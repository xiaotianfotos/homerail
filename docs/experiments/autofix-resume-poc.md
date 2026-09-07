# Auto Fix durable continuation proof of concept

Status: experimental; do not create a PR until the acceptance matrix is evaluated.

## Layer decision

- Problem layer: workflow policy and caller-side durable task supervision.
- Preferred fix layer: a standalone Node.js controller using public HomeRail APIs, Docker, and Git.
- Manager touched: no. Manager Change Justification: n/a. No synthetic runtime state or private Manager API.
- Rejected shortcuts: model-authored execution receipts, unconfirmed submission retries, unconditional ref overwrites and private database mutation.
- A task survives multiple model DAG runs. Accepted proposals, snapshots, test receipts and publication intent are durable data, never inferred from model conversation.
- Public entry: `node scripts/autofix-resume-poc/controller.mjs <task-directory>` under a per-task OS flock.
- Validation: deterministic adversarial tests, real local-model runs, controller/Manager interruption, independent Docker tests, local Git compare-and-swap publication, then full repository CI.

## Scope

This is a small-file proposal workflow: the model returns a bounded file manifest as a declared DAG artifact; trusted code applies it to a snapshot. It does not replace native Auto Fix v2's arbitrary repository worktrees. Tests run in a separate container without Manager credentials, Docker socket, or controller-state mounts. Publication is a local Git ref, not a GitHub PR. No experimental pass authorizes automatic merging.

Persist intent before side effects. Recover a model submission by its unique workflow identity; an ambiguous missing submission must pause rather than duplicate model spend. Named Docker containers allow test execution to survive controller or Manager restarts. Publication records an immutable candidate commit before an atomic expected-head ref update; a lost response is reconciled against the actual ref. Completed task reruns revalidate receipts/head and append a reconciliation event; they do not create another model run, test or commit.

The controller stores plan identity, all candidate versions, failures and model run IDs. A test or infrastructure retry reuses the same candidate. Only failed acceptance or semantic review requests another model proposal. Repeated identical failed proposals pause with evidence instead of looping indefinitely. Remaining limitations and measured results must be written after execution, not predicted in advance.

## Reproduce the bounded experiment

Prerequisites: Linux with `flock`, Node.js 20+, Git, Docker and an already-ready
HomeRail Manager/Node/Worker installation. Configure a local model setting through
normal HomeRail model configuration. The prototype creates real DAG runs and
therefore consumes model tokens. It never creates a GitHub PR.

Set the existing Manager URL/control token through your private runtime environment.
Set `HR_POC_SETTING_ID` to its model setting ID and `HR_POC_IMAGE` to an installed
Docker image's immutable `sha256:...` ID containing Node.js. Do not use an image tag.
Optional `HR_POC_REASONING` selects the provider's configured effort level.

```bash
# Run from this experimental checkout. Use a new directory outside the checkout.
node scripts/autofix-resume-poc/experiment.mjs init /tmp/autofix-resume-trial
node scripts/autofix-resume-poc/experiment.mjs run /tmp/autofix-resume-trial

# The same command continues after the observer exits or is interrupted.
node scripts/autofix-resume-poc/experiment.mjs run /tmp/autofix-resume-trial

# One durable controller step; useful for deliberately injecting failures.
node scripts/autofix-resume-poc/controller.mjs /tmp/autofix-resume-trial
npm run test:autofix-resume-poc
```

`plan.json` is immutable after initialization. `state.json` records the current
phase and every attempt; `runs/`, `snapshots/` and `receipts/` contain evidence.
The `published.git` repository receives one candidate commit through an expected-head
ref update. Tests are separate Docker containers named with task identity, a nonce
and attempt number. Completed containers are retained for inspection; the operator
can remove those exact recorded containers after archiving evidence. Do not run a
broad Docker prune.

The observer is bounded; a stopped observer does not mean task data is discarded.
`needs_attention` deliberately does not auto-resume. This POC has no complete
operator API to resolve an ambiguous submission, replace an immutable plan or add
allowance. That missing production interface is an explicit acceptance gap, not an
invitation to edit state files.

## Fault and measurement helpers

`fault-proxy.mjs <manager-origin> <listen-host> <port> <flag> <jsonl-log>` forwards
public Manager requests. Creating `<flag>` drops the next successful create-and-run
response after forwarding; creating `<flag>.before` drops the next submission
before forwarding. Bind it to a private test interface and set the task's
`manager_url` to it **before** initialization. These are explicit experiment faults.
No private Manager state is written.

`model-proxy.mjs <provider-origin> <listen-host> <port> <jsonl-log>` measures the
streaming Chat Completions path. Route the model setting's
`chat_completions_base_url` through it, using an address reachable from Workers.
It records timings/usage, never prompt/output text or authorization headers, and
propagates downstream cancellation. Restore the setting before stopping the proxy.
A missing final usage value is unknown; the proxy cannot reconstruct tokens from
time. Its HTTP origin and listener must be supplied by the operator, not hardcoded
Docker network assumptions.

For process faults, use the exact `active_test.name` or controller PID belonging to
the task. Restart only an isolated Manager service. Reconcile publication against
the exact commit in `state.publication`, and verify the baseline-to-head commit
count remains one. Do not perform these faults against production services.

## Results and outstanding acceptance

See [the execution report](autofix-resume-report.md) and
[redacted structured evidence](autofix-resume-results.json). The report distinguishes
initial test-runner defects, clean baselines, restart before inference, restart
after first token, and the corrected cancellation-aware measurement proxy.

The production work is tracked in issues
[#269](https://github.com/xiaotianfotos/homerail/issues/269),
[#270](https://github.com/xiaotianfotos/homerail/issues/270), and
[#271](https://github.com/xiaotianfotos/homerail/issues/271).
No PR is authorized by a passing local fixture alone.
