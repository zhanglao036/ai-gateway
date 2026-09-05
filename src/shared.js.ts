// 公共页脚渲染函数 — 主页与 /admin 页复用，保证两处页脚一致
export const SITE_REPO_URL = 'https://github.com/yutian81/ai-gateway'
export function renderSiteFooter(title: string): string {
  return `<footer class="site-footer">
  <div class="shell site-footer__inner">
    <span>© ${new Date().getFullYear()} <a class="site-footer__link" href="${SITE_REPO_URL}" target="_blank" rel="noreferrer">${title}</a></span>
    <span>Cloudflare Workers · Hono · KV</span>
  </div>
</footer>`
}

// 共享 JS 工具函数 — 注入到后台页面的 <script> 块中
export const SHARED_JS = `
(function() {
  var urlParams = new URLSearchParams(window.location.search);
  var token = urlParams.get('token') || urlParams.get('session_id');
  if (token) {
    localStorage.setItem('admin_token', token);
    document.cookie = "session_id=" + token + "; path=/; max-age=86400; SameSite=None; Secure";
  }
  var savedToken = localStorage.getItem('admin_token');
  if (savedToken && !document.cookie.includes('session_id=')) {
    document.cookie = "session_id=" + savedToken + "; path=/; max-age=86400; SameSite=None; Secure";
  }
  var origFetch = window.fetch;
  window.fetch = function(url, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    var t = localStorage.getItem('admin_token');
    if (t) {
      if (typeof Headers !== 'undefined' && opts.headers instanceof Headers) {
        if (!opts.headers.has('Authorization')) opts.headers.append('Authorization', 'Bearer ' + t);
      } else if (Array.isArray(opts.headers)) {
        opts.headers.push(['Authorization', 'Bearer ' + t]);
      } else {
        if (!opts.headers['Authorization']) opts.headers['Authorization'] = 'Bearer ' + t;
      }
    }
    return origFetch(url, opts).then(function(resp) {
      if (resp && resp.status === 401 && typeof url === 'string' && url.indexOf('/admin/api/') !== -1 && url.indexOf('/admin/api/auth-check') === -1) {
        localStorage.removeItem('admin_token');
        document.cookie = "session_id=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=None; Secure";
        if (typeof toast === 'function') {
          toast('登录已过期，请重新登录', 'error');
        }
        setTimeout(function() {
          if (window.location.pathname.indexOf('/admin') !== -1 && window.location.pathname !== '/admin/login') {
            window.location.href = '/admin/login';
          }
        }, 800);
      }
      return resp;
    });
  };
})();

// ── 工具函数 ──
function normalizeUrl(url) {
    return url ? url.replace(new RegExp('/+$'), '') : ''
  }
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
function buildAuthHeaders(apiType, key) {
  return apiType === 'anthropic'
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : { 'Authorization': 'Bearer ' + key }
}

// ── UI 函数 ──
function showSpinner(el) {
  el.innerHTML = '<span class="mu"><i class="fas fa-spinner fa-spin"></i> 测试中...</span>'
}
function showResult(el, success, msg) {
  el.innerHTML = success
    ? '<div class="al al-s"><i class="fas fa-check-circle"></i> 连接成功</div>'
    : '<div class="al al-e"><i class="fas fa-times-circle"></i> ' + escapeHtml(msg || '连接失败') + '</div>'
}

// ── API 请求函数 ──
async function testKeyConnection(url, apiType, key, providerId, useBrowserUA) {
  try {
    var r = await fetch('/admin/api/test-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url, apiKey: key, apiType: apiType, providerId: providerId, useBrowserUA: useBrowserUA })
    })
    var d = await r.json()
    if (d.success && d.data) {
      return { success: d.data.success, status: d.data.statusCode, data: d.data.data, message: d.data.message }
    }
    return { success: false, status: 0, data: null }
  } catch (e) {
    return { success: false, status: 0, data: null }
  }
}
async function testModelConnection(url, apiType, key, modelId, providerId, useBrowserUA) {
  try {
    var r = await fetch('/admin/api/test-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url, apiKey: key, apiType: apiType, model: modelId, providerId: providerId, useBrowserUA: useBrowserUA })
    })
    var d = await r.json()
    if (d.success && d.data) {
      return { success: d.data.success, status: d.data.statusCode, latencyMs: d.data.latencyMs, message: d.data.message }
    }
    return { success: false, status: 0, latencyMs: 0 }
  } catch (e) {
    return { success: false, status: 0, latencyMs: 0 }
  }
}
`