# Auto Fix + Jev (experimental)

`auto-fix-jev` is a separately selected Auto Fix v2 template. It adds factual
advice before a repair, with a verifiable call receipt. Selecting the existing
`auto-fix` or `auto-fix-v2` workflow never calls Jev. No automatic trigger or
formal PR-review voter is changed.

The inherited flow is implementation → integration → full review → bounded
repair/review loop → two clean confirmations → `ready_for_ci`. Only the fixer
receives the additional `typesafe/system_one` capability. It inspects source,
asks focused questions, checks uncertain or disputed premises with a probe,
then performs the ordinary repair. Jev cannot remove findings, waive tests,
declare a PR approved, or change review convergence. A clean initial candidate
does not need a fixer and therefore makes no Jev request.

This uses [Choice, Score and Noul](https://docs.typesafe.ai/primitives) as typed
advisory outputs. Ask narrow factual questions with explicit evidence fields;
do not ask Jev to prove an entire patch correct. Independent questions sharing
one state should be batched. Its [known limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
include multi-step indirection and adversarial framing.

## Configure and select

Use a Manager build containing `typesafe-broker.ts`. Follow the
[Auto Fix v2 runbook](auto-fix-v2.md) for Docker Workers, the existing
`github-autofix` credential, a same-repository Draft PR, and immutable task,
task-plan and PR-context files. This variant uses those same inputs and the
same coding harnesses; it does not accept an arbitrary unprepared PR number.

Store the Jev key through the existing encrypted credential API. The shell
variable is used only as the input to that command, never as a Worker env var:

```bash
printf '%s' "$JEV_API_KEY" | hr credential set jev-autofix \
  --type api_key --name 'Jev experimental Auto Fix'
hr dag validate assets/orchestrations/auto-fix-jev.yaml.template
hr dag sync assets/orchestrations/auto-fix-jev.yaml.template
```

Create a separate runtime profile using the active setting IDs for your coding
and review roles. Coding needs a Responses-compatible setting; the review role
needs an Anthropic-compatible setting. This profile is independent of the
three-model formal PR-review profile:

```yaml
profile_id: auto-fix-jev-experimental
workflow_id: auto-fix-jev
agents:
  implementer: { llm_setting_id: YOUR_CODING_SETTING_ID, agent_type: codex_appserver, reasoning_effort: max }
  aggregator: { llm_setting_id: YOUR_CODING_SETTING_ID, agent_type: codex_appserver, reasoning_effort: max }
  fixer: { llm_setting_id: YOUR_CODING_SETTING_ID, agent_type: codex_appserver, reasoning_effort: max }
  reviewer: { llm_setting_id: YOUR_REVIEW_SETTING_ID, agent_type: claude-sdk }
```

```bash
hr profile sync /absolute/path/to/jev-profile.yaml --workflow auto-fix-jev
hr run auto-fix-jev --sync --profile auto-fix-jev-experimental --prompt '{}' \
  --input-scope jev-pilot \
  --input-file task_document:input/task.md=/absolute/path/to/task.md \
  --input-file task_plan:input/task-plan.json=/absolute/path/to/task-plan.json \
  --input-file pr_context:input/pr-context.json=/absolute/path/to/pr-context.json
```

The adapter pins `jev-1.13.0` by default. An operator may set the credential's
public `metadata.labels.model` through the credential API to another explicit
`jev-X.Y.Z` version. The workflow and model callers cannot choose an endpoint,
override the model, or receive the key. Requests go only to
`https://api.typesafe.ai/v1/systemone`, with redirects rejected.

## Advice and fallback contract

The generic broker action accepts exactly `{evidence_id, state, questions}`.
`evidence_id` is an opaque caller-supplied binding; in this template it is the
PR snapshot head. State must be an object. A request permits 1–32 questions:
Noul, Choice with 2–32 described options, or Score with 2–10 ordered descriptions.
Question instructions are non-empty strings up to 4,000 characters. Each Choice
or Score description is at most 2,000 characters. Optional Noul criteria are a
string. Total request and response size are bounded to 64 KiB each. These are
this adapter's limits, not claims about the entire TypeSafe API.

An assessed result contains the model, evidence ID, canonical request hash,
validated typed answers, provider token usage, and elapsed HTTP time. No provider
prose or arbitrary metadata is relayed. `request_sha256` hashes canonical sorted
JSON of `{model, evidence_id, state, questions}`; the evidence ID is not sent to
TypeSafe as a model input. The broker performs one HTTP attempt with a 15-second
timeout. HTTP, transport and invalid-response failures return `unavailable`
without answers. Caller cancellation aborts the call. Bad credentials or request
configuration fail explicitly before inference.

The fixer records `jev_advice.status`, `request_sha256` and its reported
`disposition` (`used`, `overridden`, `unavailable`) in every FixResult. Existing
Manager receipt checks bind these to a real same-session call and the same
`previous_head_sha` already bound to the GitHub snapshot. A fabricated or
wrong-head receipt cannot satisfy the handoff. Unavailable advice can satisfy
only an unavailable receipt; it does not relax the passing TestReport or two
independent clean reviews.

The hash proves which request was made, not that caller-selected excerpts are
complete or truthful. The disposition is the fixer's account, not independently
measured causal benefit. The once-per-round call policy is a prompt instruction,
not a provider spending quota; the broker itself never retries. Input remains
untrusted, and models can share mistakes. Keep a complete experimental packet
outside the Worker when comparing decisions, latency and actual rework.

## Maintenance and validation

The variant is generated from the existing v2 template plus a small overlay:

```bash
node scripts/generate-auto-fix-jev-template.mjs
node scripts/generate-auto-fix-jev-template.mjs --check
```

Tests compare unchanged graph edges, acceptance contracts, node policies and
review prompts, exercise both variants through multiple repairs and exhaustion,
and reject forged/missing/stale advice receipts. Adapter tests cover input and
response validation, credential reflection, overload, cancellation and response
size. Run `npm run ci` before publishing changes.

Template correctness and live Jev connectivity are separate from evidence of
efficiency. No production advantage is implied by a passing wiring test. The
[PR validation protocol](../plans/autofix-jev-template.md) requires real verified
incremental benefit before expanding the formal PR-review workflow.
