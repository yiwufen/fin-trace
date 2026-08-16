# fin-trace web

fin-trace 的前端 workspace（Vite + React + TypeScript + Tailwind，移动端 PWA）。

## 开发

- 根目录 `npm run dev` — 构建前端后启动完整服务（:3001）
- `npm run dev -w web` — 仅起 Vite 开发服务器（:5173，`/api` 代理到 :3001）

## 构建

`npm run build -w web` → `web/dist/`，由服务端 `src/static-files.ts` 托管（生产模式）。

## 主要模块

- 聊天界面（ChatView，SSE 流式）
- 账户注册/登录（邀请码）、Onboarding
- 管理后台（`/admin`：用户 / 邀请码 / 分享令牌 / 设置）
- 分享视图（`/s/:token`，可限次）
- 公开 Landing page、PWA（`manifest.webmanifest` + `sw.js`）
