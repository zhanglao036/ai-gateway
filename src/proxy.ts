import { Context } from 'hono'
import { getProvider, getProviders, updateProvider, kvGet, kvPut, kvDelete, addRequestLog, getDebugMode, getCustomModelRoutes } from './storage'
import { KV_KEYS, KEY_HEALTH_COOLDOWN_MS, KEY_HEALTH_MAX_FAILURES } from './config'
import type { Env, ProxyRequestBody } from './types'
import { isOpenCodeProvider, proxyOpenCodeRequest, resolveOpenCodeUrls } from './opencode'
import { detectPermanentFailure } from './models'
import { selectAutoModel, recordBusinessLatency, getTierStorage, backfillTier1FromTier2 } from './tiers'

async function recordModelFailure(env: Env, providerId: string, modelId: string, status: number, errorMsg: string) {
  const provider = await getProvider(env, providerId)
  if (!provider) return

  // HTTP 400 状态码通常是客户端请求参数不兼容问题（如 Unsupported parameter, Invalid JSON, thinking 参数等），不计入模型故障与冷却
  const lowerMsg = (errorMsg || '').toLowerCase()
  const isBadRequestParam = status === 400 && (
    lowerMsg.includes('parameter') ||
    lowerMsg.includes('validation') ||
    lowerMsg.includes('invalid') ||
    lowerMsg.includes('unsupported')
  )

  const permReason = detectPermanentFailure(status, errorMsg)
  let updated = false

  const updatedModels = provider.models.map((m) => {
    if (m.id !== modelId) return m
    updated = true

    if (permReason) {
      return {
        ...m,
        permanentlyDisabled: true,
        disabledReason: permReason,
      }
    }

    if (isBadRequestParam) {
      // 客户端传参问题不增加失败次数也不触发冷却
      return m
    }

    const newFailures = (m.failureCount || 0) + 1
    if (newFailures >= 3) {
      return {
        ...m,
        failureCount: newFailures,
        permanentlyDisabled: true,
        disabledReason: '累计失败达到3次，已标记永久失效',
      }
    }

    return {
      ...m,
      failureCount: newFailures,
      cooldownUntil: Date.now() + 5 * 60 * 1000,
    }
  })

  if (updated) {
    await updateProvider(env, providerId, { models: updatedModels })
  }

  const modelNowConfig = updatedModels.find((m) => m.id === modelId)
  const isPermDisabled = modelNowConfig?.permanentlyDisabled === true
  const actualDisabledReason = modelNowConfig?.disabledReason || ''

  const fullId = `${providerId}/${modelId}`
  let storage = await getTierStorage(env)

  if (storage) {
    let changed = false
    const inTier1 = storage.tier1.some((m) => m.fullId === fullId)

    if (isPermDisabled) {
      // 永久失效 (例如 402/余额不足、连续 3 次失败)：第一时间踢出第一、第二梯队
      storage.tier1 = storage.tier1.filter((m) => m.fullId !== fullId)
      storage.tier2 = storage.tier2.filter((m) => m.fullId !== fullId)
      changed = true
      console.log(`[proxy] 永久失效模型 ${fullId} 已从第一、第二梯队踢出，原因: ${actualDisabledReason}`)
    } else if (inTier1) {
      // 第一梯队模型调用出现明确故障（如 429 超限、5xx 崩溃、网络超时）：立即移出第一梯队，转入第二梯队等待冷却恢复，并触发自动补位
      console.log(`[proxy] 第一梯队模型 ${fullId} 发生异常(HTTP ${status})，立即剔除至第二梯队并启动自动补位`)
      storage.tier1 = storage.tier1.filter((m) => m.fullId !== fullId)
      const ref = { providerId, modelId, fullId, addedAt: Date.now() }
      if (!storage.tier2.some((m) => m.fullId === fullId)) {
        storage.tier2.push(ref)
      }
      changed = true
    }

    if (changed) {
      storage.probeStats[fullId] = {
        success: false,
        latency: 0,
        lastTestedAt: Date.now(),
        error: `HTTP ${status}: ${errorMsg}`,
      }
      await backfillTier1FromTier2(env, storage)
    }
  }
}

function maskKey(key: string): string {
  if (!key) return ''
  const trimmed = key.trim()
  if (trimmed.length <= 8) return '***'
  return `${trimmed.substring(0, 4)}***${trimmed.substring(trimmed.length - 4)}`
}

async function recordLog(
  env: Env,
  startTime: number,
  model: string,
  status: number,
  error?: string | null,
  extra?: {
    keyMask?: string | null
    attemptIndex?: number
    routePath?: string | null
    isStream?: boolean
    clientIp?: string | null
  }
) {
  const latency = Date.now() - startTime
  const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
  await addRequestLog(env, {
    id: crypto.randomUUID(),
    time,
    model,
    latency,
    status,
    error: error || null,
    keyMask: extra?.keyMask || null,
    attemptIndex: extra?.attemptIndex || 1,
    routePath: extra?.routePath || null,
    isStream: extra?.isStream || false,
    clientIp: extra?.clientIp || null,
  })
}

// ===== Key 健康状态类型和辅助函数 =====

interface KeyHealth {
  failures: number
  lastFailed: boolean
  demotedAt?: number  // 首次达到降权阈值的时间戳 (Date.now())
}
type HealthMap = Record<string, KeyHealth>

const HEALTH_KEY = (providerId: string) => KV_KEYS.KEY_HEALTH_PREFIX + providerId

async function readHealth(env: Env, providerId: string): Promise<HealthMap> {
  const raw = await kvGet(env, HEALTH_KEY(providerId))
  return raw ? JSON.parse(raw) : {}
}

async function writeHealth(env: Env, providerId: string, health: HealthMap): Promise<void> {
  // 只保存有失败记录的 key，避免 KV 膨胀
  const filtered: HealthMap = {}
  for (const [k, v] of Object.entries(health)) {
    if (v.failures > 0) filtered[k] = v
  }
  if (Object.keys(filtered).length > 0) {
    await kvPut(env, HEALTH_KEY(providerId), JSON.stringify(filtered))
  } else {
    // 全部健康，删除 KV 条目
    await kvDelete(env, HEALTH_KEY(providerId)).catch(() => {})
  }
}

/** 解析模型 ID，如 "deepseek/deepseek-chat" → { providerId, modelId } */
function parseModelId(model: string): { providerId: string; modelId: string } | null {
  const slashIndex = model.indexOf('/')
  if (slashIndex === -1) return null
  return {
    providerId: model.substring(0, slashIndex),
    modelId: model.substring(slashIndex + 1),
  }
}

/** 测试模型连接，发送最小请求验证 */
export async function testModelConnection(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  apiType?: 'openai' | 'anthropic'
): Promise<{ success: boolean; message: string; statusCode?: number; latencyMs?: number }> {
  const startTime = Date.now()
  try {
    const cleanBase = baseUrl.replace(/\/$/, '')
    const endpoint = apiType === 'anthropic' ? 'messages' : 'chat/completions'
    const url = `${cleanBase}/${endpoint}`

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (apiType === 'anthropic') {
      headers['x-api-key'] = apiKey
      headers['anthropic-version'] = '2023-06-01'
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(15000),
    })

    const latencyMs = Date.now() - startTime

    if (response.ok) {
      try {
        const resData = await response.json() as any
        if (resData && Array.isArray(resData.choices) && resData.choices.length > 0) {
          const msg = resData.choices[0]?.message
          const hasToolCalls = (msg?.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) || !!msg?.function_call
          if (!hasToolCalls) {
            const content = msg?.content
            if (content === '' || content === null || content === undefined || (typeof content === 'string' && content.trim() === '')) {
              return { success: false, message: '连接失败: 上游返回空内容', statusCode: response.status, latencyMs }
            }
          }
        }
      } catch {
        // ignore JSON parse failure
      }
      return { success: true, message: '连接成功', statusCode: response.status, latencyMs }
    }

    let errorBody = ''
    try {
      const errorData = await response.json() as { error?: { message?: string } }
      errorBody = errorData?.error?.message || JSON.stringify(errorData)
    } catch {
      errorBody = await response.text()
    }

    return {
      success: false,
      message: `HTTP ${response.status}: ${errorBody.substring(0, 200)}`,
      statusCode: response.status,
      latencyMs,
    }
  } catch (err) {
    const error = err as Error
    return {
      success: false,
      message: `连接失败: ${error.message?.substring(0, 200) || '未知错误'}`,
      latencyMs: Date.now() - startTime,
    }
  }
}

/** 处理 /v1/chat/completions 等 API 转发 */
export async function handleProxy(c: Context<{ Bindings: Env }>) {
  const startTime = Date.now()
  let requestedModel = 'unknown'

  try {
    const body = await c.req.json<ProxyRequestBody>().catch(() => ({} as ProxyRequestBody))
    const rawModel = body.model || ''
    let isAutoRequest = false
    let isLongText = false
    let sessionId: string | null = null

    // Extract sessionId if any
    if (body.session_id && typeof body.session_id === 'string') {
      sessionId = body.session_id
    } else if (body.conversation_id && typeof body.conversation_id === 'string') {
      sessionId = body.conversation_id
    } else if (body.user && typeof body.user === 'string') {
      sessionId = body.user
    } else {
      const h1 = c.req.header('x-session-id') || c.req.header('x-conversation-id') || c.req.header('session-id') || c.req.header('conversation-id')
      if (h1) sessionId = h1
    }

    // Identify if long text request
    if (Array.isArray(body.messages)) {
      let totalCharCount = 0
      for (const msg of body.messages) {
        if (msg && typeof msg.content === 'string') {
          totalCharCount += msg.content.length
        }
      }
      if (totalCharCount >= 4000) {
        isLongText = true
      }
    }

    let model = rawModel
    requestedModel = model || 'unknown'
    const clientIp = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || null
    const routeUrl = new URL(c.req.url)
    const routePath = routeUrl.pathname
    const isStreamReq = !!body.stream

    if (!model) {
      await recordLog(c.env, startTime, requestedModel, 400, '缺少 model 参数', {
        routePath,
        isStream: isStreamReq,
        clientIp,
      })
      return c.json({ error: { message: '缺少 model 参数', type: 'invalid_request_error' } }, 400)
    }

    // 检查后台“自定义指定模型”规则（例如 openclaw/auto -> 指定模型 或 第一梯队池）
    const customRoutes = await getCustomModelRoutes(c.env)
    const matchedRoute = customRoutes.find((r) => r.enabled && r.sourceModel.trim().toLowerCase() === model.trim().toLowerCase())
    if (matchedRoute) {
      if (matchedRoute.targetProviderId === 'tier1' || matchedRoute.targetModelId === 'auto') {
        isAutoRequest = true
        requestedModel = `${rawModel} -> [第一梯队池 (Tier 1)]`
      } else {
        isAutoRequest = false
        model = `${matchedRoute.targetProviderId}/${matchedRoute.targetModelId}`
        requestedModel = `${rawModel} -> ${model}`
      }
    } else if (model === 'openclaw/auto' || model === 'openclaw') {
      // 客户端发送 openclaw/auto 且未配规则时，安全默认指向第一梯队池，避免 404
      isAutoRequest = true
      requestedModel = `${rawModel} -> [第一梯队池默认路由]`
    }

    if (model === 'auto' || model === 'auto/auto') {
      isAutoRequest = true
    }

    const triedProviders = new Set<string>()
    let currentModel = model
    let attempts = 0
    const maxAttempts = isAutoRequest ? 3 : 1 // 指定具体模型时严格只尝试 1 次，不切换不漂移

    while (attempts < maxAttempts) {
      attempts++

      if (isAutoRequest) {
        const autoRes = await selectAutoModel(c.env, isLongText, sessionId, triedProviders)
        if (!autoRes) {
          // 如果尝试了所有提供商，重置重新选，避免死循环
          const fallbackRes = await selectAutoModel(c.env, isLongText, sessionId, new Set())
          if (!fallbackRes) {
            await recordLog(c.env, startTime, requestedModel, 503, '第一梯队无可用的模型')
            return c.json({ error: { message: '第一梯队池暂无可用的模型，请先配置模型或进行初始化探测', type: 'service_unavailable' } }, 503)
          }
          currentModel = fallbackRes.fullId
        } else {
          currentModel = autoRes.fullId
        }
        requestedModel = `auto (${currentModel})`
      }

      const parsed = parseModelId(currentModel)
      if (!parsed) {
        await recordLog(c.env, startTime, requestedModel, 400, `模型格式错误 "${currentModel}"`)
        return c.json({
          error: {
            message: `模型格式错误 "${currentModel}"，请使用 提供商ID/模型ID 格式`,
            type: 'invalid_request_error',
          },
        }, 400)
      }

      const { providerId, modelId } = parsed
      triedProviders.add(providerId)

      const provider = await getProvider(c.env, providerId)

      if (!provider) {
        if (isAutoRequest && attempts < maxAttempts) {
          continue
        }
        await recordLog(c.env, startTime, requestedModel, 404, `提供商 "${providerId}" 不存在`)
        return c.json({
          error: { message: `提供商 "${providerId}" 不存在`, type: 'invalid_request_error' },
        }, 404)
      }

      if (!provider.enabled) {
        if (isAutoRequest && attempts < maxAttempts) {
          continue
        }
        await recordLog(c.env, startTime, requestedModel, 403, `提供商 "${provider.name}" 已禁用`)
        return c.json({
          error: { message: `提供商 "${provider.name}" 已禁用`, type: 'provider_disabled' },
        }, 403)
      }

      const modelConfig = provider.models.find((m) => m.id === modelId)
      if (!modelConfig) {
        if (isAutoRequest && attempts < maxAttempts) {
          continue
        }
        await recordLog(c.env, startTime, requestedModel, 404, `模型 "${modelId}" 未配置`)
        return c.json({
          error: { message: `模型 "${modelId}" 未在提供商 "${provider.name}" 中配置`, type: 'invalid_request_error' },
        }, 404)
      }
      if (!modelConfig.enabled) {
        if (isAutoRequest && attempts < maxAttempts) {
          continue
        }
        await recordLog(c.env, startTime, requestedModel, 403, `模型 "${modelId}" 已禁用`)
        return c.json({
          error: { message: `模型 "${modelId}" 已禁用`, type: 'model_disabled' },
        }, 403)
      }

      if (modelConfig.permanentlyDisabled) {
        if (isAutoRequest && attempts < maxAttempts) {
          continue
        }
        const reason = modelConfig.disabledReason || '受上游故障影响已标记永久失效'
        await recordLog(c.env, startTime, requestedModel, 403, `模型已标记永久失效 (${reason})`)
        return c.json({
          error: { message: `模型 "${modelId}" 已标记永久失效: ${reason}。需管理员手动解封重置。`, type: 'model_permanently_disabled' },
        }, 403)
      }

      if (modelConfig.cooldownUntil && Date.now() < modelConfig.cooldownUntil) {
        if (isAutoRequest && attempts < maxAttempts) {
          continue
        }
        const remainingSec = Math.ceil((modelConfig.cooldownUntil - Date.now()) / 1000)
        await recordLog(c.env, startTime, requestedModel, 530, `模型处于冷却期 (${remainingSec}s)`)
        return c.json({
          error: { message: `模型 "${modelId}" 暂处于冷却期（剩余 ${remainingSec} 秒），已脱离所有梯队`, type: 'model_cooling_down' },
        }, 530 as any)
      }

      const enabledKeys = provider.apiKeys.filter(k => k.enabled)
      const forwardBody = { ...body, model: modelId }
      // 自动清洗兼容性参数：剥离听书/客户端自动附带但部分上游模型不支持的非标参数
      delete (forwardBody as Record<string, unknown>).thinking
      delete (forwardBody as Record<string, unknown>).disable_think
      delete (forwardBody as Record<string, unknown>).no_chain_of_thought
      delete (forwardBody as Record<string, unknown>).do_sample

      // OpenClaw / Agent 客户端参数平滑兼容处理：
      // 1. 如果带有新版 max_completion_tokens 而缺少 max_tokens，平滑转换
      const fBodyAny = forwardBody as Record<string, unknown>
      if (fBodyAny.max_completion_tokens !== undefined && fBodyAny.max_tokens === undefined) {
        fBodyAny.max_tokens = fBodyAny.max_completion_tokens
        delete fBodyAny.max_completion_tokens
      }
      // 2. 如果 tools 为空数组，直接移除，避免部分严格上游报错 400
      if (Array.isArray(fBodyAny.tools) && fBodyAny.tools.length === 0) {
        delete fBodyAny.tools
      }
      // 3. 部分上游不支持 stream_options，如果不是必要可剥离非标嵌套
      if (fBodyAny.stream_options && typeof fBodyAny.stream_options === 'object') {
        // 保留或者清理非标准字段
      }
      const url = new URL(c.req.url)
      const subPath = url.pathname.replace(/^\/v1\//, '') || 'chat/completions'

      if (isOpenCodeProvider(providerId)) {
        const response = await proxyOpenCodeRequest({
          baseUrl: provider.baseUrl,
          apiKeys: enabledKeys,
          method: c.req.method,
          subPath,
          search: url.search,
          body: JSON.stringify(forwardBody),
          mirrorUrls: resolveOpenCodeUrls(c.env),
        })

        let resText: string | null = null
        let isContentEmpty = false

        if (response.ok && !forwardBody.stream) {
          try {
            resText = await response.text()
            const resJson = JSON.parse(resText)
            if (resJson && Array.isArray(resJson.choices) && resJson.choices.length > 0) {
              const choice = resJson.choices[0]
              const msg = choice?.message
              const hasToolCalls = (msg?.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) || !!msg?.function_call
              if (!hasToolCalls) {
                const content = msg?.content
                if (content === '' || content === null || content === undefined || (typeof content === 'string' && content.trim() === '')) {
                  isContentEmpty = true
                }
              }
            }
          } catch {
            // ignore
          }
        }

        if (isContentEmpty || !response.ok) {
          const errReason = isContentEmpty ? '上游返回空内容 (choices[0].message.content 为空)' : `HTTP ${response.status}: ${response.statusText || '请求失败'}`
          const errStatus = isContentEmpty ? 502 : response.status
          await recordModelFailure(c.env, providerId, modelId, errStatus, errReason)
          await recordLog(c.env, startTime, requestedModel, errStatus, errReason)
          await recordBusinessLatency(c.env, `${providerId}/${modelId}`, Date.now() - startTime, false, isAutoRequest)
          if (isAutoRequest && attempts < maxAttempts) {
            continue
          }
          return c.json({
            error: { message: errReason, type: isContentEmpty ? 'empty_response' : 'proxy_error' },
          }, errStatus as Parameters<typeof c.json>[1])
        }

        await recordLog(c.env, startTime, requestedModel, response.status, null)
        await recordBusinessLatency(c.env, `${providerId}/${modelId}`, Date.now() - startTime, true, isAutoRequest)
        const opHeaders = new Headers(response.headers)
        if (isStreamReq) {
          opHeaders.set('X-Accel-Buffering', 'no')
          opHeaders.set('Cache-Control', 'no-cache, no-transform')
          opHeaders.set('Connection', 'keep-alive')
        }
        return new Response(resText !== null ? resText : response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: opHeaders,
        })
      }

      if (enabledKeys.length === 0) {
        if (isAutoRequest && attempts < maxAttempts) {
          await recordModelFailure(c.env, providerId, modelId, 500, '提供商无可用的 API Key')
          continue
        }
        await recordLog(c.env, startTime, requestedModel, 500, `提供商 "${provider.name}" 未配置可用的 API Key`)
        return c.json({
          error: { message: `提供商 "${provider.name}" 未配置可用的 API Key`, type: 'configuration_error' },
        }, 500)
      }

      const cleanBase = provider.baseUrl.replace(/\/$/, '')
      const forwardUrl = `${cleanBase}/${subPath}${url.search}`

      // 按健康状态排序 key：健康→洗牌，不健康→末尾，冷却到期→试用，连续失败3次→降权排除
      const healthData = await readHealth(c.env, providerId)
      const healthy: number[] = []
      const unhealthy: number[] = []
      const probation: number[] = []
      const demoted: number[] = []

      if (enabledKeys.length === 1) {
        // 只有一个 key，跳过健康检查，直接使用
        healthy.push(0)
      } else {
        for (let i = 0; i < enabledKeys.length; i++) {
          const h = healthData[enabledKeys[i].key]
          if (h && h.failures >= KEY_HEALTH_MAX_FAILURES) {
            // 兼容旧数据：无 demotedAt 视为现在刚降权，统一走冷却逻辑
            if (!h.demotedAt) {
              h.demotedAt = Date.now()
            }
            if (Date.now() - h.demotedAt >= KEY_HEALTH_COOLDOWN_MS) {
              probation.push(i)  // 冷却到期，进入试用组
            } else {
              demoted.push(i)    // 仍在冷却，继续保持降权
            }
          } else if (h && h.lastFailed) {
            unhealthy.push(i)
          } else {
            healthy.push(i)
          }
        }
      }

      // Fisher-Yates 洗牌（仅健康 key）
      for (let i = healthy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [healthy[i], healthy[j]] = [healthy[j], healthy[i]]
      }

      const keyOrder = [...healthy, ...unhealthy, ...probation]

      // 所有 key 都在冷却中时，降级尝试 demoted key（修复旧数据缺失 demotedAt 的死循环）
      if (keyOrder.length === 0 && demoted.length > 0) {
        keyOrder.push(...demoted)
        console.log(`[proxy] ${providerId}: all keys demoted, falling back to ${demoted.length} key(s)`)
      }

      if (demoted.length > 0 || probation.length > 0) {
        console.log(`[proxy] ${providerId}: ${demoted.length} key(s) demoted, ${probation.length} key(s) on probation (cooldown expired)`)
      }

      let lastError: Response | null = null
      let healthUpdated = false

    for (const keyIndex of keyOrder) {
      const apiKey = enabledKeys[keyIndex].key
      const masked = maskKey(apiKey)
      try {
        const forwardHeaders: Record<string, string> = {
          'Content-Type': 'application/json',
        }
        if (provider.apiType === 'anthropic') {
          forwardHeaders['x-api-key'] = apiKey
          forwardHeaders['anthropic-version'] = '2023-06-01'
        } else {
          forwardHeaders['Authorization'] = `Bearer ${apiKey}`
        }

        const response = await fetch(forwardUrl, {
          method: c.req.method,
          headers: forwardHeaders,
          body: JSON.stringify(forwardBody),
          signal: AbortSignal.timeout(60000),
        })

        if (response.ok) {
          let resText: string | null = null
          let isContentEmpty = false

          if (!forwardBody.stream) {
            try {
              resText = await response.text()
              const resJson = JSON.parse(resText)
              if (resJson && Array.isArray(resJson.choices) && resJson.choices.length > 0) {
                const choice = resJson.choices[0]
                const msg = choice?.message
                const hasToolCalls = (msg?.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) || !!msg?.function_call
                if (!hasToolCalls) {
                  const content = msg?.content
                  if (content === '' || content === null || content === undefined || (typeof content === 'string' && content.trim() === '')) {
                    isContentEmpty = true
                  }
                }
              }
            } catch {
              // ignore JSON parse error
            }
          }

          if (isContentEmpty) {
            console.warn(`[proxy] Upstream returned empty content from provider ${providerId}, model ${modelId}, key index ${keyIndex}. Failing over...`)
            const h = healthData[apiKey] || { failures: 0, lastFailed: false }
            h.failures++
            h.lastFailed = true
            if (h.failures >= KEY_HEALTH_MAX_FAILURES) {
              h.demotedAt = Date.now()
            }
            healthData[apiKey] = h
            healthUpdated = true
            await recordModelFailure(c.env, providerId, modelId, 502, '上游返回空内容 (choices[0].message.content 为空)')
            lastError = new Response(JSON.stringify({
              error: { message: '上游返回空内容 (choices[0].message.content 为空)', type: 'empty_response' },
            }), { status: 502 })
            continue
          }

          // 成功：重置健康状态
          if (healthData[apiKey]?.failures > 0) {
            delete healthData[apiKey]
            healthUpdated = true
          }
          if (healthUpdated) await writeHealth(c.env, providerId, healthData)

          const responseHeaders: Record<string, string> = {
            'Content-Type': response.headers.get('Content-Type') || 'application/json',
            'Cache-Control': isStreamReq ? 'no-cache, no-transform' : 'no-store',
          }
          if (isStreamReq) {
            responseHeaders['X-Accel-Buffering'] = 'no'
            responseHeaders['Connection'] = 'keep-alive'
          }
          await recordLog(c.env, startTime, requestedModel, response.status, null, {
            keyMask: masked,
            attemptIndex: attempts,
            routePath,
            isStream: isStreamReq,
            clientIp,
          })
          await recordBusinessLatency(c.env, `${providerId}/${modelId}`, Date.now() - startTime, true, isAutoRequest)
          return new Response(resText !== null ? resText : response.body, {
            status: response.status,
            headers: responseHeaders,
          })
        }

        // 429 限流：跳过当前 key，不标记失败
        if (response.status === 429) {
          lastError = response
          continue
        }

        // 401/403/5xx 尝试下一个 key（标记失败）
        if (response.status === 401 || response.status === 403 || response.status >= 500) {
          const h = healthData[apiKey] || { failures: 0, lastFailed: false }
          h.failures++
          h.lastFailed = true
          if (h.failures >= KEY_HEALTH_MAX_FAILURES) {
            h.demotedAt = Date.now()  // 达到降权阈值或试用失败，重置冷却计时
          }
          healthData[apiKey] = h
          healthUpdated = true
          lastError = response
          continue
        }

        // 其他错误（400/404 等）记录模型故障并返回
        const errorData = await response.json().catch(async () => ({ error: { message: await response.text() } }))
        const errMsg = (errorData as { error?: { message?: string } })?.error?.message || `HTTP ${response.status}`
        await recordModelFailure(c.env, providerId, modelId, response.status, errMsg)
        await recordLog(c.env, startTime, requestedModel, response.status, errMsg, {
          keyMask: masked,
          attemptIndex: attempts,
          routePath,
          isStream: isStreamReq,
          clientIp,
        })
        await recordBusinessLatency(c.env, `${providerId}/${modelId}`, Date.now() - startTime, false, isAutoRequest)
        if (isAutoRequest && attempts < maxAttempts) {
          lastError = response
          break // break standard key loop to let outer while-loop continue to next provider
        }
        return c.json(errorData, response.status as Parameters<typeof c.json>[1])
      } catch (err) {
        const error = err as Error
        // 网络错误也标记为失败
        const h = healthData[apiKey] || { failures: 0, lastFailed: false }
        h.failures++
        h.lastFailed = true
        if (h.failures >= KEY_HEALTH_MAX_FAILURES) {
          h.demotedAt = Date.now()  // 达到降权阈值或试用失败，重置冷却计时
        }
        healthData[apiKey] = h
        healthUpdated = true
        await recordModelFailure(c.env, providerId, modelId, 502, error.message || '网络连接故障')
        lastError = new Response(JSON.stringify({
          error: { message: error.message || '请求失败', type: 'proxy_error' },
        }), { status: 502 })
        continue
      }
    }

    // 写回健康状态
    if (healthUpdated) await writeHealth(c.env, providerId, healthData)

    // 所有 key 均失败或遇到异常中断
    if (lastError) {
      const errorBody = await lastError.text().catch(() => '所有 API Key 均失败')
      const errMsg = `所有 API Key 已用完，最后一次错误: HTTP ${lastError.status}`
      await recordModelFailure(c.env, providerId, modelId, lastError.status || 502, errorBody)
      await recordLog(c.env, startTime, requestedModel, lastError.status || 502, errMsg, {
        attemptIndex: attempts,
        routePath,
        isStream: isStreamReq,
        clientIp,
      })
      await recordBusinessLatency(c.env, `${providerId}/${modelId}`, Date.now() - startTime, false, isAutoRequest)
      if (isAutoRequest && attempts < maxAttempts) {
        continue // outer while-loop continue to next provider in Tier 1
      }
      return c.json({
        error: {
          message: errMsg,
          type: 'key_exhausted',
          detail: errorBody.substring(0, 500),
        },
      }, (lastError.status || 502) as Parameters<typeof c.json>[1])
    }

    if (isAutoRequest && attempts < maxAttempts) {
      await recordModelFailure(c.env, providerId, modelId, 500, '提供商无可用的 API Key')
      continue // outer while-loop continue to next provider
    }

    await recordLog(c.env, startTime, requestedModel, 500, '没有可用的 API Key', {
      attemptIndex: attempts,
      routePath,
      isStream: isStreamReq,
      clientIp,
    })
    return c.json({
      error: { message: '没有可用的 API Key', type: 'configuration_error' },
    }, 500)
  }

  await recordLog(c.env, startTime, requestedModel, 500, '所有自动补位与重试模型均已失败', {
    attemptIndex: attempts,
    routePath,
    isStream: isStreamReq,
    clientIp,
  })
  return c.json({
    error: { message: '所有自动补位与重试模型均已失败', type: 'server_error' },
  }, 500)
} catch (err) {
    const error = err as Error
    await recordLog(c.env, startTime, requestedModel, 500, error.message || '代理转发内部错误')
    return c.json({
      error: { message: error.message || '代理转发内部错误', type: 'server_error' },
    }, 500)
  }
}

/** 处理 /v1/models — 返回所有已启用的模型（含提供商前缀与自定义指定模型） */
export async function handleModels(c: Context<{ Bindings: Env }>) {
  const providers = await getProviders(c.env)
  const customRoutes = await getCustomModelRoutes(c.env)

  const models: Array<{
    id: string
    provider: string
    provider_name: string
    object: string
    created: number
    owned_by: string
  }> = [
    {
      id: 'auto/auto',
      provider: 'auto',
      provider_name: '第一梯队智能路由',
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'gateway',
    },
    {
      id: 'openclaw/auto',
      provider: 'openclaw',
      provider_name: 'OpenClaw Agent 路由',
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'openclaw',
    },
  ]

  // 注入已启用的自定义路由别名
  for (const cr of customRoutes) {
    if (!cr.enabled || !cr.sourceModel) continue
    const sm = cr.sourceModel.trim()
    if (models.some((m) => m.id.toLowerCase() === sm.toLowerCase())) continue
    const targetDesc = cr.targetProviderId === 'tier1' ? '第一梯队池' : `${cr.targetProviderId}/${cr.targetModelId}`
    models.push({
      id: sm,
      provider: 'custom',
      provider_name: `指定转发: ${targetDesc}`,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'custom_route',
    })
  }

  for (const provider of providers) {
    if (!provider.enabled) continue
    for (const model of provider.models) {
      if (!model.enabled) continue
      models.push({
        id: `${provider.id}/${model.id}`,
        provider: provider.id,
        provider_name: provider.name,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: provider.id,
      })
    }
  }

  return c.json({
    object: 'list',
    data: models,
  })
}
