# Optional Jev Auto Fix template and prospective PR evaluation

2026-09-23. Experimental; no production deployment or default workflow change.

Problem: plausible but unsupported review findings can cause unnecessary edits
and repeat review. Prior PR #314 experiments showed fast factual decisions but
also systematic errors. This change makes bounded Jev advice available to the
fixer while retaining independent tests and review acceptance.

Layer Decision:
- Problem layer: optional workflow composition and external provider access.
- Preferred fix layer: generated Auto Fix template and existing credential broker.
- Manager touched: yes.
- Manager Change Justification: public provider, settings and validation surface;
  one generic typed TypeSafe adapter, no AutoFix-specific Manager decision logic.
- Rejected shortcuts: keys in Worker env/prompts, arbitrary HTTP endpoints,
  replacing acceptance with model probabilities, modifying the default review.
- Public entry path: `hr credential set`, `hr dag sync`, `hr profile sync`,
  `hr run auto-fix-jev` with existing immutable v2 inputs.
- Validation path: bounded adapter tests, both full deterministic template
  scenarios, receipt-forgery rejection, live Jev broker execution, `npm run ci`,
  and the resulting PR's real formal review.

The template modifies only fixer advice and its required receipt. It preserves
every source/test acceptance gate. The adapter exposes Choice, Score and Noul,
pins the model through credential configuration, rejects redirects and invalid
responses, and has no automatic PR or repair authority. Old experiment commits
and datasets remain on their separate research branch.

## Freeze before formal PR review

1. Create a Draft PR for this implementation with validation and limitations.
2. Pin its exact base/head and run the established full review with one Kimi K3
   and two GLM 5.3 instances using `pr-review-mixed`, `claude-sdk`. Do not supply
   a single-model workflow override. Verify actual execution identities.
3. Retain all findings and abstentions. Create a bounded factual packet for
   every distinct finding, preserving its actual wording and relevant source at
   that same head. Do not select only findings thought to favor Jev. If there
   are no findings, report the absence of an incremental opportunity.
4. Before running Jev, freeze packet hashes, explicit factual questions and the
   decision policy. Jev gets no other model's vote or maintainer disposition.
   Compare raw Noul direction at 0.5 and conservative advisory ranges >=0.8 /
   <=0.2, with middle values deferred; never modify original findings by score.
5. Independently verify disputes through source, focused executable tests or
   documented requirements. Count true defects retained, unsupported repair
   suggestions identified, missed defects, new false objections, deferrals,
   additional investigation and actual repair/review iterations.

Incremental success requires at least one verified real error or unnecessary
repair in the baseline that Jev flags before an edit, no verified new defect
miss caused by following Jev, and a concrete avoided action documented by the
host. A probability disagreement alone is not success. Also report preparation
and adjudication overhead; unmeasured human time cannot become a speedup claim.

The formal reviewers and Jev have different task sizes. API latency may be
reported independently, but is not a speed comparison against a full PR review.
If the same bounded packet is additionally evaluated by an LLM, record the
actual model and identical input hash. No synthetic defect may be inserted into
the PR merely to manufacture an advantage; mutation probes can qualify tests
but must remain separate from real incremental benefit.

Only after incremental success should this PR add an opt-in Jev factual-check
node to PR review. It must initially be advisory, retain the original finding
union and vote accounting, and fall back on unavailable/uncertain responses.
Otherwise keep the PR scoped to the optional AutoFix template and publish the
negative/inconclusive evaluation. One PR cannot establish broad superiority.
