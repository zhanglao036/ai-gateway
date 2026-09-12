/**
 * 版本号: v1.3.4
 * 更新说明: 精准收敛发车写入与顺风车落盘：
 * 1. 严格锁定发车事件（真实故障报错、真实跨模型切换、后台保存配置），日常平稳请求零 KV 写入；
 * 2. 内存候车乘客在发车事件或手动保存时全量打包落盘并打标为【客】。
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
    await getKV(env).put(KV_KEYS.DEBUG_MODE, newDebug ? 'true' : 'false')
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
  // 顺路检查并打包内存中所有候车的请求日志，一次性写入 KV 并同步标记为【🧳 客】
  if (inMemoryLogs.length > 0) {
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

  // 首次运行时添加默认 openclaw/auto 指定规则（指向第一梯队池）
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
  // 1. 从 KV 读取已落盘的全局日志，与本地内存日志进行智能排重合并与状态同步
  try {
    const kvData = await getKV(env).get(KV_KEYS.REQUEST_LOGS)
    if (kvData) {
      const storedLogs: RequestLog[] = JSON.parse(kvData)
      if (Array.isArray(storedLogs) && storedLogs.length > 0) {
        // 构建 KV 中已落盘日志的映射表
        const kvLogMap = new Map<string, RequestLog>()
        for (const log of storedLogs) {
          if (log && log.id) {
            kvLogMap.set(log.id, log)
          }
        }

        // 关键逻辑：如果内存中的日志已经存在于 KV 中，用 KV 里的已落盘状态（如 passenger / driver）覆盖内存中的临时状态
        for (const localLog of inMemoryLogs) {
          const stored = kvLogMap.get(localLog.id)
          if (stored && stored.kvTag) {
            localLog.kvTag = stored.kvTag
          }
        }

        // 构建已有 ID 的集合以快速排重未在内存中的历史记录
        const existingIds = new Set(inMemoryLogs.map(l => l.id))
        for (const log of storedLogs) {
          if (!existingIds.has(log.id)) {
            inMemoryLogs.push(log)
            existingIds.add(log.id)
          }
        }
        // 按时间倒序重新排列（最新的在前，time 字段为 ISO 字符串）
        inMemoryLogs.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
        if (inMemoryLogs.length > MAX_MEMORY_LOGS) {
          inMemoryLogs.length = MAX_MEMORY_LOGS
        }
      }
    }
  } catch (err) {
    console.warn('[storage] 从 KV 获取历史日志缓存失败:', err instanceof Error ? err.message : String(err))
  }
  return inMemoryLogs.slice(0, 100)
}

export async function addRequestLog(env: Env, log: RequestLog): Promise<void> {
  try {
    // 读取当前调试模式与配置
    const config = await getLogConfig(env)

    // 核心发车事件判定：
    // 1. 是否为模型切换事件（首发连接或调度变动，触发发车）
    const isSwitchEvent = !!log.isModelSwitch
    // 2. 是否属于超时、报错、上游失败或 HTTP 异常状态码 (status >= 400 或存在 error)
    const isErrorOrTimeout = (typeof log.status === 'number' && log.status >= 400) || !!log.error
    // 3. 调试模式开启：任何请求均视为直接发车
    const isDriverEvent = config.debugMode || isSwitchEvent || isErrorOrTimeout

    if (isDriverEvent) {
      // 🚗 发车事件：直接触发 1 笔 KV 写入，并将本条日志打标为 driver（车）
      log.kvTag = 'driver'
      inMemoryLogs.unshift(log)
      if (inMemoryLogs.length > MAX_MEMORY_LOGS) {
        inMemoryLogs.length = MAX_MEMORY_LOGS
      }
      unflushedLogCount++
      // 触发发车，顺带将内存中所有候车的乘客日志一并带走落盘
      await flushPendingLogs(env, log.id)
    } else {
      // 🧳 顺风乘客：平稳 200 请求纯内存驻留 (0 KV 写入)，打标为 memory（候）等待下次发车顺路打包
      log.kvTag = 'memory'
      inMemoryLogs.unshift(log)
      if (inMemoryLogs.length > MAX_MEMORY_LOGS) {
        inMemoryLogs.length = MAX_MEMORY_LOGS
      }
      unflushedLogCount++
    }
  } catch (err) {
    console.warn('[storage] addRequestLog 异常:', err instanceof Error ? err.message : String(err))
  }
}

export async function flushPendingLogs(env: Env, triggerLogId?: string): Promise<void> {
  // 内存无日志则退出
  if (inMemoryLogs.length === 0) return
  try {
    // 发车打包：更新内存中所有排队日志的落盘打标
    for (const l of inMemoryLogs) {
      if (triggerLogId && l.id === triggerLogId) {
        l.kvTag = 'driver' // 触发本次发车的主事件日志
      } else if (l.kvTag === 'memory' || !l.kvTag) {
        l.kvTag = 'passenger' // 搭乘顺风车成功落盘的乘客日志
      }
    }

    // 写入前尝试与 KV 中现存数据合并，防止并发实例写覆盖
    let mergedLogs = [...inMemoryLogs]
    const kvData = await getKV(env).get(KV_KEYS.REQUEST_LOGS)
    if (kvData) {
      const storedLogs: RequestLog[] = JSON.parse(kvData)
      if (Array.isArray(storedLogs)) {
        const idSet = new Set(mergedLogs.map(l => l.id))
        for (const s of storedLogs) {
          if (!idSet.has(s.id)) {
            mergedLogs.push(s)
            idSet.add(s.id)
          }
        }
        mergedLogs.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
      }
    }
    const logsToSave = mergedLogs.slice(0, 100)
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

export async function saveCustomModelRoutes(env: Env, routes: CustomModelRoute[]): Promise<void> {
  if (unflushedLogCount > 0) {
    await flushPendingLogs(env)
  }
  await kvPut(env, KV_KEYS.CUSTOM_MODEL_ROUTES, JSON.stringify(routes))
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
    memoryCache.set(KV_KEYS.PROVIDERS, { value: JSON.stringify(cleaned) })
    await getKV(env).put(KV_KEYS.PROVIDERS, JSON.stringify(cleaned))
  }

  if (Array.isArray(data.proxyKeys)) {
    memoryCache.set(KV_KEYS.PROXY_KEYS, { value: JSON.stringify(data.proxyKeys) })
    await getKV(env).put(KV_KEYS.PROXY_KEYS, JSON.stringify(data.proxyKeys))
  }

  if (Array.isArray(data.customRoutes)) {
    memoryCache.set(KV_KEYS.CUSTOM_MODEL_ROUTES, { value: JSON.stringify(data.customRoutes) })
    await getKV(env).put(KV_KEYS.CUSTOM_MODEL_ROUTES, JSON.stringify(data.customRoutes))
  }

  // 终点再次核对：确保全链路所有待写入项全部顺风车打包完成
  await flushPendingWrites(env)
}

