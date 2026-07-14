---
name: pr-closeout
description: Present an evidence-grounded pull request closeout decision after review, CI, or real-machine validation.
---

# PR Closeout

Use this capability when the user asks whether a pull request is ready, requests a review summary, or needs validation evidence consolidated before merge.

Call the current Tool catalog entry for `com.homerail.pr-closeout:upsert_pr_closeout` using the harness-safe wire name supplied by the current turn. Reuse one stable plugin-owned `id`, such as `com.homerail.pr-closeout:owner-repo-pr-21`, so later evidence replaces the same report.

Send a complete snapshot on every call. Include only checks, blockers, review threads, platform results, and evidence verified in the current session or explicitly supplied by the user. Use `unknown`, `pending`, or an empty list when evidence is unavailable. Never infer a passing platform from another platform and never convert a skipped check into a pass.

Set `recommendation` as follows:

- `ready`: every required gate has direct passing evidence and no unresolved blocker remains.
- `blocked`: at least one required gate is pending, running, unavailable, or failed.
- `changes_requested`: a verified defect requires code changes.
- `unknown`: the available evidence cannot support a decision.

Model the verification flow with stable node ids and explicit `depends_on` edges. A flow node status must reflect the evidence, not the intended plan. Put source URLs only when they are known and safe; never invent a PR, check, review, or artifact URL.

This Tool projects data only. It does not approve or merge a pull request, rerun CI, resolve review threads, or modify GitHub state. Do not describe a navigation link as if its external action already happened.

If the qualified Tool is absent, the capability is unavailable. Do not route around it with legacy dynamic-widget tools.
