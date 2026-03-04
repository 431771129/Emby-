# Emby 多后端代理 (Cloudflare Worker)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/yourusername/emby-proxy-worker)

一个功能强大的 Cloudflare Worker，为 Emby 媒体服务器提供负载均衡、健康检查、缓存优化和安全增强的代理服务。支持多后端自动故障转移、实时健康监控、美观的管理面板以及丰富的视觉定制。

---

## ✨ 功能特性

- **负载均衡**：每个后端组可配置多个 URL，自动选择健康的节点转发请求。
- **健康检查**：定时（每分钟）检测所有后端 URL 可用性，首页实时显示在线/离线状态。
- **最快节点选择**：记录每次健康检查的响应延迟，优先转发到延迟最低的健康节点。
- **管理面板**：美观的 `/admin` 面板，支持增删改后端、实时预览玻璃态背景、文字颜色等。
- **缓存优化**：静态资源永久缓存，支持版本控制一键刷新。
- **WebSocket 兼容**：实时通知、同步进度正常。
- **重定向重写**：防止跳出代理，强制 HTTPS。
- **UA 伪装 / CSP 绕过**：可选的 UA 伪装和 CSP 头移除。
- **安全性增强**：
  - 密码从环境变量读取（不硬编码）。
  - 防爆破机制（5次失败封禁10分钟）。
  - HttpOnly 会话 Cookie。
- **交互优化**：
  - Toast 提示、URL 格式实时校验、删除确认。
  - 智能 URL 解析（自动提取协议+域名）。
- **性能优化**：
  - 健康检查增量写入 KV（仅状态变化时更新）。
  - 配置版本号防并发覆盖。
  - KV 缓存预热（stale-while-revalidate），多边缘节点秒级响应。
- **功能扩展**：
  - 导入/导出配置（JSON 备份）。
  - 批量删除、导出选中项。
  - 敏感信息脱敏（隐藏 URL 中的 `api_key`）。
- **视觉升级**：
  - 毛玻璃 2.0（`saturate(180%)` + 多层阴影 + 内边框）。
  - 呼吸灯动画、卡片悬停光晕、按钮拟物化按压效果。
  - 响应式网格布局，手机端自动折叠为属性列表。
  - 空状态插画。
  - 多主题支持（通过修改 CSS 变量快速切换）。
- **告警通知**：当某后端组所有节点离线时，通过 WebHook 发送告警（支持钉钉/Telegram）。
- **播放器兼容**：针对 Lenna 等播放器自动处理尾部斜杠，确保正常解析。

---

## 📦 部署步骤

### 1. 准备工作
- 拥有一个 [Cloudflare](https://dash.cloudflare.com/) 账号（免费版即可）。
- 域名托管在 Cloudflare（可选，也可使用 `workers.dev` 子域名）。

### 2. 创建 KV 命名空间
1. 登录 Cloudflare 控制台，进入 **Workers & Pages** → **KV**。
2. 点击 **创建命名空间**，输入名称 `EMBY_KV`（必须与代码中绑定的变量名一致）。
3. 创建完成后，记录命名空间 ID（后续绑定 Worker 时需要选择）。

### 3. 部署 Worker
#### 方法一：一键部署按钮（推荐）
[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/yourusername/emby-proxy-worker)

点击上方按钮，授权 GitHub 后即可自动创建 Worker 并绑定 KV。

#### 方法二：手动创建
1. 在 **Workers & Pages** 页面，点击 **创建应用程序** → **创建 Worker**。
2. 为 Worker 命名（例如 `emby-proxy`），点击 **部署**。
3. 将 [本仓库的 `index.js`](index.js) 代码复制粘贴到编辑器中，覆盖默认内容。
4. 在 **设置** → **KV 命名空间绑定** 中，点击 **添加绑定**：
   - 变量名称：`EMBY_KV`
   - KV 命名空间：选择之前创建的 `EMBY_KV`
5. 在 **设置** → **环境变量** 中，添加以下变量：
   - `ADMIN_PASS`：设置一个强密码（管理面板登录使用）。
   - （可选）`ADMIN_PATH`：自定义管理面板路径，如 `/manage`，默认 `/admin`。
   - （可选）`ALERT_WEBHOOK_URL`：钉钉或 Telegram 机器人的 Webhook 地址。
   - （可选）`ALERT_CHAT_ID`：Telegram 聊天 ID（如使用 Telegram）。
6. 在 **设置** → **触发器** 中，添加 Cron 触发器：`* * * * *`（每分钟执行健康检查）。
7. 点击 **保存并部署**。

---

## 🔧 配置说明

### 环境变量
| 变量名 | 必填 | 默认值 | 说明 |
|--------|------|--------|------|
| `ADMIN_PASS` | 是 | 无 | 管理面板登录密码（用户名固定为 `admin`） |
| `ADMIN_PATH` | 否 | `/admin` | 自定义管理面板访问路径 |
| `ALERT_WEBHOOK_URL` | 否 | 无 | 告警 Webhook 地址（支持钉钉、Telegram） |
| `ALERT_CHAT_ID` | 否 | 无 | Telegram 聊天 ID（使用 Telegram 时必填） |

### 管理面板使用
1. 访问 `https://你的worker域名/自定义路径`（默认 `/admin`）。
2. 输入用户名 `admin` 和设置的 `ADMIN_PASS` 登录。
3. 在面板中：
   - **服务器健康状态**：查看各后端组在线情况，点击 📋 复制代理地址或原始 URL。
   - **后端服务器配置**：添加/删除/修改后端组，可设置备注标签，URL 每行一个。
   - **外观设置**：自定义背景图、模糊强度、文字颜色，实时预览效果。
4. 点击 **保存所有配置** 使更改生效。

---

## 🚀 使用示例

### 添加后端
假设你有两个 Emby 服务器：
- 主服务器：`https://emby1.example.com`
- 备用服务器：`https://emby2.example.org`

在管理面板的“后端服务器配置”中，添加一个 Key 为 `server1` 的组，URL 输入：
