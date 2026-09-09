import { E2eFixCandidates, e2eFixDigest } from "./e2e-fix-candidates.js";
import { E2eFixAcceptanceInputSchema, sameE2eFixCandidate, type E2eFixAcceptanceInput } from "homerail-protocol";

/** Admit the reviewer input before any GitHub write. Reserve the largest safe
 * PR number; every other publication field is known or fixed-width. */
export function publishE2eFixReviewContext<T extends {
  candidate: E2eFixAcceptanceInput["candidate"]; sources?: Record<string, string>;
}>(evidence: T, candidates: E2eFixCandidates, limit: number,
  publish: () => E2eFixAcceptanceInput["publication"]) {
  const reserved = { candidate: evidence.candidate, artifact_sha256: "0".repeat(64),
    pr: Number.MAX_SAFE_INTEGER, observed_head: evidence.candidate.head, state: "open" as const };
  const admitted = projectE2eFixReviewContext({ ...evidence, publication: reserved }, candidates, limit,
    { artifact: "test_sources.json", reviewersHadFullSources: false });
  if (Buffer.byteLength(JSON.stringify(admitted)) > limit) throw new Error("review context exceeds frozen bound before publication");
  const publication = E2eFixAcceptanceInputSchema.shape.publication.parse(publish());
  if (!sameE2eFixCandidate(publication.candidate, evidence.candidate) || publication.state !== "open"
    || publication.observed_head !== evidence.candidate.head || !Number.isSafeInteger(publication.pr)) {
    throw new Error("published PR does not match the tested candidate");
  }
  // Use the admitted shape, replacing only the bounded fields that were unknown.
  return { ...admitted, publication: { ...reserved, pr: publication.pr, artifact_sha256: publication.artifact_sha256 } };
}

/** If full-source evidence overflows, project it to a base-to-candidate diff.
 * Explicitly identify whether reviewers received the full source or this
 * projection. Never truncate the issue, repair target, findings or votes. */
export function projectE2eFixReviewContext<T extends {
  candidate: Parameters<E2eFixCandidates["reviewDiff"]>[0]; sources?: Record<string, string>;
}>(evidence: T, candidates: E2eFixCandidates, limit: number,
  source: { artifact: string; reviewersHadFullSources: boolean } = { artifact: "test.json", reviewersHadFullSources: true }) {
  if (Buffer.byteLength(JSON.stringify(evidence)) <= limit) return evidence;
  // Already projected. Do not silently strip further context to make it fit.
  if (!evidence.sources) return evidence;
  const { sources, ...rest } = evidence;
  const projected = { ...rest, source_context: {
    kind: "base_to_candidate_diff", base: evidence.candidate.base, head: evidence.candidate.head,
    context_lines: 20, diff: candidates.reviewDiff(evidence.candidate, Object.keys(sources)),
    full_sources_sha256: e2eFixDigest(JSON.stringify(sources)),
    full_sources_artifact: source.artifact,
    limitation: source.reviewersHadFullSources
      ? "Unchanged source outside diff context is omitted here; full sources remain in the immutable artifact and were supplied to each reviewer."
      : "Unchanged source outside diff context is omitted here; full sources remain in the immutable artifact. Reviewers receive this projection, not the omitted source. Abstain if the supplied context is insufficient.",
  } };
  // Large changes or findings still fail the existing bound. An empty or
  // oversized diff is never permission to discard evidence or enlarge policy.
  return Buffer.byteLength(JSON.stringify(projected)) < Buffer.byteLength(JSON.stringify(evidence)) ? projected : evidence;
}
