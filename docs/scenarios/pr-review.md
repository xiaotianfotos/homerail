# PR Review Scenario

`assets/orchestrations/pr-review.yaml.template` is HomeRail's provider-neutral,
read-only pull request review scenario. It is a concrete composition of the
Orchestrator-Workers and Quorum patterns rather than a new abstract pattern.

## Inputs

Callers provide one logical PR input object:

```json
{
  "repo": "xiaotianfotos/homerail",
  "pr": 25
}
```

The CLI and Manager Skill resolve immutable base/head SHAs plus credential-free
HTTPS clone URLs from trusted GitHub PR metadata, then wrap the resolved object
in the same internal trigger envelope used by Manager event triggers. Optional
caller-supplied SHAs remain pinned, but clone URLs are always taken from the API
response and cannot be overridden by logical input. The workflow carries
separate base/head clone URLs so an explicitly reviewed fork can fetch each
commit from the repository that owns it. URL validation rejects credentials,
query strings, fragments, repository mismatches, and cross-origin base/head
metadata.

## Execution

1. A deterministic Manager command validates the credential-free GitHub API
   HTTPS clone URLs (`https://host/owner/repository.git`, including GitHub
   Enterprise hosts), clones both exact revisions into the isolated run
   workspace, verifies
   `HEAD`, and computes the changed-file list, short diff summary, and a bounded
   high-context patch. Small file sections are packed together into bounded
   120 KB evidence chunks instead of forcing one model tool call per changed
   file. Git runs with credential helpers, prompts, hooks, and
   local/ext protocols disabled; no model tool call is involved in checkout or
   evidence collection. The serialized review context is capped below the
   Manager command-output limit and records `diff_truncated` explicitly.
   Bounded author/committer metadata is captured for audit history, then
   deterministically stripped from the model context.
2. The three stable reviewer slots (historically labeled Qwen, Kimi, and GLM)
   start from the same exact evidence independently and in parallel. Their
   actual provider and model identities come from persisted Manager dispatch
   bindings and may differ from the slot labels. Each slot performs a complete
   PR review covering runtime correctness, security, compatibility, tests, and
   user-visible behavior, then casts one `approve` or `request_changes` vote. The trusted checkout is
   mounted read-only. Reviewers that need repository evidence receive only the
   read-only `Read`, `Grep`, `Glob`, and `LS` tools, so they can inspect
   complete files, trace callers, and search tests without granting untrusted PR
   content a shell or write primitive. The selected backend either applies a
   Worker pre-tool hook or uses the HomeRail-managed DSH MCP implementations;
   both resolve real paths and deny omitted paths, traversal, absolute paths
   outside the declared workspace roots, and symlink escapes before a
   read/search tool executes.
   The supplied patch is an index rather than the sole evidence source, and
   prompts require every diff chunk to be read while keeping follow-up
   inspection proportional. Model-specific output contracts reject a mislabeled
   identity and trigger bounded contract correction. Patch and repository
   content are untrusted evidence, never instructions.
3. A deterministic normalizer preserves every valid reviewer result. If a
   reviewer exhausts contract correction without a handoff, the normalizer
   emits a failed/abstain result. A complete vote is accepted only when the
   reviewer accounted for every changed file and its findings agree with its
   vote.
4. A deterministic command retains the deduplicated union of findings from
   every complete reviewer. A `pass` requires at least two approvals and zero
   retained findings; one complete request-changes vote is therefore enough to
   produce blocking `findings`. Fewer than two complete reviews with no finding
   produce `inconclusive`. No model can alter the vote or finding accounting.
5. Manager materializes the structured JSON artifact. After the run reaches a
   terminal state, the stable runner renders Markdown deterministically from
   that JSON plus `command.json`, so the exact Manager run id cannot be invented
   or altered by a model.


## Execution identity and usage evidence

The default quorum counts 2/3 approving reviewer executions plus zero retained
findings; it does not measure distinct model weights. The environment variable
`HOMERAIL_PR_REVIEW_DIVERSITY_POLICY` controls a configuration-time preflight:

- `executions` (default): preserves historical backend behavior. The Claude
  Agent SDK harness requires three distinct setting IDs; DSH may intentionally
  share one OpenAI-compatible setting across all three slots.
- `distinct_models` (opt-in): validates that all three reviewer roles resolve
  to three distinct configured `[provider_id, model_name]` JSON tuples before
  Runtime Profile sync or model dispatch, rejecting missing or duplicate
  identity. Setting IDs or endpoint URLs alone do not constitute diversity.

This preflight is configuration-time, not atomic Manager admission. Later
configuration edits and aliased endpoint weights remain tracked as #273
followup.

A trusted host collector produces `pr-review-execution.json` from persisted
Manager prompts and Worker usage snapshots for all three slots on both
successful and failed review paths. The sidecar records actual provider, model,
backend, and setting history plus explicit unavailable markers; it never
persists API keys, endpoints, prompts, prose, or debug text.

The Markdown renderer shows dispatch bindings separately from slot votes.
Per-execution cumulative usage snapshots deduplicate; observed token totals
include uncached input, output, cache-read, and cache-create once. Unknown
totals remain `null`; missing executions stay incomplete. The usage state is
`final` only when at least one runtime usage snapshot carries both
`finish_reason` and `duration_ms`; partial or unknown state never means
zero-cost or settled billing. Request-level provider attribution, upstream
cancel acknowledgement, and complete billing settlement remain #271 followup.
