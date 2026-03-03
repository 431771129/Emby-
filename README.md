# Emby 多后端代理 Worker

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange)](https://workers.cloudflare.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

一个部署在 Cloudflare Workers 上的 Emby 聚合代理，支持**多后端负载均衡**、**自动健康检查**、**动态管理面板**、**自定义背景与文字颜色**等高级功能。通过可视化管理界面，您可以轻松添加、编辑、删除后端服务器，无需修改代码。

---

## 🚀 项目简介

本项目旨在解决以下痛点：
- 拥有多个 Emby 公益服，需要统一入口并自动切换可用节点。
- 后端服务器经常变动，希望有动态管理能力。
- 希望代理具备缓存优化、WebSocket 支持、防盗链绕过等高级特性。
- 想要一个美观的首页导航页，并支持个性化外观设置（背景图片、模糊玻璃效果、文字颜色）。

通过 Cloudflare Workers 的全球边缘网络，实现低延迟、高可用的 Emby 代理服务。

---

## ✨ 核心特性

- **多后端负载均衡**：每个后端标识（如 `server1`）可配置多个 URL，随机选择健康的 URL 进行转发。
- **自动健康检查**：通过 Cron 触发器每分钟检测所有 URL 的可用性，并在首页显示在线/离线状态。
- **可视化管理面板**：访问 `/admin` 即可添加、编辑、删除后端服务器，并实时预览外观设置。
- **液态玻璃背景自定义**：支持设置背景图片 URL、模糊强度（0-20px），并可选择应用到首页导航页。
- **文字颜色适配**：根据背景亮度手动选择深色/浅色文字，确保阅读舒适。
- **缓存优化**：静态资源（图片、CSS、JS）永久缓存，支持版本控制一键刷新。
- **WebSocket 兼容**：实时通知、同步播放进度等功能正常。
- **重定向重写**：自动将后端返回的 Location 重写为 Worker 地址，防止跳出代理。
- **UA 伪装 & CSP 绕过**：避免被源站屏蔽，确保页面正常加载。
- **HTML 弹窗过滤**（可选）：可移除页面中的公告、广告等元素。

---

## 📊 请求处理流程图

```mermaid
flowchart TD
    A[客户端请求] --> B{路径是 /admin?}
    B -->|是| C[处理管理面板<br>认证、展示配置、保存]
    B -->|否| D{路径是 /health 或 /ping?}
    D -->|是| E[返回健康状态 OK]
    D -->|否| F[从KV读取后端配置]
    
    F --> G{路径中是否包含<br>有效后端标识?}
    G -->|是| H[提取 backendKey<br>重写路径]
    G -->|否| I{从Cookie中<br>读取 backendKey?}
    I -->|是| H
    I -->|否| J{路径是 /?}
    
    J -->|是| K[渲染首页导航页<br>显示所有后端及健康状态]
    J -->|否| L[使用默认后端]

    H --> M[确定目标后端]
    L --> M
    K --> Z[结束]

    M --> N[负载均衡选择<br>一个健康的URL]
    N --> O[构建代理请求头<br>复用已解析的Host]
    
    O --> P{请求类型判断}
    P -->|媒体流| Q[handleMediaStream<br>转发Range/If-Range等]
    P -->|静态资源| R[handleWithCache<br>缓存键含版本号]
    P -->|API/HTML| S[handleApiRequest<br>处理重定向/WebSocket]

    Q --> T[返回响应]
    R --> T
    S --> T
    T --> Z
