import { describe, expect, it } from "vitest";
import type { PersistedRunSnapshot } from "../src/persistence/types.js";
import { readE2eFixModelRuntime, verifyLegacyE2eFixModelArtifact } from "../src/runtime/e2e-fix-model-runtime.js";
import { e2eFixDigest } from "../src/runtime/e2e-fix-candidates.js";

const identity = { run_id: "root", node_id: "fix", session_id: "session", round_id: "round-0001" };
function fixture(): PersistedRunSnapshot {
  return { metadata: { runId: "root", agents: { fixer: { model: "changed-after-dispatch" } } }, chats: { fix: [
    { role: "manager", type: "prompt", targetId: "worker", timestamp: 1, content: {
      runId: "root", nodeId: "fix", sessionId: "session", agentConfig: {
        agent_type: "deepseek_harness", model: "unresolved-alias", llm: { provider: "local", model: "qwen",
          api_key: "private-key", base_url: "private-endpoint" } }, inputs: { secret: ["private-prompt"] },
      activity: { roundId: "round-0001", generation: 1, leaseGeneration: 2 } } },
    { role: "worker", type: "response", targetId: "worker", timestamp: 2, content: {
      ...identity, type: "usage", execution_id: "execution", generation: 1, lease_generation: 2 } },
  ] }, usages: [{ runId: "root", nodeId: "fix", scope: { session_id: "session", round_id: "round-0001",
    generation: 1, execution_id: "execution" }, usage: { input_tokens: 100, output_tokens: 10,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, timestamp: 2 }], events: [], handoffs: [],
  } as unknown as PersistedRunSnapshot;
}
describe("E2E Fix historical model dispatch identity", () => {
  it("uses the resolved sent runtime, not an alias or later graph configuration, without exposing prompts or credentials", () => {
    const result = readE2eFixModelRuntime(fixture(), identity);
    expect(result).toMatchObject({ status: "verified_dispatch", source: "manager_dispatch", model: "qwen",
      provider: "local", agent_type: "deepseek_harness", executions: [{ execution_id: "execution", generation: 1 }] });
    expect(JSON.stringify(result)).not.toMatch(/private-|changed-after|unresolved-alias/);
    expect(result).toHaveProperty("artifact_sha256", expect.stringMatching(/^[a-f0-9]{64}$/));
  });
  it.each(["runId", "nodeId", "sessionId"])("ignores a stale dispatch %s", key => {
    const snapshot = fixture(); (snapshot.chats.fix[0].content as any)[key] = "stale";
    expect(readE2eFixModelRuntime(snapshot, identity).status).toBe("unknown");
  });
  it("does not trust model-authored runtime claims or a dispatch without any execution evidence", () => {
    const snapshot = fixture(); snapshot.chats.fix[0].role = "worker";
    expect(readE2eFixModelRuntime(snapshot, identity).status).toBe("unknown");
    const noUsage = fixture(); noUsage.usages = [];
    expect(readE2eFixModelRuntime(noUsage, identity).status).toBe("unknown");
  });
  it.each(["session_id", "round_id", "execution_id", "generation", "lease_generation"])("rejects a stale Worker %s", key => {
    const snapshot = fixture(); (snapshot.chats.fix[1].content as any)[key] = "stale";
    expect(() => readE2eFixModelRuntime(snapshot, identity)).toThrow(/matching dispatched runtime/);
  });
  it("rejects a different physical target and incomplete runtime metadata", () => {
    const snapshot = fixture(); snapshot.chats.fix[1].targetId = "other-worker";
    expect(() => readE2eFixModelRuntime(snapshot, identity)).toThrow(/matching dispatched runtime/);
    const missing = fixture(); delete (missing.chats.fix[0].content as any).agentConfig.llm.provider;
    expect(() => readE2eFixModelRuntime(missing, identity)).toThrow(/incomplete/);
  });
  it("deduplicates identical prompt references but rejects model changes within a session", () => {
    const snapshot = fixture(); snapshot.chats.fix.push(structuredClone(snapshot.chats.fix[0]));
    expect(readE2eFixModelRuntime(snapshot, identity)).toHaveProperty("prompt_sha256", expect.arrayContaining([expect.any(String)]));
    const result = readE2eFixModelRuntime(snapshot, identity);
    if (result.status === "verified_dispatch") expect(result.prompt_sha256).toHaveLength(1);
    (snapshot.chats.fix[2].content as any).agentConfig.llm.model = "changed";
    expect(() => readE2eFixModelRuntime(snapshot, identity)).toThrow(/conflicting/);
  });
  it("binds both corrective executions when a new physical Worker retains the same selected model", () => {
    const snapshot = fixture(), prompt = structuredClone(snapshot.chats.fix[0]), response = structuredClone(snapshot.chats.fix[1]);
    prompt.targetId = response.targetId = "new-worker";
    (prompt.content as any).activity.leaseGeneration = 3;
    Object.assign(response.content as any, { execution_id: "correction", lease_generation: 3 });
    snapshot.chats.fix.push(prompt, response);
    const usage = structuredClone(snapshot.usages![0]); usage.scope!.execution_id = "correction"; snapshot.usages!.push(usage);
    const result = readE2eFixModelRuntime(snapshot, identity);
    expect(result).toHaveProperty("executions", expect.arrayContaining([
      expect.objectContaining({ execution_id: "execution" }), expect.objectContaining({ execution_id: "correction" }),
    ]));
  });
  it("retains a legacy role artifact only when its complete contents still match native evidence", () => {
    const current = { node_id: "review_a", session_id: "s", model: "qwen", value: { vote: "approve" },
      runtime: { status: "verified_dispatch" }, usages: [{ tokens: 100 }], artifact_sha256: "new" };
    const original = { node_id: "review_a", session_id: "s", model: null, value: current.value,
      usages: current.usages, artifact_sha256: e2eFixDigest(JSON.stringify({ node: "review_a", session: "s", value: current.value })) };
    expect(verifyLegacyE2eFixModelArtifact(original, current, null)).toBe(original);
    expect(original).not.toHaveProperty("runtime");
    expect(() => verifyLegacyE2eFixModelArtifact({ ...original, usages: [] }, current, null)).toThrow(/differs/);
    expect(() => verifyLegacyE2eFixModelArtifact({ ...original, model: "forged" }, current, null)).toThrow(/differs/);
  });
});
