import type { Provider } from './types'

// 系统全局版本号 (每次更新严格递增版本号)
export const CURRENT_VERSION = 'v1.18.2'

export const SITE_CONFIG = {
  title: 'AI Gateway',
  version: CURRENT_VERSION,
  subtitle: '统一的 AI 管理平台',
  author: 'QingYun',
  authorUrl: 'https://github.com/yutian81/ai-gateway',
  blogUrl: 'https://blog.notett.com',
  description: 'AI 提供商 API 代理网关 — 统一 /v1 接口转发',
  favicon: 'https://pan.811520.xyz/icon/ai.webp',
  faCdn: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css',
}

export const SESSION_TTL = 7 * 24 * 60 * 60

export const PROXY_KEY_PREFIX = 'sk_cf_'

export const OPENCODE_DEFAULT_URL = 'https://opencode.ai/zen/v1'

// Key 降权后自动恢复的冷却时间 (毫秒)
export const KEY_HEALTH_COOLDOWN_MS = 5 * 60 * 1000

// 连续失败多少次后降权
export const KEY_HEALTH_MAX_FAILURES = 5

// 日志队列批量落盘配置
export const LOG_BATCH_SIZE = 10
export const LOG_FLUSH_INTERVAL_MS = 30000

export const TIER_1_MAX_SLOTS = 9
// OpenClaw 专属梯队池席位上限：由原有的 5 席增加为 6 席
export const TIER_OPENCLAW_MAX_SLOTS = 6
// 绘图专属梯队池席位上限：由原有的 5 席增加为 6 席
export const TIER_DRAWING_MAX_SLOTS = 6

export const KV_KEYS = {
  PROVIDERS: 'providers',
  PROXY_KEYS: 'proxy:keys',
  SESSION_PREFIX: 'admin:session:',
  KEY_HEALTH_PREFIX: 'key:health:',
  OPENCODE_MIGRATION: 'migration:opencode-default:v1',
  REQUEST_LOGS: 'gateway:request_logs',
  DEBUG_MODE: 'config:debug_mode',
  LOG_CONFIG: 'config:log_settings',
  CUSTOM_MODEL_ROUTES: 'config:custom_model_routes',
  TIER_DATA: 'gateway:tier_data',
  TIMEOUT_CONFIG: 'system:timeout_config',
} as const

// 各梯队池独立配置（包含超时时长与思考模式开关）
export interface PoolTimeoutConfig {
  // 第一梯队（通用池）超时时长，单位秒，默认 60 秒
  generalTimeout: number
  // OpenClaw 专属池超时时长，单位秒，默认 60 秒
  openclawTimeout: number
  // 绘图专属池超时时长，单位秒，默认 60 秒
  drawingTimeout: number
  // 第一梯队（通用池）是否强制关闭思考模式（默认 false：保留模型原生推理深度）
  disableThinkingTier1?: boolean
  // OpenClaw 专属池是否强制关闭思考模式（默认 true：防止智能体与思考模式冲突崩溃）
  disableThinkingOpenclaw?: boolean
  // 绘图专属池是否强制关闭思考模式（默认 false）
  disableThinkingDrawing?: boolean
}

// 梯队池默认配置（超时保持 60 秒，OpenClaw 默认关闭思考以确保绝对稳定）
export const DEFAULT_POOL_TIMEOUTS: PoolTimeoutConfig = {
  generalTimeout: 60,
  openclawTimeout: 60,
  drawingTimeout: 60,
  disableThinkingTier1: false,
  disableThinkingOpenclaw: true, // 智能体专属池默认关闭内心戏，杜绝 LLM request failed
  disableThinkingDrawing: false,
}

// 有效期选项（秒）
export const EXPIRY_OPTIONS: Record<string, number | null> = {
  '30d': 30 * 24 * 60 * 60,
  '90d': 90 * 24 * 60 * 60,
  '180d': 180 * 24 * 60 * 60,
  '1y': 365 * 24 * 60 * 60,
  'forever': null,
}

export const DEFAULT_PROVIDERS: Provider[] = [
  {
    id: 'opencode',
    name: 'OpenCode',
    baseUrl: 'https://opencode.ai/zen/v1',
    apiType: 'openai',
    apiKeys: [],
    models: [
      { id: 'deepseek-v4-flash-free', enabled: true },
      { id: 'mimo-v2.5-free', enabled: true },
      { id: 'nemotron-3-ultra-free', enabled: true },
      { id: 'hy3-free', enabled: true },
    ],
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
]
