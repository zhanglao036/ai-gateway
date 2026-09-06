import { Context } from 'hono'
import { getProviders, getProxyKeys, getLogs, getDebugMode, getLogConfig, getCustomModelRoutes } from './storage'
import { SITE_CONFIG, OPENCODE_DEFAULT_URL } from './config'
import type { Env, TierStorage } from './types'
import { CSS_CONTENT } from './pages.css'
import { SHARED_JS, renderSiteFooter } from './shared.js'
import { getTierStorage } from './tiers'

// 前端页面模板：仅重构视觉与交互，保持后端路由、KV 结构和 API 契约不变。
const escapePageHtml = (value: unknown) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

const H = (title: string) => `
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <meta name="theme-color" content="oklch(98.5% 0.004 250)">
  <title>${title} — ${SITE_CONFIG.title}</title>
  <link rel="icon" href="${SITE_CONFIG.favicon}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&amp;family=JetBrains+Mono:wght@400;500;600&amp;family=Space+Grotesk:wght@500;600&amp;display=swap" rel="stylesheet">
  <link rel="stylesheet" href="${SITE_CONFIG.faCdn}">
  <style>${CSS_CONTENT}</style>
</head>`

// ===== 首页 =====

export async function renderHomePage(c: Context<{ Bindings: Env }>, isLoggedIn: boolean) {
  const providers = await getProviders(c.env)
  // 仅从 KV 快速读取已有数据，绝不发起任何外部网络测速，保证瞬间秒开
  const defaultTierData: TierStorage = {
    tier1: [],
    tier2: [],
    tierOpenclaw: [],
    tierDrawing: [],
    probeStats: {},
    businessStats: {},
    updatedAt: '',
    lastProbeDate: '',
    modelCursors: {},
  }
  const tierData = (await getTierStorage(c.env)) || defaultTierData
  const tier1Models = tierData.tier1 || []
  const tierOpenclawModels = tierData.tierOpenclaw || []
  const tierDrawingModels = tierData.tierDrawing || []
  const tier2Count = (tierData.tier2 || []).length

  const host = c.req.header('host') || 'localhost:8787'
  const apiBase = `https://${host}/v1`
  const enabledProviders = providers.filter((provider) => provider.enabled)
  const allModelsCount = providers.reduce((total, provider) => total + provider.models.length, 0)
  const enabledModelsCount = enabledProviders.reduce((total, provider) => total + provider.models.filter((model) => model.enabled).length, 0)

  return c.html(`<!DOCTYPE html><html lang="zh-CN">
${H('首页')}
<body class="site-page home-page">
<header class="topbar">
  <div class="shell topbar__inner">
    <a class="brand" href="/" aria-label="AI Gateway 首页">
      <span class="brand__mark" aria-hidden="true"><i class="fas fa-cloud"></i></span>
      <span class="brand__name">${SITE_CONFIG.title}</span>
      <span class="brand__descriptor">API CONTROL PLANE</span>
    </a>
    <nav class="topbar__actions" id="topbar-actions" aria-label="主导航">
      ${isLoggedIn
        ? `<a href="/admin" class="btn btn-p"><i class="fas fa-sliders-h" aria-hidden="true"></i>管理控制台</a><a href="/admin/logout" class="btn btn-gh" onclick="localStorage.removeItem('admin_token')"><i class="fas fa-sign-out-alt" aria-hidden="true"></i>退出</a>`
        : `<a href="/admin/login" class="btn btn-p"><i class="fas fa-sign-in-alt" aria-hidden="true"></i>管理员登录</a>`
      }
    </nav>
  </div>
</header>

<main>
  <section class="shell home-hero" aria-labelledby="home-title">
    <div class="home-hero__copy">
      <p class="eyebrow"><span aria-hidden="true"></span>UNIFIED AI GATEWAY</p>
      <h1 id="home-title">一个 API，调用已配置的所有模型。</h1>
      <p class="home-hero__lede">统一的 OpenAI / Anthropic 兼容入口。模型按提供商归档，转发 Key、启用状态和故障转移集中管理。</p>
      <div class="endpoint-box" aria-label="API 接入地址">
        <span class="endpoint-box__label">BASE URL</span>
        <code>${escapePageHtml(apiBase)}</code>
        <button class="icon-btn copy-control" type="button" data-copy="${escapePageHtml(apiBase)}" aria-label="复制 API 地址">
          <i class="far fa-copy" aria-hidden="true"></i><span>复制</span>
        </button>
      </div>
      <p id="copy-status" class="sr-status" aria-live="polite"></p>
    </div>

    <figure class="request-panel" aria-labelledby="request-caption">
      <figcaption id="request-caption">
        <span>POST /chat/completions</span>
        <span class="protocol-state"><i aria-hidden="true"></i>OPENAI COMPATIBLE</span>
      </figcaption>
      <pre><code><span class="syntax-command">curl</span> ${escapePageHtml(apiBase)}/chat/completions \\
  <span class="syntax-key">-H</span> <span class="syntax-string">"Authorization: Bearer sk_cf_••••"</span> \\
  <span class="syntax-key">-H</span> <span class="syntax-string">"Content-Type: application/json"</span> \\
  <span class="syntax-key">-d</span> <span class="syntax-string">'{
    "model": "opencode/deepseek-v4-flash-free",
    "messages": [{ "role": "user", "content": "Hello" }]
  }'</span></code></pre>
      <div class="request-panel__foot">
        <span>模型格式</span>
        <code>provider/model</code>
      </div>
    </figure>
  </section>

  <section class="shell metrics-strip" aria-label="网关配置概览">
    <div class="metric"><span class="metric__value">${providers.length}</span><span class="metric__label">提供商总计</span></div>
    <div class="metric"><span class="metric__value">${enabledProviders.length}</span><span class="metric__label">已启用提供商</span></div>
    <div class="metric"><span class="metric__value">${allModelsCount}</span><span class="metric__label">模型总计</span></div>
    <div class="metric"><span class="metric__value">${tier1Models.length} / 9</span><span class="metric__label">第一梯队席位</span></div>
    <div class="metric"><span class="metric__value">${tierOpenclawModels.length} / 5</span><span class="metric__label">OpenClaw 席位</span></div>
    <div class="metric"><span class="metric__value">${tierDrawingModels.length} / 5</span><span class="metric__label">绘图池席位</span></div>
  </section>

  <section class="shell tier1-showcase" style="margin-top:2rem;margin-bottom:2rem;">
    <div class="section-heading" style="margin-bottom:1rem;">
      <div>
        <h2 style="font-size:1.35rem;font-weight:600;display:flex;align-items:center;gap:0.5rem;margin:0;">
          <i class="fas fa-layer-group" style="color:#2563eb;"></i>
          第一梯队 (Tier 1) 黄金模型池
          <span style="font-size:0.75rem;padding:0.2rem 0.5rem;background:#dbeafe;color:#1e40af;border-radius:9999px;font-weight:600;">9 席位固定</span>
        </h2>
        <p style="color:#64748b;margin-top:0.25rem;font-size:0.875rem;margin-bottom:0;">
          <code>auto/auto</code> 智能路由仅在第一梯队内匹配选优；当模型遭遇业务故障或连续失败时自动淘汰，并使用独立轻量探测从候选池（含 ${tier2Count} 个候选模型）海选补位。
        </p>
      </div>
    </div>

    <!-- Auto 调用示例卡片 -->
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:0.75rem;padding:1rem;margin-bottom:1.25rem;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;flex-wrap:wrap;gap:0.5rem;">
        <span style="font-weight:600;font-size:0.9rem;display:flex;align-items:center;gap:0.5rem;color:#0f172a;">
          <i class="fas fa-bolt" style="color:#eab308;"></i> 极简通用 Auto 智能调度：指定 model: "auto/auto" 或 "tier1"
        </span>
        <span style="font-size:0.75rem;color:#64748b;">9 席黄金池 · 毫秒级优选 · 自动健康补位</span>
      </div>
      <pre style="background:#0f172a;color:#f8fafc;padding:0.75rem 1rem;border-radius:0.5rem;overflow-x:auto;font-size:0.825rem;margin:0;line-height:1.5;"><code>curl ${escapePageHtml(apiBase)}/chat/completions \\
  -H "Authorization: Bearer sk_cf_••••" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "auto/auto",
    "messages": [{ "role": "user", "content": "Hello" }]
  }'</code></pre>
    </div>

    <!-- 第一梯队 9 个席位卡片 -->
    <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(300px, 1fr));gap:0.875rem;">
      ${Array.from({ length: 9 }).map((_, idx) => {
        const item = tier1Models[idx]
        if (item) {
          const probeStat = tierData.probeStats[item.fullId]
          const bStat = tierData.businessStats[item.fullId]
          const probeLatText = probeStat?.success ? `${probeStat.latency} ms` : '初始化海选'
          const busLatText = bStat && bStat.totalRequests > 0 ? `${bStat.avgLatency} ms (${bStat.totalRequests}次)` : '尚无真实业务'
          return `
          <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:0.625rem;padding:0.875rem;box-shadow:0 1px 2px rgba(0,0,0,0.03);">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.375rem;">
              <span style="font-size:0.7rem;font-weight:700;color:#1e40af;background:#dbeafe;padding:0.15rem 0.4rem;border-radius:0.25rem;">
                席位 #${idx + 1}
              </span>
              <span style="font-size:0.7rem;color:#15803d;font-weight:600;display:flex;align-items:center;gap:0.25rem;">
                <i class="fas fa-check-circle" style="font-size:0.65rem;"></i> 第一梯队
              </span>
            </div>
            <div style="font-weight:600;font-size:0.9rem;color:#0f172a;word-break:break-all;margin-bottom:0.375rem;font-family:monospace;">
              ${escapePageHtml(item.fullId)}
            </div>
            <div style="display:flex;gap:0.35rem;align-items:center;margin-bottom:0.5rem;flex-wrap:wrap;">
              <span style="font-size:0.65rem;background:#eff6ff;color:#1d4ed8;padding:0.1rem 0.35rem;border-radius:0.25rem;">
                ${escapePageHtml(probeStat?.category || '文本')}
              </span>
              ${probeStat?.openclawCompatible ? `
              <span style="font-size:0.65rem;background:#dcfce7;color:#15803d;padding:0.1rem 0.35rem;border-radius:0.25rem;font-weight:600;" title="${escapePageHtml(probeStat.openclawReason || '适合 OpenClaw 智能体')}">
                <i class="fas fa-bolt"></i> 适合 OpenClaw
              </span>` : ''}
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.375rem;font-size:0.75rem;background:#f8fafc;padding:0.375rem 0.5rem;border-radius:0.375rem;">
              <div>
                <div style="color:#64748b;font-size:0.65rem;">海选探测延迟</div>
                <div style="font-weight:600;color:#0369a1;">${probeLatText}</div>
              </div>
              <div>
                <div style="color:#64748b;font-size:0.65rem;">用户业务延迟</div>
                <div style="font-weight:600;color:#059669;">${busLatText}</div>
              </div>
            </div>
          </div>`
        } else {
          return `
          <div style="background:#f8fafc;border:1px dashed #cbd5e1;border-radius:0.625rem;padding:0.875rem;display:flex;flex-direction:column;justify-content:center;align-items:center;min-height:90px;">
            <span style="font-size:0.7rem;font-weight:600;color:#94a3b8;margin-bottom:0.2rem;">席位 #${idx + 1}</span>
            <span style="font-size:0.8rem;color:#64748b;display:flex;align-items:center;gap:0.375rem;">
              <i class="fas fa-clock" style="color:#94a3b8;"></i> 待选拔补位
            </span>
          </div>`
        }
      }).join('')}
    </div>
  </section>

  <!-- OpenClaw 专属梯队池展示区 -->
  <section class="shell openclaw-showcase" style="margin-top:2rem;margin-bottom:2rem;">
    <div class="section-heading" style="margin-bottom:1rem;">
      <div>
        <h2 style="font-size:1.35rem;font-weight:600;display:flex;align-items:center;gap:0.5rem;margin:0;">
          <i class="fas fa-robot" style="color:#8b5cf6;"></i>
          OpenClaw 专属梯队池 (OpenClaw Tier)
          <span style="font-size:0.75rem;padding:0.2rem 0.5rem;background:#ede9fe;color:#6d28d9;border-radius:9999px;font-weight:600;">5 席位固定</span>
        </h2>
        <p style="color:#64748b;margin-top:0.25rem;font-size:0.875rem;margin-bottom:0;">
          针对复杂 Agent、Function Calling 与智能体场景经过 Canary 探针验证的模型池。传入 <code>model: "openclaw/auto"</code> 或请求包含 <code>tools</code> 时自动调度。
        </p>
      </div>
    </div>

    <!-- OpenClaw 调用示例卡片 -->
    <div style="background:#fdf4ff;border:1px solid #f5d0fe;border-radius:0.75rem;padding:1rem;margin-bottom:1.25rem;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;flex-wrap:wrap;gap:0.5rem;">
        <span style="font-weight:600;font-size:0.9rem;display:flex;align-items:center;gap:0.5rem;color:#701a75;">
          <i class="fas fa-wand-magic-sparkles" style="color:#a855f7;"></i> OpenClaw 智能调度：指定 model: "openclaw/auto" 或携带 tools 自动触发
        </span>
        <span style="font-size:0.75rem;color:#86198f;">工具调用支持 · 智能体优选 · 自动补位</span>
      </div>
      <pre style="background:#1e1b4b;color:#f5d0fe;padding:0.75rem 1rem;border-radius:0.5rem;overflow-x:auto;font-size:0.825rem;margin:0;line-height:1.5;"><code>curl ${escapePageHtml(apiBase)}/chat/completions \\
  -H "Authorization: Bearer sk_cf_••••" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "openclaw/auto",
    "messages": [{ "role": "user", "content": "Fetch weather with tools" }],
    "tools": [{ "type": "function", "function": { "name": "get_weather" } }]
  }'</code></pre>
    </div>

    <!-- OpenClaw 5 个席位卡片 -->
    <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(300px, 1fr));gap:0.875rem;">
      ${Array.from({ length: 5 }).map((_, idx) => {
        const item = tierOpenclawModels[idx]
        if (item) {
          const probeStat = tierData.probeStats[item.fullId]
          const bStat = tierData.businessStats[item.fullId]
          const probeLatText = probeStat?.success ? `${probeStat.latency} ms` : '初始化海选'
          const busLatText = bStat && bStat.totalRequests > 0 ? `${bStat.avgLatency} ms (${bStat.totalRequests}次)` : '尚无真实业务'
          return `
          <div style="background:#ffffff;border:1px solid #f3e8ff;border-radius:0.625rem;padding:0.875rem;box-shadow:0 1px 2px rgba(139,92,246,0.05);">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.375rem;">
              <span style="font-size:0.7rem;font-weight:700;color:#6d28d9;background:#ede9fe;padding:0.15rem 0.4rem;border-radius:0.25rem;">
                OpenClaw 席位 #${idx + 1}
              </span>
              <span style="font-size:0.7rem;color:#7c3aed;font-weight:600;display:flex;align-items:center;gap:0.25rem;">
                <i class="fas fa-check-circle" style="font-size:0.65rem;"></i> 兼容智能体
              </span>
            </div>
            <div style="font-weight:600;font-size:0.9rem;color:#0f172a;word-break:break-all;margin-bottom:0.375rem;font-family:monospace;">
              ${escapePageHtml(item.fullId)}
            </div>
            <div style="display:flex;gap:0.35rem;align-items:center;margin-bottom:0.5rem;flex-wrap:wrap;">
              <span style="font-size:0.65rem;background:#fae8ff;color:#86198f;padding:0.1rem 0.35rem;border-radius:0.25rem;font-weight:600;">
                <i class="fas fa-bolt"></i> 适合 OpenClaw
              </span>
              <span style="font-size:0.65rem;background:#f1f5f9;color:#475569;padding:0.1rem 0.35rem;border-radius:0.25rem;">
                ${escapePageHtml(probeStat?.category || '文本')}
              </span>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.375rem;font-size:0.75rem;background:#faf5ff;padding:0.375rem 0.5rem;border-radius:0.375rem;">
              <div>
                <div style="color:#7e22ce;font-size:0.65rem;">探针延迟</div>
                <div style="font-weight:600;color:#6b21a8;">${probeLatText}</div>
              </div>
              <div>
                <div style="color:#64748b;font-size:0.65rem;">业务延迟</div>
                <div style="font-weight:600;color:#059669;">${busLatText}</div>
              </div>
            </div>
          </div>`
        } else {
          return `
          <div style="background:#faf5ff;border:1px dashed #d8b4fe;border-radius:0.625rem;padding:0.875rem;display:flex;flex-direction:column;justify-content:center;align-items:center;min-height:90px;">
            <span style="font-size:0.7rem;font-weight:600;color:#c084fc;margin-bottom:0.2rem;">OpenClaw 席位 #${idx + 1}</span>
            <span style="font-size:0.8rem;color:#9333ea;display:flex;align-items:center;gap:0.375rem;">
              <i class="fas fa-clock" style="color:#c084fc;"></i> 待适配模型补位
            </span>
          </div>`
        }
      }).join('')}
    </div>
  </section>

  <!-- 绘图专属梯队池展示区 -->
  <section class="shell drawing-showcase" style="margin-top:2rem;margin-bottom:2rem;">
    <div class="section-heading" style="margin-bottom:1rem;">
      <div>
        <h2 style="font-size:1.35rem;font-weight:600;display:flex;align-items:center;gap:0.5rem;margin:0;">
          <i class="fas fa-palette" style="color:#ec4899;"></i>
          绘图专属梯队池 (Drawing Tier)
          <span style="font-size:0.75rem;padding:0.2rem 0.5rem;background:#fce7f3;color:#be185d;border-radius:9999px;font-weight:600;">5 席位固定</span>
        </h2>
        <p style="color:#64748b;margin-top:0.25rem;font-size:0.875rem;margin-bottom:0;">
          专门收录 DALL-E、Flux、Stable Diffusion 与各类图像生成模型。传入 <code>model: "drawing/auto"</code> 或请求 <code>/v1/images/generations</code> 接口时自动调度。
        </p>
      </div>
    </div>

    <!-- 绘图调用示例卡片 -->
    <div style="background:#fff1f2;border:1px solid #fecdd3;border-radius:0.75rem;padding:1rem;margin-bottom:1.25rem;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;flex-wrap:wrap;gap:0.5rem;">
        <span style="font-weight:600;font-size:0.9rem;display:flex;align-items:center;gap:0.5rem;color:#881337;">
          <i class="fas fa-paint-brush" style="color:#f43f5e;"></i> 绘图模型智能调度：指定 model: "drawing/auto" 或访问图像生成接口
        </span>
        <span style="font-size:0.75rem;color:#9f1239;">图像模型优选 · 智能轮询 · 故障自愈</span>
      </div>
      <pre style="background:#26131c;color:#fecdd3;padding:0.75rem 1rem;border-radius:0.5rem;overflow-x:auto;font-size:0.825rem;margin:0;line-height:1.5;"><code>curl ${escapePageHtml(apiBase)}/images/generations \\
  -H "Authorization: Bearer sk_cf_••••" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "drawing/auto",
    "prompt": "A futuristic city in watercolor style"
  }'</code></pre>
    </div>

    <!-- 绘图 5 个席位卡片 -->
    <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(300px, 1fr));gap:0.875rem;">
      ${Array.from({ length: 5 }).map((_, idx) => {
        const item = tierDrawingModels[idx]
        if (item) {
          const probeStat = tierData.probeStats[item.fullId]
          const bStat = tierData.businessStats[item.fullId]
          const probeLatText = probeStat?.success ? `${probeStat.latency} ms` : '初始化海选'
          const busLatText = bStat && bStat.totalRequests > 0 ? `${bStat.avgLatency} ms (${bStat.totalRequests}次)` : '尚无真实业务'
          return `
          <div style="background:#ffffff;border:1px solid #ffe4e6;border-radius:0.625rem;padding:0.875rem;box-shadow:0 1px 2px rgba(236,72,153,0.05);">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.375rem;">
              <span style="font-size:0.7rem;font-weight:700;color:#be185d;background:#fce7f3;padding:0.15rem 0.4rem;border-radius:0.25rem;">
                绘图席位 #${idx + 1}
              </span>
              <span style="font-size:0.7rem;color:#e11d48;font-weight:600;display:flex;align-items:center;gap:0.25rem;">
                <i class="fas fa-check-circle" style="font-size:0.65rem;"></i> 绘图模型
              </span>
            </div>
            <div style="font-weight:600;font-size:0.9rem;color:#0f172a;word-break:break-all;margin-bottom:0.375rem;font-family:monospace;">
              ${escapePageHtml(item.fullId)}
            </div>
            <div style="display:flex;gap:0.35rem;align-items:center;margin-bottom:0.5rem;flex-wrap:wrap;">
              <span style="font-size:0.65rem;background:#ffe4e6;color:#be123c;padding:0.1rem 0.35rem;border-radius:0.25rem;font-weight:600;">
                <i class="fas fa-palette"></i> 绘图
              </span>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.375rem;font-size:0.75rem;background:#fff5f7;padding:0.375rem 0.5rem;border-radius:0.375rem;">
              <div>
                <div style="color:#be123c;font-size:0.65rem;">探针延迟</div>
                <div style="font-weight:600;color:#9f1239;">${probeLatText}</div>
              </div>
              <div>
                <div style="color:#64748b;font-size:0.65rem;">业务延迟</div>
                <div style="font-weight:600;color:#059669;">${busLatText}</div>
              </div>
            </div>
          </div>`
        } else {
          return `
          <div style="background:#fff5f7;border:1px dashed #fecdd3;border-radius:0.625rem;padding:0.875rem;display:flex;flex-direction:column;justify-content:center;align-items:center;min-height:90px;">
            <span style="font-size:0.7rem;font-weight:600;color:#fb7185;margin-bottom:0.2rem;">绘图席位 #${idx + 1}</span>
            <span style="font-size:0.8rem;color:#e11d48;display:flex;align-items:center;gap:0.375rem;">
              <i class="fas fa-clock" style="color:#fb7185;"></i> 待绘图模型补位
            </span>
          </div>`
        }
      }).join('')}
    </div>
  </section>

  <section class="shell directory" aria-labelledby="directory-title">
    <div class="directory-toolbar">
      <div class="directory-header">
        <h2 id="directory-title">模型列表</h2>
        <p>点击模型卡片或右侧复制按钮即可复制完整模型 ID (<code>provider_id/model_id</code>)</p>
      </div>

      <div class="directory-search-bar">
        <label class="search-field" for="model-search">
          <i class="fas fa-search" aria-hidden="true"></i>
          <span class="sr-only">搜索提供商或模型</span>
          <input id="model-search" type="search" placeholder="搜索模型名称或提供商 (例: qwen, deepseek, gemini...)" autocomplete="off">
        </label>
      </div>

      <div class="filter-chips" id="filter-chips">
        <button type="button" class="filter-chip is-active" data-status="all">
          <i class="fas fa-cubes" aria-hidden="true"></i> 全部 (<span id="cnt-all">0</span>)
        </button>
        <button type="button" class="filter-chip" data-status="ok">
          <i class="fas fa-check-circle" style="color:#16a34a;" aria-hidden="true"></i> 正常 (<span id="cnt-ok">0</span>)
        </button>
        <button type="button" class="filter-chip" data-status="cd">
          <i class="fas fa-hourglass-half" style="color:#d97706;" aria-hidden="true"></i> 冷却 (<span id="cnt-cd">0</span>)
        </button>
        <button type="button" class="filter-chip" data-status="err">
          <i class="fas fa-ban" style="color:#dc2626;" aria-hidden="true"></i> 失效 (<span id="cnt-err">0</span>)
        </button>
      </div>
    </div>

    <div class="provider-index" id="provider-index">
      ${enabledProviders.length ? enabledProviders.map((provider) => {
        const models = provider.models.filter((model) => model.enabled)
        let okCount = 0
        let cdCount = 0
        let errCount = 0

        models.forEach((m) => {
          const isPerm = !!m.permanentlyDisabled
          const isCd = typeof m.cooldownUntil === 'number' && Date.now() < m.cooldownUntil
          if (isPerm) errCount++
          else if (isCd) cdCount++
          else okCount++
        })

        const INITIAL_LIMIT = 12
        const hasMore = models.length > INITIAL_LIMIT

        return `<article class="provider-card" data-provider-id="${escapePageHtml(provider.id.toLowerCase())}" data-provider-name="${escapePageHtml(provider.name.toLowerCase())}">
          <div class="provider-card__header">
            <div class="provider-card__identity">
              <span class="provider-avatar" aria-hidden="true">${escapePageHtml((provider.name.charAt(0) || 'A').toUpperCase())}</span>
              <div>
                <div class="provider-card__title">
                  <h3>${escapePageHtml(provider.name)}</h3>
                  <code class="provider-id-badge">${escapePageHtml(provider.id)}</code>
                  <span class="protocol-chip">${(provider.apiType || 'openai') === 'anthropic' ? 'Anthropic' : 'OpenAI'} 兼容</span>
                </div>
                <div class="provider-card__meta">
                  <span class="meta-tag">共 ${models.length} 个模型</span>
                  ${okCount > 0 ? `<span class="meta-tag meta-tag--ok"><i class="fas fa-check-circle" aria-hidden="true"></i> ${okCount} 正常</span>` : ''}
                  ${cdCount > 0 ? `<span class="meta-tag meta-tag--cd"><i class="fas fa-hourglass-half" aria-hidden="true"></i> ${cdCount} 冷却</span>` : ''}
                  ${errCount > 0 ? `<span class="meta-tag meta-tag--err"><i class="fas fa-ban" aria-hidden="true"></i> ${errCount} 失效</span>` : ''}
                </div>
              </div>
            </div>
          </div>

          <div class="provider-card__body">
            ${models.length ? `
              <div class="models-grid" id="grid-${escapePageHtml(provider.id)}">
                ${models.map((model, idx) => {
                  const fullModel = `${provider.id}/${model.id}`
                  const isPermDisabled = !!model.permanentlyDisabled
                  const isCooldown = typeof model.cooldownUntil === 'number' && Date.now() < model.cooldownUntil
                  const cooldownSec = isCooldown && typeof model.cooldownUntil === 'number' ? Math.ceil((model.cooldownUntil - Date.now()) / 1000) : 0
                  
                  let statusKey = 'ok'
                  let statusBadgeHtml = ''
                  if (isPermDisabled) {
                    statusKey = 'err'
                    statusBadgeHtml = `<span class="m-badge m-badge--err" title="${escapePageHtml(model.disabledReason || '永久失效')}"><i class="fas fa-ban" aria-hidden="true"></i>失效</span>`
                  } else if (isCooldown) {
                    statusKey = 'cd'
                    statusBadgeHtml = `<span class="m-badge m-badge--cd" title="冷却中"><i class="fas fa-hourglass-half" aria-hidden="true"></i>冷却(${cooldownSec}s)</span>`
                  } else {
                    statusKey = 'ok'
                    statusBadgeHtml = `<span class="m-badge m-badge--ok"><i class="fas fa-check-circle" aria-hidden="true"></i>正常</span>`
                  }

                  let categoryBadgeHtml = ''
                  const cat = model.category || '文本'
                  if (cat === '绘图') {
                    categoryBadgeHtml = `<span class="m-badge" style="background:#fef3c7;color:#b45309;font-size:0.65rem;border:none;"><i class="fas fa-image"></i> 绘图</span>`
                  } else if (cat === '嵌入') {
                    categoryBadgeHtml = `<span class="m-badge" style="background:#f3e8ff;color:#7e22ce;font-size:0.65rem;border:none;"><i class="fas fa-cube"></i> 嵌入</span>`
                  } else {
                    categoryBadgeHtml = `<span class="m-badge" style="background:#eff6ff;color:#1d4ed8;font-size:0.65rem;border:none;"><i class="fas fa-comment-alt"></i> 文本</span>`
                  }

                  let openclawBadgeHtml = ''
                  if (model.openclawTested) {
                    if (model.openclawCompatible) {
                      openclawBadgeHtml = `<span class="m-badge" style="background:#dcfce7;color:#15803d;font-size:0.65rem;border:none;" title="${escapePageHtml(model.openclawReason || '适合 OpenClaw 智能体')}"><i class="fas fa-bolt"></i> OpenClaw</span>`
                    } else {
                      openclawBadgeHtml = `<span class="m-badge" style="background:#f1f5f9;color:#64748b;font-size:0.65rem;border:none;" title="${escapePageHtml(model.openclawReason || '不兼容 OpenClaw 工具调用')}"><i class="fas fa-ban"></i> 非OpenClaw</span>`
                    }
                  }

                  const isHiddenInitially = idx >= INITIAL_LIMIT ? 'is-collapsed' : ''

                  return `<div class="model-card copy-control ${isHiddenInitially}" 
                               data-copy="${escapePageHtml(fullModel)}" 
                               data-model-id="${escapePageHtml(model.id.toLowerCase())}" 
                               data-full-id="${escapePageHtml(fullModel.toLowerCase())}"
                               data-status="${statusKey}"
                               data-index="${idx}">
                    <div class="model-card__info">
                      <code class="model-card__name" title="点击复制完整ID: ${escapePageHtml(fullModel)}">${escapePageHtml(model.id)}</code>
                      <div style="display:flex;align-items:center;gap:0.25rem;flex-wrap:wrap;margin-top:0.25rem;">
                        ${categoryBadgeHtml}
                        ${openclawBadgeHtml}
                        ${statusBadgeHtml}
                      </div>
                    </div>
                    <button class="model-card__copy-btn" type="button" aria-label="复制 ${escapePageHtml(fullModel)}">
                      <i class="far fa-copy" aria-hidden="true"></i>
                    </button>
                  </div>`
                }).join('')}
              </div>

              ${hasMore ? `
                <div class="provider-card__footer">
                  <button type="button" class="btn-expand-models" data-provider="${escapePageHtml(provider.id)}" data-total="${models.length}">
                    <i class="fas fa-chevron-down" aria-hidden="true"></i> 展开剩余 ${models.length - INITIAL_LIMIT} 个模型
                  </button>
                </div>
              ` : ''}
            ` : '<div class="empty-inline">暂无启用模型</div>'}
          </div>
        </article>`
      }).join('') : `<div class="empty-state"><i class="fas fa-cubes" aria-hidden="true"></i><h3>尚无可用模型</h3><p>管理员启用提供商和模型后，它们会出现在这里。</p>${isLoggedIn ? '<a class="btn btn-p" href="/admin">前往管理控制台</a>' : ''}</div>`}
    </div>
    <div id="search-empty" class="empty-state hd">
      <i class="fas fa-search" aria-hidden="true"></i>
      <h3>没有匹配的模型</h3>
      <p>尝试更短或更通用的关键字，或清除筛选条件。</p>
      <button type="button" class="btn btn-s" style="margin-top:0.5rem;" onclick="resetSearch()"><i class="fas fa-redo" aria-hidden="true"></i> 清除筛选与搜索</button>
    </div>
  </section>
</main>

${renderSiteFooter(SITE_CONFIG.title)}

<script>
(function () {
  var savedToken = localStorage.getItem('admin_token');
  if (savedToken) {
    if (!document.cookie.includes('session_id=')) {
      document.cookie = "session_id=" + savedToken + "; path=/; max-age=86400; SameSite=None; Secure";
    }
  }
  // 异步探测会话是否有效，失效则立刻跳往登录页
  fetch('/admin/api/auth-check')
    .then(function(res) { return res.json(); })
    .then(function(data) {
      if (!data || !data.loggedIn) {
        localStorage.removeItem('admin_token');
        document.cookie = "session_id=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=None; Secure";
        window.location.href = '/admin/login';
      }
    })
    .catch(function() {});

  // 复制控制
  var copyStatus = document.getElementById('copy-status');
  document.querySelectorAll('.copy-control').forEach(function (card) {
    card.addEventListener('click', async function (e) {
      e.stopPropagation();
      var text = card.getAttribute('data-copy') || '';
      var icon = card.querySelector('.model-card__copy-btn i') || card.querySelector('i');
      try {
        await navigator.clipboard.writeText(text);
        card.setAttribute('data-state', 'success');
        if (icon) icon.className = 'fas fa-check';
        if (copyStatus) copyStatus.textContent = '已复制 ' + text;
        window.setTimeout(function () {
          card.removeAttribute('data-state');
          if (icon) icon.className = 'far fa-copy';
        }, 1800);
      } catch (error) {
        card.setAttribute('data-state', 'error');
        if (copyStatus) copyStatus.textContent = '复制失败，请手动复制。';
      }
    });
  });

  // 展开 / 折叠模型控制
  document.querySelectorAll('.btn-expand-models').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var total = parseInt(btn.getAttribute('data-total') || '0', 10);
      var card = btn.closest('.provider-card');
      if (!card) return;
      var isExpanded = card.classList.contains('is-expanded');
      if (isExpanded) {
        card.classList.remove('is-expanded');
        btn.innerHTML = '<i class="fas fa-chevron-down" aria-hidden="true"></i> 展开剩余 ' + (total - 12) + ' 个模型';
      } else {
        card.classList.add('is-expanded');
        btn.innerHTML = '<i class="fas fa-chevron-up" aria-hidden="true"></i> 折叠模型列表';
      }
    });
  });

  // 统计计算与实时搜索 / 状态过滤
  var searchInput = document.getElementById('model-search');
  var filterChips = document.querySelectorAll('.filter-chip');
  var providerCards = Array.from(document.querySelectorAll('.provider-card'));
  var emptyState = document.getElementById('search-empty');

  var activeStatus = 'all';

  function updateCounts() {
    var cntAll = 0, cntOk = 0, cntCd = 0, cntErr = 0;
    document.querySelectorAll('.model-card').forEach(function (m) {
      cntAll++;
      var st = m.getAttribute('data-status');
      if (st === 'ok') cntOk++;
      else if (st === 'cd') cntCd++;
      else if (st === 'err') cntErr++;
    });

    var elAll = document.getElementById('cnt-all'); if (elAll) elAll.textContent = cntAll;
    var elOk = document.getElementById('cnt-ok'); if (elOk) elOk.textContent = cntOk;
    var elCd = document.getElementById('cnt-cd'); if (elCd) elCd.textContent = cntCd;
    var elErr = document.getElementById('cnt-err'); if (elErr) elErr.textContent = cntErr;
  }

  function applyFilters() {
    var query = (searchInput ? searchInput.value : '').trim().toLowerCase();
    var isSearching = query.length > 0 || activeStatus !== 'all';

    var totalVisibleModels = 0;

    providerCards.forEach(function (pCard) {
      var pName = pCard.getAttribute('data-provider-name') || '';
      var pId = pCard.getAttribute('data-provider-id') || '';
      var modelCards = Array.from(pCard.querySelectorAll('.model-card'));

      if (isSearching) {
        pCard.classList.add('is-searching');
      } else {
        pCard.classList.remove('is-searching');
      }

      var visibleInProvider = 0;

      modelCards.forEach(function (mCard) {
        var mId = mCard.getAttribute('data-model-id') || '';
        var fId = mCard.getAttribute('data-full-id') || '';
        var st = mCard.getAttribute('data-status') || '';

        var matchesSearch = !query || pName.includes(query) || pId.includes(query) || mId.includes(query) || fId.includes(query);
        var matchesStatus = activeStatus === 'all' || st === activeStatus;

        var isVisible = matchesSearch && matchesStatus;
        mCard.classList.toggle('hd', !isVisible);

        if (isVisible) {
          visibleInProvider++;
          totalVisibleModels++;
        }
      });

      pCard.classList.toggle('hd', visibleInProvider === 0);
    });

    if (emptyState) {
      emptyState.classList.toggle('hd', totalVisibleModels > 0 || (!query && activeStatus === 'all'));
    }
  }

  window.resetSearch = function() {
    if (searchInput) searchInput.value = '';
    activeStatus = 'all';
    filterChips.forEach(function(chip) {
      chip.classList.toggle('is-active', chip.getAttribute('data-status') === 'all');
    });
    applyFilters();
  };

  if (searchInput) {
    searchInput.addEventListener('input', applyFilters);
  }

  filterChips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      filterChips.forEach(function (c) { c.classList.remove('is-active'); });
      chip.classList.add('is-active');
      activeStatus = chip.getAttribute('data-status') || 'all';
      applyFilters();
    });
  });

  updateCounts();
})()
</script>
</body></html>`)
}

// ===== 登录页 =====

export async function renderLoginPage(c: Context<{ Bindings: Env }>) {
  return c.html(`<!DOCTYPE html><html lang="zh-CN">
${H('登录')}
<body class="site-page auth-page">
<header class="topbar topbar--auth">
  <div class="shell topbar__inner">
    <div class="brand" aria-label="AI Gateway 访问控制">
      <span class="brand__mark" aria-hidden="true"><i class="fas fa-cloud"></i></span>
      <span class="brand__name">${SITE_CONFIG.title}</span>
      <span class="brand__descriptor">CONTROL PLANE</span>
    </div>
  </div>
</header>

<main class="auth-shell">
  <section class="auth-context" aria-labelledby="auth-context-title">
    <p class="eyebrow"><span aria-hidden="true"></span>CONTROL PLANE ACCESS</p>
    <h1 id="auth-context-title">管理提供商、模型和转发密钥。</h1>
  </section>

  <section class="auth-form-wrap" aria-labelledby="login-title">
    <form class="auth-form" id="login-form" novalidate>
      <div class="auth-form__heading">
        <span class="auth-form__icon" aria-hidden="true"><i class="fas fa-lock"></i></span>
        <div><h2 id="login-title">管理员登录</h2><p>使用部署时配置的账号继续。</p></div>
      </div>

      <div id="er" class="al al-e hd" role="alert" aria-live="assertive">
        <i class="fas fa-exclamation-circle" aria-hidden="true"></i><span id="em"></span>
      </div>

      <div class="fg">
        <label for="u">用户名</label>
        <div class="input-wrap"><i class="far fa-user" aria-hidden="true"></i><input type="text" id="u" name="username" placeholder="admin" autocomplete="username" aria-required="true" aria-describedby="login-helper"></div>
      </div>
      <div class="fg">
        <label for="p">密码</label>
        <div class="input-wrap"><i class="fas fa-key" aria-hidden="true"></i><input type="password" id="p" name="password" placeholder="admin123" autocomplete="current-password" aria-required="true" aria-describedby="login-helper"><button class="password-toggle" id="password-toggle" type="button" aria-label="显示密码"><i class="far fa-eye" aria-hidden="true"></i></button></div>
      </div>
      <p id="login-helper" class="form-helper">默认账号：admin / admin123（或环境变量中配置的凭据）。</p>
      <button class="btn btn-p btn-submit" id="login-button" type="submit"><span class="button-label"><i class="fas fa-sign-in-alt" aria-hidden="true"></i>登录管理控制台</span><span class="button-loading"><i class="fas fa-circle-notch fa-spin" aria-hidden="true"></i>正在验证</span></button>
    </form>
  </section>
</main>

<script>
(function () {
  var form = document.getElementById('login-form')
  var username = document.getElementById('u')
  var password = document.getElementById('p')
  var errorBox = document.getElementById('er')
  var errorMessage = document.getElementById('em')
  var submit = document.getElementById('login-button')
  var toggle = document.getElementById('password-toggle')

  function showError(message) {
    errorMessage.textContent = message
    errorBox.classList.remove('hd')
    username.setAttribute('aria-invalid', 'true')
    password.setAttribute('aria-invalid', 'true')
  }
  function clearError() {
    errorBox.classList.add('hd')
    username.removeAttribute('aria-invalid')
    password.removeAttribute('aria-invalid')
  }

  toggle.addEventListener('click', function () {
    var show = password.type === 'password'
    password.type = show ? 'text' : 'password'
    toggle.setAttribute('aria-label', show ? '隐藏密码' : '显示密码')
    toggle.querySelector('i').className = show ? 'far fa-eye-slash' : 'far fa-eye'
    password.focus({ preventScroll: true })
  })

  form.addEventListener('submit', async function (event) {
    event.preventDefault()
    clearError()
    var u = username.value.trim()
    var p = password.value
    if (!u || !p) {
      showError('请填写用户名和密码后再登录。')
      ;(!u ? username : password).focus()
      return
    }
    submit.disabled = true
    submit.setAttribute('data-state', 'loading')
    try {
      var response = await fetch('/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: p })
      })
      var data = await response.json()
      if (data.success) {
        submit.setAttribute('data-state', 'success')
        if (data.token) {
          localStorage.setItem('admin_token', data.token)
          document.cookie = "session_id=" + data.token + "; path=/; max-age=86400; SameSite=None; Secure"
        }
        window.location.href = data.redirectUrl || ('/admin?token=' + (data.token || ''))
        return
      }
      showError(data.message || '登录失败，请检查账号配置。')
    } catch (error) {
      showError('无法连接服务，请检查网络后重试。')
    }
    submit.disabled = false
    submit.removeAttribute('data-state')
  })
})()
</script>
</body></html>`)
}

// ===== 管理后台 =====

export async function renderAdminPage(c: Context<{ Bindings: Env }>) {
  const providers = await getProviders(c.env)
  const proxyKeys = await getProxyKeys(c.env)
  const logs = await getLogs(c.env)
  const logConfig = await getLogConfig(c.env)
  const customRoutes = await getCustomModelRoutes(c.env)
  const isDebug = logConfig.debugMode
  const enabledProvidersCount = providers.filter((provider) => provider.enabled).length
  const modelsCount = providers.reduce((total, provider) => total + provider.models.length, 0)
  const enabledModelsCount = providers.reduce((total, provider) => total + provider.models.filter((model) => model.enabled).length, 0)
  const enabledProxyKeysCount = proxyKeys.filter((key) => key.enabled).length

  return c.html(`<!DOCTYPE html><html lang="zh-CN">
${H('管理')}
<body class="site-page admin-page">
<div class="admin-shell">
  <aside class="admin-rail" aria-label="控制台导航">
    <a class="brand admin-rail__brand" href="/">
      <span class="brand__mark" aria-hidden="true"><i class="fas fa-cloud"></i></span>
      <span><strong>${SITE_CONFIG.title}</strong><small>CONTROL PLANE</small></span>
    </a>
    <nav class="admin-nav">
      <a class="admin-nav__link is-active" href="#overview"><i class="fas fa-chart-pie" aria-hidden="true"></i><span>概览</span></a>
      <a class="admin-nav__link" href="#providers"><i class="fas fa-server" aria-hidden="true"></i><span>提供商</span><b>${providers.length}</b></a>
      <a class="admin-nav__link" href="#custom-routes"><i class="fas fa-route" aria-hidden="true"></i><span>指定模型路由</span><b id="custom-routes-count-badge">${customRoutes.length}</b></a>
      <a class="admin-nav__link" href="#proxy-keys"><i class="fas fa-key" aria-hidden="true"></i><span>转发 Key</span><b>${proxyKeys.length}</b></a>
      <a class="admin-nav__link" href="#logs"><i class="fas fa-list-alt" aria-hidden="true"></i><span>请求日志</span><b id="logs-count-badge">${logs.length}</b></a>
    </nav>
    <div class="admin-rail__foot">
      <div class="rail-save-box" id="save-bar">
        <span id="save-status-badge" class="badge-status badge-synced save-status-badge">
          <i class="fas fa-check-circle" aria-hidden="true"></i> 配置已同步 KV
        </span>
        <button id="btn-save-all" class="btn-save-all" onclick="saveAllConfig()">
          <i class="fas fa-save" aria-hidden="true"></i> 统一保存
        </button>
      </div>
      <a href="/" class="admin-nav__link"><i class="fas fa-arrow-left" aria-hidden="true"></i><span>返回首页</span></a>
      <a href="/admin/logout" class="admin-nav__link" onclick="localStorage.removeItem('admin_token')"><i class="fas fa-sign-out-alt" aria-hidden="true"></i><span>退出登录</span></a>
    </div>
  </aside>

  <div class="admin-main">
    <header class="admin-topbar">
      <a class="brand" href="/"><span class="brand__mark" aria-hidden="true"><i class="fas fa-cloud"></i></span><span class="brand__name">${SITE_CONFIG.title}</span></a>
      <nav aria-label="移动端控制台导航"><a href="#overview">概览</a><a href="#providers">提供商</a><a href="#custom-routes">指定路由</a><a href="#proxy-keys">Key</a><a href="#logs">日志</a></nav>
      <button class="btn-save-all btn-save-mobile" onclick="saveAllConfig()"><i class="fas fa-save" aria-hidden="true"></i> 保存</button>
      <a class="icon-btn" href="/admin/logout" onclick="localStorage.removeItem('admin_token')" aria-label="退出登录"><i class="fas fa-sign-out-alt" aria-hidden="true"></i></a>
    </header>

    <main class="admin-content">
      <div id="toast" class="hd toast" role="status" aria-live="polite"></div>

      <section id="overview" class="admin-overview" aria-labelledby="admin-title">
        <div class="admin-heading">
          <div class="admin-heading__title">
            <p class="eyebrow"><span aria-hidden="true"></span>GATEWAY STATUS</p>
            <h1 id="admin-title">管理控制台</h1>
            <p>配置提供商、模型与客户端访问凭据。变更将写入 Cloudflare KV。</p>
          </div>
          <div class="admin-heading__actions">
            <button id="btn-probe" class="btn btn-p btn-s" onclick="triggerProbe()"><i class="fas fa-radar" aria-hidden="true"></i>触发探测任务</button>
            <button class="btn btn-s" onclick="testAllBlockedModels()"><i class="fas fa-unlock-alt" aria-hidden="true"></i>批量复测封禁</button>
            <button class="btn btn-s" onclick="resetAllModels()"><i class="fas fa-sync-alt" aria-hidden="true"></i>一键重置所有模型</button>
            <a href="/" class="btn btn-gh btn-s"><i class="fas fa-external-link-alt" aria-hidden="true"></i>查看模型列表</a>
          </div>
        </div>
        <div class="admin-metrics" aria-label="配置统计">
          <div><span>${providers.length}</span><p>提供商</p><small>${enabledProvidersCount} 个已启用</small></div>
          <div><span>${modelsCount}</span><p>模型</p><small>${enabledModelsCount} 个可用</small></div>
          <div><span>${proxyKeys.length}</span><p>转发 Key</p><small>${enabledProxyKeysCount} 个可用</small></div>
          <div><span class="status-dot status-dot--online"><i aria-hidden="true"></i>已配置</span><p>存储</p><small>Cloudflare KV</small></div>
        </div>
      </section>

      <section id="providers" class="workspace-section" aria-labelledby="providers-title">
        <div class="section-heading section-heading--admin">
          <div><h2 id="providers-title">提供商</h2><p>管理上游地址、协议、API Key 和模型。</p></div>
          <button class="btn btn-p" onclick="showAdd()"><i class="fas fa-plus" aria-hidden="true"></i>添加提供商</button>
        </div>

        <div class="af-w">
          <div id="af" class="hd add-form-panel">
            <div class="panel-heading"><div><span class="panel-heading__mark"><i class="fas fa-plus" aria-hidden="true"></i></span><div><h3>添加新提供商</h3><p>先配置基本信息，再测试 Key 与模型连接。</p></div></div><button class="icon-btn" type="button" onclick="hideAdd()" aria-label="关闭添加表单"><i class="fas fa-times" aria-hidden="true"></i></button></div>
            <div class="fr">
              <div class="fg"><label for="anm">名称</label><input type="text" id="anm" placeholder="DeepSeek"></div>
              <div class="fg"><label for="aid">提供商 ID</label><input type="text" id="aid" placeholder="deepseek"><span class="form-helper">用于模型前缀，创建后不可修改。</span></div>
            </div>
            <div class="fg"><label for="aurl">API 地址</label><input type="url" id="aurl" placeholder="https://api.deepseek.com"></div>
            <div class="fg"><label for="afmt">API 格式</label><select id="afmt" class="select-sm"><option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic 兼容</option></select></div>
            <fieldset class="form-group"><legend>上游 API Keys</legend><div id="akeys"><div class="fc mb-4 field-row"><input type="text" placeholder="sk-xxx" class="fx1 aki" aria-label="上游 API Key"><label class="tg" title="启用 Key"><input type="checkbox" checked class="ake" aria-label="启用 Key"><span class="sl"></span></label><button class="icon-btn" onclick="copyRowVal(this)" title="复制 Key" aria-label="复制 Key"><i class="far fa-copy" aria-hidden="true"></i></button><button class="icon-btn" onclick="testNewAKey(this)" title="测试 Key" aria-label="测试 Key"><i class="fas fa-plug" aria-hidden="true"></i></button><button class="icon-btn" onclick="this.parentElement.remove()" title="移除 Key" aria-label="移除 Key"><i class="fas fa-times" aria-hidden="true"></i></button></div></div><button class="btn btn-s btn-xs" onclick="addAKeyRow()"><i class="fas fa-plus" aria-hidden="true"></i>添加 Key</button></fieldset>
            <aside id="amc" class="hd mdl-list-panel"><div class="panel-heading"><div><span class="panel-heading__mark"><i class="fas fa-cube" aria-hidden="true"></i></span><div><h3>可用模型</h3><p>点击“+”单条添加，或使用一键导入。</p></div></div><div class="fc" style="gap:var(--space-2xs);"><button class="btn btn-s btn-xs" onclick="importAllNewModels()" style="margin-right:8px;"><i class="fas fa-file-import" aria-hidden="true"></i> 一键导入</button><button class="icon-btn" type="button" onclick="hideMdlPanel('amc')" title="关闭可用模型" aria-label="关闭可用模型"><i class="fas fa-times" aria-hidden="true"></i></button></div></div><div id="amcl"></div></aside>
            <fieldset class="form-group"><legend>模型 ID</legend><div id="amodels"><div class="fc mb-4 field-row"><input type="text" placeholder="deepseek-chat" class="fx1 ami" aria-label="模型 ID"><label class="tg" title="启用模型"><input type="checkbox" checked class="ame" aria-label="启用模型"><span class="sl"></span></label><button class="icon-btn" onclick="testNewMdl(this)" title="测试模型" aria-label="测试模型"><i class="fas fa-plug" aria-hidden="true"></i></button><button class="icon-btn" onclick="this.parentElement.remove()" title="移除模型" aria-label="移除模型"><i class="fas fa-times" aria-hidden="true"></i></button></div></div><div class="fc mt-1 field-row"><button class="btn btn-s btn-xs" onclick="addMdlRow()"><i class="fas fa-plus" aria-hidden="true"></i>添加模型</button><button class="btn btn-s btn-xs btn-d" onclick="clearAllNewModels()" style="margin-left:8px;"><i class="fas fa-trash" aria-hidden="true"></i>一键删除所有模型</button></div></fieldset>
            <div class="panel-actions"><label class="switch-label"><span>创建后立即启用</span><span class="tg"><input type="checkbox" checked id="aen"><span class="sl"></span></span></label><div><button class="btn btn-s" onclick="hideAdd()">取消</button><button class="btn btn-p" onclick="createProv()"><i class="fas fa-plus" aria-hidden="true"></i>暂存并添加</button></div></div>
            <div id="atestR" class="mt-1" aria-live="polite"></div>
          </div>
        </div>

        <div class="gp provider-list" id="plist">
          ${providers.length ? providers.map(p=>{
            let pStatusClass = '';
            if (!p.models || p.models.length === 0) {
              pStatusClass = 'pi-red';
            } else {
              const allDisabled = p.models.every((m: any) => m.enabled === false || m.permanentlyDisabled);
              if (allDisabled) {
                pStatusClass = 'pi-red';
              } else {
                const hasAbnormal = p.models.some((m: any) => m.enabled === false || m.permanentlyDisabled || (m.cooldownUntil && Date.now() < m.cooldownUntil));
                if (hasAbnormal) {
                  pStatusClass = 'pi-yellow';
                }
              }
            }
            let statusChipsHtml = '';
            let permCount = 0;
            let cooldownCount = 0;
            let warningCount = 0;
            let disabledCount = 0;

            (p.models || []).forEach((m) => {
              const isPermDisabled = !!m.permanentlyDisabled;
              const isCooldown = typeof m.cooldownUntil === 'number' && Date.now() < m.cooldownUntil;
              const failCount = m.failureCount || 0;

              if (isPermDisabled) permCount++;
              else if (isCooldown) cooldownCount++;
              else if (failCount > 0) warningCount++;
              else if (m.enabled === false) disabledCount++;
            });

            if (permCount > 0) {
              statusChipsHtml += `<span class="abnormal-model-chip" style="background:#fee2e2;color:#b91c1c;border:1px solid #fca5a5;padding:1px 5px;font-size:10px;border-radius:4px;margin-left:4px;font-weight:600;display:inline-flex;align-items:center;gap:2px;" title="${permCount} 个模型永久失效"><i class="fas fa-ban" style="font-size:9px;"></i>${permCount} 永久失效</span>`;
            }
            if (cooldownCount > 0) {
              statusChipsHtml += `<span class="abnormal-model-chip" style="background:#fef9c3;color:#854d0e;border:1px solid #fef08a;padding:1px 5px;font-size:10px;border-radius:4px;margin-left:4px;font-weight:600;display:inline-flex;align-items:center;gap:2px;" title="${cooldownCount} 个模型冷却中"><i class="fas fa-hourglass-half" style="font-size:9px;"></i>${cooldownCount} 冷却中</span>`;
            }
            if (warningCount > 0) {
              statusChipsHtml += `<span class="abnormal-model-chip" style="background:#ffedd5;color:#c2410c;border:1px solid #fed7aa;padding:1px 5px;font-size:10px;border-radius:4px;margin-left:4px;font-weight:600;display:inline-flex;align-items:center;gap:2px;" title="${warningCount} 个模型存在失败警告"><i class="fas fa-exclamation-triangle" style="font-size:9px;"></i>${warningCount} 警告</span>`;
            }
            if (disabledCount > 0) {
              statusChipsHtml += `<span class="abnormal-model-chip" style="background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;padding:1px 5px;font-size:10px;border-radius:4px;margin-left:4px;font-weight:600;display:inline-flex;align-items:center;gap:2px;text-decoration:line-through;" title="${disabledCount} 个模型已手动禁用"><i class="fas fa-minus-circle" style="font-size:9px;"></i>${disabledCount} 禁用</span>`;
            }

            return `
          <article class="pi ${pStatusClass}" data-id="${escapePageHtml(p.id)}">
            <div class="ps" onclick="togBtn(this)" data-pid="${escapePageHtml(p.id)}" role="button" tabindex="0" onkeydown="togKey(event,this)" aria-controls="dt-${escapePageHtml(p.id)}">
              <div class="l"><i class="fas fa-chevron-right provider-chevron" aria-hidden="true" id="ch-${escapePageHtml(p.id)}"></i><span class="provider-avatar" aria-hidden="true">${escapePageHtml(p.name.charAt(0).toUpperCase() || 'A')}</span><div><h3>${escapePageHtml(p.name)}</h3><div class="pu"><code>${escapePageHtml(p.id)}</code><span>${(p.apiType||'openai')==='anthropic'?'Anthropic':'OpenAI'}</span><span>${p.apiKeys.length} Keys</span><span>${p.models.length} 模型</span>${statusChipsHtml}</div></div></div>
              <div class="fc fx-s0" onclick="event.stopPropagation()"><label class="tg"><input type="checkbox" ${p.enabled?'checked':''} id="en-${escapePageHtml(p.id)}" onchange="togglePbBtn(this)" data-pid="${escapePageHtml(p.id)}" aria-label="启用 ${escapePageHtml(p.name)}"><span class="sl"></span></label><span class="bd ${p.enabled?'bd-on':'bd-off'}">${p.enabled?'已启用':'未启用'}</span></div>
            </div>
            <div class="pd" id="dt-${escapePageHtml(p.id)}">
              <div class="detail-heading"><div><h3>编辑 ${escapePageHtml(p.name)}</h3><p>修改暂存在内存中，点击顶部【统一保存】或下方【暂存更改】后生效。</p></div><span class="protocol-chip">${(p.apiType||'openai')==='anthropic'?'ANTHROPIC':'OPENAI'}</span></div>
              <div class="fr"><div class="fg"><label>名称</label><input type="text" id="nm-${escapePageHtml(p.id)}" value="${escapePageHtml(p.name)}"></div><div class="fg"><label>ID</label><input type="text" value="${escapePageHtml(p.id)}" disabled></div></div>
              <div class="fg"><label>API 地址</label><input type="url" id="url-${escapePageHtml(p.id)}" value="${escapePageHtml(p.baseUrl)}"></div>
              <div class="fg"><label>API 格式</label><select id="at-${escapePageHtml(p.id)}" class="select-sm"><option value="openai" ${(p.apiType||'openai')!=='anthropic'?'selected':''}>OpenAI 兼容</option><option value="anthropic" ${(p.apiType||'openai')==='anthropic'?'selected':''}>Anthropic 兼容</option></select></div>
              <fieldset class="form-group"><legend>上游 API Keys</legend><div id="keys-${escapePageHtml(p.id)}">${p.apiKeys.map((k,ki)=>`<div class="fc mb-3 field-row" data-kidx="${ki}"><input type="text" value="${escapePageHtml(k.key)}" class="fx1" id="k-${escapePageHtml(p.id)}-${ki}" placeholder="API Key" aria-label="API Key"><label class="tg"><input type="checkbox" ${k.enabled?'checked':''} id="ken-${escapePageHtml(p.id)}-${ki}" aria-label="启用 Key"><span class="sl"></span></label><button class="icon-btn" onclick="copyRowVal(this)" title="复制 Key" aria-label="复制 Key"><i class="far fa-copy" aria-hidden="true"></i></button><button class="icon-btn" onclick="testKeyRowBtn(this)" data-pid="${escapePageHtml(p.id)}" data-kidx="${ki}" title="测试 Key" aria-label="测试 Key"><i class="fas fa-plug" aria-hidden="true"></i></button><button class="icon-btn" onclick="rmKeyRowBtn(this)" data-pid="${escapePageHtml(p.id)}" data-kidx="${ki}" title="移除 Key" aria-label="移除 Key"><i class="fas fa-times" aria-hidden="true"></i></button></div>`).join('')}</div><div class="fc mt-1 field-row"><input type="text" id="nk-${escapePageHtml(p.id)}" placeholder="新的 API Key" class="fx1"><button class="btn btn-s btn-xs" onclick="addKeyRowBtn(this)" data-pid="${escapePageHtml(p.id)}"><i class="fas fa-plus" aria-hidden="true"></i>添加</button></div></fieldset>
              <fieldset class="form-group"><legend>模型</legend>
                <div class="fc mb-3" style="gap:8px;flex-wrap:wrap;background:var(--color-paper);padding:8px 12px;border-radius:var(--radius-control);border:1px solid var(--color-rule);">
                  <button class="btn btn-s btn-xs" onclick="testAllModelsInProviderBtn(this)" data-pid="${escapePageHtml(p.id)}"><i class="fas fa-gauge-high"></i> 批量测模型延迟</button>
                  <button class="btn btn-s btn-xs" onclick="fetchUpstreamModelsBtn(this)" data-pid="${escapePageHtml(p.id)}"><i class="fas fa-cloud-download-alt"></i> 一键拉取上游模型</button>
                  <button class="btn btn-s btn-xs" onclick="showImportModalBtn(this)" data-pid="${escapePageHtml(p.id)}"><i class="fas fa-file-import"></i> 一键导入</button>
                  ${p.models.some((m) => m.permanentlyDisabled || (m.cooldownUntil && Date.now() < m.cooldownUntil) || (m.failureCount && m.failureCount > 0)) ? `<button class="btn btn-s btn-xs" onclick="resetAllModelsInProviderBtn(this)" data-pid="${escapePageHtml(p.id)}" style="color:#d97706;border-color:#fcd34d;"><i class="fas fa-sync-alt"></i> 一键重置本提供商所有模型异常</button>` : ''}
                  <button class="btn btn-d btn-xs" onclick="clearProviderModelsBtn(this)" data-pid="${escapePageHtml(p.id)}"><i class="fas fa-trash-alt"></i> 一键删除全部本提供商模型</button>
                </div>
                <div class="search-field mb-3" style="position:relative;">
                  <i class="fas fa-search" aria-hidden="true" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--color-muted);font-size:12px;"></i>
                  <input type="search" id="msearch-${escapePageHtml(p.id)}" data-pid="${escapePageHtml(p.id)}" placeholder="搜索本提供商中的模型 ID 或分类..." oninput="filterAdminModels(this)" autocomplete="off" style="padding-left:30px;font-size:12px;height:32px;width:100%;box-sizing:border-box;border-radius:var(--radius-control);border:1px solid var(--color-rule);background:var(--color-paper);" class="fx1">
                </div>
                <div id="ml-${escapePageHtml(p.id)}">
                  ${p.models.map((m,mi)=>{
                    const mId = m.id || '';
                    const mCat = m.category || '文本';
                    const isPermDisabled = !!m.permanentlyDisabled;
                    const permReason = m.disabledReason || '受上游故障影响永久失效';
                    const isCooldown = typeof m.cooldownUntil === 'number' && Date.now() < m.cooldownUntil;
                    const cooldownSec = isCooldown && typeof m.cooldownUntil === 'number' ? Math.ceil((m.cooldownUntil - Date.now()) / 1000) : 0;
                    const failCount = m.failureCount || 0;

                    let styleAttr = '';
                    let titleText = '模型 ID';
                    let statusBadge = '';
                    let unblockBtn = '';

                    if (isPermDisabled) {
                      styleAttr = 'style="color: #ef4444; border-color: #fca5a5; font-weight: 600; background-color: #fef2f2;"';
                      titleText = `永久失效: ${escapePageHtml(permReason)}`;
                      statusBadge = `<span class="bd" style="background:#fef2f2;color:#dc2626;border:1px solid #fecaca;padding:2px 6px;font-size:11px;border-radius:4px;font-weight:600;" title="${titleText}"><i class="fas fa-ban"></i> 永久失效 (${failCount}/3)</span>`;
                      unblockBtn = `<button class="btn btn-s btn-xs" style="padding:2px 6px;font-size:11px;" onclick="unblockModelBtn(this)" data-pid="${escapePageHtml(p.id)}" data-mid="${escapePageHtml(m.id)}" title="一键解封并恢复状态"><i class="fas fa-unlock"></i> 解封恢复</button>`;
                    } else if (isCooldown) {
                      styleAttr = 'style="border-color: #fcd34d; background-color: #fffbeb;"';
                      titleText = '因异常进入冷却状态';
                      statusBadge = `<span class="bd" style="background:#fefce8;color:#ca8a04;border:1px solid #fef08a;padding:2px 6px;font-size:11px;border-radius:4px;font-weight:600;" title="${titleText}"><i class="fas fa-hourglass-half"></i> 冷却中 (${cooldownSec}s)</span>`;
                      unblockBtn = `<button class="btn btn-s btn-xs" style="padding:2px 6px;font-size:11px;" onclick="unblockModelBtn(this)" data-pid="${escapePageHtml(p.id)}" data-mid="${escapePageHtml(m.id)}" title="重置冷却状态"><i class="fas fa-redo"></i> 重置冷却</button>`;
                    } else if (failCount > 0) {
                      styleAttr = 'style="border-color: #ffedd5; background-color: #fffaf0;"';
                      titleText = '曾出现探测或业务异常';
                      statusBadge = `<span class="bd" style="background:#fff7ed;color:#ea580c;border:1px solid #ffedd5;padding:2px 6px;font-size:11px;border-radius:4px;font-weight:600;" title="${titleText}"><i class="fas fa-exclamation-triangle"></i> 警告 (失败 ${failCount}/3)</span>`;
                      unblockBtn = `<button class="btn btn-s btn-xs" style="padding:2px 6px;font-size:11px;" onclick="unblockModelBtn(this)" data-pid="${escapePageHtml(p.id)}" data-mid="${escapePageHtml(m.id)}" title="清零失败计数"><i class="fas fa-check"></i> 清零恢复</button>`;
                    } else if (m.enabled !== false) {
                      statusBadge = '<span class="bd bd-on" style="padding:2px 6px;font-size:11px;border-radius:4px;"><i class="fas fa-check-circle"></i> 正常</span>';
                    } else {
                      styleAttr = 'style="color: #64748b; border-color: #cbd5e1; background-color: #f1f5f9; text-decoration: line-through;"';
                      titleText = '模型已手动禁用';
                      statusBadge = '<span class="bd bd-off" style="padding:2px 6px;font-size:11px;border-radius:4px;"><i class="fas fa-minus-circle"></i> 已禁用</span>';
                    }

                    const openclawBadge = m.openclawTested
                      ? (m.openclawCompatible
                          ? `<span class="openclaw-badge openclaw-badge--ok" title="${escapePageHtml(m.openclawReason || '适合 OpenClaw (支持 Tool 与智能体交互)')}"><i class="fas fa-robot"></i> OpenClaw 适合</span>`
                          : `<span class="openclaw-badge openclaw-badge--no" title="${escapePageHtml(m.openclawReason || '不适合 OpenClaw (不支持 Tool 或非代码模型)')}"><i class="fas fa-ban"></i> OpenClaw 不适合</span>`)
                      : '';

                    const catSelect = `<select class="select-xs" style="padding:2px 6px;font-size:11px;border-radius:4px;" onchange="updateModelCatBtn(this)" data-pid="${escapePageHtml(p.id)}" data-mid="${escapePageHtml(m.id)}" title="修改智能分类">` +
                      `<option value="文本" ${mCat === '文本' ? 'selected' : ''}>文本</option>` +
                      `<option value="绘图" ${mCat === '绘图' ? 'selected' : ''}>绘图</option>` +
                      `<option value="多模态" ${mCat === '多模态' ? 'selected' : ''}>多模态</option>` +
                      `<option value="其他" ${mCat === '其他' ? 'selected' : ''}>其他</option>` +
                      `</select>`;

                    return `<div class="model-single-row" data-idx="${mi}">` +
                      `<div class="model-row-line-1">` +
                        `<input type="text" value="${escapePageHtml(m.id)}" class="model-id-input" id="mid-${escapePageHtml(p.id)}-${mi}" placeholder="模型 ID" ${styleAttr} title="${titleText}">` +
                        `<div class="model-row-actions-1">` +
                          `<label class="tg" title="启用模型"><input type="checkbox" ${m.enabled !== false ? 'checked' : ''} id="men-${escapePageHtml(p.id)}-${mi}" aria-label="启用模型"><span class="sl"></span></label>` +
                          `<button class="icon-btn" onclick="rmMdlBtn(this)" data-pid="${escapePageHtml(p.id)}" data-idx="${mi}" title="移除模型" aria-label="移除模型"><i class="fas fa-times" aria-hidden="true"></i></button>` +
                        `</div>` +
                      `</div>` +
                      `<div class="model-row-line-2">` +
                        catSelect +
                        statusBadge +
                        openclawBadge +
                        `<span id="lat-${escapePageHtml(p.id)}-${mi}" class="latency-chip" title="模型通信延迟"><i class="fas fa-gauge-high"></i> <span class="lat-val">-- ms</span></span>` +
                        unblockBtn +
                        `<button class="icon-btn test-mdl-btn" onclick="testMdlBtn(this)" data-pid="${escapePageHtml(p.id)}" data-mid="${escapePageHtml(m.id)}" data-idx="${mi}" title="单独测试模型延迟" aria-label="测试模型延迟"><i class="fas fa-gauge-high" aria-hidden="true"></i></button>` +
                      `</div>` +
                    `</div>`;
                  }).join('')}
                </div>
                <div class="fc mt-1 field-row"><input type="text" id="nmid-${escapePageHtml(p.id)}" placeholder="新的模型 ID" class="fx1"><button class="btn btn-s btn-xs" onclick="addMdlBtn(this)" data-pid="${escapePageHtml(p.id)}"><i class="fas fa-plus" aria-hidden="true"></i>添加</button></div>
              </fieldset>
              <div class="detail-actions">
                <div id="tr-${escapePageHtml(p.id)}" aria-live="polite"></div>
                <div>
                  ${p.id === 'opencode' ? `<button class="btn btn-s" onclick="fetchEditModelsBtn(this)" data-pid="${escapePageHtml(p.id)}"><i class="fas fa-download" aria-hidden="true"></i>获取模型</button>` : ''}
                  <button class="btn btn-d" onclick="delBtn(this)" data-pid="${escapePageHtml(p.id)}"><i class="fas fa-trash" aria-hidden="true"></i>删除</button>
                  <button class="btn btn-p" onclick="saveBtn(this)" data-pid="${escapePageHtml(p.id)}"><i class="fas fa-save" aria-hidden="true"></i>暂存更改</button>
                </div>
              </div>
            </div>
          </article>`
          }).join('') : `<div class="empty-state"><i class="fas fa-server" aria-hidden="true"></i><h3>还没有提供商</h3><p>添加第一个上游提供商，配置 API 地址、Key 和模型。</p><button class="btn btn-p" onclick="showAdd()">添加提供商</button></div>`}
        </div>
      </section>

      <section id="custom-routes" class="workspace-section" aria-labelledby="routes-title">
        <div class="section-heading section-heading--admin">
          <div>
            <h2 id="routes-title">指定模型路由</h2>
            <p>指定客户端请求特定模型名时，强制转发至特定提供商的指定模型（如客户端请求 <code>openclaw/auto</code> 时转发到指定的高性能模型）。支持按标签一键快速选模。</p>
          </div>
          <button type="button" class="btn btn-p" onclick="openAddCustomRouteModal()"><i class="fas fa-plus" aria-hidden="true"></i>添加指定规则</button>
        </div>
        <div class="route-tag-bar" id="custom-routes-filter-bar">
          <button type="button" class="route-tag-chip is-active" data-route-filter="all" onclick="filterCustomRoutesTableBtn(this)"><i class="fas fa-layer-group"></i> 全部规则 <span class="chip-count" id="cr-cnt-all">0</span></button>
          <button type="button" class="route-tag-chip" data-route-filter="openclaw" onclick="filterCustomRoutesTableBtn(this)"><i class="fas fa-robot"></i> OpenClaw 规则 <span class="chip-count" id="cr-cnt-openclaw">0</span></button>
          <button type="button" class="route-tag-chip" data-route-filter="tier1" onclick="filterCustomRoutesTableBtn(this)"><i class="fas fa-bolt"></i> 第一梯队规则 <span class="chip-count" id="cr-cnt-tier1">0</span></button>
          <button type="button" class="route-tag-chip" data-route-filter="text" onclick="filterCustomRoutesTableBtn(this)"><i class="fas fa-comment-dots"></i> 文本规则 <span class="chip-count" id="cr-cnt-text">0</span></button>
          <button type="button" class="route-tag-chip" data-route-filter="image" onclick="filterCustomRoutesTableBtn(this)"><i class="fas fa-palette"></i> 绘图规则 <span class="chip-count" id="cr-cnt-image">0</span></button>
        </div>
        <div class="table-wrap" style="overflow-x:auto;border:1px solid var(--color-rule);border-radius:var(--radius-panel);background:var(--color-paper);">
          <table class="data-table" id="custom-routes-table" style="width:100%;text-align:left;border-collapse:collapse;">
            <thead>
              <tr style="border-bottom:1px solid var(--color-rule);font-size:var(--text-xs);color:var(--color-muted);background:var(--color-paper-2);">
                <th style="padding:10px 12px;">请求模型名称 (匹配项)</th>
                <th style="padding:10px 12px;">目标提供商</th>
                <th style="padding:10px 12px;">目标模型</th>
                <th style="padding:10px 12px;">实时延迟</th>
                <th style="padding:10px 12px;">启用状态</th>
                <th style="padding:10px 12px;text-align:right;">操作</th>
              </tr>
            </thead>
            <tbody id="custom-routes-tbody">
              ${customRoutes.length === 0 ? '<tr><td colspan="6" style="text-align:center;color:var(--color-muted);padding:24px;">暂无自定义指定规则。点击右上角“+ 添加指定规则”可指定将特定模型名（如 openclaw/auto）转发到指定模型或第一梯队池。</td></tr>' : ''}
            </tbody>
          </table>
        </div>
      </section>

      <section id="proxy-keys" class="workspace-section" aria-labelledby="proxy-keys-title">
        <div class="section-heading section-heading--admin"><div><h2 id="proxy-keys-title">转发 Key</h2><p>客户端使用这些 Key 访问统一的 <code>/v1</code> 接口。</p></div><button class="btn btn-p" onclick="genKey()"><i class="fas fa-plus" aria-hidden="true"></i>生成转发 Key</button></div>
        <div class="key-list">
          ${proxyKeys.length===0?'<div class="empty-state"><i class="fas fa-key" aria-hidden="true"></i><h3>暂无转发 Key</h3><p>生成一个 Key 后，客户端才能访问网关。</p><button class="btn btn-p" onclick="genKey()">生成转发 Key</button></div>':''}
          ${proxyKeys.map(k=>`<article class="ki" data-id="${escapePageHtml(k.id)}"><div class="key-main"><span class="key-icon" aria-hidden="true"><i class="fas fa-key"></i></span><div><div class="kv"><span id="kv-${escapePageHtml(k.id)}" data-full="${escapePageHtml(k.key)}" data-vis="0">${escapePageHtml(k.key.length>12?k.key.substring(0,8)+'*****'+k.key.substring(k.key.length-4):k.key)}</span><button class="icon-btn" onclick="toggleKeyVisBtn(this)" data-id="${escapePageHtml(k.id)}" title="显示或隐藏" aria-label="显示或隐藏 Key"><i class="far fa-eye" aria-hidden="true"></i></button><button class="icon-btn" onclick="copyText(this)" data-copy="${escapePageHtml(k.key)}" title="复制" aria-label="复制 Key"><i class="far fa-copy" aria-hidden="true"></i></button></div><div class="key-meta"><h3>${escapePageHtml(k.name)}</h3><span class="key-meta__sep" aria-hidden="true">-</span><p>创建于 ${new Date(k.createdAt).toLocaleDateString()} · ${k.expiresAt?'有效至 '+new Date(k.expiresAt).toLocaleDateString():'永久有效'}</p></div></div></div><div class="key-actions"><label class="tg"><input type="checkbox" ${k.enabled?'checked':''} onchange="toggleProxyKeyBtn(this)" data-id="${escapePageHtml(k.id)}" aria-label="启用 ${escapePageHtml(k.name)}"><span class="sl"></span></label><span class="bd ${k.enabled?'bd-on':'bd-off'}">${k.enabled?'已启用':'已禁用'}</span><button class="bd bd-del" onclick="rmKeyBtn(this)" data-id="${escapePageHtml(k.id)}"><i class="fas fa-trash" aria-hidden="true"></i>删除</button></div></article>`).join('')}
        </div>
      </section>

      <section id="logs" class="workspace-section" aria-labelledby="logs-title">
        <div class="section-heading section-heading--admin">
          <div><h2 id="logs-title">网关请求日志</h2><p>记录客户端 API 请求，包含耗时、HTTP 状态、调用详情与失败原因。</p></div>
          <div class="fc" style="gap:12px;flex-wrap:wrap;align-items:center;">
            <label class="switch-label" style="background:var(--color-paper);padding:6px 12px;border-radius:var(--radius-control);border:1px solid var(--color-rule);" title="调试模式开启：每条请求日志即时同步写入 KV，点击【刷新日志】可实时查看；关闭后彻底停用日志（0 KV 消耗）">
              <span style="font-size:var(--text-xs);font-weight:600;">调试模式 (同步落盘)</span>
              <span class="tg"><input type="checkbox" id="debug-mode-toggle" ${isDebug ? 'checked' : ''} onchange="toggleDebugMode(this.checked)"><span class="sl"></span></span>
            </label>
            <button class="btn btn-s" onclick="fetchLogs()"><i class="fas fa-sync" aria-hidden="true"></i>刷新日志</button>
            <button class="btn btn-d" onclick="clearAllLogs()"><i class="fas fa-trash" aria-hidden="true"></i>清空日志</button>
          </div>
        </div>
        <div id="logs-panel" class="logs-container">
          <!-- 日志表格组件 -->
        </div>
      </section>
    </main>

    ${renderSiteFooter(SITE_CONFIG.title)}
  </div>
</div>

<div id="modal" class="modal-o hd" role="presentation" onclick="if(event.target===this)closeM()"><div class="modal" id="mc" role="dialog" aria-modal="true" aria-live="polite"></div></div>

<script id="init-providers-json" type="application/json">${JSON.stringify(providers).replace(/</g, '\\u003c')}</script>
<script id="init-proxykeys-json" type="application/json">${JSON.stringify(proxyKeys).replace(/</g, '\\u003c')}</script>

<script>${SHARED_JS}
// 1. 内存临时状态（生命周期随 Worker 实例 / 页面会话有效，所有表单修改暂存于此，不单项操作 KV）
// 注意：Cloudflare Workers 运行在无状态多实例 Serverless Container 环境，内存变量仅在单实例生命周期内生效。
var draftProviders = JSON.parse(document.getElementById('init-providers-json').textContent || '[]');
var draftProxyKeys = JSON.parse(document.getElementById('init-proxykeys-json').textContent || '[]');
var isDirty = false;

function markDirty(dirty) {
  isDirty = dirty;
  var badges = document.querySelectorAll('.save-status-badge, #save-status-badge');
  badges.forEach(function(badge) {
    if (dirty) {
      badge.className = 'badge-status badge-unsaved save-status-badge';
      badge.innerHTML = '<i class="fas fa-exclamation-triangle" aria-hidden="true"></i> 有未保存的改动';
    } else {
      badge.className = 'badge-status badge-synced save-status-badge';
      badge.innerHTML = '<i class="fas fa-check-circle" aria-hidden="true"></i> 配置已同步 KV';
    }
  });
}

// 同步激活的展开表单输入值到内存暂存状态 draftProviders
function syncActiveFormsToDraft() {
  draftProviders.forEach(function(p) {
    var nmEl = document.getElementById('nm-' + p.id);
    var urlEl = document.getElementById('url-' + p.id);
    var atEl = document.getElementById('at-' + p.id);
    var enEl = document.getElementById('en-' + p.id);
    if (nmEl) p.name = nmEl.value.trim();
    if (urlEl) p.baseUrl = urlEl.value.trim();
    if (atEl) p.apiType = atEl.value;
    if (enEl) p.enabled = enEl.checked;

    var keysContainer = document.getElementById('keys-' + p.id);
    if (keysContainer) {
      p.apiKeys = getKeys(p.id);
    }
    var modelsContainer = document.getElementById('ml-' + p.id);
    if (modelsContainer) {
      p.models = getMdl(p.id);
    }
  });
}

// 统一保存大按钮处理逻辑（含防重复提交与错误弹窗提示）
async function saveAllConfig() {
  var btns = document.querySelectorAll('.btn-save-all, #btn-save-all');
  if (!btns || btns.length === 0) return;

  var isAnyDisabled = false;
  btns.forEach(function(b) {
    if (b.disabled) isAnyDisabled = true;
  });
  if (isAnyDisabled) return;

  btns.forEach(function(b) {
    var btnEl = b;
    btnEl.disabled = true;
    btnEl.style.opacity = '0.6';
    btnEl.style.cursor = 'not-allowed';
    btnEl.setAttribute('data-orig-html', btnEl.innerHTML);
    btnEl.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> 保存中...';
  });

  try {
    syncActiveFormsToDraft();

    var resp = await fetch('/admin/api/save-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providers: draftProviders,
        proxyKeys: draftProxyKeys,
        customRoutes: customRoutesData,
      })
    });

    var data = await resp.json();

    if (data && data.success) {
      toast('保存成功！所有提供商、Key及指定路由配置已合包一次性写入 KV。', 'success');
      markDirty(false);
      renderProviderList();
      renderProxyKeyList();
      renderCustomRoutesTable();
    } else {
      var errMsg = (data && data.message) ? data.message : '未知系统错误';
      aM('保存失败：' + errMsg, 'error');
    }
  } catch (err) {
    var errText = (err && err.message) ? err.message : String(err);
    aM('保存配置失败（网络或系统异常）：' + errText, 'error');
  } finally {
    btns.forEach(function(b) {
      var btnEl = b;
      btnEl.disabled = false;
      btnEl.style.opacity = '1';
      btnEl.style.cursor = 'pointer';
      var origHtml = btnEl.getAttribute('data-orig-html');
      if (origHtml) btnEl.innerHTML = origHtml;
    });
  }
}

// copy
function copyText(t, el) {
  var text = typeof t === 'string' ? t : '';
  var target = el || (t && t.nodeType ? t : null);
  if (!text && target) {
    text = target.getAttribute('data-copy') || target.dataset.copy || '';
  }
  if (!text && target) {
    var inp = target.parentElement ? target.parentElement.querySelector('input[type=text]') : null;
    if (inp) text = inp.value;
  }
  if (!target) return;
  var i = target.tagName === 'I' ? target : (target.querySelector('i') || (target.parentElement ? target.parentElement.querySelector('i') : null));
  if (!i) { if (text) navigator.clipboard.writeText(text).catch(function() {}); return; }
  var oc = i.className;
  navigator.clipboard.writeText(text).then(function() {
    i.className = 'fas fa-check c-s';
    target.setAttribute('data-state', 'success');
    setTimeout(function() {
      i.className = oc;
      target.removeAttribute('data-state');
    }, 1800);
  }).catch(function() {
    target.setAttribute('data-state', 'error');
  });
}

function copyRowVal(btn) {
  var inp = btn.parentElement.querySelector('input[type=text]');
  if (inp) copyText(inp.value, btn);
}

function addMdlFromBtn(btn) {
  var pid = btn.getAttribute('data-pid');
  var mid = btn.getAttribute('data-mid');
  if (pid) {
    addMdlToEdit(pid, mid);
  } else {
    addMdlToForm(mid);
  }
}

function testMdlBtn(btn) {
  var pid = btn.getAttribute('data-pid');
  var mid = btn.getAttribute('data-mid');
  var idx = parseInt(btn.getAttribute('data-idx') || '0', 10);
  var inp = document.getElementById('mid-' + pid + '-' + idx);
  if (inp && inp.value.trim()) {
    mid = inp.value.trim();
  }
  testMdl(pid, mid, idx, btn);
}

function unblockModelBtn(btn) {
  var pid = btn.getAttribute('data-pid');
  var mid = btn.getAttribute('data-mid');
  unblockModel(pid, mid);
}

function resetAllModelsInProviderBtn(btn) {
  var pid = btn.getAttribute('data-pid');
  if (pid) resetAllModelsInProvider(pid);
}

function updateModelCatBtn(selectEl) {
  var pid = selectEl.getAttribute('data-pid');
  var mid = selectEl.getAttribute('data-mid');
  updateModelCat(pid, mid, selectEl.value);
}

function hideMdlPanelBtn(btn) {
  var pid = btn.getAttribute('data-panel');
  if (pid) hideMdlPanel(pid);
}

function testKeyRowBtn(btn) {
  var pid = btn.getAttribute('data-pid');
  var kidx = parseInt(btn.getAttribute('data-kidx') || '0', 10);
  testKeyRow(pid, kidx, btn);
}

function rmKeyRowBtn(btn) {
  var pid = btn.getAttribute('data-pid');
  var kidx = parseInt(btn.getAttribute('data-kidx') || '0', 10);
  rmKeyRow(pid, kidx);
}

function rmMdlBtn(btn) {
  var pid = btn.getAttribute('data-pid');
  var idx = parseInt(btn.getAttribute('data-idx') || '0', 10);
  rmMdl(pid, idx);
}

function fetchUpstreamModelsBtn(btn) {
  var pid = btn.getAttribute('data-pid');
  if (pid) fetchUpstreamModels(pid);
}

function showImportModalBtn(btn) {
  var pid = btn.getAttribute('data-pid');
  if (pid) showImportModal(pid);
}

function clearProviderModelsBtn(btn) {
  var pid = btn.getAttribute('data-pid');
  if (pid) clearProviderModels(pid);
}

function fetchEditModelsBtn(btn) {
  var pid = btn.getAttribute('data-pid');
  if (pid) fetchEditModels(pid, btn);
}

function togBtn(btn) {
  var pid = btn.getAttribute('data-pid');
  if (pid) tog(pid);
}

function togKey(e, el) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    togBtn(el);
  }
}

function togglePbBtn(cb) {
  var pid = cb.getAttribute('data-pid');
  if (pid) togglePb(pid, cb.checked);
}

function addKeyRowBtn(btn) {
  var pid = btn.getAttribute('data-pid');
  if (pid) addKeyRow(pid);
}

function addMdlBtn(btn) {
  var pid = btn.getAttribute('data-pid');
  if (pid) addMdl(pid);
}

function delBtn(btn) {
  var pid = btn.getAttribute('data-pid');
  if (pid) del(pid);
}

function saveBtn(btn) {
  var pid = btn.getAttribute('data-pid');
  if (pid) save(pid, btn);
}

function toggleKeyVisBtn(btn) {
  var id = btn.getAttribute('data-id');
  if (id) toggleKeyVis(id);
}

function toggleProxyKeyBtn(cb) {
  var id = cb.getAttribute('data-id');
  if (id) toggleProxyKey(id, cb.checked);
}

function rmKeyBtn(btn) {
  var id = btn.getAttribute('data-id');
  if (id) rmKey(id);
}

// modal
function showM(h) { document.getElementById('mc').innerHTML = h; document.getElementById('modal').classList.remove('hd') }
function closeM() { document.getElementById('modal').classList.add('hd') }
function cM(msg) {
  return new Promise(function(r) {
    showM('<h3><i class="fas fa-question-circle c-p"></i> 确认</h3><p>' + escapeHtml(msg) + '</p><div class="fa"><button class="btn btn-s" id="cMc">取消</button><button class="btn btn-p" id="cMo">确定</button></div>');
    var cancelBtn = document.getElementById('cMc');
    var okBtn = document.getElementById('cMo');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function() { closeM(); r(false); });
    }
    if (okBtn) {
      okBtn.addEventListener('click', function() { closeM(); r(true); });
    }
  });
}
function pM(msg, def) {
  return new Promise(r => {
    showM('<h3><i class="fas fa-pen c-p"></i> ' + msg + '</h3><div class="fg"><input type="text" id="pv" value="' + (def || '') + '" placeholder="请输入"></div><div class="fa"><button class="btn btn-s" id="pMc">取消</button><button class="btn btn-p" id="pMo">确定</button></div>')
    window.r = r
    const inp = document.getElementById('pv')
    if (inp) {
      inp.focus()
      inp.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { closeM(); r(inp.value.trim()) }
      })
    }
    document.getElementById('pMc').addEventListener('click', function() { closeM(); r(null) })
    document.getElementById('pMo').addEventListener('click', function() { closeM(); r(inp.value.trim()) })
  })
}
function aM(msg, t) {
  const i = t === 'success' ? 'fa-check-circle c-s' : 'fa-exclamation-circle c-d'
  showM('<h3><i class="fas ' + i + '"></i> ' + (t === 'success' ? '成功' : '提示') + '</h3><p>' + msg + '</p><div class="fa"><button class="btn btn-p" onclick="closeM()">确定</button></div>')
}

function toast(msg, t) {
  const el = document.getElementById('toast')
  const i = t === 'success' ? 'fa-check-circle' : 'fa-times-circle'
  const cls = t === 'success' ? 'al-s' : 'al-e'
  el.innerHTML = '<div class="al ' + cls + '"><i class="fas ' + i + '"></i> ' + escapeHtml(msg) + '</div>'
  el.classList.remove('hd')
  setTimeout(() => el.classList.add('hd'), 3000)
}

// providers UI render
function tog(id) {
  const d = document.getElementById('dt-' + id), c = document.getElementById('ch-' + id)
  if (d && c) {
    d.classList.toggle('open')
    c.style.transform = d.classList.contains('open') ? 'rotate(90deg)' : ''
    const card = d.closest('.pi')
    if (card) card.classList.toggle('open', d.classList.contains('open'))
  }
}

function showAdd() {
  resetAddForm();
  document.getElementById('af').classList.remove('hd');
}
function hideAdd() { document.getElementById('af').classList.add('hd'); document.getElementById('amc').classList.add('hd') }

function resetAddForm() {
  const anm = document.getElementById('anm');
  const aid = document.getElementById('aid');
  const aurl = document.getElementById('aurl');
  const afmt = document.getElementById('afmt');
  const akeys = document.getElementById('akeys');
  const amodels = document.getElementById('amodels');
  const aen = document.getElementById('aen');
  const atestR = document.getElementById('atestR');

  if (anm) anm.value = '';
  if (aid) aid.value = '';
  if (aurl) aurl.value = '';
  if (afmt) afmt.value = 'openai';
  if (aen) aen.checked = true;
  if (atestR) atestR.innerHTML = '';

  if (akeys) {
    akeys.innerHTML = '<div class="fc mb-4 field-row"><input type="text" placeholder="sk-xxx" class="fx1 aki" aria-label="上游 API Key"><label class="tg" title="启用 Key"><input type="checkbox" checked class="ake" aria-label="启用 Key"><span class="sl"></span></label><button class="icon-btn" onclick="copyRowVal(this)" title="复制 Key" aria-label="复制 Key"><i class="far fa-copy" aria-hidden="true"></i></button><button class="icon-btn" onclick="testNewAKey(this)" title="测试 Key" aria-label="测试 Key"><i class="fas fa-plug" aria-hidden="true"></i></button><button class="icon-btn" onclick="this.parentElement.remove()" title="移除 Key" aria-label="移除 Key"><i class="fas fa-times" aria-hidden="true"></i></button></div>';
  }
  if (amodels) {
    amodels.innerHTML = '<div class="fc mb-4 field-row"><input type="text" placeholder="deepseek-chat" class="fx1 ami" aria-label="模型 ID"><label class="tg" title="启用模型"><input type="checkbox" checked class="ame" aria-label="启用模型"><span class="sl"></span></label><button class="icon-btn" onclick="testNewMdl(this)" title="测试模型" aria-label="测试模型"><i class="fas fa-plug" aria-hidden="true"></i></button><button class="icon-btn" onclick="this.parentElement.remove()" title="移除模型" aria-label="移除模型"><i class="fas fa-times" aria-hidden="true"></i></button></div>';
  }
  const amcl = document.getElementById('amcl');
  if (amcl) amcl.innerHTML = '';
  hideMdlPanel('amc');
}

document.getElementById('aid').addEventListener('input', function() {
  if (this.value.trim() === 'opencode') {
    document.getElementById('aurl').value = '${OPENCODE_DEFAULT_URL}'
  }
})

function addAKeyRow() {
  const c = document.getElementById('akeys')
  const d = document.createElement('div')
  d.className = 'fc mb-4 field-row'
  d.innerHTML = '<input type="text" placeholder="sk-xxx" class="fx1 aki" aria-label="上游 API Key"><label class="tg"><input type="checkbox" checked class="ake" aria-label="启用 Key"><span class="sl"></span></label><button class="icon-btn" onclick="copyRowVal(this)" title="复制 Key" aria-label="复制 Key"><i class="far fa-copy"></i></button><button class="icon-btn" onclick="testNewAKey(this)" title="测试 Key" aria-label="测试 Key"><i class="fas fa-plug"></i></button><button class="icon-btn" onclick="this.parentElement.remove()" title="移除 Key" aria-label="移除 Key"><i class="fas fa-times"></i></button>'
  c.appendChild(d)
}

function renderModelGrid(models, editId, providerId) {
  if (providerId === 'opencode') {
    models = (models || []).filter(function(m) {
      return m && typeof m.id === 'string' && /^[A-Za-z0-9._:/-]+$/.test(m.id) && (m.id === 'big-pickle' || m.id.endsWith('-free'))
    })
  }
  if (!models || models.length === 0) return '<span class="mu">未返回模型列表</span>'
  var h = models.map(function(m) {
    var modelId = String(m.id || '')
    var safeId = escapeHtml(modelId)
    return '<div class="mdl-item">' +
      '<i class="fas fa-cube"></i>' +
      '<span class="fx1 cp ov" onclick="copyText(this)" data-copy="' + safeId + '">' + safeId + '</span>' +
      '<button class="btn btn-gh btn-xs mdl-add-btn" onclick="addMdlFromBtn(this)" data-pid="' + escapeHtml(editId || '') + '" data-mid="' + safeId + '" title="添加到表单">+</button></div>'
  }).join('')
  return '<div class="grid-2-gap6">' + h + '</div>'
}

function importAllEditModelsBtn(btn) {
  var pid = btn.getAttribute('data-pid');
  if (pid) importAllEditModels(pid);
}

function modelPanelHeading(panelId, pid) {
  var importBtn = pid ? '<button class="btn btn-s btn-xs" data-pid="' + escapeHtml(pid) + '" onclick="importAllEditModelsBtn(this)" style="margin-right:8px;"><i class="fas fa-file-import" aria-hidden="true"></i> 一键导入</button>' : '';
  return '<div class="panel-heading"><div>' +
    '<span class="panel-heading__mark"><i class="fas fa-cube" aria-hidden="true"></i></span>' +
    '<div><h3>可用模型</h3><p>点击“+”单条添加，或使用一键导入。</p></div></div>' +
    '<div class="fc" style="gap:var(--space-2xs);">' + importBtn +
    '<button class="icon-btn" type="button" onclick="hideMdlPanelBtn(this)" data-panel="' + escapeHtml(panelId) + '" title="关闭可用模型" aria-label="关闭可用模型"><i class="fas fa-times" aria-hidden="true"></i></button></div></div>'
}

function importAllNewModels() {
  const btns = document.querySelectorAll('#amcl .mdl-add-btn');
  if (btns.length === 0) {
    toast('无可用模型可导入', 'warning');
    return;
  }
  let count = 0;
  btns.forEach(btn => {
    const mid = btn.getAttribute('data-mid');
    if (mid) {
      const inputs = document.querySelectorAll('#amodels .ami');
      let exists = false;
      for (const input of Array.from(inputs)) {
        if (input.value.trim() === mid.trim()) {
          exists = true;
          break;
        }
      }
      if (!exists) {
        addMdlToForm(mid);
        count++;
      }
    }
  });
  toast('成功导入 ' + count + ' 个模型' + (count < btns.length ? '（已自动过滤重复项）' : ''), 'success');
}

function importAllEditModels(pid) {
  const container = document.getElementById('melc-' + pid);
  if (!container) return;
  const btns = container.querySelectorAll('.mdl-add-btn');
  if (btns.length === 0) {
    toast('无可用模型可导入', 'warning');
    return;
  }
  let count = 0;
  btns.forEach(btn => {
    const mid = btn.getAttribute('data-mid');
    if (mid) {
      const inputs = document.querySelectorAll('#ml-' + pid + ' input.fx1');
      let exists = false;
      for (const input of Array.from(inputs)) {
        if (input.value.trim() === mid.trim()) {
          exists = true;
          break;
        }
      }
      if (!exists) {
        const inp = document.getElementById('nmid-' + pid);
        if (inp) {
          inp.value = mid;
          addMdl(pid);
        }
        count++;
      }
    }
  });
  toast('成功导入 ' + count + ' 个模型' + (count < btns.length ? '（已自动过滤重复项）' : ''), 'success');
}

function clearAllNewModels() {
  const c = document.getElementById('amodels');
  if (c) {
    c.innerHTML = '';
    toast('已清空新增提供商下的所有模型列表', 'success');
  }
}

function clearAllEditModels(pid) {
  const c = document.getElementById('ml-' + pid);
  if (c) {
    c.innerHTML = '';
    markDirty(true);
    toast('已清空该提供商下的所有模型列表，请点击【保存更改】以使变更生效', 'success');
  }
}

function hideMdlPanel(panelId) {
  document.getElementById(panelId).classList.add('hd')
}

async function testNewAKey(btn) {
  if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
  try {
    const inp = btn.parentElement.querySelector('.aki'), k = inp.value.trim()
    const providerId = document.getElementById('aid').value.trim()
    if (!k && providerId !== 'opencode') { toast('请输入 API Key', 'error'); return }
    const url = document.getElementById('aurl').value.trim()
    if (!url) { toast('请先填写 API 地址', 'error'); return }
    const apiType = document.getElementById('afmt').value
    const tr = document.getElementById('atestR')
    showSpinner(tr)
    const result = await testKeyConnection(url, apiType, k, providerId)
    if (result.success && result.data) {
      document.getElementById('amcl').innerHTML = renderModelGrid(result.data.data || [], null, providerId)
      document.getElementById('amc').classList.remove('hd')
    } else {
      document.getElementById('amc').classList.add('hd')
    }
    showResult(tr, result.success, result.success ? '' : 'HTTP ' + result.status)
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
  }
}

function addMdlRow() {
  const c = document.getElementById('amodels')
  const d = document.createElement('div')
  d.className = 'fc mb-4 field-row'
  d.innerHTML = '<input type="text" placeholder="deepseek-chat" class="fx1 ami" aria-label="模型 ID"><label class="tg"><input type="checkbox" checked class="ame" aria-label="启用模型"><span class="sl"></span></label><button class="icon-btn" onclick="testNewMdl(this)" title="测试模型" aria-label="测试模型"><i class="fas fa-plug"></i></button><button class="icon-btn" onclick="this.parentElement.remove()" title="移除模型" aria-label="移除模型"><i class="fas fa-times"></i></button>'
  c.appendChild(d)
}

function addMdlToForm(mid) {
  const inputs = document.querySelectorAll('#amodels .ami');
  for (const input of Array.from(inputs)) {
    if (input.value.trim() === mid.trim()) {
      toast('模型 ' + mid + ' 已在列表中，已自动剔除重复项', 'warning');
      return;
    }
  }
  const c = document.getElementById('amodels')
  const d = document.createElement('div')
  d.className = 'fc mb-4 field-row'
  d.innerHTML = '<input type="text" value="' + escapeHtml(mid) + '" class="fx1 ami" aria-label="模型 ID"><label class="tg"><input type="checkbox" checked class="ame" aria-label="启用模型"><span class="sl"></span></label><button class="icon-btn" onclick="testNewMdl(this)" title="测试模型" aria-label="测试模型"><i class="fas fa-plug"></i></button><button class="icon-btn" onclick="this.parentElement.remove()" title="移除模型" aria-label="移除模型"><i class="fas fa-times"></i></button>'
  c.appendChild(d)
}

async function testNewMdl(btn) {
  if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
  try {
    const inp = btn.parentElement.querySelector('.ami'), mid = inp.value.trim()
    if (!mid) { toast('请输入模型 ID', 'error'); return }
    const url = document.getElementById('aurl').value.trim()
    const akeys = document.querySelectorAll('#akeys .aki')
    const configuredKey = Array.from(akeys).map(function(inp) { return inp.value.trim() }).filter(Boolean)[0] || ''
    const apiType = document.getElementById('afmt').value
    const tr = document.getElementById('atestR')
    showSpinner(tr)
    const providerId = document.getElementById('aid').value.trim()
    const apiKey = configuredKey || (providerId === 'opencode' ? '' : 'dummy')
    const result = await testModelConnection(url, apiType, apiKey, mid, providerId)
    showResult(tr, result.success, result.success ? '' : 'HTTP ' + result.status)
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
  }
}

function createProv() {
  var createBtn = document.querySelector('#af .panel-actions button.btn-p');
  if (createBtn) { createBtn.disabled = true; createBtn.style.opacity = '0.6'; }
  try {
    var nm = document.getElementById('anm').value.trim();
    var id = document.getElementById('aid').value.trim();
    var url = document.getElementById('aurl').value.trim();
    var apiType = document.getElementById('afmt').value;
    var aki = document.querySelectorAll('#akeys .aki');
    var seenKeys = new Set();
    var keys = Array.from(aki).map(function(inp) {
      var k = inp.value.trim();
      if (!k) return null;
      if (seenKeys.has(k)) {
        if (inp.parentElement) inp.parentElement.remove();
        return null;
      }
      seenKeys.add(k);
      var akeEl = inp.parentElement ? inp.parentElement.querySelector('.ake') : null;
      var en = akeEl ? akeEl.checked : true;
      return { key: k, enabled: en };
    }).filter(Boolean);
    var ami = document.querySelectorAll('#amodels .ami');
    var seenModels = new Set();
    var models = Array.from(ami).map(function(inp) {
      var mid = inp.value.trim();
      if (!mid) return null;
      if (seenModels.has(mid)) {
        if (inp.parentElement) inp.parentElement.remove();
        return null;
      }
      seenModels.add(mid);
      var ameEl = inp.parentElement ? inp.parentElement.querySelector('.ame') : null;
      var en = ameEl ? ameEl.checked : true;
      return { id: mid, enabled: en };
    }).filter(Boolean);
    var enabled = document.getElementById('aen').checked;

    if (!nm || !id || !url) { toast('请填写名称、ID 和 API 地址', 'error'); return; }
    if (draftProviders.some(function(p) { return p.id === id; })) {
      toast('提供商 ID "' + id + '" 已存在', 'error');
      return;
    }

    var now = new Date().toISOString();
    draftProviders.push({
      id: id,
      name: nm,
      baseUrl: url,
      apiType: apiType,
      apiKeys: keys,
      models: models,
      enabled: enabled,
      createdAt: now,
      updatedAt: now
    });

    markDirty(true);
    hideAdd();
    resetAddForm();
    renderProviderList();
    toast('提供商已添加至暂存，请点击【统一保存】写入 KV', 'success');
  } finally {
    if (createBtn) { createBtn.disabled = false; createBtn.style.opacity = '1'; }
  }
}

function getKeys(id) {
  const c = document.getElementById('keys-' + id)
  if (!c) return []
  const items = c.querySelectorAll('[data-kidx]')
  const seen = new Set()
  return Array.from(items).map(item => {
    const idx = parseInt(item.dataset.kidx)
    const inp = document.getElementById('k-' + id + '-' + idx)
    const chk = document.getElementById('ken-' + id + '-' + idx)
    const k = inp ? inp.value.trim() : ''
    if (!k) return null
    if (seen.has(k)) {
      item.remove()
      return null
    }
    seen.add(k)
    const en = chk ? chk.checked : true
    return { key: k, enabled: en }
  }).filter(Boolean)
}

function addKeyRow(id) {
  const inp = document.getElementById('nk-' + id), k = inp.value.trim()
  if (!k) { toast('请输入 API Key', 'error'); return }
  const c = document.getElementById('keys-' + id)
  
  // Check duplicate key
  const inputs = c.querySelectorAll('input[id^="k-"]')
  for (const input of Array.from(inputs)) {
    if (input.value.trim() === k) {
      toast('API Key 已在配置中，已自动剔除重复项', 'warning')
      inp.value = ''
      return
    }
  }

  let maxIdx = -1
  c.querySelectorAll('[data-kidx]').forEach(item => {
    const kidx = parseInt(item.dataset.kidx || '-1', 10)
    if (kidx > maxIdx) maxIdx = kidx
  })
  const cnt = maxIdx + 1
  const d = document.createElement('div')
  d.className = 'fc mb-3 field-row'
  d.dataset.kidx = cnt
  d.innerHTML = '<input type="text" value="' + escapeHtml(k) + '" class="fx1" id="k-' + id + '-' + cnt + '" placeholder="API Key"><label class="tg"><input type="checkbox" checked id="ken-' + id + '-' + cnt + '" onchange="markDirty(true)"><span class="sl"></span></label><button class="icon-btn" onclick="copyRowVal(this)" title="复制 Key" aria-label="复制 Key"><i class="far fa-copy"></i></button><button class="icon-btn" onclick="testKeyRowBtn(this)" data-pid="' + escapeHtml(id) + '" data-kidx="' + cnt + '" title="测试 Key" aria-label="测试 Key"><i class="fas fa-plug"></i></button><button class="icon-btn" onclick="rmKeyRowBtn(this)" data-pid="' + escapeHtml(id) + '" data-kidx="' + cnt + '" title="移除 Key" aria-label="移除 Key"><i class="fas fa-times"></i></button>'
  c.appendChild(d)
  inp.value = ''
  inp.focus()
  markDirty(true)
}

function rmKeyRow(id, idx) {
  const c = document.getElementById('keys-' + id)
  if (c) {
    c.querySelectorAll('[data-kidx]').forEach(item => {
      if (parseInt(item.dataset.kidx) === idx) item.remove()
    })
    markDirty(true)
  }
}

async function testKeyRow(id, idx, btn) {
  if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
  try {
    const inp = document.getElementById('k-' + id + '-' + idx)
    const urlInp = document.getElementById('url-' + id)
    const k = inp ? inp.value.trim() : ''
    const url = urlInp ? urlInp.value.trim() : ''
    if (!k) { toast('请输入 API Key', 'error'); return }
    const apiType = document.getElementById('at-' + id).value
    const tr = document.getElementById('tr-' + id)
    showSpinner(tr)
    const result = await testKeyConnection(url, apiType, k, id)
    showResult(tr, result.success, result.success ? '' : 'HTTP ' + result.status)
    if (result.success && result.data) {
      showEditModelsList(id, result.data.data || [])
    }
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
  }
}

async function fetchEditModels(id, btn) {
  if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
  try {
    const urlInp = document.getElementById('url-' + id)
    const url = urlInp ? urlInp.value.trim() : ''
    const keys = getKeys(id)
    const apiKey = keys.length > 0 ? keys[0].key : ''
    const apiType = document.getElementById('at-' + id).value
    const tr = document.getElementById('tr-' + id)
    showSpinner(tr)
    const result = await testKeyConnection(url, apiType, apiKey, id)
    showResult(tr, result.success, result.success ? '' : escapeHtml(result.message || '获取模型失败'))
    if (result.success && result.data) {
      showEditModelsList(id, result.data.data || [])
    }
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
  }
}

function showEditModelsList(id, models) {
  const cid = 'mel-' + id
  let el = document.getElementById(cid)
  if (!el) {
    const keysFs = document.getElementById('keys-' + id).closest('fieldset')
    el = document.createElement('aside')
    el.id = cid
    el.className = 'mdl-list-panel'
    el.innerHTML = modelPanelHeading(cid, id) + '<div id="melc-' + id + '"></div>'
    keysFs.insertAdjacentElement('afterend', el)
  }
  el.classList.remove('hd')
  document.getElementById('melc-' + id).innerHTML = renderModelGrid(models, id, id)
}

function addMdlToEdit(id, mid) {
  document.getElementById('nmid-' + id).value = mid
  addMdl(id)
}

function filterAdminModels(target) {
  var pId = typeof target === 'string' ? target : (target ? target.getAttribute('data-pid') : '');
  if (!pId) return;
  var input = document.getElementById('msearch-' + pId);
  var container = document.getElementById('ml-' + pId);
  if (!input || !container) return;
  var q = input.value.trim().toLowerCase();
  var rows = container.querySelectorAll('.model-single-row');
  var matchCount = 0;
  rows.forEach(function(row) {
    var midInput = row.querySelector('.model-id-input');
    var catSelect = row.querySelector('.select-xs');
    var textToSearch = '';
    if (midInput) textToSearch += midInput.value.toLowerCase() + ' ';
    if (catSelect) textToSearch += catSelect.value.toLowerCase() + ' ';
    textToSearch += row.textContent.toLowerCase();

    if (!q || textToSearch.includes(q)) {
      row.classList.remove('hd');
      row.style.display = '';
      matchCount++;
    } else {
      row.classList.add('hd');
      row.style.display = 'none';
    }
  });

  var countHint = document.getElementById('mcnt-' + pId);
  if (!countHint) {
    countHint = document.createElement('div');
    countHint.id = 'mcnt-' + pId;
    countHint.style.fontSize = '11px';
    countHint.style.color = 'var(--color-muted)';
    countHint.style.margin = '4px 0 8px 0';
    input.parentNode.insertAdjacentElement('afterend', countHint);
  }
  if (q) {
    countHint.textContent = '已筛选出 ' + matchCount + ' / ' + rows.length + ' 个模型';
    countHint.style.display = '';
  } else {
    countHint.style.display = 'none';
  }
}

function getMdl(id) {
  const c = document.getElementById('ml-' + id)
  if (!c) return []
  const items = c.querySelectorAll('[data-idx]')
  const seen = new Set()
  var pObj = (typeof draftProviders !== 'undefined' && Array.isArray(draftProviders)) ? draftProviders.find(function(x) { return x.id === id; }) : null;
  var oldModelsMap = {};
  if (pObj && pObj.models) {
    pObj.models.forEach(function(m) { if (m && m.id) oldModelsMap[m.id] = m; });
  }

  return Array.from(items).map(item => {
    const idx = parseInt(item.dataset.idx)
    const inp = document.getElementById('mid-' + id + '-' + idx)
    const chk = document.getElementById('men-' + id + '-' + idx)
    const catSel = item.querySelector('select')
    const mid = inp ? inp.value.trim() : ''
    if (!mid) return null
    if (seen.has(mid)) {
      item.remove()
      return null
    }
    seen.add(mid)
    const en = chk ? chk.checked : true
    const cat = catSel ? catSel.value : '文本'

    var old = oldModelsMap[mid] || {};
    return Object.assign({}, old, { id: mid, enabled: en, category: cat });
  }).filter(Boolean)
}

function addMdl(id) {
  const inp = document.getElementById('nmid-' + id), mid = inp ? inp.value.trim() : ''
  if (!mid) { toast('请输入模型 ID', 'error'); return }
  
  // Check duplicate
  const inputs = document.querySelectorAll('#ml-' + id + ' input[id^="mid-"]');
  for (const input of Array.from(inputs)) {
    if (input.value.trim() === mid) {
      toast('模型 ' + mid + ' 已在配置中，已自动剔除重复项', 'warning');
      if (inp) inp.value = '';
      return;
    }
  }

  const c = document.getElementById('ml-' + id)
  let maxIdx = -1
  c.querySelectorAll('[data-idx]').forEach(item => {
    const idx = parseInt(item.dataset.idx || '-1', 10)
    if (idx > maxIdx) maxIdx = idx
  })
  const cnt = maxIdx + 1

  const catSelect = '<select class="select-xs" style="padding:2px 6px;font-size:11px;border-radius:4px;" onchange="updateModelCatBtn(this)" data-pid="' + escapeHtml(id) + '" data-mid="' + escapeHtml(mid) + '" title="修改智能分类">' +
    '<option value="文本" selected>文本</option>' +
    '<option value="绘图">绘图</option>' +
    '<option value="多模态">多模态</option>' +
    '<option value="其他">其他</option>' +
    '</select>';

  const statusBadge = '<span class="bd bd-on" style="padding:2px 6px;font-size:11px;border-radius:4px;"><i class="fas fa-check-circle"></i> 正常</span>';

  const d = document.createElement('div')
  d.className = 'model-single-row'
  d.setAttribute('data-idx', cnt)
  d.innerHTML = '<div class="model-row-line-1">' +
    '<input type="text" value="' + escapeHtml(mid) + '" class="model-id-input" id="mid-' + escapeHtml(id) + '-' + cnt + '" placeholder="模型 ID">' +
    '<div class="model-row-actions-1">' +
      '<label class="tg" title="启用模型"><input type="checkbox" checked id="men-' + escapeHtml(id) + '-' + cnt + '" onchange="markDirty(true)"><span class="sl"></span></label>' +
      '<button class="icon-btn" onclick="rmMdlBtn(this)" data-pid="' + escapeHtml(id) + '" data-idx="' + cnt + '" title="移除模型" aria-label="移除模型"><i class="fas fa-times" aria-hidden="true"></i></button>' +
    '</div>' +
  '</div>' +
  '<div class="model-row-line-2">' +
    catSelect +
    statusBadge +
    '<span id="lat-' + escapeHtml(id) + '-' + cnt + '" class="latency-chip" title="模型通信延迟"><i class="fas fa-gauge-high"></i> <span class="lat-val">-- ms</span></span>' +
    '<button class="icon-btn test-mdl-btn" onclick="testMdlBtn(this)" data-pid="' + escapeHtml(id) + '" data-mid="' + escapeHtml(mid) + '" data-idx="' + cnt + '" title="单独测试模型延迟" aria-label="测试模型延迟"><i class="fas fa-gauge-high" aria-hidden="true"></i></button>' +
  '</div>';
  c.appendChild(d)
  inp.value = ''
  markDirty(true)
  filterAdminModels(id)
}

function rmMdl(id, idx) {
  const c = document.getElementById('ml-' + id)
  if (c) {
    c.querySelectorAll('[data-idx]').forEach(item => {
      if (parseInt(item.dataset.idx) === idx) item.remove()
    })
    markDirty(true)
    filterAdminModels(id)
  }
}

async function testMdl(id, mid, idx, btn) {
  if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
  const row = btn ? btn.closest('.model-single-row') : null;
  const latEl = row ? row.querySelector('.latency-chip') : document.getElementById('lat-' + id + '-' + idx);
  if (latEl) {
    latEl.className = 'latency-chip lat-loading';
    latEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 测速中';
  }
  try {
    const tr = document.getElementById('tr-' + id)
    if (tr) showSpinner(tr)
    const r = await fetch('/admin/api/providers/' + encodeURIComponent(id) + '/test-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId: mid })
    })
    const d = await r.json()
    if (d.success && d.data) {
      const latencyMs = d.data.latencyMs || 0;
      if (d.data.success) {
        if (latEl) {
          latEl.className = 'latency-chip lat-ok';
          latEl.innerHTML = '<i class="fas fa-bolt"></i> ' + latencyMs + ' ms';
        }
        if (tr) showResult(tr, true, mid + ' 响应: ' + latencyMs + ' ms')
        toast(mid + ' 测速成功: ' + latencyMs + ' ms', 'success')
      } else {
        if (latEl) {
          latEl.className = 'latency-chip lat-err';
          latEl.innerHTML = '<i class="fas fa-exclamation-triangle"></i> 失败 (' + (latencyMs ? latencyMs + 'ms' : '超时') + ')';
        }
        if (tr) showResult(tr, false, d.data.message || '连接失败')
        toast(mid + ' 测试失败: ' + (d.data.message || '连接错误'), 'error')
      }

      // 动态更新 OpenClaw 适合度标注
      if (d.data.openclaw && d.data.openclaw.tested) {
        var isCompat = d.data.openclaw.compatible;
        var reason = d.data.openclaw.reason || (isCompat ? '适合 OpenClaw (支持 Tool 与智能体交互)' : '不适合 OpenClaw (不支持 Tool 或非代码模型)');
        var badgeHtml = isCompat
          ? '<span class="openclaw-badge openclaw-badge--ok" title="' + escapeHtml(reason) + '"><i class="fas fa-robot"></i> OpenClaw 适合</span>'
          : '<span class="openclaw-badge openclaw-badge--no" title="' + escapeHtml(reason) + '"><i class="fas fa-ban"></i> OpenClaw 不适合</span>';

        if (row) {
          var existingBadge = row.querySelector('.openclaw-badge');
          if (existingBadge) {
            existingBadge.outerHTML = badgeHtml;
          } else {
            var line2 = row.querySelector('.model-row-line-2');
            if (line2) {
              var testBtn = line2.querySelector('.test-mdl-btn');
              if (testBtn) {
                testBtn.insertAdjacentHTML('beforebegin', badgeHtml);
              } else {
                line2.insertAdjacentHTML('beforeend', badgeHtml);
              }
            }
          }
        }

        // 同步至内存 draftProviders
        if (typeof draftProviders !== 'undefined' && Array.isArray(draftProviders)) {
          var pObj = draftProviders.find(function(item) { return item.id === id; });
          if (pObj && pObj.models) {
            var mObj = pObj.models.find(function(m) { return m.id === mid; });
            if (mObj) {
              mObj.openclawTested = true;
              mObj.openclawCompatible = isCompat;
              mObj.openclawReason = reason;
              mObj.openclawTestedAt = Date.now();
            }
          }
        }
      }
    } else {
      if (latEl) {
        latEl.className = 'latency-chip lat-err';
        latEl.innerHTML = '<i class="fas fa-exclamation-triangle"></i> 失败';
      }
      if (tr) showResult(tr, false, d.message || '测试失败')
      toast('测试失败: ' + (d.message || '未知错误'), 'error')
    }
  } catch (e) {
    if (latEl) {
      latEl.className = 'latency-chip lat-err';
      latEl.innerHTML = '<i class="fas fa-exclamation-triangle"></i> 请求错误';
    }
    toast('网络请求失败', 'error')
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
  }
}

async function testAllModelsInProviderBtn(btn) {
  var pId = btn.dataset.pid;
  if (!pId) return;
  btn.disabled = true;
  btn.style.opacity = '0.6';
  toast('开始批量探测模型通信与 OpenClaw 适合度...', 'info');
  try {
    var c = document.getElementById('ml-' + pId);
    if (!c) return;
    var testBtns = c.querySelectorAll('.test-mdl-btn');
    for (var i = 0; i < testBtns.length; i++) {
      var b = testBtns[i];
      var idx = b.getAttribute('data-idx') || b.dataset.idx || String(i);
      var inp = document.getElementById('mid-' + pId + '-' + idx);
      var mid = (inp && inp.value.trim()) ? inp.value.trim() : (b.getAttribute('data-mid') || b.dataset.mid || '');
      if (mid) {
        await testMdl(pId, mid, parseInt(idx, 10), b);
        // 温和节流延时，防止触发 Cloudflare 1015 / 429 限流
        if (i < testBtns.length - 1) {
          await new Promise(function(r) { setTimeout(r, 260); });
        }
      }
    }
    toast('提供商 ' + pId + ' 模型探测已完成', 'success');
  } finally {
    btn.disabled = false;
    btn.style.opacity = '1';
  }
}

function save(id, btn) {
  if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; }
  try {
    var p = draftProviders.find(function(item) { return item.id === id; });
    if (!p) return;
    var nmInp = document.getElementById('nm-' + id);
    var urlInp = document.getElementById('url-' + id);
    var atInp = document.getElementById('at-' + id);
    var enInp = document.getElementById('en-' + id);

    p.name = nmInp ? nmInp.value.trim() : p.name;
    p.baseUrl = urlInp ? urlInp.value.trim() : p.baseUrl;
    p.apiType = atInp ? atInp.value : p.apiType;
    p.apiKeys = getKeys(id);
    p.models = getMdl(id);
    p.enabled = enInp ? enInp.checked : p.enabled;
    p.updatedAt = new Date().toISOString();

    markDirty(true);
    renderProviderList();
    toast('已暂存 [' + id + '] 的修改，点击【统一保存】后写入 KV', 'success');
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
  }
}

async function del(id) {
  if (!(await cM('确定要删除此提供商？'))) return;
  draftProviders = draftProviders.filter(function(p) { return p.id !== id; });
  markDirty(true);
  renderProviderList();
  toast('已删除提供商（暂存内存，需点击【统一保存】写入 KV）', 'success');
}

function togglePb(id, checked) {
  var p = draftProviders.find(function(item) { return item.id === id; });
  if (p) {
    p.enabled = checked;
    markDirty(true);
    var pi = document.querySelector('.pi[data-id="' + id + '"]');
    if (pi) {
      var b = pi.querySelector('.ps .bd');
      if (b) { b.textContent = checked ? '已启用' : '未启用'; b.className = 'bd ' + (checked ? 'bd-on' : 'bd-off'); }
    }
    toast('已调整启用状态（暂存内存，点击【统一保存】写入 KV）', 'success');
  }
}

// proxy keys
async function genKey() {
  const name = await pM('输入 Key 名称（可选）')
  if (name === null) return
  showM('<h3><i class="fas fa-key c-p"></i> 生成转发 Key</h3><div class="fg"><label>有效期</label><select id="exp"><option value="30d">30 天</option><option value="90d">90 天</option><option value="180d">180 天</option><option value="1y">1 年</option><option value="forever" selected>永久</option></select></div><div class="fa"><button class="btn btn-s" id="gKc">取消</button><button class="btn btn-p" id="gKo">生成</button></div>')
  document.getElementById('gKc').addEventListener('click', closeM)
  document.getElementById('gKo').addEventListener('click', function() { doGenKey(document.getElementById('exp').value, name) })
}

function doGenKey(exp, name) {
  closeM();
  var nm = name || ('Key-' + new Date().toLocaleDateString());
  var id = 'pk_' + Math.random().toString(36).substring(2, 10);
  var randomStr = Array.from({length: 24}, function() { return Math.floor(Math.random() * 16).toString(16); }).join('');
  var key = 'sk-cf-' + randomStr;

  var expiresAt = null;
  var now = Date.now();
  if (exp === '30d') expiresAt = new Date(now + 30 * 86400 * 1000).toISOString();
  else if (exp === '90d') expiresAt = new Date(now + 90 * 86400 * 1000).toISOString();
  else if (exp === '180d') expiresAt = new Date(now + 180 * 86400 * 1000).toISOString();
  else if (exp === '1y') expiresAt = new Date(now + 365 * 86400 * 1000).toISOString();

  draftProxyKeys.push({
    id: id,
    key: key,
    name: nm,
    enabled: true,
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt
  });

  markDirty(true);
  renderProxyKeyList();
  showM('<h3><i class="fas fa-check-circle c-s"></i> 生成成功（已存内存）</h3><p>请妥善保存此 Key（需点击【统一保存】写入 KV）：</p><div class="mk">' + key + '</div><div class="fa"><button class="btn btn-p" onclick="closeM()">确定</button></div>');
}

async function rmKey(id) {
  if (!(await cM('确定要删除此 Key？'))) return;
  draftProxyKeys = draftProxyKeys.filter(function(k) { return k.id !== id; });
  markDirty(true);
  renderProxyKeyList();
  toast('已删除转发 Key（暂存内存，点击【统一保存】后生效）', 'success');
}

function toggleProxyKey(id, checked) {
  var k = draftProxyKeys.find(function(item) { return item.id === id; });
  if (k) {
    k.enabled = checked;
    markDirty(true);
    var ki = document.querySelector('.ki[data-id="' + id + '"]');
    if (ki) {
      var b = ki.querySelector('.key-actions .bd');
      if (b) { b.textContent = checked ? '已启用' : '已禁用'; b.className = 'bd ' + (checked ? 'bd-on' : 'bd-off'); }
    }
    toast('已调整 Key 状态（暂存内存，点击【统一保存】写入 KV）', 'success');
  }
}

function toggleKeyVis(id) {
  const el = document.getElementById('kv-' + id)
  if (!el) return
  const full = el.dataset.full
  const vis = el.dataset.vis === '1'
  if (vis) {
    el.textContent = full.length > 12
      ? full.substring(0, 8) + '*****' + full.substring(full.length - 4)
      : full
    el.dataset.vis = '0'
  } else {
    el.textContent = full
    el.dataset.vis = '1'
  }
}

function renderProviderList() {
  const container = document.getElementById('plist');
  if (!container) return;

  var openIds = [];
  var searchQueries = {};
  container.querySelectorAll('.pd.open').forEach(function(el) {
    var id = el.id ? el.id.replace('dt-', '') : null;
    if (id) {
      openIds.push(id);
      var sq = document.getElementById('msearch-' + id);
      if (sq && sq.value) searchQueries[id] = sq.value;
    }
  });

  if (!draftProviders || draftProviders.length === 0) {
    container.innerHTML = '<div class="empty-state"><i class="fas fa-server" aria-hidden="true"></i><h3>还没有提供商</h3><p>添加第一个上游提供商，配置 API 地址、Key 和模型。</p><button class="btn btn-p" onclick="showAdd()">添加提供商</button></div>';
    return;
  }

  container.innerHTML = draftProviders.map(function(p) {
    var pName = escapeHtml(p.name || '');
    var pId = escapeHtml(p.id || '');
    var pUrl = escapeHtml(p.baseUrl || '');
    var pApiType = p.apiType || 'openai';
    var isAnthropic = pApiType === 'anthropic';
    var isEnabled = p.enabled !== false;
    var keysArr = p.apiKeys || [];
    var modelsArr = p.models || [];

    var statusChipsHtml = '';
    var abnormalCount = 0;
    var permCount = 0;
    var cooldownCount = 0;
    var warningCount = 0;
    var disabledCount = 0;

    modelsArr.forEach(function(m) {
      var isPermDisabled = !!m.permanentlyDisabled;
      var isCooldown = m.cooldownUntil && Date.now() < m.cooldownUntil;
      var failCount = m.failureCount || 0;

      if (isPermDisabled) {
        permCount++;
        abnormalCount++;
      } else if (isCooldown) {
        cooldownCount++;
        abnormalCount++;
      } else if (failCount > 0) {
        warningCount++;
        abnormalCount++;
      } else if (m.enabled === false) {
        disabledCount++;
      }
    });

    if (permCount > 0) {
      statusChipsHtml += '<span class="abnormal-model-chip" style="background:#fee2e2;color:#b91c1c;border:1px solid #fca5a5;padding:1px 5px;font-size:10px;border-radius:4px;margin-left:4px;font-weight:600;display:inline-flex;align-items:center;gap:2px;" title="' + permCount + ' 个模型永久失效"><i class="fas fa-ban" style="font-size:9px;"></i>' + permCount + ' 永久失效</span>';
    }
    if (cooldownCount > 0) {
      statusChipsHtml += '<span class="abnormal-model-chip" style="background:#fef9c3;color:#854d0e;border:1px solid #fef08a;padding:1px 5px;font-size:10px;border-radius:4px;margin-left:4px;font-weight:600;display:inline-flex;align-items:center;gap:2px;" title="' + cooldownCount + ' 个模型冷却中"><i class="fas fa-hourglass-half" style="font-size:9px;"></i>' + cooldownCount + ' 冷却中</span>';
    }
    if (warningCount > 0) {
      statusChipsHtml += '<span class="abnormal-model-chip" style="background:#ffedd5;color:#c2410c;border:1px solid #fed7aa;padding:1px 5px;font-size:10px;border-radius:4px;margin-left:4px;font-weight:600;display:inline-flex;align-items:center;gap:2px;" title="' + warningCount + ' 个模型存在失败警告"><i class="fas fa-exclamation-triangle" style="font-size:9px;"></i>' + warningCount + ' 警告</span>';
    }
    if (disabledCount > 0) {
      statusChipsHtml += '<span class="abnormal-model-chip" style="background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;padding:1px 5px;font-size:10px;border-radius:4px;margin-left:4px;font-weight:600;display:inline-flex;align-items:center;gap:2px;text-decoration:line-through;" title="' + disabledCount + ' 个模型已手动禁用"><i class="fas fa-minus-circle" style="font-size:9px;"></i>' + disabledCount + ' 禁用</span>';
    }

    var keysHtml = keysArr.map(function(k, ki) {
      return '<div class="fc mb-3 field-row" data-kidx="' + ki + '">' +
        '<input type="text" value="' + escapeHtml(k.key || '') + '" class="fx1" id="k-' + pId + '-' + ki + '" placeholder="API Key" aria-label="API Key">' +
        '<label class="tg"><input type="checkbox" ' + (k.enabled ? 'checked' : '') + ' id="ken-' + pId + '-' + ki + '" onchange="markDirty(true)" aria-label="启用 Key"><span class="sl"></span></label>' +
        '<button class="icon-btn" onclick="copyRowVal(this)" title="复制 Key" aria-label="复制 Key"><i class="far fa-copy" aria-hidden="true"></i></button>' +
        '<button class="icon-btn" onclick="testKeyRowBtn(this)" data-pid="' + pId + '" data-kidx="' + ki + '" title="测试 Key" aria-label="测试 Key"><i class="fas fa-plug" aria-hidden="true"></i></button>' +
        '<button class="icon-btn" onclick="rmKeyRowBtn(this)" data-pid="' + pId + '" data-kidx="' + ki + '" title="移除 Key" aria-label="移除 Key"><i class="fas fa-times" aria-hidden="true"></i></button>' +
        '</div>';
    }).join('');

    var modelsHtml = modelsArr.map(function(m, mi) {
      var mId = escapeHtml(m.id || '');
      var mCat = m.category || '文本';
      var isPermDisabled = !!m.permanentlyDisabled;
      var permReason = m.disabledReason || '受上游故障影响永久失效';
      var isCooldown = m.cooldownUntil && Date.now() < m.cooldownUntil;
      var cooldownSec = isCooldown ? Math.ceil((m.cooldownUntil - Date.now()) / 1000) : 0;
      var failCount = m.failureCount || 0;

      var styleAttr = '';
      var titleText = '模型 ID';
      var statusBadge = '';
      var unblockBtn = '';
      if (isPermDisabled) {
        styleAttr = 'style="color: #ef4444; border-color: #fca5a5; font-weight: 600; background-color: #fef2f2;"';
        titleText = '永久失效: ' + escapeHtml(permReason);
        statusBadge = '<span class="bd" style="background:#fef2f2;color:#dc2626;border:1px solid #fecaca;padding:2px 6px;font-size:11px;border-radius:4px;font-weight:600;" title="' + escapeHtml(permReason) + '"><i class="fas fa-ban"></i> 永久失效 (' + failCount + '/3)</span>';
        unblockBtn = '<button class="btn btn-s btn-xs" style="padding:2px 6px;font-size:11px;" onclick="unblockModelBtn(this)" data-pid="' + pId + '" data-mid="' + mId + '" title="一键解封并恢复状态"><i class="fas fa-unlock"></i> 解封恢复</button>';
      } else if (isCooldown) {
        styleAttr = 'style="border-color: #fcd34d; background-color: #fffbeb;"';
        titleText = '因异常进入冷却状态';
        statusBadge = '<span class="bd" style="background:#fefce8;color:#ca8a04;border:1px solid #fef08a;padding:2px 6px;font-size:11px;border-radius:4px;font-weight:600;" title="因异常进入冷却状态"><i class="fas fa-hourglass-half"></i> 冷却中 (' + cooldownSec + 's)</span>';
        unblockBtn = '<button class="btn btn-s btn-xs" style="padding:2px 6px;font-size:11px;" onclick="unblockModelBtn(this)" data-pid="' + pId + '" data-mid="' + mId + '" title="重置冷却状态"><i class="fas fa-redo"></i> 重置冷却</button>';
      } else if (failCount > 0) {
        styleAttr = 'style="border-color: #ffedd5; background-color: #fffaf0;"';
        titleText = '曾出现探测或业务异常';
        statusBadge = '<span class="bd" style="background:#fff7ed;color:#ea580c;border:1px solid #ffedd5;padding:2px 6px;font-size:11px;border-radius:4px;font-weight:600;" title="曾出现探测或业务异常"><i class="fas fa-exclamation-triangle"></i> 警告 (失败 ' + failCount + '/3)</span>';
        unblockBtn = '<button class="btn btn-s btn-xs" style="padding:2px 6px;font-size:11px;" onclick="unblockModelBtn(this)" data-pid="' + pId + '" data-mid="' + mId + '" title="清零失败计数"><i class="fas fa-check"></i> 清零恢复</button>';
      } else if (m.enabled !== false) {
        statusBadge = '<span class="bd bd-on" style="padding:2px 6px;font-size:11px;border-radius:4px;"><i class="fas fa-check-circle"></i> 正常</span>';
      } else {
        styleAttr = 'style="color: #64748b; border-color: #cbd5e1; background-color: #f1f5f9; text-decoration: line-through;"';
        titleText = '模型已手动禁用';
        statusBadge = '<span class="bd bd-off" style="padding:2px 6px;font-size:11px;border-radius:4px;"><i class="fas fa-minus-circle"></i> 已禁用</span>';
      }

      var openclawBadge = m.openclawTested
        ? (m.openclawCompatible
            ? '<span class="openclaw-badge openclaw-badge--ok" title="' + escapeHtml(m.openclawReason || '适合 OpenClaw (支持 Tool 与智能体交互)') + '"><i class="fas fa-robot"></i> OpenClaw 适合</span>'
            : '<span class="openclaw-badge openclaw-badge--no" title="' + escapeHtml(m.openclawReason || '不适合 OpenClaw (不支持 Tool 或非代码模型)') + '"><i class="fas fa-ban"></i> OpenClaw 不适合</span>')
        : '';

      var catSelect = '<select class="select-xs" style="padding:2px 6px;font-size:11px;border-radius:4px;" onchange="updateModelCatBtn(this)" data-pid="' + pId + '" data-mid="' + mId + '" title="修改智能分类">' +
        '<option value="文本" ' + (mCat === '文本' ? 'selected' : '') + '>文本</option>' +
        '<option value="绘图" ' + (mCat === '绘图' ? 'selected' : '') + '>绘图</option>' +
        '<option value="多模态" ' + (mCat === '多模态' ? 'selected' : '') + '>多模态</option>' +
        '<option value="其他" ' + (mCat === '其他' ? 'selected' : '') + '>其他</option>' +
        '</select>';

      return '<div class="model-single-row" data-idx="' + mi + '">' +
        '<div class="model-row-line-1">' +
          '<input type="text" value="' + mId + '" class="model-id-input" id="mid-' + pId + '-' + mi + '" placeholder="模型 ID" ' + styleAttr + ' title="' + titleText + '">' +
          '<div class="model-row-actions-1">' +
            '<label class="tg" title="启用模型"><input type="checkbox" ' + (m.enabled !== false ? 'checked' : '') + ' id="men-' + pId + '-' + mi + '" onchange="markDirty(true)" aria-label="启用模型"><span class="sl"></span></label>' +
            '<button class="icon-btn" onclick="rmMdlBtn(this)" data-pid="' + pId + '" data-idx="' + mi + '" title="移除模型" aria-label="移除模型"><i class="fas fa-times" aria-hidden="true"></i></button>' +
          '</div>' +
        '</div>' +
        '<div class="model-row-line-2">' +
          catSelect +
          statusBadge +
          openclawBadge +
          '<span id="lat-' + pId + '-' + mi + '" class="latency-chip" title="模型通信延迟"><i class="fas fa-gauge-high"></i> <span class="lat-val">-- ms</span></span>' +
          unblockBtn +
          '<button class="icon-btn test-mdl-btn" onclick="testMdlBtn(this)" data-pid="' + pId + '" data-mid="' + mId + '" data-idx="' + mi + '" title="单独测试模型延迟" aria-label="测试模型延迟"><i class="fas fa-gauge-high" aria-hidden="true"></i></button>' +
        '</div>' +
        '</div>';
    }).join('');

    var pStatusClass = '';
    if (!modelsArr || modelsArr.length === 0) {
      pStatusClass = 'pi-red';
    } else {
      var allDisabled = modelsArr.every(function(m) {
        return m.enabled === false || !!m.permanentlyDisabled;
      });
      if (allDisabled) {
        pStatusClass = 'pi-red';
      } else {
        var hasAbnormal = modelsArr.some(function(m) {
          return m.enabled === false || !!m.permanentlyDisabled || (m.cooldownUntil && Date.now() < m.cooldownUntil);
        });
        if (hasAbnormal) {
          pStatusClass = 'pi-yellow';
        }
      }
    }

    var providerModelActions = '<div class="fc mb-3" style="gap:8px;flex-wrap:wrap;background:var(--color-paper);padding:8px 12px;border-radius:var(--radius-control);border:1px solid var(--color-rule);">' +
      '<button class="btn btn-s btn-xs" onclick="testAllModelsInProviderBtn(this)" data-pid="' + pId + '"><i class="fas fa-gauge-high"></i> 批量测模型延迟</button>' +
      '<button class="btn btn-s btn-xs" onclick="fetchUpstreamModelsBtn(this)" data-pid="' + pId + '"><i class="fas fa-cloud-download-alt"></i> 一键拉取上游模型</button>' +
      '<button class="btn btn-s btn-xs" onclick="showImportModalBtn(this)" data-pid="' + pId + '"><i class="fas fa-file-import"></i> 一键导入</button>' +
      (abnormalCount > 0 ? '<button class="btn btn-s btn-xs" onclick="resetAllModelsInProviderBtn(this)" data-pid="' + pId + '" style="color:#d97706;border-color:#fcd34d;"><i class="fas fa-sync-alt"></i> 一键重置本提供商所有模型异常</button>' : '') +
      '<button class="btn btn-d btn-xs" onclick="clearProviderModelsBtn(this)" data-pid="' + pId + '"><i class="fas fa-trash-alt"></i> 一键删除全部本提供商模型</button>' +
      '</div>' +
      '<div class="search-field mb-3" style="position:relative;">' +
      '<i class="fas fa-search" aria-hidden="true" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--color-muted);font-size:12px;"></i>' +
      '<input type="search" id="msearch-' + pId + '" data-pid="' + pId + '" placeholder="搜索本提供商中的模型 ID 或分类..." oninput="filterAdminModels(this)" autocomplete="off" style="padding-left:30px;font-size:12px;height:32px;width:100%;box-sizing:border-box;border-radius:var(--radius-control);border:1px solid var(--color-rule);background:var(--color-paper);" class="fx1">' +
      '</div>';

    var opencodeBtn = pId === 'opencode'
      ? '<button class="btn btn-s" onclick="fetchEditModelsBtn(this)" data-pid="' + pId + '"><i class="fas fa-download" aria-hidden="true"></i>获取模型</button>'
      : '';

    return '<article class="pi ' + pStatusClass + '" data-id="' + pId + '">' +
      '<div class="ps" onclick="togBtn(this)" data-pid="' + pId + '" role="button" tabindex="0" onkeydown="togKey(event,this)" aria-controls="dt-' + pId + '">' +
        '<div class="l"><i class="fas fa-chevron-right provider-chevron" aria-hidden="true" id="ch-' + pId + '"></i><span class="provider-avatar" aria-hidden="true">' + escapeHtml((pName.charAt(0) || 'A').toUpperCase()) + '</span><div><h3>' + pName + '</h3><div class="pu"><code>' + pId + '</code><span>' + (isAnthropic ? 'Anthropic' : 'OpenAI') + '</span><span>' + keysArr.length + ' Keys</span><span>' + modelsArr.length + ' 模型</span>' + statusChipsHtml + '</div></div></div>' +
        '<div class="fc fx-s0" onclick="event.stopPropagation()"><label class="tg"><input type="checkbox" ' + (isEnabled ? 'checked' : '') + ' id="en-' + pId + '" onchange="togglePbBtn(this)" data-pid="' + pId + '" aria-label="启用 ' + pName + '"><span class="sl"></span></label><span class="bd ' + (isEnabled ? 'bd-on' : 'bd-off') + '">' + (isEnabled ? '已启用' : '未启用') + '</span></div>' +
      '</div>' +
      '<div class="pd" id="dt-' + pId + '">' +
        '<div class="detail-heading"><div><h3>编辑 ' + pName + '</h3><p>修改暂存在内存中，点击顶部【统一保存】落盘写入 KV。</p></div><span class="protocol-chip">' + (isAnthropic ? 'ANTHROPIC' : 'OPENAI') + '</span></div>' +
        '<div class="fr"><div class="fg"><label>名称</label><input type="text" id="nm-' + pId + '" value="' + pName + '" oninput="markDirty(true)"></div><div class="fg"><label>ID</label><input type="text" value="' + pId + '" disabled></div></div>' +
        '<div class="fg"><label>API 地址</label><input type="url" id="url-' + pId + '" value="' + pUrl + '" oninput="markDirty(true)"></div>' +
        '<div class="fg"><label>API 格式</label><select id="at-' + pId + '" class="select-sm" onchange="markDirty(true)"><option value="openai" ' + (!isAnthropic ? 'selected' : '') + '>OpenAI 兼容</option><option value="anthropic" ' + (isAnthropic ? 'selected' : '') + '>Anthropic 兼容</option></select></div>' +
        '<fieldset class="form-group"><legend>上游 API Keys</legend><div id="keys-' + pId + '">' + keysHtml + '</div><div class="fc mt-1 field-row"><input type="text" id="nk-' + pId + '" placeholder="新的 API Key" class="fx1"><button class="btn btn-s btn-xs" onclick="addKeyRowBtn(this)" data-pid="' + pId + '"><i class="fas fa-plus" aria-hidden="true"></i>添加</button></div></fieldset>' +
        '<fieldset class="form-group"><legend>模型</legend>' + providerModelActions + '<div id="ml-' + pId + '">' + modelsHtml + '</div><div class="fc mt-1 field-row"><input type="text" id="nmid-' + pId + '" placeholder="新的模型 ID" class="fx1"><button class="btn btn-s btn-xs" onclick="addMdlBtn(this)" data-pid="' + pId + '"><i class="fas fa-plus" aria-hidden="true"></i>添加</button></div></fieldset>' +
        '<div class="detail-actions"><div id="tr-' + pId + '" aria-live="polite"></div><div>' + opencodeBtn + '<button class="btn btn-d" onclick="delBtn(this)" data-pid="' + pId + '"><i class="fas fa-trash" aria-hidden="true"></i>删除</button><button class="btn btn-p" onclick="saveBtn(this)" data-pid="' + pId + '"><i class="fas fa-save" aria-hidden="true"></i>暂存更改</button></div></div>' +
      '</div>' +
    '</article>';
  }).join('');

  openIds.forEach(function(pId) {
    var d = document.getElementById('dt-' + pId);
    var c = document.getElementById('ch-' + pId);
    if (d && c) {
      d.classList.add('open');
      c.style.transform = 'rotate(90deg)';
      var card = d.closest('.pi');
      if (card) card.classList.add('open');
    }
  });

  Object.keys(searchQueries).forEach(function(pId) {
    var sq = document.getElementById('msearch-' + pId);
    if (sq) {
      sq.value = searchQueries[pId];
      filterAdminModels(pId);
    }
  });
}

function renderProxyKeyList() {
  const container = document.querySelector('.key-list');
  if (!container) return;

  if (!draftProxyKeys || draftProxyKeys.length === 0) {
    container.innerHTML = '<div class="empty-state"><i class="fas fa-key" aria-hidden="true"></i><h3>暂无转发 Key</h3><p>生成一个 Key 后，客户端才能访问网关。</p><button class="btn btn-p" onclick="genKey()">生成转发 Key</button></div>';
    return;
  }

  container.innerHTML = draftProxyKeys.map(function(k) {
    var kId = escapeHtml(k.id || '');
    var kVal = escapeHtml(k.key || '');
    var kName = escapeHtml(k.name || '');
    var isEnabled = k.enabled !== false;
    var masked = kVal.length > 12 ? kVal.substring(0, 8) + '*****' + kVal.substring(kVal.length - 4) : kVal;

    return '<article class="ki" data-id="' + kId + '">' +
      '<div class="key-main"><span class="key-icon" aria-hidden="true"><i class="fas fa-key"></i></span><div>' +
        '<div class="kv"><span id="kv-' + kId + '" data-full="' + kVal + '" data-vis="0">' + masked + '</span>' +
        '<button class="icon-btn" onclick="toggleKeyVisBtn(this)" data-id="' + kId + '" title="显示或隐藏" aria-label="显示或隐藏 Key"><i class="far fa-eye" aria-hidden="true"></i></button>' +
        '<button class="icon-btn" onclick="copyText(this)" data-copy="' + kVal + '" title="复制" aria-label="复制 Key"><i class="far fa-copy" aria-hidden="true"></i></button></div>' +
        '<div class="key-meta"><h3>' + kName + '</h3><span class="key-meta__sep" aria-hidden="true">-</span><p>创建于 ' + (k.createdAt ? new Date(k.createdAt).toLocaleDateString() : '未知') + ' · ' + (k.expiresAt ? '有效至 ' + new Date(k.expiresAt).toLocaleDateString() : '永久有效') + '</p></div>' +
      '</div></div>' +
      '<div class="key-actions"><label class="tg"><input type="checkbox" ' + (isEnabled ? 'checked' : '') + ' onchange="toggleProxyKeyBtn(this)" data-id="' + kId + '" aria-label="启用 ' + kName + '"><span class="sl"></span></label><span class="bd ' + (isEnabled ? 'bd-on' : 'bd-off') + '">' + (isEnabled ? '已启用' : '已禁用') + '</span><button class="bd bd-del" onclick="rmKeyBtn(this)" data-id="' + kId + '"><i class="fas fa-trash" aria-hidden="true"></i>删除</button></div>' +
    '</article>';
  }).join('');
}

const adminNavLinks = Array.from(document.querySelectorAll('.admin-nav a[href^="#"]'))
function setActiveAdminNav(hash) {
  const targetHash = adminNavLinks.some(function (link) { return link.getAttribute('href') === hash }) ? hash : '#overview'
  adminNavLinks.forEach(function (link) {
    const active = link.getAttribute('href') === targetHash
    link.classList.toggle('is-active', active)
    if (active) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  })
  // 按需加载：仅当切换到 #logs 标签页时才加载日志，避免进后台卡顿
  if (targetHash === '#logs') {
    fetchLogs();
  }
}
adminNavLinks.forEach(function (link) {
  link.addEventListener('click', function () { setActiveAdminNav(link.getAttribute('href') || '#overview') })
})
window.addEventListener('hashchange', function () { setActiveAdminNav(location.hash) })
setActiveAdminNav(location.hash)

// 网关日志及调试模式前端逻辑 (支持手动按需刷新)

async function fetchLogs() {
  try {
    var res = await fetch('/admin/api/logs');
    var json = await res.json();
    if (json.success && json.data) {
      renderLogsTable(json.data.logs || []);
      var dbgToggle = document.getElementById('debug-mode-toggle');
      if (dbgToggle && typeof json.data.debugMode === 'boolean') {
        dbgToggle.checked = json.data.debugMode;
      }
    }
  } catch (err) {
    console.error('获取请求日志失败:', err);
  }
}

async function toggleDebugMode(checked) {
  try {
    var res = await fetch('/admin/api/debug-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        debugMode: checked,
      })
    });
    var json = await res.json();
    if (json.success) {
      toast(json.message, 'success');
      fetchLogs();
    } else {
      toast(json.message || '切换调试模式失败', 'error');
    }
  } catch (err) {
    toast('切换调试模式请求异常', 'error');
  }
}

async function clearAllLogs() {
  if (!(await cM('确定要清空所有网关请求日志？'))) return;
  try {
    var res = await fetch('/admin/api/logs', { method: 'DELETE' });
    var json = await res.json();
    if (json.success) {
      toast(json.message || '网关请求日志已清空', 'success');
      fetchLogs();
    } else {
      toast(json.message || '清空日志失败', 'error');
    }
  } catch (err) {
    toast('清空日志请求失败', 'error');
  }
}

function renderLogsTable(logs) {
  var badge = document.getElementById('logs-count-badge');
  if (badge) badge.textContent = logs.length;

  var container = document.getElementById('logs-panel');
  if (!container) return;

  if (!logs || logs.length === 0) {
    container.innerHTML = '<div class="empty-state"><i class="fas fa-list-alt" aria-hidden="true"></i><h3>暂无网关请求日志</h3><p>当客户端通过网关 <code>/v1</code> 接口发起调用时，请求日志将实时或批量显示在这里。</p></div>';
    return;
  }

  // 性能保护：仅渲染最新 50 条日志，避免大量 DOM 导致界面卡顿
  var displayLogs = logs.slice(0, 50);

  // 桌面端表格行
  var rowsHtml = displayLogs.map(function(item) {
    var isSuccess = item.status >= 200 && item.status < 300;
    var statusBadgeClass = isSuccess ? 'bd-on' : 'bd-off';
    var statusText = item.status || 500;
    var errText = item.error ? escapeHtml(item.error) : '-';
    var timeStr = escapeHtml(item.time || '-');
    var modelStr = escapeHtml(item.model || 'unknown');
    var latency = item.latency || 0;
    var latencyColor = latency < 1500 ? 'var(--color-success)' : (latency < 4000 ? '#eab308' : 'var(--color-danger)');
    var latencyStr = '<span style="color:' + latencyColor + ';font-weight:600;">' + latency + ' ms</span>';
    var keyMaskStr = item.keyMask ? '<code>' + escapeHtml(item.keyMask) + '</code>' : '<span style="color:var(--color-muted);">-</span>';
    var attemptStr = item.attemptIndex ? ('第 ' + item.attemptIndex + ' 次') : '-';
    var streamBadge = item.isStream ? '<span class="bd" style="padding:1px 4px;font-size:10px;background:#e0f2fe;color:#0369a1;border:1px solid #bae6fd;">流式</span>' : '<span class="bd" style="padding:1px 4px;font-size:10px;background:#f1f5f9;color:#64748b;border:1px solid #e2e8f0;">非流</span>';
    var ipBadge = item.clientIp ? '<span class="log-ip-badge"><i class="fas fa-network-wired" style="font-size:9px;color:var(--color-muted);"></i>' + escapeHtml(item.clientIp) + '</span>' : '<span style="color:var(--color-muted);font-size:11px;">-</span>';

    return '<tr>' +
      '<td style="padding:8px 10px;white-space:nowrap;font-size:var(--text-xs);color:var(--color-muted);">' + timeStr + '</td>' +
      '<td style="padding:8px 10px;white-space:nowrap;">' + ipBadge + '</td>' +
      '<td style="padding:8px 10px;"><code style="font-size:11.5px;">' + modelStr + '</code></td>' +
      '<td style="padding:8px 10px;white-space:nowrap;">' + keyMaskStr + '</td>' +
      '<td style="padding:8px 10px;white-space:nowrap;"><span class="bd ' + statusBadgeClass + '">' + statusText + '</span> ' + streamBadge + '</td>' +
      '<td style="padding:8px 10px;white-space:nowrap;font-family:var(--font-mono);font-size:var(--text-xs);">' + latencyStr + '</td>' +
      '<td style="padding:8px 10px;white-space:nowrap;font-size:var(--text-xs);color:var(--color-muted);">' + attemptStr + '</td>' +
      '<td style="padding:8px 10px;font-size:var(--text-xs);color:' + (isSuccess ? 'var(--color-muted)' : 'var(--color-danger)') + ';max-width:300px;word-break:break-all;">' + errText + '</td>' +
    '</tr>';
  }).join('');

  // 移动端卡片流
  var mobileCardsHtml = displayLogs.map(function(item) {
    var isSuccess = item.status >= 200 && item.status < 300;
    var statusBadgeClass = isSuccess ? 'bd-on' : 'bd-off';
    var statusText = item.status || 500;
    var timeStr = escapeHtml(item.time || '-');
    var modelStr = escapeHtml(item.model || 'unknown');
    var latency = item.latency || 0;
    var latencyColor = latency < 1500 ? 'var(--color-success)' : (latency < 4000 ? '#ca8a04' : 'var(--color-danger)');
    var streamBadge = item.isStream ? '<span class="bd" style="padding:1px 4px;font-size:10px;background:#e0f2fe;color:#0369a1;border:1px solid #bae6fd;">流式</span>' : '<span class="bd" style="padding:1px 4px;font-size:10px;background:#f1f5f9;color:#64748b;border:1px solid #e2e8f0;">非流</span>';
    var ipStr = item.clientIp ? '<span class="log-ip-badge"><i class="fas fa-network-wired" style="font-size:9px;"></i>' + escapeHtml(item.clientIp) + '</span>' : '';
    var keyStr = item.keyMask ? '<code>' + escapeHtml(item.keyMask) + '</code>' : '';
    var errBox = (!isSuccess && item.error) ? '<div style="margin-top:6px;padding:4px 8px;background:#fef2f2;border-radius:4px;color:var(--color-danger);font-size:11px;word-break:break-all;">' + escapeHtml(item.error) + '</div>' : '';

    return '<div class="log-mobile-card ' + (isSuccess ? 'is-ok' : 'is-err') + '">' +
      '<div class="log-mobile-header">' +
        '<span style="color:var(--color-muted);font-family:var(--font-mono);font-size:11px;"><i class="far fa-clock"></i> ' + timeStr + '</span>' +
        '<div><span class="bd ' + statusBadgeClass + '" style="font-size:10.5px;">' + statusText + '</span> ' + streamBadge + '</div>' +
      '</div>' +
      '<div class="log-mobile-route"><code>' + modelStr + '</code></div>' +
      '<div class="log-mobile-meta">' +
        ipStr +
        '<span style="color:' + latencyColor + ';font-weight:600;font-family:var(--font-mono);"><i class="fas fa-stopwatch"></i> ' + latency + ' ms</span>' +
        (item.attemptIndex ? '<span>第 ' + item.attemptIndex + ' 次</span>' : '') +
        keyStr +
      '</div>' +
      errBox +
    '</div>';
  }).join('');

  container.innerHTML = '<div class="logs-desktop-view table-wrap" style="overflow-x:auto;border:1px solid var(--color-rule);border-radius:var(--radius-panel);background:var(--color-paper);"><table class="data-table" style="width:100%;text-align:left;border-collapse:collapse;">' +
    '<thead><tr style="border-bottom:1px solid var(--color-rule);font-size:var(--text-xs);color:var(--color-muted);background:var(--color-paper-2);">' +
      '<th style="padding:10px 10px;">请求时间</th>' +
      '<th style="padding:10px 10px;">客户端 IP</th>' +
      '<th style="padding:10px 10px;">调度链路与模型</th>' +
      '<th style="padding:10px 10px;">API Key</th>' +
      '<th style="padding:10px 10px;">状态码</th>' +
      '<th style="padding:10px 10px;">响应耗时</th>' +
      '<th style="padding:10px 10px;">尝试轮次</th>' +
      '<th style="padding:10px 10px;">失败原因</th>' +
    '</tr></thead>' +
    '<tbody style="divide-y:1px solid var(--color-rule);">' + rowsHtml + '</tbody>' +
  '</table></div>' +
  '<div class="logs-mobile-view">' + mobileCardsHtml + '</div>';
}

// ===== 模型配套功能与探测任务客户端交互 =====

async function triggerProbe() {
  var btn = document.getElementById('btn-probe');
  if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; }
  toast('开始执行初始化与补位探测任务...', 'success');
  try {
    var res = await fetch('/admin/api/probe', { method: 'POST' });
    var data = await res.json();
    if (res.status === 429 || !data.success) {
      aM(data.message || '已有探测任务正在运行中，请稍后再试', 'error');
    } else {
      toast(data.message || '探测任务完成', 'success');
      var pRes = await fetch('/admin/api/providers');
      var pData = await pRes.json();
      if (pData.success && pData.data) {
        draftProviders = pData.data;
        renderProviderList();
      }
    }
  } catch (err) {
    aM('触发探测失败：' + ((err && err.message) || String(err)), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
  }
}

async function resetAllModels() {
  if (!(await cM('确定要一键重置所有模型到初始状态？\\n\\n所有模型的冷却状态、累计失败次数、永久失效/封禁标记都将被彻底清空，恢复至刚刚添加时的可用状态，并重新就绪动态梯队池。'))) return;
  try {
    toast('正在重置所有模型至初始状态...', 'info');
    var res = await fetch('/admin/api/reset-all-models', { method: 'POST' });
    var data = await res.json();
    if (data.success) {
      toast(data.message || '已成功将所有模型重置到初始状态！', 'success');
      if (Array.isArray(draftProviders)) {
        draftProviders.forEach(function(p) {
          if (Array.isArray(p.models)) {
            p.models.forEach(function(m) {
              m.cooldownUntil = null;
              m.failureCount = 0;
              m.permanentlyDisabled = false;
              m.disabledReason = null;
              m.permTestFailCount = 0;
              m.enabled = true;
            });
          }
        });
      }
      var pRes = await fetch('/admin/api/providers');
      var pData = await pRes.json();
      if (pData.success && pData.data) {
        draftProviders = pData.data;
      }
      renderProviderList();
      if (typeof loadTierData === 'function') {
        loadTierData();
      }
    } else {
      aM('重置所有模型失败：' + (data.message || '未知错误'), 'error');
    }
  } catch (err) {
    aM('请求网络异常：' + ((err && err.message) || String(err)), 'error');
  }
}
var resetCooldowns = resetAllModels;

async function testAllBlockedModels() {
  if (!(await cM('确定要对所有处于【永久封禁】状态的模型执行批量交叉复测？系统将按提供商交替轮抽并发探针测试，若测试响应连通，模型将自动解封恢复可用。'))) return;
  toast('正在交叉轮抽并发复测所有封禁模型，请稍候...', 'info');
  try {
    var res = await fetch('/admin/api/test-blocked-models', { method: 'POST' });
    var data = await res.json();
    if (data.success) {
      aM(data.message || '批量交叉复测完成！', 'success');
      var pRes = await fetch('/admin/api/providers');
      var pData = await pRes.json();
      if (pData.success && pData.data) {
        draftProviders = pData.data;
      }
      renderProviderList();
    } else {
      aM('批量复测失败：' + (data.message || '未知错误'), 'error');
    }
  } catch (err) {
    aM('请求网络异常：' + ((err && err.message) || String(err)), 'error');
  }
}

async function fetchUpstreamModels(providerId) {
  toast('正在拉取上游模型列表...', 'success');
  try {
    var res = await fetch('/admin/api/providers/' + encodeURIComponent(providerId) + '/fetch-models', { method: 'POST' });
    var data = await res.json();
    if (data.success && data.data && data.data.models) {
      var p = draftProviders.find(function(item) { return item.id === providerId; });
      if (p) {
        p.models = data.data.models;
        markDirty(true);
        renderProviderList();
        toast('一键拉取成功！已自动智能分类且去重，当前共 ' + data.data.models.length + ' 个模型', 'success');
      }
    } else {
      aM('拉取失败：' + (data.message || '未知错误'), 'error');
    }
  } catch (err) {
    aM('拉取上游模型异常：' + ((err && err.message) || String(err)), 'error');
  }
}

async function showImportModal(providerId) {
  var p = draftProviders.find(function(item) { return item.id === providerId; });
  if (!p) return;
  var text = await pM('导入模型 ID 列表（支持换行、逗号或分号分隔，自动剔除重复项并自动分类）：');
  if (!text) return;

  var lines = text.split(new RegExp('[\\\\n,;]+')).map(function(s) { return s.trim(); }).filter(Boolean);
  if (!lines.length) return;

  p.models = p.models || [];
  var seen = new Set(p.models.map(function(m) { return m.id; }));
  var addedCount = 0;
  lines.forEach(function(mid) {
    if (!seen.has(mid)) {
      seen.add(mid);
      var cat = '通用对话';
      var lower = mid.toLowerCase();
      if (/image|draw|flux|dall|sd|midjourney|recraft|stable-diffusion|wanx/i.test(lower)) cat = '绘图';
      else if (/code|coder|dev|sql|prog/i.test(lower)) cat = '代码';
      else if (/reason|r1|o1|o3|thinking|cot/i.test(lower)) cat = '推理';
      else if (/vision|vl|4v|4o|gemini-1.5|image-to-text|multimodal/i.test(lower)) cat = '多模态';
      else if (/embed|bge|text-embedding/i.test(lower)) cat = '向量嵌入';

      p.models.push({
        id: mid,
        name: mid,
        enabled: true,
        category: cat,
      });
      addedCount++;
    }
  });

  markDirty(true);
  renderProviderList();
  toast('成功导入 ' + addedCount + ' 个模型至草稿，请点击【统一保存】写入 KV', 'success');
}

async function clearProviderModels(providerId) {
  if (!(await cM('确定要清空该提供商的全部模型？（请点击【统一保存】后生效）'))) return;
  var p = draftProviders.find(function(item) { return item.id === providerId; });
  if (p) {
    p.models = [];
    markDirty(true);
    renderProviderList();
    toast('已清空该提供商模型列表（已暂存草稿，请点击统一保存）', 'info');
  }
}

async function unblockModel(providerId, modelId) {
  var p = draftProviders.find(function(item) { return item.id === providerId; });
  if (p) {
    var m = p.models.find(function(m) { return m.id === modelId; });
    if (m) {
      m.permanentlyDisabled = false;
      m.disabledReason = null;
      m.failureCount = 0;
      m.cooldownUntil = null;
      markDirty(true);
      renderProviderList();
      toast('模型 [' + modelId + '] 已在内存中重置，请点击【统一保存】持久化', 'success');
    }
  }
}

async function resetAllModelsInProvider(providerId) {
  var p = draftProviders.find(function(item) { return item.id === providerId; });
  if (!p || !p.models || !p.models.length) return;

  p.models.forEach(function(m) {
    m.permanentlyDisabled = false;
    m.disabledReason = null;
    m.failureCount = 0;
    m.cooldownUntil = null;
    m.permTestFailCount = 0;
    m.lastPermTestAt = undefined;
    m.enabled = true;
  });

  markDirty(true);
  renderProviderList();
  toast('已一键重置该提供商所有模型状态（请点击【统一保存】持久化）', 'success');
}

async function updateModelCat(providerId, modelId, category) {
  var p = draftProviders.find(function(item) { return item.id === providerId; });
  if (p) {
    var m = p.models.find(function(m) { return m.id === modelId; });
    if (m) {
      m.category = category;
      markDirty(true);
      toast('模型分类已更新为 [' + category + ']（请点击【统一保存】写入 KV）', 'info');
    }
  }
}

/* ========== 自定义指定模型路由逻辑 ========== */
var customRoutesData = [];
var currentEditingRouteId = '';
var customRoutesActiveFilter = 'all';
var modalActiveTag = 'all';

async function loadCustomRoutes() {
  try {
    var res = await fetch('/admin/api/custom-routes');
    var json = await res.json();
    if (json.success && Array.isArray(json.data)) {
      customRoutesData = json.data;
      renderCustomRoutesTable();
      var countBadge = document.getElementById('custom-routes-count-badge');
      if (countBadge) countBadge.textContent = customRoutesData.length;
    }
  } catch (err) {
    console.error('加载自定义路由失败:', err);
  }
}

function checkRouteCategoryMatches(r) {
  var isTier1 = (r.targetProviderId === 'tier1' || r.targetModelId === 'auto');
  var isOpenclawTier = (r.targetProviderId === 'tier_openclaw' || r.targetModelId === 'openclaw');
  var isDrawingTier = (r.targetProviderId === 'tier_drawing' || r.targetModelId === 'drawing');

  var pObj = draftProviders.find(function(p) { return p.id === r.targetProviderId; });
  var mObj = pObj && pObj.models ? pObj.models.find(function(m) { return m.id === r.targetModelId; }) : null;

  var sModel = (r.sourceModel || '').toLowerCase();
  var tModel = (r.targetModelId || '').toLowerCase();

  var isDraw = isDrawingTier ||
    (mObj && mObj.category === '绘图') ||
    /dall-e|flux|stable-diffusion|sdxl|midjourney|image|draw|recraft|cogview|imagen/i.test(sModel) ||
    /dall-e|flux|stable-diffusion|sdxl|midjourney|image|draw|recraft|cogview|imagen/i.test(tModel);

  var isOpenclaw = isOpenclawTier ||
    /openclaw|agent|tool/i.test(sModel) ||
    (mObj && mObj.openclawTested && mObj.openclawCompatible) ||
    (mObj && /claude|gpt|gemini|deepseek|qwen|coder/i.test(mObj.id)) ||
    isTier1;

  var isTier1Match = isTier1;
  var isText = (!isDraw) || (mObj && mObj.category === '文本') || isTier1;

  return {
    openclaw: !!isOpenclaw,
    tier1: !!isTier1Match,
    text: !!isText,
    image: !!isDraw
  };
}

function updateCustomRoutesFilterCounts(total, openclaw, tier1, text, image) {
  var elAll = document.getElementById('cr-cnt-all');
  var elOc = document.getElementById('cr-cnt-openclaw');
  var elT1 = document.getElementById('cr-cnt-tier1');
  var elTxt = document.getElementById('cr-cnt-text');
  var elImg = document.getElementById('cr-cnt-image');
  if (elAll) elAll.innerText = total;
  if (elOc) elOc.innerText = openclaw;
  if (elT1) elT1.innerText = tier1;
  if (elTxt) elTxt.innerText = text;
  if (elImg) elImg.innerText = image;
}

function filterCustomRoutesTable(btn, filterType) {
  customRoutesActiveFilter = filterType;
  var bar = document.getElementById('custom-routes-filter-bar');
  if (bar) {
    var chips = bar.querySelectorAll('.route-tag-chip');
    chips.forEach(function(c) { c.classList.remove('is-active'); });
  }
  if (btn) btn.classList.add('is-active');
  renderCustomRoutesTable();
}

function filterCustomRoutesTableBtn(btn) {
  var f = btn.getAttribute('data-route-filter');
  if (f) filterCustomRoutesTable(btn, f);
}

function renderCustomRoutesTable() {
  var tbody = document.getElementById('custom-routes-tbody');
  if (!tbody) return;
  if (!customRoutesData || customRoutesData.length === 0) {
    updateCustomRoutesFilterCounts(0, 0, 0, 0, 0);
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--color-muted);padding:24px;">暂无自定义指定规则。点击右上角“+ 添加指定规则”可指定将特定模型名（如 openclaw/auto）转发到指定模型或第一梯队池。</td></tr>';
    return;
  }

  // 计算各类规则数量
  var cntOpenclaw = 0, cntTier1 = 0, cntText = 0, cntImage = 0;
  customRoutesData.forEach(function(r) {
    var cat = checkRouteCategoryMatches(r);
    if (cat.openclaw) cntOpenclaw++;
    if (cat.tier1) cntTier1++;
    if (cat.text) cntText++;
    if (cat.image) cntImage++;
  });
  updateCustomRoutesFilterCounts(customRoutesData.length, cntOpenclaw, cntTier1, cntText, cntImage);

  var filteredList = customRoutesData.filter(function(r) {
    if (customRoutesActiveFilter === 'all') return true;
    var cat = checkRouteCategoryMatches(r);
    if (customRoutesActiveFilter === 'openclaw') return cat.openclaw;
    if (customRoutesActiveFilter === 'tier1') return cat.tier1;
    if (customRoutesActiveFilter === 'text') return cat.text;
    if (customRoutesActiveFilter === 'image') return cat.image;
    return true;
  });

  if (filteredList.length === 0) {
    var tipMap = {
      openclaw: '当前暂无针对 OpenClaw 智能体的指定路由规则',
      tier1: '当前暂无转发至第一梯队的指定路由规则',
      text: '当前暂无针对文本模型的指定路由规则',
      image: '当前暂无针对绘图模型的指定路由规则'
    };
    var tip = tipMap[customRoutesActiveFilter] || '当前标签筛选下无匹配规则';
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--color-muted);padding:24px;">' +
      '<div style="margin-bottom:6px;"><i class="fas fa-filter" style="color:var(--color-muted);font-size:1.2rem;"></i></div>' +
      tip + '。您可以点击右上角“+ 添加指定规则”快速添加。' +
      '</td></tr>';
    return;
  }

  tbody.innerHTML = filteredList.map(function(r) {
    var isTier1 = r.targetProviderId === 'tier1' || r.targetModelId === 'auto';
    var isOpenclawTier = r.targetProviderId === 'tier_openclaw' || r.targetModelId === 'openclaw';
    var isDrawingTier = r.targetProviderId === 'tier_drawing' || r.targetModelId === 'drawing';

    var pName = r.targetProviderId;
    var mName = r.targetModelId;
    var targetBadge = '';

    if (isOpenclawTier) {
      pName = '🟣 OpenClaw 专属调度池';
      mName = 'OpenClaw Tier (5 席智能体池)';
      targetBadge = '<span class="openclaw-badge openclaw-badge--ok" style="background:#ede9fe;color:#6d28d9;border-color:#ddd6fe;margin-left:4px;"><i class="fas fa-robot"></i> OpenClaw池</span>';
    } else if (isDrawingTier) {
      pName = '🎨 绘图专属调度池';
      mName = 'Drawing Tier (5 席图像模型池)';
      targetBadge = '<span class="openclaw-badge openclaw-badge--ok" style="background:#fce7f3;color:#be185d;border-color:#fbcfe8;margin-left:4px;"><i class="fas fa-palette"></i> 绘图池</span>';
    } else if (isTier1) {
      pName = '🌟 第一梯队自动调度池';
      mName = 'Tier 1 黄金池 (9 席自动选优)';
      targetBadge = '<span class="openclaw-badge openclaw-badge--ok" style="background:#e0f2fe;color:#0369a1;border-color:#bae6fd;margin-left:4px;"><i class="fas fa-bolt"></i> 第一梯队池</span>';
    } else {
      var pObj = draftProviders.find(function(p) { return p.id === r.targetProviderId; });
      if (pObj) {
        pName = pObj.name + ' (' + pObj.id + ')';
      }
      targetBadge = '<span style="color:#0f766e;font-weight:600;font-size:0.75rem;margin-left:4px;"><i class="fas fa-crosshairs"></i> 严格指定</span>';
    }

    var mObj = null;
    if (!isTier1 && !isOpenclawTier && !isDrawingTier) {
      var pObjFind = draftProviders.find(function(p) { return p.id === r.targetProviderId; });
      if (pObjFind && pObjFind.models) {
        mObj = pObjFind.models.find(function(m) { return m.id === r.targetModelId; });
      }
    }

    var tagBadges = '';
    if (mObj) {
      if (mObj.openclawTested && mObj.openclawCompatible) {
        tagBadges += '<span class="openclaw-badge openclaw-badge--ok" style="margin-left:4px;"><i class="fas fa-robot"></i> OpenClaw 适合</span>';
      } else if (mObj.openclawTested && !mObj.openclawCompatible) {
        tagBadges += '<span class="openclaw-badge openclaw-badge--no" style="margin-left:4px;"><i class="fas fa-ban"></i> 不适智能体</span>';
      }
      if (mObj.category === '绘图') {
        tagBadges += '<span style="padding:1px 5px;font-size:10px;border-radius:3px;background:oklch(96% 0.04 60);border:1px solid oklch(88% 0.08 60);color:oklch(40% 0.12 60);margin-left:4px;"><i class="fas fa-palette"></i> 绘图</span>';
      } else {
        tagBadges += '<span style="padding:1px 5px;font-size:10px;border-radius:3px;background:var(--color-paper-2);border:1px solid var(--color-rule);color:var(--color-muted);margin-left:4px;"><i class="fas fa-comment-dots"></i> 文本</span>';
      }
    }

    return '<tr>' +
      '<td style="padding:10px 12px;"><code>' + escapeHtml(r.sourceModel) + '</code></td>' +
      '<td style="padding:10px 12px;color:var(--color-ink);">' + escapeHtml(pName) + '</td>' +
      '<td style="padding:10px 12px;"><code>' + escapeHtml(mName) + '</code>' + targetBadge + tagBadges + '</td>' +
      '<td style="padding:10px 12px;" id="cr-lat-' + escapeHtml(r.id) + '"><span style="color:var(--color-muted);font-size:0.8rem;">未测试</span></td>' +
      '<td style="padding:10px 12px;"><label class="tg"><input type="checkbox" ' + (r.enabled ? 'checked' : '') + ' data-id="' + escapeHtml(r.id) + '" onchange="toggleCustomRouteBtn(this)"><span class="sl"></span></label></td>' +
      '<td style="padding:10px 12px;text-align:right;">' +
        '<button type="button" class="btn btn-s btn-xs" style="margin-right:6px;" data-id="' + escapeHtml(r.id) + '" onclick="testCustomRouteLatencyBtn(this)"><i class="fas fa-gauge-high"></i> 测延迟</button>' +
        '<button type="button" class="btn btn-s btn-xs" style="margin-right:6px;" data-id="' + escapeHtml(r.id) + '" onclick="editCustomRouteBtn(this)"><i class="fas fa-edit"></i> 编辑</button>' +
        '<button type="button" class="btn btn-d btn-xs" data-id="' + escapeHtml(r.id) + '" onclick="deleteCustomRouteBtn(this)"><i class="fas fa-trash"></i> 删除</button>' +
      '</td>' +
    '</tr>';
  }).join('');
}

function getAllFlattenedModels() {
  var list = [];
  draftProviders.forEach(function(p) {
    if (Array.isArray(p.models)) {
      p.models.forEach(function(m) {
        list.push({
          providerId: p.id,
          providerName: p.name,
          modelId: m.id,
          category: m.category || '文本',
          openclawTested: !!m.openclawTested,
          openclawCompatible: !!m.openclawCompatible,
          openclawReason: m.openclawReason || '',
          enabled: m.enabled !== false,
          isBlocked: !!m.permanentlyDisabled || (m.cooldownUntil && Date.now() < m.cooldownUntil)
        });
      });
    }
  });
  return list;
}

function renderCustomRouteQuickPicker(activeTag, selectedPid, selectedMid) {
  var container = document.getElementById('cr-quick-picker');
  if (!container) return;
  var allModels = getAllFlattenedModels();
  
  var filtered = allModels.filter(function(item) {
    if (activeTag === 'all') return true;
    if (activeTag === 'openclaw') return item.openclawTested ? item.openclawCompatible : /claude|gpt|gemini|deepseek|qwen|coder/i.test(item.modelId);
    if (activeTag === 'text') return item.category === '文本';
    if (activeTag === 'image') return item.category === '绘图';
    if (activeTag === 'healthy') return item.enabled && !item.isBlocked;
    return true;
  });

  var html = '';
  // 如果处于全部或特定标签，首项提供调度池选项
  if (activeTag === 'all' || activeTag === 'tier1') {
    var isTier1Selected = selectedPid === 'tier1' || selectedMid === 'auto';
    html += '<div class="route-model-pick-card ' + (isTier1Selected ? 'is-selected' : '') + '" data-pid="tier1" data-mid="auto" onclick="onPickCardClick(this)">' +
      '<div class="rm-title" style="color:#0284c7;"><i class="fas fa-bolt" style="color:#eab308;"></i> 🌟 第一梯队调度池</div>' +
      '<div class="rm-meta"><span>动态选优</span><span class="openclaw-badge openclaw-badge--ok" style="background:#e0f2fe;color:#0369a1;border-color:#bae6fd;padding:0 4px;font-size:10px;">Tier 1</span></div>' +
    '</div>';
  }
  if (activeTag === 'all' || activeTag === 'openclaw') {
    var isOcSelected = selectedPid === 'tier_openclaw' || selectedMid === 'openclaw';
    html += '<div class="route-model-pick-card ' + (isOcSelected ? 'is-selected' : '') + '" data-pid="tier_openclaw" data-mid="openclaw" onclick="onPickCardClick(this)">' +
      '<div class="rm-title" style="color:#7c3aed;"><i class="fas fa-robot" style="color:#8b5cf6;"></i> 🟣 OpenClaw 专属池</div>' +
      '<div class="rm-meta"><span>智能体</span><span class="openclaw-badge openclaw-badge--ok" style="background:#ede9fe;color:#6d28d9;border-color:#ddd6fe;padding:0 4px;font-size:10px;">OpenClaw</span></div>' +
    '</div>';
  }
  if (activeTag === 'all' || activeTag === 'image') {
    var isDrawSelected = selectedPid === 'tier_drawing' || selectedMid === 'drawing';
    html += '<div class="route-model-pick-card ' + (isDrawSelected ? 'is-selected' : '') + '" data-pid="tier_drawing" data-mid="drawing" onclick="onPickCardClick(this)">' +
      '<div class="rm-title" style="color:#be185d;"><i class="fas fa-palette" style="color:#ec4899;"></i> 🎨 绘图专属池</div>' +
      '<div class="rm-meta"><span>图像模型</span><span class="openclaw-badge openclaw-badge--ok" style="background:#fce7f3;color:#be185d;border-color:#fbcfe8;padding:0 4px;font-size:10px;">Drawing</span></div>' +
    '</div>';
  }

  if (activeTag !== 'tier1') {
    html += filtered.map(function(item) {
      var isSel = (selectedPid === item.providerId && selectedMid === item.modelId);
      var badge = '';
      if (item.openclawTested && item.openclawCompatible) {
        badge = '<span class="openclaw-badge openclaw-badge--ok" style="padding:0 4px;font-size:10px;"><i class="fas fa-robot"></i> OpenClaw</span>';
      } else if (item.category === '绘图') {
        badge = '<span style="padding:0 4px;font-size:10px;border-radius:3px;background:oklch(96% 0.04 60);border:1px solid oklch(88% 0.08 60);color:oklch(40% 0.12 60);"><i class="fas fa-palette"></i> 绘图</span>';
      } else {
        badge = '<span style="padding:0 4px;font-size:10px;border-radius:3px;background:var(--color-paper-2);border:1px solid var(--color-rule);color:var(--color-muted);">' + escapeHtml(item.category) + '</span>';
      }
      return '<div class="route-model-pick-card ' + (isSel ? 'is-selected' : '') + '" data-pid="' + escapeHtml(item.providerId) + '" data-mid="' + escapeHtml(item.modelId) + '" onclick="onPickCardClick(this)">' +
        '<div class="rm-title" title="' + escapeHtml(item.modelId) + '"><i class="fas fa-cube" style="font-size:10px;color:var(--color-muted);margin-right:3px;"></i>' + escapeHtml(item.modelId) + '</div>' +
        '<div class="rm-meta"><span title="' + escapeHtml(item.providerName) + '">' + escapeHtml(item.providerId) + '</span>' + badge + '</div>' +
      '</div>';
    }).join('');
  }

  if (!html) {
    html = '<div style="grid-column:1/-1;text-align:center;padding:16px;color:var(--color-muted);font-size:0.8rem;">该标签下暂无匹配模型</div>';
  }

  container.innerHTML = html;
}

function onPickCardClick(el) {
  var pid = el.getAttribute('data-pid');
  var mid = el.getAttribute('data-mid');
  if (pid && mid) onSelectModelFromPicker(pid, mid);
}

function onModalRouteTagBtn(btn) {
  var tag = btn.getAttribute('data-modal-tag');
  if (tag) onCustomRouteTagClick(btn, tag);
}

function onCustomRouteTagClick(btn, tag) {
  modalActiveTag = tag;
  var bar = document.getElementById('modal-tag-bar');
  if (bar) {
    var chips = bar.querySelectorAll('.route-tag-chip');
    chips.forEach(function(c) { c.classList.remove('is-active'); });
  }
  if (btn) btn.classList.add('is-active');

  if (tag === 'tier1') {
    onSelectModelFromPicker('tier1', 'auto');
  } else {
    var pSelect = document.getElementById('cr-provider');
    var mSelect = document.getElementById('cr-model');
    var currentPid = pSelect ? pSelect.value : '';
    var currentMid = mSelect ? mSelect.value : '';
    renderCustomRouteQuickPicker(tag, currentPid, currentMid);
    updateCustomRouteModelOptions(currentMid);
  }
}

function onSelectModelFromPicker(pid, mid) {
  var pSelect = document.getElementById('cr-provider');
  var mSelect = document.getElementById('cr-model');
  var sourceInput = document.getElementById('cr-source');

  if (pSelect) {
    pSelect.value = pid;
  }
  updateCustomRouteModelOptions(mid);
  if (mSelect) {
    mSelect.value = mid;
  }

  renderCustomRouteQuickPicker(modalActiveTag, pid, mid);

  // 自动贴心填充/建议请求模型名称
  if (sourceInput && !sourceInput.value.trim()) {
    if (pid === 'tier1' || mid === 'auto') {
      sourceInput.value = 'auto/auto';
    } else if (pid === 'tier_openclaw' || mid === 'openclaw') {
      sourceInput.value = 'openclaw/auto';
    } else if (pid === 'tier_drawing' || mid === 'drawing') {
      sourceInput.value = 'drawing/auto';
    } else if (modalActiveTag === 'openclaw' || mid.toLowerCase().includes('openclaw')) {
      sourceInput.value = 'openclaw/auto';
    } else {
      sourceInput.value = mid;
    }
  }

  var poolTitle = '🌟 第一梯队调度池';
  if (pid === 'tier_openclaw') poolTitle = '🟣 OpenClaw 专属池';
  if (pid === 'tier_drawing') poolTitle = '🎨 绘图专属池';
  toast('已选定目标：' + (pid.startsWith('tier') ? poolTitle : (pid + ' / ' + mid)), 'info');
}

function openAddCustomRouteModal() {
  currentEditingRouteId = '';
  modalActiveTag = 'all';
  var allModels = getAllFlattenedModels();
  var openclawCount = allModels.filter(function(m) { return m.openclawTested ? m.openclawCompatible : /claude|gpt|gemini|deepseek|qwen|coder/i.test(m.modelId); }).length;
  var textCount = allModels.filter(function(m) { return m.category === '文本'; }).length;
  var imgCount = allModels.filter(function(m) { return m.category === '绘图'; }).length;

  var modalHtml = '<h3><i class="fas fa-route c-p"></i> 添加指定模型路由</h3>' +
    '<p class="form-helper" style="margin-bottom:12px;">可通过下方【标签分类】一键快速点选，或在下拉框中精确指定。</p>' +
    '<div class="fg mb-2">' +
      '<label style="font-weight:600;font-size:0.8125rem;"><i class="fas fa-tags" style="color:var(--color-focus);margin-right:4px;"></i> 按标签选择模型：</label>' +
      '<div class="route-tag-bar" id="modal-tag-bar">' +
        '<button type="button" class="route-tag-chip is-active" data-modal-tag="all" onclick="onModalRouteTagBtn(this)"><i class="fas fa-layer-group"></i> 全部 <span class="chip-count">' + allModels.length + '</span></button>' +
        '<button type="button" class="route-tag-chip" data-modal-tag="openclaw" onclick="onModalRouteTagBtn(this)"><i class="fas fa-robot"></i> OpenClaw 适合 <span class="chip-count">' + openclawCount + '</span></button>' +
        '<button type="button" class="route-tag-chip" data-modal-tag="tier1" onclick="onModalRouteTagBtn(this)"><i class="fas fa-bolt"></i> 第一梯队池</button>' +
        '<button type="button" class="route-tag-chip" data-modal-tag="text" onclick="onModalRouteTagBtn(this)"><i class="fas fa-comment-dots"></i> 文本模型 <span class="chip-count">' + textCount + '</span></button>' +
        '<button type="button" class="route-tag-chip" data-modal-tag="image" onclick="onModalRouteTagBtn(this)"><i class="fas fa-palette"></i> 绘图模型 <span class="chip-count">' + imgCount + '</span></button>' +
        '<button type="button" class="route-tag-chip" data-modal-tag="healthy" onclick="onModalRouteTagBtn(this)"><i class="fas fa-shield-halved"></i> 仅健康就绪</button>' +
      '</div>' +
      '<div id="cr-quick-picker" class="route-quick-picker"></div>' +
    '</div>' +
    '<div class="fg mb-3"><label for="cr-source">客户端请求模型名称 (匹配项) *</label><input type="text" id="cr-source" placeholder="例如 openclaw/auto 或 deepseek-chat" class="fx1" style="width:100%;box-sizing:border-box;"></div>' +
    '<div class="grid-2-gap6" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">' +
      '<div class="fg mb-3"><label for="cr-provider">目标提供商 *</label><select id="cr-provider" onchange="updateCustomRouteModelOptions()" class="select-sm" style="width:100%;">' +
        '<optgroup label="智能调度池 (自动选优与故障自愈)">' +
          '<option value="tier1" selected>🌟 第一梯队池 (Tier 1 通用黄金池)</option>' +
          '<option value="tier_openclaw">🟣 OpenClaw 专属池 (智能体/Tools 优选)</option>' +
          '<option value="tier_drawing">🎨 绘图专属池 (图像生成模型优选)</option>' +
        '</optgroup>' +
        '<optgroup label="指定特定提供商具体模型（绝不切换其他模型）">' +
        draftProviders.map(function(p) { return '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.name) + ' (' + escapeHtml(p.id) + ')</option>'; }).join('') +
        '</optgroup>' +
      '</select></div>' +
      '<div class="fg mb-3"><label for="cr-model">目标模型 *</label><select id="cr-model" class="select-sm" style="width:100%;"><option value="auto">🌟 第一梯队池自动选优 (9席健康模型智能调度)</option></select></div>' +
    '</div>' +
    '<div class="fa" style="margin-top:16px;"><button class="btn btn-s" onclick="closeM()">取消</button><button class="btn btn-p" onclick="saveCustomRouteFromModal()">保存规则</button></div>';
  showM(modalHtml);
  renderCustomRouteQuickPicker('all', 'tier1', 'auto');
  updateCustomRouteModelOptions('auto');
}

function updateCustomRouteModelOptions(selectedModelId) {
  var pSelect = document.getElementById('cr-provider');
  var mSelect = document.getElementById('cr-model');
  if (!pSelect || !mSelect) return;
  var pid = pSelect.value;
  if (!pid) {
    mSelect.innerHTML = '<option value="">请选择目标提供商...</option>';
    return;
  }
  if (pid === 'tier1') {
    mSelect.innerHTML = '<option value="auto" selected>🌟 第一梯队池自动选优 (9席健康模型智能调度)</option>';
    return;
  }
  if (pid === 'tier_openclaw') {
    mSelect.innerHTML = '<option value="openclaw" selected>🟣 OpenClaw 专属池自动选优 (5席智能体模型)</option>';
    return;
  }
  if (pid === 'tier_drawing') {
    mSelect.innerHTML = '<option value="drawing" selected>🎨 绘图专属池自动选优 (5席图像模型)</option>';
    return;
  }
  var p = draftProviders.find(function(item) { return item.id === pid; });
  if (!p || !p.models || p.models.length === 0) {
    mSelect.innerHTML = '<option value="">该提供商暂无可用模型</option>';
    return;
  }

  // 根据当前 modalActiveTag 过滤或打标
  var models = p.models;
  if (modalActiveTag === 'openclaw') {
    var filtered = models.filter(function(m) {
      return m.openclawTested ? m.openclawCompatible : /claude|gpt|gemini|deepseek|qwen|coder/i.test(m.id);
    });
    if (filtered.length > 0) models = filtered;
  } else if (modalActiveTag === 'text') {
    var textFiltered = models.filter(function(m) { return m.category === '文本'; });
    if (textFiltered.length > 0) models = textFiltered;
  } else if (modalActiveTag === 'image') {
    var imgFiltered = models.filter(function(m) { return m.category === '绘图'; });
    if (imgFiltered.length > 0) models = imgFiltered;
  }

  mSelect.innerHTML = models.map(function(m) {
    var isSel = m.id === selectedModelId ? 'selected' : '';
    var tagInfo = '';
    if (m.openclawTested && m.openclawCompatible) {
      tagInfo = ' [OpenClaw适合]';
    } else if (m.category) {
      tagInfo = ' [' + m.category + ']';
    }
    return '<option value="' + escapeHtml(m.id) + '" ' + isSel + '>' + escapeHtml(m.id) + tagInfo + '</option>';
  }).join('');
}

function editCustomRouteBtn(btn) {
  var id = btn.getAttribute('data-id');
  if (!id) return;
  var r = customRoutesData.find(function(item) { return item.id === id; });
  if (!r) return;
  currentEditingRouteId = id;
  modalActiveTag = 'all';
  var isTier1 = r.targetProviderId === 'tier1' || r.targetModelId === 'auto';
  var isOpenclawTier = r.targetProviderId === 'tier_openclaw' || r.targetModelId === 'openclaw';
  var isDrawingTier = r.targetProviderId === 'tier_drawing' || r.targetModelId === 'drawing';
  var isSpecialTier = isTier1 || isOpenclawTier || isDrawingTier;

  var allModels = getAllFlattenedModels();
  var openclawCount = allModels.filter(function(m) { return m.openclawTested ? m.openclawCompatible : /claude|gpt|gemini|deepseek|qwen|coder/i.test(m.modelId); }).length;
  var textCount = allModels.filter(function(m) { return m.category === '文本'; }).length;
  var imgCount = allModels.filter(function(m) { return m.category === '绘图'; }).length;

  var modalHtml = '<h3><i class="fas fa-edit c-p"></i> 编辑指定模型路由</h3>' +
    '<p class="form-helper" style="margin-bottom:12px;">可通过下方【标签分类】一键切换模型，或在下拉框中精确选择。</p>' +
    '<div class="fg mb-2">' +
      '<label style="font-weight:600;font-size:0.8125rem;"><i class="fas fa-tags" style="color:var(--color-focus);margin-right:4px;"></i> 按标签选择模型：</label>' +
      '<div class="route-tag-bar" id="modal-tag-bar">' +
        '<button type="button" class="route-tag-chip is-active" data-modal-tag="all" onclick="onModalRouteTagBtn(this)"><i class="fas fa-layer-group"></i> 全部 <span class="chip-count">' + allModels.length + '</span></button>' +
        '<button type="button" class="route-tag-chip" data-modal-tag="openclaw" onclick="onModalRouteTagBtn(this)"><i class="fas fa-robot"></i> OpenClaw 适合 <span class="chip-count">' + openclawCount + '</span></button>' +
        '<button type="button" class="route-tag-chip" data-modal-tag="tier1" onclick="onModalRouteTagBtn(this)"><i class="fas fa-bolt"></i> 第一梯队池</button>' +
        '<button type="button" class="route-tag-chip" data-modal-tag="text" onclick="onModalRouteTagBtn(this)"><i class="fas fa-comment-dots"></i> 文本模型 <span class="chip-count">' + textCount + '</span></button>' +
        '<button type="button" class="route-tag-chip" data-modal-tag="image" onclick="onModalRouteTagBtn(this)"><i class="fas fa-palette"></i> 绘图模型 <span class="chip-count">' + imgCount + '</span></button>' +
        '<button type="button" class="route-tag-chip" data-modal-tag="healthy" onclick="onModalRouteTagBtn(this)"><i class="fas fa-shield-halved"></i> 仅健康就绪</button>' +
      '</div>' +
      '<div id="cr-quick-picker" class="route-quick-picker"></div>' +
    '</div>' +
    '<div class="fg mb-3"><label for="cr-source">客户端请求模型名称 (匹配项) *</label><input type="text" id="cr-source" value="' + escapeHtml(r.sourceModel) + '" class="fx1" style="width:100%;box-sizing:border-box;"></div>' +
    '<div class="grid-2-gap6" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">' +
      '<div class="fg mb-3"><label for="cr-provider">目标提供商 *</label><select id="cr-provider" onchange="updateCustomRouteModelOptions()" class="select-sm" style="width:100%;">' +
        '<optgroup label="智能调度池 (自动选优与故障自愈)">' +
          '<option value="tier1" ' + (isTier1 ? 'selected' : '') + '>🌟 第一梯队池 (Tier 1 通用黄金池)</option>' +
          '<option value="tier_openclaw" ' + (isOpenclawTier ? 'selected' : '') + '>🟣 OpenClaw 专属池 (智能体/Tools 优选)</option>' +
          '<option value="tier_drawing" ' + (isDrawingTier ? 'selected' : '') + '>🎨 绘图专属池 (图像生成模型优选)</option>' +
        '</optgroup>' +
        '<optgroup label="指定特定提供商具体模型（绝不切换其他模型）">' +
        draftProviders.map(function(p) {
          var isSel = !isSpecialTier && p.id === r.targetProviderId ? 'selected' : '';
          return '<option value="' + escapeHtml(p.id) + '" ' + isSel + '>' + escapeHtml(p.name) + ' (' + escapeHtml(p.id) + ')</option>';
        }).join('') +
        '</optgroup>' +
      '</select></div>' +
      '<div class="fg mb-3"><label for="cr-model">目标模型 *</label><select id="cr-model" class="select-sm" style="width:100%;"></select></div>' +
    '</div>' +
    '<div class="fa" style="margin-top:16px;"><button class="btn btn-s" onclick="closeM()">取消</button><button class="btn btn-p" onclick="saveCustomRouteFromModal()">保存更改</button></div>';
  showM(modalHtml);
  renderCustomRouteQuickPicker('all', r.targetProviderId, r.targetModelId);
  updateCustomRouteModelOptions(r.targetModelId);
}

async function testCustomRouteLatencyBtn(btn) {
  var id = btn.getAttribute('data-id');
  if (!id) return;
  var r = customRoutesData.find(function(item) { return item.id === id; });
  if (!r) return;
  var cell = document.getElementById('cr-lat-' + r.id);
  if (cell) cell.innerHTML = '<span style="color:#0284c7;font-size:0.8rem;"><i class="fas fa-spinner fa-spin"></i> 测试中...</span>';
  btn.disabled = true;
  try {
    var res = await fetch('/admin/api/custom-routes/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetProviderId: r.targetProviderId,
        targetModelId: r.targetModelId
      })
    });
    var json = await res.json();
    if (json.success && json.data) {
      var d = json.data;
      if (d.success) {
        if (cell) {
          cell.innerHTML = '<span style="color:#15803d;font-weight:600;font-size:0.85rem;" title="' + escapeHtml(d.targetInfo || '') + '"><i class="fas fa-check-circle"></i> ' + (d.latencyMs !== undefined ? d.latencyMs + ' ms' : '连通') + '</span>';
        }
        toast('连通测试成功 (' + (d.latencyMs || 0) + 'ms)', 'success');
      } else {
        if (cell) {
          cell.innerHTML = '<span style="color:#b91c1c;font-size:0.8rem;" title="' + escapeHtml(d.message || '') + '"><i class="fas fa-times-circle"></i> 失败</span>';
        }
        toast('测试失败: ' + (d.message || '无法连通'), 'error');
      }
    } else {
      if (cell) cell.innerHTML = '<span style="color:#b91c1c;font-size:0.8rem;">错误</span>';
      toast('测试失败: ' + (json.message || '请求错误'), 'error');
    }
  } catch (err) {
    if (cell) cell.innerHTML = '<span style="color:#b91c1c;font-size:0.8rem;">异常</span>';
    toast('测延迟异常: ' + ((err && err.message) || String(err)), 'error');
  } finally {
    btn.disabled = false;
  }
}

async function saveCustomRouteFromModal() {
  var sourceEl = document.getElementById('cr-source');
  var provEl = document.getElementById('cr-provider');
  var modelEl = document.getElementById('cr-model');
  if (!sourceEl || !provEl || !modelEl) return;
  var source = sourceEl.value.trim();
  var pid = provEl.value;
  var mid = modelEl.value;
  if (!source || !pid || !mid) {
    toast('请完整填写请求模型名称、提供商和模型', 'error');
    return;
  }
  var ruleId = currentEditingRouteId || ('cr_' + Date.now());
  var existingIdx = customRoutesData.findIndex(function(r) { return r.id === ruleId; });
  var routeObj = { id: ruleId, sourceModel: source, targetProviderId: pid, targetModelId: mid, enabled: true };
  if (existingIdx >= 0) {
    routeObj.enabled = customRoutesData[existingIdx].enabled;
    customRoutesData[existingIdx] = routeObj;
  } else {
    customRoutesData.push(routeObj);
  }
  renderCustomRoutesTable();
  var countBadge = document.getElementById('custom-routes-count-badge');
  if (countBadge) countBadge.textContent = customRoutesData.length;
  markDirty(true);
  toast('指定路由规则已加入草稿，请点击【统一保存】写入 KV', 'success');
  closeM();
}

async function toggleCustomRouteBtn(checkbox) {
  var id = checkbox.getAttribute('data-id');
  if (!id) return;
  var r = customRoutesData.find(function(item) { return item.id === id; });
  if (r) {
    r.enabled = checkbox.checked;
    markDirty(true);
    toast('路由状态已变更（草稿），请点击【统一保存】写入 KV', 'info');
  }
}

async function deleteCustomRouteBtn(btn) {
  var id = btn.getAttribute('data-id');
  if (!id) return;
  if (!(await cM('确定删除该条指定路由规则？（需点击【统一保存】持久化）'))) return;
  customRoutesData = customRoutesData.filter(function(r) { return r.id !== id; });
  renderCustomRoutesTable();
  var countBadge = document.getElementById('custom-routes-count-badge');
  if (countBadge) countBadge.textContent = customRoutesData.length;
  markDirty(true);
  toast('已从草稿中删除规则，请点击【统一保存】写入 KV', 'info');
}

async function saveCustomRoutesToServer() {
  try {
    var res = await fetch('/admin/api/custom-routes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ routes: customRoutesData })
    });
    var json = await res.json();
    if (json.success) {
      renderCustomRoutesTable();
      var countBadge = document.getElementById('custom-routes-count-badge');
      if (countBadge) countBadge.textContent = customRoutesData.length;
      toast('指定路由规则已保存生效', 'success');
    } else {
      aM(json.message || '保存失败', 'error');
    }
  } catch (err) {
    aM('保存指定路由异常：' + ((err && err.message) || String(err)), 'error');
  }
}

loadCustomRoutes();
</script>
</body></html>`)
}