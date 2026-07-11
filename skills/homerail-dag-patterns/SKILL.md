---
name: homerail-dag-patterns
description: |
  Select, inspect, instantiate, adapt, and validate HomeRail's built-in DAG design patterns.
  Use when an agent needs to design a reusable workflow for periodic triage, planner/worker fan-out,
  budget admission, graduated trust, standing-goal verification, quorum decisions, adversarial
  builder/breaker review, monotonic improvement, or evidence-driven process evolution. Also use
  when deciding whether a workflow needs condition, loop, join, or while gateway semantics.
---

# HomeRail DAG Patterns

Treat a pattern as an abstract control-flow invariant, not a finished task
template. Read the live Manager catalog before choosing one; it is the source of
truth for parameters and generated topology.

## Manager Agent Native Path

When running as the HomeRail Manager Agent, use Manager tools rather than shell,
`curl`, or the `hr` binary:

1. Call `list_dag_patterns` and compare `typical_uses`, `avoid_when`, required
   primitives, and parameters.
2. Call `get_dag_pattern` for the best candidate before changing Manager state.
3. Call `instantiate_dag_pattern` with a stable `workflow_id`, task-specific
   name, and typed parameters. Keep its default `sync=true` only after the
   selection is justified.
4. Call `create_and_run` with the returned `workflow_id`, an available runtime
   profile when needed, and a prompt containing task inputs and boundaries.
5. Use `get_run_status` for progress. Never claim the DAG started without the
   real run id returned by `create_and_run`.

When adapting a pattern or authoring a custom workflow instead of using the
generated instance unchanged:

1. Call `get_dag_schema`; do not rely on a remembered WorkflowSpec shape.
2. Emit `api_version: homerail.ai/v1` with explicit top-level edges and terminal
   nodes.
3. Call `validate_dag_workflow` and repair every structured diagnostic.
4. Call `sync_dag_workflow` only after validation returns `valid: true`.
5. Use the returned workflow revision and canonical hash as provenance.

For a simple one-step or linear task, do not force a pattern. Use an existing
concrete orchestration or ask for the missing execution boundary.

## Select a Pattern

```bash
hr doctor
hr --json patterns list
hr --json patterns show <pattern-id>
```

Choose from constraints, not keyword similarity:

- `heartbeat`: periodic work needs a cheap quiet exit, one selected action, and
  an independent verdict.
- `orchestrator-workers`: one planner can split independent work that must
  aggregate before verification.
- `budget-gate`: measured usage must admit or stop work before execution.
- `trust-ledger`: autonomy varies per recurring skill based on measured history.
- `standing-goal-sentinel`: previously satisfied goals must be re-verified as
  standing invariants.
- `quorum`: expensive or risky action requires independent n-of-m agreement.
- `sparring`: a breaker, builder, and fresh verifier must remain separate.
- `ratchet`: one metric should improve through bounded attempts until a target.
- `compost`: repeated failures should produce a bounded set of proposals that
  remain behind human review.

Do not choose a pattern when the catalog's `avoid_when` conditions apply. A
small linear DAG is better than a pattern whose invariant is unnecessary.

## Instantiate and Adapt

Generate YAML without syncing it first:

```bash
hr patterns instantiate quorum \
  --set workflow_id=release-decision \
  --set threshold=2 \
  --output /tmp/release-decision.yaml
```

Adapt role names, prompts, evidence fields, and terminal actions to the task.
Preserve the invariant that made the pattern useful:

- Keep voters independent in `quorum`.
- Keep planner, workers, and verifier distinct in `orchestrator-workers`.
- Keep breaker, builder, and verifier distinct in `sparring`.
- Keep `ratchet` bounded and metric-driven.
- Keep policy changes behind review in `compost`.
- Keep the quiet path cheaper than the action path in `heartbeat`.

Do not put provider, model, API key, or base URL fields in generated workflow
YAML. Bind models through HomeRail database settings and runtime profiles.

Pattern instances are strict WorkflowSpec v1 documents. Keep the
`api_version`/`kind`/`metadata`/`spec` envelope, named port contracts, top-level
`spec.edges`, and explicit terminal outcomes when adapting them.

## Compose Patterns

Compose only at explicit boundaries. Common combinations:

- Put `budget-gate` or `quorum` before an expensive `orchestrator-workers`
  subgraph.
- Put `trust-ledger` after independent verification, not before execution alone.
- Run `standing-goal-sentinel` as a heartbeat action, but keep detection and
  repair as separate runs.
- Feed failed runs and violated goals into `compost`; never let Compost apply
  its own policy proposals.

When combining patterns, retain one structured handoff contract at each
boundary. Avoid nested planners, duplicated verifiers, and loops without one
clear stop predicate.

## Use Gateway Semantics Correctly

- `condition`: route one structured value by field and exact case.
- `foreach`: iterate a finite item list and emit `done` after the last item;
  set `result_port` to include every ordered iteration result in the final payload.
- `join`: aggregate all arrived inputs using `all`, `any`, or `n_of_m`;
  configure `field`, `success_values`, and threshold explicitly.
- `while`: compare the latest feedback value, emit `continue` while
  unmatched, and emit `exhausted` after `max_iterations`.
- A `kind: feedback` edge must declare `max_traversals` independently of the
  run-wide edge limit.
- `terminal` declares `outcome: success | failure | cancelled` and never calls
  a model.

Data edges imply completion dependencies. Use `depends_on` only for a
control-only barrier that carries no payload. Join nodes wait for all declared
inputs before aggregating. Feedback edges must return directly to a `foreach`
or `while` node and remain statically bounded.

## Validate Before Running

Inspect generated YAML, then sync and run it only when its task-specific prompts
and runtime profile are complete:

```bash
hr dag schema
hr --json dag validate /tmp/release-decision.yaml
hr dag sync /tmp/release-decision.yaml
hr profile sync <profile.yaml> --workflow release-decision
hr run --workflow release-decision --profile <profile-id> --prompt "<task>"
hr dag watch <run-id> --timeout 600
hr dag handoffs <run-id> --content-limit 0
```

Require all of the following before calling the adaptation useful:

- `hr patterns instantiate` reports a valid graph.
- The YAML contains pattern id, version, source, and resolved parameters.
- Every branch reaches an explicit terminal node, possibly through a bounded
  feedback edge.
- Sync returns the expected immutable revision and canonical hash.
- A deterministic or fake-dispatch test exercises the topology.
- A real model-backed run exercises task semantics before production use.
- Terminal status and non-empty handoffs support the claimed result.
