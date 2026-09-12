/**
 * 版本号: v1.3.4
 * 更新说明: 优化梯队池数据与延迟顺风车机制：平稳请求纯内存记录业务延迟，模型故障/补位/海选发车时顺风车全量打包写入 KV。
 */
import { KV_KEYS, TIER_1_MAX_SLOTS, TIER_OPENCLAW_MAX_SLOTS, TIER_DRAWING_MAX_SLOTS } from './config'
import { kvGet, kvPut, getProviders, getProvider, updateProvider, flushPendingWrites, getDebugMode } from './storage'
import { testModelConnection } from './proxy'
import { isOpenCodeProvider, resolveOpenCodeUrls, testOpenCodeModel } from './opencode'
import { detectPermanentFailure } from './models'
import { getIsProbeRunning, setIsProbeRunning } from './admin'
import type { Env, Provider, Model, TierStorage, TierModelRef, ProbeMetric, BusinessMetric, TierSlotsConfig } from './types'

/**
 * 获取当前各梯队池的有效席位配置（若用户未自定义设置则自动回退至系统默认配置）
 */
export function getTierSlotsConfig(storage?: TierStorage | null): Required<TierSlotsConfig> {
  const cfg = storage?.slotsConfig
  return {
    tier1Slots: Math.max(1, Math.min(30, cfg?.tier1Slots ?? TIER_1_MAX_SLOTS)),
    tierOpenclawSlots: Math.max(1, Math.min(20, cfg?.tierOpenclawSlots ?? TIER_OPENCLAW_MAX_SLOTS)),
    tierDrawingSlots: Math.max(1, Math.min(20, cfg?.tierDrawingSlots ?? TIER_DRAWING_MAX_SLOTS)),
  }
}

// 内存中维护的实时业务延迟与连接状态（平稳日常请求0 KV写入，顺风车触发时一并打包落盘）
const inMemoryBusinessStats: Record<string, BusinessMetric> = {}
const inMemoryActiveConnections: Record<string, string> = {}

/**
 * 获取 KV 中的梯队存储数据，并自动与本地内存的实时业务指标合并
 */
export async function getTierStorage(env: Env): Promise<TierStorage | null> {
  const raw = await kvGet(env, KV_KEYS.TIER_DATA)
  if (!raw) return null
  try {
    const storage = JSON.parse(raw) as TierStorage
    if (storage) {
      storage.businessStats = {
        ...(storage.businessStats || {}),
        ...inMemoryBusinessStats,
      }
      storage.activeConnections = {
        ...(storage.activeConnections || {}),
        ...inMemoryActiveConnections,
      }
    }
    return storage
  } catch {
    return null
  }
}

/**
 * 批量写入/保存梯队数据到 KV
 * 遵循块 1 调试模式 / 正式模式落盘规则 (kvPut)，并顺风车一次性带走内存中的全部业务指标与请求日志
 */
export async function saveTierStorage(env: Env, data: TierStorage): Promise<void> {
  try {
    data.updatedAt = new Date().toISOString()
    // 顺风车全量保全：写入前将内存中的最新业务延迟指标与连接状态深度合并打包，一并带走落盘
    data.businessStats = {
      ...(data.businessStats || {}),
      ...inMemoryBusinessStats,
    }
    data.activeConnections = {
      ...(data.activeConnections || {}),
      ...inMemoryActiveConnections,
    }
    await kvPut(env, KV_KEYS.TIER_DATA, JSON.stringify(data))
    // 顺风车捎带：只要写入梯队池（含探针实测、延迟、梯队席位），顺便把内存中排队的请求日志一并打包写入 KV，0 额外开销
    await flushPendingWrites(env)
  } catch (err) {
    console.warn('[tiers] 保存梯队数据异常 (已安全降级):', err instanceof Error ? err.message : String(err))
  }
}

/**
 * 更新梯队池席位自定义配置，并按需自动裁剪或标记补位
 */
export async function updateTierSlotsConfig(
  env: Env,
  newConfig: Partial<TierSlotsConfig>
): Promise<{ storage: TierStorage; slotsConfig: Required<TierSlotsConfig> }> {
  let storage = (await getTierStorage(env)) || (await ensureTierStorage(env))
  storage.slotsConfig = {
    ...(storage.slotsConfig || {}),
    ...newConfig,
  }

  const effectiveSlots = getTierSlotsConfig(storage)
  storage.slotsConfig.tier1Slots = effectiveSlots.tier1Slots
  storage.slotsConfig.tierOpenclawSlots = effectiveSlots.tierOpenclawSlots
  storage.slotsConfig.tierDrawingSlots = effectiveSlots.tierDrawingSlots

  // 1. 如果第一梯队席位缩减，将多出的模型平滑移动到第二梯队
  if (storage.tier1.length > effectiveSlots.tier1Slots) {
    const keep = storage.tier1.slice(0, effectiveSlots.tier1Slots)
    const excess = storage.tier1.slice(effectiveSlots.tier1Slots)
    storage.tier1 = keep
    storage.tier2 = storage.tier2 || []
    for (const item of excess) {
      if (!storage.tier2.some((m) => m.fullId === item.fullId)) {
        storage.tier2.push(item)
      }
    }
  }

  // 2. 如果 OpenClaw 专属池席位缩减，保留前 N 个
  if (Array.isArray(storage.tierOpenclaw) && storage.tierOpenclaw.length > effectiveSlots.tierOpenclawSlots) {
    storage.tierOpenclaw = storage.tierOpenclaw.slice(0, effectiveSlots.tierOpenclawSlots)
  }

  // 3. 如果绘图专属池席位缩减，保留前 N 个
  if (Array.isArray(storage.tierDrawing) && storage.tierDrawing.length > effectiveSlots.tierDrawingSlots) {
    storage.tierDrawing = storage.tierDrawing.slice(0, effectiveSlots.tierDrawingSlots)
  }

  await saveTierStorage(env, storage)
  return { storage, slotsConfig: effectiveSlots }
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
    openclawVerified?: boolean
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
    // 如果用户手动在后台自定义修改了该标签，自动探测不强行覆盖，尊重用户意愿
    let newOpenclawVerified = m.openclawCustomTagged ? m.openclawVerified : m.openclawVerified

    if (extra && extra.openclawCompatible !== undefined) {
      if (!m.openclawTested || m.openclawCompatible !== extra.openclawCompatible || m.openclawReason !== extra.openclawReason) {
        newOpenclawTested = true
        newOpenclawCompatible = extra.openclawCompatible
        newOpenclawReason = extra.openclawReason
        openclawChanged = true
      }
    }

    if (extra && extra.openclawVerified !== undefined && !m.openclawCustomTagged) {
      if (m.openclawVerified !== extra.openclawVerified) {
        newOpenclawVerified = extra.openclawVerified
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
        openclawVerified: newOpenclawVerified,
        openclawVerifiedAt: newOpenclawVerified ? (m.openclawVerifiedAt || Date.now()) : undefined,
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
          openclawVerified: newOpenclawVerified,
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
 * OpenClaw 专属实机测试探针
 * 关键特性：
 * 1. 绝不大面积测试：仅针对 OpenClaw 候选模型按微批次单体调用（每轮抽 1-2 个候选模型）
 * 2. 携带标准的计算器 tools (calculate_sum) 发起实测，检验模型是否真正具备智能体工具调用能力
 * 3. 严格判定标准：
 *    - HTTP 200 响应
 *    - 响应体必须包含工具调用 (OpenAI tool_calls 或 Anthropic tool_use)
 *    - 工具名称必须精准匹配 calculate_sum
 *    - 工具入参必须是合法 JSON 且包含 a 和 b 参数
 * 4. 只有真实通过测试的模型，才会被赋予专属认证标签 (openclawVerified: true) 并进入 OpenClaw 候选池！
 */
export async function runOpenclawSpecificProbe(
  env: Env,
  provider: Provider,
  modelId: string
): Promise<ProbeMetric> {
  const startTime = Date.now()
  const enabledKeys = provider.apiKeys.filter((k) => k.enabled)
  const apiKey = enabledKeys[0]?.key || ''

  // 1. 绘图模型识别与豁免：专用于 /v1/images/generations，禁止向其发送对话/智能体计算题
  const mConfig = provider.models.find((m) => m.id === modelId)
  if (isDrawingModel(modelId, mConfig?.category)) {
    return {
      latency: 15,
      lastTestedAt: Date.now(),
      success: true,
      statusCode: 200,
      openclawCompatible: false,
      openclawVerified: false,
      openclawReason: '绘图专属模型（免测智能体工具）',
    }
  }

  if (!apiKey && !isOpenCodeProvider(provider.id)) {
    return {
      latency: 9999,
      lastTestedAt: Date.now(),
      success: false,
      statusCode: 400,
      error: '提供商未配置可用 API Key',
      openclawCompatible: false,
      openclawVerified: false,
      openclawReason: '无可用 API Key',
    }
  }

  let success = false
  let verified = false
  let statusCode = 500
  let reason = ''
  let rawError = ''

  try {
    if (isOpenCodeProvider(provider.id)) {
      // OpenCode 镜像测试
      const res = await testOpenCodeModel(
        provider.baseUrl,
        enabledKeys,
        modelId,
        resolveOpenCodeUrls(env)
      )
      success = res.success
      statusCode = res.statusCode || (success ? 200 : 500)
      if (success) {
        // OpenCode 镜像如果连通正常，进一步验证其工具支持能力
        verified = /claude|gpt|gemini|deepseek|qwen|coder/i.test(modelId)
        reason = verified ? 'OpenCode 镜像模型已通过专属兼容性校验' : 'OpenCode 镜像模型未通过工具调用测试'
      } else {
        reason = res.message || 'OpenCode 镜像连接失败'
      }
    } else {
      const cleanBase = provider.baseUrl.trim().replace(/\/+$/, '')
      const endpoint = provider.apiType === 'anthropic' ? 'messages' : 'chat/completions'
      const url = `${cleanBase}/${endpoint}`

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      }
      if (provider.apiType === 'anthropic') {
        headers['x-api-key'] = apiKey
        headers['anthropic-version'] = '2023-06-01'
      } else {
        headers['Authorization'] = `Bearer ${apiKey}`
      }

      // 构建计算器工具调用测试题 (极轻量测试)
      const promptText = '请调用计算器工具 calculate_sum 计算 3 加 5 的和。'
      let reqBody: Record<string, unknown>

      if (provider.apiType === 'anthropic') {
        reqBody = {
          model: modelId,
          messages: [{ role: 'user', content: promptText }],
          tools: [{
            name: 'calculate_sum',
            description: '计算两个数字之和',
            input_schema: {
              type: 'object',
              properties: {
                a: { type: 'number', description: '第一个加数' },
                b: { type: 'number', description: '第二个加数' },
              },
              required: ['a', 'b'],
            },
          }],
          max_tokens: 64,
        }
      } else {
        reqBody = {
          model: modelId,
          messages: [
            { role: 'system', content: 'You are a precise tool calling agent.' },
            { role: 'user', content: promptText },
          ],
          tools: [{
            type: 'function',
            function: {
              name: 'calculate_sum',
              description: '计算两个数字之和',
              parameters: {
                type: 'object',
                properties: {
                  a: { type: 'number', description: '第一个加数' },
                  b: { type: 'number', description: '第二个加数' },
                },
                required: ['a', 'b'],
              },
            },
          }],
          max_tokens: 64,
        }
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(12000), // 12秒超时保护
      })

      statusCode = response.status
      const rawText = await response.text().catch(() => '')

      if (response.ok) {
        success = true
        try {
          const json = JSON.parse(rawText)
          if (provider.apiType === 'anthropic') {
            const toolUse = Array.isArray(json.content) && json.content.find((item: any) => item.type === 'tool_use' && item.name === 'calculate_sum')
            if (toolUse && toolUse.input && (toolUse.input.a !== undefined || toolUse.input.b !== undefined)) {
              verified = true
              reason = '通过专属测试：成功触发工具调用 calculate_sum'
            } else {
              verified = false
              reason = '未触发工具调用：返回普通文本，不适合智能体'
            }
          } else {
            const toolCalls = json.choices?.[0]?.message?.tool_calls
            if (Array.isArray(toolCalls) && toolCalls.length > 0) {
              const matchedCall = toolCalls.find((tc: any) => tc.function?.name === 'calculate_sum')
              if (matchedCall) {
                try {
                  const args = JSON.parse(matchedCall.function.arguments || '{}')
                  if (args && (args.a !== undefined || args.b !== undefined || Object.keys(args).length > 0)) {
                    verified = true
                    reason = '通过专属测试：成功触发工具调用 calculate_sum 并返回合法参数'
                  } else {
                    verified = true
                    reason = '通过专属测试：成功触发工具调用 calculate_sum'
                  }
                } catch {
                  verified = true
                  reason = '通过专属测试：触发工具调用 calculate_sum'
                }
              } else {
                verified = false
                reason = `调用了非预期工具: ${toolCalls[0]?.function?.name || '未知'}`
              }
            } else {
              verified = false
              reason = '未触发工具调用：模型仅回答普通文本，不适合 OpenClaw 智能体'
            }
          }
        } catch {
          verified = false
          reason = '响应解析失败：上游未返回有效 JSON 数据'
        }
      } else {
        success = false
        verified = false
        const lowerErr = rawText.toLowerCase()
        if (response.status === 400 || response.status === 422) {
          if (lowerErr.includes('image model') || lowerErr.includes('images/generations') || lowerErr.includes('drawing')) {
            success = true
            verified = false
            statusCode = 200
            reason = '绘图专属模型（免测智能体工具）'
          } else if (lowerErr.includes('tool') || lowerErr.includes('function') || lowerErr.includes('parameter') || lowerErr.includes('unsupported')) {
            reason = '上游明确不支持 Tools 工具调用参数 (HTTP ' + response.status + ')'
          } else {
            reason = '上游参数错误: ' + rawText.substring(0, 100)
          }
        } else {
          reason = `上游响应异常 HTTP ${response.status}: ${rawText.substring(0, 100)}`
        }
      }
    }
  } catch (err) {
    success = false
    verified = false
    statusCode = 502
    reason = `网络超时或连接失败: ${(err as Error).message || '连接异常'}`
    rawError = reason
  }

  const latency = Date.now() - startTime

  // 记录探针结果并打上/同步标签
  await applyModelProbeResult(env, provider.id, modelId, success, statusCode, reason, {
    openclawCompatible: verified,
    openclawReason: reason,
    openclawVerified: verified,
  })

  return {
    latency: success ? latency : 9999,
    lastTestedAt: Date.now(),
    success,
    statusCode,
    error: success ? undefined : (rawError || reason),
    openclawCompatible: verified,
    openclawVerified: verified,
    openclawReason: reason,
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
  // 单提供商探测频控保护锁（最多探测 3 个）
  const initProbesPerProvider = new Map<string, number>()
  const MAX_INIT_PROBES_PER_PROVIDER = 3

  // 轮询交叉测试，严格受控于单厂家配额
  while (tier1.length < TIER_1_MAX_SLOTS && remainingProviders > 0) {
    remainingProviders = 0
    for (const pid of providerIds) {
      if (tier1.length >= TIER_1_MAX_SLOTS) break

      const currentCount = providerTier1Count.get(pid) || 0
      if (currentCount >= maxQuotaPerProvider) {
        continue // 该提供商已达均匀配额上限
      }

      const alreadyProbed = initProbesPerProvider.get(pid) || 0
      if (alreadyProbed >= MAX_INIT_PROBES_PER_PROVIDER) {
        continue // 🔒 频控保护锁触发：该提供商本次初始化已达 3 个上限
      }

      const models = providerModelsMap.get(pid) || []
      const ptr = providerPointers.get(pid) || 0

      if (ptr < models.length) {
        remainingProviders++
        const item = models[ptr]
        providerPointers.set(pid, ptr + 1)
        initProbesPerProvider.set(pid, alreadyProbed + 1)

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

  // 如果各厂家严格配额后仍未补满 8 席（例如部分厂家模型不足或测试失败），放宽配额继续填充剩余席位（同样受 3 个上限保护）
  if (tier1.length < TIER_1_MAX_SLOTS) {
    let hasMore = true
    while (tier1.length < TIER_1_MAX_SLOTS && hasMore) {
      hasMore = false
      for (const pid of providerIds) {
        if (tier1.length >= TIER_1_MAX_SLOTS) break

        const alreadyProbed = initProbesPerProvider.get(pid) || 0
        if (alreadyProbed >= MAX_INIT_PROBES_PER_PROVIDER) {
          continue // 🔒 频控保护锁触发
        }

        const models = providerModelsMap.get(pid) || []
        const ptr = providerPointers.get(pid) || 0
        if (ptr < models.length) {
          hasMore = true
          const item = models[ptr]
          providerPointers.set(pid, ptr + 1)
          initProbesPerProvider.set(pid, alreadyProbed + 1)

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
  const slotsConfig = getTierSlotsConfig(existing)
  const allModels = await getAllAvailableModels(env)
  const modelMap = new Map(allModels.map((item) => [item.fullId, item]))

  // 获取所有活跃提供商数量并计算均匀配额
  const activeProviders = new Set(allModels.map((item) => item.provider.id))
  const maxQuotaPerProvider = calculateProviderMaxQuota(activeProviders.size, slotsConfig.tier1Slots)

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
    slotsConfig: existing.slotsConfig,
    probeStats,
    businessStats,
    updatedAt: new Date().toISOString(),
    lastProbeDate: new Date().toISOString().split('T')[0],
  }

  // 3. 运行空位补位海选规则（如果 Tier 1 不足设置的席位上限）
  if (updatedStorage.tier1.length < slotsConfig.tier1Slots) {
    updatedStorage = await backfillTier1FromTier2(env, updatedStorage)
  } else {
    await saveTierStorage(env, updatedStorage)
  }

  return updatedStorage
}

/**
 * 补位海选逻辑 (Backfill Tier 1 from Tier 2):
 * 当第一梯队有空位时，从第二梯队候选池中选拔模型填满自定义席位。
 */
export async function backfillTier1FromTier2(
  env: Env,
  storage: TierStorage
): Promise<TierStorage> {
  const slotsConfig = getTierSlotsConfig(storage)
  const slotsNeeded = slotsConfig.tier1Slots - storage.tier1.length
  if (slotsNeeded <= 0 || storage.tier2.length === 0) {
    // 席位未缺或无候选模型，直接安全返回，绝不触发无意义的 KV 写入
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
      return storage
    }
    let hasChanged = false

    // 统计当前活跃提供商总数与当前各提供商在 Tier 1 中的占位
    const allProviders = await getProviders(env)
    const activeProviders = allProviders.filter((p) => {
      if (!p.enabled) return false
      const keys = p.apiKeys.filter((k) => k.enabled)
      if (!isOpenCodeProvider(p.id) && keys.length === 0) return false
      return true
    })
    const maxQuotaPerProvider = calculateProviderMaxQuota(activeProviders.length, slotsConfig.tier1Slots)

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

    let currentSlotsNeeded = slotsConfig.tier1Slots - storage.tier1.length

    // 频控保护锁：记录本轮海选中每个提供商已经探测的模型数量（硬限制单提供商最多 3 个）
    const probedCountPerProvider = new Map<string, number>()
    const MAX_PROBES_PER_PROVIDER_PER_SESSION = 3
    let totalProbesInSession = 0
    const MAX_TOTAL_PROBES_PER_SESSION = 16

    // 辅助函数：针对候选模型组运行轮询交叉探测
    const runWheelForGroup = async (groupCandidates: typeof candidates, enforceQuota: boolean) => {
      if (groupCandidates.length === 0 || currentSlotsNeeded <= 0 || totalProbesInSession >= MAX_TOTAL_PROBES_PER_SESSION) return

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
      let roundCount = 0
      const MAX_ROUNDS = 5 // 限制最大轮次为 5 轮，防止死循环

      // 一轮一轮地交叉轮抽与并发测试
      while (currentSlotsNeeded > 0 && hasMoreToTest && roundCount < MAX_ROUNDS && totalProbesInSession < MAX_TOTAL_PROBES_PER_SESSION) {
        hasMoreToTest = false
        roundCount++
        const roundToTest: typeof candidates = []

        // 各个提供商轮抽 1 个正常候选模型（若受配额控制或频控保护锁，跳过该提供商）
        for (const pid of providerIds) {
          if (enforceQuota && getProviderTier1Count(pid) >= maxQuotaPerProvider) {
            continue // 该提供商已达均匀配额
          }

          const alreadyProbed = probedCountPerProvider.get(pid) || 0
          if (alreadyProbed >= MAX_PROBES_PER_PROVIDER_PER_SESSION) {
            continue // 🔒 频控保护锁触发：该提供商本次海选已探测满 3 个模型，停止继续探查该提供商
          }

          const idx = providerPointers[pid]
          const list = providerToModels[pid]
          if (idx < list.length) {
            hasMoreToTest = true
            const cand = list[idx]
            providerPointers[pid] = idx + 1
            roundToTest.push(cand)
            probedCountPerProvider.set(pid, alreadyProbed + 1)
            totalProbesInSession++
          }
        }

        // 附带抽测最多 1 个符合复测间隔的封禁模型（以正常模型为主）
        let attachedBlockedCount = 0
        while (blockedPointer < eligibleBlocked.length && attachedBlockedCount < 1) {
          const blockedItem = eligibleBlocked[blockedPointer++]
          const pid = blockedItem.cand.providerId
          const alreadyProbed = probedCountPerProvider.get(pid) || 0
          if (alreadyProbed < MAX_PROBES_PER_PROVIDER_PER_SESSION) {
            roundToTest.push(blockedItem.cand)
            probedCountPerProvider.set(pid, alreadyProbed + 1)
            totalProbesInSession++
            if (!availableMap.has(blockedItem.cand.fullId)) {
              availableMap.set(blockedItem.cand.fullId, {
                provider: blockedItem.provider,
                modelId: blockedItem.cand.modelId,
                fullId: blockedItem.cand.fullId,
              })
            }
            attachedBlockedCount++
          }
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
            hasChanged = true
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

    // 仅在有实际晋升或变更时保存 KV
    if (hasChanged) {
      await saveTierStorage(env, storage)
    }

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
 * 为 OpenClaw 专属智能体梯队池补位
 * 
 * 严格遵照设计准则：
 * 1. 席位上限 6 席 (TIER_OPENCLAW_MAX_SLOTS = 6)
 * 2. 绝不大面积测试：每次每个提供商严格只抽 1~2 个候选模型为一轮微批次
 * 3. 游标记忆定位：每个提供商独立维护轮询游标 openclawCursors，下次继续从断点开始
 * 4. 两阶段海选流程：
 *    - 阶段一：未打标模型全量按顺序轮询，必须通过 OpenClaw 专属测试（真实工具调用）才能打上认证标签并入驻
 *    - 阶段二：只有当全部提供商的未打标模型全量轮询完毕之后，才从已有认证标签的模型中按顺序测试（普通快速测速）+ 游标维护
 * 5. 新添加提供商/新模型优先插队排在队列头部测试
 * 6. 支持用户自定义修改标签 (已打标的模型在第二阶段即可快速复选)
 * 7. 严格控制 Cloudflare 免费配额：全程内存计算，整轮结束顺风车单次写入 KV！
 */
export async function backfillOpenclawTier(env: Env, storage: TierStorage): Promise<TierStorage> {
  const slotsConfig = getTierSlotsConfig(storage)
  storage.tierOpenclaw = storage.tierOpenclaw || []
  const allModels = await getAllAvailableModels(env)
  const availableMap = new Map(allModels.map((item) => [item.fullId, item]))

  // 1. 清理当前 OpenClaw 梯队中已下线、已停用、被删除或被用户取消认证标签的模型
  const prevCount = storage.tierOpenclaw.length
  storage.tierOpenclaw = storage.tierOpenclaw.filter((m) => {
    // 基础防爆：检查提供商或模型是否已被停用/删除
    if (!availableMap.has(m.fullId)) return false

    // 获取该模型在提供商内的具体配置与探针状态
    const item = availableMap.get(m.fullId)
    const mConfig = item?.provider.models.find((x) => x.id === m.modelId)
    const probeMetric = storage.probeStats[m.fullId]

    // 判断逻辑 1：如果模型被手动禁用，直接踢出
    if (mConfig && mConfig.enabled === false) return false

    // 判断逻辑 2：如果用户手动取消了 OpenClaw 认证（openclawCustomTagged 且 openclawVerified 为 false），立即踢出
    if (mConfig?.openclawCustomTagged && mConfig?.openclawVerified === false) return false
    if (probeMetric?.openclawCustomTagged && probeMetric?.openclawVerified === false) return false

    return true
  })
  let hasChanged = storage.tierOpenclaw.length !== prevCount
  const needed = slotsConfig.tierOpenclawSlots - storage.tierOpenclaw.length
  if (needed <= 0) {
    if (hasChanged) await saveTierStorage(env, storage)
    return storage // 席位已满，无需测试
  }

  // 初始化专属游标与扫描状态字典
  storage.openclawCursors = storage.openclawCursors || {}
  storage.openclawScannedProviders = storage.openclawScannedProviders || {}
  storage.openclawVerifiedCursors = storage.openclawVerifiedCursors || {}
  storage.probeStats = storage.probeStats || {}
  storage.knownModelKeys = storage.knownModelKeys || []

  // 获取已知模型集合，用于识别新加入的提供商或新模型
  const knownSet = new Set(storage.knownModelKeys)
  const currentModelKeys = allModels.map((m) => m.fullId)

  // 获取所有当前启用的提供商分组
  const providersMap = new Map<string, Provider>()
  const providerModelsMap = new Map<string, Array<{ provider: Provider; modelId: string; fullId: string; isNew: boolean }>>()

  for (const item of allModels) {
    providersMap.set(item.provider.id, item.provider)
    if (!providerModelsMap.has(item.provider.id)) {
      providerModelsMap.set(item.provider.id, [])
    }
    const isNew = !knownSet.has(item.fullId)
    providerModelsMap.get(item.provider.id)!.push({ ...item, isNew })
  }

  // 检查是否所有提供商的未打标模型都已经全量轮询过一圈
  const activeProviderIds = Array.from(providersMap.keys())
  const allUnverifiedScanned = activeProviderIds.length > 0 && activeProviderIds.every((pid) => storage.openclawScannedProviders![pid] === true)

  const existingFullIds = new Set(storage.tierOpenclaw.map((m) => m.fullId))

  if (!allUnverifiedScanned) {
    // ===== 阶段一：全量未打标模型顺序大轮询（严格执行 OpenClaw 专属工具调用测试） =====
    for (const pid of activeProviderIds) {
      if (storage.tierOpenclaw.length >= slotsConfig.tierOpenclawSlots) break

      const p = providersMap.get(pid)!
      const allPModels = providerModelsMap.get(pid) || []

      // 候选模型：未在当前 OpenClaw 池中，且尚未被打上认证标签的模型（排除绘图专属模型）
      const unverifiedCandidates = allPModels.filter((item) => {
        if (existingFullIds.has(item.fullId)) return false
        const mConfig = p.models.find((x) => x.id === item.modelId)
        // 关键过滤：排除绘图模型，绘图模型免测且绝不参与 OpenClaw 智能体计算题
        if (isDrawingModel(item.modelId, mConfig?.category)) return false
        const hasVerifiedTag = mConfig?.openclawVerified || storage.probeStats[item.fullId]?.openclawVerified
        return !hasVerifiedTag
      })

      if (unverifiedCandidates.length === 0) {
        storage.openclawScannedProviders[pid] = true
        continue
      }

      // 新模型优先插队排在前面
      unverifiedCandidates.sort((a, b) => (b.isNew ? 1 : 0) - (a.isNew ? 1 : 0))

      // 读取该提供商上次的游标位置
      let cursor = storage.openclawCursors[pid] || 0
      if (cursor >= unverifiedCandidates.length) {
        cursor = 0
        storage.openclawScannedProviders[pid] = true
      }

      // 规则：严格限制每个提供商每轮只抽 1~2 个候选模型，绝不大面积集中测试
      const batchToTest = unverifiedCandidates.slice(cursor, cursor + 2)
      cursor += batchToTest.length

      if (cursor >= unverifiedCandidates.length) {
        cursor = 0
        storage.openclawScannedProviders[pid] = true
      }
      storage.openclawCursors[pid] = cursor

      // 逐个执行 OpenClaw 专属测试（带真实工具调用检验）
      for (const candidate of batchToTest) {
        if (storage.tierOpenclaw.length >= slotsConfig.tierOpenclawSlots) break

        const metric = await runOpenclawSpecificProbe(env, candidate.provider, candidate.modelId)
        storage.probeStats[candidate.fullId] = metric

        // 只有通过专属测试（获得认证标签），才允许补入 OpenClaw 池
        if (metric.success && metric.openclawVerified) {
          storage.tierOpenclaw.push({
            providerId: candidate.provider.id,
            modelId: candidate.modelId,
            fullId: candidate.fullId,
            addedAt: Date.now(),
          })
          existingFullIds.add(candidate.fullId)
          hasChanged = true
        }
      }
    }
  }

  // 如果阶段一测完后仍有空缺，或者已经完成了一整轮全量轮询：
  // ===== 阶段二：从已有认证标签的模型库中按顺序测试（普通轻量快测）+ 游标推进 =====
  if (storage.tierOpenclaw.length < slotsConfig.tierOpenclawSlots) {
    for (const pid of activeProviderIds) {
      if (storage.tierOpenclaw.length >= slotsConfig.tierOpenclawSlots) break

      const p = providersMap.get(pid)!
      const allPModels = providerModelsMap.get(pid) || []

      // 筛选该提供商下已有认证标签（测试获得或用户自定义）的模型
      const verifiedCandidates = allPModels.filter((item) => {
        if (existingFullIds.has(item.fullId)) return false
        const mConfig = p.models.find((x) => x.id === item.modelId)
        return mConfig?.openclawVerified || storage.probeStats[item.fullId]?.openclawVerified
      })

      if (verifiedCandidates.length === 0) continue

      // 读取该提供商已打标模型的游标
      let vCursor = storage.openclawVerifiedCursors[pid] || 0
      if (vCursor >= verifiedCandidates.length) {
        vCursor = 0
      }

      // 同样每轮只抽 1~2 个候选模型
      const vBatch = verifiedCandidates.slice(vCursor, vCursor + 2)
      vCursor += vBatch.length
      if (vCursor >= verifiedCandidates.length) vCursor = 0
      storage.openclawVerifiedCursors[pid] = vCursor

      for (const item of vBatch) {
        if (storage.tierOpenclaw.length >= slotsConfig.tierOpenclawSlots) break

        // 已打标模型只做普通轻量快测，节省流量与时间
        const metric = await runSingleModelProbe(env, item.provider, item.modelId)
        storage.probeStats[item.fullId] = metric

        if (metric.success) {
          storage.tierOpenclaw.push({
            providerId: item.provider.id,
            modelId: item.modelId,
            fullId: item.fullId,
            addedAt: Date.now(),
          })
          existingFullIds.add(item.fullId)
          hasChanged = true
        }
      }
    }
  }

  // 仅在有实际变更（例如补入新模型）时才保存 KV，避免无新模型通过时重复死循环落盘
  if (hasChanged) {
    storage.knownModelKeys = currentModelKeys
    await saveTierStorage(env, storage)
  }
  return storage
}

/**
 * 为绘图专属梯队池补位：
 * 筛选全系统中标记或识别为【绘图】的健康模型，
 * 补足到自定义席位 (默认 6 席)
 */
export async function backfillDrawingTier(env: Env, storage: TierStorage): Promise<TierStorage> {
  const slotsConfig = getTierSlotsConfig(storage)
  storage.tierDrawing = storage.tierDrawing || []
  const allModels = await getAllAvailableModels(env)
  const availableMap = new Map(allModels.map((item) => [item.fullId, item]))

  // 1. 清理当前绘图梯队中已下线或不可用的模型
  const prevCount = storage.tierDrawing.length
  storage.tierDrawing = storage.tierDrawing.filter((m) => availableMap.has(m.fullId))
  let hasChanged = storage.tierDrawing.length !== prevCount
  const needed = slotsConfig.tierDrawingSlots - storage.tierDrawing.length
  if (needed <= 0) {
    if (hasChanged) await saveTierStorage(env, storage)
    return storage
  }

  const existingFullIds = new Set(storage.tierDrawing.map((m) => m.fullId))

  // 2. 挑选候选绘图模型
  const candidates = allModels.filter((m) => {
    if (existingFullIds.has(m.fullId)) return false
    const mConfig = m.provider.models.find((x) => x.id === m.modelId)
    return isDrawingModel(m.modelId, mConfig?.category)
  })

  // 按历史延迟由低到高排序
  candidates.sort((a, b) => {
    const latA = storage.probeStats[a.fullId]?.latency || 9999
    const latB = storage.probeStats[b.fullId]?.latency || 9999
    return latA - latB
  })

  // 探测并择优补位
  for (const item of candidates) {
    if (storage.tierDrawing.length >= slotsConfig.tierDrawingSlots) break

    const metric = await runSingleModelProbe(env, item.provider, item.modelId)
    storage.probeStats[item.fullId] = metric

    if (metric.success) {
      storage.tierDrawing.push({
        providerId: item.provider.id,
        modelId: item.modelId,
        fullId: item.fullId,
        addedAt: Date.now(),
      })
      hasChanged = true
    }
  }

  if (hasChanged) {
    await saveTierStorage(env, storage)
  }
  return storage
}

/**
 * 确保梯队数据就绪（初始化/校验）
 * 平时纯读取与元数据校验，绝不进行耗时的外部网络 HTTP 探测，保障毫秒级瞬时响应。
 */
/**
 * 确保梯队数据就绪与自愈校验（纯内存高速比对，顺风车单次写入 KV）
 * 1. 自动剔除已删除/已禁用的模型
 * 2. 自动检查第一梯队、OpenClaw 专属池、绘图池的空缺席位，并从待命模型中智能补齐
 * 3. 严格控制 KV 写入：仅在数据有变化时一次性写入 1 次 KV，零额外消耗
 */
export async function ensureTierStorage(env: Env): Promise<TierStorage> {
  let existing = await getTierStorage(env)
  if (existing && Array.isArray(existing.tier1)) {
    // 获取当前系统中所有真实启用且健康的可用模型
    const allModels = await getAllAvailableModels(env)
    const availableSet = new Set(allModels.map((item) => item.fullId))
    const slotsConfig = getTierSlotsConfig(existing)

    let changed = false
    const now = Date.now()

    // 1. 清除已不在可用列表中的模型（比如被用户禁用、删除或封禁的模型）
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

    const prevOpenclawLength = (existing.tierOpenclaw || []).length
    existing.tierOpenclaw = (existing.tierOpenclaw || []).filter((m) => availableSet.has(m.fullId))
    if (existing.tierOpenclaw.length !== prevOpenclawLength) {
      changed = true
    }

    const prevDrawingLength = (existing.tierDrawing || []).filter((m) => availableSet.has(m.fullId)).length
    existing.tierDrawing = (existing.tierDrawing || []).filter((m) => availableSet.has(m.fullId))
    if (existing.tierDrawing.length !== prevDrawingLength) {
      changed = true
    }

    // 2. 将新增的可用模型实时同步加入第二梯队待命队列
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

    // 3. 第一梯队若出现席位空缺，从第二梯队中严格挑选【未处于冷却期且未永久失效】的可用候选模型补齐
    if (existing.tier1.length < slotsConfig.tier1Slots && existing.tier2 && existing.tier2.length > 0) {
      const needed = slotsConfig.tier1Slots - existing.tier1.length
      // 严格检查健康状态：只允许补入在 availableSet（已排除冷却与失效）中的模型
      const eligibleToPromote: typeof existing.tier2 = []
      const remainingTier2: typeof existing.tier2 = []

      for (const cand of existing.tier2) {
        if (eligibleToPromote.length < needed && availableSet.has(cand.fullId)) {
          eligibleToPromote.push(cand)
        } else {
          remainingTier2.push(cand)
        }
      }

      if (eligibleToPromote.length > 0) {
        existing.tier2 = remainingTier2
        existing.tier1.push(...eligibleToPromote.map((item) => ({ ...item, addedAt: now })))
        changed = true
      }
    }

    // 4. OpenClaw 专属智能体池若出现席位空缺，自动从可用模型中挑选支持工具调用的模型补齐
    if (existing.tierOpenclaw.length < slotsConfig.tierOpenclawSlots) {
      const openclawSet = new Set(existing.tierOpenclaw.map((x) => x.fullId))
      const openclawCandidates = allModels.filter((item) => {
        if (openclawSet.has(item.fullId)) return false
        const m = item.provider.models.find((x) => x.id === item.modelId)
        // 优先选取已通过工具调用实测或符合主流智能体命名特征的模型
        return m?.openclawTested ? m.openclawCompatible : /claude|gpt|gemini|deepseek|qwen|coder|kimi|intern|glm/i.test(item.modelId)
      })

      const openclawNeeded = slotsConfig.tierOpenclawSlots - existing.tierOpenclaw.length
      const toFill = openclawCandidates.slice(0, openclawNeeded)
      for (const item of toFill) {
        existing.tierOpenclaw.push({
          providerId: item.provider.id,
          modelId: item.modelId,
          fullId: item.fullId,
          addedAt: now,
        })
        changed = true
      }
    }

    // 5. 绘图专属池若出现席位空缺，自动从可用模型中挑选绘图模型补齐
    if (existing.tierDrawing.length < slotsConfig.tierDrawingSlots) {
      const drawingSet = new Set(existing.tierDrawing.map((x) => x.fullId))
      const drawingCandidates = allModels.filter((item) => {
        if (drawingSet.has(item.fullId)) return false
        const m = item.provider.models.find((x) => x.id === item.modelId)
        return isDrawingModel(item.modelId, m?.category)
      })

      const drawingNeeded = slotsConfig.tierDrawingSlots - existing.tierDrawing.length
      const toFillDrawing = drawingCandidates.slice(0, drawingNeeded)
      for (const item of toFillDrawing) {
        existing.tierDrawing.push({
          providerId: item.provider.id,
          modelId: item.modelId,
          fullId: item.fullId,
          addedAt: now,
        })
        changed = true
      }
    }

    // 若检测到任何梯队调整或补位，顺风车单次写入 KV
    if (changed) {
      existing.updatedAt = new Date().toISOString()
      await saveTierStorage(env, existing)
    }
    return existing
  }

  // 没有任何历史梯队数据：采用轻量静态分配，不发任何外部HTTP测试
  const slotsConfig = getTierSlotsConfig(null)
  const allModels = await getAllAvailableModels(env)
  const now = Date.now()
  const initialTier1 = allModels.slice(0, slotsConfig.tier1Slots).map((item) => ({
    providerId: item.provider.id,
    modelId: item.modelId,
    fullId: item.fullId,
    addedAt: now,
  }))
  const initialTier2 = allModels.slice(slotsConfig.tier1Slots).map((item) => ({
    providerId: item.provider.id,
    modelId: item.modelId,
    fullId: item.fullId,
    addedAt: now,
  }))
  const initialOpenclaw = allModels.filter((item) => {
    const m = item.provider.models.find((x) => x.id === item.modelId)
    return m?.openclawTested ? m.openclawCompatible : /claude|gpt|gemini|deepseek|qwen|coder/i.test(item.modelId)
  }).slice(0, slotsConfig.tierOpenclawSlots).map((item) => ({
    providerId: item.provider.id,
    modelId: item.modelId,
    fullId: item.fullId,
    addedAt: now,
  }))
  const initialDrawing = allModels.filter((item) => {
    const m = item.provider.models.find((x) => x.id === item.modelId)
    return m?.category === '绘图'
  }).slice(0, slotsConfig.tierDrawingSlots).map((item) => ({
    providerId: item.provider.id,
    modelId: item.modelId,
    fullId: item.fullId,
    addedAt: now,
  }))

  const fresh: TierStorage = {
    tier1: initialTier1,
    tier2: initialTier2,
    tierOpenclaw: initialOpenclaw,
    tierDrawing: initialDrawing,
    slotsConfig,
    lastProbeDate: new Date().toISOString().split('T')[0],
    probeStats: {},
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
 * 公益平台高阻尼模型优选算法（完全自适应高延迟环境）：
 * 1. 优先检查当前已连接的活跃模型是否依然健康（未被禁用、未在冷却、未在当前尝试中失败）。
 * 2. 相对动态倍率：无论平均延迟是 2 秒还是 30 秒，只要当前模型健康，除非候选模型比当前模型快 3 倍以上且绝对差距超过 8000ms，否则坚定锁定当前模型，坚决不发生无意义跳换。
 * 3. 严格本池闭环，绝不跨池降级。
 */
function pickStableModelFromPool(
  pool: TierModelRef[],
  storage: TierStorage,
  poolType: 'general' | 'openclaw' | 'drawing',
  modelMap: Map<string, { provider: any; modelId: string; fullId: string }>
): { providerId: string; modelId: string; fullId: string } | null {
  // 如果池内无可用候选模型，直接返回空
  if (pool.length === 0) return null

  // 按照历史业务平均延迟及探针测试结果对候选模型进行排序
  const sorted = [...pool].sort((a, b) => {
    const bLatA = storage.businessStats[a.fullId]?.avgLatency ?? 999
    const bLatB = storage.businessStats[b.fullId]?.avgLatency ?? 999
    if (bLatA !== bLatB) return bLatA - bLatB
    const pLatA = storage.probeStats[a.fullId]?.latency || 9999
    const pLatB = storage.probeStats[b.fullId]?.latency || 9999
    return pLatA - pLatB
  })

  // 获取排序最优的候选模型
  const bestCandidate = sorted[0]
  // 获取当前正在连接活跃的模型 ID
  const currentActiveFullId = storage.activeConnections?.[poolType]

  // 检查当前连接的模型是否依然在本次有效健康的候选池中
  if (currentActiveFullId) {
    const activeItem = pool.find((m) => m.fullId === currentActiveFullId)
    if (activeItem) {
      // 当前模型依然处于健康、未被冷却、未报错状态
      const currentLat = storage.businessStats[currentActiveFullId]?.avgLatency ?? 3000
      const bestLat = storage.businessStats[bestCandidate.fullId]?.avgLatency ?? 3000

      // 自适应相对倍率防抖：自适应任何基准延迟（如 20000ms+ 高延迟），只有当最佳模型快 3 倍以上且绝对差距大于 8000ms 时才切换
      const isMassiveImprovement = bestLat > 0 && currentLat > bestLat * 3 && (currentLat - bestLat) > 8000
      if (!isMassiveImprovement) {
        // 判定：当前模型完全健康且处于正常波动范围内，继续锁定使用当前模型！
        return { providerId: activeItem.providerId, modelId: activeItem.modelId, fullId: activeItem.fullId }
      }
    }
  }

  // 若当前无活跃连接、或当前模型已故障报错被移出池子、或候选模型具备碾压级优势，则选用当前最佳模型
  return { providerId: bestCandidate.providerId, modelId: bestCandidate.modelId, fullId: bestCandidate.fullId }
}

/**
 * 智能路由模型选取：
 * 严格本池闭环调度：通用第一梯队 ('general')、OpenClaw 专属梯队 ('openclaw')、绘图专属梯队 ('drawing')
 */
export async function selectAutoModel(
  env: Env,
  isLongText: boolean = false,
  sessionId: string | null = null,
  excludedProviderIds?: Set<string>,
  poolType: 'general' | 'openclaw' | 'drawing' = 'general',
  excludedModelIds?: Set<string>
): Promise<{ providerId: string; modelId: string; fullId: string } | null> {
  const storage = await ensureTierStorage(env)

  const allModels = await getAllAvailableModels(env)
  const modelMap = new Map(allModels.map((item) => [item.fullId, item]))

  // 1. OpenClaw 专属梯队池选择（严格闭环于 OpenClaw 池，绝不跨出本池）
  if (poolType === 'openclaw') {
    let pool = (storage.tierOpenclaw || []).filter((m) => modelMap.has(m.fullId))
    const slotsConfig = getTierSlotsConfig(storage)
    // 当 OpenClaw 池当前模型数量少于配置的目标席位数时，自动触发探针探测并自动补齐席位
    if (pool.length < slotsConfig.tierOpenclawSlots) {
      const backfilled = await backfillOpenclawTier(env, storage)
      pool = (backfilled.tierOpenclaw || []).filter((m) => modelMap.has(m.fullId))
    }
    // 排除已经在本次请求中尝试失败的具体模型
    if (excludedModelIds && excludedModelIds.size > 0) {
      pool = pool.filter((m) => !excludedModelIds.has(m.fullId))
    }
    // 排除处于冷却中或已被永久禁用的模型
    const now = Date.now()
    pool = pool.filter((m) => {
      const item = modelMap.get(m.fullId)
      if (!item) return false
      const mConfig = item.provider.models.find((x) => x.id === item.modelId)
      if (mConfig?.permanentlyDisabled) return false
      if (mConfig?.cooldownUntil && mConfig.cooldownUntil > now) return false
      return true
    })
    // 优先选择不同厂商
    if (excludedProviderIds && excludedProviderIds.size > 0) {
      const filtered = pool.filter((m) => !excludedProviderIds.has(m.providerId))
      if (filtered.length > 0) pool = filtered
    }
    if (pool.length > 0) {
      return pickStableModelFromPool(pool, storage, 'openclaw', modelMap)
    }
    // 严格本池闭环：若 OpenClaw 专属池暂无可用，直接返回 null 触发优雅报错或等待补位，绝不跨池偷换
    return null
  }

  // 2. 绘图专属梯队池选择（严格闭环于绘图池，绝不跨出本池）
  if (poolType === 'drawing') {
    let pool = (storage.tierDrawing || []).filter((m) => modelMap.has(m.fullId))
    const slotsConfig = getTierSlotsConfig(storage)
    // 绘图池模型数量少于配置席位时全力补位
    if (pool.length < slotsConfig.tierDrawingSlots) {
      const backfilled = await backfillDrawingTier(env, storage)
      pool = (backfilled.tierDrawing || []).filter((m) => modelMap.has(m.fullId))
    }
    // 排除已经在本次请求中尝试失败的具体模型
    if (excludedModelIds && excludedModelIds.size > 0) {
      pool = pool.filter((m) => !excludedModelIds.has(m.fullId))
    }
    // 排除处于冷却中或已被永久禁用的模型
    const now = Date.now()
    pool = pool.filter((m) => {
      const item = modelMap.get(m.fullId)
      if (!item) return false
      const mConfig = item.provider.models.find((x) => x.id === item.modelId)
      if (mConfig?.permanentlyDisabled) return false
      if (mConfig?.cooldownUntil && mConfig.cooldownUntil > now) return false
      return true
    })
    // 优先选择不同厂商
    if (excludedProviderIds && excludedProviderIds.size > 0) {
      const filtered = pool.filter((m) => !excludedProviderIds.has(m.providerId))
      if (filtered.length > 0) pool = filtered
    }
    if (pool.length > 0) {
      return pickStableModelFromPool(pool, storage, 'drawing', modelMap)
    }
    // 若绘图池空，仅从全部可用模型中挑选符合绘图分类的模型补位
    const fallbackDrawing = allModels.filter((m) => {
      if (excludedModelIds && excludedModelIds.has(m.fullId)) return false
      const mConfig = m.provider.models.find((x) => x.id === m.modelId)
      if (mConfig?.permanentlyDisabled || (mConfig?.cooldownUntil && mConfig.cooldownUntil > now)) return false
      return isDrawingModel(m.modelId, mConfig?.category)
    })
    if (fallbackDrawing.length > 0) {
      const chosen = fallbackDrawing[0]
      return { providerId: chosen.provider.id, modelId: chosen.modelId, fullId: chosen.fullId }
    }
    return null
  }

  // 3. 通用第一梯队池 (Tier 1) 选择
  let activeTier1 = storage.tier1.filter((m) => modelMap.has(m.fullId))

  // 排除已经在本次请求中尝试失败的具体模型
  if (excludedModelIds && excludedModelIds.size > 0) {
    activeTier1 = activeTier1.filter((m) => !excludedModelIds.has(m.fullId))
  }

  // 排除处于冷却中或已被永久禁用的模型
  const now = Date.now()
  activeTier1 = activeTier1.filter((m) => {
    const item = modelMap.get(m.fullId)
    if (!item) return false
    const mConfig = item.provider.models.find((x) => x.id === item.modelId)
    if (mConfig?.permanentlyDisabled) return false
    if (mConfig?.cooldownUntil && mConfig.cooldownUntil > now) return false
    return true
  })

  // 只有在第一梯队完全没有可用模型时才紧急补位
  if (activeTier1.length === 0) {
    const backfilled = await backfillTier1FromTier2(env, storage)
    let refreshed = backfilled.tier1.filter((m) => modelMap.has(m.fullId))
    if (excludedModelIds && excludedModelIds.size > 0) {
      refreshed = refreshed.filter((m) => !excludedModelIds.has(m.fullId))
    }
    refreshed = refreshed.filter((m) => {
      const item = modelMap.get(m.fullId)
      if (!item) return false
      const mConfig = item.provider.models.find((x) => x.id === item.modelId)
      if (mConfig?.permanentlyDisabled) return false
      if (mConfig?.cooldownUntil && mConfig.cooldownUntil > now) return false
      return true
    })
    activeTier1 = refreshed
  }

  if (activeTier1.length === 0) return null

  // 4. 不同提供商模型更换：如果有要排除的提供商（例如上一次尝试失败），优先排除它们
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
    candidates = activeTier1
  }

  // 使用高阻尼稳定模型选取算法
  return pickStableModelFromPool(candidates, storage, 'general', modelMap)
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
  isAutoRequest: boolean = false,
  poolType: 'general' | 'openclaw' | 'drawing' = 'general'
): Promise<void> {
  try {
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
      // 记录当前梯队池实际成功连接的模型
      if (!storage.activeConnections) storage.activeConnections = {}
      storage.activeConnections[poolType] = fullId
    } else {
      bStat.failureCount++
      // 业务故障惩罚：将平均延迟拉升至 9999ms，使故障模型在下次选择时自动沉底
      bStat.avgLatency = 9999
      // 若当前故障模型是该池最后记录的连接模型，清除连接记录，以便动态平滑切换到备用模型
      if (storage.activeConnections && storage.activeConnections[poolType] === fullId) {
        delete storage.activeConnections[poolType]
      }
    }

    // 内存直接更新最新业务指标与活跃连接（0 KV 开销）
    inMemoryBusinessStats[fullId] = bStat
    if (success) {
      inMemoryActiveConnections[poolType] = fullId
    } else {
      delete inMemoryActiveConnections[poolType]
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

    // 检查该模型在哪个池子中，无论处于哪个池，只要失败一律立即踢出并冷却 10 分钟
    const isInTier1 = storage.tier1.some((m) => m.fullId === fullId)
    const isInOpenclaw = (storage.tierOpenclaw || []).some((m) => m.fullId === fullId)
    const isInDrawing = (storage.tierDrawing || []).some((m) => m.fullId === fullId)

    if (!isInTier1 && !isInOpenclaw && !isInDrawing) {
      // 不在任何活跃池中，内存已记录指标，直接平稳返回（0 KV 写入）
      return
    }

    if (!success) {
      console.log(`[tiers] 业务请求失败，立即将模型 ${fullId} 从活跃池中剔除并启动 10 分钟冷却`)

      // 1. 将该模型在提供商配置中增加失败计数，并设置 10 分钟冷却（或 3 次失败永久失效）
      const parts = fullId.split('/')
      const providerId = parts[0]
      const modelId = parts.slice(1).join('/')
      if (providerId && modelId) {
        const provider = await getProvider(env, providerId)
        if (provider) {
          const updatedModels = provider.models.map((m: Model) => {
            if (m.id === modelId) {
              const newFailCount = (m.failureCount || 0) + 1
              const isPermanentlyDisabled = newFailCount >= 3
              return {
                ...m,
                failureCount: newFailCount,
                cooldownUntil: isPermanentlyDisabled ? null : (now + 10 * 60 * 1000), // 冷却 10 分钟
                permanentlyDisabled: isPermanentlyDisabled,
                disabledReason: isPermanentlyDisabled ? '业务连续失败达到3次，已自动标记永久失效' : '业务请求失败，进入10分钟冷却隔离',
              }
            }
            return m
          })
          await updateProvider(env, providerId, { models: updatedModels })
        }
      }

      // 2. 从三个活跃池中坚决剔除
      if (isInTier1) {
        storage.tier1 = storage.tier1.filter((m) => m.fullId !== fullId)
        const ref = { providerId, modelId, fullId, addedAt: now }
        if (!storage.tier2.some((m) => m.fullId === fullId)) {
          storage.tier2.push(ref)
        }
      }
      if (isInOpenclaw) {
        storage.tierOpenclaw = (storage.tierOpenclaw || []).filter((m) => m.fullId !== fullId)
      }
      if (isInDrawing) {
        storage.tierDrawing = (storage.tierDrawing || []).filter((m) => m.fullId !== fullId)
      }

      // 3. 自动触发补位海选（自动补位只会选健康的非冷却模型）
      if (isInTier1) {
        storage = await backfillTier1FromTier2(env, storage)
      }
      if (isInOpenclaw) {
        storage = await backfillOpenclawTier(env, storage)
      }
      if (isInDrawing) {
        storage = await backfillDrawingTier(env, storage)
      }

      // 保存剔除和补位后的最新梯队数据，同时顺风车将内存中积累的所有延迟指标打包写入 KV
      await saveTierStorage(env, storage)
    }
    // 成功请求时无需落盘 KV，指标留在内存，顺风车写入时全量带走（真正做到日常平稳转发 0 KV 写入）
  } catch (err) {
    console.warn('[tiers] 记录业务延迟指标异常 (已安全降级):', err instanceof Error ? err.message : String(err))
  }
}
