# DAG Pattern Library

HomeRail's pattern library separates reusable orchestration knowledge into four
layers. A pattern describes a control-flow invariant; it is not tied to one
model, provider, repository, or task prompt.

## Four Layers

1. **Runtime primitives**: typed handoffs, terminal edges, condition/loop/join/
   while gateways, deterministic commands, durable approvals, transactional
   state, bounded dynamic fan-out, advisor calls, workspace policies, and
   Manager-owned triggers.
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

### Deterministic Command

`kind: command` executes an argument vector without a shell. The executable
must be present in `HOMERAIL_DAG_COMMAND_ALLOWLIST`; timeout, output capture,
exit codes, optional stdin, and JSON/number parsing are explicit. Use command
nodes for checks, metric measurement, and compensation. The default allowlist
is empty because commands run in the Manager host trust boundary. A dynamic
`command_field` additionally requires `HOMERAIL_DAG_ALLOW_DYNAMIC_COMMANDS=true`.
When a command node has multiple input ports, `config.input` selects the
authoritative port used by `command_field` and `stdin_field`; other inputs can
act as deterministic readiness gates without being able to replace the command.
Command nodes do not run inside a provisioned Node or agent workspace. A metric
or rollback that must observe worker filesystem changes therefore needs an
external target reachable from Manager, or a future explicit command execution
target; do not assume Manager and a remote Node share a filesystem.

### Durable Approval

`kind: approval` persists the exact proposal and its SHA-256 hash, enters
`WAITING_FOR_APPROVAL`, and survives Manager restart. Approval requires an
authorized actor and matching proposal hash. The workflow must declare a
`proposer_actor`; that actor cannot also be authorized to decide, and the
persistence boundary rejects matching proposer/approver identities. Approved
and rejected rows are immutable for the same run and node. Manager Agent may
list pending approvals but cannot decide them. Decisions are accepted only from
loopback clients, or with `HOMERAIL_DAG_APPROVAL_TOKEN` when Manager is remote.
The actor value remains an audited identity asserted by that trusted client;
the shared token is not per-actor authentication.

### Transactional State And Triggers

`kind: state` provides namespaced versioned records with history. Workflow
`spec.triggers` supports persisted interval and idempotent event delivery with
overlap and concurrency policies. Remote DAG writes require
`HOMERAIL_DAG_MUTATION_TOKEN`, including run lifecycle operations, workflow and
profile sync, state changes, event delivery, injection, and dynamic graph
changes; loopback remains the default local trust boundary. `budget_admit`
requires a positive requested amount and atomically
reserves it only when `spent + requested <= limit`, so concurrent runs cannot
all pass from the same stale ledger read. The reservation is a declared upper
bound, not provider-side enforcement of actual model spend.

### Dynamic Fan-out

`kind: fanout` expands a bounded item array into run-local worker nodes. It
enforces item and parallelism limits, all/any/n-of-m completion, optional early
cancellation, and result isolation without mutating the workflow revision.
`item_field` selects the per-worker array, while optional `context_field`
selects immutable shared context copied to every worker envelope and to the
aggregate result for canonical verification. Optional `result_contract`
validates each dynamic worker's `result` handoff before it can count toward the
completion threshold.

### Advisor And Workspace Policy

Agent nodes can declare bounded `advisors`. `consult_advisor` returns advice to
the same executor turn and audits identity, request, response, usage, timeout,
and call count. Worker content, stream events, errors, transcripts, audit
records, Manager Agent tool evidence, advisor events, and deterministic command
telemetry pass through the shared protocol redactor before evidence transport or
persistence. Authoritative DAG handoffs and resumable `session.json` state remain
exact so recovery cannot change behavior; they are private runtime state, not
telemetry, and must not be used to carry credentials. `workspace_access` delays
handoff until
final file snapshots show that readonly artifacts and write scopes were
respected inside the workspace root. It does not observe writes outside that
root or a protected file changed and restored before the final snapshot;
OS-level containment remains the responsibility of the selected agent backend
or container sandbox.

Manager-to-Node and Manager-to-Worker WebSocket transport is trusted-network
transport in this release. Multi-host deployments must provide network-layer
isolation or a TLS-authenticated reverse proxy until native `wss` authentication
is implemented.

The self-hosted catalog validation uses an operator-configured Qwen 3.6 service
through its Anthropic-compatible endpoint and the HomeRail `claude-sdk`
adapter. Machine-specific endpoints and storage paths are supplied through CI
secrets rather than committed to the repository. The runner checks that
`qwen3.6` is listed before starting the catalog and can wake the model host when
explicitly enabled.

`workspace.mode: shared` provisions separate workers against the same
run-scoped `${HOMERAIL_HOME}/workspace/<run-id>` directory. This enables
breaker/builder/verifier and iterative improvement patterns without exposing a
host-global workspace; per-node `workspace_access` rules and immutable-file
hashes still apply.

## Built-in Patterns

| Pattern | Invariant |
| --- | --- |
| `heartbeat` | Cheap quiet exit, one selected action, independent verdict. |
| `orchestrator-workers` | One planner, independent workers, aggregate, fresh verifier. |
| `executor-advisor` | One executor retains context and consults a bounded advisor only at ambiguity boundaries. |
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

The Ratchet reference topology sends the while gateway's previous measurement
and the independent remeasurement into an explicit join. A deterministic
command compares that adjacent pair before feedback is allowed. The improver
preserves measurement and rollback commands, but it cannot declare or rewrite
the baseline used by the monotonic gate.

## Runtime State Boundaries

Manager owns schedules, event-delivery idempotency, budget/trust/goal state,
and approval decisions. External systems still own measured facts such as
model pricing, repository tests, deployment APIs, and actor authentication.
Feed those facts through deterministic commands or event payloads.

```bash
hr dag approvals
hr dag decide <run-id> <node-id> --decision approved --actor <id> --proposal-hash <sha256>
hr dag triggers
hr dag trigger-event <event> --idempotency-key <key> --payload '<json>'
hr dag state-get <namespace> <key>
hr dag state-set <namespace> <key> '<json>' --expected-version <n>
```

## Inspiration

This library is inspired by Avid's article
[How to Build An Agentic OS using Fable 5 (Builder's Guide)](https://x.com/i/status/2074169173178212621).
HomeRail adapts the article's orchestration ideas into generic DAG primitives
and provider-independent patterns; it does not copy the article's model,
pricing, shell, or cron assumptions.
