---
name: homerail-install-ops
description: Install, configure, start, verify, update, and troubleshoot a local-source HomeRail deployment for AI-agent use. Use when a user wants to deploy HomeRail from a local checkout or local Git address, install HomeRail skills, set up Manager/Node/Worker services, configure provider credentials, run doctor/smoke, or repair a broken local install before npm publication exists.
---

# HomeRail Install Ops

Before acting, apply `homerail-shared` rules. This pre-publication flow uses a local source checkout or local Git clone, not npm publication.

## Local Skill Install

Install HomeRail skills by linking the checkout's `skills/homerail-*`
directories into the target agent skill directory. Prefer symlinks over copies
so skill updates follow `git pull`.

If the source tree is already present, use `skills/README.md` as the source of
truth for Codex and Claude Code install targets. On macOS/Linux:

```bash
repo=/path/to/HomeRail

for root in "${CODEX_HOME:-$HOME/.codex}/skills" "$HOME/.claude/skills"; do
  mkdir -p "$root"
  for skill in "$repo"/skills/homerail-*; do
    [ -d "$skill" ] || continue
    name="$(basename "$skill")"
    dst="$root/$name"
    if [ -L "$dst" ]; then
      rm "$dst"
    elif [ -e "$dst" ]; then
      echo "Refusing to replace existing non-symlink skill: $dst" >&2
      continue
    fi
    ln -s "$skill" "$dst"
  done
done
```

If the user gives a local Git address, clone it first, then install links from
the checkout:

```bash
git clone <local-homerail-git-url> HomeRail
cd HomeRail
```

On Windows, use PowerShell directory symlinks when Developer Mode or
Administrator permissions allow them. If symlinks are blocked, use a junction
as the local fallback; repeat the junction for every `skills/homerail-*`
directory that should be installed:

```powershell
cmd /c mklink /J "%USERPROFILE%\.claude\skills\homerail-install-ops" "C:\path\to\HomeRail\skills\homerail-install-ops"
```

After installing or updating skills, ask the user to restart the AI agent session if their agent host only loads skills on startup.

After restart, route user requests to the root skills this way:

- Use `homerail-install-ops` for first install, update, service startup,
  provider configuration, and smoke verification. Codex invocation:
  `$homerail-install-ops`; Claude Code invocation: `/homerail-install-ops`.
- Use `homerail-dag-ops` for running DAGs, monitoring runs, checking handoffs,
  and writing DAG templates.
- Use `homerail-dag-patterns` for selecting, composing, instantiating, and
  validating built-in DAG design patterns.
- Use `homerail-cli` for command syntax, flags, and evidence commands.
- Use `homerail-shared` as background rules for all HomeRail operations.

## Deploy From Local Source

Run from the source root:

```bash
npm run install:all
npm run build
npm run typecheck
npm test
npm run ci
```

Prepare a local data root:

```bash
export HOMERAIL_HOME="${HOMERAIL_HOME:-$HOME/.homerail}"
```

Configure local runtime settings and credentials through the CLI:

```bash
node homerail_cli/dist/cli.js config
```

Start Manager and Node together:

```bash
node homerail_cli/dist/cli.js start
node homerail_cli/dist/cli.js start --rebuild-worker-image
node homerail_cli/dist/cli.js start --ui
node homerail_cli/dist/cli.js doctor
```

`hr start` uses the shared `HOMERAIL_HOME`, starts Manager if needed, applies
stored model config, builds `homerail-worker:latest` when missing, and starts a
Node with Docker capability when no configured Node is connected.
Use `--rebuild-worker-image` after Worker runtime changes so provisioned DAG
workers run the current checkout.
Use `--ui` or `node homerail_cli/dist/cli.js ui start` to start the decoupled
Agent UI. HTTPS is the default endpoint, `https://localhost:19192`, and HTTP is
kept as a fallback on `http://localhost:19193`.
If provider credentials are not configured yet, `hr start` should still bring
up Manager and Node; `hr doctor` reports the missing model or Manager Agent
runtime configuration and the agent should run `hr config` /
`hr model configure`.

Use `node homerail_cli/dist/cli.js runtime status|logs|stop` for service
inspection and cleanup. Use `node homerail_cli/dist/cli.js ui status|logs|stop`
for UI-only inspection and cleanup.

`hr doctor` is the first environment probe an agent needs for normal operation.
Do not supplement it with `ps`, `lsof`, `curl /health`, or source reading unless
the CLI output is insufficient for a concrete failure. It reports,
per line: manager reachability + URL, runtime state (connected nodes/workers,
active runs, node capabilities), node count, any active LLM model setting, and
the Manager Agent runtime/harness readiness.
A `HomeRail is ready.` trailer is the readiness gate; any `FAIL`/`WARN` line names
the exact next command to run (e.g. `hr model configure`).

`connected_workers: 0` is **expected** on an idle Manager. DAG Workers are
provisioned on demand by a Node into Docker containers when a run dispatches;
there is no standing worker to inspect or start by hand. `connected_nodes >= 1`
is what matters for DAGs to run.

The local harness deployment diagnosis DAG runs through the same Worker provisioning
path as normal DAGs. Do not start a fixed host Worker, mount the Docker socket
into a Worker, or use Docker-in-Docker for this test. The diagnosis run uses
its isolated workspace, clones the latest source, builds it, configures the
cloned CLI to talk to the outer Manager, and verifies `runtime status` /
`doctor`. Deployment diagnosis uses advisory scorecard enforcement; inspect
findings, but use terminal status and structured handoff evidence as the
deployment result.

## Configure Provider

For MiMo token-plan Claude Agent SDK compatibility:

```bash
node homerail_cli/dist/cli.js config
node homerail_cli/dist/cli.js config apply
node homerail_cli/dist/cli.js doctor
```

Do not put the key into repo files. The config flow stores secrets under
Manager's encrypted secret store. `${HOMERAIL_HOME}/secrets/env` is a legacy
plaintext import path only. Do not use MiMo ASR/API-billing endpoints for DAG
workers.

## Smoke Test

Run the public smoke DAG:

```bash
node homerail_cli/dist/cli.js smoke dag \
  --template assets/orchestrations/public-dev-5node.yaml.template
```

Then verify the configured Manager Agent harness can call Manager tools and
start a real run:

```bash
node homerail_cli/dist/cli.js smoke manager-agent
```

This is the live Manager Agent gate. It uses the saved Manager Agent config,
calls `/api/manager/chat`, requires a real `run_id`, and waits for the
deterministic two-node DAG to reach `completed`. Use `--setting-id`,
`--provider`, or `--model` when validating a specific Kimi Code or Claude
SDK-compatible runtime.

When it completes, inspect:

```bash
node homerail_cli/dist/cli.js dag quick <run_id> --events 30
node homerail_cli/dist/cli.js dag chats <run_id> --tools 10
node homerail_cli/dist/cli.js dag handoffs <run_id>
node homerail_cli/dist/cli.js scorecard <run_id>
node homerail_cli/dist/cli.js eval-run <run_id>
```

Do not treat an idle-looking process as success until terminal status, handoffs, scorecard, and eval-run are checked.

## Maintenance

- Keep installed skills as symlinks to the checkout. After skill edits, verify
  the target agent skill directory still points at `skills/homerail-*`; do not
  refresh by copying stale directories.
- Re-run `npm run build` after code changes.
- Run `node homerail_cli/dist/cli.js start`; add `--rebuild-worker-image` after Worker runtime changes.
- Keep Manager and Node on the same `HOMERAIL_HOME`.
- If Worker containers cannot connect back to Manager, set an explicit callback host through Manager worker WebSocket environment settings rather than hardcoding Docker bridge IPs.
