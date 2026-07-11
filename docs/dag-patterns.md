# DAG Pattern Library

HomeRail's pattern library separates reusable orchestration knowledge into four
layers. A pattern describes a control-flow invariant; it is not tied to one
model, provider, repository, or task prompt.

## Four Layers

1. **Runtime primitives**: nodes, typed handoffs, terminal edges, condition and
   finite-loop gateways, `join_gateway`, `while_gateway`, and bounded feedback
   edges.
2. **Abstract patterns**: parameterized, provider-independent workflow
   definitions built into Manager.
3. **Skill guidance**: selection, adaptation, composition, and validation rules
   in `skills/homerail-dag-patterns/SKILL.md`.
4. **Concrete instances**: task-specific YAML with prompts and runtime profiles,
   such as `pattern-quorum-offline.yaml` and
   `pattern-ratchet-exhaustion-offline.yaml`.

The Manager catalog is the source of truth for abstract definitions. Skills and
concrete instances reference the catalog instead of duplicating it.

## Runtime Primitives

### Join Gateway

`join_gateway` waits for its normal `after` dependencies, collects all input
mailboxes, and emits one aggregate payload. Configure:

- `mode`: `all`, `any`, or `n_of_m`.
- `field`: optional dotted field read from each input.
- `success_values`: values counted as successful.
- `threshold`: required count for `n_of_m`.
- `passed_port` and `failed_port`: output names; defaults are `passed` and
  `failed`.

The aggregate payload includes `total`, `successes`, `failures`, `threshold`,
`passed`, and the original `values`. It does not cancel slow upstream work or
finish early; use it when every declared dependency must report.

### Finite Loop Gateway

`loop_gateway` can set `result_port` to collect one result from each finite-loop
iteration. Its terminal `done` payload contains the ordered `results` array, so
downstream reporters and AI agents receive evidence from every item rather than
only a completion count.

### While Gateway

`while_gateway` evaluates the latest feedback value before each attempt.

Configure:

- `field`: optional dotted field containing the metric or status.
- `operator`: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `truthy`, or `falsy`.
- `value`: expected value for comparison operators.
- `max_iterations`: maximum number of continue passes.
- `continue_port`, `done_port`, and `exhausted_port`.

The feedback edge must return directly to the while gateway. Add
`retry_policy.max_retries` to that edge so the local feedback bound is explicit
in addition to the run-wide traversal limit.

## Built-in Patterns

| Pattern | Invariant |
| --- | --- |
| `heartbeat` | Cheap quiet exit, one selected action, independent verdict. |
| `orchestrator-workers` | One planner, independent workers, aggregate, fresh verifier. |
| `budget-gate` | Explicit budget admission before expensive work. |
| `trust-ledger` | Autonomy is granted per recurring skill from measured history. |
| `standing-goal-sentinel` | Completed goals become repeatedly checked invariants. |
| `quorum` | Independent n-of-m agreement before action. |
| `sparring` | Breaker, builder, and verifier remain separate. |
| `ratchet` | Bounded measured attempts until a target or exhaustion. |
| `compost` | Repeated failures become bounded proposals behind human review. |

List and inspect the live catalog:

```bash
hr patterns list
hr --json patterns show quorum
```

Instantiate without changing Manager state:

```bash
hr patterns instantiate quorum \
  --set workflow_id=release-quorum \
  --set threshold=2 \
  --output /tmp/release-quorum.yaml
```

Add `--sync` only after reviewing the generated YAML. Runtime model selection
still comes from HomeRail database settings and profiles.

The same operations are available to AI clients through:

- `GET /api/dag/patterns`
- `GET /api/dag/patterns/:id`
- `POST /api/dag/patterns/:id/instantiate`

The HomeRail Manager Agent receives all Skill metadata discovered under
`${HOMERAIL_HOME}/skills` on every turn. For pattern work it loads
`homerail-dag-patterns` through `read_skill`, then uses
`list_dag_patterns`, `get_dag_pattern`, `instantiate_dag_pattern`, and
`create_and_run`. This works identically for host Codex, host-shell, and
container Manager Agent runtimes; it does not depend on the native Codex or
Claude skill search path.

Instantiation validates parameter types, rejects unknown parameters, preserves
numeric and boolean values, substitutes all placeholders, parses the generated
YAML, and validates the resulting graph before returning it.

## External State Boundaries

Some patterns need state or triggers outside the DAG graph. Schedules, cost
records, trust history, standing-goal ledgers, and human approvals remain
explicit inputs or surrounding services. The pattern encodes how that evidence
is routed; it does not claim that a DAG alone provides a cron scheduler, billing
source, durable policy database, or interactive human pause.

## Inspiration

This library is inspired by Avid's article
[How to Build An Agentic OS using Fable 5 (Builder's Guide)](https://x.com/i/status/2074169173178212621).
HomeRail adapts the article's orchestration ideas into generic DAG primitives
and provider-independent patterns; it does not copy the article's model,
pricing, shell, or cron assumptions.
