# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What HomeRail is

A voice-first, local agent-orchestration runtime: user intent (voice or text) → a Manager Agent plans a DAG → each DAG node runs as an agent in its own Docker Worker container → explicit handoffs carry evidence node-to-node → runs are replayable and scored. It runs on the operator's own hardware (homelab/NAS), never as SaaS.

Design constraints that shape code decisions (see ROADMAP.md):
- HomeRail targets outputs that are **easy to judge** (reports, assets, configured systems) — it is explicitly NOT a software-engineering automation tool, and not a general-purpose job runner.
- It does not build agent harnesses; it orchestrates on top of existing ones (Claude Agent SDK, Codex app server, Kimi Code).
- Human attention is the scarce resource: narrow on the human side (voice in, generated UI out), wide on the machine side (agents/nodes/environments).

## Repository layout

Six independent npm packages (NOT npm workspaces — each has its own `node_modules`, installed/built via `npm --prefix`):

| Package | Role |
| --- | --- |
| `homerail_protocol` | Shared message/validation contracts (zod + ajv). Single source of truth for runtime communication. Other packages depend on it as `homerail-protocol` via relative path; `homerail_worker` has a `postinstall` that runs `npm ci` inside it. |
| `homerail_manager` | Manager service: HTTP/WS server (port 19191), DAG engine (`src/orchestration/` — graph-executor, dag-dispatcher, dag-engine, graph-validator, yaml-loader), persistence (better-sqlite3), scorecards/eval, voice-session registry, generated-UI widget contract (`src/widgets/`). Runtime phase marker lives in `src/runtime/status.ts`. |
| `homerail_node` | Node daemon: provisions one Docker Worker container per DAG node (dockerode). |
| `homerail_worker` | Worker runtime inside the container. Harness adapters in `src/agent/` (claude-sdk, codex-appserver, kimi-code, deterministic offline backend, factory + backend-selection). DAG tools (handoff etc.) in `src/dag-tools/`. |
| `homerail_cli` | The `hr` CLI (commander). Primary way to operate HomeRail. |
| `agent-ui` | Decoupled Vue 3 + Vite browser UI (ports 19192 HTTPS / 19193 HTTP). Vue Flow for DAG graphs, chart.js, i18n locales. |

Other roots: `assets/orchestrations/` (DAG YAML templates + `dag-best-practices/SKILL.md`), `assets/profiles/` (runtime profiles), `skills/` (agent skills for driving HomeRail — install by **symlinking**, never copying).

## Commands

Node.js >= 20 and npm >= 10 required; Docker must be running for live DAG runs. On this machine, use Node 24 via fnm (`eval "$(fnm env)" && fnm use 24`) — new shells default to Node 26.

From the repo root:

```bash
npm run install:all       # npm ci in all six packages, in dependency order
npm run build             # build all packages (protocol first)
npm run typecheck         # tsc --noEmit across all packages
npm run test:packages     # vitest run across all packages (no rebuild)
npm run ci                # typecheck + build + test — run before considering work done
```

Per-package (faster inner loop):

```bash
npm --prefix homerail_manager test        # one package's tests (manager's test also typechecks)
npm --prefix homerail_manager run dev     # tsx src/index.ts (manager dev mode)
cd homerail_node && npx vitest run src/__tests__/foo.test.ts   # single test file
npx vitest run -t "test name"             # single test by name (from package dir)
npm --prefix agent-ui run dev             # Vite dev server
npm --prefix agent-ui run lint            # eslint --fix (agent-ui only has lint config)
npm --prefix agent-ui run typecheck      # vue-tsc against tsconfig.prod.json
```

Changing `homerail_protocol` requires rebuilding it before dependent packages pick it up.

## Operating the runtime (`hr` CLI)

`hr` is npm-linked from `homerail_cli/` (`cd homerail_cli && npm link`). Core loop:

```bash
hr start [--ui]           # start Manager + Node (builds homerail-worker:latest image on first run)
hr doctor                 # readiness: manager, runtime, node, model setting, manager-agent harness
hr templates list
hr run <template-path|name> [--sync] [--profile <p>] --prompt "..."   # returns run_id
hr status <run_id>        # node states
hr dag supervise <run_id> # watch handoff flow
hr scorecard <run_id>     # pass/fail scorecard
hr eval-run <run_id>      # eval report
hr replay <run_id> / hr trace <run_id>
hr smoke dag --template assets/orchestrations/public-dev-5node.yaml.template   # full 5-node smoke
hr runtime status|logs|stop ; hr ui status|logs|stop
```

- Offline topology check without a model provider: `--profile offline-deterministic` on the two-node template.
- CLI resolves Manager URL: `--base-url` → `HOMERAIL_MANAGER_URL` → `${HOMERAIL_HOME}/config.json` → `http://localhost:19191`.
- `HOMERAIL_HOME` (default `~/.homerail`) holds Manager state, logs, and per-run workspaces (`workspace/<run_id>/` — grows quickly).
- Provider credentials live in the Manager's encrypted settings store (`hr model configure ... --api-key-stdin`), never in repo files.
- When editing DAG YAML, keep `workflow_id` stable — changing it creates a new workflow identity.

## Architecture notes

- **Execution chain**: `hr` CLI → Manager service (coordination, port 19191) → Node (provisions Docker workers) → Worker containers (one per DAG node). Workers for one run share `${HOMERAIL_HOME}/workspace/<run_id>`. Manager never runs inside the Worker image.
- **Handoffs are the contract**: each DAG node receives upstream handoff content injected into its task prompt, does its part, and must call the `handoff` tool exactly once on its declared port. Scorecards verify handoffs are non-empty and no auto-handoff fallback fired.
- **Per-node model routing** ("smart brain, efficient workers"): templates map `provider`/`model` per agent with a `"*"` wildcard fallback, so an expensive model can plan/review while cheaper models do bulk work. Each node gets a fresh context window.
- **Worker networking**: containers reach the Manager via the URL Manager passes to Node — `host.docker.internal` on Docker Desktop, `host-gateway` or `HOMERAIL_MANAGER_WORKER_WS_BASE_URL` on Linux. Never hardcode Docker bridge addresses.
- **Manager Agent harness gap**: for the voice Manager Agent, `codex_appserver` is the only harness that synthesizes the spoken `commentary` channel from the reasoning stream; `claude-sdk` and `kimi-code` are silent during execution. This is a provider capability gap, not a HomeRail bug.
- Ports: Manager 19191, Agent UI 19192 (HTTPS, self-signed) / 19193 (HTTP). All bind 127.0.0.1 by default; `--host 0.0.0.0` / `--public` only for intentional exposure.
