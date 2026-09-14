/**
 * 版本号: v1.3.0
 * 更新说明: 深度贯彻“顺风车”极简 KV 写入哲学：日常 AI 成功与失败请求指标全面转为内存缓存维护（0 KV 写入），提供 setMemoryCacheOnly 接口，仅在刚性事件发生时顺路打包带走所有内存日志与暂存数据。
 */
import { KV_KEYS, LOG_BATCH_SIZE, LOG_FLUSH_INTERVAL_MS } from './config'
import type { Env, Provider, ProxyKey, RequestLog, Session, CustomModelRoute } from './types'
import { createLocalKV } from './localKv'

let defaultKV: ReturnType<typeof createLocalKV> | null = null

function getKV(env?: Env) {
  if (env?.KV) {
    return env.KV
  }
  if (!defaultKV) {
    defaultKV = createLocalKV()
  }
  return defaultKV
}

/**
 * 注意：Cloudflare Workers 运行在无状态多实例（Serverless Edge Container）环境。
 * 内存变量仅在单个隔离实例内生效，不同实例间无法共享内存状态。
 * 通过单实例内存高速队列 + 满足定量/定时条件时批量落盘 + 顺风车打包写入，极致节省 Cloudflare KV 写入额度。
 */

// 内存二级缓存（单实例有效）
const memoryCache = new Map<string, { value: string; expiresAt?: number }>()
const pendingWrites = new Map<string, { value: string; options?: { expirationTtl?: number }; isDelete?: boolean }>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

// 动态调试模式与日志参数控制
let dynamicDebugMode: boolean | null = null
let dynamicBufferMaxCount: number | null = null
let dynamicFlushIntervalSeconds: number | null = null

// 日志落盘计数器与上次落盘时间戳（单实例有效）
let unflushedLogCount = 0
let lastLogFlushTime = Date.now()

export function isDebugMode(env?: Env): boolean {
  if (dynamicDebugMode !== null) return dynamicDebugMode
  if (env?.MODE === 'debug' || env?.DEBUG === true || env?.DEBUG === 'true') return true
  if (typeof process !== 'undefined' && process.env && (process.env.MODE === 'debug' || process.env.DEBUG === 'true')) return true
  return false
}

export async function getLogConfig(env: Env): Promise<{ debugMode: boolean; bufferMaxCount: number; flushIntervalSeconds: number }> {
  let debug = dynamicDebugMode
  let maxCount = dynamicBufferMaxCount
  let intervalSec = dynamicFlushIntervalSeconds

  if (debug === null || maxCount === null || intervalSec === null) {
    const raw = await getKV(env).get(KV_KEYS.LOG_CONFIG)
    if (raw) {
      try {
        const parsed = JSON.parse(raw)
        if (typeof parsed.debugMode === 'boolean') debug = parsed.debugMode
        if (typeof parsed.bufferMaxCount === 'number' && parsed.bufferMaxCount > 0) maxCount = parsed.bufferMaxCount
        if (typeof parsed.flushIntervalSeconds === 'number' && parsed.flushIntervalSeconds > 0) intervalSec = parsed.flushIntervalSeconds
      } catch {}
    }
  }

  if (debug === null) {
    const kvVal = await getKV(env).get(KV_KEYS.DEBUG_MODE)
    debug = kvVal !== null ? kvVal === 'true' : isDebugMode(env)
  }
  if (maxCount === null) maxCount = 20 // 默认 20 条定量落盘，大幅降低 KV 写入频率
  if (intervalSec === null) intervalSec = 60 // 默认 60 秒定时落盘

  dynamicDebugMode = debug
  dynamicBufferMaxCount = maxCount
  dynamicFlushIntervalSeconds = intervalSec

  return { debugMode: debug, bufferMaxCount: maxCount, flushIntervalSeconds: intervalSec }
}

export async function getDebugMode(env: Env): Promise<boolean> {
  const config = await getLogConfig(env)
  return config.debugMode
}

export async function saveLogConfig(
  env: Env,
  config: { debugMode: boolean; bufferMaxCount?: number; flushIntervalSeconds?: number }
): Promise<void> {
  const current = await getLogConfig(env)
  const newDebug = typeof config.debugMode === 'boolean' ? config.debugMode : current.debugMode
  const newMaxCount = typeof config.bufferMaxCount === 'number' && config.bufferMaxCount > 0 ? config.bufferMaxCount : current.bufferMaxCount
  const newInterval = typeof config.flushIntervalSeconds === 'number' && config.flushIntervalSeconds > 0 ? config.flushIntervalSeconds : current.flushIntervalSeconds

  dynamicDebugMode = newDebug
  dynamicBufferMaxCount = newMaxCount
  dynamicFlushIntervalSeconds = newInterval

  const configObj = {
    debugMode: newDebug,
    bufferMaxCount: newMaxCount,
    flushIntervalSeconds: newInterval,
  }

  try {
    await getKV(env).put(KV_KEYS.LOG_CONFIG, JSON.stringify(configObj))
  } catch (err) {
    console.warn('[storage] 保存日志配置异常 (已静默降级):', err instanceof Error ? err.message : String(err))
  }

  // 切换配置或调试模式瞬间，未落地日志及缓存强制落盘
  try {
    await flushPendingLogs(env)
    await flushPendingWrites(env)
  } catch (err) {
    console.warn('[storage] 强制落盘异常 (已静默降级):', err instanceof Error ? err.message : String(err))
  }
}

export async function setDebugMode(env: Env, enabled: boolean): Promise<void> {
  await saveLogConfig(env, { debugMode: enabled })
}

export async function kvGet(env: Env, key: string): Promise<string | null> {
  const mem = memoryCache.get(key)
  if (mem) {
    if (!mem.expiresAt || mem.expiresAt > Date.now()) {
      return mem.value
    } else {
      memoryCache.delete(key)
    }
  }
  const val = await getKV(env).get(key)
  if (val !== null) {
    memoryCache.set(key, { value: val })
  }
  return val
}

/**
 * 纯内存写入缓存（顺风车乘客模式）：
 * 仅更新 Worker 运行时内存缓存，绝对不主动发起 KV 写入或启动定时器。
 * 等待后续任何刚性写入事件发生时，再作为顺风车乘客一次性打包持久化到 KV。
 */
export function setMemoryCacheOnly(key: string, value: string): void {
  memoryCache.set(key, { value })
}

export async function kvPut(env: Env, key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
  const expiresAt = options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : undefined
  memoryCache.set(key, { value, expiresAt })

  if (isDebugMode(env)) {
    // 调试模式：立即直接落盘 KV
    try {
      await getKV(env).put(key, value, options)
    } catch (err) {
      console.warn(`[storage] 调试模式写入 KV 异常 (key: ${key}, 已静默降级):`, err instanceof Error ? err.message : String(err))
    }
    return
  }

  // 正式模式：合并内存批量/延迟落盘，降低 KV 写入频率
  pendingWrites.set(key, { value, options, isDelete: false })
  scheduleFlush(env)
}

export async function kvDelete(env: Env, key: string): Promise<void> {
  memoryCache.delete(key)
  if (isDebugMode(env)) {
    await getKV(env).delete(key)
    return
  }
  pendingWrites.set(key, { value: '', isDelete: true })
  scheduleFlush(env)
}

function scheduleFlush(env: Env) {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushPendingWrites(env).catch(console.error)
  }, 1000)
}

export async function flushPendingWrites(env: Env): Promise<void> {
  // 顺风车捎带：只要系统有任何必须写入 KV 的操作（保存配置、故障降级、梯队补位等），
  // 检查内存中是否有未保存的请求日志，只要有（> 0 条），就顺路打包一次性写入 KV，0 额外写入成本！
  if (unflushedLogCount > 0) {
    await flushPendingLogs(env)
  }
  if (pendingWrites.size === 0) return
  const entries = Array.from(pendingWrites.entries())
  pendingWrites.clear()
  for (const [key, item] of entries) {
    try {
      if (item.isDelete) {
        await getKV(env).delete(key)
      } else {
        await getKV(env).put(key, item.value, item.options)
      }
    } catch (err) {
      console.error(`[storage] KV flush error for key ${key}:`, err)
    }
  }
}

// ===== 提供商 CRUD =====

export async function getProviders(env: Env): Promise<Provider[]> {
  const data = await kvGet(env, KV_KEYS.PROVIDERS)
  const providers: Provider[] = data ? JSON.parse(data) : []

  // 注入合并：读取 tier_data 中的动态模型状态 (cooldowns, failureCounts, permanentlyDisabled, disabledReasons)
  try {
    const tierDataRaw = await kvGet(env, KV_KEYS.TIER_DATA)
    if (tierDataRaw) {
      const tierData = JSON.parse(tierDataRaw)
      const cooldowns = tierData.cooldowns || {}
      const failureCounts = tierData.failureCounts || {}
      const permanentlyDisabled = tierData.permanentlyDisabled || {}
      const disabledReasons = tierData.disabledReasons || {}

      for (const p of providers) {
        if (p.models) {
          p.models = p.models.map((m: any) => {
            const fullId = `${p.id}/${m.id}`
            const dCooldown = cooldowns[fullId]
            const dFailCount = failureCounts[fullId]
            const dPermDisabled = permanentlyDisabled[fullId]
            const dDisabledReason = disabledReasons[fullId]

            return {
              ...m,
              cooldownUntil: dCooldown !== undefined ? dCooldown : (m.cooldownUntil ?? null),
              failureCount: dFailCount !== undefined ? dFailCount : (m.failureCount ?? 0),
              permanentlyDisabled: dPermDisabled !== undefined ? dPermDisabled : (m.permanentlyDisabled ?? false),
              disabledReason: dDisabledReason !== undefined ? dDisabledReason : (m.disabledReason ?? null),
            }
          })
        }
      }
    }
  } catch (err) {
    // 静默降级
  }

  return providers
}

export async function getProvider(env: Env, id: string): Promise<Provider | null> {
  const providers = await getProviders(env)
  return providers.find((p) => p.id === id) ?? null
}

export async function setProviders(env: Env, providers: Provider[], immediate = false): Promise<void> {
  const cleaned = providers.map((p) => {
    const seenKeys = new Set<string>()
    const uniqueKeys = (p.apiKeys || [])
      .filter((k) => {
        const trimmed = (k.key || '').trim()
        if (!trimmed || seenKeys.has(trimmed)) return false
        seenKeys.add(trimmed)
        return true
      })
      .map((k) => ({ key: k.key.trim(), enabled: k.enabled !== false }))

    const seenModels = new Set<string>()
    const uniqueModels = (p.models || []).filter((m) => {
      const trimmed = (m.id || '').trim()
      if (!trimmed || seenModels.has(trimmed)) return false
      seenModels.add(trimmed)
      return true
    })

    return {
      ...p,
      baseUrl: (p.baseUrl || '').trim().replace(/\/$/, ''),
      apiKeys: uniqueKeys,
      models: uniqueModels,
    }
  })

  await kvPut(env, KV_KEYS.PROVIDERS, JSON.stringify(cleaned))
  if (immediate) {
    await flushPendingWrites(env)
  }
}

export async function addProvider(env: Env, provider: Provider, immediate = true): Promise<void> {
  const providers = await getProviders(env)
  providers.push(provider)
  await setProviders(env, providers, immediate)
}

export async function updateProvider(env: Env, id: string, updates: Partial<Provider>, immediate = false): Promise<Provider | null> {
  const providers = await getProviders(env)
  const index = providers.findIndex((p) => p.id === id)
  if (index === -1) return null

  // 若更新中包含 models 列表，提取其中的动态/临时状态，直接合并入 tier_data
  if (updates.models) {
    try {
      const rawData = await getKV(env).get(KV_KEYS.PROVIDERS)
      const rawProviders: Provider[] = rawData ? JSON.parse(rawData) : []
      const rawIndex = rawProviders.findIndex((p) => p.id === id)

      if (rawIndex !== -1) {
        const rawProvider = rawProviders[rawIndex]

        const tierDataRaw = await getKV(env).get(KV_KEYS.TIER_DATA)
        const tierData = tierDataRaw ? JSON.parse(tierDataRaw) : { probeStats: {}, businessStats: {} }
        if (!tierData.cooldowns) tierData.cooldowns = {}
        if (!tierData.failureCounts) tierData.failureCounts = {}
        if (!tierData.permanentlyDisabled) tierData.permanentlyDisabled = {}
        if (!tierData.disabledReasons) tierData.disabledReasons = {}

        let configChanged = false

        for (const updatedM of updates.models) {
          const fullId = `${id}/${updatedM.id}`

          if (updatedM.cooldownUntil !== undefined) {
            if (updatedM.cooldownUntil === null) delete tierData.cooldowns[fullId]
            else tierData.cooldowns[fullId] = updatedM.cooldownUntil
          }
          if (updatedM.failureCount !== undefined) {
            if (updatedM.failureCount === null || updatedM.failureCount === 0) delete tierData.failureCounts[fullId]
            else tierData.failureCounts[fullId] = updatedM.failureCount
          }
          if (updatedM.permanentlyDisabled !== undefined) {
            if (updatedM.permanentlyDisabled === null || updatedM.permanentlyDisabled === false) delete tierData.permanentlyDisabled[fullId]
            else tierData.permanentlyDisabled[fullId] = updatedM.permanentlyDisabled
          }
          if (updatedM.disabledReason !== undefined) {
            if (updatedM.disabledReason === null || updatedM.disabledReason === '') delete tierData.disabledReasons[fullId]
            else tierData.disabledReasons[fullId] = updatedM.disabledReason
          }

          // 检查静态配置字段 (enabled, category 等) 是否发生了真实改变
          const rawM = rawProvider.models.find((m) => m.id === updatedM.id)
          if (rawM) {
            if (updatedM.enabled !== undefined && updatedM.enabled !== rawM.enabled) {
              rawM.enabled = updatedM.enabled
              configChanged = true
            }
            if (updatedM.category !== undefined && updatedM.category !== rawM.category) {
              rawM.category = updatedM.category
              configChanged = true
            }
            if (updatedM.openclawVerified !== undefined && updatedM.openclawVerified !== rawM.openclawVerified) {
              rawM.openclawVerified = updatedM.openclawVerified
              configChanged = true
            }
            if (updatedM.openclawCustomTagged !== undefined && updatedM.openclawCustomTagged !== rawM.openclawCustomTagged) {
              rawM.openclawCustomTagged = updatedM.openclawCustomTagged
              configChanged = true
            }
          }
        }

        // 保存动态状态到 tier_data KV
        tierData.updatedAt = new Date().toISOString()
        await kvPut(env, KV_KEYS.TIER_DATA, JSON.stringify(tierData))

        // 仅在真实配置 (enabled, category) 改变时才重写巨大的 providers 数据库，日常 0 写入！
        if (configChanged) {
          rawProvider.updatedAt = new Date().toISOString()
          await setProviders(env, rawProviders, immediate)
        }

        return (await getProviders(env)).find((p) => p.id === id) || null
      }
    } catch (err) {
      console.warn('[storage] 拦截 updateProvider 动态状态异常:', err)
    }
  }

  providers[index] = { ...providers[index], ...updates, updatedAt: new Date().toISOString() }
  await setProviders(env, providers, immediate)
  return providers[index]
}

export async function deleteProvider(env: Env, id: string, immediate = true): Promise<boolean> {
  const providers = await getProviders(env)
  const filtered = providers.filter((p) => p.id !== id)
  if (filtered.length === providers.length) return false
  await setProviders(env, filtered, immediate)
  return true
}

// ===== Session 管理 =====

async function signSession(username: string, expiresAt: number, secret: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(`${username}:${expiresAt}:${secret}`)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function createSession(env: Env, username: string, ttlSeconds: number): Promise<string> {
  const expiresAt = Date.now() + ttlSeconds * 1000
  const secret = env.ADMIN_PASSWORD || 'default_secret_123'
  const sig = await signSession(username, expiresAt, secret)
  // 签名会话令牌结构: username.expiresAt.sig (0 KV 读写)
  return `${username}.${expiresAt}.${sig}`
}

export async function getSession(env: Env, sessionId: string): Promise<Session | null> {
  if (!sessionId) return null

  // 兼容性保障：如果不包含 "."，说明可能是管理员密码本身，或者是历史遗留 KV Session
  if (!sessionId.includes('.')) {
    const adminPass = env.ADMIN_PASSWORD || 'admin123'
    if (sessionId === adminPass) {
      return { username: env.ADMIN_USERNAME || 'admin', expiresAt: Date.now() + 86400 * 1000 }
    }
    try {
      const data = await getKV(env).get(KV_KEYS.SESSION_PREFIX + sessionId)
      if (data) {
        const session = JSON.parse(data)
        if (session.expiresAt > Date.now()) {
          return session
        }
      }
    } catch {}
    return null
  }

  const parts = sessionId.split('.')
  if (parts.length !== 3) return null

  const [username, expiresAtStr, sig] = parts
  const expiresAt = parseInt(expiresAtStr, 10)
  if (isNaN(expiresAt) || expiresAt < Date.now()) {
    return null // 已过期
  }

  const secret = env.ADMIN_PASSWORD || 'default_secret_123'
  const expectedSig = await signSession(username, expiresAt, secret)
  if (sig !== expectedSig) {
    return null // 签名校验失败
  }

  return { username, expiresAt }
}

export async function deleteSession(env: Env, sessionId: string): Promise<void> {
  // 签名会话直接在前端清除 Cookie 即可，这里不需要写任何 KV。
  // 若是历史遗留 KV 会话，安全清理之。
  if (sessionId && !sessionId.includes('.')) {
    try {
      await getKV(env).delete(KV_KEYS.SESSION_PREFIX + sessionId)
    } catch {}
  }
}

// ===== 转发 Key =====

export async function getProxyKeys(env: Env): Promise<ProxyKey[]> {
  const data = await kvGet(env, KV_KEYS.PROXY_KEYS)
  return data ? JSON.parse(data) : []
}

export async function setProxyKeys(env: Env, keys: ProxyKey[], immediate = false): Promise<void> {
  await kvPut(env, KV_KEYS.PROXY_KEYS, JSON.stringify(keys))
  if (immediate) {
    await flushPendingWrites(env)
  }
}

export async function addProxyKey(env: Env, key: ProxyKey, immediate = true): Promise<void> {
  const keys = await getProxyKeys(env)
  keys.push(key)
  await setProxyKeys(env, keys, immediate)
}

export async function deleteProxyKey(env: Env, id: string, immediate = true): Promise<boolean> {
  const keys = await getProxyKeys(env)
  const filtered = keys.filter((k) => k.id !== id)
  if (filtered.length === keys.length) return false
  await setProxyKeys(env, filtered, immediate)
  return true
}

export async function updateProxyKey(env: Env, id: string, updates: Partial<ProxyKey>, immediate = true): Promise<ProxyKey | null> {
  const keys = await getProxyKeys(env)
  const idx = keys.findIndex(k => k.id === id)
  if (idx === -1) return null
  keys[idx] = { ...keys[idx], ...updates }
  await setProxyKeys(env, keys, immediate)
  return keys[idx]
}

export async function validateProxyKey(env: Env, key: string): Promise<boolean> {
  const keys = await getProxyKeys(env)
  return keys.some((k) => {
    if (k.key !== key || !k.enabled) return false
    if (k.expiresAt) {
      const now = Date.now()
      const expires = new Date(k.expiresAt).getTime()
      if (now >= expires) return false
    }
    return true
  })
}

// ===== 初始数据填充 =====

import { DEFAULT_PROVIDERS, PROXY_KEY_PREFIX } from './config'

export async function seedInitialData(env: Env): Promise<void> {
  const providers = await getProviders(env)

  // 核心消释：如果提供商配置中已经有数据（比如恢复历史版本已有提供商），直接判定已经迁移完毕，绝不触发任何写操作！
  if (providers.length > 0) {
    memoryCache.set(KV_KEYS.OPENCODE_MIGRATION, { value: '1' })
    return
  }

  const migrationCompleted = await kvGet(env, KV_KEYS.OPENCODE_MIGRATION)
  if (migrationCompleted) return

  const opencode = DEFAULT_PROVIDERS.find((provider) => provider.id === 'opencode')

  if (opencode) {
    await setProviders(env, [
      {
        ...opencode,
        apiKeys: opencode.apiKeys.map((key) => ({ ...key })),
        models: opencode.models.map((model) => ({ ...model })),
      },
    ])
  }
  await kvPut(env, KV_KEYS.OPENCODE_MIGRATION, '1')

  const keys = await getProxyKeys(env)
  if (keys.length === 0) {
    const testKey = {
      id: crypto.randomUUID(),
      key: `${PROXY_KEY_PREFIX}${crypto.randomUUID().replace(/-/g, '').substring(0, 16)}`,
      name: '测试 Key',
      enabled: true,
      createdAt: new Date().toISOString(),
    }
    await addProxyKey(env, testKey)
  }

  const customRoutes = await getCustomModelRoutes(env)
  if (customRoutes.length === 0) {
    await saveCustomModelRoutes(env, [
      {
        id: 'cr_openclaw_default',
        sourceModel: 'openclaw/auto',
        targetProviderId: 'tier1',
        targetModelId: 'auto',
        enabled: true,
      },
    ])
  }
}

// ===== 网关请求日志管理 (内存高速队列 + 定量/定时/顺风车落盘 KV) =====

const MAX_MEMORY_LOGS = 150
const inMemoryLogs: RequestLog[] = []

export async function getLogs(env: Env): Promise<RequestLog[]> {
  // 1. 优先直接返回内存中的实时请求日志
  if (inMemoryLogs.length > 0) {
    return inMemoryLogs.slice(0, 100)
  }
  // 2. 内存为空（如 Serverless 节点冷启动/跨节点响应），从 KV 读取上一次保存的历史日志填充内存
  try {
    const kvData = await getKV(env).get(KV_KEYS.REQUEST_LOGS)
    if (kvData) {
      const storedLogs: RequestLog[] = JSON.parse(kvData)
      if (Array.isArray(storedLogs) && storedLogs.length > 0) {
        inMemoryLogs.push(...storedLogs.slice(0, MAX_MEMORY_LOGS))
      }
    }
  } catch (err) {
    console.warn('[storage] 从 KV 获取历史日志缓存失败:', err instanceof Error ? err.message : String(err))
  }
  return inMemoryLogs.slice(0, 100)
}

export async function addRequestLog(env: Env, log: RequestLog): Promise<void> {
  try {
    // 将最新请求日志放入内存队列首部
    inMemoryLogs.unshift(log)
    if (inMemoryLogs.length > MAX_MEMORY_LOGS) {
      inMemoryLogs.length = MAX_MEMORY_LOGS
    }

    unflushedLogCount++

    // 关键判断 1：检查是否属于超时、网络连接失败、上游报错或 HTTP 异常状态码 (status >= 400 或存在 error)
    const isErrorOrTimeout = (typeof log.status === 'number' && log.status >= 400) || !!log.error

    // 关键判断 2：读取用户设置的定量缓存阈值（默认 20 条）或调试模式
    const config = await getLogConfig(env)
    const bufferMax = config.bufferMaxCount || 20

    // 核心落盘规则（严格遵守 Cloudflare 免费额度政策）：
    // 1. 【调试模式下】：如果发生超时、报错、连接失败或积攒达到定量阈值，立即写入 KV，便于排查；
    // 2. 【正式模式下】（调试模式关闭）：严禁因请求报错或积攒主动刷写 KV！所有日志纯内存排队，
    //    仅在管理员保存配置等必要操作时通过“顺风车”顺路写入，日常请求完全 0 KV 写入消耗！
    if (config.debugMode && (isErrorOrTimeout || unflushedLogCount >= bufferMax)) {
      await flushPendingLogs(env)
    }
  } catch (err) {
    console.warn('[storage] addRequestLog 异常:', err instanceof Error ? err.message : String(err))
  }
}

export async function flushPendingLogs(env: Env): Promise<void> {
  // 内存无日志则退出
  if (inMemoryLogs.length === 0) return
  try {
    const logsToSave = inMemoryLogs.slice(0, 100)
    await getKV(env).put(KV_KEYS.REQUEST_LOGS, JSON.stringify(logsToSave))
    unflushedLogCount = 0
    lastLogFlushTime = Date.now()
  } catch (err) {
    console.warn('[storage] 落盘/顺风车保存日志至 KV 异常:', err instanceof Error ? err.message : String(err))
  }
}

export async function clearLogs(env: Env): Promise<void> {
  inMemoryLogs.length = 0
  unflushedLogCount = 0
  lastLogFlushTime = Date.now()
  try {
    await getKV(env).delete(KV_KEYS.REQUEST_LOGS)
  } catch {}
}

export async function getCustomModelRoutes(env: Env): Promise<CustomModelRoute[]> {
  const raw = await kvGet(env, KV_KEYS.CUSTOM_MODEL_ROUTES)
  if (!raw) return []
  try {
    const list = JSON.parse(raw)
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

export async function saveCustomModelRoutes(env: Env, routes: CustomModelRoute[], immediate = false): Promise<void> {
  if (unflushedLogCount > 0) {
    await flushPendingLogs(env)
  }
  await kvPut(env, KV_KEYS.CUSTOM_MODEL_ROUTES, JSON.stringify(routes))
  if (immediate) {
    await flushPendingWrites(env)
  }
}

/**
 * 核心统一保存：将所有配置（提供商、转发Key、指定模型路由）打包合流，一次性落盘，并顺风车捎带保存最新日志
 */
export async function saveAllUnifiedConfig(
  env: Env,
  data: {
    providers?: Provider[]
    proxyKeys?: ProxyKey[]
    customRoutes?: CustomModelRoute[]
  }
): Promise<void> {
  // 顺风车捎带：保存配置时检查内存未落盘日志并打包写入 KV
  if (unflushedLogCount > 0) {
    await flushPendingLogs(env)
  }
  // 顺风车捎带：将内存中排队的待落盘状态数据（如 Key 健康度、降级冷却等）一次性落盘
  await flushPendingWrites(env)
  if (Array.isArray(data.providers)) {
    const cleaned = data.providers.map((p) => {
      const seenKeys = new Set<string>()
      const uniqueKeys = (p.apiKeys || [])
        .filter((k) => {
          const trimmed = (k.key || '').trim()
          if (!trimmed || seenKeys.has(trimmed)) return false
          seenKeys.add(trimmed)
          return true
        })
        .map((k) => ({ key: k.key.trim(), enabled: k.enabled !== false }))

      const seenModels = new Set<string>()
      const uniqueModels = (p.models || []).filter((m) => {
        const trimmed = (m.id || '').trim()
        if (!trimmed || seenModels.has(trimmed)) return false
        seenModels.add(trimmed)
        return true
      })

      return {
        ...p,
        baseUrl: (p.baseUrl || '').trim().replace(/\/$/, ''),
        apiKeys: uniqueKeys,
        models: uniqueModels,
      }
    })
    await kvPut(env, KV_KEYS.PROVIDERS, JSON.stringify(cleaned))
  }

  if (Array.isArray(data.proxyKeys)) {
    await kvPut(env, KV_KEYS.PROXY_KEYS, JSON.stringify(data.proxyKeys))
  }

  if (Array.isArray(data.customRoutes)) {
    await kvPut(env, KV_KEYS.CUSTOM_MODEL_ROUTES, JSON.stringify(data.customRoutes))
  }

  // 终点再次核对：确保全链路所有待写入项全部顺风车打包完成
  await flushPendingWrites(env)
}

