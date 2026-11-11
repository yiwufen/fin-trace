---
name: fin-trace-web-verify
description: Use when需要真实跑起 fin-trace web 前端做视觉/交互验收（构建、起服务、登录、进入聊天页、浏览器截图），或验收聊天 composer 相关 UI 变更。
---

# fin-trace web 页面实测验收

## 构建 / 启动
- Node 走 nvm：非交互 shell 先 `source ~/.nvm/nvm.sh`。
- `npm install` 可能拦 esbuild postinstall（install-scripts 审批），通常不影响 vite 构建；装完直接跑。
- `npm run typecheck`（tsc --noEmit）→ `npm run build`（产出 dist/ + web/dist/）。新装依赖后 tsc 才可用（.bin/tsc 由 install 生成）。
- 起服务：`node dist/index.js`，监听 **:3001**，`curl localhost:3001/` 返回 200 即可达。日志含 Web UI endpoint 行。

## 进入聊天页
- 首页 `/` 是落地页，未登录访问 /app 会被 /api/account/me 401 重定向。
- 注册：`/register` 填邮箱 + 密码（≥8 位）→ 提交后进 `/onboarding`（PWA 引导）→ 点「跳过引导」到 `/app`。无需邀请码（本地新库）。
- 登录态在浏览器里持久，之后直接访问 `/app`。
- console 里未登录阶段的 401（/api/account/me、/api/sessions）和 404（/api/public/demo）属预期噪音，不算回归；看页面报错需结合登录后状态判断。

## Playwright 浏览器
- 首次用需 `npx playwright install chromium`（约 126MB，装到 ~/.cache/ms-playwright）。

## 验收判据（composer 类 UI）
- 桌面端 composer 目标形态：与消息列同轴限宽居中（均为 `max-w-3xl mx-auto`，ChatInput.tsx 外层容器 + ChatView.tsx 消息列对照）、圆角 rounded-2xl + border + shadow-sm、底部不贴窗口底缘（外层有 pb 计算）。
- 移动端（viewport 390x844）：drawer 顶栏（汉堡菜单 + 用户名）正常、composer 仍贴底但保留 `env(safe-area-inset-bottom)` 留白、两侧留白与消息列一致。
- 功能态：空文本时「发送」disabled（灰）；输入后变蓝可点；输入框 focus 有 ring；处理中 textarea disabled 且 placeholder 变「思考中...」、按钮换「停止/取消重连」。
- 验证发送按钮可用态不必真发送消息——真发送会触发 agent 探索（消耗配额且需 LLM 配置），填文本看按钮变色 + 截图即可。
