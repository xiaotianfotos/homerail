# E2E Fix: recovering a pre-dispatch configuration failure

E2E Fix remains experimental. This recovery handles a narrow failure: the
Manager rejects an agent runtime configuration before the root's first Worker
dispatch. It does not retry an uncertain model request or revive arbitrary
failed/cancelled workflows.

When admitting a workflow containing durable commands, the Manager resolves all
agent and advisor runtime profiles before executing a command. This catches an
unsupported local model reasoning effort before a host Planner spends tokens.
Configuration can still change after admission; dispatch validates it again.

For an eligible late failure, the Manager atomically retains the pre-failure
graph snapshot and failed-state digest. Completed native command receipts must
still verify. Recovery rejects any Worker lease history, provisioning, dispatch,
handoff, chat or usage evidence, outstanding/previous actor commands, and
unconsumed or uncertain native commands. Zero reported usage is insufficient.

Inspect with `GET /api/runs/{run_id}/pre-dispatch-recovery`. Then send the returned
`expected_state_sha256` to the same endpoint with POST:

```json
{
  "request_id": "remove-unsupported-effort-1",
  "expected_state_sha256": "<digest returned by GET>",
  "clear_reasoning_effort_for": ["fixer", "reviewer_a", "reviewer_b", "reviewer_c"],
  "reason": "This custom model has no selectable reasoning efforts"
}
```

Use the same Manager mutation authentication as other run-control endpoints.
This first version only removes an explicit DeepSeek Harness reasoning effort;
it cannot change the model, backend, graph, plan, policy or completion criteria.
All downstream roles must pass preflight after the correction.

The transaction restores the original round and graph snapshot, retains all
completed nodes and counters, reopens only never-leased actors, creates a fresh
failed-node session, and records an immutable recovery receipt before dispatch.
Submitting the identical request returns that receipt without another tick;
another request or stale digest conflicts. A Manager restart after commit can
recover the active root through normal cold recovery. Each root permits one
such configuration recovery.

Creation time and round expiry are preserved. This does not add a general
per-dispatch task deadline or token-budget guard: E2E Fix's frozen trusted stages
still enforce their original task deadline. Whole-graph recovery, unknown model
requests, exhausted budgets and guaranteed semantic convergence remain separate
work.

Older failures have no executor checkpoint and are rejected by this API. An
operator-only program migration supports the precise legacy “does not declare
selectable reasoning efforts” failure: it requires the original resolver error,
no Worker execution evidence, verified completed commands, and an exact
reconstruction of the failed graph and mailboxes from recorded handoffs. It
does not execute any handoff-producing process or fabricate a model result.

Verification: `npm --prefix homerail_manager test -- tests/dag-dispatch-recovery.test.ts`.
The suite executes an actual Planner fixture command once, interrupts between
recovery commit and dispatch, checks fresh-session dispatch, injects transaction
failure, and rejects stale requests, partial profile correction, changed command
logs, legacy mailbox divergence and completed/cancelled roots. This proves the
recovery contract, not a successful real issue-to-PR run.
