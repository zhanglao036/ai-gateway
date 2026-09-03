import { Context } from 'hono'
import {
  getProviders,
  getProvider,
  addProvider,
  updateProvider,
  deleteProvider,
  getProxyKeys,
  addProxyKey,
  updateProxyKey,
  deleteProxyKey,
  setProviders,
  setProxyKeys,
  getLogs,
  clearLogs,
  getDebugMode,
  setDebugMode,
  getLogConfig,
  saveLogConfig,
  getCustomModelRoutes,
  saveCustomModelRoutes,
} from './storage'
import { testModelConnection } from './proxy'
import { fetchOpenCodeModels, isOpenCodeProvider, resolveOpenCodeUrls, testOpenCodeModel } from './opencode'
import { PROXY_KEY_PREFIX, EXPIRY_OPTIONS, OPENCODE_DEFAULT_URL } from './config'
import {
  deduplicateAndClassifyModels,
  resetAllCooldowns,
  resetAllModelsToInitial,
  resetProviderModelsToInitial,
  detectPermanentFailure,
  autoClassifyModel,
} from './models'
import { ensureTierStorage, runInitCrossProbe, applyModelProbeResult, selectAutoModel } from './tiers'
import type {
  Env,
  ApiResponse,
  Provider,
  CreateProviderRequest,
  UpdateProviderRequest,
  CreateProxyKeyRequest,
  TestModelRequest,
  Model,
  CustomModelRoute,
} from './types'

// ===== 系统状态 =====

/**
 * 将 string[] 或正规对象数组统一转换为正规对象数组
 * 例: ["k1","k2"] → [{key:"k1",enabled:true},{key:"k2",enabled:true}]
 */
function normalizeArray<T>(
  items: unknown,
  mapFn: (val: string) => T
): T[] {
  if (!Array.isArray(items)) return []
  if (items.length === 0 || typeof items[0] === 'string') {
    return (items as string[]).map(mapFn)
  }
  return items as T[]
}

export async function handleStatus(c: Context<{ Bindings: Env }>) {
  const providers = await getProviders(c.env)
  const proxyKeys = await getProxyKeys(c.env)

  const totalModels = providers.reduce((sum, p) => sum + p.models.length, 0)
  const enabledModels = providers.reduce(
    (sum, p) => sum + p.models.filter((m) => m.enabled).length,
    0
  )

  return c.json<ApiResponse>({
    success: true,
    data: {
      providersCount: providers.length,
      enabledProvidersCount: providers.filter((p) => p.enabled).length,
      modelsCount: totalModels,
      enabledModelsCount: enabledModels,
      proxyKeysCount: proxyKeys.filter((k) => k.enabled).length,
      adminConfigured: !!(c.env.ADMIN_USERNAME && c.env.ADMIN_PASSWORD),
      baseUrl: new URL(c.req.url).origin,
    },
  })
}

// ===== 提供商 CRUD =====

export async function handleGetProviders(c: Context<{ Bindings: Env }>) {
  const providers = await getProviders(c.env)
  return c.json<ApiResponse<Provider[]>>({ success: true, data: providers })
}

export async function handleCreateProvider(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<CreateProviderRequest>()
  // opencode 未传地址时自动填充
  if (body.id === 'opencode' && !body.baseUrl) {
    body.baseUrl = OPENCODE_DEFAULT_URL
  }

  if (!body.id || !body.name || !body.baseUrl) {
    return c.json<ApiResponse>({ success: false, message: 'id、name、baseUrl 为必填项' }, 400)
  }

  const providers = await getProviders(c.env)
  if (providers.some((p) => p.id === body.id)) {
    return c.json<ApiResponse>({ success: false, message: `提供商 id "${body.id}" 已存在` }, 409)
  }

  const now = new Date().toISOString()
  const provider: Provider = {
    id: body.id,
    name: body.name,
    baseUrl: body.baseUrl.replace(/\/$/, ''),
    apiType: body.apiType || 'openai',
    apiKeys: normalizeArray(body.apiKeys, (k) => ({ key: k, enabled: true })),
    models: body.models ? deduplicateAndClassifyModels(body.models) : [],
    enabled: body.enabled !== undefined ? body.enabled : true,
    createdAt: now,
    updatedAt: now,
  }

  await addProvider(c.env, provider)
  return c.json<ApiResponse<Provider>>({ success: true, data: provider }, 201)
}

export async function handleUpdateProvider(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const body = await c.req.json<UpdateProviderRequest>()

  const updates: Partial<Provider> = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.baseUrl !== undefined) updates.baseUrl = body.baseUrl.replace(/\/$/, '')
  if (body.apiType !== undefined) updates.apiType = body.apiType
  if (body.apiKeys !== undefined) {
    updates.apiKeys = normalizeArray(body.apiKeys, (k) => ({ key: k, enabled: true }))
  }
  if (body.enabled !== undefined) updates.enabled = body.enabled
  if (body.models !== undefined) {
    updates.models = deduplicateAndClassifyModels(body.models)
  }

  const updated = await updateProvider(c.env, id, updates)
  if (!updated) {
    return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  }

  return c.json<ApiResponse<Provider>>({ success: true, data: updated })
}

export async function handleDeleteProvider(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const deleted = await deleteProvider(c.env, id)
  if (!deleted) {
    return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  }
  return c.json<ApiResponse>({ success: true, message: '提供商已删除' })
}

export async function handleTestModel(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const { modelId } = await c.req.json<TestModelRequest>()

  if (!modelId) {
    return c.json<ApiResponse>({ success: false, message: 'modelId 为必填项' }, 400)
  }

  const provider = await getProvider(c.env, id)
  if (!provider) {
    return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  }

  const modelConfig = provider.models.find((m) => m.id === modelId)
  if (!modelConfig) {
    return c.json<ApiResponse>({ success: false, message: `模型 "${modelId}" 不存在于提供商 "${provider.name}"` }, 404)
  }

  const enabledKeys = provider.apiKeys.filter(k => k.enabled)
  if (!isOpenCodeProvider(provider.id) && enabledKeys.length === 0) {
    return c.json<ApiResponse>({ success: false, message: '该提供商未配置可用的 API Key' }, 400)
  }

  const result = isOpenCodeProvider(provider.id)
    ? await testOpenCodeModel(provider.baseUrl, enabledKeys, modelId, resolveOpenCodeUrls(c.env))
    : await testModelConnection(
        provider.baseUrl,
        enabledKeys[0].key,
        modelId,
        provider.apiType,
        modelConfig.category,
        modelConfig.openclawTested
          ? {
              openclawTested: modelConfig.openclawTested,
              openclawCompatible: modelConfig.openclawCompatible,
              openclawReason: modelConfig.openclawReason,
            }
          : undefined
      )

  if (result.openclaw && result.openclaw.tested) {
    modelConfig.openclawTested = true
    modelConfig.openclawCompatible = result.openclaw.compatible
    modelConfig.openclawReason = result.openclaw.reason
    modelConfig.openclawTestedAt = Date.now()
    await updateProvider(c.env, id, { models: provider.models })
  }

  await applyModelProbeResult(
    c.env,
    id,
    modelId,
    result.success,
    result.statusCode || (result.success ? 200 : 500),
    result.message || ''
  )

  return c.json<ApiResponse>({
    success: true,
    data: result,
  })
}

// ===== Key / 模型连通性测试（通过服务端代理，避免 CORS） =====

function buildAuthHeaders(apiKey: string, apiType?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  }
  if (apiType === 'anthropic') {
    headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'
    return headers
  }
  headers['Authorization'] = `Bearer ${apiKey}`
  return headers
}

export async function handleTestKeyNew(c: Context<{ Bindings: Env }>) {
  const { url, apiKey, apiType, providerId } = await c.req.json<{
    url: string
    apiKey: string
    apiType?: string
    providerId?: string
  }>()
  if (!url || (!apiKey && !(providerId && isOpenCodeProvider(providerId)))) {
    return c.json<ApiResponse>({ success: false, message: 'url 和 apiKey 为必填项' }, 400)
  }

  if (providerId && isOpenCodeProvider(providerId)) {
    // 没填 key 时检查是否配了镜像，避免迷惑性报错
    if (!apiKey) {
      const mirrors = resolveOpenCodeUrls(c.env)
      if (mirrors.length === 0) {
        return c.json<ApiResponse>({
          success: true,
          data: { success: false, statusCode: 0, message: '请先填写 API Key 或配置 OPENCODE_MIRRORS_URL 环境变量' },
        })
      }
    }
    const result = await fetchOpenCodeModels(url, [{ key: apiKey, enabled: true }], resolveOpenCodeUrls(c.env))
    return c.json<ApiResponse>({
      success: true,
      data: {
        success: result.success,
        statusCode: result.statusCode || 0,
        message: result.message,
        data: result.data,
      },
    })
  }

  const cleanBase = url.trim().replace(/\/+$/, '')
  try {
    const response = await fetch(`${cleanBase}/models`, {
      method: 'GET', headers: buildAuthHeaders(apiKey, apiType), signal: AbortSignal.timeout(15000),
    })

    let data: unknown = null
    if (response.ok) {
      try { data = await response.json() } catch { /* ignore */ }
    }

    return c.json<ApiResponse>({
      success: true,
      data: { success: response.ok, statusCode: response.status, data },
    })
  } catch (err) {
    return c.json<ApiResponse>({
      success: true,
      data: { success: false, statusCode: 0, message: (err as Error).message || '连接失败' },
    })
  }
}

export async function handleTestModelNew(c: Context<{ Bindings: Env }>) {
  const { url, apiKey, apiType, model, providerId } = await c.req.json<{
    url: string
    apiKey: string
    apiType?: string
    model: string
    providerId?: string
  }>()
  if (!url || !model || (!apiKey && !isOpenCodeProvider(providerId || ''))) {
    return c.json<ApiResponse>({ success: false, message: 'url、apiKey、model 为必填项' }, 400)
  }

  if (providerId && isOpenCodeProvider(providerId)) {
    const apiKeys = apiKey ? [{ key: apiKey, enabled: true }] : []
    const result = await testOpenCodeModel(url, apiKeys, model, resolveOpenCodeUrls(c.env))
    return c.json<ApiResponse>({
      success: true,
      data: { success: result.success, statusCode: result.statusCode || 0, message: result.message, latencyMs: result.latencyMs },
    })
  }

  const result = await testModelConnection(url, apiKey, model, apiType as any)
  return c.json<ApiResponse>({
    success: true,
    data: {
      success: result.success,
      statusCode: result.statusCode || 0,
      message: result.message,
      latencyMs: result.latencyMs,
      openclaw: result.openclaw,
    },
  })
}

// ===== 转发 Key 管理 =====

export async function handleGetProxyKeys(c: Context<{ Bindings: Env }>) {
  const keys = await getProxyKeys(c.env)
  const maskedKeys = keys.map((k) => ({
    ...k,
    key: k.key.length > 12
      ? k.key.substring(0, 8) + '****' + k.key.substring(k.key.length - 4)
      : k.key,
  }))
  return c.json<ApiResponse>({ success: true, data: maskedKeys })
}

export async function handleCreateProxyKey(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<CreateProxyKeyRequest>()
  const id = crypto.randomUUID()
  const randomPart = crypto.randomUUID().replace(/-/g, '')
  const key = `${PROXY_KEY_PREFIX}${randomPart}`

  // 计算过期时间
  let expiresAt: string | null = null
  if (body.expiresIn && body.expiresIn !== 'forever') {
    const ttl = EXPIRY_OPTIONS[body.expiresIn]
    if (ttl) {
      expiresAt = new Date(Date.now() + ttl * 1000).toISOString()
    }
  }

  const proxyKey = {
    id,
    key,
    name: body.name || `Key-${new Date().toLocaleDateString()}`,
    enabled: true,
    createdAt: new Date().toISOString(),
    expiresAt,
  }

  await addProxyKey(c.env, proxyKey)
  return c.json<ApiResponse>({
    success: true,
    data: proxyKey,
    message: '请立即保存此 Key，关闭后将不再显示',
  }, 201)
}

export async function handleDeleteProxyKey(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const deleted = await deleteProxyKey(c.env, id)
  if (!deleted) {
    return c.json<ApiResponse>({ success: false, message: '转发 Key 不存在' }, 404)
  }
  return c.json<ApiResponse>({ success: true, message: '转发 Key 已删除' })
}

export async function handleUpdateProxyKey(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const body = await c.req.json<{ enabled?: boolean }>()
  const updates: Partial<import('./types').ProxyKey> = {}
  if (body.enabled !== undefined) updates.enabled = body.enabled
  const updated = await updateProxyKey(c.env, id, updates)
  if (!updated) {
    return c.json<ApiResponse>({ success: false, message: '转发 Key 不存在' }, 404)
  }
  return c.json<ApiResponse>({ success: true, data: updated })
}

// ===== 批量统一保存 (一次性写入 KV) =====

/**
 * 注意：Cloudflare Workers 运行在无状态多实例（Serverless Edge Container）环境。
 * 内存变量仅在单实例生命周期内生效。点击【统一保存】触发此接口一次性将批量配置落盘持久化至 KV。
 */
export async function handleSaveAll(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json<{ providers?: Provider[]; proxyKeys?: import('./types').ProxyKey[] }>()
    if (!body || !Array.isArray(body.providers) || !Array.isArray(body.proxyKeys)) {
      return c.json<ApiResponse>({ success: false, message: '请求格式错误：providers 与 proxyKeys 必须为数组' }, 400)
    }

    await setProviders(c.env, body.providers)
    await setProxyKeys(c.env, body.proxyKeys)

    return c.json<ApiResponse>({
      success: true,
      message: '全部配置已成功批量写入 KV 持久化存储！',
    })
  } catch (err) {
    return c.json<ApiResponse>({
      success: false,
      message: '批量保存配置至 KV 失败：' + ((err as Error).message || String(err)),
    }, 500)
  }
}

// ===== 网关请求日志与调试模式 API =====

export async function handleGetLogs(c: Context<{ Bindings: Env }>) {
  const logs = await getLogs(c.env)
  const config = await getLogConfig(c.env)
  return c.json<ApiResponse>({
    success: true,
    data: { logs, debugMode: config.debugMode, config },
  })
}

export async function handleClearLogs(c: Context<{ Bindings: Env }>) {
  await clearLogs(c.env)
  return c.json<ApiResponse>({
    success: true,
    message: '网关请求日志已清空',
  })
}

export async function handleGetDebugMode(c: Context<{ Bindings: Env }>) {
  const config = await getLogConfig(c.env)
  return c.json<ApiResponse>({
    success: true,
    data: { debugMode: config.debugMode, config },
  })
}

export async function handleToggleDebugMode(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<{ debugMode?: boolean; bufferMaxCount?: number; flushIntervalSeconds?: number }>().catch(() => ({} as { debugMode?: boolean; bufferMaxCount?: number; flushIntervalSeconds?: number }))
  await saveLogConfig(c.env, {
    debugMode: !!body.debugMode,
    bufferMaxCount: body.bufferMaxCount,
    flushIntervalSeconds: body.flushIntervalSeconds,
  })
  const updatedConfig = await getLogConfig(c.env)
  return c.json<ApiResponse>({
    success: true,
    data: { debugMode: updatedConfig.debugMode, config: updatedConfig },
    message: body.debugMode
      ? '调试模式已开启：每条请求日志实时写入 KV，前端面板实时刷新'
      : `正式模式已启用：日志内存缓存策略生效（满 ${updatedConfig.bufferMaxCount} 条或 ${updatedConfig.flushIntervalSeconds} 秒定时批量落盘，未落地日志已强制立即落盘）`,
  })
}

export async function handleGetCustomRoutes(c: Context<{ Bindings: Env }>) {
  const routes = await getCustomModelRoutes(c.env)
  return c.json<ApiResponse>({
    success: true,
    data: routes,
  })
}

export async function handleSaveCustomRoutes(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<{ routes: CustomModelRoute[] }>().catch(() => ({ routes: [] }))
  const list = Array.isArray(body.routes) ? body.routes : []
  await saveCustomModelRoutes(c.env, list)
  const updated = await getCustomModelRoutes(c.env)
  return c.json<ApiResponse>({
    success: true,
    data: updated,
    message: '自定义指定模型规则已保存',
  })
}

/** 测试指定模型路由延迟（支持具体模型与第一梯队池） */
export async function handleTestCustomRoute(c: Context<{ Bindings: Env }>) {
  const { targetProviderId, targetModelId } = await c.req.json<{
    targetProviderId: string
    targetModelId: string
  }>()

  if (!targetProviderId || !targetModelId) {
    return c.json<ApiResponse>({ success: false, message: '缺少目标提供商或目标模型参数' }, 400)
  }

  // 分支 1：目标为第一梯队池 (Tier 1)
  if (targetProviderId === 'tier1' || targetModelId === 'auto') {
    const selected = await selectAutoModel(c.env)
    if (!selected) {
      return c.json<ApiResponse>({
        success: true,
        data: {
          success: false,
          targetInfo: '第一梯队池 (Tier 1)',
          message: '第一梯队池暂无可用的健康模型',
        },
      })
    }
    const provider = await getProvider(c.env, selected.providerId)
    if (!provider) {
      return c.json<ApiResponse>({
        success: true,
        data: {
          success: false,
          targetInfo: `第一梯队最优模型: ${selected.fullId}`,
          message: `提供商 ${selected.providerId} 不存在`,
        },
      })
    }
    const enabledKeys = provider.apiKeys.filter((k) => k.enabled)
    if (!isOpenCodeProvider(provider.id) && enabledKeys.length === 0) {
      return c.json<ApiResponse>({
        success: true,
        data: {
          success: false,
          targetInfo: `第一梯队最优模型: ${selected.fullId}`,
          message: '该提供商无可用 API Key',
        },
      })
    }

    const testRes = isOpenCodeProvider(provider.id)
      ? await testOpenCodeModel(provider.baseUrl, enabledKeys, selected.modelId, resolveOpenCodeUrls(c.env))
      : await testModelConnection(provider.baseUrl, enabledKeys[0]?.key || '', selected.modelId, provider.apiType)

    return c.json<ApiResponse>({
      success: true,
      data: {
        success: testRes.success,
        targetInfo: `第一梯队调度模型: ${selected.fullId}`,
        latencyMs: testRes.latencyMs,
        statusCode: testRes.statusCode,
        message: testRes.message,
      },
    })
  }

  // 分支 2：目标为特定具体模型（严格直连测试，不切换其他模型）
  const provider = await getProvider(c.env, targetProviderId)
  if (!provider) {
    return c.json<ApiResponse>({
      success: true,
      data: {
        success: false,
        targetInfo: `${targetProviderId}/${targetModelId}`,
        message: `提供商 "${targetProviderId}" 不存在`,
      },
    })
  }

  const enabledKeys = provider.apiKeys.filter((k) => k.enabled)
  if (!isOpenCodeProvider(provider.id) && enabledKeys.length === 0) {
    return c.json<ApiResponse>({
      success: true,
      data: {
        success: false,
        targetInfo: `${targetProviderId}/${targetModelId}`,
        message: '该提供商无可用 API Key',
      },
    })
  }

  const testRes = isOpenCodeProvider(provider.id)
    ? await testOpenCodeModel(provider.baseUrl, enabledKeys, targetModelId, resolveOpenCodeUrls(c.env))
    : await testModelConnection(provider.baseUrl, enabledKeys[0]?.key || '', targetModelId, provider.apiType)

  return c.json<ApiResponse>({
    success: true,
    data: {
      success: testRes.success,
      targetInfo: `${targetProviderId}/${targetModelId}`,
      latencyMs: testRes.latencyMs,
      statusCode: testRes.statusCode,
      message: testRes.message,
    },
  })
}


// ===== 探测任务内存互斥锁 =====
// 注意：该内存锁仅单 Worker 实例生效。Cloudflare Workers 多实例并发无法实现全局锁，后续可扩展 KV 分布式锁。
let isProbeRunning = false

export function getIsProbeRunning(): boolean {
  return isProbeRunning
}

export function setIsProbeRunning(val: boolean) {
  isProbeRunning = val
}

export async function handleRunProbe(c: Context<{ Bindings: Env }>) {
  if (isProbeRunning) {
    return c.json<ApiResponse>({
      success: false,
      message: '已有探测任务正在运行中，请稍后再试',
    }, 429)
  }

  isProbeRunning = true
  try {
    const providers = await getProviders(c.env)
    let testedCount = 0
    let successCount = 0
    let failedCount = 0

    const updatedProviders = await Promise.all(providers.map(async (provider) => {
      if (!provider.enabled) return provider
      const enabledKeys = provider.apiKeys.filter((k) => k.enabled)
      if (!isOpenCodeProvider(provider.id) && enabledKeys.length === 0) return provider

      let changed = false
      const updatedModels = await Promise.all(provider.models.map(async (model) => {
        // 忽略已禁用、标记永久失效的模型（手动触发探测任务时，忽略冷却期以确保测试所有模型）
        if (!model.enabled || model.permanentlyDisabled) return model

        testedCount++
        const apiKey = enabledKeys[0]?.key || ''
        const testRes = isOpenCodeProvider(provider.id)
          ? await testOpenCodeModel(provider.baseUrl, enabledKeys, model.id, resolveOpenCodeUrls(c.env))
          : await testModelConnection(provider.baseUrl, apiKey, model.id, provider.apiType)

        changed = true
        if (testRes.success) {
          successCount++
          return {
            ...model,
            cooldownUntil: null,
          }
        } else {
          failedCount++
          const permReason = detectPermanentFailure(testRes.statusCode || 500, testRes.message)
          if (permReason) {
            return {
              ...model,
              permanentlyDisabled: true,
              disabledReason: permReason,
            }
          }
          const newFailCount = (model.failureCount || 0) + 1
          if (newFailCount >= 3) {
            return {
              ...model,
              failureCount: newFailCount,
              permanentlyDisabled: true,
              disabledReason: '探测连续失败达到3次，已标记永久失效',
            }
          }
          return {
            ...model,
            failureCount: newFailCount,
            cooldownUntil: Date.now() + 5 * 60 * 1000,
          }
        }
      }))

      if (changed) {
        return {
          ...provider,
          models: updatedModels,
          updatedAt: new Date().toISOString(),
        }
      }
      return provider
    }))

    await setProviders(c.env, updatedProviders)
    const tierData = await runInitCrossProbe(c.env)

    return c.json<ApiResponse>({
      success: true,
      message: `探测任务完成！共探测 ${testedCount} 个模型：${successCount} 个可用，${failedCount} 个异常。已更新第一梯队（${tierData.tier1.length} 席）和第二梯队候选池（${tierData.tier2.length} 个）。`,
      data: { testedCount, successCount, failedCount, tierData },
    })
  } finally {
    isProbeRunning = false
  }
}

// ===== 一键重置所有模型至刚刚添加的初始状态 =====
export async function handleResetAllModels(c: Context<{ Bindings: Env }>) {
  const { totalReset, providerCount } = await resetAllModelsToInitial(c.env)
  return c.json<ApiResponse>({
    success: true,
    message: `已成功将 ${providerCount} 个提供商下的全部 ${totalReset} 个模型重置至刚添加的初始状态（已清空所有失败计数、解除冷却与永久失效，梯队池已重新就绪）。`,
    data: { totalReset, providerCount },
  })
}

// ===== 一键重置单个提供商所有模型异常至初始状态 =====
export async function handleResetProviderModels(c: Context<{ Bindings: Env }>) {
  const providerId = c.req.param('id')
  if (!providerId) return c.json<ApiResponse>({ success: false, message: '缺少提供商 ID' }, 400)
  const { totalReset, provider } = await resetProviderModelsToInitial(c.env, providerId)
  return c.json<ApiResponse>({
    success: true,
    message: `已成功将该提供商下的 ${totalReset} 个模型重置至初始可用状态`,
    data: { totalReset, provider },
  })
}

// 保持历史兼容
export const handleResetCooldowns = handleResetAllModels

// ===== 一键拉取上游模型 =====
export async function handleFetchUpstreamModels(c: Context<{ Bindings: Env }>) {
  const providerId = c.req.param('id')
  if (!providerId) return c.json<ApiResponse>({ success: false, message: '缺少提供商 id' }, 400)

  const provider = await getProvider(c.env, providerId)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)

  const enabledKeys = provider.apiKeys.filter((k) => k.enabled)
  if (!isOpenCodeProvider(provider.id) && enabledKeys.length === 0) {
    return c.json<ApiResponse>({ success: false, message: '请先在该提供商下配置并启用至少一个 API Key' }, 400)
  }

  let modelIds: string[] = []

  if (isOpenCodeProvider(provider.id)) {
    const opencodeRes = await fetchOpenCodeModels(provider.baseUrl, enabledKeys, resolveOpenCodeUrls(c.env))
    if (!opencodeRes.success || !Array.isArray(opencodeRes.data)) {
      return c.json<ApiResponse>({ success: false, message: opencodeRes.message || '拉取 OpenCode 上游模型列表失败' }, 500)
    }
    modelIds = opencodeRes.data
  } else {
    const cleanBase = provider.baseUrl.replace(/\/$/, '')
    const apiKey = enabledKeys[0]?.key || ''
    try {
      const resp = await fetch(`${cleanBase}/models`, {
        method: 'GET',
        headers: buildAuthHeaders(apiKey, provider.apiType),
        signal: AbortSignal.timeout(15000),
      })
      if (!resp.ok) {
        const text = await resp.text()
        return c.json<ApiResponse>({ success: false, message: `拉取失败 HTTP ${resp.status}: ${text.substring(0, 200)}` }, 500)
      }
      const data = await resp.json() as { data?: Array<{ id: string }> }
      if (Array.isArray(data.data)) {
        modelIds = data.data.map((m) => m.id).filter(Boolean)
      } else {
        return c.json<ApiResponse>({ success: false, message: '上游返回数据格式不符合 OpenAI /models 标准规范' }, 500)
      }
    } catch (err) {
      return c.json<ApiResponse>({ success: false, message: '网络请求异常: ' + (err as Error).message }, 500)
    }
  }

  const newModels = deduplicateAndClassifyModels(modelIds)
  return c.json<ApiResponse>({
    success: true,
    data: { models: newModels, count: newModels.length },
    message: `成功拉取并自动分类 ${newModels.length} 个上游模型`,
  })
}

// ===== 一键导入模型 =====
export async function handleImportModels(c: Context<{ Bindings: Env }>) {
  const providerId = c.req.param('id')
  if (!providerId) return c.json<ApiResponse>({ success: false, message: '缺少提供商 id' }, 400)

  const provider = await getProvider(c.env, providerId)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)

  const body = await c.req.json<{ text?: string; models?: Model[] | string[] }>()
  let importItems: Array<Partial<Model> | string> = []

  if (Array.isArray(body.models)) {
    importItems = body.models
  } else if (typeof body.text === 'string' && body.text.trim()) {
    importItems = body.text
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  }

  if (importItems.length === 0) {
    return c.json<ApiResponse>({ success: false, message: '导入内容为空' }, 400)
  }

  const merged = deduplicateAndClassifyModels([...provider.models, ...importItems])
  await updateProvider(c.env, providerId, { models: merged })

  return c.json<ApiResponse>({
    success: true,
    data: { models: merged },
    message: `成功导入模型！当前提供商已有 ${merged.length} 个模型（重复项已自动剔除）`,
  })
}

// ===== 一键删除全部本提供商模型 =====
export async function handleClearProviderModels(c: Context<{ Bindings: Env }>) {
  const providerId = c.req.param('id')
  if (!providerId) return c.json<ApiResponse>({ success: false, message: '缺少提供商 id' }, 400)

  const updated = await updateProvider(c.env, providerId, { models: [] })
  if (!updated) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)

  return c.json<ApiResponse>({
    success: true,
    message: '已成功删除该提供商的全部模型',
  })
}

// ===== 修改单个模型分类/状态解封 =====
export async function handleUpdateModelStatus(c: Context<{ Bindings: Env }>) {
  const providerId = c.req.param('id')
  const modelId = decodeURIComponent(c.req.param('modelId') || '')

  if (!providerId || !modelId) return c.json<ApiResponse>({ success: false, message: '参数错误' }, 400)

  const provider = await getProvider(c.env, providerId)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)

  const body = await c.req.json<{
    enabled?: boolean
    category?: '文本' | '绘图' | '多模态' | '其他' | string
    unblockPermanent?: boolean
  }>()

  let found = false
  const updatedModels = provider.models.map((m) => {
    if (m.id !== modelId) return m
    found = true
    const copy = { ...m }
    if (typeof body.enabled === 'boolean') copy.enabled = body.enabled
    if (typeof body.category === 'string' && body.category) copy.category = body.category
    if (body.unblockPermanent) {
      copy.permanentlyDisabled = false
      copy.disabledReason = null
      copy.failureCount = 0
      copy.permTestFailCount = 0
      copy.lastPermTestAt = Date.now()
      copy.cooldownUntil = null
    }
    return copy
  })

  if (!found) return c.json<ApiResponse>({ success: false, message: '模型不存在' }, 404)

  await updateProvider(c.env, providerId, { models: updatedModels })
  return c.json<ApiResponse>({
    success: true,
    message: '模型配置已成功更新',
  })
}

// ===== 获取梯队与探测数据 =====
export async function handleGetTiers(c: Context<{ Bindings: Env }>) {
  const tierData = await ensureTierStorage(c.env)
  return c.json<ApiResponse>({
    success: true,
    data: tierData,
  })
}

// ===== 手动批量交叉交替测试封禁模型 =====
export async function handleTestBlockedModels(c: Context<{ Bindings: Env }>) {
  if (isProbeRunning) {
    return c.json<ApiResponse>({
      success: false,
      message: '已有探测任务正在运行中，请稍后再试',
    }, 429)
  }

  isProbeRunning = true
  try {
    const providers = await getProviders(c.env)

    const blockedToTest: Array<{ provider: Provider; model: Model }> = []
    for (const p of providers) {
      if (!p.enabled) continue
      const enabledKeys = p.apiKeys.filter((k) => k.enabled)
      if (!isOpenCodeProvider(p.id) && enabledKeys.length === 0) continue

      for (const m of p.models) {
        if (m.enabled !== false && m.permanentlyDisabled) {
          blockedToTest.push({ provider: p, model: m })
        }
      }
    }

    if (blockedToTest.length === 0) {
      return c.json<ApiResponse>({
        success: true,
        message: '当前没有任何处于永久封禁状态的模型',
        data: { testedCount: 0, unblockedCount: 0, unblockedModelIds: [] },
      })
    }

    // 按 Provider 分组
    const providerMap = new Map<string, Array<{ provider: Provider; model: Model }>>()
    for (const item of blockedToTest) {
      if (!providerMap.has(item.provider.id)) {
        providerMap.set(item.provider.id, [])
      }
      providerMap.get(item.provider.id)!.push(item)
    }

    const providerIds = Array.from(providerMap.keys()).sort()
    const pointers: Record<string, number> = {}
    for (const pid of providerIds) pointers[pid] = 0

    // 交叉轮抽 Round-Robin
    const roundOrder: Array<{ provider: Provider; model: Model }> = []
    let hasMore = true
    while (hasMore) {
      hasMore = false
      for (const pid of providerIds) {
        const list = providerMap.get(pid)!
        const idx = pointers[pid]
        if (idx < list.length) {
          hasMore = true
          roundOrder.push(list[idx])
          pointers[pid] = idx + 1
        }
      }
    }

    let testedCount = 0
    let unblockedCount = 0
    const unblockedModelIds: string[] = []
    const allProviders = await getProviders(c.env)
    const now = Date.now()

    const BATCH_SIZE = 5
    for (let i = 0; i < roundOrder.length; i += BATCH_SIZE) {
      const chunk = roundOrder.slice(i, i + BATCH_SIZE)
      const chunkResults = await Promise.all(
        chunk.map(async ({ provider, model }) => {
          testedCount++
          const enabledKeys = provider.apiKeys.filter((k) => k.enabled)
          const apiKey = enabledKeys[0]?.key || ''
          const testRes = isOpenCodeProvider(provider.id)
            ? await testOpenCodeModel(provider.baseUrl, enabledKeys, model.id, resolveOpenCodeUrls(c.env))
            : await testModelConnection(provider.baseUrl, apiKey, model.id, provider.apiType)

          return {
            providerId: provider.id,
            modelId: model.id,
            success: testRes.success,
            statusCode: testRes.statusCode || (testRes.success ? 200 : 500),
            message: testRes.message || '',
          }
        })
      )

      for (const res of chunkResults) {
        const targetP = allProviders.find((p) => p.id === res.providerId)
        if (!targetP) continue
        const modelObj = (targetP.models || []).find((m) => m.id === res.modelId)
        if (!modelObj) continue

        if (res.success) {
          unblockedCount++
          unblockedModelIds.push(`${res.providerId}/${res.modelId}`)
          modelObj.cooldownUntil = null
          modelObj.failureCount = 0
          modelObj.permanentlyDisabled = false
          modelObj.permTestFailCount = 0
          modelObj.lastPermTestAt = now
          modelObj.disabledReason = undefined
        } else {
          modelObj.lastPermTestAt = now
          modelObj.permTestFailCount = (modelObj.permTestFailCount || 0) + 1
        }
      }
    }

    // 批量测试结束后，一次性写入 KV
    if (testedCount > 0) {
      await setProviders(c.env, allProviders)
    }

    const unblockedDetail = unblockedCount > 0 ? `解封模型：[${unblockedModelIds.join(', ')}]` : '暂无模型解封'
    return c.json<ApiResponse>({
      success: true,
      message: `批量交叉测试完成！共测试 ${testedCount} 个封禁模型，成功解封 ${unblockedCount} 个模型。${unblockedDetail}`,
      data: { testedCount, unblockedCount, unblockedModelIds },
    })
  } finally {
    isProbeRunning = false
  }
}
