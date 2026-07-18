---
name: homerail-cli
description: |
  Exact HomeRail local-source TypeScript CLI command and configuration reference.
  Use when: (1) configuring or invoking the homerail CLI from a local checkout,
  (2) listing orchestration templates, starting runs, checking status,
  (3) supervising DAG runs, inspecting chats/handoffs/scorecards,
  (4) injecting instructions or replaying runs, or (5) translating a known HomeRail operation into an exact hr command.
  For workflow topology selection use homerail-dag-patterns; for multi-Actor Surface lifecycle and operational procedure use homerail-dag-ops.
  For deployment, service startup, or skill installation, use homerail-install-ops first.
---

# HomeRail CLI (TypeScript)

## Manager Agent native shell

The HomeRail Manager Agent can use the selected harness's native shell directly:
Codex provides its built-in shell and Claude Agent SDK provides `Bash`.

Prefer `hr --json <command...>` for structured results. If `hr` is not installed
on `PATH`, HomeRail exposes the active local-source entrypoint through
`HOMERAIL_CLI_ENTRYPOINT`; invoke it as:

```bash
node "$HOMERAIL_CLI_ENTRYPOINT" --json <command...>
```

A zero exit status plus the returned JSON is valid execution evidence. Dedicated
Manager Tools remain useful shortcuts, but the CLI is the complete control
surface for commands that have no dedicated Tool.

## Installation

Before acting, apply `homerail-shared` rules. This pre-publication release uses the local source tree; do not assume npm publication exists.

```bash
cd homerail_cli
npm ci
npm run build
```

The CLI binary is `dist/cli.js`. Run it directly or via the `hr` bin alias:

```bash
# From the repo root after build
node homerail_cli/dist/cli.js --help

# Or link globally
cd homerail_cli && npm link
hr --help
```

For development without a build step:

```bash
npx tsx homerail_cli/src/cli.ts --help
```

## Configuration

Use the CLI config flow for local runtime settings and provider credentials:

```bash
hr config
hr config show
hr config apply
```

`hr config` writes non-secret settings under `${HOMERAIL_HOME}/config.json`.
Provider and integration credentials are sent to Manager and stored in the
Manager encrypted settings store, persisted under
`${HOMERAIL_HOME}/manager/homerail.db`. `${HOMERAIL_HOME}/secrets/env` is a
legacy plaintext import path only; do not use it as the normal OSS
configuration path.

The Manager URL is resolved in this order:

1. `--base-url <url>` flag on any command
2. `HOMERAIL_MANAGER_URL` environment variable
3. `${HOMERAIL_HOME}/config.json`
4. Default: `http://localhost:19191`

The default Manager port is `19191`. Override it with `HOMERAIL_MANAGER_PORT` for
local service startup, or use a full `HOMERAIL_MANAGER_URL` / `--base-url` when the
Manager is on another host or port.
The default Agent UI HTTPS port is `19192`. Override it with `HOMERAIL_UI_PORT` or
`ui.port` in local config. The HTTP fallback port is `19193`; override it with
`HOMERAIL_UI_HTTP_PORT` or `ui.httpPort`.

```bash
# Option A: environment variable
export HOMERAIL_MANAGER_PORT=19191
export HOMERAIL_MANAGER_URL=http://localhost:${HOMERAIL_MANAGER_PORT}

# Option B: per-command flag
hr --base-url http://localhost:19191 templates list
```

Additional global options:

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON instead of formatted text |
| `--request-timeout <ms>` | HTTP request timeout (default: 30000) |

## Commands

### Local Runtime

```bash
# Interactive local config
hr config

# Start Manager and Node together
hr start
hr start --rebuild-worker-image
hr start --ui
hr start --ui --enable-text-mode

# Inspect and stop services started by hr start
hr runtime status
hr runtime logs
hr runtime stop

# Start and stop the decoupled Agent UI
hr ui start
hr ui start --enable-text-mode
hr ui status
hr ui logs
hr ui stop

# Check readiness
hr doctor
```

`hr start` is service-first: missing provider credentials should not prevent
Manager and Node from starting. `hr doctor` is the readiness gate that reports
missing model configuration and Manager Agent harness compatibility before DAGs
or Manager Agent smokes can run.
Use `--rebuild-worker-image` after changing `homerail_worker` source so provisioned
DAG workers run the current checkout instead of a stale local Docker image.
Use `hr start --ui` or `hr ui start` to run the Agent UI. HTTPS is the
primary local endpoint (`https://localhost:19192`) and HTTP remains available as
a fallback (`http://localhost:19193`). The UI processes use
`${HOMERAIL_HOME}/pids/ui-https.pid` / `${HOMERAIL_HOME}/logs/ui-https.log` and
`${HOMERAIL_HOME}/pids/ui.pid` / `${HOMERAIL_HOME}/logs/ui.log`; `hr runtime stop`
also stops both.
Agent UI text mode is temporarily disabled by default, so `/agent` opens the
Voice Agent cockpit directly. Use `--enable-text-mode` only when restoring the
text Agent shell for local debugging.

### Templates and Runs

```bash
# List available orchestration templates
hr templates list
hr --json templates list

# Start a DAG run from a public YAML template path
hr run assets/orchestrations/public-two-node.yaml.template \
  --prompt "<prompt>"

# Sync a DAG asset to the Manager database. The YAML workflow_id is the stable
# identity; keep it unchanged during AI edits unless creating a new workflow/version.
hr dag sync assets/orchestrations/public-dev-5node.yaml.template

# Sync a DB-backed runtime profile. Profile YAML references model_alias or
# llm_setting_id, not provider/model.
hr profile sync assets/profiles/example-runtime.profile.yaml.template \
  --workflow public-dev-5node-template

# Run the database DAG instance with a server-side runtime profile
hr run \
  --workflow public-dev-5node-template \
  --profile example-runtime \
  --prompt "<prompt>"

# One-shot convenience: sync asset and profile YAML, then run the DB instance
hr run assets/orchestrations/public-dev-5node.yaml.template \
  --sync \
  --profile assets/profiles/example-runtime.profile.yaml.template \
  --prompt "<prompt>"

# Pin a specific database LLM setting for this run when needed
hr run assets/orchestrations/public-two-node.yaml.template \
  --setting-id <llm_setting_id> \
  --prompt "<prompt>"

# Run a read-only local harness deployment diagnosis from a fresh clone.
# The agent files an issue only when deployment is blocked.
hr run assets/orchestrations/local-harness-cli-deploy-diagnosis.yaml.template \
  --prompt "source_repo_url=<https git url> branch=main"

# List recent runs
hr runs

# Check run status
hr status <run_id>
hr --json status <run_id>

# Stop a running DAG
hr stop <run_id>
```

The deployment diagnosis template is a normal DAG. Do not start a fixed host
Worker and do not mount Docker into the Worker. The run should be provisioned
through Node like any other DAG, use its isolated workspace, clone the latest
source, build it, configure the cloned CLI to talk to the outer Manager, and
verify `runtime status` / `doctor`. The template uses advisory scorecard
enforcement, so scorecard findings should be reviewed separately from the
deployment result unless a template explicitly opts into strict enforcement.

### Smoke Gates

```bash
# Live DAG smoke through Manager create-and-run
hr smoke dag \
  --template assets/orchestrations/public-dev-5node.yaml.template

# Live Manager Agent smoke through /api/manager/chat
hr smoke manager-agent

# Validate a specific configured Manager Agent runtime
hr smoke manager-agent --setting-id <llm_setting_id>
hr smoke manager-agent --provider <provider_id> --model <model_name>
```

`smoke manager-agent` verifies the configured Manager Agent harness can call
Manager tools. It requires `/api/manager/chat` to return a real `run_id`, then
waits for the deterministic two-node DAG to reach `completed`.

### DAG Supervision and Inspection

```bash
# Cursor-based supervision (preferred for live monitoring)
hr dag supervise <run_id>

# Single tick with cursor (for agent-driven loops)
hr dag supervise <run_id> --tick --cursor <cursor>

# Interval polling watch
hr dag watch <run_id> --interval 5 --timeout 600

# Quick status snapshot
hr dag quick <run_id> --events 10

# Per-node chat and tool activity
hr dag chats <run_id> --tools 5
hr dag chats <run_id> --node node-a node-b
hr dag chats <run_id> --tools 20 --raw-tools

# Handoff content and contract checks
# --content-limit caps each handoff's content; default 500 truncates long JSON.
# Pass 0 (or a large value) to see the full review/summary payload.
hr dag handoffs <run_id> --content-limit 0
```

Use `--raw-tools` only for audit/debug. It prints redacted tool inputs and
result previews so an operator can verify CLI-first behavior, detect forbidden
Write/Edit/MultiEdit use, or spot direct API calls.
For local deep debugging only, Worker raw audit files are stored per run under
`${HOMERAIL_HOME}/audit/tool-events/<run_id>.jsonl`; older installs may still have
legacy `${HOMERAIL_HOME}/audit/tool-events.jsonl` archives.

### Evaluation and Reporting

```bash
# Run scorecard
hr scorecard <run_id>

# Evaluation report
hr eval-run <run_id> --events 5 --tools 3

# Replay log
hr replay <run_id>
```

Scorecard policies are advisory by default. `hr scorecard` still reports
findings, but `eval-run` only treats scorecard findings as gating failures when
the template declares `scorecard.enforcement: strict`.

### Utilities

```bash
# Configure the MiMo token-plan preset through local config
hr config
hr config apply

# List configured LLM providers
hr provider list

# Add or update a local custom provider catalog entry
hr provider upsert \
  --id <provider-id> \
  --name "<display name>" \
  --default-model <model-name> \
  --provider-base-url <provider-api-base-url>

# Show current LLM settings
hr llm-settings list

# Configure a realtime ASR model setting; read the key from stdin in real use
hr llm-settings add \
  --provider-id custom-asr-provider \
  --model-name realtime-asr-model \
  --display-name "Realtime ASR" \
  --endpoint-id custom_asr_realtime \
  --endpoint-name "Realtime ASR" \
  --plan-type custom \
  --protocol custom \
  --auth-type bearer \
  --model-base-url http://<asr-host>:5000 \
  --asr-realtime-url ws://<asr-host>:5002/v1/realtime \
  --supports-asr \
  --api-key-stdin

# Patch voice endpoint metadata without rebuilding the setting
hr llm-settings update <setting-id> \
  --asr-realtime-url ws://<asr-host>:5002/v1/realtime \
  --supports-asr \
  --no-supports-llm

# Show or switch the current Voice Agent runtime selection
hr voice show
hr voice configure \
  --recognition-mode asr \
  --asr-setting-id <asr-setting-id> \
  --tts-setting-id <tts-setting-id> \
  --llm-setting-id <llm-setting-id> \
  --tts-output-channel final \
  --tts-output-channel commentary
```

Do not configure an LLM-only model as ASR. Realtime ASR requires a separate
`supports_asr` setting that points at a realtime-capable endpoint. Batch ASR
remains a separate setting without a native realtime URL.

```bash
# Run statistics
hr stats

# Execution trace
hr trace <run_id>

# Inject an instruction into a running node
hr inject <run_id> <node_id> "<instruction>" --mode inbox
```

## Asset Discovery

The CLI sends the template path to the TS Manager API. Public examples use
`.yaml.template` files so users can copy them before adding local provider
profiles.

To discover available templates:

```bash
hr templates list
```

To inspect a template's structure, read the YAML file directly from
`assets/orchestrations/` in the repository.

Use `assets/orchestrations/local-harness-cli-deploy-diagnosis.yaml.template` for a
single-node, read-only local harness diagnosis run that clones fresh source, tries the
CLI deployment path on an isolated non-default Manager port, and creates a
deployment-blocker or coverage-blocker issue only on failure.

## DAG YAML Reference

Templates live in `assets/orchestrations/` and follow this minimal structure:

```yaml
name: my-pipeline
description: "Short description of the pipeline"

agents:
  my-agent:
    system: |
      You are a worker agent.
      When finished, call handoff(port="done", content=result).

nodes:
  step-a:
    name: "Step A"
    agent: my-agent
    after: []
    outputs:
      done:
        to: ""  # empty string = terminal node
```

Provider/model runtime selection comes from database LLM settings configured by
the CLI or settings UI. DB runtime profiles may select a default `model_alias`
or `llm_setting_id`, plus per-agent overrides and `agent_type`. YAML DAG
templates themselves must not contain provider/model/key/base_url runtime
fields. Supported public backend names include `claude-sdk`, `kimi-code`,
`kimi_code`, `codex_appserver`, and `deterministic`.
Do not use `direct-llm` or Chat Completions for Coding Plan / Agent Plan
accounts. Kimi should use the Kimi Code CLI harness (`kimi-code`); other
Coding Plan providers should use the Claude Code compatible harness
(`claude-sdk`) with an Anthropic-compatible endpoint.
Prefer hyphenated names in new YAML (`kimi-code`) unless you are preserving an
older template.

### Key Fields

| Field | Location | Description |
|-------|----------|-------------|
| `name` | top-level | Template display name shown by `hr templates list` |
| `agents.<key>.system` | agent | Inline system prompt |
| `agents.<key>.system_file` | agent | External prompt file (relative to YAML) |
| `nodes.<id>.agent` | node | Agent assignment |
| `nodes.<id>.after` | node | List of predecessor node IDs |
| `nodes.<id>.outputs.<port>.to` | node | Route target `"node.in:port"` or `""` for terminal |

## MCP Tools Available to DAG Agents

Each DAG agent receives these tools automatically:

| Tool | Purpose |
|------|---------|
| `handoff(port, content)` | Must be called when finished; hands off to downstream nodes |
| `send_message(to_node, content)` | Send a message to another node in the graph |
| `receive_message(timeout?)` | Block until a message arrives |
| `get_graph_context()` | Inspect current position in the DAG graph |
