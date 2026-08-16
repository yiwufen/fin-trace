# AGENTS.md

This file provides guidance to AI coding agents (e.g. ZCode Agent) when working with code in this repository.

## Project Status

Deployed to production (CI/CD via GitHub Actions) and under active development. The product has shipped beyond the original agent core: web frontend with account system, admin console, share tokens, mobile PWA, and a golden-set eval framework. `design-docs/` holds the agent-core specification — note parts of it predate the v3 refactor and are pending rewrite (see Design Doc Index below). All design documents are written in Chinese with English technical terms.

## What This Is

fin-trace (Graph Explorer) is a multi-hop relationship reasoning agent for financial knowledge graphs, packaged as a self-hosted web product. One process (:3001) serves four interfaces:

- **Web app** — Vite + React frontend (`web/`): chat UI, account registration with invite codes, admin console (`/admin`), share tokens (`/s/:token`), public landing page, mobile PWA; served from `web/dist/` plus `/api/*` HTTP endpoints (auth, sessions, admin, share, settings)
- **A2A Agent** — `graph_explore` skill; Agent Card at `/.well-known/agent-card.json`, JSON-RPC at `/a2a`; called by host agents (e.g. OpenClaw)
- **MCP server** — `/mcp`, exposing `graph_explore_start/status/cancel` (async submit + poll)
- **Internal agent** — the Agent Loop (EXPLORING → FINALIZE) talks to the knowledge-graph MCP service

## Architecture at a Glance

```
Browser (web app)          Host Agent (OpenClaw)      MCP client
    │ /api/* + static          │ /a2a (JSON-RPC)          │ /mcp
    ▼                          ▼                          ▼
┌──────────────────────── fin-trace (:3001) ───────────────────────┐
│  HTTP server (src/index.ts, src/api.ts, src/static-files.ts)     │
│  Auth / accounts / settings / share tokens                       │
│                                                                  │
│  Chat loop (src/chat/) — multi-turn conversation                 │
│    └→ Agent Loop (src/agent/): EXPLORING → FINALIZE              │
│              ↕ MCP (internal)                                    │
│         knowledge-graph MCP service (external)                   │
└──────────────────────────────────────────────────────────────────┘
    └→ Returns: findings + event_threads + meta (A2A Artifacts / API / SSE)
```

Core constraint: **"Library over framework"** — no agent framework, the loop is entirely in own code.

## Build & Test Commands

```bash
npm run build       # tsc && build web workspace → dist/ + web/dist/
npm run dev         # build web then tsx src/index.ts (development run)
npm start           # node dist/index.js (production run)
npm run typecheck   # tsc --noEmit (type check only)
```

No unit test runner is configured. Verification tooling:

- `npm run typecheck`
- `tests/e2e/` — smoke scenarios with captured outputs (`npx tsx tests/e2e/run-scenarios.ts`)
- `eval/` — golden-set evaluation: `npx tsx eval/cli.ts run | judge | report` (specs in `docs/superpowers/specs/`; `eval/runs/`, `eval/judgments/` artifacts are gitignored)

> **开发环境注意事项**: Node.js 通过 nvm 管理（当前 v20.20.2），位于 `~/.nvm/versions/node/`。ZCode Agent 的 Bash 工具使用非交互式 shell，不会自动 source `.bashrc`，因此执行 node/npm 命令前需先 `source ~/.nvm/nvm.sh`。

## Project Structure

- `src/` — TypeScript server: agent core (`src/agent/`), chat loop (`src/chat/`), A2A (`src/a2a/`), MCP server (`src/mcp-server.ts`), HTTP API (`src/api.ts`), auth & accounts (`src/auth/`, `src/account-handler.ts`, `src/user-store.ts`), settings/share/session stores, LLM clients (`src/llm/`)
- `design-docs/` — agent-core specification; `README.md` is the master index
- `web/` — npm workspace for the frontend (Vite + React + Tailwind, PWA)
- `eval/` — golden-set evaluation framework
- `tests/e2e/` — e2e smoke scenarios
- `skills/` — cross-platform skill definitions (e.g. `fin-trace.md`)
- `docs/` — deployment guide (`deploy.md`), ops runbook, historical specs/plans (`docs/superpowers/`)
- `.github/workflows/` — CI/CD pipeline

## Deployment Architecture

```
GitHub Actions                       百度服务器 182.61.1.77
push tag vX.Y.Z ─→ typecheck         git pull（仅同步配置）
                    buildx 构建镜像    写 .env IMAGE_TAG
                    push GHCR ──SSH──→ compose pull + up -d
                                      health check (curl localhost:3001/)
push main / PR ─→ CI 仅验证（typecheck + docker build）

镜像: ghcr.io/yiwufen/fin-trace:vX.Y.Z（+ latest，package public）
环境: deployer@182.61.1.77, ~/fin-trace/（配置载体，不构建）, 3.8 GB 内存
```

### 部署关键约束

- **build once, deploy many** — 镜像只在 GitHub Actions 构建，服务器不构建；服务器 `git pull` 仅同步 compose/脚本
- **tag 打在 main 提交上** — 部署时服务器 `git pull origin main`，tag 指向非 main 提交会导致 compose 与镜像不一致
- **服务器无法直连外网** — dockerd 走代理 `127.0.0.1:7890` 拉取 ghcr.io（systemd drop-in，一次性配置）；重启 docker 会中断所有容器
- **GHCR package 为 public** — 服务器匿名拉取，无服务器侧凭据；镜像不含密钥（config/data 均为 volume 挂载，`.dockerignore` 排除）
- **回滚 = 重部署旧 tag** — `echo "IMAGE_TAG=<旧版>" > .env && docker compose pull && docker compose up -d`
- **旧 Registry 数据目录不可 `--delete` 同步** — `registry-data/`、`registry-auth/` 需排除（本地 registry 已于 2026-08 下线，目录待清理）
- **Caddy 修改后必须 `docker restart`** — `caddy reload` 有 bind mount 缓存（Caddy 属外部 knowledge-net 部署，不在本仓库）
- **CI 用独立 SSH 密钥对** — `ssh-keygen -t ed25519 -C "fin-trace-ci"` 生成，公钥写入 `authorized_keys`，私钥存 GitHub Secrets
- 完整部署文档：`docs/deploy.md`
- `config.json` — runtime configuration (gitignored; see `config.example.json`，首次启动会自动生成)
- `data/` — runtime data: sessions, `settings.json`（含 admin_token/invite_codes）, `users.json`, share tokens (gitignored)

## Design Document Index

Master index: `design-docs/README.md` — refer there for the full list, the v2→v3 terminology baseline, and the archive. The nine core specs were realigned to the v3 code (五意图架构) in 2026-08 and each carries a status header (`已对齐: <SHA>`).

## Project Configuration

`config.json` at project root (gitignored) stores runtime configuration, decoupled from agent logic. Full field set — see `config.example.json`:

```json
{
  "llm": {
    "provider": "openai",
    "base_url": "https://api.deepseek.com",
    "model": "deepseek-v4-pro",
    "max_tokens": 38400,
    "api_key": ""
  },
  "mcp": {
    "servers": {
      "knowledge-graph": {
        "url": "https://182-61-1-77.nip.io/mcp",
        "transport": "streamable-http",
        "api_key": ""
      }
    }
  },
  "a2a": { "inbound_token": "" }
}
```

- `llm.*` is required (unguarded reads at startup). `llm.max_tokens` doubles as the exploration token budget (fallback chain: input → `llm.max_tokens` → 128k).
- `a2a.inbound_token` is optional (A2A auth).

A second, UI-managed layer can override `config.json`: `data/settings.json` (edited via the admin console `/api/settings`) overrides LLM/MCP API keys and holds `web.admin_token` (auto-generated on first boot) and `web.invite_codes`.

## Key Architectural Decisions

- **Config-decoupled**: MCP endpoint and LLM settings live in `config.json`, not in agent code. The A2A Agent Card URL is derived from the server port.
- **Single-hop tool primitives**: Each tool fetches one *semantic* hop per call (the KG is an entity-event bipartite graph: one relationship = 2 edges, so the mapping layer sends `hops: 2` for trace — see `design-docs/tools.md`); multi-hop behavior emerges from the Agent Loop composing calls sequentially
- **Phase isolation**: EXPLORING works on compressed/summary views; FINALIZE gets the full raw event archive injected
- **Evidence traceability**: Every finding requires KU ID–backed evidence; threads validate ku_id existence against the event archive
- **Budget-aware at every level**: Token budget is config-driven (`llm.max_tokens`, 128k fallback) with multi-level compression escalation; step budget (20 EXPLORING + 2 FINALIZE) checked each iteration
- **Graceful degradation**: MCP error handling (retry → degrade → skip), LLM format auto-repair, diminishing-returns detection (consecutive identical decisions forces strategy switch)
- **Async external interfaces**: Long-running Agent Loop (3-20min) is exposed as A2A Tasks and as async MCP tools (`graph_explore_start/status/cancel`) — never a call that blocks for minutes. Internal KG communication uses MCP.

## Finding Categories

Four types: `pattern_violation`, `concentration`, `chain`, `absence`. Extraction is triggered by step thresholds, strategy switches, unexpected results, or sufficient signal. Dedup uses entity overlap + category match + keyword similarity. v3 routes findings into `entity_flags` / `cluster_flags` / `key_insights` (see `src/agent/state.ts`).

## Architecture Constraints（架构约束）

These constraints are binding — treat them as hard limits when editing code.

### Implementation Fidelity（实现保真）
- `design-docs/` is the documentation of record for the agent core (kept aligned to `src/`, each doc carries a 状态头 with an alignment SHA). Implement as written, don't improvise architecture.
- **PRs that change agent-core behavior must update the corresponding design doc in the same PR and refresh its alignment SHA (状态头"已对齐").**
- The 5 KG tools (lookup, trace, timeline, expand, scan) are fixed — do not add, remove, or rename tools.
- One semantic hop per tool call is enforced at the mapping layer; depth control is the Agent Loop's job, not a tool parameter to change.

### Config Decoupling（配置解耦）
- MCP endpoint must be read from `config.json` at startup. Never hardcode URLs into source code.
- When adding new external service dependencies, add their URLs to `config.json` as well.

### Framework Constraint（框架约束）
- Do not introduce agent frameworks (LangChain, AutoGen, CrewAI, etc.). The Agent Loop is custom code.
- Use lightweight libraries for MCP client, not orchestration layers.
- "Library over framework" — prefer composing small, focused modules over adopting a framework's abstractions.

### Evidence Traceability（证据可追溯）
- Every Finding must have `evidence: string[]` (KU IDs). No evidence = not a valid finding.
- Event Threads must validate `ku_id` against the event archive (`raw_event_archive`) before inclusion.
- `reliability_note` must be set when any degradation occurred during the session.

## Language & Style Conventions（语言与风格约定）

### Language（语言）
- Documents, design notes, and code comments: Chinese (with English technical terms where natural).
- Code identifiers (variables, functions, types, files): English.
- Git commit messages: English.

### Style（风格）
- Match the writing style of existing `design-docs/` — concise, structured with tables and code blocks, no filler prose.
- TypeScript interfaces follow the naming in `design-docs/state.md` / `src/agent/state.ts` exactly (ExplorationState, Finding, EventThread, etc.).

## Implementation Principles

- Agent core maps to `design-docs/` specs — check the spec before implementing; newer subsystems (web, accounts, share, eval) are documented in `docs/` or only in code.
- `design-docs/` is the specification. Implement as written, don't improvise architecture.
