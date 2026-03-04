// ==================== Emby 多后端代理（终极优化版 + 视觉升级）====================
/**
 * 功能特性：
 * - 负载均衡：每个后端标识可配置多个 URL，随机选择健康的 URL 转发
 * - 健康检查：定时任务每分钟检测所有 URL 可用性，首页显示在线/离线状态
 * - 管理面板：/admin 路径，支持增删改后端，实时预览液态玻璃背景、文字颜色
 * - 缓存优化：静态资源永久缓存，支持版本控制一键刷新
 * - WebSocket 兼容：实时通知、同步进度正常
 * - 重定向重写：防止跳出代理，强制 HTTPS
 * - UA 伪装、CSP 绕过、HTML 弹窗过滤（可选）
 * - 安全性增强：密码从环境变量读取、防爆破、会话 Cookie
 * - 交互优化：Toast 提示、URL 校验、删除确认
 * - 性能优化：健康检查增量写入、配置版本号防并发覆盖
 * - 功能扩展：导入/导出配置、批量删除、导出选中项
 * - 视觉升级：毛玻璃 2.0、呼吸灯优化、平滑过滤、响应式网格、智能 URL 校验、空状态设计
 *
 * 部署要求：
 * 1. 在 Cloudflare Workers 中创建 KV 命名空间，绑定变量名为 EMBY_KV
 * 2. 在 Worker 设置中添加 Cron 触发器（例如 * * * * *）以启用健康检查
 * 3. 在环境变量中设置 ADMIN_PASS 为强密码（不要写在代码中）
 */

const myConfig = {
  defaultBackends: {},
  defaultBackend: '',
  backendCookieName: 'backend',
  cacheVersion: 'v1',
  enableCors: true,
  enableCache: true,
  enableUAMasking: true,
  enableCSPBypass: true,
  enableHtmlFilter: false,
  filterSelectors: ['.notice', '#popup', '.advertisement'],
  staticCacheTTL: 31536000,
  rewriteReferer: false,
  rewriteOrigin: false,
};

const ADMIN_USER = 'admin';
const RESERVED_PATHS = new Set(['web', 'emby', 'Items', 'Users', 'admin', 'health', 'ping']);
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DEFAULT_UI = {
  backgroundUrl: '',
  blurStrength: 10,
  applyToHome: false,
  textColor: 'dark',
};

// ---------- 内存缓存 ----------
let cachedBackends = null;
let cachedUi = null;
let configPromise = null;

async function getBackends(env) {
  if (cachedBackends) return cachedBackends;
  if (configPromise) return configPromise;
  configPromise = (async () => {
    let backends = {};
    try {
      const stored = await env.EMBY_KV.get('backends', 'json');
      if (stored && typeof stored === 'object') {
        for (const [key, value] of Object.entries(stored)) {
          if (Array.isArray(value)) {
            backends[key] = {
              urls: value,
              healthy: new Array(value.length).fill(true),
              remark: ''
            };
          } else if (typeof value === 'object' && value !== null) {
            const urls = Array.isArray(value.urls) ? value.urls : [];
            backends[key] = {
              urls: urls,
              healthy: new Array(urls.length).fill(true),
              remark: value.remark || ''
            };
          }
        }
      }
    } catch (e) {}
    try {
      const health = await env.EMBY_KV.get('health', 'json');
      if (health) {
        for (const [key, urlHealth] of Object.entries(health)) {
          if (backends[key]) {
            for (let i = 0; i < backends[key].urls.length; i++) {
              const url = backends[key].urls[i];
              if (urlHealth[url] !== undefined) backends[key].healthy[i] = urlHealth[url];
            }
          }
        }
      }
    } catch (e) {}
    cachedBackends = backends;
    configPromise = null;
    return backends;
  })();
  return configPromise;
}

async function getUiConfig(env) {
  if (cachedUi) return cachedUi;
  try {
    const stored = await env.EMBY_KV.get('ui_config', 'json');
    cachedUi = stored ? { ...DEFAULT_UI, ...stored } : DEFAULT_UI;
  } catch {
    cachedUi = DEFAULT_UI;
  }
  return cachedUi;
}

async function updateBackends(env, newBackends, expectedVersion, clientIP) {
  const currentVersion = (await env.EMBY_KV.get('config_version')) || '0';
  if (expectedVersion !== currentVersion) {
    throw new Error('配置已被其他管理员修改，请刷新后重试');
  }
  const storeData = {};
  for (const [key, value] of Object.entries(newBackends)) {
    storeData[key] = {
      urls: value.urls || value,
      remark: value.remark || ''
    };
  }
  await env.EMBY_KV.put('backends', JSON.stringify(storeData));
  const newVersion = (parseInt(currentVersion) + 1).toString();
  await env.EMBY_KV.put('config_version', newVersion);
  // 记录最后修改信息
  const lastModified = {
    ip: clientIP,
    time: Date.now()
  };
  await env.EMBY_KV.put('last_modified', JSON.stringify(lastModified));
  cachedBackends = newBackends;
  return newVersion;
}

async function updateHealth(env, healthData) {
  const existing = await env.EMBY_KV.get('health', 'json').catch(() => null);
  if (existing && JSON.stringify(existing) === JSON.stringify(healthData)) {
    return;
  }
  await env.EMBY_KV.put('health', JSON.stringify(healthData));
  if (cachedBackends) {
    for (const [key, urlHealth] of Object.entries(healthData)) {
      if (cachedBackends[key]) {
        for (let i = 0; i < cachedBackends[key].urls.length; i++) {
          const url = cachedBackends[key].urls[i];
          if (urlHealth[url] !== undefined) cachedBackends[key].healthy[i] = urlHealth[url];
        }
      }
    }
  }
}

async function updateUiConfig(env, ui) {
  await env.EMBY_KV.put('ui_config', JSON.stringify(ui));
  cachedUi = ui;
}

// ---------- 健康检查定时任务（并行版 + 增量写入）----------
export async function scheduled(event, env, ctx) {
  const backends = await getBackends(env);
  const health = {};
  const promises = [];

  for (const [key, { urls }] of Object.entries(backends)) {
    health[key] = {};
    for (const url of urls) {
      const promise = (async () => {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);
          const res = await fetch(url + '/health', { method: 'HEAD', signal: controller.signal }).catch(() => null);
          clearTimeout(timeout);
          health[key][url] = res && res.ok;
        } catch {
          health[key][url] = false;
        }
      })();
      promises.push(promise);
    }
  }
  await Promise.allSettled(promises);
  await updateHealth(env, health);
}

function selectHealthyUrl(backend) {
  const { urls, healthy } = backend;
  const healthyIndices = [];
  for (let i = 0; i < urls.length; i++) if (healthy[i]) healthyIndices.push(i);
  if (healthyIndices.length === 0) return urls[0];
  return urls[healthyIndices[Math.floor(Math.random() * healthyIndices.length)]];
}

function isMediaRequest(path) {
  const lcPath = path.toLowerCase();
  if (lcPath.endsWith('.mp4') || lcPath.endsWith('.mkv') || lcPath.endsWith('.avi') ||
      lcPath.endsWith('.mov') || lcPath.endsWith('.flv') || lcPath.endsWith('.wmv') ||
      lcPath.endsWith('.mp3') || lcPath.endsWith('.flac') || lcPath.endsWith('.aac') ||
      lcPath.endsWith('.m4a')) {
    return true;
  }
  if (lcPath.includes('/videos/') || lcPath.includes('/audio/') ||
      lcPath.includes('/stream/') || lcPath.includes('/play/')) {
    return true;
  }
  return false;
}

function isStaticResource(path) {
  const lcPath = path.toLowerCase();
  if (lcPath.endsWith('.js') || lcPath.endsWith('.css') || lcPath.endsWith('.png') ||
      lcPath.endsWith('.jpg') || lcPath.endsWith('.jpeg') || lcPath.endsWith('.gif') ||
      lcPath.endsWith('.ico') || lcPath.endsWith('.svg') || lcPath.endsWith('.woff') ||
      lcPath.endsWith('.woff2') || lcPath.endsWith('.ttf') || lcPath.endsWith('.eot')) {
    return true;
  }
  if (lcPath.includes('/web/') || lcPath.includes('/favicon.ico')) {
    return true;
  }
  return false;
}

function buildProxyHeaders(req, targetBase, targetHostname) {
  const headers = new Headers(req.headers);
  headers.set('Host', targetHostname);

  if (myConfig.rewriteReferer && headers.has('Referer')) {
    headers.set('Referer', targetBase);
  }
  if (myConfig.rewriteOrigin && headers.has('Origin')) {
    headers.set('Origin', targetBase);
  }

  if (myConfig.enableUAMasking) {
    if (!headers.has('user-agent') || headers.get('user-agent').includes('Cloudflare')) {
      headers.set('User-Agent', DEFAULT_UA);
    }
  }
  headers.delete('connection');
  return headers;
}

function rewriteLocation(location, requestUrl, targetBase, backendKey) {
  if (!location) return location;
  try {
    const locUrl = new URL(location, targetBase);
    if (locUrl.origin === new URL(targetBase).origin) {
      const workerUrl = new URL(requestUrl);
      workerUrl.protocol = 'https:';
      workerUrl.pathname = '/' + backendKey + locUrl.pathname;
      workerUrl.search = locUrl.search;
      return workerUrl.toString();
    }
  } catch {}
  return location;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (!env.EMBY_KV) return new Response('请绑定 KV 命名空间 EMBY_KV', { status: 500 });

    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && !url.hostname.includes('127.0.0.1')) {
      return Response.redirect(`https://${url.host}${url.pathname}${url.search}`, 301);
    }

    if (path === '/admin') return handleAdmin(req, env);

    const backends = await getBackends(env);
    const ui = await getUiConfig(env);

    if (req.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (path === '/health' || path === '/ping') {
      return new Response('OK', { status: 200, headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' } });
    }

    let backendKey = null;
    let rewrittenPath = path;
    const pathParts = path.split('/').filter(p => p.length > 0);
    if (pathParts.length > 0 && !RESERVED_PATHS.has(pathParts[0]) && backends[pathParts[0]]) {
      backendKey = pathParts[0];
      rewrittenPath = '/' + pathParts.slice(1).join('/');
    }
    if (!backendKey) {
      const cookie = req.headers.get('Cookie');
      const match = cookie?.match(new RegExp(`${myConfig.backendCookieName}=([^;]+)`));
      if (match && backends[match[1]]) backendKey = match[1];
    }

    if (path === '/' && !backendKey) {
      return new Response(renderHomePage(backends, myConfig.cacheVersion, ui), {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' },
      });
    }

    backendKey = backendKey || myConfig.defaultBackend;
    const backend = backends[backendKey];
    if (!backend) return new Response('未找到后端配置，请前往 /admin 设置', { status: 404 });

    const targetBase = selectHealthyUrl(backend);
    const targetHostname = new URL(targetBase).hostname;

    const rewrittenUrl = new URL(url.toString());
    rewrittenUrl.pathname = rewrittenPath;

    if (isMediaRequest(rewrittenPath)) {
      return handleMediaStream(req, rewrittenUrl, targetBase, targetHostname, backendKey);
    }
    if (myConfig.enableCache && isStaticResource(rewrittenPath)) {
      return handleWithCache(req, rewrittenUrl, targetBase, targetHostname, ctx, backendKey);
    }
    return handleApiRequest(req, rewrittenUrl, targetBase, targetHostname, backendKey);
  },
};

// -------------------- 管理面板（终极视觉版）--------------------
async function handleAdmin(req, env) {
  const url = new URL(req.url);
  const clientIP = req.headers.get('CF-Connecting-IP') || 'unknown';

  const cookies = req.headers.get('Cookie') || '';
  const sessionMatch = cookies.match(/admin_session=([^;]+)/);
  let sessionValid = false;
  if (sessionMatch) {
    const sessionToken = sessionMatch[1];
    const sessionData = await env.EMBY_KV.get(`session:${sessionToken}`).catch(() => null);
    if (sessionData === ADMIN_USER) {
      sessionValid = true;
    }
  }

  if (!sessionValid) {
    const failKey = `auth_fail:${clientIP}`;
    const failData = await env.EMBY_KV.get(failKey, 'json').catch(() => null);
    if (failData && failData.count >= 5 && Date.now() - failData.firstFail < 10 * 60 * 1000) {
      return new Response('Too many failed attempts, please try after 10 minutes', { status: 403 });
    }

    const auth = req.headers.get('Authorization');
    if (!auth) {
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="Admin"' },
      });
    }
    const [user, pass] = atob(auth.split(' ')[1]).split(':');
    const adminPass = env.ADMIN_PASS;
    if (!adminPass) {
      return new Response('Server misconfiguration: ADMIN_PASS not set', { status: 500 });
    }
    if (user !== ADMIN_USER || pass !== adminPass) {
      const newFailData = {
        count: (failData?.count || 0) + 1,
        firstFail: failData?.firstFail || Date.now()
      };
      await env.EMBY_KV.put(failKey, JSON.stringify(newFailData), { expirationTtl: 600 });
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="Admin"' },
      });
    }

    await env.EMBY_KV.delete(failKey).catch(() => {});

    const sessionToken = crypto.randomUUID();
    await env.EMBY_KV.put(`session:${sessionToken}`, ADMIN_USER, { expirationTtl: 86400 });
    env.sessionCookie = `admin_session=${sessionToken}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`;
  }

  if (req.method === 'POST') {
    try {
      const data = await req.json();
      if (data.backends) {
        const newBackends = {};
        for (const [key, val] of Object.entries(data.backends)) {
          let urls = [];
          let remark = '';
          if (Array.isArray(val)) {
            urls = val;
          } else if (typeof val === 'object' && val !== null) {
            urls = Array.isArray(val.urls) ? val.urls : [];
            remark = val.remark || '';
          }
          newBackends[key] = {
            urls: urls,
            healthy: new Array(urls.length).fill(true),
            remark: remark
          };
        }
        const expectedVersion = data.version;
        const newVersion = await updateBackends(env, newBackends, expectedVersion, clientIP);
        if (data.defaultBackend) {
          await env.EMBY_KV.put('defaultBackend', data.defaultBackend);
        }
        return new Response(JSON.stringify({ success: true, version: newVersion }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (data.ui) {
        await updateUiConfig(env, data.ui);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
  }

  const backends = await getBackends(env);
  const defaultBackend = await env.EMBY_KV.get('defaultBackend') || '';
  const ui = await getUiConfig(env);
  const configVersion = (await env.EMBY_KV.get('config_version')) || '0';
  const lastModified = await env.EMBY_KV.get('last_modified', 'json').catch(() => null);
  const workerOrigin = new URL(req.url).origin;

  // 计算统计指标
  const totalBackends = Object.keys(backends).length;
  const totalUrls = Object.values(backends).reduce((acc, b) => acc + b.urls.length, 0);
  const healthyUrls = Object.values(backends).reduce((acc, b) => acc + b.healthy.filter(Boolean).length, 0);
  const onlineRate = totalUrls > 0 ? Math.round((healthyUrls / totalUrls) * 100) : 0;

  function escapeHtml(unsafe) {
    return unsafe
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // 内联脚本
  const copyFunctionScript = `
    function copyText(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
          showToast('已复制到剪贴板', 'success');
        }).catch(() => {
          prompt('手动复制：', text);
        });
      } else {
        prompt('手动复制：', text);
      }
    }
  `;

  const filterScript = `
    function filterCards() {
      const searchText = document.getElementById('serverSearch').value.toLowerCase();
      const cards = document.querySelectorAll('.health-grid > div');
      cards.forEach(card => {
        const key = card.getAttribute('data-key') || '';
        const remark = card.getAttribute('data-remark') || '';
        if (key.toLowerCase().includes(searchText) || remark.toLowerCase().includes(searchText)) {
          card.style.opacity = '1';
          card.style.transform = 'scale(1)';
          card.style.display = '';
        } else {
          card.style.opacity = '0';
          card.style.transform = 'scale(0.95)';
          setTimeout(() => { card.style.display = 'none'; }, 300);
        }
      });
    }
  `;

  const toastScript = `
    function showToast(message, type = 'success') {
      const toast = document.getElementById('toast');
      toast.textContent = message;
      toast.className = 'toast show ' + type;
      setTimeout(() => {
        toast.className = 'toast';
      }, 3000);
    }
  `;

  const validateUrls = `
    function isValidUrl(str) {
      try {
        new URL(str);
        return true;
      } catch {
        return false;
      }
    }
    function checkUrlProtocol(textarea) {
      const lines = textarea.value.split('\\n');
      const warnings = [];
      lines.forEach((line, index) => {
        line = line.trim();
        if (line && !line.match(/^https?:\\/\\//i)) {
          warnings.push(\`第 \${index+1} 行缺少 http/https 协议\`);
        }
      });
      const warningDiv = textarea.parentNode.querySelector('.url-warning');
      if (warnings.length > 0) {
        if (!warningDiv) {
          const div = document.createElement('div');
          div.className = 'url-warning';
          div.style.color = '#eab308';
          div.style.fontSize = '0.8rem';
          div.style.marginTop = '4px';
          div.innerHTML = warnings.join('<br>');
          textarea.parentNode.appendChild(div);
        } else {
          warningDiv.innerHTML = warnings.join('<br>');
        }
      } else if (warningDiv) {
        warningDiv.remove();
      }
    }
  `;

  const confirmDelete = `
    function confirmDelete(key) {
      if (confirm('确定要删除服务器组 "' + key + '" 吗？')) {
        delete config.backends[key];
        renderConfig();
        showToast('已删除', 'info');
      }
    }
  `;

  const batchScript = `
    function toggleAll(checked) {
      document.querySelectorAll('.select-item').forEach(cb => cb.checked = checked);
    }
    function deleteSelected() {
      const selected = [];
      document.querySelectorAll('.select-item:checked').forEach(cb => {
        selected.push(cb.value);
      });
      if (selected.length === 0) {
        showToast('请先选择要删除的服务器组', 'warning');
        return;
      }
      if (confirm('确定要删除选中的 ' + selected.length + ' 个服务器组吗？')) {
        selected.forEach(key => delete config.backends[key]);
        renderConfig();
        showToast('已删除选中项', 'info');
      }
    }
    function exportSelected() {
      const selected = [];
      document.querySelectorAll('.select-item:checked').forEach(cb => {
        selected.push(cb.value);
      });
      if (selected.length === 0) {
        showToast('请先选择要导出的服务器组', 'warning');
        return;
      }
      const exportObj = {};
      selected.forEach(key => {
        exportObj[key] = config.backends[key];
      });
      const exportData = {
        backends: exportObj,
        defaultBackend: document.getElementById('default').value,
        ui: ui,
        version: currentVersion
      };
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'emby-selected.json';
      a.click();
      URL.revokeObjectURL(url);
    }
  `;

  const importExportScript = `
    function exportConfig() {
      const exportData = {
        backends: config.backends,
        defaultBackend: document.getElementById('default').value,
        ui: ui,
        version: currentVersion
      };
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'emby-backup.json';
      a.click();
      URL.revokeObjectURL(url);
    }
    function importConfig(event) {
      const file = event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const imported = JSON.parse(e.target.result);
          if (imported.backends && typeof imported.backends === 'object') {
            config.backends = imported.backends;
            if (imported.defaultBackend) document.getElementById('default').value = imported.defaultBackend;
            if (imported.ui) {
              ui = imported.ui;
              document.getElementById('bgUrl').value = ui.backgroundUrl || '';
              document.getElementById('blurRange').value = ui.blurStrength || 10;
              document.getElementById('applyHome').checked = ui.applyToHome || false;
              document.querySelectorAll('input[name="textColor"]').forEach(r => {
                if (r.value === (ui.textColor || 'dark')) r.checked = true;
              });
              updateBlur(ui.blurStrength || 10);
              updateTextColor(ui.textColor || 'dark');
              previewBg();
            }
            if (imported.version) currentVersion = imported.version;
            renderConfig();
            showToast('导入成功', 'success');
          } else {
            showToast('无效的配置文件', 'error');
          }
        } catch (err) {
          showToast('解析失败：' + err.message, 'error');
        }
      };
      reader.readAsText(file);
    }
  `;

  const themeToggleScript = `
    function toggleTheme() {
      const body = document.body;
      if (body.classList.contains('light-theme')) {
        body.classList.remove('light-theme');
        ui.textColor = 'dark';
      } else {
        body.classList.add('light-theme');
        ui.textColor = 'light';
      }
      document.querySelectorAll('input[name="textColor"]').forEach(r => {
        if (r.value === ui.textColor) r.checked = true;
      });
      updateTextColor(ui.textColor);
    }
  `;

  // 生成健康卡片（呼吸灯优化）
  const healthCards = Object.entries(backends).map(([key, { urls, healthy, remark }]) => {
    const total = urls.length;
    const healthyCount = healthy.filter(Boolean).length;
    const statusColor = healthyCount === total ? '#22c55e' : (healthyCount > 0 ? '#eab308' : '#ef4444');
    const proxyAddress = `${workerOrigin}/${key}`;
    const proxyDisplay = proxyAddress.replace(/^https?:\/\//, '');
    return `
      <div data-key="${escapeHtml(key)}" data-remark="${escapeHtml(remark || '')}" class="health-card">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <div style="display: flex; align-items: center; gap: 5px;">
            <input type="checkbox" class="select-item" value="${escapeHtml(key)}" style="width: auto; margin: 0;">
            <strong style="font-size: 1.1em;">${escapeHtml(key)}</strong>
          </div>
          ${remark ? `<span class="remark-badge">${escapeHtml(remark)}</span>` : ''}
          <span class="status-badge" style="color: ${statusColor};">
            <span class="pulse-dot" style="background: ${statusColor}; box-shadow: 0 0 0 0 ${statusColor};"></span>
            ${healthyCount}/${total}
          </span>
        </div>
        <div class="proxy-row">
          <span class="proxy-label"><i class="fas fa-link"></i> 代理：</span>
          <span class="proxy-url">${escapeHtml(proxyDisplay)}</span>
          <button class="copy-btn" onclick="copyText('${escapeHtml(proxyAddress)}')" title="复制代理地址"><i class="fas fa-copy"></i></button>
        </div>
        <ul class="url-list">
          ${urls.map((url, index) => `
            <li>
              <span class="url-status" style="background: ${healthy[index] ? '#22c55e' : '#ef4444'};"></span>
              <span class="url-text">${escapeHtml(url)}</span>
              <button class="copy-btn" onclick="copyText('${escapeHtml(url)}')" title="复制URL"><i class="fas fa-copy"></i></button>
            </li>
          `).join('')}
        </ul>
      </div>
    `;
  }).join('');

  // 空状态显示
  const emptyState = totalBackends === 0 ? `
    <div style="text-align: center; padding: 40px 20px; background: rgba(255,255,255,0.05); border-radius: 28px;">
      <i class="fas fa-server" style="font-size: 3rem; opacity: 0.3; margin-bottom: 16px;"></i>
      <p style="opacity: 0.7;">暂无后端配置，点击下方按钮开始添加</p>
    </div>
  ` : '';

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Emby 管理面板 · 视觉升级</title>
      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css">
      <style>
        /* 色彩系统 - Indigo 主色调 */
        :root {
          --primary-50: #eef2ff;
          --primary-100: #e0e7ff;
          --primary-200: #c7d2fe;
          --primary-300: #a5b4fc;
          --primary-400: #818cf8;
          --primary-500: #6366f1; /* Indigo-500 */
          --primary-600: #4f46e5;
          --primary-700: #4338ca;
          --primary-800: #3730a3;
          --primary-900: #312e81;
          --success: #22c55e;
          --warning: #eab308;
          --error: #ef4444;
          --info: #3b82f6;
          --surface: rgba(15, 23, 42, 0.8);
          --text-primary: #f8fafc;
          --text-secondary: rgba(248, 250, 252, 0.6);
        }
        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }
        body {
          font-family: 'Inter', system-ui, -apple-system, sans-serif;
          max-width: 1400px;
          margin: 0 auto;
          padding: 24px;
          background: #0f172a;
          transition: background-color 0.3s, color 0.3s, background-image 0.3s;
          background-size: cover;
          background-position: center;
          background-attachment: fixed;
          color: var(--text-primary);
        }
        body.has-bg {
          background-image: url('${escapeHtml(ui.backgroundUrl)}');
        }
        body.light-theme {
          color: #1e293b;
          --text-primary: #1e293b;
          --text-secondary: rgba(30, 41, 59, 0.6);
        }
        /* 毛玻璃 2.0 强化 */
        .glass-panel {
          background: rgba(255, 255, 255, 0.08);
          backdrop-filter: saturate(180%) blur(${ui.blurStrength}px);
          -webkit-backdrop-filter: saturate(180%) blur(${ui.blurStrength}px);
          border-radius: 32px;
          padding: 28px;
          box-shadow: 
            0 20px 40px -12px rgba(0, 0, 0, 0.5),
            0 8px 24px -8px rgba(0, 0, 0, 0.3),
            0 0 0 1px rgba(255, 255, 255, 0.1) inset;
          border: 1px solid rgba(255, 255, 255, 0.05);
          color: inherit;
        }
        /* 统计卡片 */
        .stats-row {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 16px;
          margin-bottom: 28px;
        }
        .stat-card {
          background: rgba(255, 255, 255, 0.05);
          backdrop-filter: saturate(180%) blur(8px);
          border-radius: 24px;
          padding: 16px 20px;
          display: flex;
          align-items: center;
          gap: 16px;
          border: 1px solid rgba(255,255,255,0.1);
          box-shadow: 0 8px 16px -4px rgba(0,0,0,0.3);
        }
        .stat-icon {
          font-size: 2.2rem;
          opacity: 0.9;
          color: var(--primary-400);
        }
        .stat-content {
          display: flex;
          flex-direction: column;
        }
        .stat-label {
          font-size: 0.85rem;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--text-secondary);
        }
        .stat-value {
          font-size: 1.8rem;
          font-weight: 600;
          line-height: 1.2;
        }
        .stat-unit {
          font-size: 0.9rem;
          margin-left: 4px;
          opacity: 0.6;
        }
        /* 健康卡片网格 */
        .health-grid {
          display: grid;
          gap: 16px;
          grid-template-columns: repeat(3, 1fr);
          margin-bottom: 16px;
        }
        .health-card {
          background: rgba(255, 255, 255, 0.05);
          backdrop-filter: saturate(180%) blur(8px);
          border-radius: 24px;
          padding: 16px;
          border: 1px solid rgba(255,255,255,0.1);
          box-shadow: 0 12px 28px -8px rgba(0,0,0,0.3);
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .health-card:hover {
          transform: translateY(-3px);
          box-shadow: 0 24px 36px -12px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.2) inset;
        }
        .status-badge {
          display: flex;
          align-items: center;
          gap: 6px;
          font-weight: 500;
          background: rgba(0,0,0,0.3);
          padding: 4px 12px;
          border-radius: 40px;
          font-size: 0.85rem;
        }
        /* 呼吸灯优化：cubic-bezier 曲线 + 光晕 */
        .pulse-dot {
          display: inline-block;
          width: 8px;
          height: 8px;
          border-radius: 50%;
          animation: pulse-glow 2s cubic-bezier(0.4, 0, 0.2, 1) infinite;
        }
        @keyframes pulse-glow {
          0% { box-shadow: 0 0 0 0 currentColor, 0 0 0 0 rgba(255,255,255,0.4); opacity: 1; }
          70% { box-shadow: 0 0 0 6px transparent, 0 0 0 10px rgba(255,255,255,0.1); opacity: 0.7; }
          100% { box-shadow: 0 0 0 0 transparent, 0 0 0 0 transparent; opacity: 1; }
        }
        .remark-badge {
          background: rgba(255,255,255,0.1);
          padding: 4px 12px;
          border-radius: 40px;
          font-size: 0.8rem;
          font-weight: 400;
          backdrop-filter: blur(4px);
          color: var(--text-secondary);
        }
        .proxy-row {
          background: rgba(0,0,0,0.3);
          border-radius: 40px;
          padding: 8px 14px;
          margin: 10px 0 8px;
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 0.9rem;
        }
        .proxy-label {
          color: var(--text-secondary);
          white-space: nowrap;
        }
        .proxy-url {
          flex: 1;
          word-break: break-all;
        }
        .copy-btn {
          background: rgba(255,255,255,0.1);
          border: none;
          color: inherit;
          padding: 6px 12px;
          border-radius: 40px;
          cursor: pointer;
          transition: all 0.2s;
          display: inline-flex;
          align-items: center;
          gap: 4px;
          font-size: 0.85rem;
        }
        .copy-btn:hover {
          background: rgba(255,255,255,0.2);
          transform: scale(1.05);
        }
        .url-list {
          list-style: none;
          padding: 0;
          margin: 8px 0 0;
        }
        .url-list li {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 6px;
          font-size: 0.85rem;
          background: rgba(0,0,0,0.2);
          padding: 8px 14px;
          border-radius: 40px;
        }
        .url-status {
          display: inline-block;
          width: 8px;
          height: 8px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .url-text {
          flex: 1;
          word-break: break-all;
        }
        /* 配置区域网格布局 - 响应式 */
        .config-grid {
          display: grid;
          grid-template-columns: 1fr 1.5fr 3fr auto;
          gap: 12px;
          align-items: start;
        }
        .config-item {
          background: rgba(255,255,255,0.05);
          border-radius: 20px;
          padding: 16px;
          border: 1px solid rgba(255,255,255,0.1);
          margin-bottom: 12px;
        }
        @media (max-width: 768px) {
          .config-grid {
            grid-template-columns: 1fr;
            gap: 8px;
          }
        }
        .section {
          margin-top: 28px;
          padding: 20px;
          background: rgba(255,255,255,0.05);
          border-radius: 28px;
          border: 1px solid rgba(255,255,255,0.1);
        }
        h2 { font-size: 2rem; font-weight: 600; margin-bottom: 16px; letter-spacing: -0.02em; }
        h3 { font-size: 1.4rem; font-weight: 500; margin: 16px 0 12px; color: var(--text-primary); }
        input, button, textarea, select {
          padding: 12px 18px;
          font-size: 0.95rem;
          width: 100%;
          border-radius: 40px;
          border: 1px solid rgba(255,255,255,0.15);
          background: rgba(0,0,0,0.3);
          color: inherit;
          transition: border 0.3s ease, background 0.3s ease;
        }
        input:focus, textarea:focus, select:focus {
          outline: none;
          border-color: var(--primary-400);
          background: rgba(0,0,0,0.4);
          box-shadow: 0 0 0 2px var(--primary-500/20);
        }
        textarea {
          resize: vertical;
          min-height: 60px;
          height: auto;
        }
        button {
          width: auto;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          font-weight: 500;
          border: 1px solid rgba(255,255,255,0.1);
          background: rgba(255,255,255,0.1);
        }
        button:hover {
          background: rgba(255,255,255,0.15);
        }
        .save-btn {
          background: var(--primary-500);
          color: white;
          border: none;
          padding: 14px 28px;
          font-size: 1.1rem;
          margin-top: 16px;
          transition: all 0.2s;
          border-radius: 40px;
        }
        .save-btn.loading {
          background: var(--warning);
          pointer-events: none;
        }
        .save-btn.success {
          background: var(--success);
        }
        .flex-row {
          display: flex;
          gap: 12px;
          align-items: center;
          flex-wrap: wrap;
        }
        .search-area {
          display: flex;
          gap: 12px;
          margin-bottom: 20px;
        }
        .batch-bar {
          display: flex;
          gap: 12px;
          flex-wrap: wrap;
          margin-bottom: 16px;
          align-items: center;
        }
        .toast {
          visibility: hidden;
          min-width: 280px;
          background: #1e293b;
          color: white;
          text-align: center;
          border-radius: 40px;
          padding: 14px 24px;
          position: fixed;
          z-index: 1000;
          left: 50%;
          transform: translateX(-50%);
          bottom: 30px;
          opacity: 0;
          transition: opacity 0.3s, visibility 0.3s;
          box-shadow: 0 12px 24px -8px black;
        }
        .toast.show {
          visibility: visible;
          opacity: 1;
        }
        .toast.success { background: var(--success); }
        .toast.error { background: var(--error); }
        .toast.warning { background: var(--warning); }
        .toast.info { background: var(--info); }
        .theme-toggle {
          position: fixed;
          bottom: 24px;
          right: 24px;
          background: rgba(255,255,255,0.1);
          backdrop-filter: saturate(180%) blur(10px);
          border: 1px solid rgba(255,255,255,0.2);
          border-radius: 40px;
          padding: 12px 20px;
          font-size: 1.2rem;
          cursor: pointer;
          z-index: 100;
          color: inherit;
        }
        .version-info {
          display: flex;
          align-items: center;
          gap: 12px;
          font-size: 0.9rem;
          color: var(--text-secondary);
          margin-bottom: 8px;
        }
        .url-warning {
          color: var(--warning);
          font-size: 0.8rem;
          margin-top: 4px;
        }
      </style>
    </head>
    <body class="${ui.backgroundUrl ? 'has-bg' : ''} ${ui.textColor === 'light' ? 'light-theme' : ''}" style="background-image: url('${escapeHtml(ui.backgroundUrl)}');">
      <div class="glass-panel">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
          <h2><i class="fas fa-server" style="color: var(--primary-400);"></i> Emby 多后端管理</h2>
          <button class="copy-btn" onclick="toggleTheme()" title="切换深/浅色模式" style="padding: 10px 16px;">
            <i class="fas fa-adjust"></i> 主题
          </button>
        </div>

        <!-- 统计卡片 + 版本追溯 -->
        <div class="stats-row">
          <div class="stat-card">
            <i class="fas fa-database stat-icon"></i>
            <div class="stat-content">
              <span class="stat-label">总后端组</span>
              <span class="stat-value">${totalBackends}</span>
            </div>
          </div>
          <div class="stat-card">
            <i class="fas fa-link stat-icon"></i>
            <div class="stat-content">
              <span class="stat-label">总后端节点</span>
              <span class="stat-value">${totalUrls}</span>
            </div>
          </div>
          <div class="stat-card">
            <i class="fas fa-heartbeat stat-icon"></i>
            <div class="stat-content">
              <span class="stat-label">在线率</span>
              <span class="stat-value">${onlineRate}<span class="stat-unit">%</span></span>
            </div>
          </div>
          <div class="stat-card">
            <i class="fas fa-tag stat-icon"></i>
            <div class="stat-content">
              <span class="stat-label">配置版本</span>
              <span class="stat-value">${configVersion}</span>
              <span class="stat-unit" style="font-size:0.7rem;">最后修改: ${lastModified ? new Date(lastModified.time).toLocaleString() + ' ' + lastModified.ip : '无'}</span>
            </div>
          </div>
        </div>

        <!-- 健康卡片区域 -->
        <div class="section">
          <h3><i class="fas fa-heartbeat" style="color: var(--primary-400);"></i> 服务器健康状态</h3>
          <div class="search-area">
            <input type="text" id="serverSearch" placeholder="🔍 搜索名称或备注..." oninput="filterCards()">
            <button class="copy-btn" onclick="document.getElementById('serverSearch').value=''; filterCards();"><i class="fas fa-undo"></i> 重置</button>
          </div>
          <div class="batch-bar">
            <label><input type="checkbox" onchange="toggleAll(this.checked)"> 全选</label>
            <button class="copy-btn" onclick="deleteSelected()"><i class="fas fa-trash-alt"></i> 删除选中</button>
            <button class="copy-btn" onclick="exportSelected()"><i class="fas fa-download"></i> 导出选中</button>
            <button class="copy-btn" onclick="exportConfig()"><i class="fas fa-file-export"></i> 导出全部</button>
            <input type="file" id="importFile" accept=".json,application/json" style="display:none;" onchange="importConfig(event)">
            <button class="copy-btn" onclick="document.getElementById('importFile').click()"><i class="fas fa-upload"></i> 导入配置</button>
          </div>
          <div class="health-grid">
            ${healthCards || emptyState}
          </div>
        </div>

        <!-- 后端配置区域（网格布局） -->
        <h3><i class="fas fa-cogs" style="color: var(--primary-400);"></i> 后端服务器配置</h3>
        <div id="config-list" style="display: flex; flex-direction: column; gap: 12px;"></div>
        <div class="flex-row" style="margin: 16px 0;">
          <button onclick="add()"><i class="fas fa-plus-circle" style="color: var(--primary-400);"></i> 添加新服务器组</button>
          <label>默认启动后端 (Key):</label>
          <input type="text" id="default" value="${escapeHtml(defaultBackend)}" style="width: 200px;">
        </div>

        <!-- 外观设置 -->
        <div class="section">
          <h3><i class="fas fa-palette" style="color: var(--primary-400);"></i> 外观设置</h3>
          <div class="flex-row">
            <input type="text" id="bgUrl" placeholder="背景图片 URL" value="${escapeHtml(ui.backgroundUrl || '')}">
            <button class="copy-btn" onclick="previewBg()"><i class="fas fa-eye"></i> 预览</button>
          </div>
          <div>
            <label>模糊强度: <span id="blurVal">${ui.blurStrength}</span>px</label>
            <input type="range" id="blurRange" min="0" max="20" value="${ui.blurStrength}" oninput="updateBlur(this.value)">
          </div>
          <div class="flex-row" style="margin: 12px 0;">
            <label>文字颜色：</label>
            <label><input type="radio" name="textColor" value="dark" ${ui.textColor === 'dark' ? 'checked' : ''} onchange="updateTextColor('dark')"> 深色</label>
            <label><input type="radio" name="textColor" value="light" ${ui.textColor === 'light' ? 'checked' : ''} onchange="updateTextColor('light')"> 浅色</label>
            <label>
              <input type="checkbox" id="applyHome" ${ui.applyToHome ? 'checked' : ''}> 应用到首页
            </label>
          </div>
          <div class="preview-box" id="preview" style="background-image: url('${escapeHtml(ui.backgroundUrl)}');"></div>
          <div class="note"><i class="fas fa-info-circle"></i> 背景需 HTTPS 且允许跨域。</div>
        </div>

        <button class="save-btn" id="saveBtn" onclick="save()"><i class="fas fa-save"></i> 保存所有配置</button>
      </div>

      <div id="toast" class="toast"></div>
      <div class="theme-toggle" onclick="toggleTheme()"><i class="fas fa-adjust"></i></div>

      <script>
        ${copyFunctionScript}
        ${filterScript}
        ${toastScript}
        ${validateUrls}
        ${confirmDelete}
        ${batchScript}
        ${importExportScript}
        ${themeToggleScript}

        let rawConfig = ${JSON.stringify(backends)};
        let config = { backends: {} };
        for (let k in rawConfig) {
          config.backends[k] = {
            urls: rawConfig[k].urls || [],
            remark: rawConfig[k].remark || ''
          };
        }

        let ui = {
          backgroundUrl: '${escapeHtml(ui.backgroundUrl || '')}',
          blurStrength: ${ui.blurStrength},
          applyToHome: ${ui.applyToHome},
          textColor: '${ui.textColor}'
        };
        let currentVersion = '${configVersion}';
        let saveBtn = document.getElementById('saveBtn');

        function renderConfig() {
          const container = document.getElementById('config-list');
          container.innerHTML = '';
          for (let k in config.backends) {
            const item = config.backends[k];
            const urlsText = Array.isArray(item.urls) ? item.urls.join('\\n') : '';
            const div = document.createElement('div');
            div.className = 'config-item';
            div.innerHTML = \`
              <div class="config-grid">
                <div><strong>Key</strong><input type="text" value="\${k}" onchange="updateKey('\${k}', this.value)"></div>
                <div><strong>备注</strong><input type="text" value="\${item.remark || ''}" placeholder="例如：主服务器" onchange="updateRemark('\${k}', this.value)"></div>
                <div><strong>URLs (每行一个)</strong>
                  <textarea rows="1" oninput="checkUrlProtocol(this)" onchange="updateUrls('\${k}', this.value)">\${urlsText}</textarea>
                </div>
                <div style="display: flex; align-items: center;">
                  <button class="copy-btn" onclick="confirmDelete('\${k}')"><i class="fas fa-trash-alt"></i> 删除</button>
                </div>
              </div>
            \`;
            container.appendChild(div);
          }
          // 自动调整textarea高度
          document.querySelectorAll('textarea').forEach(ta => {
            ta.style.height = 'auto';
            ta.style.height = ta.scrollHeight + 'px';
          });
        }

        function updateKey(oldK, newK) {
          config.backends[newK] = config.backends[oldK];
          delete config.backends[oldK];
          renderConfig();
        }

        function updateRemark(key, value) {
          if (!config.backends[key]) config.backends[key] = { urls: [], remark: '' };
          config.backends[key].remark = value;
        }

        function updateUrls(key, value) {
          const urls = value.split('\\n').map(s => s.trim()).filter(s => s);
          if (!config.backends[key]) config.backends[key] = { urls: [], remark: '' };
          config.backends[key].urls = urls;
        }

        function add() {
          const n = 'server' + Date.now();
          config.backends[n] = { urls: ['https://'], remark: '' };
          renderConfig();
        }

        function updateBlur(val) {
          document.getElementById('blurVal').innerText = val;
          ui.blurStrength = parseInt(val);
          document.querySelector('.glass-panel').style.backdropFilter = \`saturate(180%) blur(\${val}px)\`;
        }

        function updateTextColor(color) {
          ui.textColor = color;
          if (color === 'light') {
            document.body.classList.add('light-theme');
          } else {
            document.body.classList.remove('light-theme');
          }
        }

        function previewBg() {
          const url = document.getElementById('bgUrl').value;
          ui.backgroundUrl = url;
          document.body.style.backgroundImage = url ? \`url('\${url}')\` : 'none';
          document.body.classList.toggle('has-bg', !!url);
          document.getElementById('preview').style.backgroundImage = url ? \`url('\${url}')\` : 'none';
        }

        async function save() {
          // URL 格式校验
          for (let key in config.backends) {
            for (let url of config.backends[key].urls) {
              if (!isValidUrl(url)) {
                showToast('URL 格式错误：' + url, 'error');
                return;
              }
            }
          }
          saveBtn.classList.add('loading');
          saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 保存中...';
          const defaultKey = document.getElementById('default').value;
          ui.applyToHome = document.getElementById('applyHome').checked;
          const bgUrlInput = document.getElementById('bgUrl').value;
          ui.backgroundUrl = bgUrlInput;
          const payload = {
            backends: config.backends,
            defaultBackend: defaultKey,
            ui: ui,
            version: currentVersion
          };
          try {
            const res = await fetch('/admin', { method: 'POST', body: JSON.stringify(payload) });
            if (res.ok) {
              const data = await res.json();
              if (data.version) currentVersion = data.version;
              saveBtn.classList.remove('loading');
              saveBtn.classList.add('success');
              saveBtn.innerHTML = '<i class="fas fa-check"></i> 已保存';
              showToast('配置已保存', 'success');
              setTimeout(() => {
                saveBtn.classList.remove('success');
                saveBtn.innerHTML = '<i class="fas fa-save"></i> 保存所有配置';
              }, 2000);
            } else {
              const error = await res.json().catch(() => ({ error: '保存失败' }));
              saveBtn.classList.remove('loading');
              saveBtn.innerHTML = '<i class="fas fa-save"></i> 保存所有配置';
              showToast(error.error || '保存失败', 'error');
            }
          } catch (err) {
            saveBtn.classList.remove('loading');
            saveBtn.innerHTML = '<i class="fas fa-save"></i> 保存所有配置';
            showToast('网络错误', 'error');
          }
        }

        renderConfig();
      </script>
    </body>
    </html>
  `;

  const response = new Response(html, {
    headers: { 'Content-Type': 'text/html;charset=UTF-8' }
  });
  if (env.sessionCookie) {
    response.headers.append('Set-Cookie', env.sessionCookie);
  }
  return response;
}

// -------------------- 首页导航页（同步玻璃质感）--------------------
function renderHomePage(backends, cacheVersion, ui) {
  function escapeHtml(unsafe) {
    if (!unsafe) return unsafe;
    return unsafe
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  const links = Object.keys(backends).map(key => {
    const backend = backends[key];
    const total = backend.urls.length;
    const healthyCount = backend.healthy.filter(Boolean).length;
    const statusColor = healthyCount === total ? '#22c55e' : (healthyCount > 0 ? '#eab308' : '#ef4444');
    const statusText = `在线: ${healthyCount}/${total}`;
    const remarkHtml = backend.remark ? `<span style="font-size:0.8em; opacity:0.7;"> (${escapeHtml(backend.remark)})</span>` : '';
    return `<li>
      <a href="/${key}/web/index.html" style="color: var(--primary-400);">🎬 进入 ${key} 后端</a>${remarkHtml}
      <span style="color:${statusColor}; margin-left:10px;">${statusText}</span>
      <span style="opacity:0.6; display:block; font-size:0.85em;">${backend.urls.join('<br>')}</span>
    </li>`;
  }).join('');

  const bgStyle = ui.applyToHome && ui.backgroundUrl ? `
    body {
      background-image: url('${ui.backgroundUrl}');
      background-size: cover;
      background-attachment: fixed;
      color: ${ui.textColor === 'light' ? '#1e293b' : '#f8fafc'};
    }
    .glass-panel {
      background: rgba(255,255,255,0.08);
      backdrop-filter: saturate(180%) blur(${ui.blurStrength}px);
      border-radius: 32px;
      padding: 30px;
      box-shadow: 0 20px 40px -8px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.1) inset;
      border: 1px solid rgba(255,255,255,0.05);
      color: inherit;
    }
  ` : '';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Emby 多后端代理</title>
  <style>
    body {
      font-family: 'Inter', sans-serif;
      max-width: 900px;
      margin: 50px auto;
      padding: 20px;
      background: #0f172a;
      transition: 0.3s;
      color: #f8fafc;
    }
    h1 { font-weight: 600; }
    ul { list-style: none; padding: 0; }
    li {
      margin: 15px 0;
      padding: 20px;
      background: rgba(255,255,255,0.05);
      backdrop-filter: blur(5px);
      border-radius: 24px;
      box-shadow: 0 8px 16px rgba(0,0,0,0.3);
      border: 1px solid rgba(255,255,255,0.1);
    }
    a { text-decoration: none; font-weight: 500; font-size: 1.2rem; }
    a:hover { text-decoration: underline; }
    .note {
      margin-top: 30px;
      color: var(--text-secondary, #94a3b8);
      border-top: 1px solid rgba(255,255,255,0.1);
      padding-top: 20px;
    }
    ${bgStyle}
  </style>
</head>
<body>
  <div class="glass-panel">
    <h1>🚀 Emby 多后端代理</h1>
    <p>请选择要使用的服务器组：</p>
    <ul>${links}</ul>
    <div class="note">
      <p><strong>📱 Infuse / Apple TV 配置：</strong> <code>https://你的域名/server1</code></p>
      <p><strong>🔄 缓存版本：</strong> ${cacheVersion}</p>
      <p><strong>⚙️ 管理面板：</strong> <a href="/admin" style="color: var(--primary-400);">/admin</a>（需密码）</p>
    </div>
  </div>
</body>
</html>`;
}

// -------------------- 代理请求处理函数（保持不变）--------------------
async function handleMediaStream(req, url, targetBase, targetHostname, backendKey) {
  const targetUrl = targetBase + url.pathname + url.search;
  const proxyReq = new Request(targetUrl, {
    method: req.method,
    headers: buildProxyHeaders(req, targetBase, targetHostname),
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
    redirect: 'manual',
  });

  try {
    let res = await fetch(proxyReq);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (location) {
        const newLocation = rewriteLocation(location, req.url, targetBase, backendKey);
        const rh = new Headers(res.headers);
        rh.set('location', newLocation);
        if (myConfig.enableCors) rh.set('Access-Control-Allow-Origin', '*');
        return new Response(null, { status: res.status, statusText: res.statusText, headers: rh });
      }
    }
    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') return res;
    const rh = new Headers(res.headers);
    if (myConfig.enableCors) rh.set('Access-Control-Allow-Origin', '*');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: rh });
  } catch (err) {
    return new Response('Media Stream Error: ' + err.message, { status: 502 });
  }
}

async function handleWithCache(req, url, targetBase, targetHostname, ctx, backendKey) {
  const cache = caches.default;
  const cacheKey = new Request(`https://emby-cache/${myConfig.cacheVersion}/${backendKey}${url.pathname}${url.search}`, { method: req.method });
  let response = await cache.match(cacheKey);
  if (response) {
    const rh = new Headers(response.headers);
    rh.set('CF-Cache-Status', 'HIT');
    if (myConfig.enableCors) rh.set('Access-Control-Allow-Origin', '*');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: rh });
  }

  const targetUrl = targetBase + url.pathname + url.search;
  const proxyReq = new Request(targetUrl, {
    method: req.method,
    headers: buildProxyHeaders(req, targetBase, targetHostname),
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
    redirect: 'manual',
  });

  try {
    response = await fetch(proxyReq);
  } catch (err) {
    return new Response('Static Resource Error: ' + err.message, { status: 502 });
  }

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (location) {
      const newLocation = rewriteLocation(location, req.url, targetBase, backendKey);
      const rh = new Headers(response.headers);
      rh.set('location', newLocation);
      if (myConfig.enableCors) rh.set('Access-Control-Allow-Origin', '*');
      return new Response(null, { status: response.status, statusText: response.statusText, headers: rh });
    }
  }

  if (response.status === 200) {
    const cr = response.clone();
    const crRes = new Response(cr.body, cr);
    crRes.headers.set('Cache-Control', `public, max-age=${myConfig.staticCacheTTL}, immutable`);
    crRes.headers.delete('Vary');
    crRes.headers.delete('Set-Cookie');
    ctx.waitUntil(cache.put(cacheKey, crRes).catch(e => console.error('Cache put error:', e)));
  }

  const rh = new Headers(response.headers);
  rh.set('CF-Cache-Status', 'MISS');
  if (myConfig.enableCors) rh.set('Access-Control-Allow-Origin', '*');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: rh });
}

async function handleApiRequest(req, url, targetBase, targetHostname, backendKey) {
  const targetUrl = targetBase + url.pathname + url.search;
  const proxyReq = new Request(targetUrl, {
    method: req.method,
    headers: buildProxyHeaders(req, targetBase, targetHostname),
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
    redirect: 'manual',
  });

  try {
    let response = await fetch(proxyReq);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
        const newLocation = rewriteLocation(location, req.url, targetBase, backendKey);
        const rh = new Headers(response.headers);
        rh.set('location', newLocation);
        if (myConfig.enableCors) rh.set('Access-Control-Allow-Origin', '*');
        return new Response(null, { status: response.status, statusText: response.statusText, headers: rh });
      }
    }
    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') return response;
    if (response.status === 503 || response.status === 429) {
      const msg = response.status === 503 ? '服务暂时过载，请稍后重试' : '请求过于频繁，请稍后再试';
      return new Response(JSON.stringify({ error: msg, status: response.status }), {
        status: response.status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
    let finalResponse = response;
    if (myConfig.enableHtmlFilter && response.headers.get('content-type')?.includes('text/html')) {
      finalResponse = await filterHtmlResponse(response, myConfig.filterSelectors);
    }
    const rh = new Headers(finalResponse.headers);
    if (myConfig.enableCors) {
      rh.set('Access-Control-Allow-Origin', '*');
      rh.set('Access-Control-Expose-Headers', '*');
    }
    if (myConfig.enableCSPBypass && finalResponse.headers.get('content-type')?.includes('text/html')) {
      rh.delete('content-security-policy');
      rh.delete('content-security-policy-report-only');
    }
    const originalPathParts = new URL(req.url).pathname.split('/').filter(p => p.length > 0);
    if (originalPathParts[0] === backendKey) {
      rh.append('Set-Cookie', `${myConfig.backendCookieName}=${backendKey}; Path=/; Max-Age=86400; SameSite=Lax`);
    }
    return new Response(finalResponse.body, { status: finalResponse.status, statusText: finalResponse.statusText, headers: rh });
  } catch (err) {
    return new Response(JSON.stringify({ error: '代理请求失败: ' + err.message, status: 502 }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

async function filterHtmlResponse(response, selectors) {
  let rewriter = new HTMLRewriter();
  selectors.forEach(s => rewriter.on(s, { element(e) { e.remove(); } }));
  return rewriter.transform(response);
}
