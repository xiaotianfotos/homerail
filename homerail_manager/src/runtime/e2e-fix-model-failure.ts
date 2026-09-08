import { sanitizeAttemptDiagnostic } from "homerail-protocol";
import { getDagSessionIndex } from "../persistence/dag-session-index.js";
import { loadRunMetadata, loadRunSnapshot } from "../persistence/store.js";
import { e2eFixDigest } from "./e2e-fix-candidates.js";

/** Whitelist content-free byte observations; never copy arbitrary debug data
 * into the next model context or turn these counters into token usage. */
function outputObservation(value: any) {
  if (value?.version !== 1 || value.unit !== "utf8_bytes" || typeof value.final !== "boolean"
    || value.scope !== "observed_root_session_events_not_tokens") return null;
  const keys = ["text", "reasoning", "tool_arguments"] as const;
  const counts = [value.stream_events, value.message_events, value.interim_snapshots,
    ...keys.map(k => value.stream_bytes?.[k]), ...keys.map(k => value.message_bytes?.[k])];
  if (!counts.every(n => Number.isSafeInteger(n) && n >= 0) || value.interim_snapshots > 16) return null;
  return { version: 1, unit: "utf8_bytes", final: value.final, scope: value.scope,
    stream_events: value.stream_events, message_events: value.message_events,
    interim_snapshots: value.interim_snapshots,
    stream_bytes: Object.fromEntries(keys.map(k => [k, value.stream_bytes[k]])),
    message_bytes: Object.fromEntries(keys.map(k => [k, value.message_bytes[k]])) };
}

/** Read execution facts, never a model's claimed failure/usage in a handoff. */
export function readE2eFixModelFailure(runId: string, nodeId: string, routed: unknown) {
  const metadata = loadRunMetadata(runId);
  const session = getDagSessionIndex(runId, nodeId);
  if (!session || session.status !== "failed" || metadata?.nodeStates[nodeId] !== "FAILED"
    || !metadata.currentRound?.round_id) throw new Error("model failure provenance mismatch");
  const roundId = metadata.currentRound.round_id;
  const entries = (loadRunSnapshot(runId)?.chats[nodeId] ?? []).filter(entry => {
    const c = entry.content as Record<string, unknown> | null;
    return entry.type === "response" && c && c.session_id === session.session_id && c.round_id === roundId
      && (c.runId ?? c.run_id) === runId && (c.nodeId ?? c.node_id) === nodeId;
  });
  const error = (routed as { error?: unknown } | null)?.error;
  const last = entries.filter(entry => {
    const c = entry.content as Record<string, unknown>;
    return typeof c.message === "string" && c.message === error && c.type === undefined;
  }).at(-1);
  const diagnostic = sanitizeAttemptDiagnostic((last?.content as Record<string, unknown> | undefined)?.attempt_diagnostics,
    { failure_reason: error });
  const usages = new Map<string, { execution_id: string; input_tokens: number; output_tokens: number;
    cache_read_input_tokens: number; duration_ms: number | null; finish_reason: string | null }>();
  const outputs = new Map<string, NonNullable<ReturnType<typeof outputObservation>>>();
  for (const entry of entries) {
    const c = entry.content as Record<string, any>;
    if (c.type === "agent_debug" && c.source === "deepseek-harness" && c.message === "output_observation"
      && typeof c.execution_id === "string" && c.execution_id) {
      const observation = outputObservation(c.data);
      if (observation) outputs.set(c.execution_id, observation);
    }
    if (c.type !== "usage" || typeof c.execution_id !== "string" || !c.execution_id || !c.usage) continue;
    const u = c.usage;
    if (![u.input_tokens, u.output_tokens, u.cache_read_input_tokens].every(n => Number.isSafeInteger(n) && n >= 0)) continue;
    // Transport sends cumulative snapshots per execution; count each once.
    usages.set(c.execution_id, { execution_id: c.execution_id, input_tokens: u.input_tokens,
      output_tokens: u.output_tokens, cache_read_input_tokens: u.cache_read_input_tokens,
      duration_ms: Number.isFinite(c.duration_ms) && c.duration_ms >= 0 ? c.duration_ms : null,
      finish_reason: typeof c.finish_reason === "string" ? c.finish_reason.slice(0, 128) : null });
  }
  const attempts = [...usages.values()].map(attempt => ({ ...attempt,
    output_observation: outputs.get(attempt.execution_id) ?? null }));
  const confirmedTruncation = diagnostic?.failure_category === "provider_output_truncated"
    && attempts.length > 0 && /^(?:max[-_ ]?tokens|length)$/i.test(attempts.at(-1)?.finish_reason ?? "");
  const evidence = { node_id: nodeId, session_id: session.session_id, round_id: roundId,
    outcome: confirmedTruncation ? "output_truncated" : "unknown", diagnostic: diagnostic ?? null,
    error: typeof error === "string" ? error.slice(0, 4000) : "Model failed without a retained error message",
    attempts, usage_status: attempts.length ? "reported_execution_snapshots" : "unknown" };
  return { ...evidence, artifact_sha256: e2eFixDigest(JSON.stringify(evidence)) };
}
