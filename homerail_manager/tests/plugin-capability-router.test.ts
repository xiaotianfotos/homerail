import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { homerailPluginTurnContextDigestInput } from "homerail-protocol";
import type { PluginPermissionGrantRecord, PluginRegistryState } from "../src/persistence/plugins.js";
import { closeDb } from "../src/persistence/db.js";
import { getPluginRegistryState } from "../src/persistence/plugins.js";
import { compilePluginCapabilityIndex } from "../src/plugins/capability-index.js";
import { routePluginCapabilities } from "../src/plugins/capability-router.js";
import { assemblePluginTurnContext } from "../src/plugins/context-assembler.js";
import { pluginJsonDigest } from "../src/plugins/descriptor.js";
import { syncBuiltinPlugins } from "../src/plugins/registry.js";

const TOPIC_CAPABILITY = "com.homerail.topic-outline:compose-outline";

const ROUTING_FIXTURES = {
  positive: {
    utterance: "create a topic outline",
    modality: "voice",
    inputs: { title: "Capability Router" },
  },
  negative: {
    utterance: "what will the weather be tomorrow",
    modality: "voice",
  },
  missing_input: {
    utterance: "create a topic outline",
    modality: "voice",
  },
  explicit: {
    utterance: "do the requested thing",
    modality: "voice",
    inputs: { title: "Explicit" },
    explicit_plugin_id: "com.homerail.topic-outline",
    explicit_capability_id: "compose-outline",
  },
} as const;

function clonedState(): PluginRegistryState {
  return structuredClone(getPluginRegistryState());
}

function topicPlugin(state: PluginRegistryState): PluginRegistryState["plugins"][number] {
  return state.plugins.find((plugin) => plugin.plugin_id === "com.homerail.topic-outline")!;
}

describe("Plugin Capability Index and deterministic Top-K Router", () => {
  let previousHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    closeDb();
    previousHome = process.env.HOMERAIL_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-capability-router-"));
    process.env.HOMERAIL_HOME = tmpHome;
    syncBuiltinPlugins();
  });

  afterEach(() => {
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("compiles a compact, ordered, replayable index and excludes disabled or incompatible plugins", () => {
    const first = compilePluginCapabilityIndex();
    const second = compilePluginCapabilityIndex();
    expect(second).toEqual(first);
    expect(first.entries.map((entry) => entry.qualified_id)).toEqual([
      "com.homerail.core:voice-generative-ui",
      "com.homerail.pr-closeout:summarize-pr-closeout",
      TOPIC_CAPABILITY,
    ]);
    expect(first.entries[2]).toMatchObject({
      plugin_version: "1.0.0",
      required_inputs: ["title"],
      skill: {
        qualified_id: "com.homerail.topic-outline:topic-outline",
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      operations: [expect.objectContaining({
        qualified_id: "com.homerail.topic-outline:upsert_topic_outline",
        input_schema_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        output_schema_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      })],
    });
    expect(JSON.stringify(first.entries)).not.toContain("# Topic Outline");
    expect(first.index_digest).toMatch(/^[a-f0-9]{64}$/);

    const disabled = clonedState();
    topicPlugin(disabled).activation.enabled = false;
    expect(compilePluginCapabilityIndex(disabled).entries.map((entry) => entry.qualified_id))
      .not.toContain(TOPIC_CAPABILITY);

    const incompatible = clonedState();
    topicPlugin(incompatible).descriptor.manifest.compatibility.homerail.max_exclusive = "0.1.0";
    expect(compilePluginCapabilityIndex(incompatible).entries.map((entry) => entry.qualified_id))
      .not.toContain(TOPIC_CAPABILITY);
  });

  it("routes positive intent, preserves negative and missing-input evidence, and loads selected assets only", () => {
    const positive = routePluginCapabilities(ROUTING_FIXTURES.positive);
    expect(positive.candidates[0]).toMatchObject({
      qualified_id: TOPIC_CAPABILITY,
      status: "ready",
      selection: "selected",
    });
    expect(positive.selected).toEqual([expect.objectContaining({
      capability_id: TOPIC_CAPABILITY,
      plugin_version: "1.0.0",
      manifest_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      package_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      skill_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      operation_schema_digests: [
        expect.stringMatching(/^[a-f0-9]{64}$/),
        expect.stringMatching(/^[a-f0-9]{64}$/),
      ],
    })]);
    expect(positive.selected_context.enabled_plugins.map((plugin) => plugin.id))
      .toEqual(["com.homerail.topic-outline"]);
    expect(positive.selected_context.skills.map((skill) => skill.qualified_id))
      .toEqual(["com.homerail.topic-outline:topic-outline"]);
    expect(positive.selected_context.tools.map((tool) => tool.qualified_id))
      .toEqual(["com.homerail.topic-outline:upsert_topic_outline"]);
    expect(positive.prompt_context.skills[0].content).toContain("# Topic Outline");
    expect(positive.prompt_bytes).toBeLessThanOrEqual(positive.prompt_byte_budget);

    const replay = routePluginCapabilities(ROUTING_FIXTURES.positive);
    expect(replay).toEqual(positive);
    expect(replay.replay.result_digest).toMatch(/^[a-f0-9]{64}$/);

    const negative = routePluginCapabilities(ROUTING_FIXTURES.negative);
    expect(negative.candidates).toEqual([]);
    expect(negative.selected).toEqual([]);
    expect(negative.prompt_bytes).toBe(0);

    const missing = routePluginCapabilities(ROUTING_FIXTURES.missing_input);
    expect(missing.candidates[0]).toMatchObject({
      qualified_id: TOPIC_CAPABILITY,
      status: "needs_input",
      missing_inputs: ["title"],
      selection: "blocked",
    });
    expect(missing.selected_context.skills).toEqual([]);
    expect(missing.selected_context.tools).toEqual([]);
  });

  it("routes PR readiness requests to the closeout Skill and projection Tool", () => {
    const routed = routePluginCapabilities({
      utterance: "判断这个 PR 是否可以合并并整理验证证据",
      modality: "text",
      inputs: {
        repository: "xiaotianfotos/homerail",
        pr_number: 21,
        recommendation: "blocked",
      },
    });
    expect(routed.selected.map((entry) => entry.capability_id))
      .toEqual(["com.homerail.pr-closeout:summarize-pr-closeout"]);
    expect(routed.selected_context.enabled_plugins.map((plugin) => plugin.id))
      .toEqual(["com.homerail.pr-closeout"]);
    expect(routed.selected_context.skills.map((skill) => skill.qualified_id))
      .toEqual(["com.homerail.pr-closeout:pr-closeout"]);
    expect(routed.selected_context.tools.map((tool) => tool.qualified_id))
      .toEqual(["com.homerail.pr-closeout:upsert_pr_closeout"]);
    expect(routed.prompt_context.skills[0].content).toContain("# PR Closeout");
  });

  it("honors explicit plugin/capability and modality while reporting unavailable disabled targets", () => {
    const explicit = routePluginCapabilities(ROUTING_FIXTURES.explicit);
    expect(explicit.candidates).toHaveLength(1);
    expect(explicit.selected.map((entry) => entry.capability_id)).toEqual([TOPIC_CAPABILITY]);
    expect(explicit.signals.explicit_target_unavailable).toBe(false);

    const wrongModality = routePluginCapabilities({
      ...ROUTING_FIXTURES.explicit,
      modality: "text",
    });
    expect(wrongModality.candidates).toEqual([]);
    expect(wrongModality.signals.explicit_target_unavailable).toBe(true);

    const disabled = clonedState();
    topicPlugin(disabled).activation.enabled = false;
    const unavailable = routePluginCapabilities(ROUTING_FIXTURES.explicit, disabled, {
      permission_revision: 0,
    });
    expect(unavailable.candidates).toEqual([]);
    expect(unavailable.signals.explicit_target_unavailable).toBe(true);
    expect(unavailable.selected_context.enabled_plugins).toEqual([]);
  });

  it("retains unauthorized candidates as needs_grant and selects the same snapshot once granted", () => {
    const state = clonedState();
    topicPlugin(state).descriptor.manifest.permissions.required = [{ permission: "workspace.read" }];
    const grant = (status: PluginPermissionGrantRecord["status"]): PluginPermissionGrantRecord => ({
      plugin_id: "com.homerail.topic-outline",
      plugin_version: "1.0.0",
      permission: "workspace.read",
      declaration: { required: true },
      status,
      revision: 2,
      updated_at: "2026-07-12T00:00:00.000Z",
    });
    const denied = routePluginCapabilities(ROUTING_FIXTURES.positive, state, {
      grants: [grant("denied")],
      permission_revision: 7,
    });
    expect(denied.candidates[0]).toMatchObject({
      qualified_id: TOPIC_CAPABILITY,
      status: "needs_grant",
      missing_grants: ["workspace.read"],
      denied_permissions: ["workspace.read"],
      selection: "blocked",
    });
    expect(denied.selected).toEqual([]);

    const granted = routePluginCapabilities(ROUTING_FIXTURES.positive, state, {
      grants: [grant("granted")],
      permission_revision: 8,
    });
    expect(granted.candidates[0]).toMatchObject({ status: "ready", selection: "selected" });
    expect(granted.permission_revision).toBe(8);
    expect(granted.selected_context.permission_revision).toBe(8);
    expect(granted.index_digest).not.toBe(denied.index_digest);
  });

  it("signals ambiguous side-effect conflicts until a capability is explicit", () => {
    const state = clonedState();
    const manifest = topicPlugin(state).descriptor.manifest;
    const original = manifest.capabilities[0];
    manifest.capabilities.push({ ...structuredClone(original), id: "compose-outline-alternate" });

    const ambiguous = routePluginCapabilities(ROUTING_FIXTURES.positive, state, {
      permission_revision: 0,
    });
    expect(ambiguous.signals).toMatchObject({
      ambiguous: true,
      side_effect_conflict: true,
      clarification_required: true,
    });
    expect(ambiguous.signals.ambiguity_capability_ids).toEqual([
      TOPIC_CAPABILITY,
      "com.homerail.topic-outline:compose-outline-alternate",
    ]);
    expect(ambiguous.selected).toEqual([]);
    expect(ambiguous.candidates.map((candidate) => candidate.selection))
      .toEqual(["clarification_required", "clarification_required"]);

    const explicit = routePluginCapabilities({
      ...ROUTING_FIXTURES.positive,
      explicit_capability_id: TOPIC_CAPABILITY,
    }, state, { permission_revision: 0 });
    expect(explicit.signals.ambiguous).toBe(false);
    expect(explicit.selected.map((entry) => entry.capability_id)).toEqual([TOPIC_CAPABILITY]);
  });

  it("enforces Top-K and prompt byte budgets without partial Skill/Tool exposure", () => {
    const coreState = clonedState();
    const core = coreState.plugins.find((plugin) => plugin.plugin_id === "com.homerail.core")!;
    core.descriptor.manifest.capabilities[0].tools = [];
    const original = core.descriptor.manifest.capabilities[0];
    core.descriptor.manifest.capabilities.push({ ...structuredClone(original), id: "voice-generative-ui-alt" });
    const topK = routePluginCapabilities({
      utterance: "remember evolving task requirements",
      modality: "voice",
      top_k: 1,
    }, coreState, { permission_revision: 0 });
    expect(topK.signals.ambiguous).toBe(true);
    expect(topK.signals.side_effect_conflict).toBe(false);
    expect(topK.selected).toHaveLength(1);
    expect(topK.truncated_by_top_k).toBe(true);

    const baseline = routePluginCapabilities(ROUTING_FIXTURES.positive);
    expect(baseline.prompt_bytes).toBeGreaterThan(1);
    const bounded = routePluginCapabilities({
      ...ROUTING_FIXTURES.positive,
      prompt_byte_budget: baseline.prompt_bytes - 1,
    });
    expect(bounded.selected).toEqual([]);
    expect(bounded.selected_context.skills).toEqual([]);
    expect(bounded.selected_context.tools).toEqual([]);
    expect(bounded.prompt_bytes).toBe(0);
    expect(bounded.prompt_bytes).toBeLessThanOrEqual(bounded.prompt_byte_budget);
    expect(bounded.truncated_by_budget).toBe(true);
    expect(bounded.candidates[0].selection).toBe("budget_excluded");
  });

  it("rejects a self-digested source context that is not owned by the live registry", () => {
    const source = assemblePluginTurnContext(undefined, { modality: "voice" });
    const forged = structuredClone(source);
    const tool = forged.tools.find((entry) => entry.plugin_id === "com.homerail.topic-outline")!;
    tool.description = `${tool.description} forged prompt instructions`;
    forged.context_digest = pluginJsonDigest(homerailPluginTurnContextDigestInput(forged));
    expect(() => routePluginCapabilities(ROUTING_FIXTURES.positive, undefined, {
      source_context: forged,
    })).toThrow(/not owned by the current registry/);
  });
});
