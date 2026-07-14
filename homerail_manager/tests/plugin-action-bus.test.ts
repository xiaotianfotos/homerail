import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GenerativeUiActorType,
  HomerailPluginPermission,
  type GenerativeUiNodeV1,
  type HomerailPluginRuntimeExecutionOutputV1,
  type HomerailPluginToolInvocationV1,
} from "homerail-protocol";
import { PersistentGenerativeUiDocumentService } from "../src/generative-ui/persistent-document-service.js";
import { closeDb } from "../src/persistence/db.js";
import { getPluginToolRequest, listPluginToolEvents } from "../src/persistence/plugin-actions.js";
import {
  setPluginEnabled,
  setPluginGrantStatus,
  syncPluginPackage,
} from "../src/persistence/plugins.js";
import {
  PluginActionBus,
  PluginBuiltinToolRegistry,
} from "../src/plugins/action-bus.js";
import { PluginToolCapabilityTokenAuthority } from "../src/plugins/capability-token.js";
import { loadPluginPackage } from "../src/plugins/manifest-loader.js";
import { PluginRuntimeBroker, PluginRuntimeTransportRegistry } from "../src/plugins/runtime-broker.js";

const scope = { type: "voice_session", id: "action-session" } as const;
const pluginId = "com.example.action";
const pluginVersion = "1.0.0";
const nodeId = `${pluginId}:current`;

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeFixture(root: string): void {
  const inputSchema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      id: { type: "string", minLength: pluginId.length + 2, maxLength: 256 },
      content: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: 120 },
          status: { type: "string", enum: ["ready", "done"] },
        },
        required: ["title", "status"],
        additionalProperties: false,
      },
    },
    required: ["id", "content"],
    additionalProperties: false,
  };
  const contentSchema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, maxLength: 120 },
      status: { type: "string", enum: ["ready", "done"] },
    },
    required: ["title", "status"],
    additionalProperties: false,
  };
  writeJson(path.join(root, "schemas/action-input.schema.json"), inputSchema);
  writeJson(path.join(root, "schemas/content.schema.json"), contentSchema);
  writeJson(path.join(root, "ui/complete.json"), {
    projection_version: 1,
    type: "direct_ui_node",
    kind: `${pluginId}/card`,
    kind_version: 1,
    node_id_pointer: "/id",
    content_pointer: "/content",
    omit_content_fields: [],
    fallback: { title_pointer: "/content/title" },
    defaults: {
      surface: "task",
      importance: "primary",
      density: "detail",
      persistence: "session",
    },
  });
  fs.mkdirSync(path.join(root, "skills/action"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills/action/SKILL.md"), `---
name: action-card
description: Manage the deterministic Action Bus test card.
---

# Action card

Use the symbolic card action exposed by the current Generative UI node.
`, "utf8");
  writeJson(path.join(root, "homerail.plugin.json"), {
    manifest_version: 1,
    id: pluginId,
    version: pluginVersion,
    name: "Action Bus Fixture",
    publisher: { id: "com.example", name: "Example" },
    license: "MIT",
    compatibility: {
      homerail: { min: "0.1.0", max_exclusive: "0.2.0" },
      plugin_api: [1],
      ui_ir: [1],
      renderer_api: [1],
    },
    capabilities: [{
      id: "manage-card",
      summary: "Complete the current Action Bus card.",
      intents: ["complete current card"],
      tags: ["card", "complete"],
      modalities: ["voice", "touch", "gamepad"],
      required_inputs: [],
      skill: "action-card",
      tools: [],
      workflows: [],
      actions: ["complete"],
    }],
    skills: [{
      id: "action-card",
      path: "skills/action/SKILL.md",
      description: "Complete the current Action Bus card.",
    }],
    schemas: [
      { id: "action-input", file: "schemas/action-input.schema.json" },
      { id: "card-content", file: "schemas/content.schema.json" },
    ],
    kinds: [{
      kind: `${pluginId}/card`,
      current_version: 1,
      versions: [{
        version: 1,
        content_schema: "card-content",
        allowed_surfaces: ["task"],
        default_surface: "task",
        default_variant: "detail",
        max_content_bytes: 4096,
        preferred_visuals: ["card"],
        fallback: "portable_required",
        actions: ["complete"],
      }],
      migrations: [],
    }],
    tools: [{
      id: "complete_card",
      description: "Complete the selected card through an Action-bound Tool.",
      exposure: ["action"],
      input_schema: "action-input",
      output_schema: "card-content",
      effect: "write",
      permissions: [HomerailPluginPermission.ARTIFACT_WRITE],
      confirmation: "always",
      handler: { type: "projection", file: "ui/complete.json" },
    }],
    workflows: [],
    renderers: [],
    actions: [{
      id: "complete",
      intent: `${pluginId}.complete`,
      tool: "complete_card",
    }],
    runtime: { trust: "data_only", plugin_api: 1 },
    permissions: {
      required: [{ permission: HomerailPluginPermission.WORKSPACE_READ }],
      optional: [{ permission: HomerailPluginPermission.ARTIFACT_WRITE }],
    },
    state: { schema_version: 1, migrations: [] },
  });
}

function initialNode(): GenerativeUiNodeV1 {
  return {
    ir_version: 1,
    id: nodeId,
    kind: `${pluginId}/card`,
    kind_version: 1,
    owner: { id: pluginId, version: pluginVersion },
    surface: "task",
    importance: "primary",
    content: { title: "Review architecture", status: "ready" },
    lifecycle: { persistence: "session" },
    actions: [{
      id: "complete",
      label: "Complete",
      intent: `${pluginId}.complete`,
      arguments: {
        id: nodeId,
        content: { title: "Review architecture", status: "done" },
      },
      confirmation: { required: true, message: "Mark this architecture review complete?" },
    }],
    fallback: { title: "Review architecture" },
  };
}

describe("plugin Action Bus", () => {
  let previousHome: string | undefined;
  let home: string;
  let fixture: string;
  let documents: PersistentGenerativeUiDocumentService;
  let bus: PluginActionBus;
  let mode: "prefer" | "off";

  beforeEach(() => {
    closeDb();
    previousHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-action-bus-home-"));
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-action-bus-plugin-"));
    process.env.HOMERAIL_HOME = home;
    mode = "prefer";
    writeFixture(fixture);
    const descriptor = loadPluginPackage(fixture, { source: "builtin" });
    syncPluginPackage({ descriptor, source: "builtin", default_enabled: true });
    documents = new PersistentGenerativeUiDocumentService(() => []);
    documents.createOrGet({
      documentId: "action-document",
      scope,
      createdAt: new Date().toISOString(),
      purpose: "canonical",
    });
    const seeded = documents.apply({
      ir_version: 1,
      transaction_id: "seed-action-card",
      document_id: "action-document",
      base_revision: 0,
      actor: { type: GenerativeUiActorType.AGENT, id: "test" },
      operations: [{ op: "put", node: initialNode() }],
      created_at: new Date().toISOString(),
    }, scope);
    if (seeded.status !== "applied") throw new Error(`failed to seed Action node: ${JSON.stringify(seeded)}`);
    const tokens = new PluginToolCapabilityTokenAuthority(Buffer.alloc(32, 0x61));
    bus = new PluginActionBus({
      documents,
      tokens,
      runtime: new PluginRuntimeBroker({ tokens, transports: new PluginRuntimeTransportRegistry() }),
      builtins: new PluginBuiltinToolRegistry(),
      resolve_mode: () => mode,
    });
  });

  afterEach(() => {
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  function request(suffix: string, input: Record<string, unknown> = {}) {
    return {
      request_id: `action_request_${suffix}`,
      idempotency_key: `action_idempotency_${suffix}`,
      scope,
      document_id: "action-document",
      document_revision: 1,
      node_id: nodeId,
      node_revision: 1,
      action_id: "complete",
      input,
    };
  }

  function grantDefaultActionPermissions(): void {
    for (const permission of [
      HomerailPluginPermission.ARTIFACT_WRITE,
      HomerailPluginPermission.WORKSPACE_READ,
    ]) {
      setPluginGrantStatus({
        plugin_id: pluginId,
        plugin_version: pluginVersion,
        permission,
        status: "granted",
        expected_revision: 1,
        actor_type: "operator",
        actor_id: "action-test",
      });
    }
  }

  function createDeferredCommitRaceFixture(
    race: "mode" | "registry" | "permission",
    handlerType: "runtime" | "builtin",
    builtinThrowsAfterEffect = false,
  ) {
    const racePluginId = `com.example.commit-${race}`;
    const raceScope = { type: "voice_session", id: `commit-race-${race}` } as const;
    const raceDocumentId = `commit-race-document-${race}`;
    const raceNodeId = `${racePluginId}:current`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `homerail-commit-race-${race}-`));
    writeFixture(root);
    for (const relative of [
      "homerail.plugin.json",
      "schemas/action-input.schema.json",
      "schemas/content.schema.json",
      "ui/complete.json",
      "skills/action/SKILL.md",
    ]) {
      const file = path.join(root, relative);
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll(pluginId, racePluginId), "utf8");
    }
    const manifestFile = path.join(root, "homerail.plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
      tools: Array<{ id: string } & Record<string, unknown>>;
      runtime: Record<string, unknown>;
    };
    const tool = manifest.tools.find((candidate) => candidate.id === "complete_card")!;
    Object.assign(tool, {
      effect: "external",
      confirmation: "always",
      handler: handlerType === "runtime"
        ? { type: "runtime", method: "deferred_commit" }
        : { type: "builtin", id: "deferred-commit" },
    });
    manifest.runtime = { trust: "trusted_builtin", plugin_api: 1 };
    writeJson(manifestFile, manifest);
    const descriptor = loadPluginPackage(root, {
      source: "builtin",
      trusted_builtin_ids: new Set([racePluginId]),
    });
    syncPluginPackage({ descriptor, source: "builtin", default_enabled: true });
    for (const permission of [
      HomerailPluginPermission.ARTIFACT_WRITE,
      HomerailPluginPermission.WORKSPACE_READ,
    ]) {
      setPluginGrantStatus({
        plugin_id: racePluginId,
        plugin_version: pluginVersion,
        permission,
        status: "granted",
        expected_revision: 1,
        actor_type: "operator",
        actor_id: "commit-race-test",
      });
    }

    documents.createOrGet({
      documentId: raceDocumentId,
      scope: raceScope,
      createdAt: new Date().toISOString(),
      purpose: "canonical",
    });
    const node = structuredClone(initialNode());
    node.id = raceNodeId;
    node.kind = `${racePluginId}/card`;
    node.owner = { id: racePluginId, version: pluginVersion };
    node.actions![0]!.intent = `${racePluginId}.complete`;
    node.actions![0]!.arguments = {
      id: raceNodeId,
      content: { title: "Review architecture", status: "done" },
    };
    expect(documents.apply({
      ir_version: 1,
      transaction_id: `seed-commit-race-${race}`,
      document_id: raceDocumentId,
      base_revision: 0,
      actor: { type: GenerativeUiActorType.AGENT, id: "commit-race-test" },
      operations: [{ op: "put", node }],
      created_at: new Date().toISOString(),
    }, raceScope)).toMatchObject({ status: "applied", revision: 1 });

    let signalStarted!: () => void;
    const handlerStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    let releaseHandler!: () => void;
    const handlerGate = new Promise<void>((resolve) => { releaseHandler = resolve; });
    let dispatches = 0;
    let completedEffects = 0;
    const outputFor = (
      invocation: HomerailPluginToolInvocationV1,
    ): HomerailPluginRuntimeExecutionOutputV1 => {
      if (invocation.source.type !== "ui_action") throw new Error("expected UI Action source");
      return {
        type: "ui_transaction",
        transaction: {
          ir_version: 1,
          transaction_id: invocation.request_id,
          document_id: invocation.source.target.document_id,
          base_revision: invocation.source.target.document_revision,
          actor: {
            type: "plugin",
            id: invocation.tool.qualified_id,
            plugin: {
              id: invocation.binding.plugin_id,
              version: invocation.binding.plugin_version,
            },
          },
          operations: [{
            op: "remove",
            node_id: invocation.source.target.node_id,
            if_revision: invocation.source.target.node_revision,
          }],
          created_at: new Date().toISOString(),
        },
      };
    };

    const builtins = new PluginBuiltinToolRegistry();
    const transports = new PluginRuntimeTransportRegistry();
    if (handlerType === "builtin") {
      builtins.register("deferred-commit", async ({ authorization }) => {
        dispatches += 1;
        signalStarted();
        await handlerGate;
        completedEffects += 1;
        if (builtinThrowsAfterEffect) throw new Error("fixture builtin failed after external effect");
        return outputFor(authorization.invocation);
      });
    } else {
      transports.register(racePluginId, pluginVersion, {
        request: async (rpc) => {
          if (rpc.method === "prepare") {
            const invocation = rpc.params.authorization.invocation;
            return {
              runtime_rpc_version: 1,
              message_type: "result",
              method: "prepare",
              rpc_id: rpc.rpc_id,
              completed_at: new Date().toISOString(),
              request_id: invocation.request_id,
              request_digest: invocation.request_digest,
              binding: invocation.binding,
              artifact_declarations: [],
              logs: [],
              artifacts: [],
            };
          }
          if (rpc.method !== "execute") throw new Error("unexpected Runtime method");
          dispatches += 1;
          signalStarted();
          await handlerGate;
          completedEffects += 1;
          const invocation = rpc.params.authorization.invocation;
          return {
            runtime_rpc_version: 1,
            message_type: "result",
            method: "execute",
            rpc_id: rpc.rpc_id,
            completed_at: new Date().toISOString(),
            request_id: invocation.request_id,
            request_digest: invocation.request_digest,
            binding: invocation.binding,
            output: outputFor(invocation),
            logs: [],
            artifacts: [],
          };
        },
      });
    }
    const tokens = new PluginToolCapabilityTokenAuthority(Buffer.alloc(32, 0x64));
    const raceBus = new PluginActionBus({
      documents,
      tokens,
      runtime: new PluginRuntimeBroker({ tokens, transports }),
      builtins,
      resolve_mode: () => mode,
    });
    const interaction = {
      request_id: `commit_race_request_${race}`,
      idempotency_key: `commit_race_idempotency_${race}`,
      scope: raceScope,
      document_id: raceDocumentId,
      document_revision: 1,
      node_id: raceNodeId,
      node_revision: 1,
      action_id: "complete",
      input: {},
    };
    return {
      root,
      plugin_id: racePluginId,
      scope: raceScope,
      document_id: raceDocumentId,
      interaction,
      bus: raceBus,
      handler_started: handlerStarted,
      release_handler: releaseHandler,
      dispatches: () => dispatches,
      completed_effects: () => completedEffects,
    };
  }

  it("runs the golden grant -> confirmation -> projection -> durable revision flow", async () => {
    const missing = await bus.invoke(request("missing"));
    expect(missing).toMatchObject({
      status: "needs_grant",
      missing_permissions: [
        HomerailPluginPermission.ARTIFACT_WRITE,
        HomerailPluginPermission.WORKSPACE_READ,
      ],
    });
    expect(documents.get("action-document", scope)).toMatchObject({ revision: 1 });

    grantDefaultActionPermissions();
    const pending = await bus.invoke(request("approved"));
    expect(pending).toMatchObject({
      status: "awaiting_confirmation",
      challenge: {
        effect: "write",
        permissions: [
          HomerailPluginPermission.ARTIFACT_WRITE,
          HomerailPluginPermission.WORKSPACE_READ,
        ],
        effective_grants: [
          { permission: HomerailPluginPermission.ARTIFACT_WRITE },
          { permission: HomerailPluginPermission.WORKSPACE_READ },
        ],
        message: "Allow com.example.action@1.0.0 to perform write Tool complete_card for Action complete on node com.example.action:current?",
      },
    });
    const committed = await bus.confirm(pending.request_id, {
      challenge_id: pending.challenge!.challenge_id,
      decision: "approved",
    });
    expect(committed).toMatchObject({
      status: "committed",
      result: {
        output_type: "ui_transaction",
        document_id: "action-document",
        document_revision: 2,
      },
    });
    expect(documents.get("action-document", scope)).toMatchObject({
      revision: 2,
      nodes: [{
        id: nodeId,
        revision: 2,
        content: { title: "Review architecture", status: "done" },
      }],
    });
    expect(listPluginToolEvents(pending.request_id).map((event) => event.event_type)).toEqual([
      "requested", "confirmation_issued", "confirmed", "running", "committed",
    ]);

    const replay = await bus.invoke({ ...request("approved"), request_digest: committed.request_digest });
    expect(replay).toMatchObject({ status: "committed", idempotent: true, result: committed.result });
    await expect(bus.confirm(pending.request_id, {
      challenge_id: pending.challenge!.challenge_id,
      decision: "approved",
    })).resolves.toMatchObject({ status: "committed", idempotent: true, result: committed.result });
    await expect(bus.confirm(pending.request_id, {
      challenge_id: pending.challenge!.challenge_id,
      decision: "denied",
    })).rejects.toThrow(/idempotency collision/);
    expect(documents.listTransactions("action-document", scope)).toHaveLength(2);
  });

  it("rejects stale targets and idempotency collisions without changing the document", async () => {
    grantDefaultActionPermissions();
    const pending = await bus.invoke(request("collision"));
    await expect(bus.invoke(request("collision", { ignored: "changed" })))
      .rejects.toThrow(/idempotency collision/);
    await expect(bus.invoke({ ...request("stale"), document_revision: 0 }))
      .rejects.toThrow(/document revision is stale/);
    await expect(bus.invoke(request("fixed-override", {
      content: { title: "Attacker override", status: "ready" },
    }))).rejects.toThrow(/conflicts with Manager-owned fixed argument/);
    expect(getPluginToolRequest(pending.request_id)).toMatchObject({ status: "awaiting_confirmation" });
    expect(documents.get("action-document", scope)).toMatchObject({ revision: 1 });
  });

  it("fails a pure projection safely when the live session switches off before dispatch", async () => {
    grantDefaultActionPermissions();
    const pending = await bus.invoke(request("off_pending"));
    expect(pending.status).toBe("awaiting_confirmation");

    mode = "off";
    await expect(bus.confirm(pending.request_id, {
      challenge_id: pending.challenge!.challenge_id,
      decision: "approved",
    })).resolves.toMatchObject({ status: "failed", error_code: "mode_revoked" });
    expect(documents.get("action-document", scope)).toMatchObject({ revision: 1 });
    expect(documents.listTransactions("action-document", scope)).toHaveLength(1);
    expect(listPluginToolEvents(pending.request_id).map((event) => event.event_type)).toEqual([
      "requested", "confirmation_issued", "confirmed", "failed",
    ]);

    await expect(bus.invoke(request("off_new"))).rejects.toThrow(/mode does not authorize/);
    expect(getPluginToolRequest("action_request_off_new")).toBeUndefined();
    expect(documents.listTransactions("action-document", scope)).toHaveLength(1);
  });

  it.each([
    { race: "mode" as const, handler: "runtime" as const },
    { race: "registry" as const, handler: "builtin" as const },
    { race: "permission" as const, handler: "runtime" as const },
  ])("fails closed after a deferred $handler effect when $race authority drifts before commit", async ({
    race,
    handler,
  }) => {
    const fixture = createDeferredCommitRaceFixture(race, handler);
    try {
      const pending = await fixture.bus.invoke(fixture.interaction);
      expect(pending).toMatchObject({ status: "awaiting_confirmation" });
      const completion = fixture.bus.confirm(pending.request_id, {
        challenge_id: pending.challenge!.challenge_id,
        decision: "approved",
      });
      await fixture.handler_started;
      expect(fixture.dispatches()).toBe(1);
      expect(fixture.completed_effects()).toBe(0);

      if (race === "mode") {
        mode = "off";
      } else if (race === "registry") {
        expect(setPluginEnabled(fixture.plugin_id, false, {
          expected_revision: 1,
          expected_active_version: pluginVersion,
        })).toMatchObject({ enabled: false, revision: 2 });
      } else {
        expect(setPluginGrantStatus({
          plugin_id: fixture.plugin_id,
          plugin_version: pluginVersion,
          permission: HomerailPluginPermission.ARTIFACT_WRITE,
          status: "denied",
          expected_revision: 2,
          actor_type: "operator",
          actor_id: "commit-race-test",
        })).toMatchObject({ status: "denied", revision: 3 });
      }

      fixture.release_handler();
      await expect(completion).resolves.toMatchObject({
        status: "failed",
        error_code: "runtime_indeterminate",
      });
      expect(fixture.completed_effects()).toBe(1);
      expect(getPluginToolRequest(pending.request_id)).toMatchObject({
        status: "failed",
        error_code: "runtime_indeterminate",
      });
      expect(documents.get(fixture.document_id, fixture.scope)).toMatchObject({
        revision: 1,
        nodes: [expect.objectContaining({ id: fixture.interaction.node_id, revision: 1 })],
      });
      expect(documents.listTransactions(fixture.document_id, fixture.scope)).toHaveLength(1);
      expect(listPluginToolEvents(pending.request_id).map((event) => event.event_type)).toEqual([
        "requested", "confirmation_issued", "confirmed", "running", "failed",
      ]);

      if (race === "mode") {
        mode = "prefer";
      } else if (race === "registry") {
        expect(setPluginEnabled(fixture.plugin_id, true, {
          expected_revision: 2,
          expected_active_version: pluginVersion,
        })).toMatchObject({ enabled: true, revision: 3 });
      } else {
        expect(setPluginGrantStatus({
          plugin_id: fixture.plugin_id,
          plugin_version: pluginVersion,
          permission: HomerailPluginPermission.ARTIFACT_WRITE,
          status: "granted",
          expected_revision: 3,
          actor_type: "operator",
          actor_id: "commit-race-test",
        })).toMatchObject({ status: "granted", revision: 4 });
      }
      await expect(fixture.bus.invoke({
        ...fixture.interaction,
        request_id: `${fixture.interaction.request_id}_retry`,
        idempotency_key: `${fixture.interaction.idempotency_key}_retry`,
      })).rejects.toThrow(/blocked by an unresolved Tool execution.*requires reconciliation/);
      expect(fixture.dispatches()).toBe(1);
      expect(documents.listTransactions(fixture.document_id, fixture.scope)).toHaveLength(1);
    } finally {
      fixture.release_handler();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("marks a throwing external builtin indeterminate after dispatch and requires reconciliation", async () => {
    const fixture = createDeferredCommitRaceFixture("registry", "builtin", true);
    try {
      const pending = await fixture.bus.invoke(fixture.interaction);
      expect(pending).toMatchObject({ status: "awaiting_confirmation" });
      const completion = fixture.bus.confirm(pending.request_id, {
        challenge_id: pending.challenge!.challenge_id,
        decision: "approved",
      });
      await fixture.handler_started;
      expect(fixture.dispatches()).toBe(1);
      expect(fixture.completed_effects()).toBe(0);
      fixture.release_handler();

      await expect(completion).resolves.toMatchObject({
        status: "failed",
        error_code: "runtime_indeterminate",
      });
      expect(fixture.completed_effects()).toBe(1);
      expect(getPluginToolRequest(pending.request_id)).toMatchObject({
        status: "failed",
        error_code: "runtime_indeterminate",
      });
      expect(documents.get(fixture.document_id, fixture.scope)).toMatchObject({ revision: 1 });
      expect(documents.listTransactions(fixture.document_id, fixture.scope)).toHaveLength(1);
      expect(listPluginToolEvents(pending.request_id).map((event) => event.event_type)).toEqual([
        "requested", "confirmation_issued", "confirmed", "running", "failed",
      ]);

      await expect(fixture.bus.invoke({
        ...fixture.interaction,
        request_id: `${fixture.interaction.request_id}_retry`,
        idempotency_key: `${fixture.interaction.idempotency_key}_retry`,
      })).rejects.toThrow(/blocked by an unresolved Tool execution.*requires reconciliation/);
      expect(fixture.dispatches()).toBe(1);
    } finally {
      fixture.release_handler();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("makes denial terminal and rejects confirmation replay", async () => {
    grantDefaultActionPermissions();
    const pending = await bus.invoke(request("denied"));
    const denied = await bus.confirm(pending.request_id, {
      challenge_id: pending.challenge!.challenge_id,
      decision: "denied",
    });
    expect(denied).toMatchObject({ status: "denied" });
    await expect(bus.confirm(pending.request_id, {
      challenge_id: pending.challenge!.challenge_id,
      decision: "approved",
    })).rejects.toThrow(/idempotency collision/);
    expect(documents.get("action-document", scope)).toMatchObject({ revision: 1 });
  });

  it("allows only one executor when an approved confirmation is retried concurrently", async () => {
    const concurrentId = "com.example.concurrent-action";
    const concurrentScope = { type: "voice_session", id: "concurrent-action-session" } as const;
    const concurrentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-concurrent-action-plugin-"));
    try {
      writeFixture(concurrentRoot);
      for (const relative of [
        "homerail.plugin.json",
        "schemas/action-input.schema.json",
        "schemas/content.schema.json",
        "ui/complete.json",
        "skills/action/SKILL.md",
      ]) {
        const file = path.join(concurrentRoot, relative);
        fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll(pluginId, concurrentId), "utf8");
      }
      const manifestFile = path.join(concurrentRoot, "homerail.plugin.json");
      const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
        tools: Array<{ id: string } & Record<string, unknown>>;
        runtime: Record<string, unknown>;
        permissions: { required: unknown[]; optional: unknown[] };
      };
      const concurrentTool = manifest.tools.find((tool) => tool.id === "complete_card")!;
      Object.assign(concurrentTool, {
        permissions: [],
        confirmation: "always",
        handler: { type: "builtin", id: "deferred-test" },
      });
      delete concurrentTool.output_schema;
      manifest.runtime = { trust: "trusted_builtin", plugin_api: 1 };
      manifest.permissions = { required: [], optional: [] };
      writeJson(manifestFile, manifest);
      const descriptor = loadPluginPackage(concurrentRoot, {
        source: "builtin",
        trusted_builtin_ids: new Set([concurrentId]),
      });
      syncPluginPackage({ descriptor, source: "builtin", default_enabled: true });

      documents.createOrGet({
        documentId: "concurrent-action-document",
        scope: concurrentScope,
        createdAt: new Date().toISOString(),
        purpose: "canonical",
      });
      const concurrentNode = structuredClone(initialNode());
      concurrentNode.id = `${concurrentId}:current`;
      concurrentNode.kind = `${concurrentId}/card`;
      concurrentNode.owner = { id: concurrentId, version: pluginVersion };
      concurrentNode.actions![0]!.intent = `${concurrentId}.complete`;
      expect(documents.apply({
        ir_version: 1,
        transaction_id: "seed-concurrent-action-card",
        document_id: "concurrent-action-document",
        base_revision: 0,
        actor: { type: GenerativeUiActorType.AGENT, id: "test" },
        operations: [{ op: "put", node: concurrentNode }],
        created_at: new Date().toISOString(),
      }, concurrentScope)).toMatchObject({ status: "applied", revision: 1 });

      let started!: () => void;
      const handlerStarted = new Promise<void>((resolve) => { started = resolve; });
      let finish!: (value: { type: "domain_output"; output: { ok: boolean } }) => void;
      const handlerResult = new Promise<{ type: "domain_output"; output: { ok: boolean } }>((resolve) => {
        finish = resolve;
      });
      let executions = 0;
      const builtins = new PluginBuiltinToolRegistry();
      builtins.register("deferred-test", async () => {
        executions += 1;
        started();
        return handlerResult;
      });
      const tokens = new PluginToolCapabilityTokenAuthority(Buffer.alloc(32, 0x63));
      const concurrentBus = new PluginActionBus({
        documents,
        tokens,
        runtime: new PluginRuntimeBroker({ tokens, transports: new PluginRuntimeTransportRegistry() }),
        builtins,
        resolve_mode: () => "prefer",
      });
      const interaction = {
        request_id: "concurrent_action_request",
        idempotency_key: "concurrent_action_idempotency",
        scope: concurrentScope,
        document_id: "concurrent-action-document",
        document_revision: 1,
        node_id: `${concurrentId}:current`,
        node_revision: 1,
        action_id: "complete",
        input: {},
      };
      const pending = await concurrentBus.invoke(interaction);
      expect(pending).toMatchObject({ status: "awaiting_confirmation" });
      const decision = {
        challenge_id: pending.challenge!.challenge_id,
        decision: "approved" as const,
      };
      const first = concurrentBus.confirm(pending.request_id, decision);
      const exactRetry = concurrentBus.confirm(pending.request_id, decision);
      await handlerStarted;
      await expect(concurrentBus.invoke({
        ...interaction,
        request_id: "concurrent_action_second_request",
        idempotency_key: "concurrent_action_second_idempotency",
      })).rejects.toThrow(/blocked by an unresolved Tool execution/);
      expect(executions).toBe(1);
      finish({ type: "domain_output", output: { ok: true } });
      const results = await Promise.all([first, exactRetry]);
      expect(results.map((result) => result.idempotent).sort()).toEqual([false, true]);
      expect(results).toContainEqual(expect.objectContaining({
        status: "committed",
        result: { output_type: "domain_output", output: { ok: true } },
      }));
      expect(results.every((result) => result.status === "running" || result.status === "committed")).toBe(true);
      expect(executions).toBe(1);
      expect(getPluginToolRequest(pending.request_id)).toMatchObject({ status: "committed" });
    } finally {
      fs.rmSync(concurrentRoot, { recursive: true, force: true });
    }
  });

  it("contains Runtime crashes and timeouts without changing the canonical document", async () => {
    const runtimeId = "com.example.runtime-action";
    const runtimeScope = (operation: "crash" | "timeout" | "success") => ({
      type: "voice_session" as const,
      id: `runtime-action-session-${operation}`,
    });
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-runtime-action-plugin-"));
    try {
      writeFixture(runtimeRoot);
      for (const relative of [
        "homerail.plugin.json",
        "schemas/action-input.schema.json",
        "schemas/content.schema.json",
        "ui/complete.json",
        "skills/action/SKILL.md",
      ]) {
        const file = path.join(runtimeRoot, relative);
        fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll(pluginId, runtimeId), "utf8");
      }
      const manifestFile = path.join(runtimeRoot, "homerail.plugin.json");
      const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
        tools: Array<{ id: string } & Record<string, unknown>>;
        runtime: Record<string, unknown>;
        permissions: { required: unknown[]; optional: unknown[] };
      };
      const runtimeTool = manifest.tools.find((tool) => tool.id === "complete_card")!;
      Object.assign(runtimeTool, {
        permissions: [],
        confirmation: "never",
        handler: { type: "runtime", method: "complete" },
      });
      manifest.runtime = { trust: "trusted_builtin", plugin_api: 1 };
      manifest.permissions = { required: [], optional: [] };
      writeJson(manifestFile, manifest);
      const descriptor = loadPluginPackage(runtimeRoot, {
        source: "builtin",
        trusted_builtin_ids: new Set([runtimeId]),
      });
      syncPluginPackage({ descriptor, source: "builtin", default_enabled: true });

      const runtimeNode = structuredClone(initialNode());
      runtimeNode.id = `${runtimeId}:current`;
      runtimeNode.kind = `${runtimeId}/card`;
      runtimeNode.owner = { id: runtimeId, version: pluginVersion };
      runtimeNode.actions![0]!.intent = `${runtimeId}.complete`;
      for (const operation of ["crash", "timeout", "success"] as const) {
        const documentId = `runtime-action-document-${operation}`;
        documents.createOrGet({
          documentId,
          scope: runtimeScope(operation),
          createdAt: new Date().toISOString(),
          purpose: "canonical",
        });
        const seeded = documents.apply({
          ir_version: 1,
          transaction_id: `seed-runtime-action-card-${operation}`,
          document_id: documentId,
          base_revision: 0,
          actor: { type: GenerativeUiActorType.AGENT, id: "test" },
          operations: [{ op: "put", node: runtimeNode }],
          created_at: new Date().toISOString(),
        }, runtimeScope(operation));
        expect(seeded).toMatchObject({ status: "applied", revision: 1 });
      }

      const tokens = new PluginToolCapabilityTokenAuthority(Buffer.alloc(32, 0x62));
      const transports = new PluginRuntimeTransportRegistry();
      let dispatches = 0;
      transports.register(runtimeId, pluginVersion, {
        request: async (rpc) => {
          if (rpc.method !== "execute") throw new Error("unexpected Runtime method");
          dispatches += 1;
          const invocation = rpc.params.authorization.invocation;
          if (invocation.request_id.includes("crash")) {
            throw new Error("fixture Runtime crashed");
          }
          if (invocation.request_id.includes("success")) {
            if (invocation.source.type !== "ui_action") throw new Error("expected UI Action source");
            return {
              runtime_rpc_version: 1,
              message_type: "result",
              method: "execute",
              rpc_id: rpc.rpc_id,
              completed_at: new Date().toISOString(),
              request_id: invocation.request_id,
              request_digest: invocation.request_digest,
              binding: invocation.binding,
              output: {
                type: "ui_transaction",
                transaction: {
                  ir_version: 1,
                  transaction_id: invocation.request_id,
                  document_id: invocation.source.target.document_id,
                  base_revision: invocation.source.target.document_revision,
                  actor: {
                    type: "plugin",
                    id: invocation.tool.qualified_id,
                    plugin: { id: runtimeId, version: pluginVersion },
                  },
                  operations: [{
                    op: "put",
                    node: {
                      ir_version: 1,
                      id: invocation.source.target.node_id,
                      kind: `${runtimeId}/card`,
                      kind_version: 1,
                      owner: { id: runtimeId, version: pluginVersion },
                      surface: "task",
                      importance: "primary",
                      content: structuredClone(invocation.arguments.content),
                      lifecycle: { persistence: "session" },
                      fallback: { title: "Runtime success" },
                    },
                  }],
                  created_at: new Date().toISOString(),
                },
              },
              logs: [],
              artifacts: [],
            };
          }
          return await new Promise(() => undefined);
        },
      });
      const runtimeBus = new PluginActionBus({
        documents,
        tokens,
        runtime: new PluginRuntimeBroker({ tokens, transports, timeout_ms: 10 }),
        resolve_mode: () => "prefer",
      });
      const runtimeRequest = (
        operation: "crash" | "timeout" | "success",
        requestSuffix = operation,
        documentRevision = 1,
      ) => ({
        request_id: `runtime_action_${requestSuffix}`,
        idempotency_key: `runtime_idempotency_${requestSuffix}`,
        scope: runtimeScope(operation),
        document_id: `runtime-action-document-${operation}`,
        document_revision: documentRevision,
        node_id: `${runtimeId}:current`,
        node_revision: 1,
        action_id: "complete",
        input: {},
      });
      await expect(runtimeBus.invoke(runtimeRequest("crash"))).resolves.toMatchObject({
        status: "failed",
        error_code: "runtime_indeterminate",
      });
      await expect(runtimeBus.invoke(runtimeRequest("timeout"))).resolves.toMatchObject({
        status: "failed",
        error_code: "runtime_indeterminate",
      });
      expect(documents.get("runtime-action-document-crash", runtimeScope("crash"))).toMatchObject({ revision: 1 });
      expect(documents.get("runtime-action-document-timeout", runtimeScope("timeout"))).toMatchObject({ revision: 1 });
      expect(documents.listTransactions("runtime-action-document-crash", runtimeScope("crash"))).toHaveLength(1);
      expect(documents.listTransactions("runtime-action-document-timeout", runtimeScope("timeout"))).toHaveLength(1);
      expect(dispatches).toBe(2);
      const unrelatedNode = structuredClone(runtimeNode);
      unrelatedNode.id = `${runtimeId}:unrelated`;
      delete unrelatedNode.actions;
      expect(documents.apply({
        ir_version: 1,
        transaction_id: "advance-unrelated-runtime-node",
        document_id: "runtime-action-document-crash",
        base_revision: 1,
        actor: { type: GenerativeUiActorType.AGENT, id: "unrelated-test" },
        operations: [{ op: "put", node: unrelatedNode }],
        created_at: new Date().toISOString(),
      }, runtimeScope("crash"))).toMatchObject({ status: "applied", revision: 2 });
      expect(documents.get("runtime-action-document-crash", runtimeScope("crash"))).toMatchObject({
        revision: 2,
        nodes: [
          expect.objectContaining({ id: `${runtimeId}:current`, revision: 1 }),
          expect.objectContaining({ id: `${runtimeId}:unrelated`, revision: 1 }),
        ],
      });
      await expect(runtimeBus.invoke(runtimeRequest("crash", "reconcile_blocked", 2)))
        .rejects.toThrow(/requires reconciliation/);
      expect(dispatches).toBe(2);
      await expect(runtimeBus.invoke(runtimeRequest("success"))).resolves.toMatchObject({
        status: "committed",
        result: { output_type: "ui_transaction", document_revision: 2 },
      });
      expect(documents.get("runtime-action-document-success", runtimeScope("success"))).toMatchObject({ revision: 2 });
      expect(documents.listTransactions("runtime-action-document-success", runtimeScope("success"))).toHaveLength(2);
      expect(dispatches).toBe(3);
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });
});
