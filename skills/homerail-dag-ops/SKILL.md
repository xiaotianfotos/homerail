---
name: homerail-dag-ops
description: |
  Run, monitor, inspect, debug, and author HomeRail DAG workflows through the CLI or Manager Tools, including supervised multi-Actor runs with stable live Surfaces and later per-Actor follow-ups.
  Use when: (1) listing templates, (2) starting a DAG run, (3) supervising or watching a run,
  (4) inspecting chats, handoffs, scorecard, eval-run, or replay output,
  (5) creating multiple parallel UI panels that update while Actors work, (6) sending commands to waiting Actors,
  (7) injecting instructions into running nodes, or (8) creating custom DAG templates.
  For installing or starting Manager/Node/Worker services, use homerail-install-ops first.
---

# HomeRail DAG Operations (TypeScript Backend)

Before acting, apply `homerail-shared` rules. This skill assumes the local runtime
is already ready. If not, run `hr start` or use `homerail-install-ops`.

When this Skill is loaded inside the HomeRail Manager Agent, use the harness's
native shell and the HomeRail CLI whenever they provide the clearest or most
complete path. Prefer `--json` so command results remain structured. Dedicated
Manager Tools such as `list_orchestrations`, `create_and_run`, `invoke_run`, and
`get_run_status` are equivalent shorter paths for operations they already
cover; they are not the only valid execution route. For abstract pattern selection, load
`homerail-dag-patterns` and use either its Manager Tools or the corresponding
`hr patterns` commands before running the instantiated workflow.

## Supervised multi-Actor live panels

Use the concrete `assets/orchestrations/multi-actor-live-report.yaml.template`
Workflow only when the user wants three stable, independently grounded panels
for evidence research, skeptical analysis, and a screenshot-ready publication
draft. It explicitly declares digest-pinned Surface views,
`report_surface_state`, a three-Actor join, and `await_command`, so all three
Actors remain addressable after their first round.

Choose exactly three Actors when each panel remains useful by itself, each has
a non-overlapping responsibility, and the user benefits from later per-panel
follow-ups. Share one source identity and evidence boundary. Parallelize only
independent work. When analysis or publication must consume research output,
author explicit data edges or structured handoffs instead of using the bundled
parallel template unchanged. Use one Manager-owned Block for a simple answer or
single report, and never add Actors merely to make the task look sophisticated.

Inside the Manager Agent, start it with `start_supervised_dag` and the exact
`yamlPath`; pass the user's full objective as `prompt` and an available runtime
profile only when one is required. Do not substitute the abstract
`orchestrator-workers` pattern: that pattern performs dynamic fan-out and
verification but intentionally has no live Surface or follow-up contract.

Read [references/multi-actor-surfaces.md](references/multi-actor-surfaces.md)
before authoring another presentation-aware Workflow or handling a follow-up
that changes one or more Actor panels.

## Quick Path (runtime already ready)

When the install is already done and you only need to run a DAG, follow this
shortest path. Do not rebuild or re-install packages for a plain DAG run.

```bash
hr doctor                                              # sole readiness check
hr templates list                                      # pick a template
hr run <template> --prompt "<prompt per contract below>"
hr dag watch <run_id> --interval 10 --timeout 600      # wait for terminal state
hr dag handoffs <run_id> --content-limit 0             # authoritative output
```

Use `hr run <template> --profile <profile>` only for profiles embedded in that
template, such as `offline-deterministic`. For DB-backed runtime profiles, sync
the DAG/profile first and run by `--workflow`; otherwise an agent can pick a
profile id that the Manager cannot resolve.

Judge success only from terminal status + non-empty handoffs (see
"Judging Whether Output Is Useful" below). Re-build/install only after
changing source, not before every run.

## DAG Best Practices

One principle: establish shared facts first, split focused checks next, then
judge only from evidence.

### Do

- Start with one source of truth. Use a seed node or explicit prompt contract
  to provide code version, input parameters, external URLs, and evidence paths
  to every downstream node.
- Give each node one clear question: source cleanliness, build result, runtime
  health, data preservation, regression result, or advisory review.
- Make nodes inspect reality. If a task requires a command, file, API, or clone,
  the node should execute or read it rather than restating the prompt.
- Require structured handoff. Each useful node output should include conclusion,
  evidence, gaps, blockers, and a concrete next step when blocked.
- Keep fan-in nodes as judges. They summarize and decide from upstream handoffs
  and evidence; they should not silently redo or invent missing checks.
- Separate hard gates from advisory review. A hard gate failure blocks the run;
  advisory output can highlight risk but cannot replace evidence.
- Treat environment differences as normal. Host, container, local, remote, and
  CI may have different paths, network reachability, credentials, and tools.
- Keep disruptive host actions outside the DAG unless explicitly isolated.
  Deploying, migrating, and restarting services can invalidate the runtime
  executing the DAG.
- Record baselines before upgrade or migration checks. User data, settings,
  projects, sessions, secrets, and model providers need before/after evidence.
- Preserve evidence so the result is auditable: what was checked, what command
  ran, what returned, and why the run passed or blocked.
- Use smoke runs to test wiring and real model-backed tasks to test capability.
- Use URLs, paths, and credentials that the executing node can actually access.
  Validate from the container's point of view when the worker runs in Docker.

### Do Not

- Do not let nodes use different versions or inputs. If facts diverge, fan-in
  conclusions are not meaningful.
- Do not use vague natural language as the node-to-node protocol. Pass
  structured fields instead of relying on chat interpretation.
- Do not overload one node with unrelated responsibilities; mixed failures are
  hard to diagnose.
- Do not count a node with no handoff as success. Missing output is missing
  evidence.
- Do not auto-fill handoffs and then call the run clean. Auto-fill only proves
  the node failed its output contract.
- Do not let fan-in guess through missing evidence. Block explicitly when a
  hard gate lacks proof.
- Do not treat a quick smoke as complete validation. Smoke proves the path can
  run, not that the requested work is good.
- Do not assume host access equals container access. Local paths, SSH keys,
  known_hosts, Docker sockets, and private remotes often differ.
- Do not save only the final verdict. Without process evidence, the verdict is
  not reviewable.
- Do not hide uncertainty. Unchecked, unreachable, permission denied, and
  insufficient-evidence states should appear in the result.
- Do not hardcode tokens, private hosts, personal paths, or temporary staging
  directories in reusable templates. Pass them through runtime parameters or
  environment configuration.

### Quick Checklist

- Is there one shared source of truth?
- Does each node answer one focused question?
- Does every required node produce structured handoff?
- Does fan-in decide only from handoffs and evidence?
- Are hard gates and advisory checks separated?
- Are smoke and real validation separated?
- Were network, path, and permission assumptions checked from the executing
  node's environment?
- If the run fails, is the next step obvious?

## Running a Simple DAG

Check runtime readiness:

```bash
hr doctor
```

List templates and start a run:

```bash
hr templates list
hr run assets/orchestrations/public-two-node.yaml.template \
  --prompt "Draft a short release checklist"
```

For reusable DAGs, sync the asset into the Manager database first. Treat
`workflow_id` as the stable identity: AI edits may change prompts, nodes, and
edges, but must not change `workflow_id` unless intentionally creating a new
workflow/version.

```bash
hr dag sync assets/orchestrations/public-dev-5node.yaml.template
hr profile sync assets/profiles/example-runtime.profile.yaml.template \
  --workflow public-dev-5node-template
hr run \
  --workflow public-dev-5node-template \
  --profile example-runtime \
  --prompt "Draft a short release checklist"
```

Profile YAML references DB `model_alias` or `llm_setting_id`; it must not write
provider/model/key/base_url as executable runtime configuration.

For read-only deployment diagnosis with a configured DB LLM setting, use the single-node template:

```bash
hr run assets/orchestrations/local-harness-cli-deploy-diagnosis.yaml.template \
  --prompt "source_repo_url=<https git url> branch=main"
```

This template must run through the normal Node-provisioned Worker path. Do not
use a fixed host Worker, Docker socket mounts, or Docker-in-Docker. The
template's deployment proof uses the run's isolated workspace, clones the
source, builds it, configures the cloned CLI to talk to the outer Manager, and
then verifies `runtime status` and `doctor`. This template uses advisory
scorecard enforcement: scorecard findings are useful review evidence, but
deployment success is determined by terminal DAG state plus the structured
handoff and CLI evidence.

## Template Prompt Contracts (read before `hr run`)

A DAG Worker runs inside an isolated Docker workspace. It **cannot** see your
host filesystem — no `/Users/...`, no `/Volumes/...`, no host repo checkout. So
the `--prompt` must carry everything a node needs to reach its inputs:

- **Repo-access templates** (any template whose agent system prompt says
  "git clone/fetch the repo", "inspect the PR", "review the diff", etc.,
  including `local-harness-cli-deploy-diagnosis` and any PR-review family templates) **require**
  a cloneable git URL in the prompt:
  `--prompt "source_repo_url=<https or ssh git url> branch=<branch>"`.
  A host-local path like `/Volumes/.../HomeRail` will fail inside the container —
  every reviewer node will hand off `WARN: repository not accessible` and the
  run produces no review. Use the Gitea/GitHub remote URL, not a local path.
- **Self-contained templates** (e.g. `public-two-node`, `public-dev-5node`)
  only need the task text in `--prompt`; they do not clone anything.

If unsure whether a template needs a repo URL, `grep` the template YAML for
`clone|repo|PR|git` in agent `system:` blocks. If present, supply
`source_repo_url=`. A correct prompt avoids a 2-minute run that ends in
all-`WARN` handoffs.

Copy the returned `run_id`, then supervise:

```bash
hr dag supervise <run_id>
hr dag watch <run_id> --interval 5 --timeout 600
```

## Agent Monitoring Ladder

Use this order before claiming a run result:

```bash
hr dag quick <run_id> --events 30
hr dag chats <run_id> --tools 10
hr dag chats <run_id> --tools 10 --raw-tools
hr dag handoffs <run_id>
hr scorecard <run_id>
hr eval-run <run_id>
```

If `quick` looks stale or ambiguous, use `chats` before concluding that no progress happened. If a command shows idle but a `run_id` exists, do not equate idle with completion; verify terminal state and handoffs.
Use `dag chats --raw-tools` when auditing whether a DAG agent actually used the
HomeRail CLI, avoided Write/Edit/MultiEdit, or bypassed the CLI with direct API
calls. The raw tool view is redacted and should be used together with handoffs,
scorecard, and eval-run before claiming a CLI-first run is clean.
Only inspect Worker raw audit files locally for deep debugging. New Worker tool
audit files are run-scoped at `${HOMERAIL_HOME}/audit/tool-events/<run_id>.jsonl`;
legacy installs may still contain a global `${HOMERAIL_HOME}/audit/tool-events.jsonl`.
If `scorecard` reports advisory findings, separate policy/prompt issues from
actual DAG failure before deciding whether to rerun or patch.

## Judging Whether Output Is Useful

A `completed` run with a passing scorecard only proves the **pipeline** worked,
not that the **work product** is useful. Before reporting results, read the
handoff content (`hr dag handoffs <run_id> --content-limit 0`) and check for
these hollow-output signals — if present, the run succeeded mechanically but
produced no real result, and the fix is the prompt/inputs, not the code:

- Any handoff `verdict` of `WARN`/`FAIL` citing `not accessible`,
  `inspection incomplete`, `repository ... does not exist`, or `cannot clone`.
- Handoff content shorter than the task expects, or a review/summary that
  describes what it *couldn't* do rather than what it found.
- A reviewer falling back to inspecting `/app` (the Worker container itself)
  instead of the intended target — this means it never reached its inputs.

A run in this state means the template prompt contract was not met (most often
a missing `source_repo_url=`). Re-run with the correct prompt; do not treat the
hollow output as a code defect.

To correct a running node, prefer inbox injection:

```bash
hr inject <run_id> <node_id> "Correction or additional instruction" --mode inbox
```

Use `replay` after terminal failure:

```bash
hr replay <run_id>
```

## Public Assets Boundary

The following assets are part of the public interface:

```
skills/
  homerail-shared/       # Common service, security, provider, and local-source rules
  homerail-install-ops/  # Local-source install, service startup, maintenance, smoke
  homerail-cli/          # CLI command reference
  homerail-dag-ops/      # DAG run, monitor, inspect, and author operations
  homerail-dag-patterns/ # DAG pattern selection, composition, and instantiation

assets/
  orchestrations/    # Public example DAG template YAML files
    public-*.yaml.template
    local-harness-cli-deploy-diagnosis.yaml.template
  profiles/          # Public example runtime profile YAML templates
```

Rules for public DAG templates and agents:

- Use only public component names: `homerail-manager`, `homerail-node`, `homerail_worker`.
- Do not assume `assets/agents`, `assets/prompts`, or `assets/skills` exists.
  Current public templates keep prompts inline or in checked template/profile
  assets.
- Do not treat every local `assets/orchestrations/*.yaml.template` as public.
  Internal release gates, staging-only templates, and private checks must stay
  out of public export and reusable user instructions.
- Use the CLI config flow for Manager address and credentials. `--base-url` and
  `HOMERAIL_MANAGER_URL` remain per-command overrides; `HOMERAIL_MANAGER_PORT`
  controls the local-service default port.
- Do not reference internal-only paths, internal hostnames, or legacy runtimes.
- The CLI default base URL is `http://localhost:19191` (TS Manager port).

## Self-Dev Architecture Boundary

When a DAG is used to change HomeRail itself, the first implementation handoff
must classify the correct product layer before editing code:

```text
Layer Decision:
- Problem layer:
- Preferred fix layer:
- Manager touched: yes/no
- Manager Change Justification: <allowed category or n/a>
- Rejected shortcuts:
- Public entry path:
- Validation path:
```

Allowed Manager categories are limited to:

- run/node/edge/handoff/event lifecycle management.
- Node/Worker registration, scheduling, provisioning, cleanup, and runtime status.
- Persisted run evidence needed by chats, handoffs, usage, scorecard, or eval.
- Public provider, asset catalog, settings, and validation surfaces.
- Stable inspection/mutation APIs used by CLI or Agent UI.

If no allowed category applies, return `DESIGN_BLOCKED` and describe the missing
CLI, skill, DAG contract, install path, or documentation work. Do not add
Manager routes, fake state, deterministic runs, empty successful defaults,
compatibility aliases, embedded DAG YAML, hardcoded issue IDs, or private
shortcuts only to make a smoke, UI, or scorecard pass.

Before accepting a self-dev DAG result, run:

```bash
npm run ci
```

For intentionally broad Manager changes, set `HOMERAIL_BOUNDARY_SCAN_STRICT=1` and
provide `HOMERAIL_MANAGER_CHANGE_JUSTIFICATION` during local review so the
justification is explicit.

## Creating a Custom DAG Template

Create a new YAML file in `assets/orchestrations/`:

```yaml
name: my-linear-pipeline
description: "A simple three-step linear pipeline"

agents:
  researcher:
    system: |
      Research the given topic.
      Call handoff(port="done", content=findings).

  writer:
    system: |
      Write a document based on the research.
      Call handoff(port="done", content=document).

  reviewer:
    system: |
      Review the document for quality.
      Call handoff(port="approved", content=review) if good.
      Call handoff(port="needs-work", content=feedback) otherwise.

nodes:
  research:
    name: "Research"
    agent: researcher
    after: []
    outputs:
      done:
        to: "write.in:data"

  write:
    name: "Write"
    agent: writer
    after: [research]
    outputs:
      done:
        to: "review.in:document"

  review:
    name: "Review"
    agent: reviewer
    after: [write]
    outputs:
      approved:
        to: ""
      needs-work:
        to: "write.in:feedback"
```

Supported public backend names include `claude-sdk`, `kimi-code`,
`kimi_code`, `codex_appserver`, and `deterministic`.
Do not use `direct-llm` or Chat Completions for Coding Plan / Agent Plan
accounts. Kimi should use the Kimi Code CLI harness (`kimi-code`); other
Coding Plan providers should use the Claude Code compatible harness
(`claude-sdk`) with an Anthropic-compatible endpoint.
Prefer hyphenated names in new YAML (`kimi-code`) unless you are preserving an
older template.

Restart the Manager if templates are loaded at startup.

Run the new template:

```bash
hr run assets/orchestrations/my-linear-pipeline.yaml --prompt "Research TypeScript best practices"
hr dag supervise <run_id>
```
