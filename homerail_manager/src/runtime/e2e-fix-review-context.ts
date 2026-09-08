import { E2eFixCandidates, e2eFixDigest } from "./e2e-fix-candidates.js";

/** Reviewers already received full source. If their combined reports overflow,
 * give the Judger a program-generated base-to-candidate diff instead. Never
 * truncate the issue, findings, votes or evidence, or silently omit changes. */
export function projectE2eFixReviewContext<T extends {
  candidate: Parameters<E2eFixCandidates["reviewDiff"]>[0]; sources: Record<string, string>;
}>(evidence: T, candidates: E2eFixCandidates, limit: number) {
  if (Buffer.byteLength(JSON.stringify(evidence)) <= limit) return evidence;
  const { sources, ...rest } = evidence;
  const projected = { ...rest, source_context: {
    kind: "base_to_candidate_diff", base: evidence.candidate.base, head: evidence.candidate.head,
    context_lines: 20, diff: candidates.reviewDiff(evidence.candidate, Object.keys(sources)),
    full_sources_sha256: e2eFixDigest(JSON.stringify(sources)),
    full_sources_artifact: "test.json",
    limitation: "Unchanged source outside diff context is omitted here; full sources remain in the immutable test artifact and were supplied to each reviewer.",
  } };
  // Large changes or findings still fail the existing bound. An empty or
  // oversized diff is never permission to discard evidence or enlarge policy.
  return Buffer.byteLength(JSON.stringify(projected)) < Buffer.byteLength(JSON.stringify(evidence)) ? projected : evidence;
}
