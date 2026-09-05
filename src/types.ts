export interface Model {
  id: string
  enabled: boolean
  category?: '文本' | '绘图' | '多模态' | '其他' | string
  failureCount?: number
  cooldownUntil?: number | null
  permanentlyDisabled?: boolean
  disabledReason?: string | null
  lastPermTestAt?: number
  permTestFailCount?: number
  openclawTested?: boolean
  openclawCompatible?: boolean
  openclawReason?: string | null
  openclawTestedAt?: number
}

export interface ApiKeyEntry {
  key: string
  enabled: boolean
}

export interface Provider {
  id: string
  name: string
  baseUrl: string
  apiType?: 'openai' | 'anthropic'
  useBrowserUA?: boolean
  apiKeys: ApiKeyEntry[]
  models: Model[]
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface ProxyKey {
  id: string
  key: string
  name: string
  enabled: boolean
  createdAt: string
  expiresAt?: string | null
}

export interface Session {
  username: string
  expiresAt: number
}

export interface ProxyRequestBody {
  model?: string
  stream?: boolean
  messages?: Array<{ role: string; content: string }>
  [key: string]: unknown
}

export interface TestModelRequest {
  modelId: string
  forceOpenclaw?: boolean
}

export interface CreateProviderRequest {
  id: string
  name: string
  baseUrl: string
  apiType?: 'openai' | 'anthropic'
  useBrowserUA?: boolean
  apiKeys?: Array<{ key: string; enabled: boolean }>
  models?: Array<{ id: string; enabled: boolean }> | string[]
  enabled?: boolean
}

export interface UpdateProviderRequest {
  name?: string
  baseUrl?: string
  apiType?: 'openai' | 'anthropic'
  useBrowserUA?: boolean
  apiKeys?: Array<{ key: string; enabled: boolean }>
  models?: Array<{ id: string; enabled: boolean }> | string[]
  enabled?: boolean
}

export interface CreateProxyKeyRequest {
  name?: string
  expiresIn?: string // '30d' | '90d' | '180d' | '1y' | 'forever'
}

export interface RequestLog {
  id: string
  time: string
  model: string
  latency: number
  status: number
  error?: string | null
  // 扩展排查详情字段
  keyMask?: string | null
  attemptIndex?: number
  routePath?: string | null
  isStream?: boolean
  clientIp?: string | null
}

export interface LogConfig {
  debugMode: boolean
  bufferMaxCount: number
  flushIntervalSeconds: number
}

export interface CustomModelRoute {
  id: string
  sourceModel: string
  targetProviderId: string
  targetModelId: string
  enabled: boolean
}

export interface TierModelRef {
  providerId: string
  modelId: string
  fullId: string
  addedAt: number
}

export interface ProbeMetric {
  latency: number
  lastTestedAt: number
  success: boolean
  statusCode?: number
  error?: string
  category?: string
  openclawCompatible?: boolean
  openclawReason?: string
}

export interface BusinessMetric {
  avgLatency: number
  totalRequests: number
  successCount: number
  failureCount: number
  lastUsedAt: number
}

export interface TierStorage {
  tier1: TierModelRef[]
  tier2: TierModelRef[]
  tierOpenclaw?: TierModelRef[]
  tierDrawing?: TierModelRef[]
  probeStats: Record<string, ProbeMetric>
  businessStats: Record<string, BusinessMetric>
  updatedAt: string
  lastProbeDate?: string
  lastCursorProviderId?: string
  modelCursors?: Record<string, number>
}

export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  message?: string
}

export interface Env {
  KV: KVNamespace
  ADMIN_USERNAME?: string
  ADMIN_PASSWORD?: string
  OPENCODE_MIRRORS_URL?: string
  MODE?: string
  DEBUG?: boolean | string
}
