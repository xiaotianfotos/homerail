/**
 * Shared PR Review scenario primitives.
 * @version 0.1.0
 */

/** One standard PR Review reserves eight scenario budget units: four primary
 * reviews, one synthesis pass, and three independent quorum votes. */
export const DEFAULT_PR_REVIEW_EXPECTED_USAGE = 8;

const FULL_GIT_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** Accept only complete SHA-1 or SHA-256 Git object identifiers. */
export function isFullGitRevision(value: unknown): value is string {
  return typeof value === "string" && FULL_GIT_REVISION.test(value);
}

/** Keep repeated PR reviews under one repository-scoped daily budget. */
export function defaultPrReviewBudgetKey(repo: string, now = new Date()): string {
  return `pr-review:${repo}:${now.toISOString().slice(0, 10)}`;
}
