# 本地运行与 UI 视觉验收

Use when 需要把 fin-trace 页面真实跑起来、用浏览器截图做 UX/视觉验收（聊天 UI、Markdown 渲染、分享页等）时。

## 构建与启动

```bash
source ~/.nvm/nvm.sh        # 非交互 shell 不会自动 source；ZCode Bash 工具必须先执行
npm install                 # 首次或依赖变更后；esbuild 的 postinstall 可能被 npm install-scripts 拦，
                            # 报 "tsc: not found"/vite 二进制缺失时先 `npm rebuild esbuild`
npm run typecheck           # tsc --noEmit
npm run build               # 产出 dist/ + web/dist/
PORT=3101 node dist/index.js   # 起服务；PORT 环境变量可覆盖端口（默认 3001）
```

- 首次启动自动生成 `config.json`（复制自 config.example.json，api_key 为空）与 `data/` 下的 stores；空 api_key 不影响静态页与分享页渲染，只有真实对话需要 LLM。
- 启动后 `curl -s -o /dev/null -w "%{http_code}" http://localhost:<port>/` 应为 200。

## 坑：3001 端口被占

多会话并行在同一台机器工作时，3001 常被**其他 worktree 的 fin-trace 实例**占用（`EADDRINUSE` 崩溃退出）。处理：

- `ss -ltnp | grep 3001` 找到占用进程；`ls -l /proc/<pid>/cwd` 确认属主 worktree。
- **不要杀别人的进程**——那可能是并行流水线节点的服务。给自己的实例换端口：`PORT=3101 node dist/index.js`。
- 注意：换端口实例的 `data/` 是相对 cwd 解析的，在自己 worktree 根下起服务即可读到自己的 data。

## 不依赖 LLM 做 Markdown/分享页验收

聊天回复渲染 Markdown 需要真实 LLM 调用；可用**种子数据**绕过：

1. 手写 `data/sessions/<uuid>.json`（Session 结构见 `src/session-store.ts`）：messages 里放一条 `role:"assistant"`、content 为 markdown 字符串的消息（可含 fenced code block、长行、行内 code、列表等，按验收点构造）。
2. 手写 `data/share-tokens.json`（结构见 `src/share-store.ts`）：造一个 token，`session_ids` 指向上面的会话。
3. 浏览器打开 `/s/<token>` —— 分享页与聊天页复用同一 `Markdown` 组件（`web/src/components/Markdown.tsx`，经 StreamingText），一处验收覆盖两条链路。

## 验收判据与手法（Markdown 渲染类）

- **代码块主题**：截图亲眼看是否浅色系；用 `browser_evaluate` 取 `getComputedStyle(pre)` 的 `backgroundColor`/`color` 做客观佐证（Tailwind v4 的 oklch 值，浅色即高 L 值）。
- **横向滚动**：`pre.overflowX === "auto"` 且 `scrollWidth > clientWidth`，再设 `pre.scrollLeft` 验证可滚动。
- **控制台报错**：`/api/*` 的 401 在未登录/分享页是预期探测行为，非缺陷级证据；真实报错要看渲染空白、资源 404 等。
- 浏览器缺失时先 `npx @playwright/mcp install-browser chrome-for-testing`。
