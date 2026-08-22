# dsh 插件发布指南（@lihangcz/dsh-fin-trace）

> 维护者文档：`packages/dsh-fin-trace/` 的版本发布、CI 管线与验证纪律。
> 用户侧安装/升级见[插件 README](../packages/dsh-fin-trace/README.md)。

## 架构

```
GitHub Actions                                    npm
┌──────────────────────────────────────┐
│ 发布: push tag plugin-vX.Y.Z 触发      │
│  1. 守卫① tag ↔ package.json 版本一致  │
│  2. 守卫② 路径相关性（对照上一 plugin tag）│──→ npm publish --provenance
│  3. npm ci → build → publish          │
│ 验证: push main / PR（插件路径变化时）  │
│   root typecheck + 插件 typecheck/    │
│   build / publish dry-run             │
└──────────────────────────────────────┘
```

**核心原则**：**打 `plugin-v*` tag 即发布**；**绝不本地 `npm publish`**——账号开启了 2FA，
本地 classic token 会被 registry 以 403 拒绝（`Two-factor authentication or granular access
token ... required`），唯一发布通道是 CI（`NPM_TOKEN` granular secret + provenance attestation，
发布来源可溯源到对应的 GitHub Actions run）。

**硬拦截**：仓库带 ZCode workspace hook（`.zcode/config.json` →
`.zcode/hooks/block-local-npm-publish.py`），`PreToolUse(Bash)` 在命令匹配 `npm publish`
（非 `--dry-run`）时直接 deny 并提示正确流程——AGENTS.md 的规则是告知，hook 是强制。

- 两条 lane 与服务器部署（`deploy.yml`，`vX.Y.Z` tag）完全独立，互不触发
- tag 必须打在 **main 分支的提交**上，且 `plugin-vX.Y.Z` 与 `packages/dsh-fin-trace/package.json`
  的 `version` 严格一致（守卫①会校验）
- 守卫②防误发：自上一 `plugin-v*` tag 以来必须触及插件相关路径；路径集唯一权威源是
  [`.github/plugin-paths.txt`](../.github/plugin-paths.txt)

## 日常发布

```bash
# 1. 改代码 + 更新 packages/dsh-fin-trace/package.json 的 version
#    （如有需要，同步 README 的版本相关描述）
# 2. 本地验证（见下节），提交并推送 main
git add packages/dsh-fin-trace/ && git commit -m "feat(plugin): ..."
git push origin main                      # 触发 plugin-verify（校验 lane）

# 3. 确认 plugin-verify / CI 绿后打 tag 发布
git tag plugin-vX.Y.Z && git push origin plugin-vX.Y.Z   # 触发 plugin-release

# 4. 确认
gh run watch <run-id> --repo yiwufen/fin-trace --exit-status
npm view @lihangcz/dsh-fin-trace version dist-tags.latest
```

## 版本兼容性锚定

插件锚定宿主 **dsh `0.1.1-rc.2`**：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、
`@deepseek-ai/dsh-jobs` 等 devDependencies 固定 exact 版本并**全部打进 dist**（不进
dependencies），避免 profile 内出现第二份模块实例导致宿主 symbol 解析分裂。宿主升级时需
重新对齐这些版本并真机回归。

## 发布前验证纪律

**link 安装验证通过 ≠ npm 安装可用**（有前车之鉴：0.1.2 时代 link 全通过、npm 安装即崩）。
发布前必须走 npm 安装路径真机验证：

```bash
cd packages/dsh-fin-trace && npm pack
# 在一个 pnpm/npm 安装的 dsh profile 里升级 tarball 后启动真机验证
dsh --profile <name> ...
```

最低验证集：插件激活（headless 冒烟）、三件套工具 + job 注册/取消链路、
web profile 下 `/plugins/@lihangcz/dsh-fin-trace/client.js` 下发 200 且 boot 图含本包行。

## 用户侧更新

```bash
dsh plugin --profile web add @lihangcz/dsh-fin-trace@X.Y.Z   # 或不带版本拉 latest
# 重启 dsh 生效（客户端 bundle 发现按"插件集变更需重启"设计）
```

## 踩坑记录

- **本地 `npm publish` 403**：见核心原则——只能走 `plugin-v*` tag → CI。
- **`exports` 必须导出 `./package.json` 子路径**：宿主 client-modules 扫描用
  `require.resolve('<pkg>/package.json')` 发现客户端半边；定义了 `exports` 却漏掉该子路径会
  被静默跳过（0.3.0 真机验证时发现）。
- **webServer 前缀路由不带尾斜杠**：匹配规则是 `pathname.startsWith(prefix + "/")`，
  注册 `/fintrace/` 只能精确命中自身（同为 0.3.0 真机验证发现）。
- **plugin-paths.txt 与 workflow 内联列表必须同步**：GitHub Actions 不支持从文件读 paths
  过滤器，`plugin-verify.yml` 内联了两份清单，改路径集时三处一起改。
