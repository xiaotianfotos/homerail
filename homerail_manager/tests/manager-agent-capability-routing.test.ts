import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildHrpArchive,
  buildSignedHrpArchive,
  buildSignedPluginRegistryIndex,
  scanPluginSource,
  sourceFilesForPack,
} from "homerail-plugin-sdk";
import type { GenerativeUiCanvasContextV1 } from "homerail-protocol";

const captured = vi.hoisted(() => ({
  host: [] as Array<Record<string, unknown>>,
  host_stream: [] as Array<Record<string, unknown>>,
  container: [] as Array<Record<string, unknown>>,
  host_shell: [] as Array<Record<string, unknown>>,
  continuation_records: [] as Array<Record<string, unknown>>,
  continuation_acks: [] as string[],
  continuation_releases: [] as string[],
}));

vi.mock("../src/persistence/plugin-tool-continuations.js", () => ({
  leasePluginAgentToolContinuations: () => captured.continuation_records.length
    ? { lease_id: "continuation_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", records: captured.continuation_records }
    : { records: [] },
  acknowledgePluginAgentToolContinuationLease: (leaseId: string) => {
    captured.continuation_acks.push(leaseId);
    return 1;
  },
  releasePluginAgentToolContinuationLease: (leaseId: string) => {
    captured.continuation_releases.push(leaseId);
    return 1;
  },
}));

vi.mock("../src/server/manager-agent-container.js", () => ({
  ensureManagerAgentContainer: async () => ({
    containerId: "container-test",
    nodeId: "node-test",
    baseUrl: "http://127.0.0.1:39001",
    containerName: "manager-agent-container-test",
  }),
  forwardChatToManagerAgentContainer: async (_container: unknown, payload: Record<string, unknown>) => {
    captured.container.push(structuredClone(payload));
    return { text: "container result" };
  },
}));

vi.mock("../src/server/host-shell-manager-agent.js", () => ({
  ensureHostShellManagerAgent: async () => ({
    processId: 123,
    baseUrl: "http://127.0.0.1:59001",
    workerId: "host-shell-test",
    processName: "manager-agent-host-test",
  }),
  forwardChatToHostShellManagerAgent: async (_agent: unknown, payload: Record<string, unknown>) => {
    captured.host_shell.push(structuredClone(payload));
    return { text: "host-shell result" };
  },
}));

vi.mock("../src/server/host-codex-manager-agent.js", () => ({
  HostCodexManagerAgentExecutionError: class extends Error {},
  loadVoiceSystemContract: () => ({ prompt: "voice test", source: "test" }),
  runHostCodexManagerAgentTurn: async (input: Record<string, unknown>) => {
    captured.host.push(structuredClone(input));
    if (String(input.message).includes("force-host-failure")) throw new Error("forced host failure");
    return { text: "host result", worker_id: "host-codex", container_name: null };
  },
  runHostCodexManagerAgentTurnStream: async function* (input: Record<string, unknown>) {
    captured.host_stream.push(structuredClone(input));
    yield { type: "result", result: { text: "host stream result", worker_id: "host-codex" } };
  },
}));

import type { ManagerAgentRuntimeConfig } from "../src/server/manager-agent-container.js";
import { closeDb } from "../src/persistence/db.js";
import { assemblePluginTurnContext, selectPluginTurnContext } from "../src/plugins/context-assembler.js";
import { installHrpArchive } from "../src/plugins/package-lifecycle.js";
import { setPluginEnabled } from "../src/persistence/plugins.js";
import {
  setPluginPublisherTrust,
  setPluginPublisherTrustAndRevokePackages,
} from "../src/persistence/plugin-distribution.js";
import {
  configureRemotePluginRegistry,
  enableRemotePluginRegistryRelease,
  installRemotePluginRegistryRelease,
  syncRemotePluginRegistryIndex,
} from "../src/plugins/remote-registry.js";
import { syncBuiltinPlugins } from "../src/plugins/registry.js";
import {
  resolveManagerAgentTurnAssets,
  runManagerAgentTurn,
  runManagerAgentTurnStream,
} from "../src/server/manager-agent-runtime.js";

function runtimeConfig(runtime_placement: "host" | "host_shell" | "container"): ManagerAgentRuntimeConfig {
  return {
    provider_name: "test",
    model: "test-model",
    api_key: "test-key",
    base_url: "http://127.0.0.1:1",
    agent_type: runtime_placement === "host" ? "codex_appserver" : "claude-sdk",
    runtime_placement,
    service_tier: null,
  };
}

function pluginSkillIds(payload: Record<string, unknown>): string[] {
  return ((payload.manager_skills ?? []) as Array<{ id: string; source: string }>)
    .filter((skill) => skill.source === "plugin")
    .map((skill) => skill.id);
}

function pluginContext(payload: Record<string, unknown>) {
  return payload.plugin_context as ReturnType<typeof assemblePluginTurnContext>;
}

function writeHomeSkill(
  home: string,
  id: string,
  description: string,
  body = "# Test Skill\n\nLOCAL_SKILL_BODY_LOADED",
): void {
  const root = path.join(home, "skills", id);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "SKILL.md"),
    `---\nname: ${id}\ndescription: ${description}\n---\n\n${body}\n`,
    "utf8",
  );
}

function writeHomeSkillA2uiTemplate(home: string, id: string): void {
  const root = path.join(home, "skills", id, "assets", "homerail");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "view-templates.json"), JSON.stringify({
    manifest_version: 1,
    templates: [{
      id: "result",
      description: "Show a compact visual result.",
      data_schema: {
        type: "object",
        properties: { title: { type: "string", minLength: 1, maxLength: 200 } },
        required: ["title"],
        additionalProperties: false,
      },
      a2ui: {
        version: "v1.0",
        catalogId: "https://homerail.dev/a2ui/catalogs/core/v1",
        components: [{ id: "root", component: "Text", text: { path: "/data/title" } }],
      },
      defaults: {
        surface: "result",
        importance: "primary",
        density: "summary",
        canvas_size: "1x1",
        persistence: "session",
      },
    }],
  }), "utf8");
}

describe("Manager Agent per-turn capability routing", () => {
  let previousHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    closeDb();
    previousHome = process.env.HOMERAIL_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-manager-routing-"));
    process.env.HOMERAIL_HOME = tmpHome;
    syncBuiltinPlugins();
    captured.host.length = 0;
    captured.host_stream.length = 0;
    captured.container.length = 0;
    captured.host_shell.length = 0;
    captured.continuation_records.length = 0;
    captured.continuation_acks.length = 0;
    captured.continuation_releases.length = 0;
  });

  afterEach(() => {
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("delivers the same selected Skill/Tool snapshot to host, host-shell, and container", async () => {
    const turn = {
      message: "create a topic outline",
      response_mode: "voice" as const,
      generative_ui_mode: "prefer" as const,
      voice_session_id: "capability-routing-session",
      plugin_routing: { inputs: { title: "Runtime parity" } },
    };
    const host = await runManagerAgentTurn({ ...turn, agent_config: runtimeConfig("host") });
    const hostShell = await runManagerAgentTurn(
      { ...turn, agent_config: runtimeConfig("host_shell") },
      { managerRestUrl: "http://127.0.0.1:3000" },
    );
    const container = await runManagerAgentTurn(
      { ...turn, agent_config: runtimeConfig("container") },
      { managerRestUrl: "http://127.0.0.1:3000" },
    );

    const hostContext = pluginContext(captured.host[0]);
    expect(pluginContext(captured.host_shell[0])).toEqual(hostContext);
    expect(pluginContext(captured.container[0])).toEqual(hostContext);
    expect(host.plugin_context).toEqual(hostContext);
    expect(hostShell.plugin_context).toEqual(hostContext);
    expect(container.plugin_context).toEqual(hostContext);
    expect(hostContext.enabled_plugins.map((plugin) => plugin.id)).toEqual([
      "com.homerail.core",
      "com.homerail.topic-outline",
    ]);
    expect(hostContext.skills.map((skill) => skill.qualified_id)).toEqual([
      "com.homerail.core:voice-generative-ui",
      "com.homerail.topic-outline:topic-outline",
    ]);
    expect(hostContext.tools.map((tool) => tool.qualified_id)).toEqual([
      "com.homerail.core:upsert_generated_view",
      "com.homerail.topic-outline:upsert_topic_outline",
    ]);
    expect(pluginSkillIds(captured.host[0])).toEqual([
      "com.homerail.core:voice-generative-ui",
      "com.homerail.topic-outline:topic-outline",
    ]);
    const deliveredSkills = captured.host[0].manager_skills as Array<{ id: string; content?: string }>;
    expect(deliveredSkills.find((skill) => skill.id === "com.homerail.core:voice-generative-ui")?.content)
      .toContain("# Voice Generative UI");
    expect(captured.host_shell[0].manager_skills).toEqual(captured.host[0].manager_skills);
    expect(captured.container[0].manager_skills).toEqual(captured.host[0].manager_skills);
    expect(pluginSkillIds(captured.host_shell[0])).toEqual(pluginSkillIds(captured.host[0]));
    expect(pluginSkillIds(captured.container[0])).toEqual(pluginSkillIds(captured.host[0]));
    expect(captured.container[0]).not.toHaveProperty("plugin_routing");
    for (const payload of [captured.host[0], captured.host_shell[0], captured.container[0]]) {
      const token = payload.plugin_tool_turn_token;
      expect(token).toMatch(/^hrtoolturn1\./);
      expect(JSON.stringify(payload.plugin_context)).not.toContain(String(token));
      expect(JSON.stringify(payload.manager_skills)).not.toContain(String(token));
      expect(JSON.stringify(payload.voice_system_contract ?? null)).not.toContain(String(token));
      expect(JSON.stringify(payload.voice_ui_rules ?? null)).not.toContain(String(token));
    }
  });

  it("injects leased confirmed Tool results once and releases the lease on Agent failure", async () => {
    captured.continuation_records.push({
      scope: { type: "voice_session", id: "continuation-session" },
      status: "leased",
      delivery_attempts: 1,
      created_at: "2026-07-11T00:00:00.000Z",
      payload: {
        continuation_version: 1,
        request_id: "tool_continuation_request_001",
        request_digest: "a".repeat(64),
        call_id: "call_continuation_request_001",
        plugin: { id: "com.homerail.topic-outline", version: "1.0.0" },
        tool: {
          local_id: "compose_outline",
          qualified_id: "com.homerail.topic-outline:compose_outline",
          wire_id: "p_continuation_compose_outline",
        },
        status: "committed",
        confirmation: "approved",
        result: { output_type: "domain_result", summary: "confirmed result" },
        completed_at: "2026-07-11T00:00:01.000Z",
      },
    });
    await runManagerAgentTurn({
      message: "continue the confirmed work",
      response_mode: "voice",
      generative_ui_mode: "prefer",
      voice_session_id: "continuation-session",
      agent_config: runtimeConfig("host"),
    });
    expect(captured.host.at(-1)?.message).toContain("homerail_plugin_tool_continuations");
    expect(captured.host.at(-1)?.message).toContain("tool_continuation_request_001");
    expect(captured.host.at(-1)?.message).toContain("continue the confirmed work");
    expect(captured.continuation_acks).toEqual(["continuation_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
    expect(captured.continuation_releases).toEqual([]);

    captured.continuation_acks.length = 0;
    await expect(runManagerAgentTurn({
      message: "force-host-failure",
      response_mode: "voice",
      generative_ui_mode: "prefer",
      voice_session_id: "continuation-session",
      agent_config: runtimeConfig("host"),
    })).rejects.toThrow(/forced host failure/);
    expect(captured.continuation_acks).toEqual([]);
    expect(captured.continuation_releases).toEqual(["continuation_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
  });

  it("keeps a zero-match turn empty and strips caller-supplied unmatched Plugin skills", async () => {
    const callerSkills = [{
      id: "local-test",
      name: "Local test",
      description: "local",
      relative_path: "skills/local-test/SKILL.md",
      source: "home" as const,
      enabled: true as const,
    }, {
      id: "com.example.unmatched:rogue",
      name: "Rogue",
      description: "must not leak",
      relative_path: "plugin://com.example.unmatched@1.0.0/skills/rogue",
      source: "plugin" as const,
      enabled: true as const,
      plugin_id: "com.example.unmatched",
      plugin_version: "1.0.0",
      digest: "0".repeat(64),
    }];
    const turn = {
      message: "what will the weather be tomorrow",
      response_mode: "voice" as const,
      manager_skills: callerSkills,
    };
    await runManagerAgentTurn({ ...turn, agent_config: runtimeConfig("host") });
    await runManagerAgentTurn(
      { ...turn, agent_config: runtimeConfig("container") },
      { managerRestUrl: "http://127.0.0.1:3000" },
    );

    for (const payload of [captured.host[0], captured.container[0]]) {
      expect(pluginContext(payload)).toMatchObject({
        enabled_plugins: [],
        skills: [],
        tools: [],
        actions: [],
      });
      expect(pluginSkillIds(payload)).toEqual([]);
      expect(payload).not.toHaveProperty("plugin_tool_turn_token");
      expect((payload.manager_skills as Array<{ id: string }>).map((skill) => skill.id)).toEqual(["local-test"]);
    }
    expect(pluginContext(captured.container[0])).toEqual(pluginContext(captured.host[0]));
  });

  it("preserves explicit legacy context while a routing source remains a strict capability boundary", () => {
    const full = assemblePluginTurnContext(undefined, { modality: "voice" });
    const legacy = resolveManagerAgentTurnAssets({
      message: "unmatched legacy turn",
      response_mode: "voice",
      agent_config: runtimeConfig("host"),
      plugin_context: full,
    });
    expect(legacy.route).toBeNull();
    expect(legacy.plugin_context).toStrictEqual(full);
    expect(legacy.plugin_context).not.toBe(full);
    expect(legacy.manager_skills.filter((skill) => skill.source === "plugin").map((skill) => skill.id)).toEqual([
      "com.homerail.core:voice-generative-ui",
      "com.homerail.pr-closeout:pr-closeout",
      "com.homerail.topic-outline:topic-outline",
    ]);

    const compatibilitySource = assemblePluginTurnContext(undefined, {
      modality: "voice",
      legacy_compatibility_mode: true,
    });
    const bounded = resolveManagerAgentTurnAssets({
      message: "create a topic outline",
      response_mode: "voice",
      agent_config: runtimeConfig("host"),
      plugin_routing: {
        inputs: { title: "Must remain unavailable" },
        source_context: compatibilitySource,
      },
    });
    expect(bounded.route?.signals.explicit_target_unavailable).toBe(false);
    expect(bounded.route?.candidates).toEqual([]);
    expect(bounded.plugin_context.skills).toEqual([]);
    expect(bounded.plugin_context.tools).toEqual([]);

    const tamperedSource = structuredClone(compatibilitySource);
    tamperedSource.skills[0].description = "tampered after assembly";
    expect(() => resolveManagerAgentTurnAssets({
      message: "remember evolving task requirements",
      response_mode: "voice",
      agent_config: runtimeConfig("host"),
      plugin_routing: { source_context: tamperedSource },
    })).toThrow(/digest verification/);
  });

  it("preloads a matching local Skill body for a short natural utterance", () => {
    writeHomeSkill(
      tmpHome,
      "palquery",
      "查询游戏资料与配种；典型短问包括“能配出什么”“怎么配”“适合干什么”。",
    );
    writeHomeSkillA2uiTemplate(tmpHome, "palquery");

    const routed = resolveManagerAgentTurnAssets({
      message: "空涡龙和妖焰灯能配出什么？",
      response_mode: "voice",
      generative_ui_mode: "prefer",
      voice_session_id: "natural-local-skill",
      agent_config: runtimeConfig("host"),
    });
    expect(routed.manager_skills.find((skill) => skill.id === "palquery")?.content)
      .toContain("LOCAL_SKILL_BODY_LOADED");
    expect(routed.manager_skills.find((skill) => skill.id === "palquery")?.view_templates)
      .toEqual([expect.objectContaining({
        id: "result",
        a2ui: expect.objectContaining({
          version: "v1.0",
          catalogId: "https://homerail.dev/a2ui/catalogs/core/v1",
        }),
      })]);
    expect(routed.manager_skills.find((skill) => skill.id === "palquery")?.view_templates?.[0])
      .not.toHaveProperty("view");

    const explicit = resolveManagerAgentTurnAssets({
      message: "阿努比斯怎么配？",
      response_mode: "voice",
      agent_config: runtimeConfig("host"),
      plugin_context: assemblePluginTurnContext(undefined, { modality: "voice" }),
    });
    expect(explicit.manager_skills.find((skill) => skill.id === "palquery")?.content)
      .toContain("LOCAL_SKILL_BODY_LOADED");
  });

  it("keeps local Skill preloading relevant and bounded", () => {
    writeHomeSkill(tmpHome, "alpha", "分析资料；典型短问包括“分析这些结果”。", "# Alpha\n\nalpha-body");
    writeHomeSkill(tmpHome, "beta", "整理资料；典型短问包括“分析这些结果”。", "# Beta\n\nbeta-body");
    writeHomeSkill(tmpHome, "gamma", "复核资料；典型短问包括“分析这些结果”。", "# Gamma\n\ngamma-body");
    writeHomeSkill(
      tmpHome,
      "oversized",
      "生成资料；典型短问包括“分析这些结果”。",
      `# Oversized\n\n${"x".repeat(30_001)}`,
    );

    const unrelated = resolveManagerAgentTurnAssets({
      message: "明天上海会下雨吗？",
      response_mode: "voice",
      agent_config: runtimeConfig("host"),
    });
    expect(unrelated.manager_skills.filter((skill) => skill.content)).toEqual([]);

    const matching = resolveManagerAgentTurnAssets({
      message: "帮我分析这些结果",
      response_mode: "voice",
      agent_config: runtimeConfig("host"),
    });
    expect(matching.manager_skills.filter((skill) => skill.content).map((skill) => skill.id)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(matching.manager_skills.find((skill) => skill.id === "gamma")?.content).toBeUndefined();
    expect(matching.manager_skills.find((skill) => skill.id === "oversized")?.content).toBeUndefined();
  });

  it("uses the same selected context for the host streaming path", async () => {
    const canvasContext: GenerativeUiCanvasContextV1 = {
      canvas_context_version: 1,
      document_id: "voice-canvas-stream",
      document_revision: 3,
      selected_node_id: "com.homerail.core:selected-card",
      nodes: [{
        id: "com.homerail.core:selected-card",
        revision: 2,
        kind: "com.homerail.core/generated_view",
        surface: "result",
        title: "Selected card",
        selected: true,
        content: { data: { status: "ready" } },
      }],
    };
    const events = [];
    for await (const event of runManagerAgentTurnStream({
      message: "remember evolving task requirements",
      response_mode: "voice",
      generative_ui_mode: "prefer",
      voice_session_id: "voice-session-stream",
      canvas_context: canvasContext,
      agent_config: runtimeConfig("host"),
    })) events.push(event);

    expect(captured.host_stream).toHaveLength(1);
    expect(captured.host_stream[0]?.canvas_context).toEqual(canvasContext);
    const context = pluginContext(captured.host_stream[0]);
    expect(context.enabled_plugins.map((plugin) => plugin.id)).toEqual(["com.homerail.core"]);
    expect(context.skills.map((skill) => skill.qualified_id)).toEqual([
      "com.homerail.core:voice-generative-ui",
    ]);
    expect(context.tools.map((tool) => tool.qualified_id)).toEqual([
      "com.homerail.core:upsert_generated_view",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "result",
      result: { plugin_context: context },
    });
  });

  it("always binds Core Generative UI in a prefer voice turn without relying on keyword routing", () => {
    const assets = resolveManagerAgentTurnAssets({
      message: "把这些发布数据整理得便于快速浏览",
      response_mode: "voice",
      generative_ui_mode: "prefer",
      voice_session_id: "voice-natural-dashboard",
      agent_config: runtimeConfig("host"),
    });
    expect(assets.plugin_context.skills.map((skill) => skill.qualified_id)).toContain(
      "com.homerail.core:voice-generative-ui",
    );
    expect(assets.plugin_context.tools.map((tool) => tool.qualified_id)).toContain(
      "com.homerail.core:upsert_generated_view",
    );
  });

  it("keeps runtime A2UI instructions but withholds its Tool when Generative UI is unbound", () => {
    const assets = resolveManagerAgentTurnAssets({
      message: "remember evolving task requirements",
      response_mode: "voice",
      agent_config: runtimeConfig("host"),
    });
    expect(assets.plugin_context.skills.map((skill) => skill.qualified_id)).toEqual([
      "com.homerail.core:voice-generative-ui",
    ]);
    expect(assets.plugin_context.tools).toEqual([]);
  });

  it("keeps installed Plugin instructions out of every same-UID Agent prompt path", async () => {
    const source = path.resolve(import.meta.dirname, "../../plugins/examples/release-notes");
    const snapshot = scanPluginSource(source);
    expect(snapshot.valid).toBe(true);
    const installed = installHrpArchive(buildHrpArchive(sourceFilesForPack(snapshot)).archive);
    setPluginEnabled(installed.package.plugin_id, true, {
      expected_revision: installed.activation.revision,
      expected_active_version: installed.package.plugin_version,
    });

    await expect(runManagerAgentTurn({
      message: "create release notes for version 1.2.3",
      response_mode: "voice",
      generative_ui_mode: "prefer",
      voice_session_id: "external-plugin-session",
      agent_config: runtimeConfig("host"),
      plugin_routing: {
        explicit_plugin_id: installed.package.plugin_id,
        explicit_capability_id: `${installed.package.plugin_id}:compose-release-notes`,
        inputs: { title: "Release notes", version: "1.2.3" },
      },
    })).rejects.toThrow(/trusted Registry HRP.*isolated container/);
    expect(captured.host).toHaveLength(0);

    const full = assemblePluginTurnContext(undefined, { modality: "voice" });
    const supplied = selectPluginTurnContext(full, [
      `${installed.package.plugin_id}:compose-release-notes`,
    ]);
    expect(() => resolveManagerAgentTurnAssets({
      message: "caller supplied archived Plugin context",
      response_mode: "voice",
      generative_ui_mode: "prefer",
      voice_session_id: "external-plugin-session",
      agent_config: runtimeConfig("container"),
      plugin_context: supplied,
    })).toThrow(/trusted Registry HRP.*isolated container/);
  });

  it("admits only an enabled trusted Registry HRP to an isolated container Agent turn", () => {
    const source = path.resolve(import.meta.dirname, "../../plugins/examples/release-notes");
    const publisherKeys = generateKeyPairSync("ed25519");
    const registryKeys = generateKeyPairSync("ed25519");
    const signed = buildSignedHrpArchive(sourceFilesForPack(scanPluginSource(source)), {
      publisher: "dev.homerail",
      private_key: publisherKeys.privateKey,
    });
    setPluginPublisherTrust({
      entry: {
        publisher: signed.signature.publisher,
        key_id: signed.signature.key_id,
        public_key_spki: signed.signature.public_key_spki,
        state: "trusted",
      },
      actor: "agent-trust-test",
    });
    const catalog = buildSignedPluginRegistryIndex({
      registry_id: "agent-trust.homerail",
      sequence: 1,
      issued_at: "2026-07-12T00:00:00.000Z",
      expires_at: "2026-07-13T00:00:00.000Z",
      releases: [{
        plugin_id: signed.lock.plugin.id,
        plugin_version: signed.lock.plugin.version,
        archive_path: "releases/release-notes-1.0.0.hrp",
        archive_digest: signed.archive_digest,
        payload_digest: signed.lock.payload_digest,
        publisher_key_id: signed.signature.key_id,
      }],
    }, { private_key: registryKeys.privateKey });
    configureRemotePluginRegistry({
      registry_id: "agent-trust.homerail",
      source_url: "https://registry.homerail.example/agent-trust.json",
      root_key_id: catalog.root_pin,
    });
    syncRemotePluginRegistryIndex({
      registry_id: "agent-trust.homerail",
      index_bytes: catalog.bytes,
      now: "2026-07-12T01:00:00.000Z",
    });
    const release = installRemotePluginRegistryRelease({
      registry_id: "agent-trust.homerail",
      plugin_id: signed.lock.plugin.id,
      plugin_version: signed.lock.plugin.version,
      archive: signed.archive,
      now: "2026-07-12T01:00:00.000Z",
    });
    enableRemotePluginRegistryRelease({
      registry_id: "agent-trust.homerail",
      plugin_id: signed.lock.plugin.id,
      expected_revision: release.installed.activation.revision,
      expected_active_version: signed.lock.plugin.version,
      now: "2026-07-12T01:00:00.000Z",
    });

    const full = assemblePluginTurnContext(undefined, { modality: "voice" });
    const supplied = selectPluginTurnContext(full, [
      `${signed.lock.plugin.id}:compose-release-notes`,
    ]);
    const isolated = resolveManagerAgentTurnAssets({
      message: "create trusted release notes",
      response_mode: "voice",
      generative_ui_mode: "prefer",
      voice_session_id: "trusted-registry-agent-session",
      agent_config: runtimeConfig("container"),
      plugin_context: supplied,
    });
    expect(isolated.plugin_context.enabled_plugins).toEqual([
      expect.objectContaining({ id: signed.lock.plugin.id, version: signed.lock.plugin.version }),
    ]);
    expect(() => resolveManagerAgentTurnAssets({
      message: "same package on same-UID host",
      response_mode: "voice",
      agent_config: runtimeConfig("host"),
      plugin_context: supplied,
    })).toThrow(/trusted Registry HRP.*isolated container/);

    setPluginPublisherTrustAndRevokePackages({
      entry: {
        publisher: signed.signature.publisher,
        key_id: signed.signature.key_id,
        public_key_spki: signed.signature.public_key_spki,
        state: "revoked",
      },
      expected_revision: 1,
      actor: "agent-trust-test",
      reason: "test revocation",
    });
    expect(() => resolveManagerAgentTurnAssets({
      message: "stale context after publisher revocation",
      response_mode: "voice",
      agent_config: runtimeConfig("container"),
      plugin_context: supplied,
    })).toThrow(/current registry|enabled|trusted Registry HRP/);
  });
});
