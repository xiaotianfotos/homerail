# HomeRail self-development boundary

Read only when the task changes HomeRail itself.

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
