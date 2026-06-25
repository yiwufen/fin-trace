# AGENTS.md

This file provides guidance to AI coding agents (e.g. ZCode Agent) when working with code in this repository.

> 注：本项目同时保留 `CLAUDE.md` 与 `.claude/rules/`，供 Claude Code 使用。两份配置内容等价；当两者冲突时，以本文件（AGENTS.md）为准。

## Project Status

Implementation in progress. `design-docs/` contains the complete specification; `src/` contains the implementation. All design documents are written in Chinese with English technical terms.

## What This Is

Graph Explorer Agent is a multi-hop relationship reasoning agent for financial knowledge graphs. It operates as an independent TypeScript process exposed as an A2A Agent (`graph_explore` skill), called by a host agent (OpenClaw) when multi-hop reasoning is needed.

## Architecture at a Glance

```
Host Agent (OpenClaw)
    │  a2a_discover → Agent Card
    │  a2a_send_task → taskId
    │  a2a_task_status → poll
    ▼
fin-trace A2A Agent (independent process)
    │
    │  Agent Loop: EXPLORING → FINALIZE
    │       ↕ MCP (internal)
    │  knowledge-graph MCP service
    │
    └→ Returns: findings + event_threads + meta (as A2A Artifacts)
```

Core constraint: **"Library over framework"** — no agent framework, the loop is entirely in own code.

## Build & Test Commands

```bash
npm run build       # tsc && build web workspace → dist/ + web/dist/
npm run dev         # build web then tsx src/index.ts (development run)
npm start           # node dist/index.js (production run)
npm run typecheck   # tsc --noEmit (type check only)
```

No test runner is configured; correctness is verified via `typecheck` and end-to-end runs.

## Project Structure

- `src/` — TypeScript implementation (each source file maps to one design doc)
- `design-docs/` — the specification; `README.md` is the master index
- `web/` — npm workspace for the frontend (Vite + React)
- `skills/` — cross-platform skill definitions (e.g. `fin-trace.md`)
- `docs/` — deployment guide and ops runbook
- `scripts/` — one-time setup scripts (registry init)
- `.github/workflows/` — CI/CD pipeline

## Deployment Architecture

```
GitHub Actions (CI)              百度服务器 182.61.1.77 (CD)
typecheck ──SSH 触发──→  git pull
                         docker build --network host (走代理 127.0.0.1:7890)
                         docker push localhost:5000
                         docker compose pull + up -d
                         health check

Registry: localhost:5000 (仅本机)，Caddy 上无暴露路由
镜像:    localhost:5000/fin-trace:latest
环境:    deployer@182.61.1.77, ~/fin-trace/, 3.8 GB 内存
```

### 部署关键约束

- **服务器无法直连外网** — Docker Hub / npm 必须走 `127.0.0.1:7890` 代理
- **构建用 `--network host`** — 否则容器内无法访问宿主机代理
- **推送本地镜像前移除 Docker 客户端代理** — 否则 `localhost:5000` 也被劫持
- **Caddy 修改后必须 `docker restart`** — `caddy reload` 有 bind mount 缓存
- **Registry 数据目录不可 rsync `--delete`** — `registry-data/`、`registry-auth/` 需排除
- **CI 用独立 SSH 密钥对** — `ssh-keygen -t ed25519 -C "fin-trace-ci"` 生成，公钥写入 `authorized_keys`，私钥存 GitHub Secrets
- 完整部署文档：`docs/deploy.md`
- `config.json` — runtime configuration (gitignored; see `config.example.json`)
- `data/` — runtime data (gitignored)

## Design Document Index

All docs are in `design-docs/` with `README.md` as the master index.

| File | What it defines |
|------|-----------------|
| `README.md` | Master index + architecture overview |
| `system-prompt.md` | Six-layer system prompt (phase-dependent activation) |
| `tools.md` | 5 tool schemas: lookup, trace, timeline, expand, scan |
| `state.md` | TypeScript interfaces: ExplorationState, Finding, EventThread, etc. |
| `agent-loop.md` | Think-Act-Observe loop pseudocode + phase transitions |
| `findings.md` | Finding extraction triggers, dedup, confidence grading |
| `event-threads.md` | FINALIZE prompt + thread construction + validation |
| `error-handling.md` | Fallback mapping, 3-level MCP degradation, LLM format repair |
| `context-assembly.md` | Token budget allocation (128k), State View, compression strategy |
| `agent-card.md` | A2A Agent Card + JSON-RPC contract |

## Project Configuration

`config.json` at project root stores runtime configuration, decoupled from agent logic:

```json
{
  "mcp": {
    "servers": {
      "knowledge-graph": {
        "url": "https://182-61-1-77.nip.io/mcp",
        "transport": "streamable-http"
      }
    }
  }
}
```

Agent code reads MCP endpoint from this file at startup — no hardcoded URLs.

## Key Architectural Decisions

- **Config-decoupled**: `knowledge-graph` MCP endpoint lives in `config.json`, not in agent code. The A2A Agent Card URL is derived from the server port.
- **Single-hop tool primitives**: Each tool enforces `hops=1`; multi-hop behavior emerges from the Agent Loop composing calls sequentially
- **Phase isolation**: EXPLORING phase does not see event_buffer; FINALIZE gets full context injection
- **Evidence traceability**: Every finding requires KU ID–backed evidence; threads validate ku_id existence against event_buffer
- **Budget-aware at every level**: Token (128k), step (20 EXPLORING + 2 FINALIZE), and depth budgets checked each iteration with 4-level compression escalation
- **Graceful degradation**: 3-level MCP error handling (retry → fallback → skip), LLM format auto-repair, diminishing-returns detection (4 consecutive identical decisions forces strategy switch)
- **A2A over MCP for external interface**: Long-running Agent Loop (3-20min) is exposed as an A2A Task (async submit → poll → collect artifacts), not a synchronous MCP function call. Internal KG communication still uses MCP.

## Finding Categories

Four types: `pattern_violation`, `concentration`, `chain`, `absence`. Extraction is triggered by step thresholds, strategy switches, unexpected results, or sufficient signal. Dedup uses entity overlap + category match + keyword similarity.

## Architecture Constraints（架构约束）

These constraints are binding — treat them as hard limits when editing code.

### Implementation Fidelity（实现保真）
- `design-docs/` is the specification. Implement as written, don't improvise architecture.
- The 5 tools (lookup, trace, timeline, expand, scan) are fixed — do not add, remove, or rename tools.
- `hops=1` is enforced at tool level; depth control is the Agent Loop's job, not a tool parameter to change.

### Config Decoupling（配置解耦）
- MCP endpoint must be read from `config.json` at startup. Never hardcode URLs into source code.
- When adding new external service dependencies, add their URLs to `config.json` as well.

### Framework Constraint（框架约束）
- Do not introduce agent frameworks (LangChain, AutoGen, CrewAI, etc.). The Agent Loop is custom code.
- Use lightweight libraries for MCP client, not orchestration layers.
- "Library over framework" — prefer composing small, focused modules over adopting a framework's abstractions.

### Evidence Traceability（证据可追溯）
- Every Finding must have `evidence: string[]` (KU IDs). No evidence = not a valid finding.
- Event Threads must validate `ku_id` against `event_buffer` before inclusion.
- `reliability_note` must be set when any degradation occurred during the session.

## Language & Style Conventions（语言与风格约定）

### Language（语言）
- Documents, design notes, and code comments: Chinese (with English technical terms where natural).
- Code identifiers (variables, functions, types, files): English.
- Git commit messages: English.

### Style（风格）
- Match the writing style of existing `design-docs/` — concise, structured with tables and code blocks, no filler prose.
- TypeScript interfaces follow the naming in `design-docs/state.md` exactly (ExplorationState, Finding, EventThread, etc.).

## Implementation Principles

- Each source file maps to one design doc — check the spec before implementing
- `design-docs/` is the specification. Implement as written, don't improvise architecture
