# Auto Fix Jev template: PR #318 validation

2026-09-23. Experiment on [PR #318](https://github.com/xiaotianfotos/homerail/pull/318).
This report separates implementation validity, factual inference and actual
avoided repair work. The prospective decision rule was committed before the
formal review in `docs/plans/autofix-jev-template.md`.

## Frozen implementation and baseline

- Base: `916e343fc645be48620af7e55bd58b608f0ccfac`.
- Candidate: `c9a928d02259055b2fc8e7233521eeb191ad3f39`.
- [Full review](https://github.com/xiaotianfotos/homerail/actions/runs/35853819389),
  Manager DAG `a48626cb-9b80-4f37-822b-586373aecf00`.
- Actual dispatch records: GLM `glm-5.3`, Kimi `k3`, GLM `glm-5.3`, all through
  `claude-sdk`, with three independent executions. No single-model override.
- [Full CI](https://github.com/xiaotianfotos/homerail/actions/runs/35853903334),
  including Windows and Linux Node 20/24.

On the frozen initial candidate, local `npm run ci` passed with 4,299 tests and 43 skipped. An earlier run failed
three unrelated Worker workspace-boundary tests because this isolated worktree
used an external `node_modules` directory symlink. Independent dependency
directories resolved those failures; no test or runtime guard was weakened.
The 36 focused tests cover the adapter, template invariants, both complete
deterministic repair-loop scenarios and missing/forged/wrong-head receipts.
These are simulated agent handoffs, not a live autonomous repair success rate.

## Live broker connectivity

An isolated Manager DAG used its encrypted credential store and a broker node
with `typesafe/system_one`, then persisted the result. No production workflow
or credentials were changed. The state contained the complete new adapter
source (SHA-256 `8838711e5527cfe5f770b22da415991e14868e76d3e490c62dfada178d36c4b0`).
A single real Jev 1.13.0 request returned:

| Question | Primitive | Answer |
| --- | --- | --- |
| Does fetch explicitly reject redirects? | Noul | 0.99 |
| What happens on HTTP 529? | Choice | `unavailable`, probability 1 |
| What explicit response-size control exists? | Score | Level 2: byte-counted stream limit, probability 1 |

All three observations match the source. Provider usage was 2,576 input tokens
and 74 output tokens; measured broker HTTP time was 818 ms, whole local DAG
about 834 ms. This one request demonstrates connectivity and typed output only.
It is neither a latency distribution nor a comparison against full PR review.
The collection script initially inspected the terminal's already-consumed
mailbox; the receipt was recovered from the same persisted handoff without
repeating the API call.

## Prospective review-finding evaluation

The formal review finished with **3 approvals, no abstentions, no findings**.
All three reviewers reported complete coverage of the same ten changed files.
Thus there was no real erroneous repair suggestion to correct. The preregistered
incremental-benefit gate was **not demonstrated**, rather than failed on a
verified real disagreement. No PR-review Jev node was added.

We then ran a clearly supplementary, post-hoc factual check of eight claims
arising from the reviewed implementation. Two packets contained exact adapter
source and relevant parsed template nodes/contracts/edges. They contained no
reviewer vote, review summary, host label or instruction to agree with a model.
Their complete question text and bytes were frozen before inference; SHA-256:
`286124a337a70b6229092e40919ae8e63f9cb5260db8116cb896e3fee14baedc`.
Host fact labels were also frozen before the first request. We did not inject
bugs or relabel these factual checks as real review findings.

| Claim | Source truth | Jev Noul, rounds 1 / 2 / 3 |
| --- | --- | --- |
| Caller can override model through input | false | .23 / .20 / .22 |
| HTTP explicitly rejects redirects | true | .98 / .98 / .99 |
| HTTP 529 triggers an automatic retry | false | .03 / .02 / .03 |
| Response stream is bounded to 64 KiB | true | .39 / .40 / .42 |
| Final confirmation requires two clean matching reviews | true | .98 / .98 / .98 |
| Unavailable advice waives passing TestReport checks | false | .09 / .10 / .09 |
| Review-revision node receives Jev credentials | false | .02 / .02 / .02 |
| Fix handoff binds all three Jev identity/status fields | true | .71 / .68 / .74 |

At a .5 direction threshold Jev got 7/8 distinct facts right in every round
(21/24 repeated answers). It repeatedly missed the real stream bound: source
contains `MAX_BYTES = 64 * 1024`, adds each chunk's byteLength, and throws above
MAX_BYTES; the independent oversize-stream unit test passes. This contradicts
the claim's negative Jev direction and shows that a focused prompt is not a
correctness guarantee.

The preregistered conservative range (>= .8 positive, <= .2 negative) yields
16 correct suggestions, 8 deferrals and no incorrect confident suggestion in
this small repeated set. The caller-model claim crosses the .2 boundary once;
stable raw direction does not imply stable actionable coverage. Repetition
adds no independent examples and these rates cannot estimate real bug recall.

All six batch requests succeeded. HTTP latency median was 339.5 ms, range
261–837 ms; provider usage totaled 23,808 input and 465 output tokens. API
billing was not independently measured. Packet preparation and host checking
were extra work and were not timed, so no end-to-end speedup is claimed.

**Outcome:** optional AutoFix wiring is validated; factual advice is fast but
imperfect; demonstrated avoided edits = 0, demonstrated saved repair rounds = 0.
This evidence does not justify adding Jev to formal PR review. Retain the
experimental, explicitly selected AutoFix template and use a future PR with
actual disputed findings to test incremental benefit.


## CI-discovered defect and real repair

The initial GitHub CI run was not clean. Windows caught a new generator defect:
exact LF anchors failed against a CRLF checkout. All three approving reviewers
had missed it. A deterministic local reproduction converted the unmodified base
template to CRLF and got the same anchor error before any edit.

Before fixing it, a separate frozen packet supplied Jev with the actual generator,
Windows failure and reproduction. Jev correctly said the input was not normalized
(Noul .05), the output check compared raw text (.94), and both the base input and
checked output needed line-ending handling (Choice `both`, .89; 961 ms). The host
had already independently identified both sites. This is useful corroboration
of a CI-discovered repair, not a Jev-discovered defect or demonstrated saved edit.

The repair normalizes CRLF before matching anchors and before comparing generated
output. A regression test creates an actual CRLF checkout, requires `--check` to
pass, then changes its template ID and requires the stale-content check to fail.
All 37 focused tests and Manager typecheck passed after the fix. The generated
workflow itself is unchanged.

The first CI run also timed out in two existing asynchronous tests (Linux
Manager SIGKILL recovery marker, Windows resumed-command dispatch). Neither
assertion was weakened. The Linux recovery cases passed a focused local rerun.
The corrected PR must receive fresh full CI; the initial approval and local pass
must not be presented as proof of Windows success.
