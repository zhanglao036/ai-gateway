import { Context, Next } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { createSession, getSession, deleteSession, validateProxyKey } from './storage'
import { SESSION_TTL } from './config'
import type { Env } from './types'

/** SHA-256 哈希 */
export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(password)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 管理后台 Session 验证中间件 */
export async function adminAuthMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const url = new URL(c.req.url)
  if (url.pathname === '/admin/login') return next()

  let sessionId = getCookie(c, 'session_id')
  if (!sessionId) {
    const authHeader = c.req.header('Authorization')
    if (authHeader && authHeader.startsWith('Bearer ')) {
      sessionId = authHeader.slice(7)
    } else {
      sessionId = url.searchParams.get('token') || url.searchParams.get('session_id') || undefined
    }
  }

  if (!sessionId) {
    if (url.pathname.startsWith('/admin/api/')) {
      return c.json({ success: false, message: '未登录' }, 401)
    }
    return c.redirect('/admin/login')
  }

  const session = await getSession(c.env, sessionId)
  if (!session) {
    deleteCookie(c, 'session_id')
    if (url.pathname.startsWith('/admin/api/')) {
      return c.json({ success: false, message: 'Session 已过期' }, 401)
    }
    return c.redirect('/admin/login')
  }

  // Ensure cookie is set for subsequent requests
  try {
    setCookie(c, 'session_id', sessionId, {
      httpOnly: false,
      secure: true,
      sameSite: 'None',
      path: '/',
      maxAge: SESSION_TTL,
    })
  } catch (e) {}

  ;(c as any).set('username', session.username)
  return next()
}

/** 管理员登录 */
export async function handleLogin(c: Context<{ Bindings: Env }>) {
  let body: { username?: string; password?: string } = {}
  try {
    body = await c.req.json()
  } catch (e) {
    return c.json({ success: false, message: '无效的 JSON 请求' }, 400)
  }

  const { username, password } = body
  const adminUser = c.env?.ADMIN_USERNAME || process.env.ADMIN_USERNAME || 'admin'
  const adminPass = c.env?.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || 'admin123'

  if (!adminUser || !adminPass) {
    return c.json({
      success: false,
      message: '未配置管理员账号，请在环境变量中设置 ADMIN_USERNAME 和 ADMIN_PASSWORD',
    }, 500)
  }

  if (!username || !password) {
    return c.json({ success: false, message: '请输入用户名和密码' }, 400)
  }

  if (username !== adminUser) {
    return c.json({ success: false, message: '用户名或密码错误' }, 401)
  }

  const passwordHash = await hashPassword(password)
  const adminPassHash = await hashPassword(adminPass)

  if (passwordHash !== adminPassHash) {
    return c.json({ success: false, message: '用户名或密码错误' }, 401)
  }

  const sessionId = await createSession(c.env, username, SESSION_TTL)
  
  try {
    setCookie(c, 'session_id', sessionId, {
      httpOnly: false,
      secure: true,
      sameSite: 'None',
      path: '/',
      maxAge: SESSION_TTL,
    })
  } catch (e) {}

  return c.json({
    success: true,
    message: '登录成功',
    token: sessionId,
    redirectUrl: `/admin?token=${sessionId}`
  })
}

/** 检查当前登录凭证是否有效 */
export async function handleCheckAuth(c: Context<{ Bindings: Env }>) {
  let sessionId = getCookie(c, 'session_id')
  if (!sessionId) {
    const authHeader = c.req.header('Authorization')
    if (authHeader && authHeader.startsWith('Bearer ')) {
      sessionId = authHeader.slice(7)
    }
  }
  if (!sessionId) {
    return c.json({ loggedIn: false }, 200)
  }
  const session = await getSession(c.env, sessionId)
  if (!session) {
    deleteCookie(c, 'session_id')
    return c.json({ loggedIn: false }, 200)
  }
  return c.json({ loggedIn: true, username: session.username }, 200)
}

/** 退出登录 */
export async function handleLogout(c: Context<{ Bindings: Env }>) {
  const sessionId = getCookie(c, 'session_id')
  if (sessionId) {
    await deleteSession(c.env, sessionId)
    deleteCookie(c, 'session_id')
  }
  return c.redirect('/admin/login')
}

/** 转发 API Key 验证中间件 */
export async function proxyKeyAuthMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const startTime = Date.now()
  const authHeader = c.req.header('Authorization')
  const { recordLog, getClientIp, maskKey } = await import('./proxy')
  const clientIp = getClientIp(c)
  const routePath = new URL(c.req.url).pathname

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    await recordLog(c.env, startTime, '鉴权失败', 401, '缺少或无效的 Authorization 头 (需 Bearer sk_cf_*)', {
      routePath,
      clientIp,
    })
    return c.json({
      error: { message: '缺少或无效的 Authorization 头，格式: Bearer sk_cf_*', type: 'authentication_error' },
    }, 401)
  }

  const token = authHeader.slice(7)
  const isValid = await validateProxyKey(c.env, token)
  if (!isValid) {
    await recordLog(c.env, startTime, '鉴权失败', 401, `API Key 无效、已禁用或已过期: ${maskKey(token)}`, {
      keyMask: maskKey(token),
      routePath,
      clientIp,
    })
    return c.json({
      error: { message: 'API Key 无效或已禁用', type: 'authentication_error' },
    }, 401)
  }

  return next()
}
