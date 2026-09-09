# E2E Fix: bounded recovery with retained evidence

## Review aggregation runtime repair

After a verified first-round `review_evidence` context-overflow failure, a
trusted operator can authorize one replacement frozen runtime for that stage:
`POST /api/runs/{run_id}/e2e-fix-review-recovery`. The request uses the ordinary
DAG mutation authentication and contains `request_id`, `expected_state_sha256`,
`reason`, `task_directory`, `runtime_directory`, and `runtime_sha256`.
The state digest is `recoveryDigest(loadRunMetadata(run_id))` from trusted host
persistence. Both directories must be absolute, private host paths. The new
interpreter must already be in `HOMERAIL_DAG_COMMAND_ALLOWLIST`; the operator
must review and test the replacement before approving this request.

The Manager verifies the original command's exact overflow error, native
completion receipts, model handoffs, candidate snapshot, latest passing test
receipts and the replacement runtime inventory. It reconstructs the checkpoint
through the DAG engine and requires an exact replay of the recorded failure,
with no other ready or in-flight branch. It rejects unknown executions, changed
artifacts, expired tasks/rounds, missing retry allowance and an occupied workflow
concurrency slot. A known nonzero command exit by itself does not authorize retry.

One transaction preserves the original round, deadlines, consumed counters,
completed sessions and candidate, assigns a fresh aggregation session, changes
only that stage's static command, and records the runtime authorization before
dispatch. The original policy file and all model/test/publication runtimes stay
frozen. Subsequent rounds use the approved aggregation runtime under that same
policy. Repeated identical requests return the original receipt without another
tick; changed requests conflict. The original failed command and evidence remain
available, and the task permits only one such recovery.

This is an operator-assisted repair of a deterministic runtime fault, not an
automatic model retry or proof of an unassisted E2E run. It supports the specific
first-round aggregation failure only. If the replacement still fails, its
evidence is retained; it does not gain another recovery allowance or a later
deadline. Successful recovery admission alone does not prove downstream repair,
review, publication or CI success.

The native stage suite checks checkpoint reconstruction, receipt tampering,
expiry, transaction rollback, idempotent HTTP replay and stage-specific runtime
authorization with real Git/Docker and simulated models. Its recovery runtime
fixture is deliberately not executed; actual continuation requires separate
live evidence.

Recovery also authenticates an explicitly frozen host Codex Fixer using its
native command, session, structured-output receipt and event journal. Worker
Fixers retain their original handoff provenance checks; opting into a host
Fixer does not authorize replacing a model result or replaying its command.

When full source plus combined reviews exceeds the frozen context bound, the
aggregation stage can replace the full source rendering with a trusted Git
diff from the frozen base to the candidate, including 20 context lines. This
includes changes retained from earlier repair iterations. The full issue,
findings, reports and evidence digests remain intact. Full source remains in
the immutable `test.json` artifact, identified by a digest, and each reviewer
has already received it. The projection explicitly identifies omitted unchanged
source. If the projection still exceeds the bound, the stage still fails;
it never truncates findings or increases the task's context allowance.

Review `findings` are unresolved actionable defects. Positive observations
belong in `summary`; `approve` requires an empty `findings` array. Existing
contradictory reports are preserved and cannot satisfy the approval gate,
even if their text appears positive. Clarifying the prompt for new workflows
does not repair already frozen reviewer prompts or previously emitted votes.

New workflows enforce the approval/findings relation in the Review JSON Schema,
before a handoff can reach the aggregation node. A rejected report therefore
uses the existing native node-correction path, with at most one correction per
node for the task. Only that node is rescheduled; completed candidate capture,
tests and sibling reviews are retained. The correction input includes the
contract error, original inputs and a bounded rendering of the rejected report.
Exhaustion fails the node; the runtime cannot synthesize a successful report.

This path preserves the logical session and its authorization fence. It is not
a new repair round. Worker correction mode replaces the system prompt and
allows only a handoff. The local DeepSeek Harness adapter creates a new isolated
process/session store for every execution and does not resume model history;
other backends retain their own session semantics. Input and correction sizes
remain subject to their existing bounds. A later correction may keep genuine
defects and change the vote to `request_changes`; code never removes findings
or converts a vote on the model's behalf. An already accepted legacy handoff is
outside this pre-handoff correction path and is not retroactively rewritten.

## Pre-dispatch configuration repair and model failures

Patch proposals can contain multiple small edits to one authorized file. Each
`old` snippet must match the frozen parent exactly once, and matched ranges
must not overlap. Edits are applied in reverse offset order, so their array
order cannot change the result. An edit cannot match text inserted by another
edit. Duplicate new-file creation, combined no-op changes, out-of-scope paths
and protected paths remain rejected. This lets the executor accept the same
short-snippet format requested by the Codex plan without requiring whole-file
replacements; it does not establish why a previous model response truncated.

### Optional host Codex Fixer

For a newly frozen task, set `host_codex.fixer: true` and build its host commands
with `frozenE2eFixHostCodexCommands(runtime, taskDirectory, { fixer: true })`.
Both are required: a command alone does not authorize host Fixer receipts.
The default remains a Worker Fixer. Changing an existing frozen task is rejected;
this option is not an automatic fallback or a way to revive a terminal root.

The Fixer is a native durable command with an ephemeral, read-only Codex session
and no tools. It implements the approved plan by returning the same `Patch`
contract used by Worker Fixers. Candidate capture enforces scope and exact edits;
programs execute tests and publish. Planner, Fixer and Judger have distinct
sessions, while all three reviewers remain independent Worker nodes.

A host Fixer process/provider failure follows its single terminal failure edge,
preserving claims and evidence rather than reading Worker diagnostics or spending
again. This does not recover unknown model execution. The observer uses the
native cycle iteration for artifact paths, independently of lifecycle round IDs,
and includes opted-in host Fixer failures when a command becomes stranded.
Existing output-truncation feedback applies to Worker Fixers.

Host Codex Judgers use a strict provider schema: every property is required,
with a nullable `retry_strategy` normalized to absence in native Judgment
receipts. The adapter releases its app-server before yielding final diagnostic
events, including when a consumer stops on a provider error.

For program-only observation, run
`node scripts/event-supervisor/watch_e2e_fix.mjs /absolute/watch-options.json`
under the durable event supervisor. Options are `manager_url`, `task_directory`,
`evidence_directory`, `timeout_ms` and optional `poll_ms` (default 15000).
The watcher only reads status and private task artifacts. It exits 0 when a
terminal status is observed (which may be failed), or 2 on a stranded host
failure, bounded observation error or deadline. An error receipt matching the
current host role/round and original claim while the node remains RUNNING for
five seconds triggers attention. Expected handled Fixer failures stay quiet.
Use a fresh evidence directory and preserve its attention event key for dedup.
An observation job for a frozen runtime should not pin the changing development
checkout's HEAD: the task already binds its runtime and policy. Keep HEAD gates
on source CI jobs. Do not rerun a DAG because its observer ended or failed.

DSH output diagnostics now retain bounded, content-free byte observations for
reasoning, visible text and tool arguments. Stream deltas and assembled messages
are separate counters because their contents can overlap. At most 16 interim
snapshots and one final snapshot are emitted per adapter invocation. The Worker
binds diagnostics to its usage execution ID; failure evidence exposes the latest
validated snapshot from the matching native session and round to the Judger.
No reasoning text or incomplete tool arguments are copied into these records,
and a partial tool call never becomes a handoff. These counters measure observed
UTF-8 bytes, not token usage; zero means unobserved, not proof that the provider
generated nothing. A process crash or early handoff can omit the final snapshot.
Old Worker images do not provide this evidence. This improves diagnosis, but
does not implement a cumulative token admission limit or retain raw partial
model output.

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
such configuration recovery. Recovery must re-acquire a workflow concurrency
slot; admission and reopening share one transaction. A competing active root
leaves the failed root and recovery checkpoint unchanged.

Creation time and round expiry are preserved. This does not add a general
per-dispatch task deadline or token-budget guard: E2E Fix's frozen trusted stages
still enforce their original task deadline. Whole-graph recovery, unknown model
requests, exhausted budgets and guaranteed semantic convergence remain separate
work.

When a Worker reports output truncation without a retained rejected handoff,
review recovery path or reusable broker receipt, the Manager does not spend
ordinary handoff-correction attempts on the same task and output limit. It
retains the transport diagnostic and uses the normal node failure path, even
with a zero correction budget; truncation must not synthesize success. This
guard does not change output limits or provide post-execution recovery. Such a
continuation needs an explicitly changed, bounded input or output policy and
must preserve earlier model evidence, plans and consumed budgets. The
pre-dispatch API above cannot recover a root that already executed a Worker.

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

## Model failures inside the native repair loop

Newly built E2E Fix workflows route `fix.failed` into the trusted candidate
stage. That stage requires a failed persisted node/session and reads matching
Worker or Node transport records for the current session and native round.
It saves diagnostics and usage snapshots deduplicated by execution ID. It does
not turn a model failure into a patch or a passing test: candidate is null,
tests are empty, and reviewers and publication are skipped for that iteration.

For ordinary review revisions, the next fresh context also retains the Judger's
`retry_strategy`. It excludes a finding only when the complete disposition set
matches all finding IDs without duplicates and that dismissal supplies a reason
and known evidence references. Invalid dismissals remain unresolved. Full findings
and dispositions remain in the immutable review and judgment artifacts; this
projection does not relax publication acceptance.

The graph sends this evidence to its Codex Judger. A confirmed output-limit
failure may enter the feedback edge only when the Judger returns `revise` with
a nonempty `retry_strategy`. Unknown execution, missing matching usage, or an
`accept` without a candidate pauses. The next fresh Planner receives that
strategy and prior diagnostic/cost evidence. The trusted plan stage rejects an
identical strategy/path set before another Fixer dispatch (ignoring JSON key
order and cosmetic surrounding whitespace), and sends the Fixer only sources
within the Planner's approved path subset. This is a bounded
change check, not proof of semantic progress; assessing the strategy remains
the Judger's responsibility.

This uses the existing root, iteration and time limits, without increasing the
output allowance or resetting prior evidence. It does not retrofit a failure
edge into an already failed historical workflow, prove arbitrary recovery, or
provide a cumulative model-token admission budget. Those remain separate work.

The opt-in `tests/e2e-fix-stage.test.ts` suite uses real native stages, Git and
Docker with simulated models/GitHub. It verifies output truncation → Judger
strategy → new-context repair → tests/reviews/publication/CI, and rejects unknown
or stale execution evidence, an unchanged plan, missing strategy and attempted
acceptance without a patch. Set `HOMERAIL_E2E_FIX_TEST_IMAGE` to an immutable
local Node image ID to run these scenarios. This is control-flow evidence;
real model and real GitHub acceptance must be demonstrated separately.

## Candidate snapshot publication

Trusted candidate snapshots normalize file modes from Git (`0444` for regular
files, `0555` for executables) and directory modes to `0755`, including on
storage with inherited ACLs. The private candidate store remains private;
only the snapshot is mounted into the non-root test container. The complete
temporary snapshot is checked before publication. A malformed temporary
snapshot is discarded, so a retry can rebuild it. A previously published
snapshot with changed bytes, permissions, entries or unsafe links is rejected
without being rewritten.
# Model runtime evidence across aggregation recovery

New E2E role artifacts bind the resolved Manager dispatch runtime to the retained
session, round, actor generation, physical target, lease and reported execution.
Production stages reject missing or conflicting runtime evidence. This records
the selected provider/model; it does not attest which model a provider served.

An explicitly admitted aggregation recovery may contain older role artifacts
without runtime metadata. The recovery verifies their original digest format,
handoff and session. When the replacement stage reads them, it compares every
legacy field with freshly loaded native evidence, retains the original bytes,
and writes the new dispatch projection to `<reviewer>_runtime.json`. It does not
rewrite previous votes or rerun a model to add metadata. New-format artifacts
also require an exact match with the retained Manager dispatch projection.

新回执绑定当时的 Manager 派发模型身份。受限汇总恢复兼容旧回执：重新核对
全部旧字段，保留原字节，来源投影另存，不查询当前设置冒充历史，也不重跑模型。


## CI 观察恢复 / CI observation recovery

GitHub CI provider 在首次观察前保存 `ci-deadline.json`。瞬时 GET 或日志读取
失败由可信程序在该期限内重试；不会重新 push、创建 PR 或 dispatch workflow。
重新进入观察时复用原 `ci-run.json` 的 run/attempt 和原期限。身份不匹配、
不完整或歧义的 inventory 仍立即停止；超期不会被重新进入延长。

终态 `ci-evidence.json` 保持不可变。重新读取时先核对当前 PR 和 CI 身份，
再复用原结果，不因 GitHub 后续增加元数据而重写证据；原 unknown 也不会
悄悄升级成成功。此 provider 的读取恢复不意味着原生 DAG 的任意失败阶段都
支持自动重派发，不能以此绕过冻结阶段或原任务期限。

The GitHub CI provider persists its observation deadline before its first read.
Transient GET/log failures retry within that deadline; writes are never retried
by this mechanism. Re-entry retains the owned run/attempt and deadline. Invalid
identities or incomplete/ambiguous inventories stop immediately. Final evidence
is reused after checking current PR/run identity, including a retained unknown
outcome. This does not authorize arbitrary native stage redispatch or extend the
root run deadline.

验证包括实际观察进程 SIGKILL 后在新进程复用同 run/attempt、原 deadline、
一次 dispatch 的回归测试（GitHub transport 为替身）。另在 #307 原第三轮
证据的独立副本上注入一次声明的读取故障及真实 SIGKILL，恢复后以真实 GitHub
GET/日志核对原 CI `34298573799` attempt 1 的五项成功；仅 14 次 GET，零
修改请求、零模型调用，未改写原证据。后者证明已完成 CI 的观察恢复，不是
真实 GitHub 服务故障或仍执行中的远端 CI 重启。
