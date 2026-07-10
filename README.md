# HomeRail

English | [中文](README.zh-CN.md)

HomeRail is a TypeScript runtime that turns one-off agent chats into auditable,
reusable workflows. The name comes from what it is: **Home** — it runs on your
own homelab, NAS, or home server, serving the people who live there; **Rail** —
the track shape of a DAG, where agent work flows node to node along explicit
edges instead of pooling in a single chat. The design bet is that a person's
attention is the scarcest resource in any automation, so the system should ask
for very little of it.

The long-term shape is a resident home-datacenter agent you talk to — voice in,
a generated interface out, a DAG of agents doing the work behind it. What is in
this tree today is the foundation it runs on: a DAG engine, a CLI, a voice
surface, and the first steps toward a generated UI.

## Why

Human bandwidth is narrow; the work we want done is not. HomeRail is shaped like
an inverted funnel that widens toward the machine:

- **Voice** — the preferred input, because it asks the least of you. You speak;
  the agent listens, confirms, and narrows ambiguity before doing anything. Text
  is always available too — for quiet settings, for precision, or for anyone not
  ready to talk to their computer yet.
- **Generative UI** — the agent does not dump logs or JSON at you. The interface
  is generated for the moment and shaped to be easy to read.
- **DAG** — the execution engine behind both. Multiple agents, multiple roles,
  multiple environments, with every handoff traced and every run replayable.

A chat session is a black box. A DAG is a graph you can inspect, replay, and
improve. HomeRail is what sits between the two — narrow where the person is,
wide where the machine is.

## What works today

- **DAG runtime** *(most mature)* — multi-agent orchestration with explicit
  handoffs, workspace isolation per run, replay, scorecards, and run evaluation.
- **CLI `hr`** — `start`, `config`, `doctor`, `run`, `smoke`, `dag supervise`,
  `scorecard`, `eval-run`, `replay`. The primary way to operate HomeRail.
- **Voice surface** — a Voice Surface Contract with ASR / TTS / VAD, Chinese by
  default, served through a desktop voice shell. The agent collects intent
  across turns before acting.
- **Generative UI** *(in exploration)* — instead of dumping logs or JSON, the
  agent produces structured, generated views meant to be read at a glance. The
  shape of these views is still being designed through real use cases; the
  contract and the widget set will keep changing.
- **Docker Worker** — Manager and Node run as local services; Node uses Docker
  to provision Worker containers, one per DAG node, sharing a workspace per run.

## Hand this README to an agent

HomeRail is designed to be operated by agents as much as by people. This README
is written so that it doubles as an agent-readable runbook: the commands below
are plain `hr` invocations with self-describing names, and each step says what
to expect. You can hand the whole file to your agent (Claude Code, Codex, or
any tool that can run shell commands and read output) and ask it to install,
configure, and verify HomeRail on your machine following the Quickstart.

## Quickstart

Requirements:

- Node.js 20+ and npm 10+
- Docker, used by Node to provision Worker containers
- A Claude Agent SDK-compatible model endpoint for live agent runs

Platform notes:

- **macOS** — install [Docker Desktop](https://www.docker.com/products/docker-desktop/).
  The default `host.docker.internal` mapping works out of the box.
- **Windows** — Docker Desktop (WSL 2 or Hyper-V backend both work), and run
  the CLI from Git Bash (or another POSIX-compatible shell). Some scripts
  assume a Unix-like shell and will not run correctly under `cmd.exe` or
  PowerShell.
- **Linux** — Docker Engine. Worker-to-Manager networking may need extra setup;
  see the [Configuration](#configuration) notes on Worker callback URLs.

Install and build from this source checkout:

```bash
npm run install:all
npm run build
```

Run the deterministic checks directly with `npm run ci`. To execute the Linux
GitHub Actions jobs locally, install Docker, [`act`](https://github.com/nektos/act),
and [`actionlint`](https://github.com/rhysd/actionlint), then run:

```bash
npm run ci:local
npm run ci:local -- core-linux  # run one job
```

The local runner covers the Linux core, UI coverage, and Docker smoke jobs. The
Windows job remains on GitHub's `windows-latest` runner.

The CLI is exposed as `hr`. Link it locally so the rest of this guide works as
written:

```bash
cd homerail_cli && npm link && cd ..
hr --help
```

Start Manager and Node together. On first run this builds the
`homerail-worker:latest` image; it is rebuilt automatically when the worker
source fingerprint changes:

```bash
hr start
```

Check readiness. `hr doctor` reports Manager reachability, Node availability,
the active model setting, and whether the Manager Agent harness can resolve a
runtime:

```bash
hr doctor
```

Run a local topology check. This uses the two-node template's offline
deterministic profile, so it does not need a model provider yet:

```bash
hr run assets/orchestrations/public-two-node.yaml.template \
  --profile offline-deterministic \
  --prompt "Draft a short checklist for a backend release"
```

The command returns a `run_id`; inspect it with `hr dag supervise <run_id>` if
you want to watch the handoff flow.

To also bring up the browser Agent UI:

```bash
hr start --ui
```

Defaults are Manager `http://localhost:19191`, Agent UI
`https://localhost:19192`, and HTTP fallback `http://localhost:19193`. The
Manager binds to `127.0.0.1` by default; use `hr start --host 0.0.0.0` only when
you intentionally want it reachable beyond localhost.

## Run a DAG

Load a template explicitly and run it:

```bash
hr templates list
hr run assets/orchestrations/public-two-node.yaml.template \
  --prompt "Draft a short project checklist"
```

For reusable workflows, sync the DAG into the Manager database. Keep
`workflow_id` stable when editing YAML; changing it creates a new workflow
identity.

```bash
hr dag sync assets/orchestrations/public-dev-5node.yaml.template
hr profile sync assets/profiles/example-runtime.profile.yaml.template \
  --workflow public-dev-5node-template
hr run \
  --workflow public-dev-5node-template \
  --profile example-runtime \
  --prompt "Draft a short project checklist"
```

Copy the returned `run_id`, then inspect it:

```bash
hr dag supervise <run_id>
hr scorecard <run_id>
hr eval-run <run_id>
```

For a topology check without a live model provider, the two-node template ships
an offline deterministic profile:

```bash
hr run assets/orchestrations/public-two-node.yaml.template \
  --profile offline-deterministic \
  --prompt "Draft a short checklist for a backend release"
```

## Drive the CLI from a coding agent

There is a second way to use HomeRail, beyond speaking to the Manager Agent or
typing commands yourself. A coding agent you already trust — Codex, Claude
Code, or any tool that can run shell commands — can drive the `hr` CLI
directly: `templates list`, `run`, `dag supervise`, `scorecard`, `replay`.

This skips the Manager Agent layer (the AI that plans a DAG from a request),
but not the Manager service (the DAG coordinator). Your coding agent takes over
the planning role: it reads a template, decides what to change, runs the DAG,
inspects the result, and iterates. This is the natural loop for developing and
debugging DAGs and templates — you get the full audit trail and evaluation of
the DAG runtime, with a model you already use for code in direct control of the
loop.

```text
you ↔ coding agent ↔ hr CLI ↔ Manager service ↔ DAG nodes
       (planning)              (coordination)     (execution)
```

The Manager Agent is still the right choice when you want HomeRail to plan and
run a workflow end-to-end from a single request, especially by voice. Driving
the CLI yourself is the right choice when you are building or tuning the DAG.

## Architecture

| Package | Role |
| --- | --- |
| `homerail_protocol` | Shared message and validation contracts — single source of truth for runtime communication. |
| `homerail_manager` | Manager service and DAG coordinator. Owns the voice surface and the generated-UI contract. |
| `homerail_node` | Node service. Provisions Docker-backed Worker containers. |
| `homerail_worker` | Worker runtime. Harness adapters for Claude Agent SDK and compatible agent backends. |
| `homerail_cli` | The `hr` CLI. Configures, runs, and inspects DAG workflows. |
| `agent-ui` | Decoupled browser UI for operating the Manager. Renders voice surface and widgets. |

Manager and Node run as local services. Manager is not expected to run inside
the Worker image. Node creates Worker containers; Workers for one run share
`${HOMERAIL_HOME}/workspace/<run_id>`.

### Smart brain, efficient workers

The expensive model should not do everything. Each DAG node runs in its own
context window: it receives the handoff it needs, does its part, and passes
evidence forward. Context never balloons into one giant thread, and nothing gets
compressed under pressure just to fit. Because nodes are independent, each can
use a different model — the smartest model plans and reviews; cheaper, more
token-efficient models do the bulk of the work. Templates express this through a
per-agent `provider` / `model` mapping, with a `"*"` wildcard as the fallback
default.

## Configuration

`HOMERAIL_HOME` is the local data root — where Manager state, run workspaces,
logs, and the worker image cache land. It defaults to `~/.homerail` and can grow
quickly: every DAG run writes its artifacts under
`${HOMERAIL_HOME}/workspace/<run_id>/`, and these accumulate across runs. Point
it at a disk with room (a NAS mount, a large external volume) before you start
running real work:

```bash
export HOMERAIL_HOME="/mnt/nas/homerail"
```

Provider credentials are stored in the Manager encrypted settings store, never
in repo files. Configure a model from the provider catalog:

```bash
hr model configure <provider-or-endpoint-alias> \
  --endpoint-id <endpoint-id> \
  --model-name <model-id> \
  --api-key-stdin
hr model list
```

After a model is configured, run the full public smoke DAG. It exercises the
five-node path (plan → implement → test → review → summarize) and verifies both
scorecard and eval-run:

```bash
hr smoke dag \
  --template assets/orchestrations/public-dev-5node.yaml.template
```

A passing smoke writes its artifacts to the shared run workspace:

```text
${HOMERAIL_HOME}/workspace/<run_id>/snake-game/index.html
${HOMERAIL_HOME}/workspace/<run_id>/snake-game/TESTS.md
```

The CLI resolves the Manager URL in this order: `--base-url`,
`HOMERAIL_MANAGER_URL`, `${HOMERAIL_HOME}/config.json`, then
`http://localhost:19191`.

For reverse-proxied public access, advertise external endpoints and bind the UI
to the machine IP:

```bash
hr start --ui --public \
  --public-url https://homerail.example.com \
  --ui-public-url https://homerail-ui.example.com
```

Worker containers connect back to the Manager through the URL Manager passes to
Node. On Docker Desktop the default `host.docker.internal` mapping is usually
enough; on Linux use Docker `host-gateway` support or set
`HOMERAIL_MANAGER_WORKER_WS_BASE_URL`. Do not hardcode Docker bridge addresses.

Runtime helpers:

```bash
hr runtime status
hr runtime logs
hr runtime stop
hr ui status
hr ui logs
hr ui stop
```

## Project direction

HomeRail is heading toward a resident agent on the home datacenter — voice in,
generated UI out, multiple nodes and terminals (phone, tablet, TV, car). The
foundation here is the first step; see [ROADMAP.md](ROADMAP.md) for the plan.

For the voice Manager Agent, **Codex (`codex_appserver`) is the recommended
harness today**: it is the only path that auto-synthesizes the `commentary`
speech channel from the model's native reasoning stream, so the user hears
progress while work happens. Other harnesses (`claude-sdk`, `kimi-code`) are
silent during execution — this is a provider capability gap, not something
HomeRail can close.

## License

MIT. See [LICENSE](LICENSE).
