/**
 * 版本号: v1.3.7
 * 更新说明:
 * 1. 界面体验大升级：彻底消灭日志列表横向拖动条，失败原因就地直观显示在模型下方，状态码集成重试标识；
 * 2. 调度池纯净化：严格过滤非对话模型（向量嵌入、视频检测、绘图等），杜绝 70 秒超时与 500 报错；
 * 3. 顺风车持久化连接状态：真实发生跨模型切换时顺风车一次性写入 KV，解决多边缘节点冷启动重复误报切换与多发车问题；
 * 4. 敏捷超时保护：优化非流式请求超时策略，避免上游卡死导致过长等待。
 */
import type { Provider } from './types'

export const VERSION = 'v1.3.7'

export const SITE_CONFIG = {
  title: 'AI Gateway',
  subtitle: '统一的 AI 管理平台',
  version: VERSION,
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

// 梯队池席位上限配置（第一梯队 9 席，OpenClaw 智能体池 6 席，绘画池 6 席）
export const TIER_1_MAX_SLOTS = 9
export const TIER_OPENCLAW_MAX_SLOTS = 6
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
} as const

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
