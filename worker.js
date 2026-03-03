// ==================== Emby 多后端代理（极致优化版 + 完整管理面板）====================
/**
 * 功能特性：
 * - 负载均衡：每个后端标识可配置多个 URL，随机选择健康的 URL 转发
 * - 健康检查：定时任务每分钟检测所有 URL 可用性，首页显示在线/离线状态
 * - 管理面板：/admin 路径，支持增删改后端，实时预览液态玻璃背景、文字颜色
 * - 缓存优化：静态资源永久缓存，支持版本控制一键刷新
 * - WebSocket 兼容：实时通知、同步进度正常
 * - 重定向重写：防止跳出代理，强制 HTTPS
 * - UA 伪装、CSP 绕过、HTML 弹窗过滤（可选）
 *
 * 部署要求：
 * 1. 在 Cloudflare Workers 中创建 KV 命名空间，绑定变量名为 EMBY_KV
 * 2. 在 Worker 设置中添加 Cron 触发器（例如 * * * * *）以启用健康检查
 * 3. 修改下方的 ADMIN_PASS 为强密码
 */

const myConfig = {
  defaultBackends: {
    server1: ['https://emby1.example.com:443'],
    server2: ['https://emby2.example.org:443'],
    server3: ['https://emby3.example.net:8096'],
  },
  defaultBackend: 'server1',
  backendCookieName: 'backend',
  cacheVersion: 'v1',
  enableCors: true,
  enableCache: true,
  enableUAMasking: true,
  enableCSPBypass: true,
  enableHtmlFilter: false,
  filterSelectors: ['.notice', '#popup', '.advertisement'],
  staticCacheTTL: 31536000,
  // 防盗链选项：若后端检查 Referer/Origin，设为 true 可避免 403
  rewriteReferer: false,
  rewriteOrigin: false,
};

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'your-strong-password'; // 务必修改！

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
            backends[key] = { urls: value, healthy: new Array(value.length).fill(true) };
          } else if (typeof value === 'string') {
            backends[key] = { urls: [value], healthy: [true] };
          } else if (value && Array.isArray(value.urls)) {
            backends[key] = { urls: value.urls, healthy: value.healthy || new Array(value.urls.length).fill(true) };
          }
        }
      }
    } catch (e) {}
    if (Object.keys(backends).length === 0) {
      for (const [key, urls] of Object.entries(myConfig.defaultBackends)) {
        backends[key] = { urls, healthy: new Array(urls.length).fill(true) };
      }
    }
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

async function updateBackends(env, newBackends) {
  const storeData = {};
  for (const [key, value] of Object.entries(newBackends)) {
    storeData[key] = value.urls || value;
  }
  await env.EMBY_KV.put('backends', JSON.stringify(storeData));
  cachedBackends = newBackends;
}

async function updateHealth(env, healthData) {
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

// ---------- 健康检查定时任务（并行版）----------
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

// ---------- 优化：使用字符串方法判断请求类型 ----------
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

// ---------- 构建代理请求头（可选重写 Referer/Origin）----------
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

    // 解析后端标识
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

    // 首页导航页
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

// -------------------- 管理面板（完整版）--------------------
async function handleAdmin(req, env) {
  const auth = req.headers.get('Authorization');
  if (!auth) {
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="Admin"' },
    });
  }
  const [user, pass] = atob(auth.split(' ')[1]).split(':');
  if (user !== ADMIN_USER || pass !== ADMIN_PASS) {
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="Admin"' },
    });
  }

  if (req.method === 'POST') {
    try {
      const data = await req.json();
      if (data.backends) {
        const newBackends = {};
        for (const [key, urls] of Object.entries(data.backends)) {
          const urlList = Array.isArray(urls) ? urls : urls.split('\n').map(s => s.trim()).filter(Boolean);
          newBackends[key] = { urls: urlList, healthy: new Array(urlList.length).fill(true) };
        }
        await updateBackends(env, newBackends);
        if (data.defaultBackend) {
          await env.EMBY_KV.put('defaultBackend', data.defaultBackend);
        }
      }
      if (data.ui) {
        await updateUiConfig(env, data.ui);
      }
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
  }

  const backendsObj = await env.EMBY_KV.get('backends', 'json') || myConfig.defaultBackends;
  const defaultBackend = await env.EMBY_KV.get('defaultBackend') || myConfig.defaultBackend;
  const ui = await getUiConfig(env);

  return new Response(
    `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Emby 管理面板 - 外观设置</title>
      <style>
        body {
          font-family: sans-serif;
          max-width: 1000px;
          margin: 0 auto;
          padding: 20px;
          background: #f5f5f5;
          transition: background-image 0.3s, color 0.3s;
          background-size: cover;
          background-position: center;
          background-attachment: fixed;
          color: ${ui.textColor === 'light' ? '#fff' : '#333'};
        }
        body.has-bg {
          background-image: url('${ui.backgroundUrl}');
        }
        .glass-panel {
          background: rgba(255, 255, 255, 0.25);
          backdrop-filter: blur(${ui.blurStrength}px);
          -webkit-backdrop-filter: blur(${ui.blurStrength}px);
          border-radius: 20px;
          padding: 30px;
          box-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.37);
          border: 1px solid rgba(255, 255, 255, 0.18);
          color: ${ui.textColor === 'light' ? '#fff' : '#333'};
        }
        input, button, textarea, select {
          padding: 10px;
          margin: 5px 0;
          width: 100%;
          box-sizing: border-box;
          border-radius: 8px;
          border: 1px solid rgba(255,255,255,0.3);
          background: rgba(255,255,255,0.8);
          color: #333;
        }
        .item {
          border: 1px solid rgba(255,255,255,0.3);
          padding: 15px;
          margin-bottom: 15px;
          border-radius: 12px;
          background: rgba(255,255,255,0.2);
          backdrop-filter: blur(5px);
        }
        .section {
          margin-top: 30px;
          padding: 20px;
          background: rgba(255,255,255,0.15);
          border-radius: 16px;
        }
        h2, h3 { color: ${ui.textColor === 'light' ? '#fff' : '#222'}; }
        .preview-box {
          width: 100%;
          height: 100px;
          background-size: cover;
          background-position: center;
          border-radius: 12px;
          margin-top: 10px;
          border: 2px solid white;
        }
        .note { color: ${ui.textColor === 'light' ? '#ddd' : '#444'}; margin-top: 10px; }
        .flex-row { display: flex; gap: 10px; align-items: center; }
        .flex-row input { flex: 1; }
        .radio-group { display: flex; gap: 20px; align-items: center; margin: 10px 0; }
        .radio-group label { display: flex; align-items: center; gap: 5px; }
      </style>
    </head>
    <body class="${ui.backgroundUrl ? 'has-bg' : ''}" style="background-image: url('${ui.backgroundUrl}'); color: ${ui.textColor === 'light' ? '#fff' : '#333'};">
      <div class="glass-panel">
        <h2>🛠️ Emby 管理面板（负载均衡 + 外观）</h2>

        <!-- 后端配置区域 -->
        <h3>📡 后端服务器配置</h3>
        <div id="list"></div>
        <button onclick="add()">➕ 添加新服务器组</button><br><br>
        <label>默认启动后端 (Key):</label>
        <input type="text" id="default" value="${defaultBackend}">

        <!-- 外观设置区域 -->
        <div class="section">
          <h3>🎨 外观设置（液态玻璃效果 + 文字颜色）</h3>
          <div class="flex-row">
            <input type="text" id="bgUrl" placeholder="背景图片 URL" value="${ui.backgroundUrl || ''}">
            <button onclick="previewBg()">预览</button>
          </div>
          <div>
            <label>模糊强度: <span id="blurVal">${ui.blurStrength}</span>px</label>
            <input type="range" id="blurRange" min="0" max="20" value="${ui.blurStrength}" oninput="updateBlur(this.value)">
          </div>
          <div class="radio-group">
            <label>文字颜色：</label>
            <label><input type="radio" name="textColor" value="dark" ${ui.textColor === 'dark' ? 'checked' : ''} onchange="updateTextColor('dark')"> 深色</label>
            <label><input type="radio" name="textColor" value="light" ${ui.textColor === 'light' ? 'checked' : ''} onchange="updateTextColor('light')"> 浅色</label>
          </div>
          <div class="flex-row">
            <label>
              <input type="checkbox" id="applyHome" ${ui.applyToHome ? 'checked' : ''}> 应用到首页导航页
            </label>
          </div>
          <div class="preview-box" id="preview" style="background-image: url('${ui.backgroundUrl}');"></div>
          <div class="note">提示：背景 URL 需支持 HTTPS 且允许跨域。修改后点击下方保存按钮生效。</div>
        </div>

        <button class="save" onclick="save()">💾 保存所有配置</button>
      </div>

      <script>
        let config = { backends: ${JSON.stringify(backendsObj)} };
        let ui = {
          backgroundUrl: '${ui.backgroundUrl || ''}',
          blurStrength: ${ui.blurStrength},
          applyToHome: ${ui.applyToHome},
          textColor: '${ui.textColor}'
        };

        function render() {
          const list = document.getElementById('list');
          list.innerHTML = '';
          for (let k in config.backends) {
            const urls = Array.isArray(config.backends[k]) ? config.backends[k].join('\\n') : config.backends[k];
            list.innerHTML += \`<div class="item">
              <div><strong>Key:</strong> <input type="text" value="\${k}" onchange="updateKey('\${k}', this.value)"></div>
              <div><strong>URLs (每行一个):</strong></div>
              <textarea rows="3" onchange="updateUrls('\${k}', this.value)">\${urls}</textarea>
              <button class="del" onclick="delete config.backends['\${k}'];render()">删除此组</button>
            </div>\`;
          }
        }
        function updateKey(oldK, newK) {
          config.backends[newK] = config.backends[oldK];
          delete config.backends[oldK];
          render();
        }
        function updateUrls(key, value) {
          config.backends[key] = value.split('\\n').map(s => s.trim()).filter(s => s);
        }
        function add() {
          const n = 'server' + Date.now();
          config.backends[n] = ['https://'];
          render();
        }
        function updateBlur(val) {
          document.getElementById('blurVal').innerText = val;
          ui.blurStrength = parseInt(val);
          document.querySelector('.glass-panel').style.backdropFilter = \`blur(\${val}px)\`;
          document.querySelector('.glass-panel').style.webkitBackdropFilter = \`blur(\${val}px)\`;
        }
        function updateTextColor(color) {
          ui.textColor = color;
          const textColor = color === 'light' ? '#fff' : '#333';
          document.body.style.color = textColor;
          document.querySelector('.glass-panel').style.color = textColor;
          document.querySelectorAll('h2, h3').forEach(el => el.style.color = color === 'light' ? '#fff' : '#222');
          document.querySelectorAll('.note').forEach(el => el.style.color = color === 'light' ? '#ddd' : '#444');
        }
        function previewBg() {
          const url = document.getElementById('bgUrl').value;
          ui.backgroundUrl = url;
          document.body.style.backgroundImage = url ? \`url('\${url}')\` : 'none';
          document.body.classList.toggle('has-bg', !!url);
          document.getElementById('preview').style.backgroundImage = url ? \`url('\${url}')\` : 'none';
        }
        async function save() {
          const defaultKey = document.getElementById('default').value;
          ui.applyToHome = document.getElementById('applyHome').checked;
          const payload = {
            backends: config.backends,
            defaultBackend: defaultKey,
            ui: ui
          };
          const res = await fetch('/admin', { method: 'POST', body: JSON.stringify(payload) });
          if (res.ok) alert('配置已保存');
          else alert('保存失败');
        }
        render();
      </script>
    </body>
    </html>
    `,
    { headers: { 'Content-Type': 'text/html;charset=UTF-8' } }
  );
}

// -------------------- 首页导航页 --------------------
function renderHomePage(backends, cacheVersion, ui) {
  const links = Object.keys(backends).map(key => {
    const backend = backends[key];
    const total = backend.urls.length;
    const healthyCount = backend.healthy.filter(Boolean).length;
    const statusColor = healthyCount === total ? 'green' : (healthyCount > 0 ? 'orange' : 'red');
    const statusText = `在线: ${healthyCount}/${total}`;
    return `<li>
      <a href="/${key}/web/index.html" style="color: ${ui.textColor === 'light' ? '#80c0ff' : '#007bff'};">🎬 进入 ${key} 后端</a>
      <span style="color:${statusColor}; margin-left:10px;">${statusText}</span>
      <span style="color:${ui.textColor === 'light' ? '#ccc' : '#666'}; display:block; font-size:0.9em;">${backend.urls.join('<br>')}</span>
    </li>`;
  }).join('');

  const bgStyle = ui.applyToHome && ui.backgroundUrl ? `
    body {
      background-image: url('${ui.backgroundUrl}');
      background-size: cover;
      background-attachment: fixed;
      color: ${ui.textColor === 'light' ? '#fff' : '#333'};
    }
    .glass-panel {
      background: rgba(255,255,255,0.2);
      backdrop-filter: blur(${ui.blurStrength}px);
      -webkit-backdrop-filter: blur(${ui.blurStrength}px);
      border-radius: 20px;
      padding: 30px;
      box-shadow: 0 8px 32px 0 rgba(31,38,135,0.37);
      border: 1px solid rgba(255,255,255,0.18);
      color: ${ui.textColor === 'light' ? '#fff' : '#333'};
    }
    h1, p { color: ${ui.textColor === 'light' ? '#fff' : '#333'}; }
    .note { color: ${ui.textColor === 'light' ? '#ddd' : '#666'}; }
  ` : '';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Emby 多后端代理</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 900px; margin: 50px auto; padding: 20px; background: #f5f5f5; transition: background 0.3s, color 0.3s; }
    h1 { color: #333; }
    ul { list-style: none; padding: 0; }
    li { margin: 15px 0; padding: 15px; background: white; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
    a { text-decoration: none; color: #007bff; font-weight: bold; font-size: 1.2em; }
    a:hover { text-decoration: underline; }
    .note { margin-top: 30px; color: #666; font-size: 0.9em; border-top: 1px solid #ddd; padding-top: 20px; }
    ${bgStyle}
  </style>
</head>
<body>
  <div class="glass-panel">
    <h1>🚀 Emby 多后端代理（负载均衡）</h1>
    <p>请选择要使用的服务器组：</p>
    <ul>${links}</ul>
    <div class="note">
      <p><strong>📱 Infuse / Apple TV 配置：</strong> 直接输入 <code>https://你的域名/server1</code></p>
      <p><strong>🔄 缓存版本：</strong> ${cacheVersion}</p>
      <p><strong>⚙️ 管理面板：</strong> <a href="/admin" style="color: ${ui.textColor === 'light' ? '#80c0ff' : '#007bff'};">/admin</a>（需密码）</p>
    </div>
  </div>
</body>
</html>`;
}

// -------------------- 处理函数 --------------------
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