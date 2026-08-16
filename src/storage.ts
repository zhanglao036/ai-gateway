import { KV_KEYS, LOG_BATCH_SIZE, LOG_FLUSH_INTERVAL_MS } from './config'
import type { Env, Provider, ProxyKey, RequestLog, Session } from './types'
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
 * 在正式模式下通过单实例内存缓存合并/延迟落盘，以规避 Cloudflare 免费版 KV 每日 1000 次写入限额。
 * 调试模式（MODE='debug' 或 DEBUG='true'）下跳过内存合并，即时写入 KV。
 */

// 内存二级缓存（单实例有效）
const memoryCache = new Map<string, { value: string; expiresAt?: number }>()
const pendingWrites = new Map<string, { value: string; options?: { expirationTtl?: number }; isDelete?: boolean }>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

// 动态调试模式与日志参数控制
let dynamicDebugMode: boolean | null = null
let dynamicBufferMaxCount: number | null = null
let dynamicFlushIntervalSeconds: number | null = null

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
  if (maxCount === null) maxCount = 50 // 默认 50 条
  if (intervalSec === null) intervalSec = 30 // 默认 30 秒

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

  await getKV(env).put(KV_KEYS.LOG_CONFIG, JSON.stringify(configObj))
  await getKV(env).put(KV_KEYS.DEBUG_MODE, newDebug ? 'true' : 'false')

  // 切换配置或调试模式瞬间，未落地日志及缓存强制落盘
  await flushPendingLogs(env)
  await flushPendingWrites(env)
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

export async function kvPut(env: Env, key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
  const expiresAt = options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : undefined
  memoryCache.set(key, { value, expiresAt })

  if (isDebugMode(env)) {
    // 调试模式：立即直接落盘 KV
    await getKV(env).put(key, value, options)
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
  return data ? JSON.parse(data) : []
}

export async function getProvider(env: Env, id: string): Promise<Provider | null> {
  const providers = await getProviders(env)
  return providers.find((p) => p.id === id) ?? null
}

export async function setProviders(env: Env, providers: Provider[]): Promise<void> {
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
  await flushPendingWrites(env)
}

export async function addProvider(env: Env, provider: Provider): Promise<void> {
  const providers = await getProviders(env)
  providers.push(provider)
  await setProviders(env, providers)
}

export async function updateProvider(env: Env, id: string, updates: Partial<Provider>): Promise<Provider | null> {
  const providers = await getProviders(env)
  const index = providers.findIndex((p) => p.id === id)
  if (index === -1) return null
  providers[index] = { ...providers[index], ...updates, updatedAt: new Date().toISOString() }
  await setProviders(env, providers)
  return providers[index]
}

export async function deleteProvider(env: Env, id: string): Promise<boolean> {
  const providers = await getProviders(env)
  const filtered = providers.filter((p) => p.id !== id)
  if (filtered.length === providers.length) return false
  await setProviders(env, filtered)
  return true
}

// ===== Session 管理 =====

export async function createSession(env: Env, username: string, ttlSeconds: number): Promise<string> {
  const sessionId = crypto.randomUUID()
  const session: Session = {
    username,
    expiresAt: Date.now() + ttlSeconds * 1000,
  }
  await kvPut(env, KV_KEYS.SESSION_PREFIX + sessionId, JSON.stringify(session), {
    expirationTtl: ttlSeconds,
  })
  await flushPendingWrites(env)
  return sessionId
}

export async function getSession(env: Env, sessionId: string): Promise<Session | null> {
  const data = await kvGet(env, KV_KEYS.SESSION_PREFIX + sessionId)
  if (!data) return null
  const session: Session = JSON.parse(data)
  if (session.expiresAt < Date.now()) {
    await deleteSession(env, sessionId)
    return null
  }
  return session
}

export async function deleteSession(env: Env, sessionId: string): Promise<void> {
  await kvDelete(env, KV_KEYS.SESSION_PREFIX + sessionId)
  await flushPendingWrites(env)
}

// ===== 转发 Key =====

export async function getProxyKeys(env: Env): Promise<ProxyKey[]> {
  const data = await kvGet(env, KV_KEYS.PROXY_KEYS)
  return data ? JSON.parse(data) : []
}

export async function setProxyKeys(env: Env, keys: ProxyKey[]): Promise<void> {
  await kvPut(env, KV_KEYS.PROXY_KEYS, JSON.stringify(keys))
  await flushPendingWrites(env)
}

export async function addProxyKey(env: Env, key: ProxyKey): Promise<void> {
  const keys = await getProxyKeys(env)
  keys.push(key)
  await setProxyKeys(env, keys)
}

export async function deleteProxyKey(env: Env, id: string): Promise<boolean> {
  const keys = await getProxyKeys(env)
  const filtered = keys.filter((k) => k.id !== id)
  if (filtered.length === keys.length) return false
  await setProxyKeys(env, filtered)
  return true
}

export async function updateProxyKey(env: Env, id: string, updates: Partial<ProxyKey>): Promise<ProxyKey | null> {
  const keys = await getProxyKeys(env)
  const idx = keys.findIndex(k => k.id === id)
  if (idx === -1) return null
  keys[idx] = { ...keys[idx], ...updates }
  await setProxyKeys(env, keys)
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
  const migrationCompleted = await kvGet(env, KV_KEYS.OPENCODE_MIGRATION)
  const opencode = DEFAULT_PROVIDERS.find((provider) => provider.id === 'opencode')

  if (!migrationCompleted) {
    if (opencode && !providers.some((provider) => provider.id === opencode.id)) {
      await setProviders(env, [
        ...providers,
        {
          ...opencode,
          apiKeys: opencode.apiKeys.map((key) => ({ ...key })),
          models: opencode.models.map((model) => ({ ...model })),
        },
      ])
    }
    await kvPut(env, KV_KEYS.OPENCODE_MIGRATION, '1')
  }

  // 仅首次运行时创建测试转发 Key
  if (providers.length === 0 && !migrationCompleted) {
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
  }
}

// ===== 网关请求日志管理 =====

let logQueue: RequestLog[] = []
let logFlushTimer: ReturnType<typeof setTimeout> | null = null

export async function getLogs(env: Env): Promise<RequestLog[]> {
  const kvData = await getKV(env).get(KV_KEYS.REQUEST_LOGS)
  const storedLogs: RequestLog[] = kvData ? JSON.parse(kvData) : []
  const combined = [...logQueue, ...storedLogs]
  const uniqueMap = new Map<string, RequestLog>()
  for (const item of combined) {
    if (item && item.id && !uniqueMap.has(item.id)) {
      uniqueMap.set(item.id, item)
    }
  }
  return Array.from(uniqueMap.values()).slice(0, 100)
}

export async function addRequestLog(env: Env, log: RequestLog): Promise<void> {
  const config = await getLogConfig(env)
  if (config.debugMode) {
    // 调试模式开启：每条请求日志实时写入 KV
    const currentLogs = await getLogs(env)
    const updated = [log, ...currentLogs].slice(0, 100)
    await getKV(env).put(KV_KEYS.REQUEST_LOGS, JSON.stringify(updated))
    return
  }

  // 调试模式关闭：推入内存缓存队列
  logQueue.unshift(log)
  if (logQueue.length > 100) logQueue.length = 100

  // 达到队列条数阈值：立即批量落盘
  const maxCount = config.bufferMaxCount || LOG_BATCH_SIZE
  if (logQueue.length >= maxCount) {
    await flushPendingLogs(env)
  } else {
    // 定时器规则批量落盘
    scheduleLogFlush(env, (config.flushIntervalSeconds || 30) * 1000)
  }
}

function scheduleLogFlush(env: Env, intervalMs: number = LOG_FLUSH_INTERVAL_MS) {
  if (logFlushTimer) return
  logFlushTimer = setTimeout(() => {
    logFlushTimer = null
    flushPendingLogs(env).catch(console.error)
  }, intervalMs)
}

export async function flushPendingLogs(env: Env): Promise<void> {
  if (logFlushTimer) {
    clearTimeout(logFlushTimer)
    logFlushTimer = null
  }
  if (logQueue.length === 0) return

  const itemsToFlush = [...logQueue]
  logQueue = []

  try {
    const rawKV = await getKV(env).get(KV_KEYS.REQUEST_LOGS)
    const existing: RequestLog[] = rawKV ? JSON.parse(rawKV) : []
    const merged = [...itemsToFlush, ...existing]
    const uniqueMap = new Map<string, RequestLog>()
    for (const item of merged) {
      if (item && item.id && !uniqueMap.has(item.id)) {
        uniqueMap.set(item.id, item)
      }
    }
    const finalLogs = Array.from(uniqueMap.values()).slice(0, 100)
    await getKV(env).put(KV_KEYS.REQUEST_LOGS, JSON.stringify(finalLogs))
  } catch (err) {
    console.error('[storage] 批量落盘日志失败:', err)
    logQueue = [...itemsToFlush, ...logQueue]
  }
}

export async function clearLogs(env: Env): Promise<void> {
  logQueue = []
  if (logFlushTimer) {
    clearTimeout(logFlushTimer)
    logFlushTimer = null
  }
  await getKV(env).delete(KV_KEYS.REQUEST_LOGS)
}
