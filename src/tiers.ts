import { KV_KEYS, TIER_1_MAX_SLOTS } from './config'
import { kvGet, kvPut, getProviders, getProvider, updateProvider, flushPendingWrites, getDebugMode } from './storage'
import { testModelConnection } from './proxy'
import { isOpenCodeProvider, resolveOpenCodeUrls, testOpenCodeModel } from './opencode'
import { detectPermanentFailure } from './models'
import { getIsProbeRunning, setIsProbeRunning } from './admin'
import type { Env, Provider, Model, TierStorage, TierModelRef, ProbeMetric, BusinessMetric } from './types'

/**
 * 获取 KV 中的梯队存储数据
 */
export async function getTierStorage(env: Env): Promise<TierStorage | null> {
  const raw = await kvGet(env, KV_KEYS.TIER_DATA)
  if (!raw) return null
  try {
    return JSON.parse(raw) as TierStorage
  } catch {
    return null
  }
}

/**
 * 批量写入/保存梯队数据到 KV
 * 遵循块 1 调试模式 / 正式模式落盘规则 (kvPut)
 */
export async function saveTierStorage(env: Env, data: TierStorage): Promise<void> {
  data.updatedAt = new Date().toISOString()
  await kvPut(env, KV_KEYS.TIER_DATA, JSON.stringify(data))
  await flushPendingWrites(env)
}

/**
 * 计算动态复测间隔 (毫秒)
 * 24h * (permTestFailCount + 1)，上限 72h (3天)
 */
export function getPermTestIntervalMs(permTestFailCount: number = 0): number {
  const hours = Math.min(24 * (permTestFailCount + 1), 72)
  return hours * 60 * 60 * 1000
}

/**
 * 按照规则更新提供商模型的可连接性/冷却/失效状态
 */
export async function applyModelProbeResult(
  env: Env,
  providerId: string,
  modelId: string,
  success: boolean,
  statusCode: number,
  errorMsg: string
): Promise<void> {
  const provider = await getProvider(env, providerId)
  if (!provider) return

  let updated = false
  const updatedModels = provider.models.map((m) => {
    if (m.id !== modelId) return m
    updated = true

    if (success) {
      return {
        ...m,
        cooldownUntil: null,
        failureCount: 0,
        permanentlyDisabled: false,
        permTestFailCount: 0,
        lastPermTestAt: Date.now(),
        disabledReason: undefined,
      }
    } else {
      if (m.permanentlyDisabled) {
        return {
          ...m,
          lastPermTestAt: Date.now(),
          permTestFailCount: (m.permTestFailCount || 0) + 1,
        }
      }

      const lowerMsg = (errorMsg || '').toLowerCase()
      const isBadRequestParam = statusCode === 400 && (
        lowerMsg.includes('parameter') ||
        lowerMsg.includes('validation') ||
        lowerMsg.includes('invalid') ||
        lowerMsg.includes('unsupported')
      )

      const permReason = detectPermanentFailure(statusCode, errorMsg)

      if (permReason) {
        return {
          ...m,
          permanentlyDisabled: true,
          disabledReason: permReason,
          lastPermTestAt: Date.now(),
          permTestFailCount: 0,
        }
      }

      if (isBadRequestParam) {
        return m
      }

      const newFailures = (m.failureCount || 0) + 1
      if (newFailures >= 3) {
        return {
          ...m,
          failureCount: newFailures,
          permanentlyDisabled: true,
          disabledReason: '探测连续失败达到3次，已标记永久失效',
          lastPermTestAt: Date.now(),
          permTestFailCount: 0,
        }
      }

      return {
        ...m,
        failureCount: newFailures,
        cooldownUntil: Date.now() + 5 * 60 * 1000,
      }
    }
  })

  if (updated) {
    await updateProvider(env, providerId, { models: updatedModels })
  }

  // 如果没有探测锁冲突，且模型状态改变（比如变为永久失效，或者调试模式下第一梯队出错），同步更新梯队
  if (!getIsProbeRunning()) {
    const modelNowConfig = updatedModels.find((m) => m.id === modelId)
    if (!modelNowConfig) return

    const isPermDisabled = modelNowConfig.permanentlyDisabled === true
    const actualDisabledReason = modelNowConfig.disabledReason || ''
    const fullId = `${providerId}/${modelId}`

    let storage = await getTierStorage(env)

    if (storage) {
      let changed = false
      const inTier1 = storage.tier1.some((m) => m.fullId === fullId)

      if (isPermDisabled) {
        storage.tier1 = storage.tier1.filter((m) => m.fullId !== fullId)
        storage.tier2 = storage.tier2.filter((m) => m.fullId !== fullId)
        changed = true
        console.log(`[applyModelProbeResult] 永久失效模型 ${fullId} 已从第一、第二梯队踢出，原因: ${actualDisabledReason}`)
      } else if (!success && inTier1) {
        console.log(`[applyModelProbeResult] 第一梯队模型 ${fullId} 探测异常(${statusCode})，立即踢出至第二梯队并启动自动补位`)
        storage.tier1 = storage.tier1.filter((m) => m.fullId !== fullId)
        const ref = { providerId, modelId, fullId, addedAt: Date.now() }
        if (!storage.tier2.some((m) => m.fullId === fullId)) {
          storage.tier2.push(ref)
        }
        changed = true
      }

      if (changed) {
        storage.probeStats[fullId] = {
          success,
          latency: success ? 100 : 0,
          lastTestedAt: Date.now(),
          error: success ? undefined : `HTTP ${statusCode}: ${errorMsg}`,
        }
        await backfillTier1FromTier2(env, storage)
      }
    }
  }
}

/**
 * 极低 Token 简短 Prompt 探测单模型
 * 独立探测链路，不产生用户业务日志，不记录用户业务延迟
 */
export async function runSingleModelProbe(
  env: Env,
  provider: Provider,
  modelId: string
): Promise<ProbeMetric> {
  const startTime = Date.now()
  const enabledKeys = provider.apiKeys.filter((k) => k.enabled)
  const apiKey = enabledKeys[0]?.key || ''

  let success = false
  let statusCode = 500
  let errorMsg = ''

  try {
    if (isOpenCodeProvider(provider.id)) {
      const res = await testOpenCodeModel(
        provider.baseUrl,
        enabledKeys,
        modelId,
        resolveOpenCodeUrls(env)
      )
      success = res.success
      statusCode = res.statusCode || (success ? 200 : 500)
      errorMsg = res.message
    } else {
      if (!apiKey) {
        return {
          latency: 9999,
          lastTestedAt: Date.now(),
          success: false,
          statusCode: 400,
          error: '提供商未配置有效 Key',
        }
      }
      const res = await testModelConnection(
        provider.baseUrl,
        apiKey,
        modelId,
        provider.apiType
      )
      success = res.success
      statusCode = res.statusCode || (success ? 200 : 500)
      errorMsg = res.message
    }
  } catch (err) {
    success = false
    statusCode = 502
    errorMsg = (err as Error).message || '网络异常'
  }

  const latency = Date.now() - startTime

  await applyModelProbeResult(env, provider.id, modelId, success, statusCode, errorMsg)

  return {
    latency: success ? latency : 9999,
    lastTestedAt: Date.now(),
    success,
    statusCode,
    error: success ? undefined : errorMsg,
  }
}

/**
 * 获取系统中当前全部可用的 (provider, model) 列表
 */
export async function getAllAvailableModels(env: Env): Promise<Array<{ provider: Provider; modelId: string; fullId: string }>> {
  const providers = await getProviders(env)
  const list: Array<{ provider: Provider; modelId: string; fullId: string }> = []

  for (const provider of providers) {
    if (!provider.enabled) continue
    const enabledKeys = provider.apiKeys.filter((k) => k.enabled)
    if (!isOpenCodeProvider(provider.id) && enabledKeys.length === 0) continue

    for (const m of provider.models) {
      if (!m.enabled || m.permanentlyDisabled) continue
      if (m.cooldownUntil && Date.now() < m.cooldownUntil) continue

      list.push({
        provider,
        modelId: m.id,
        fullId: `${provider.id}/${m.id}`,
      })
    }
  }

  return list
}

/**
 * 辅助函数：计算每个提供商在第一梯队中的最大允许席位上限 (Fair Share Cap)
 * 假设总席位为 9 席：
 * - 若可用提供商 >= 9 家：每家最多 1 席（确保 9 个席位分给 9 家不同提供商）
 * - 若可用提供商 < 9 家（如 N 家）：单家基础配额为 ceil(9 / N)
 */
export function calculateProviderMaxQuota(activeProviderCount: number, maxSlots: number = TIER_1_MAX_SLOTS): number {
  if (activeProviderCount <= 0) return maxSlots
  if (activeProviderCount >= maxSlots) return 1
  return Math.ceil(maxSlots / activeProviderCount)
}

/**
 * 无历史梯队时的“轮询交叉初始化探测”策略：
 * 保证模型均匀分布在所有提供商中：
 * 1. 严格遵守单提供商席位配额（Quota），避免前几家提供商独占所有 9 个名额。
 * 2. 轮询交叉测试，第一轮优先让每家提供商贡献 1 个成功模型，未满时再进入第二轮填充。
 * 探测完成后批量把延迟、探测结果一次性写入 KV。
 */
export async function runInitCrossProbe(env: Env): Promise<TierStorage> {
  const providers = await getProviders(env)
  const enabledProviders = providers.filter((p) => {
    if (!p.enabled) return false
    const keys = p.apiKeys.filter((k) => k.enabled)
    if (!isOpenCodeProvider(p.id) && keys.length === 0) return false
    return true
  })

  // 按提供商将模型分组
  const providerModelsMap = new Map<string, Array<{ provider: Provider; modelId: string; fullId: string }>>()
  for (const p of enabledProviders) {
    const validModels = p.models
      .filter((m) => m.enabled && !m.permanentlyDisabled && !(m.cooldownUntil && Date.now() < m.cooldownUntil))
      .map((m) => ({ provider: p, modelId: m.id, fullId: `${p.id}/${m.id}` }))
    if (validModels.length > 0) {
      providerModelsMap.set(p.id, validModels)
    }
  }

  const probeStats: Record<string, ProbeMetric> = {}
  const tier1: TierModelRef[] = []
  const tier2: TierModelRef[] = []
  const now = Date.now()
  const nowStr = new Date().toISOString().split('T')[0]

  const providerIds = Array.from(providerModelsMap.keys())
  const activeProviderCount = providerIds.length
  const maxQuotaPerProvider = calculateProviderMaxQuota(activeProviderCount, TIER_1_MAX_SLOTS)

  const providerPointers = new Map<string, number>()
  const providerTier1Count = new Map<string, number>()
  for (const pid of providerIds) {
    providerPointers.set(pid, 0)
    providerTier1Count.set(pid, 0)
  }

  // 区分【文本】模型优先
  for (const pid of providerIds) {
    const models = providerModelsMap.get(pid) || []
    models.sort((a, b) => {
      const mA = a.provider.models.find((m) => m.id === a.modelId)
      const mB = b.provider.models.find((m) => m.id === b.modelId)
      const catA = mA?.category === '文本' ? 0 : 1
      const catB = mB?.category === '文本' ? 0 : 1
      if (catA !== catB) return catA - catB
      return a.modelId.localeCompare(b.modelId)
    })
  }

  let remainingProviders = providerIds.length

  // 轮询交叉测试，严格受控于单厂家配额
  while (tier1.length < TIER_1_MAX_SLOTS && remainingProviders > 0) {
    remainingProviders = 0
    for (const pid of providerIds) {
      if (tier1.length >= TIER_1_MAX_SLOTS) break

      const currentCount = providerTier1Count.get(pid) || 0
      if (currentCount >= maxQuotaPerProvider) {
        continue // 该提供商已达均匀配额上限
      }

      const models = providerModelsMap.get(pid) || []
      const ptr = providerPointers.get(pid) || 0

      if (ptr < models.length) {
        remainingProviders++
        const item = models[ptr]
        providerPointers.set(pid, ptr + 1)

        // 轻量探测
        const metric = await runSingleModelProbe(env, item.provider, item.modelId)
        probeStats[item.fullId] = metric

        if (metric.success) {
          tier1.push({
            providerId: item.provider.id,
            modelId: item.modelId,
            fullId: item.fullId,
            addedAt: now,
          })
          providerTier1Count.set(pid, currentCount + 1)
        } else {
          tier2.push({
            providerId: item.provider.id,
            modelId: item.modelId,
            fullId: item.fullId,
            addedAt: now,
          })
        }
      }
    }
  }

  // 如果各厂家严格配额后仍未补满 9 席（例如部分厂家模型不足或测试失败），放宽配额继续填充剩余席位
  if (tier1.length < TIER_1_MAX_SLOTS) {
    let hasMore = true
    while (tier1.length < TIER_1_MAX_SLOTS && hasMore) {
      hasMore = false
      for (const pid of providerIds) {
        if (tier1.length >= TIER_1_MAX_SLOTS) break
        const models = providerModelsMap.get(pid) || []
        const ptr = providerPointers.get(pid) || 0
        if (ptr < models.length) {
          hasMore = true
          const item = models[ptr]
          providerPointers.set(pid, ptr + 1)

          const metric = await runSingleModelProbe(env, item.provider, item.modelId)
          probeStats[item.fullId] = metric

          if (metric.success) {
            tier1.push({
              providerId: item.provider.id,
              modelId: item.modelId,
              fullId: item.fullId,
              addedAt: now,
            })
          } else {
            tier2.push({
              providerId: item.provider.id,
              modelId: item.modelId,
              fullId: item.fullId,
              addedAt: now,
            })
          }
        }
      }
    }
  }

  // 将未探测的剩余可用模型全部放入第二梯队
  for (const pid of providerIds) {
    const models = providerModelsMap.get(pid) || []
    const ptr = providerPointers.get(pid) || 0
    for (let i = ptr; i < models.length; i++) {
      const item = models[i]
      if (!tier1.some((m) => m.fullId === item.fullId) && !tier2.some((m) => m.fullId === item.fullId)) {
        tier2.push({
          providerId: item.provider.id,
          modelId: item.modelId,
          fullId: item.fullId,
          addedAt: now,
        })
      }
    }
  }

  const newStorage: TierStorage = {
    tier1,
    tier2,
    probeStats,
    businessStats: {},
    updatedAt: new Date().toISOString(),
    lastProbeDate: nowStr,
  }

  await saveTierStorage(env, newStorage)
  return newStorage
}

/**
 * 带有历史 KV 数据的初始化与重测逻辑：
 * ①如果KV存在前一日/历史有效的第一梯队历史数据：以此作为基底；对梯队内模型执行一轮轻量探测；
 * 剔除失败、冷却、永久失效以及严重超出提供商均匀配额的多余模型；
 * 之后正常运行动态淘汰、空位补位规则。
 */
export async function validateAndRebuildHistoryTier1(
  env: Env,
  existing: TierStorage
): Promise<TierStorage> {
  const allModels = await getAllAvailableModels(env)
  const modelMap = new Map(allModels.map((item) => [item.fullId, item]))

  // 获取所有活跃提供商数量并计算均匀配额
  const activeProviders = new Set(allModels.map((item) => item.provider.id))
  const maxQuotaPerProvider = calculateProviderMaxQuota(activeProviders.size, TIER_1_MAX_SLOTS)

  const probeStats: Record<string, ProbeMetric> = { ...(existing.probeStats || {}) }
  const businessStats: Record<string, BusinessMetric> = { ...(existing.businessStats || {}) }
  const newTier1: TierModelRef[] = []
  const newTier2: TierModelRef[] = []
  const now = Date.now()

  const providerCounts = new Map<string, number>()

  // 1. 对历史 Tier 1 内的模型执行一轮轻量探测，并执行多样性配额检查
  for (const m of existing.tier1 || []) {
    const item = modelMap.get(m.fullId)
    if (!item) {
      // 模型不存在/已被永久禁用/已删除
      continue
    }

    const currentCount = providerCounts.get(m.providerId) || 0
    // 如果单个提供商在第一梯队中超出均匀配额，多余模型主动降级至第二梯队，给其他提供商让位
    if (currentCount >= maxQuotaPerProvider) {
      newTier2.push({
        providerId: m.providerId,
        modelId: m.modelId,
        fullId: m.fullId,
        addedAt: now,
      })
      continue
    }

    const metric = await runSingleModelProbe(env, item.provider, item.modelId)
    probeStats[m.fullId] = metric

    if (metric.success) {
      newTier1.push({
        ...m,
        addedAt: m.addedAt || now,
      })
      providerCounts.set(m.providerId, currentCount + 1)
    } else {
      // 探测失败或处于冷却/失效状态，从第一梯队剔除，降至第二梯队
      newTier2.push({
        providerId: m.providerId,
        modelId: m.modelId,
        fullId: m.fullId,
        addedAt: now,
      })
    }
  }

  // 2. 将其余全部可用模型加入第二梯队 (避免重复)
  for (const item of allModels) {
    const isInTier1 = newTier1.some((x) => x.fullId === item.fullId)
    const isInTier2 = newTier2.some((x) => x.fullId === item.fullId)
    if (!isInTier1 && !isInTier2) {
      newTier2.push({
        providerId: item.provider.id,
        modelId: item.modelId,
        fullId: item.fullId,
        addedAt: now,
      })
    }
  }

  let updatedStorage: TierStorage = {
    tier1: newTier1,
    tier2: newTier2,
    probeStats,
    businessStats,
    updatedAt: new Date().toISOString(),
    lastProbeDate: new Date().toISOString().split('T')[0],
  }

  // 3. 运行空位补位海选规则（如果 Tier 1 不足 9 个）
  if (updatedStorage.tier1.length < TIER_1_MAX_SLOTS) {
    updatedStorage = await backfillTier1FromTier2(env, updatedStorage)
  } else {
    await saveTierStorage(env, updatedStorage)
  }

  return updatedStorage
}

/**
 * 补位海选逻辑 (Backfill Tier 1 from Tier 2):
 * 当第一梯队有空位时，从第二梯队候选池中选拔模型填满 9 席。
 * 
 * 1. 探测执行必须经过块4的探测互斥锁，不可并发执行补位探测。
 * 2. 均匀分布保障：严格计算单提供商席位配额（Quota），优先给第一梯队中席位较少/为0的提供商补位。
 * 3. 探测优先遍历第二梯队内标记【文本】分类的模型；各个提供商轮抽模型交叉测试；
 * 4. 探测游标持久化存KV：每次探测结束记录当前游标位置；下一次补位探测从上一次游标下一个模型继续遍历。
 * 5. 每一轮探测结束，选取本轮探测延迟最低的可用模型晋升进入第一梯队（不超过单厂家配额）。
 * 6. 全部状态、游标、梯队变更，落盘严格遵守块1调试/正式模式KV策略。
 */
export async function backfillTier1FromTier2(
  env: Env,
  storage: TierStorage
): Promise<TierStorage> {
  const slotsNeeded = TIER_1_MAX_SLOTS - storage.tier1.length
  if (slotsNeeded <= 0 || storage.tier2.length === 0) {
    await saveTierStorage(env, storage)
    return storage
  }

  // 6. 探测执行必须经过块 4 的探测互斥锁，不可并发执行补位探测
  if (getIsProbeRunning()) {
    console.log('[tiers] 补位探测互斥锁已被占用，跳过本次自动补位探测')
    return storage
  }

  setIsProbeRunning(true)
  try {
    const allModels = await getAllAvailableModels(env)
    const availableMap = new Map(allModels.map((item) => [item.fullId, item]))

    // 筛选第二梯队中可用的候选模型
    const candidates = storage.tier2.filter((m) => availableMap.has(m.fullId))
    if (candidates.length === 0) {
      await saveTierStorage(env, storage)
      return storage
    }

    // 统计当前活跃提供商总数与当前各提供商在 Tier 1 中的占位
    const allProviders = await getProviders(env)
    const activeProviders = allProviders.filter((p) => {
      if (!p.enabled) return false
      const keys = p.apiKeys.filter((k) => k.enabled)
      if (!isOpenCodeProvider(p.id) && keys.length === 0) return false
      return true
    })
    const maxQuotaPerProvider = calculateProviderMaxQuota(activeProviders.length, TIER_1_MAX_SLOTS)

    // 区分【文本】模型优先：优先遍历第二梯队内标记【文本】分类的模型
    const textCandidates: typeof candidates = []
    const otherCandidates: typeof candidates = []

    for (const cand of candidates) {
      const liveModel = availableMap.get(cand.fullId)
      if (liveModel) {
        const modelConfig = liveModel.provider.models.find((m) => m.id === liveModel.modelId)
        const category = modelConfig?.category || ''
        if (category === '文本') {
          textCandidates.push(cand)
        } else {
          otherCandidates.push(cand)
        }
      }
    }

    let currentSlotsNeeded = TIER_1_MAX_SLOTS - storage.tier1.length

    // 辅助函数：针对候选模型组运行轮询交叉探测
    const runWheelForGroup = async (groupCandidates: typeof candidates, enforceQuota: boolean) => {
      if (groupCandidates.length === 0 || currentSlotsNeeded <= 0) return

      const allProviderIds = allProviders.map((p) => p.id).sort()

      // 按 providerId 将候选模型分组
      const providerToModels: Record<string, typeof candidates> = {}
      for (const cand of groupCandidates) {
        if (!providerToModels[cand.providerId]) {
          providerToModels[cand.providerId] = []
        }
        providerToModels[cand.providerId].push(cand)
      }

      let providerIds = Object.keys(providerToModels)

      // 统计每个提供商目前在 Tier 1 拥有的席位数量，优先排布席位少的提供商（确保均匀）
      const getProviderTier1Count = (pid: string) => storage.tier1.filter((m) => m.providerId === pid).length

      // 探测游标与席位均衡综合排序：
      // 1. 在 Tier 1 中席位较少（甚至为 0）的提供商排在最前面
      // 2. 席位相同的情况下，根据上次轮抽游标偏置进行平滑轮转
      const lastCursor = storage.lastCursorProviderId
      const lastIdx = lastCursor && allProviderIds.includes(lastCursor) ? allProviderIds.indexOf(lastCursor) : 0
      const N = Math.max(allProviderIds.length, 1)

      providerIds.sort((a, b) => {
        const countA = getProviderTier1Count(a)
        const countB = getProviderTier1Count(b)
        if (countA !== countB) {
          return countA - countB // 席位少的优先探测与晋升
        }

        const idxA = allProviderIds.indexOf(a)
        const idxB = allProviderIds.indexOf(b)
        const distA = (idxA - lastIdx + N) % N
        const distB = (idxB - lastIdx + N) % N
        const weightA = distA === 0 ? N : distA
        const weightB = distB === 0 ? N : distB
        return weightA - weightB
      })

      // 组内各个提供商内部候选模型排序 (文本/通用优先)
      for (const pid of providerIds) {
        providerToModels[pid].sort((a, b) => a.modelId.localeCompare(b.modelId))
      }

      // 记录每个提供商本轮已轮抽/测试的模型指针
      const providerPointers: Record<string, number> = {}
      for (const pid of providerIds) {
        providerPointers[pid] = 0
      }

      // 收集达到复测间隔的已封禁模型（每轮海选附带抽测最多 1~2 个）
      const eligibleBlocked: Array<{ cand: TierModelRef; provider: Provider }> = []
      const now = Date.now()
      for (const p of allProviders) {
        if (!p.enabled) continue
        const enabledKeys = p.apiKeys.filter((k) => k.enabled)
        if (!isOpenCodeProvider(p.id) && enabledKeys.length === 0) continue

        for (const m of p.models) {
          if (m.enabled !== false && m.permanentlyDisabled) {
            const lastTested = m.lastPermTestAt || 0
            const failCount = m.permTestFailCount || 0
            const interval = getPermTestIntervalMs(failCount)
            if (now - lastTested >= interval) {
              eligibleBlocked.push({
                cand: { providerId: p.id, modelId: m.id, fullId: `${p.id}/${m.id}`, addedAt: Date.now() },
                provider: p,
              })
            }
          }
        }
      }
      let blockedPointer = 0

      let hasMoreToTest = true
      // 一轮一轮地交叉轮抽与并发测试
      while (currentSlotsNeeded > 0 && hasMoreToTest) {
        hasMoreToTest = false
        const roundToTest: typeof candidates = []

        // 各个提供商轮抽 1 个正常候选模型（若受配额控制，超额提供商本轮跳过）
        for (const pid of providerIds) {
          if (enforceQuota && getProviderTier1Count(pid) >= maxQuotaPerProvider) {
            continue // 该提供商已达均匀配额
          }

          const idx = providerPointers[pid]
          const list = providerToModels[pid]
          if (idx < list.length) {
            hasMoreToTest = true
            const cand = list[idx]
            providerPointers[pid] = idx + 1
            roundToTest.push(cand)
          }
        }

        // 附带抽测最多 1~2 个符合复测间隔的封禁模型（以正常模型为主）
        let attachedBlockedCount = 0
        while (blockedPointer < eligibleBlocked.length && attachedBlockedCount < 2) {
          const blockedItem = eligibleBlocked[blockedPointer++]
          roundToTest.push(blockedItem.cand)
          if (!availableMap.has(blockedItem.cand.fullId)) {
            availableMap.set(blockedItem.cand.fullId, {
              provider: blockedItem.provider,
              modelId: blockedItem.cand.modelId,
              fullId: blockedItem.cand.fullId,
            })
          }
          attachedBlockedCount++
        }

        if (roundToTest.length === 0) break

        // 并发探测本轮抽取的候选模型
        const probeResults = await Promise.all(
          roundToTest.map(async (cand) => {
            const liveModel = availableMap.get(cand.fullId)
            if (!liveModel) return null
            const metric = await runSingleModelProbe(env, liveModel.provider, liveModel.modelId)
            return { cand, metric }
          })
        )

        const roundTested: Array<{ ref: TierModelRef; metric: ProbeMetric }> = []
        for (const res of probeResults) {
          if (res) {
            storage.probeStats[res.cand.fullId] = res.metric
            roundTested.push({ ref: res.cand, metric: res.metric })
            // 记录当前已测试的提供商游标
            storage.lastCursorProviderId = res.cand.providerId
          }
        }

        // 选取本轮探测成功的可用模型按延迟由低到高晋升进入第一梯队
        const successCandidates = roundTested.filter((item) => item.metric.success)
        if (successCandidates.length > 0) {
          successCandidates.sort((a, b) => a.metric.latency - b.metric.latency)
          for (const item of successCandidates) {
            if (currentSlotsNeeded <= 0) break

            if (enforceQuota && getProviderTier1Count(item.ref.providerId) >= maxQuotaPerProvider) {
              continue // 晋升时再次严格校验配额
            }

            // 晋升到第一梯队
            storage.tier1.push({
              ...item.ref,
              addedAt: Date.now()
            })

            // 从第二梯队移除已晋升的项
            storage.tier2 = storage.tier2.filter((m) => m.fullId !== item.ref.fullId)

            currentSlotsNeeded--
          }

          // 只要缺额被补满，立即停止海选
          if (currentSlotsNeeded <= 0) {
            break
          }
        }
      }
    }

    // 阶段 1：在严格执行均匀配额（Fair Share Quota）的前提下，优先遍历标记【文本】分类的模型
    await runWheelForGroup(textCandidates, true)

    // 阶段 2：在严格执行配额前提下，若仍有空位，遍历其余分类模型
    if (currentSlotsNeeded > 0) {
      await runWheelForGroup(otherCandidates, true)
    }

    // 阶段 3：若由于部分提供商无可用模型导致第一梯队仍未补满 9 席，放宽配额限制（false）用剩余模型填满
    if (currentSlotsNeeded > 0) {
      await runWheelForGroup(textCandidates, false)
    }
    if (currentSlotsNeeded > 0) {
      await runWheelForGroup(otherCandidates, false)
    }

    // 全部状态、游标、梯队变更落盘
    await saveTierStorage(env, storage)

  } finally {
    setIsProbeRunning(false)
  }

  return storage
}

/**
 * 确保梯队数据就绪（初始化/校验）
 */
export async function ensureTierStorage(env: Env): Promise<TierStorage> {
  let existing = await getTierStorage(env)
  if (existing && Array.isArray(existing.tier1) && existing.tier1.length > 0) {
    // 存在历史 Tier 1 数据
    const today = new Date().toISOString().split('T')[0]
    if (existing.lastProbeDate !== today) {
      // 跨日或已有前一日历史数据：以此作为基底，对梯队内模型执行一轮轻量探测并补位
      return await validateAndRebuildHistoryTier1(env, existing)
    }

    // 重点：同步并清理系统中的全部可用/已删除/已停用模型，防止新模型或被删模型导致无法补位
    const allModels = await getAllAvailableModels(env)
    const availableSet = new Set(allModels.map((item) => item.fullId))

    let changed = false
    const now = Date.now()

    // 1. 清除已不在可用列表中的模型（比如被删除、禁用、永久失效的模型）
    const prevTier1Length = existing.tier1.length
    existing.tier1 = existing.tier1.filter((m) => availableSet.has(m.fullId))
    if (existing.tier1.length !== prevTier1Length) {
      changed = true
    }

    const prevTier2Length = existing.tier2.length
    existing.tier2 = existing.tier2.filter((m) => availableSet.has(m.fullId))
    if (existing.tier2.length !== prevTier2Length) {
      changed = true
    }

    // 2. 将新增的可用模型实时同步加入第二梯队
    for (const item of allModels) {
      const isInTier1 = existing.tier1.some((x) => x.fullId === item.fullId)
      const isInTier2 = existing.tier2.some((x) => x.fullId === item.fullId)
      if (!isInTier1 && !isInTier2) {
        existing.tier2.push({
          providerId: item.provider.id,
          modelId: item.modelId,
          fullId: item.fullId,
          addedAt: now,
        })
        changed = true
      }
    }

    // 自动补位：如果今天内第一梯队席位不满 9 个，自动触发补位探测
    if (existing.tier1.length < TIER_1_MAX_SLOTS) {
      existing = await backfillTier1FromTier2(env, existing)
    } else if (changed) {
      await saveTierStorage(env, existing)
    }
    return existing
  }

  // 无历史梯队数据：启动初始化交叉轮询海选
  return await runInitCrossProbe(env)
}

/**
 * Helper to identify if a model is suitable for long context.
 */
export function isLongContextModel(modelId: string): boolean {
  const name = modelId.toLowerCase()
  return (
    name.includes('128k') ||
    name.includes('200k') ||
    name.includes('256k') ||
    name.includes('512k') ||
    name.includes('1m') ||
    name.includes('32k') ||
    name.includes('64k') ||
    name.includes('long') ||
    name.includes('gpt-4') ||
    name.includes('claude') ||
    name.includes('gemini') ||
    name.includes('deepseek') ||
    name.includes('qwen') ||
    name.includes('llama-3') ||
    name.includes('yi-')
  )
}

/**
 * auto/auto 路由模型选取：
 * 从第一梯队池 (Tier 1) 中选出一个健康模型
 */
export async function selectAutoModel(
  env: Env,
  isLongText: boolean = false,
  sessionId: string | null = null,
  excludedProviderIds?: Set<string>
): Promise<{ providerId: string; modelId: string; fullId: string } | null> {
  const storage = await ensureTierStorage(env)

  const allModels = await getAllAvailableModels(env)
  const modelMap = new Map(allModels.map((item) => [item.fullId, item]))

  // 过滤第一梯队中当前可用的模型
  let activeTier1 = storage.tier1.filter((m) => modelMap.has(m.fullId))

  if (activeTier1.length === 0 || storage.tier1.length < TIER_1_MAX_SLOTS) {
    // 若第一梯队全部模型不可用，或第一梯队不满 9 席，尝试补位
    const backfilled = await backfillTier1FromTier2(env, storage)
    activeTier1 = backfilled.tier1.filter((m) => modelMap.has(m.fullId))
  }

  if (activeTier1.length === 0) return null

  // 4. 不同提供商模型更换：如果有要排除的提供商（例如因 402/余额不足等原因报错），优先排除它们
  if (excludedProviderIds && excludedProviderIds.size > 0) {
    const filtered = activeTier1.filter((m) => !excludedProviderIds.has(m.providerId))
    if (filtered.length > 0) {
      activeTier1 = filtered
    }
  }

  // 1.识别长文本请求：长文本流量只在第一梯队【文本】分类模型中调度，过滤绘图、多模态、向量嵌入类模型。
  let candidates = activeTier1
  if (isLongText) {
    candidates = activeTier1.filter((m) => {
      const liveModel = modelMap.get(m.fullId)
      if (!liveModel) return false
      const modelConfig = liveModel.provider.models.find((x) => x.id === m.modelId)
      const category = modelConfig?.category || '文本'
      return category === '文本'
    })
  }

  if (candidates.length === 0) {
    // Fallback: 如果过滤后无可用模型，使用原本的候选（确保服务可用性）
    candidates = activeTier1
  }

  // 2.分组内优先选择适配长上下文标记的文本模型。
  // 按照长上下文标记优先，其次按真实业务延迟 (businessStats) 排序选择最佳模型（完全不使用轻量探测延迟！）
  const sorted = [...candidates].sort((a, b) => {
    const isLongA = isLongContextModel(a.modelId) ? 1 : 0
    const isLongB = isLongContextModel(b.modelId) ? 1 : 0
    if (isLongA !== isLongB) {
      return isLongB - isLongA // True (1) comes before False (0)
    }

    const bLatA = storage.businessStats[a.fullId]?.avgLatency ?? 999
    const bLatB = storage.businessStats[b.fullId]?.avgLatency ?? 999
    return bLatA - bLatB
  })

  const chosen = sorted[0]
  if (!chosen) return null
  return { providerId: chosen.providerId, modelId: chosen.modelId, fullId: chosen.fullId }
}

/**
 * ⚠️ 严格隔离：记录用户真实业务请求延迟
 * 只针对 auto/auto 的业务流量生效，只读取【用户真实业务延迟】这一套统计样本，轻探测延迟完全不参与淘汰判断。
 */
export async function recordBusinessLatency(
  env: Env,
  fullId: string,
  latency: number,
  success: boolean,
  isAutoRequest: boolean = false
): Promise<void> {
  // 仅针对 auto/auto 业务流量生效
  if (!isAutoRequest) return

  let storage = await getTierStorage(env)
  if (!storage) return

  const now = Date.now()
  const bStat: BusinessMetric = storage.businessStats[fullId] || {
    avgLatency: latency,
    totalRequests: 0,
    successCount: 0,
    failureCount: 0,
    lastUsedAt: now,
  }

  bStat.totalRequests++
  bStat.lastUsedAt = now

  if (success) {
    bStat.successCount++
    bStat.failureCount = 0 // 成功重置连续失败计数
    // 滑动平均更新真实业务延迟
    bStat.avgLatency = Math.round(bStat.avgLatency * 0.7 + latency * 0.3)
  } else {
    bStat.failureCount++
  }

  storage.businessStats[fullId] = bStat

  const debugMode = await getDebugMode(env)
  if (debugMode) {
    // 调试模式：将最新请求延迟与结果实时同步更新至 probeStats，方便前端直接展示最新探测/调用延迟
    storage.probeStats[fullId] = {
      success,
      latency: Math.round(latency),
      lastTestedAt: now,
      error: success ? undefined : '调用异常/失败',
    }
  }

  // 检查该模型是否在第一梯队中
  const isInTier1 = storage.tier1.some((m) => m.fullId === fullId)
  if (!isInTier1) {
    await saveTierStorage(env, storage)
    return
  }

  let shouldEliminate = false
  let eliminationReason = ''

  if (!success) {
    // 业务请求失败 1 次：模型标黄，移出第一梯队，冷却 10 分钟
    shouldEliminate = true
    eliminationReason = `业务请求失败 1 次`
  }

  if (shouldEliminate) {
    console.log(`[tiers] 淘汰第一梯队模型 ${fullId}: ${eliminationReason}`)

    // 模型标黄，移出第一梯队，冷却 10 分钟
    // 复用块4已经实现逻辑：冷却不重置失败计数器，冷却完回到第二梯队
    const parts = fullId.split('/')
    const providerId = parts[0]
    const modelId = parts.slice(1).join('/')
    if (providerId && modelId) {
      const provider = await getProvider(env, providerId)
      if (provider) {
        const updatedModels = provider.models.map((m: Model) => {
          if (m.id === modelId) {
            return {
              ...m,
              cooldownUntil: now + 10 * 60 * 1000, // 冷却 10 分钟
            }
          }
          return m
        })
        await updateProvider(env, providerId, { models: updatedModels })
      }
    }

    // 移出第一梯队，回到第二梯队候选池
    storage.tier1 = storage.tier1.filter((m) => m.fullId !== fullId)
    const ref = { providerId, modelId, fullId, addedAt: now }
    if (!storage.tier2.some((m) => m.fullId === fullId)) {
      storage.tier2.push(ref)
    }

    // 触发空位海选补位
    storage = await backfillTier1FromTier2(env, storage)
  } else {
    if (storage.tier1.length < TIER_1_MAX_SLOTS) {
      storage = await backfillTier1FromTier2(env, storage)
    } else {
      await saveTierStorage(env, storage)
    }
  }
}
