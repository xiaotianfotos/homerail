# Manager Agent Eval

A behavioral eval set for the Manager Agent — the component that converts a
user request into real Manager actions (start a DAG, query status, list
assets, or ask for clarification).

## Why

`hr smoke manager-agent` verifies the happy path with an explicit yamlPath in
the prompt. It cannot answer the question that matters for trust: *given a
natural user request, does the agent take the right kind of action?* This eval
scores exactly that, across four categories:

| Category | Cases | Expected behavior |
| --- | --- | --- |
| `task` | a1–a4 | Concrete deliverable requested → pick a template, `create_and_run`, return a real run id |
| `status` | b1–b2 | Status question → query, never start a new run |
| `clarify` | c1–c3 | Vague or destructive request → ask / refuse, never start a run |
| `assets` | d1–d3 | Asset question → `list_orchestrations` / `list_projects`, no run |

## Run

Requires a running Manager (`hr start`) with a working Manager Agent
(`hr doctor` all green).

```bash
node evals/manager-agent/run-eval.mjs                 # all cases
node evals/manager-agent/run-eval.mjs --only a3-snake-smoke
node evals/manager-agent/run-eval.mjs --json report.json
```

Each case is one fresh `/api/manager/chat` turn scored on
`expect_run` / `must_call` / `must_not_call` (tool names are normalized across
harness prefixes, e.g. `mcp__dag-tools__create_and_run`). Runs started by
`task` cases are cancelled afterwards; the eval scores planning behavior, not
DAG output.

## Results log

| Date | Config | task | status | clarify | assets | Total | Report |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-07-11 | local-anthropic/claude-opus-4-7, container placement, pre-fix | 0/4 | 2/2 | 3/3 | 3/3 | 8/12 | `baseline-local-opus47.json` |
| 2026-07-11 | + `list_orchestrations` catalog fallback | 0/4 | 2/2 | 3/3 | 3/3 | 8/12 | `after-fix-local-opus47.json` |
| 2026-07-11 | + system prompt: templates are generic pipelines | 4/4 | 2/2 | 3/3 | 3/3 | **12/12** | `after-fix2-local-opus47.json` |

Two defects found and fixed through this eval:

1. **Container placement broke template discovery.** The Manager Agent
   container does not mount the repo, so `list_orchestrations` (filesystem
   read) always returned an empty list. Fix: fall back to the Manager's
   `/api/manage/orchestrations` catalog when the workspace has no templates
   (`homerail_worker/src/manager-agent/server.ts`).
2. **The system prompt implied templates are task-specific.** Given "run a
   snake smoke test", the agent concluded "no snake template exists" and
   refused. Fix: the prompt now states templates are generic pipelines, the
   task travels in `create_and_run`'s `prompt` argument, and a
   deliverable-shaped request should start a run
   (`homerail_protocol/src/manager-agent-prompt.ts`).

## Notes

- Cases run against the live configured provider; results vary by model.
  Log new rows with the config used rather than overwriting old reports.
- `defaults.timeout_sec` in `cases.yaml` bounds each turn.
- When adding cases, keep the four-category balance: the `task` rows guard
  against under-acting, `status`/`clarify` rows guard against over-acting —
  a prompt change that fixes one side can regress the other.
