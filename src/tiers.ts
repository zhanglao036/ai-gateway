import { KV_KEYS, TIER_1_MAX_SLOTS, TIER_OPENCLAW_MAX_SLOTS, TIER_DRAWING_MAX_SLOTS } from './config'
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
 * 采用顺风车打包落盘机制，修改后立即刷盘，确保页面刷新即刻看到最新结果
 */
export async function saveTierStorage(env: Env, data: TierStorage): Promise<void> {
  try {
    data.updatedAt = new Date().toISOString()
    // 写入梯队数据
    await kvPut(env, KV_KEYS.TIER_DATA, JSON.stringify(data))
    // 顺风车立即刷盘，确保 Cloudflare KV 立即持久化最新状态
    await flushPendingWrites(env)
  } catch (err) {
    console.warn('[tiers] 保存梯队数据异常 (已安全降级):', err instanceof Error ? err.message : String(err))
  }
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
 * 按照规则更新提供商模型的可连接性/冷却/失效状态以及 OpenClaw / 分类打标
 */
export async function applyModelProbeResult(
  env: Env,
  providerId: string,
  modelId: string,
  success: boolean,
  statusCode: number,
  errorMsg: string,
  extra?: {
    category?: string
    openclawCompatible?: boolean
    openclawReason?: string
  }
): Promise<void> {
  const provider = await getProvider(env, providerId)
  if (!provider) return

  let updated = false
  const updatedModels = provider.models.map((m) => {
    if (m.id !== modelId) return m

    // 同步更新分类与 OpenClaw 标签
    let categoryChanged = false
    let newCategory = m.category
    if (extra?.category && m.category !== extra.category) {
      newCategory = extra.category as any
      categoryChanged = true
    }

    let openclawChanged = false
    let newOpenclawTested = m.openclawTested
    let newOpenclawCompatible = m.openclawCompatible
    let newOpenclawReason = m.openclawReason
    if (extra && extra.openclawCompatible !== undefined) {
      if (!m.openclawTested || m.openclawCompatible !== extra.openclawCompatible || m.openclawReason !== extra.openclawReason) {
        newOpenclawTested = true
        newOpenclawCompatible = extra.openclawCompatible
        newOpenclawReason = extra.openclawReason
        openclawChanged = true
      }
    }

    if (success) {
      const hadAnomaly = (m.failureCount && m.failureCount > 0) || m.cooldownUntil || m.permanentlyDisabled
      if (!hadAnomaly && !categoryChanged && !openclawChanged) {
        return m
      }
      updated = true
      return {
        ...m,
        category: newCategory,
        openclawTested: newOpenclawTested,
        openclawCompatible: newOpenclawCompatible,
        openclawReason: newOpenclawReason,
        openclawTestedAt: openclawChanged ? Date.now() : m.openclawTestedAt,
        cooldownUntil: null,
        failureCount: 0,
        permanentlyDisabled: false,
        permTestFailCount: 0,
        lastPermTestAt: Date.now(),
        disabledReason: undefined,
      }
    } else {
      if (m.permanentlyDisabled) {
        updated = true
        return {
          ...m,
          category: newCategory,
          openclawTested: newOpenclawTested,
          openclawCompatible: newOpenclawCompatible,
          openclawReason: newOpenclawReason,
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

      if (isBadRequestParam) {
        if (categoryChanged || openclawChanged) {
          updated = true
          return {
            ...m,
            category: newCategory,
            openclawTested: newOpenclawTested,
            openclawCompatible: newOpenclawCompatible,
            openclawReason: newOpenclawReason,
          }
        }
        return m
      }

      const permReason = detectPermanentFailure(statusCode, errorMsg)
      if (permReason) {
        updated = true
        return {
          ...m,
          category: newCategory,
          openclawTested: newOpenclawTested,
          openclawCompatible: newOpenclawCompatible,
          openclawReason: newOpenclawReason,
          permanentlyDisabled: true,
          disabledReason: permReason,
          lastPermTestAt: Date.now(),
          permTestFailCount: 0,
        }
      }

      updated = true
      const newFailures = (m.failureCount || 0) + 1
      if (newFailures >= 3) {
        return {
          ...m,
          category: newCategory,
          openclawTested: newOpenclawTested,
          openclawCompatible: newOpenclawCompatible,
          openclawReason: newOpenclawReason,
          failureCount: newFailures,
          permanentlyDisabled: true,
          disabledReason: '探测连续失败达到3次，已标记永久失效',
          lastPermTestAt: Date.now(),
          permTestFailCount: 0,
        }
      }

      return {
        ...m,
        category: newCategory,
        openclawTested: newOpenclawTested,
        openclawCompatible: newOpenclawCompatible,
        openclawReason: newOpenclawReason,
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
  let modelCategory = '文本'
  let openclawCompatible: boolean | undefined = undefined
  let openclawReason: string | undefined = undefined

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
      const modelConfig = provider.models.find((m) => m.id === modelId)
      const res = await testModelConnection(
        provider.baseUrl,
        apiKey,
        modelId,
        provider.apiType,
        modelConfig?.category,
        modelConfig ? {
          openclawTested: modelConfig.openclawTested,
          openclawCompatible: modelConfig.openclawCompatible,
          openclawReason: modelConfig.openclawReason,
        } : undefined
      )
      success = res.success
      statusCode = res.statusCode || (success ? 200 : 500)
      errorMsg = res.message
      modelCategory = res.category || modelConfig?.category || '文本'
      openclawCompatible = res.openclaw?.compatible
      openclawReason = res.openclaw?.reason
    }
  } catch (err) {
    success = false
    statusCode = 502
    errorMsg = (err as Error).message || '网络异常'
  }

  const latency = Date.now() - startTime

  await applyModelProbeResult(env, provider.id, modelId, success, statusCode, errorMsg, {
    category: modelCategory,
    openclawCompatible,
    openclawReason,
  })

  return {
    latency: success ? latency : 9999,
    lastTestedAt: Date.now(),
    success,
    statusCode,
    error: success ? undefined : errorMsg,
    category: modelCategory,
    openclawCompatible,
    openclawReason,
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
    modelCursors: Object.fromEntries(
      Array.from(providerPointers.entries()).map(([pid, ptr]) => {
        const total = (providerModelsMap.get(pid) || []).length
        return [pid, total > 0 ? ptr % total : 0]
      })
    ),
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

  // 1. 对历史 Tier 1 内的模型并发执行轻量探测，并执行多样性配额检查
  const toProbe: Array<{ m: TierModelRef; item: { provider: Provider; modelId: string; fullId: string } }> = []
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

    providerCounts.set(m.providerId, currentCount + 1)
    toProbe.push({ m, item })
  }

  // 并发探测，耗时由十多秒骤降至约 1~2 秒
  const probeResults = await Promise.all(
    toProbe.map(async ({ m, item }) => {
      const metric = await runSingleModelProbe(env, item.provider, item.modelId)
      return { m, metric }
    })
  )

  for (const { m, metric } of probeResults) {
    probeStats[m.fullId] = metric
    if (metric.success) {
      newTier1.push({
        ...m,
        addedAt: m.addedAt || now,
      })
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

      // 【核心升级】：初始化/读取每个提供商的持久化模型游标（Ring Buffer 环形轮询）
      // 确保无论何时触发补位，各提供商都从上一次测试到的下一个模型开始轮询，绝不总是固定测试前几个模型
      storage.modelCursors = storage.modelCursors || {}
      const providerModelLists: Record<string, typeof candidates> = {}
      const providerTestedCount: Record<string, number> = {}

      for (const pid of providerIds) {
        const rawList = providerToModels[pid] || []
        providerTestedCount[pid] = 0

        if (rawList.length <= 1) {
          providerModelLists[pid] = rawList
        } else {
          // 读取该提供商上一次记录的游标位置 (0-based)
          let lastOffset = typeof storage.modelCursors[pid] === 'number' ? storage.modelCursors[pid] : 0
          // 环形切分重组：从上一次的下一个位置 (lastOffset) 开始往后轮询，再拼接前半部分
          if (lastOffset < 0 || lastOffset >= rawList.length) {
            lastOffset = 0
          }
          providerModelLists[pid] = [...rawList.slice(lastOffset), ...rawList.slice(0, lastOffset)]
        }
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

        // 动态决定每个提供商抽选数量：若提供商总数 <= 3 家则抽取 2 个模型；若 > 3 家则抽取 1 个模型
        const sampleCountPerProvider = providerIds.length <= 3 ? 2 : 1

        // 各个提供商轮流抽取候选模型（若受配额控制，超额提供商本轮跳过）
        for (const pid of providerIds) {
          // 如果开启了配额限制，且该提供商在第一梯队席位已满，则跳过
          if (enforceQuota && getProviderTier1Count(pid) >= maxQuotaPerProvider) {
            continue
          }

          const list = providerModelLists[pid] || []
          let count = providerTestedCount[pid] || 0
          // 根据动态决定的数量，从该提供商名下切取 1~2 个候选模型
          for (let pick = 0; pick < sampleCountPerProvider; pick++) {
            if (count < list.length) {
              hasMoreToTest = true
              const cand = list[count]
              count++
              providerTestedCount[pid] = count
              roundToTest.push(cand)

              // 持久化更新该提供商的名下模型游标位置：计算当前模型在原始列表中的下一个索引
              const origList = providerToModels[pid] || []
              const origIdx = origList.findIndex((x) => x.fullId === cand.fullId)
              if (origIdx !== -1 && origList.length > 0) {
                storage.modelCursors[pid] = (origIdx + 1) % origList.length
              }
              // 记录本次最后抽样的提供商，推进第一梯队的提供商游标
              storage.lastCursorProviderId = pid
            }
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

        // 选取本轮探测成功的可用模型：优先选拔适合 OpenClaw 智能体的高质量模型，其次按延迟由低到高排序
        const successCandidates = roundTested.filter((item) => item.metric.success)
        if (successCandidates.length > 0) {
          successCandidates.sort((a, b) => {
            const openclawA = a.metric.openclawCompatible ? 1 : 0
            const openclawB = b.metric.openclawCompatible ? 1 : 0
            if (openclawA !== openclawB) return openclawB - openclawA // 适合 OpenClaw 优先
            return a.metric.latency - b.metric.latency // 延迟由低到高
          })
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
 * 辅助检测是否为绘图模型
 */
export function isDrawingModel(modelId: string, category?: string): boolean {
  if (category === '绘图') return true
  const lower = modelId.toLowerCase()
  return (
    lower.includes('dall-e') ||
    lower.includes('flux') ||
    lower.includes('midjourney') ||
    lower.includes('stable-diffusion') ||
    lower.includes('sdxl') ||
    lower.includes('sd-') ||
    lower.includes('image') ||
    lower.includes('cogview') ||
    lower.includes('recraft')
  )
}

/**
 * 双重游标自适应候选模型抽样算法（支持 OpenClaw 池、绘图池等）：
 * 1. 动态数量：根据有效候选提供商数量，若 <= 3 家，每家抽取 2 个候选模型；若 > 3 家，每家抽取 1 个候选模型。
 * 2. 第一重游标（提供商游标）：根据各池子上次记录的提供商游标进行环形队列重排，上次测过的提供商往后排，上次未测到的排在最前。
 * 3. 第二重游标（模型游标）：每个提供商记录名下模型的上次测试位置，本次从该位置接着往下切取，测试完毕后游标定位推进。
 * 4. 抽样完毕后定位记录本轮最后处理的提供商 ID，供下次海选无缝接力。
 */
export function sampleCandidatesByProviderAndModelCursors<T extends { provider: Provider; modelId: string; fullId: string }>(
  poolType: 'openclaw' | 'drawing',
  candidates: T[],
  storage: TierStorage,
  maxTotalSamples = 15
): T[] {
  // 如果没有候选模型直接返回空
  if (candidates.length === 0) return []

  // 1. 将候选模型按 providerId 进行归类分组
  const providerMap = new Map<string, T[]>()
  for (const cand of candidates) {
    const pid = cand.provider.id
    if (!providerMap.has(pid)) {
      providerMap.set(pid, [])
    }
    providerMap.get(pid)!.push(cand)
  }

  let providerIds = Array.from(providerMap.keys()).sort()
  if (providerIds.length === 0) return []

  // 2. 动态决定每个提供商抽几个：如果候选提供商总数 <= 3 则抽 2 个，否则抽 1 个
  const samplePerProvider = providerIds.length <= 3 ? 2 : 1

  // 3. 第一重游标（提供商游标）：读取该池子上一次记录的最后抽测提供商
  const lastPid = poolType === 'openclaw' ? storage.lastOpenclawProviderId : storage.lastDrawingProviderId
  const lastIdx = lastPid ? providerIds.indexOf(lastPid) : -1
  if (lastIdx !== -1 && providerIds.length > 1) {
    // 环形切分：将上次抽过的提供商之后的位置移到最前面，保证轮流坐庄
    const nextStart = (lastIdx + 1) % providerIds.length
    providerIds = [...providerIds.slice(nextStart), ...providerIds.slice(0, nextStart)]
  }

  // 4. 第二重游标（各提供商名下的模型游标）：顺序切出候选模型
  storage.modelCursors = storage.modelCursors || {}
  const sampled: T[] = []
  let lastSampledPid: string | undefined

  for (const pid of providerIds) {
    const models = providerMap.get(pid) || []
    if (models.length === 0) continue

    // 各池子维护各自独立的提供商模型游标键名，互不干扰
    const cursorKey = `${poolType}_${pid}`
    let cursor = typeof storage.modelCursors[cursorKey] === 'number' ? storage.modelCursors[cursorKey] : 0
    if (cursor < 0 || cursor >= models.length) {
      cursor = 0
    }

    // 从游标位置顺延切取 samplePerProvider 个模型（支持环形取模）
    const toPick = Math.min(samplePerProvider, models.length)
    for (let i = 0; i < toPick; i++) {
      const pickIdx = (cursor + i) % models.length
      sampled.push(models[pickIdx])
    }

    // 更新该提供商名下的模型定位游标：记录下一次该从哪个索引继续
    storage.modelCursors[cursorKey] = (cursor + toPick) % models.length
    lastSampledPid = pid

    // 单轮安全熔断上限（默认 15 个），防止一次性并发过多请求导致超时
    if (sampled.length >= maxTotalSamples) break
  }

  // 5. 更新该池子的提供商定位游标（记录本次最后被抽选的提供商）
  if (lastSampledPid) {
    if (poolType === 'openclaw') {
      storage.lastOpenclawProviderId = lastSampledPid
    } else {
      storage.lastDrawingProviderId = lastSampledPid
    }
  }

  return sampled
}

/**
 * 为 OpenClaw 专属梯队池海选补位（双重游标自适应海选流程）：
 * 1. 按提供商与名下模型双重游标自适应抽选候选人（<=3家抽2个，>3家抽1个）
 * 2. 现场并发执行轻量握手探针测速
 * 3. 严格筛选测通的模型 (success === true)
 * 4. 按照本轮实测延迟由低到高严格择优录取
 * 5. 入池同时立刻记录测速延迟成绩与游标，顺风车打包 1 次写入 KV
 */
export async function backfillOpenclawTier(env: Env, storage: TierStorage): Promise<TierStorage> {
  // 确保 tierOpenclaw 数组与探针成绩单已初始化
  storage.tierOpenclaw = storage.tierOpenclaw || []
  storage.probeStats = storage.probeStats || {}
  const allModels = await getAllAvailableModels(env)
  const availableMap = new Map(allModels.map((item) => [item.fullId, item]))

  // 1. 清理当前 OpenClaw 梯队中已下线或不可用的模型
  storage.tierOpenclaw = storage.tierOpenclaw.filter((m) => availableMap.has(m.fullId))
  const needed = TIER_OPENCLAW_MAX_SLOTS - storage.tierOpenclaw.length
  if (needed <= 0) return storage

  const existingFullIds = new Set(storage.tierOpenclaw.map((m) => m.fullId))

  // 2. 筛选出候选模型（未在 OpenClaw 池中的健康模型，且排除已知不兼容项）
  const candidates = allModels.filter((m) => {
    if (existingFullIds.has(m.fullId)) return false
    const mConfig = m.provider.models.find((x) => x.id === m.modelId)
    if (mConfig?.openclawTested && !mConfig.openclawCompatible) return false
    return true
  })

  if (candidates.length === 0) return storage

  // 优先排序候选人：已测试兼容的排前面
  candidates.sort((a, b) => {
    const mA = a.provider.models.find((x) => x.id === a.modelId)
    const mB = b.provider.models.find((x) => x.id === b.modelId)
    const scoreA = mA?.openclawTested ? (mA.openclawCompatible ? 2 : 0) : 1
    const scoreB = mB?.openclawTested ? (mB.openclawCompatible ? 2 : 0) : 1
    return scoreB - scoreA
  })

  // 使用双重游标自适应抽样算法选取候选模型（提供商少于等于3家抽2个，多于3家抽1个，双重游标轮转）
  const candidatesToProbe = sampleCandidatesByProviderAndModelCursors('openclaw', candidates, storage, 15)

  if (candidatesToProbe.length === 0) return storage

  // 3. 现场并发海选测速（0成本轻量握手）
  const probeResults = await Promise.allSettled(
    candidatesToProbe.map((item) => runSingleModelProbe(env, item.provider, item.modelId))
  )

  // 4. 严格过滤测通的模型，并组装实测成绩
  const qualified: Array<{ item: typeof candidatesToProbe[0]; metric: ProbeMetric }> = []
  probeResults.forEach((res, idx) => {
    if (res.status === 'fulfilled' && res.value.success) {
      qualified.push({
        item: candidatesToProbe[idx],
        metric: res.value,
      })
    }
  })

  // 5. 按本轮实测延迟从低到高排序，择优录取
  qualified.sort((a, b) => a.metric.latency - b.metric.latency)

  // 6. 晋升入池并当场登记测速成绩
  let slotsLeft = needed
  for (const q of qualified) {
    if (slotsLeft <= 0) break
    storage.tierOpenclaw.push({
      providerId: q.item.provider.id,
      modelId: q.item.modelId,
      fullId: q.item.fullId,
      addedAt: Date.now(),
    })
    // 同步记录延迟成绩单
    storage.probeStats[q.item.fullId] = q.metric
    slotsLeft--
  }

  // 7. 顺风车合并打包写入 KV（包含双重游标、入池模型与测速成绩，0额外KV写入）
  await saveTierStorage(env, storage)
  return storage
}

/**
 * 为绘图专属梯队池海选补位（双重游标自适应海选流程）：
 * 1. 按提供商与名下模型双重游标自适应抽选绘图候选人（<=3家抽2个，>3家抽1个）
 * 2. 现场并发对候选绘图模型执行轻量握手探针测速
 * 3. 严格筛选测通的模型 (success === true)
 * 4. 按照本轮实测延迟由低到高严格择优录取
 * 5. 入池同时立刻记录测速延迟成绩与游标，顺风车打包 1 次写入 KV
 */
export async function backfillDrawingTier(env: Env, storage: TierStorage): Promise<TierStorage> {
  // 确保 tierDrawing 数组与探针成绩单已初始化
  storage.tierDrawing = storage.tierDrawing || []
  storage.probeStats = storage.probeStats || {}
  const allModels = await getAllAvailableModels(env)
  const availableMap = new Map(allModels.map((item) => [item.fullId, item]))

  // 1. 清理当前绘图梯队中已下线或不可用的模型
  storage.tierDrawing = storage.tierDrawing.filter((m) => availableMap.has(m.fullId))
  const needed = TIER_DRAWING_MAX_SLOTS - storage.tierDrawing.length
  if (needed <= 0) return storage

  const existingFullIds = new Set(storage.tierDrawing.map((m) => m.fullId))

  // 2. 筛选出候选绘图模型
  const candidates = allModels.filter((m) => {
    if (existingFullIds.has(m.fullId)) return false
    const mConfig = m.provider.models.find((x) => x.id === m.modelId)
    return isDrawingModel(m.modelId, mConfig?.category)
  })

  if (candidates.length === 0) return storage

  // 使用双重游标自适应抽样算法选取绘图候选模型（提供商少于等于3家抽2个，多于3家抽1个，双重游标轮转）
  const candidatesToProbe = sampleCandidatesByProviderAndModelCursors('drawing', candidates, storage, 15)

  if (candidatesToProbe.length === 0) return storage

  // 3. 现场并发海选测速（绘图专用轻量握手探针）
  const probeResults = await Promise.allSettled(
    candidatesToProbe.map((item) => runSingleModelProbe(env, item.provider, item.modelId))
  )

  // 4. 严格过滤测通的模型，并组装实测成绩
  const qualified: Array<{ item: typeof candidatesToProbe[0]; metric: ProbeMetric }> = []
  probeResults.forEach((res, idx) => {
    if (res.status === 'fulfilled' && res.value.success) {
      qualified.push({
        item: candidatesToProbe[idx],
        metric: res.value,
      })
    }
  })

  // 5. 按本轮实测延迟从低到高严格择优录取
  qualified.sort((a, b) => a.metric.latency - b.metric.latency)

  // 6. 晋升入池并当场登记测速成绩
  let slotsLeft = needed
  for (const q of qualified) {
    if (slotsLeft <= 0) break
    storage.tierDrawing.push({
      providerId: q.item.provider.id,
      modelId: q.item.modelId,
      fullId: q.item.fullId,
      addedAt: Date.now(),
    })
    // 同步记录延迟成绩单
    storage.probeStats[q.item.fullId] = q.metric
    slotsLeft--
  }

  // 7. 顺风车合并打包写入 KV（包含双重游标、入池模型与测速成绩，0额外KV写入）
  await saveTierStorage(env, storage)
  return storage
}

/**
 * 确保梯队数据就绪（初始化/校验）
 * 平时纯读取与元数据校验，针对缺失探针数据的席位进行毫秒级并发探测补足。
 */
export async function ensureTierStorage(env: Env): Promise<TierStorage> {
  let existing = await getTierStorage(env)
  if (existing && Array.isArray(existing.tier1)) {
    // 同步并清理系统中的全部可用/已删除/已停用模型，防止新模型或被删模型导致无法补位
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

    const prevTier2Length = (existing.tier2 || []).length
    existing.tier2 = (existing.tier2 || []).filter((m) => availableSet.has(m.fullId))
    if (existing.tier2.length !== prevTier2Length) {
      changed = true
    }

    existing.tierOpenclaw = (existing.tierOpenclaw || []).filter((m) => availableSet.has(m.fullId))
    existing.tierDrawing = (existing.tierDrawing || []).filter((m) => availableSet.has(m.fullId))

    // 2. 检查专属梯队池席位（6 席），若不足调用补位逻辑（内部自动进行并发探针测速）
    if ((existing.tierOpenclaw || []).length < TIER_OPENCLAW_MAX_SLOTS) {
      existing = await backfillOpenclawTier(env, existing)
      changed = true
    }

    if ((existing.tierDrawing || []).length < TIER_DRAWING_MAX_SLOTS) {
      existing = await backfillDrawingTier(env, existing)
      changed = true
    }

    // 3. 将新增的可用模型实时同步加入第二梯队待命
    for (const item of allModels) {
      const isInTier1 = existing.tier1.some((x) => x.fullId === item.fullId)
      const isInTier2 = (existing.tier2 || []).some((x) => x.fullId === item.fullId)
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

    // 4. 若产生元数据或席位变更，顺风车合并一次性落盘 KV
    if (changed) {
      await saveTierStorage(env, existing)
    }
    return existing
  }

  // 没有任何历史梯队数据时的初始化分配
  const allModels = await getAllAvailableModels(env)
  const now = Date.now()
  const initialTier1 = allModels.slice(0, TIER_1_MAX_SLOTS).map((item) => ({
    providerId: item.provider.id,
    modelId: item.modelId,
    fullId: item.fullId,
    addedAt: now,
  }))
  const initialTier2 = allModels.slice(TIER_1_MAX_SLOTS).map((item) => ({
    providerId: item.provider.id,
    modelId: item.modelId,
    fullId: item.fullId,
    addedAt: now,
  }))
  const initialOpenclaw = allModels.filter((item) => {
    const m = item.provider.models.find((x) => x.id === item.modelId)
    return m?.openclawTested ? m.openclawCompatible : /claude|gpt|gemini|deepseek|qwen|coder/i.test(item.modelId)
  }).slice(0, TIER_OPENCLAW_MAX_SLOTS).map((item) => ({
    providerId: item.provider.id,
    modelId: item.modelId,
    fullId: item.fullId,
    addedAt: now,
  }))
  const initialDrawing = allModels.filter((item) => {
    const m = item.provider.models.find((x) => x.id === item.modelId)
    return isDrawingModel(item.modelId, m?.category)
  }).slice(0, TIER_DRAWING_MAX_SLOTS).map((item) => ({
    providerId: item.provider.id,
    modelId: item.modelId,
    fullId: item.fullId,
    addedAt: now,
  }))

  // 为初始各池席位并发补充探针数据
  const initialSeats = [...initialTier1, ...initialOpenclaw, ...initialDrawing]
  const initUnique: Array<{ provider: Provider; modelId: string; fullId: string }> = []
  const seenInit = new Set<string>()
  for (const seat of initialSeats) {
    if (seenInit.has(seat.fullId)) continue
    seenInit.add(seat.fullId)
    const found = allModels.find((m) => m.fullId === seat.fullId)
    if (found) initUnique.push(found)
  }
  const initProbeStats: Record<string, ProbeMetric> = {}
  const probeRes = await Promise.allSettled(
    initUnique.slice(0, 15).map((item) => runSingleModelProbe(env, item.provider, item.modelId))
  )
  probeRes.forEach((res, idx) => {
    if (res.status === 'fulfilled') {
      initProbeStats[initUnique[idx].fullId] = res.value
    }
  })

  const fresh: TierStorage = {
    tier1: initialTier1,
    tier2: initialTier2,
    tierOpenclaw: initialOpenclaw,
    tierDrawing: initialDrawing,
    lastProbeDate: new Date().toISOString().split('T')[0],
    probeStats: initProbeStats,
    businessStats: {},
    updatedAt: new Date().toISOString(),
    modelCursors: {},
  }
  await saveTierStorage(env, fresh)
  return fresh
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
 * 智能路由模型选取：
 * 支持通用第一梯队 ('general')、OpenClaw 专属梯队 ('openclaw')、绘图专属梯队 ('drawing')
 */
export async function selectAutoModel(
  env: Env,
  isLongText: boolean = false,
  sessionId: string | null = null,
  excludedProviderIds?: Set<string>,
  poolType: 'general' | 'openclaw' | 'drawing' = 'general'
): Promise<{ providerId: string; modelId: string; fullId: string } | null> {
  const storage = await ensureTierStorage(env)

  const allModels = await getAllAvailableModels(env)
  const modelMap = new Map(allModels.map((item) => [item.fullId, item]))

  // 1. OpenClaw 专属梯队池选择
  if (poolType === 'openclaw') {
    let pool = (storage.tierOpenclaw || []).filter((m) => modelMap.has(m.fullId))
    // 只有在池子完全为空时才紧急补位，平时直接使用池内就绪模型
    if (pool.length === 0) {
      const backfilled = await backfillOpenclawTier(env, storage)
      pool = (backfilled.tierOpenclaw || []).filter((m) => modelMap.has(m.fullId))
    }
    if (excludedProviderIds && excludedProviderIds.size > 0) {
      const filtered = pool.filter((m) => !excludedProviderIds.has(m.providerId))
      if (filtered.length > 0) pool = filtered
    }
    if (pool.length > 0) {
      const sorted = [...pool].sort((a, b) => {
        const bLatA = storage.businessStats[a.fullId]?.avgLatency ?? 999
        const bLatB = storage.businessStats[b.fullId]?.avgLatency ?? 999
        if (bLatA !== bLatB) return bLatA - bLatB
        const pLatA = storage.probeStats[a.fullId]?.latency || 9999
        const pLatB = storage.probeStats[b.fullId]?.latency || 9999
        return pLatA - pLatB
      })
      const chosen = sorted[0]
      return { providerId: chosen.providerId, modelId: chosen.modelId, fullId: chosen.fullId }
    }
    // 若 OpenClaw 专属池暂空，尝试从全部已启用的真实可用模型中挑选支持 Agent 的模型
    const fallbackOpenclaw = allModels.filter((m) => {
      const mConfig = m.provider.models.find((x) => x.id === m.modelId)
      if (mConfig?.openclawTested && !mConfig.openclawCompatible) return false
      return /deepseek|claude|gpt|gemini|qwen|glm|mimo/i.test(m.modelId)
    })
    if (fallbackOpenclaw.length > 0) {
      const chosen = fallbackOpenclaw[0]
      return { providerId: chosen.provider.id, modelId: chosen.modelId, fullId: chosen.fullId }
    }
    // 若依然没有，平滑降级至通用第一梯队
  }

  // 2. 绘图专属梯队池选择
  if (poolType === 'drawing') {
    let pool = (storage.tierDrawing || []).filter((m) => modelMap.has(m.fullId))
    // 只有在池子完全为空时才紧急补位，平时直接使用池内就绪模型
    if (pool.length === 0) {
      const backfilled = await backfillDrawingTier(env, storage)
      pool = (backfilled.tierDrawing || []).filter((m) => modelMap.has(m.fullId))
    }
    if (excludedProviderIds && excludedProviderIds.size > 0) {
      const filtered = pool.filter((m) => !excludedProviderIds.has(m.providerId))
      if (filtered.length > 0) pool = filtered
    }
    if (pool.length > 0) {
      const sorted = [...pool].sort((a, b) => {
        const bLatA = storage.businessStats[a.fullId]?.avgLatency ?? 999
        const bLatB = storage.businessStats[b.fullId]?.avgLatency ?? 999
        if (bLatA !== bLatB) return bLatA - bLatB
        const pLatA = storage.probeStats[a.fullId]?.latency || 9999
        const pLatB = storage.probeStats[b.fullId]?.latency || 9999
        return pLatA - pLatB
      })
      const chosen = sorted[0]
      return { providerId: chosen.providerId, modelId: chosen.modelId, fullId: chosen.fullId }
    }
    // 若绘图池空，尝试从全部可用模型中找一个绘图模型
    const fallbackDrawing = allModels.filter((m) => {
      const mConfig = m.provider.models.find((x) => x.id === m.modelId)
      return isDrawingModel(m.modelId, mConfig?.category)
    })
    if (fallbackDrawing.length > 0) {
      const chosen = fallbackDrawing[0]
      return { providerId: chosen.provider.id, modelId: chosen.modelId, fullId: chosen.fullId }
    }
  }

  // 3. 通用第一梯队池 (Tier 1) 选择
  let activeTier1 = storage.tier1.filter((m) => modelMap.has(m.fullId))

  // 只有在第一梯队完全没有可用模型时才紧急补位，平时直接使用池内就绪模型
  if (activeTier1.length === 0) {
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
 * ⚠️ 记录用户真实业务请求延迟
 * 采用【时间窗口节流 + 采样落盘】机制：
 * 1. 每次请求计算滑动平均延迟，保证统计准确；
 * 2. 仅在（首次请求 / 累计10次 / 距上次落盘超5分钟 / 发生调用失败）时异步写入 KV，将写入消耗降低95%以上，保护每日配额。
 */
export async function recordBusinessLatency(
  env: Env,
  fullId: string,
  latency: number,
  success: boolean,
  isAutoRequest: boolean = false
): Promise<void> {
  try {
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

    // 判断是否满足 KV 持久化条件（节流与采样）
    const isFirstRequest = bStat.totalRequests === 1
    const isBatchThreshold = bStat.totalRequests % 10 === 0
    const isTimeInterval = !bStat.lastPersistedAt || (now - bStat.lastPersistedAt >= 5 * 60 * 1000)
    const isFailure = !success

    // 严禁在此处将业务请求耗时覆盖写入 probeStats（探针延迟），两者彻底解绑，职责清晰：
    // probeStats 专属于轻量探针测试基准延迟；businessStats 专属于真实业务请求耗时。

    storage.businessStats[fullId] = bStat

    // 检查该模型是否在第一梯队或各专属梯队中
    const isInTier1 = (storage.tier1 || []).some((m) => m.fullId === fullId)
    const isInOpenclaw = (storage.tierOpenclaw || []).some((m) => m.fullId === fullId)
    const isInDrawing = (storage.tierDrawing || []).some((m) => m.fullId === fullId)
    let tierChanged = false

    if (!success && (isInTier1 || isInOpenclaw || isInDrawing)) {
      // 业务请求失败：模型标黄并设置冷却时间
      console.log(`[tiers] 业务请求失败，淘汰故障模型 ${fullId}`)

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

      // 如果在第一梯队，移出第一梯队回到第二梯队待命
      if (isInTier1) {
        storage.tier1 = storage.tier1.filter((m) => m.fullId !== fullId)
        const ref = { providerId, modelId, fullId, addedAt: now }
        if (!storage.tier2.some((m) => m.fullId === fullId)) {
          storage.tier2.push(ref)
        }
        storage = await backfillTier1FromTier2(env, storage)
        tierChanged = true
      }

      // 如果在 OpenClaw 专属池，移出并秒级补位
      if (isInOpenclaw && storage.tierOpenclaw) {
        storage.tierOpenclaw = storage.tierOpenclaw.filter((m) => m.fullId !== fullId)
        storage = await backfillOpenclawTier(env, storage)
        tierChanged = true
      }

      // 如果在绘图专属池，移出并秒级补位
      if (isInDrawing && storage.tierDrawing) {
        storage.tierDrawing = storage.tierDrawing.filter((m) => m.fullId !== fullId)
        storage = await backfillDrawingTier(env, storage)
        tierChanged = true
      }
    } else if (isAutoRequest && storage.tier1 && storage.tier1.length < TIER_1_MAX_SLOTS) {
      storage = await backfillTier1FromTier2(env, storage)
      tierChanged = true
    }

    const debugMode = await getDebugMode(env)

    // 若未发生梯队补位/淘汰保存，且满足节流写入条件，则落盘保存业务延迟指标
    if (!tierChanged && (isFirstRequest || isBatchThreshold || isTimeInterval || isFailure || debugMode)) {
      bStat.lastPersistedAt = now
      storage.businessStats[fullId] = bStat
      await saveTierStorage(env, storage)
    }
  } catch (err) {
    console.warn('[tiers] 记录业务延迟指标异常 (已安全降级):', err instanceof Error ? err.message : String(err))
  }
}
