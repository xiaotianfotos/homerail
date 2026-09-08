import { isDeepStrictEqual } from "node:util";
import type { PersistedRunSnapshot } from "../persistence/types.js";
import { e2eFixDigest } from "./e2e-fix-candidates.js";

type Identity = { run_id: string; node_id: string; session_id: string; round_id: string };
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 512;
const hash = (value: unknown) => e2eFixDigest(JSON.stringify(value));

/** An admitted aggregation recovery may already own pre-runtime role files.
 * Revalidate every old field against current native evidence before retaining
 * their bytes. The new runtime projection is stored separately by the caller. */
export function verifyLegacyE2eFixModelArtifact(original: Record<string, any>, current: Record<string, any>, legacyModel: string | null) {
  const { runtime: _, ...rest } = current;
  const expected = { ...rest, model: legacyModel,
    artifact_sha256: hash({ node: current.node_id, session: current.session_id, value: current.value }) };
  if (original.runtime !== undefined || !isDeepStrictEqual(original, expected)) throw new Error("legacy model artifact differs from native evidence");
  return original;
}

/** The sent envelope records the resolved runtime, whereas graph aliases and
 * current LLM settings do not establish historical identity. This is evidence
 * of Manager dispatch selection, not provider attestation of its served model.
 * Copy only non-secret runtime fields; full prompts remain in their own store. */
export function readE2eFixModelRuntime(snapshot: PersistedRunSnapshot, identity: Identity) {
  if (snapshot.metadata.runId !== identity.run_id) throw new Error("model runtime root mismatch");
  const entries = snapshot.chats[identity.node_id] ?? [];
  const prompts = entries.filter(entry => {
    const c = entry.content as Record<string, any> | undefined;
    return entry.role === "manager" && entry.type === "prompt" && c
      && c.runId === identity.run_id && c.nodeId === identity.node_id && c.sessionId === identity.session_id
      && c.activity?.roundId === identity.round_id;
  });
  if (!prompts.length) return { status: "unknown" as const, source: "manager_dispatch" as const };
  const records = prompts.map(entry => {
    const c = entry.content as Record<string, any>;
    const agent = c.agentConfig;
    const runtime = { agent_type: agent?.agent_type, provider: agent?.llm?.provider,
      model: agent?.llm?.model ?? agent?.model };
    if (!Object.values(runtime).every(text) || !text(entry.targetId)
      || !Number.isSafeInteger(c.activity.generation) || c.activity.generation < 1
      || !Number.isSafeInteger(c.activity.leaseGeneration) || c.activity.leaseGeneration < 1) {
      throw new Error("incomplete model dispatch runtime evidence");
    }
    return { runtime: runtime as { agent_type: string; provider: string; model: string },
      target_id: entry.targetId, generation: c.activity.generation as number,
      lease_generation: c.activity.leaseGeneration as number, prompt_sha256: hash(c) };
  });
  if (records.some(r => !isDeepStrictEqual(r.runtime, records[0].runtime))) throw new Error("conflicting model dispatch runtimes in one session");
  const usages = (snapshot.usages ?? []).filter(u => u.nodeId === identity.node_id && u.scope?.session_id === identity.session_id);
  const executions = usages.map(usage => {
    const scope = usage.scope;
    if (usage.runId !== identity.run_id || scope?.round_id !== identity.round_id || !text(scope.execution_id)) {
      throw new Error("model runtime usage scope mismatch");
    }
    const responses = entries.filter(entry => {
      const c = entry.content as Record<string, any> | undefined;
      return entry.role === "worker" && entry.type === "response" && c
        && ["usage", "agent_debug"].includes(c.type) && c.run_id === identity.run_id && c.node_id === identity.node_id
        && c.session_id === identity.session_id && c.round_id === identity.round_id
        && c.execution_id === scope.execution_id && c.generation === scope.generation;
    });
    const matching = records.filter(r => r.generation === scope.generation && responses.some(entry => {
      const c = entry.content as Record<string, any>;
      return entry.targetId === r.target_id && c.lease_generation === r.lease_generation;
    }));
    if (!matching.length) throw new Error("model execution lacks matching dispatched runtime");
    return { execution_id: scope.execution_id, generation: scope.generation,
      dispatch_sha256: [...new Set(matching.map(r => r.prompt_sha256))] };
  });
  // A dispatch record alone is not evidence that a model execution occurred.
  if (!executions.length) return { status: "unknown" as const, source: "manager_dispatch" as const };
  const evidence = { source: "manager_dispatch" as const, identity, ...records[0].runtime,
    executions, prompt_sha256: [...new Set(records.map(r => r.prompt_sha256))] };
  return { status: "verified_dispatch" as const, ...evidence, artifact_sha256: hash(evidence) };
}
