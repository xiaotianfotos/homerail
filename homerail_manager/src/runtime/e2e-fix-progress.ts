import { createHash } from "node:crypto";

export interface E2eFixFailureObservation {
  phase: "candidate" | "ci";
  outcome: string;
  checks: Array<{ id: string; result: string; diagnostic: string }>;
  findings: string[];
  detail: string;
}

// Compare retained failure content, not candidate/plan/session hashes or a
// model's claim of improvement. Keep assertion values and source locations:
// changing those can be real progress. This conservative comparison can miss
// reworded failures; the independent round/time bounds still apply.
const normalize = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "")
  .split(/\r?\n/).map(line => line.trimEnd()).join("\n").trim();

export function e2eFixFailureFingerprint(observation: E2eFixFailureObservation): string {
  const value = {
    ...observation,
    checks: observation.checks.map(c => ({ ...c, diagnostic: normalize(c.diagnostic) }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    findings: [...new Set(observation.findings.map(normalize))].sort(),
    detail: normalize(observation.detail),
  };
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function assessE2eFixProgress(current: string, previous: Array<string | null>) {
  let repeats = 1;
  for (const fingerprint of [...previous].reverse()) {
    if (fingerprint !== current) break;
    repeats++;
  }
  return { failure_sha256: current, consecutive_failures: repeats,
    action: repeats >= 3 ? "pause" as const : repeats === 2 ? "replan" as const : "continue" as const };
}

export function sameE2eFixPlan(a: { strategy: string; allowed_paths: string[] }, b: typeof a) {
  const paths = (plan: typeof a) => JSON.stringify([...new Set(plan.allowed_paths)].sort());
  return a.strategy.trim().replace(/\s+/g, " ") === b.strategy.trim().replace(/\s+/g, " ") && paths(a) === paths(b);
}
