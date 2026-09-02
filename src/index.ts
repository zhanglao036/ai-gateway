import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import type { Env } from './types'
import { createLocalKV } from './localKv'
import { adminAuthMiddleware, proxyKeyAuthMiddleware, handleLogin, handleLogout } from './auth'
import { handleProxy, handleModels } from './proxy'
import {
  handleStatus,
  handleGetProviders,
  handleCreateProvider,
  handleUpdateProvider,
  handleDeleteProvider,
  handleTestModel,
  handleTestKeyNew,
  handleTestModelNew,
  handleGetProxyKeys,
  handleCreateProxyKey,
  handleUpdateProxyKey,
  handleDeleteProxyKey,
  handleSaveAll,
  handleGetLogs,
  handleClearLogs,
  handleGetDebugMode,
  handleToggleDebugMode,
  handleGetCustomRoutes,
  handleSaveCustomRoutes,
  handleTestCustomRoute,
  handleRunProbe,
  handleResetCooldowns,
  handleFetchUpstreamModels,
  handleImportModels,
  handleClearProviderModels,
  handleUpdateModelStatus,
  handleGetTiers,
  handleTestBlockedModels,
} from './admin'
import { renderHomePage, renderLoginPage, renderAdminPage } from './pages'
import { seedInitialData, getSession } from './storage'

const app = new Hono<{ Bindings: Env }>()

const localKV = createLocalKV()

// ===== 全局中间件 =====
app.use('*', cors())
app.use('*', logger())

// 兼容本地及 Cloud Run 运行环境的 KV 与 环境变量补全
app.use('*', async (c, next) => {
  const envObj = (c.env || {}) as Partial<Env>
  if (!envObj.KV) {
    envObj.KV = localKV as any
  }
  if (!envObj.ADMIN_USERNAME) {
    envObj.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin'
  }
  if (!envObj.ADMIN_PASSWORD) {
    envObj.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'
  }
  ;(c as any).env = envObj
  return next()
})

// 首次请求时填充虚拟数据
let seeded = false
app.use('*', async (c, next) => {
  if (!seeded) {
    await seedInitialData(c.env)
    seeded = true
  }
  return next()
})

// ===== 首页 =====
app.get('/', async (c) => {
  const { getCookie } = await import('hono/cookie')
  const sessionId = getCookie(c, 'session_id')
  let isLoggedIn = false
  if (sessionId) {
const session = await getSession(c.env, sessionId)
    isLoggedIn = session !== null
  }
  return renderHomePage(c, isLoggedIn)
})

// ===== 登录/退出 =====
app.get('/admin/login', async (c) => renderLoginPage(c))
app.post('/admin/login', handleLogin)
app.get('/admin/logout', handleLogout)

// ===== 管理后台（需 Session 验证） =====
app.use('/admin/*', adminAuthMiddleware)

app.get('/admin', async (c) => renderAdminPage(c))

// 系统状态
app.get('/admin/api/status', handleStatus)

// 提供商 CRUD
app.get('/admin/api/providers', handleGetProviders)
app.post('/admin/api/providers', handleCreateProvider)
app.put('/admin/api/providers/:id', handleUpdateProvider)
app.delete('/admin/api/providers/:id', handleDeleteProvider)
app.post('/admin/api/providers/:id/test-model', handleTestModel)
app.post('/admin/api/test-key', handleTestKeyNew)
app.post('/admin/api/test-model', handleTestModelNew)

// 转发 Key 管理
app.get('/admin/api/proxy-keys', handleGetProxyKeys)
app.post('/admin/api/proxy-keys', handleCreateProxyKey)
app.delete('/admin/api/proxy-keys/:id', handleDeleteProxyKey)
app.patch('/admin/api/proxy-keys/:id', handleUpdateProxyKey)

// 探测任务与全局重置
app.get('/admin/api/tiers', handleGetTiers)
app.post('/admin/api/probe', handleRunProbe)
app.post('/admin/api/reset-cooldowns', handleResetCooldowns)
app.post('/admin/api/test-blocked-models', handleTestBlockedModels)

// 提供商模型配套操作
app.post('/admin/api/providers/:id/fetch-models', handleFetchUpstreamModels)
app.post('/admin/api/providers/:id/import-models', handleImportModels)
app.delete('/admin/api/providers/:id/models', handleClearProviderModels)
app.patch('/admin/api/providers/:id/models/:modelId', handleUpdateModelStatus)

// 批量统一保存配置 (一次性写入 KV)
app.post('/admin/api/save-all', handleSaveAll)

// 网关请求日志与调试模式
app.get('/admin/api/logs', handleGetLogs)
app.delete('/admin/api/logs', handleClearLogs)
app.get('/admin/api/debug-mode', handleGetDebugMode)
app.post('/admin/api/debug-mode', handleToggleDebugMode)

// 自定义指定模型路由
app.get('/admin/api/custom-routes', handleGetCustomRoutes)
app.post('/admin/api/custom-routes', handleSaveCustomRoutes)
app.post('/admin/api/custom-routes/test', handleTestCustomRoute)

// ===== API 转发路由（需转发 Key 验证） =====
app.use('/v1/*', proxyKeyAuthMiddleware)
app.get('/v1/models', handleModels)
app.all('/v1/*', handleProxy)

// ===== 404 处理 =====
app.notFound((c) => {
  return c.json({ error: { message: '接口不存在', type: 'not_found' } }, 404)
})

// ===== 错误处理 =====
app.onError((err, c) => {
  console.error('未捕获的错误:', err)
  return c.json({ error: { message: '服务器内部错误', type: 'server_error' } }, 500)
})

export default app
