# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

Implementation in progress. `design-docs/` contains the complete specification; `src/` contains the implementation. All design documents are written in Chinese with English technical terms.

## What This Is

Graph Explorer Agent is a multi-hop relationship reasoning agent for financial knowledge graphs. It operates as an independent TypeScript process exposed as an MCP tool (`graph_explore`), called by a host agent (OpenClaw) when multi-hop reasoning is needed.

## Architecture at a Glance

```
Host Agent (function call)
    └→ graph_explore(goal, seed_entities, ...)
           │
           ▼
    Graph Explorer (independent process)
    │
    │  Agent Loop: EXPLORING → FINALIZE
    │       ↕ MCP
    │  knowledge-graph MCP service
    │
    └→ Returns: findings + event_threads + meta
```

Core constraint: **"Library over framework"** — no agent framework, the loop is entirely in own code.

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
| `agent-card.md` | MCP tool definition (is its own documentation) |

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

- **Config-decoupled MCP**: `knowledge-graph` endpoint lives in `config.json`, not in agent code or Claude settings

- **Single-hop tool primitives**: Each tool enforces `hops=1`; multi-hop behavior emerges from the Agent Loop composing calls sequentially
- **Phase isolation**: EXPLORING phase does not see event_buffer; FINALIZE gets full context injection
- **Evidence traceability**: Every finding requires KU ID–backed evidence; threads validate ku_id existence against event_buffer
- **Budget-aware at every level**: Token (128k), step (20 EXPLORING + 2 FINALIZE), and depth budgets checked each iteration with 4-level compression escalation
- **Graceful degradation**: 3-level MCP error handling (retry → fallback → skip), LLM format auto-repair, diminishing-returns detection (4 consecutive identical decisions forces strategy switch)
- **Tool definition IS the API**: The MCP tool schema for `graph_explore` serves as its own Agent Card — no separate integration doc needed

## Finding Categories

Four types: `pattern_violation`, `concentration`, `chain`, `absence`. Extraction is triggered by step thresholds, strategy switches, unexpected results, or sufficient signal. Dedup uses entity overlap + category match + keyword similarity.

## Implementation Principles

- Each source file maps to one design doc — check the spec before implementing
- `design-docs/` is the specification. Implement as written, don't improvise architecture
