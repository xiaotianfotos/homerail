import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scaffoldPluginProject } from "homerail-plugin-sdk";
import type {
  HomerailPluginToolExecutionEnvelopeV1,
  HomerailPluginTurnContextV1,
} from "homerail-protocol";
import { voiceCanonicalDocumentId } from "../src/generative-ui/canonical-voice-service.js";
import { persistentGenerativeUiDocumentService } from "../src/generative-ui/shadow-service.js";
import { closeDb } from "../src/persistence/db.js";
import {
  getPluginToolConfirmationForRequest,
  getPluginToolRequest,
  listPluginToolEvents,
} from "../src/persistence/plugin-actions.js";
import {
  acknowledgePluginAgentToolContinuationLease,
  leasePluginAgentToolContinuations,
  listPluginAgentToolContinuations,
  releasePluginAgentToolContinuationLease,
} from "../src/persistence/plugin-tool-continuations.js";
import { syncPluginPackage } from "../src/persistence/plugins.js";
import {
  _resetPluginActionBusForTest,
  getPluginToolTurnAuthority,
} from "../src/plugins/action-bus.js";
import { loadPluginPackage } from "../src/plugins/manifest-loader.js";
import {
  _requestManagerForTest as requestHostManager,
  createManagerTools as createHostManagerTools,
} from "../src/server/host-codex-manager-agent.js";
import { createServer } from "../src/server/http.js";
import {
  _withManagerTurnEnvelopeForTest,
  createManagerTools as createWorkerManagerTools,
} from "../../homerail_worker/src/manager-agent/server.js";
import { getManagerAgentTurnEnvelopeAuthority } from "../src/server/manager-agent-turn-envelope.js";

const ADMIN_TOKEN = "m5-prefer-golden-admin-token-0123456789abcdef";
const PLUGIN_ID = "com.example.prefer-golden";
const PLUGIN_VERSION = "1.0.0";
const AGENT_TOOL_ID = "create_action_card";
const ACTION_TOOL_ID = "commit_card";
const ACTION_ID = "commit";
const ROUTED_CAPABILITY_ID = `${PLUGIN_ID}:compose-card`;
const NODE_ID = `${PLUGIN_ID}:current`;
const MANIFEST_ACTION_INTENT = `${PLUGIN_ID}:${ACTION_ID}`;

type ApiEnvelope<T> = { success: true; data: T };
type HttpCaller = (pathname: string, init?: RequestInit) => Promise<unknown>;

interface ManagerTool {
  name: string;
  handler: (
    args: Record<string, unknown>,
    context?: { tool_call_id?: string },
  ) => Promise<unknown>;
}

interface VoiceSurfaceState {
  commentaryTexts: string[];
  progress: Record<string, unknown> | null;
  taskDraft: Record<string, unknown> | null;
  widgets: Record<string, unknown>[];
  removeWidgetIds: string[];
  pluginProjections: HomerailPluginToolExecutionEnvelopeV1[];
}

interface ToolBusResponse {
  request_id: string;
  request_digest: string;
  status: string;
  idempotent: boolean;
  source: "ui_action" | "agent";
  tool: { local_id: string; qualified_id: string; wire_id: string };
  missing_permissions?: string[];
  challenge?: {
    challenge_id: string;
    request_id: string;
    request_digest: string;
    effect: string;
    permissions: string[];
    effective_grants: Array<{ permission: string; paths?: string[]; hosts?: string[] }>;
    message: string;
  };
  result?: {
    output_type: string;
    transaction_id: string;
    document_id: string;
    document_revision: number;
  };
}

interface CanonicalProjection {
  mode: "prefer";
  authoritative: true;
  purpose: "canonical";
  document: {
    document_id: string;
    revision: number;
    nodes: Array<{
      id: string;
      revision: number;
      content: Record<string, unknown>;
      actions?: Array<{
        id: string;
        label: string;
        intent: string;
        arguments?: Record<string, unknown>;
        confirmation?: { required: boolean; message?: string };
      }>;
    }>;
  };
  pending_tool_confirmations: ToolBusResponse[];
}

interface Harness {
  name: "Host" | "Worker";
  caller: (baseUrl: string) => HttpCaller;
  tools: (
    baseUrl: string,
    sessionId: string,
    context: HomerailPluginTurnContextV1,
    turnToken: string,
  ) => { tools: ManagerTool[]; voiceSurface: VoiceSurfaceState };
}

function emptyVoiceSurface(): VoiceSurfaceState {
  return {
    commentaryTexts: [],
    progress: null,
    taskDraft: null,
    widgets: [],
    removeWidgetIds: [],
    pluginProjections: [],
  };
}

const harnesses: Harness[] = [{
  name: "Host",
  caller: (baseUrl) => (pathname, init) => requestHostManager(`${baseUrl}/api`, pathname, init),
  tools: (baseUrl, sessionId, context, turnToken) => {
    const voiceSurface = emptyVoiceSurface();
    const tools = createHostManagerTools({
      restUrl: `${baseUrl}/api`,
      workspace: process.cwd(),
      sessionId,
      createdRunIds: [],
      finalNotes: [],
      objectiveToolCalls: [],
      voiceSurface,
    }, "voice", context, turnToken) as unknown as ManagerTool[];
    return { tools, voiceSurface };
  },
}, {
  name: "Worker",
  caller: (baseUrl) => (pathname, init) => requestHostManager(`${baseUrl}/api`, pathname, init),
  tools: (baseUrl, sessionId, context, turnToken) => {
    process.env.MANAGER_REST_URL = `${baseUrl}/api`;
    const voiceSurface = emptyVoiceSurface();
    const rawTools = createWorkerManagerTools({
      sessionId,
      createdRunIds: [],
      finalNotes: [],
      objectiveToolCalls: [],
      voiceSurface,
    }, "voice", context, turnToken) as unknown as ManagerTool[];
    const sealed = getManagerAgentTurnEnvelopeAuthority().seal({
      payload: {
        session_id: sessionId,
        voice_session_id: sessionId,
        response_mode: "voice",
        generative_ui_mode: "prefer",
        plugin_context: context,
        manager_skills: [],
      },
      target: { runtime_placement: "container", worker_id: "golden-worker" },
    });
    const envelope = sealed.turn_envelope as Parameters<typeof _withManagerTurnEnvelopeForTest>[0];
    const tools = rawTools.map((tool) => ({
      ...tool,
      handler: (args: Record<string, unknown>, callContext?: { tool_call_id?: string }) => (
        _withManagerTurnEnvelopeForTest(envelope, () => tool.handler(args, callContext))
      ),
    }));
    return { tools, voiceSurface };
  },
}];

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function configureDualToolFixture(root: string): void {
  const manifestFile = path.join(root, "homerail.plugin.json");
  const contentSchemaFile = path.join(root, "schemas/card-content.v1.schema.json");
  const agentInputSchemaFile = path.join(root, "schemas/card-input.v1.schema.json");
  const actionInputSchemaFile = path.join(root, "schemas/card-action.v1.schema.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
    capabilities: Array<Record<string, unknown>>;
    schemas: Array<{ id: string; file: string }>;
    kinds: Array<{ versions: Array<{ actions: string[]; max_content_bytes: number }> }>;
    tools: Array<Record<string, unknown>>;
    actions: Array<Record<string, unknown>>;
    permissions: { optional: Array<Record<string, unknown>> };
  };
  const contentSchema = JSON.parse(fs.readFileSync(contentSchemaFile, "utf8")) as {
    properties: Record<string, unknown>;
  } & Record<string, unknown>;
  contentSchema.properties.details = { type: "string", maxLength: 14_000 };
  writeJson(contentSchemaFile, contentSchema);
  const actionInputSchema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      id: { type: "string", minLength: PLUGIN_ID.length + 2, maxLength: 256 },
      content: contentSchema,
    },
    required: ["id", "content"],
    additionalProperties: false,
  };
  writeJson(actionInputSchemaFile, actionInputSchema);
  writeJson(agentInputSchemaFile, {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      id: { type: "string", minLength: PLUGIN_ID.length + 2, maxLength: 256 },
      content: contentSchema,
      action_arguments: actionInputSchema,
    },
    required: ["id", "content", "action_arguments"],
    additionalProperties: false,
  });
  writeJson(path.join(root, "ui/projectors/card.v1.json"), {
    projection_version: 1,
    type: "direct_ui_node",
    kind: `${PLUGIN_ID}/card`,
    kind_version: 1,
    node_id_pointer: "/id",
    content_pointer: "/content",
    omit_content_fields: [],
    fallback: {
      title_pointer: "/content/title",
      summary_pointer: "/content/summary",
      items_pointer: "/content/items",
    },
    defaults: {
      surface: "task",
      importance: "primary",
      density: "detail",
      persistence: "session",
    },
    actions: [{
      id: ACTION_ID,
      label: "Commit",
      style: "primary",
      arguments_pointer: "/action_arguments",
    }],
  });
  writeJson(path.join(root, "ui/projectors/card-action.v1.json"), {
    projection_version: 1,
    type: "direct_ui_node",
    kind: `${PLUGIN_ID}/card`,
    kind_version: 1,
    node_id_pointer: "/id",
    content_pointer: "/content",
    omit_content_fields: [],
    fallback: {
      title_pointer: "/content/title",
      summary_pointer: "/content/summary",
      items_pointer: "/content/items",
    },
    defaults: {
      surface: "task",
      importance: "primary",
      density: "detail",
      persistence: "session",
    },
  });

  manifest.schemas.push({ id: "card-action-v1", file: "schemas/card-action.v1.schema.json" });
  manifest.capabilities[0] = {
    ...manifest.capabilities[0],
    tools: [AGENT_TOOL_ID],
    actions: [],
  };
  manifest.capabilities.push({
    id: "commit-card",
    summary: "Commit the current prefer Golden card.",
    intents: ["commit the current prefer golden card"],
    tags: ["card", "commit"],
    modalities: ["voice", "touch", "gamepad"],
    required_inputs: [],
    skill: "compose-card",
    tools: [],
    workflows: [],
    actions: [ACTION_ID],
  });
  manifest.kinds[0].versions[0].actions = [ACTION_ID];
  manifest.kinds[0].versions[0].max_content_bytes = 32_768;
  manifest.permissions.optional.push({
    permission: "artifact.write",
    paths: ["artifacts/releases"],
  });
  manifest.tools = [{
    id: AGENT_TOOL_ID,
    description: "Create the first canonical card and bind its symbolic commit Action.",
    exposure: ["agent"],
    input_schema: "card-input-v1",
    output_schema: "card-content-v1",
    effect: "write",
    permissions: [],
    confirmation: "always",
    handler: { type: "projection", file: "ui/projectors/card.v1.json" },
  }, {
    id: ACTION_TOOL_ID,
    description: "Commit fixed arguments from the current canonical node Action.",
    exposure: ["action"],
    input_schema: "card-action-v1",
    output_schema: "card-content-v1",
    effect: "write",
    permissions: ["artifact.write"],
    confirmation: "always",
    handler: { type: "projection", file: "ui/projectors/card-action.v1.json" },
  }];
  manifest.actions = [{
    id: ACTION_ID,
    intent: MANIFEST_ACTION_INTENT,
    tool: ACTION_TOOL_ID,
  }];
  writeJson(manifestFile, manifest);
}

function stableWireId(localId: string): string {
  const digest = createHash("sha256").update(`${PLUGIN_ID}:${localId}`).digest("hex").slice(0, 10);
  const suffixBudget = 64 - 2 - digest.length - 1;
  return `p_${digest}_${localId.slice(0, suffixBudget)}`;
}

function jsonMutation(method: "POST" | "PUT", body: unknown): RequestInit {
  return { method, body: JSON.stringify(body) };
}

async function api<T>(caller: HttpCaller, pathname: string, init?: RequestInit): Promise<T> {
  return await caller(pathname, init) as T;
}

function requireTool(tools: ManagerTool[], name: string): ManagerTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Manager Agent Tool is unavailable: ${name}`);
  return tool;
}

function toolHandlerEnvelope<T>(result: unknown): ApiEnvelope<T> {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Tool result is not an object");
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new Error("Tool result has no content");
  const text = content.find((entry) => (
    entry && typeof entry === "object" && !Array.isArray(entry) && (entry as { type?: unknown }).type === "text"
  ));
  const value = text && typeof text === "object" && !Array.isArray(text)
    ? (text as { text?: unknown }).text
    : undefined;
  if (typeof value !== "string") throw new Error("Tool result has no text envelope");
  return JSON.parse(value) as ApiEnvelope<T>;
}

function canonicalPath(sessionId: string): string {
  return `/voice-agent/sessions/${encodeURIComponent(sessionId)}/generative-ui`
    + "?device=desktop&input=mouse&viewport=wide&attention=focused";
}

describe("Plugin Agent Tool -> canonical Action real prefer HTTP Golden", () => {
  let savedEnv: NodeJS.ProcessEnv;
  let home: string;
  let sourceRoot: string;
  let server: http.Server | undefined;
  let baseUrl = "";

  beforeEach(async () => {
    savedEnv = { ...process.env };
    closeDb();
    _resetPluginActionBusForTest();
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-prefer-golden-home-"));
    sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-prefer-golden-source-"));
    process.env.HOMERAIL_HOME = home;
    process.env.HOMERAIL_LOCAL_NODE_AUTOSTART = "0";
    process.env.HOMERAIL_MANAGER_ADMIN_TOKEN = ADMIN_TOKEN;
    process.env.HOMERAIL_GENERATIVE_UI_MODE = "prefer";
    delete process.env.HOMERAIL_MANAGER_HOST;
    delete process.env.HOMERAIL_MANAGER_PUBLIC_URL;
    delete process.env.HOMERAIL_MANAGER_ADMIN_ORIGINS;
    scaffoldPluginProject(sourceRoot, PLUGIN_ID, {
      name: "Prefer Golden",
      version: PLUGIN_VERSION,
    });
    configureDualToolFixture(sourceRoot);
    const descriptor = loadPluginPackage(sourceRoot, { source: "development" });
    syncPluginPackage({ descriptor, source: "development", default_enabled: true });
    server = createServer(0, undefined, undefined, false);
    baseUrl = await new Promise<string>((resolve) => {
      server!.listen(0, "127.0.0.1", () => {
        const address = server!.address();
        if (!address || typeof address !== "object") throw new Error("server did not bind");
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
  });

  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    _resetPluginActionBusForTest();
    closeDb();
    process.env = savedEnv;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  });

  it.each(harnesses)(
    "$name createManagerTools uses the selected turn token for Agent confirmation then the exact Action Tool",
    async ({ caller: createCaller, tools: createTools }) => {
      const caller = createCaller(baseUrl);
      const session = await api<ApiEnvelope<{ session_id: string; generative_ui_mode: string }>>(
        caller,
        "/voice-agent/sessions",
        jsonMutation("POST", {}),
      );
      expect(session.data.generative_ui_mode).toBe("prefer");
      const sessionId = session.data.session_id;
      const scope = { type: "voice_session" as const, id: sessionId };
      const documentId = voiceCanonicalDocumentId(sessionId);

      const routed = await api<ApiEnvelope<{
        selected: Array<{ capability_id: string }>;
        selected_context: HomerailPluginTurnContextV1;
      }>>(caller, "/plugins/capabilities/select", jsonMutation("POST", {
        utterance: "create a prefer golden card",
        modality: "voice",
        inputs: { title: "Prefer Golden" },
        explicit_plugin_id: PLUGIN_ID,
        explicit_capability_id: ROUTED_CAPABILITY_ID,
        top_k: 1,
      }));
      expect(routed.data.selected).toEqual([
        expect.objectContaining({ capability_id: ROUTED_CAPABILITY_ID }),
      ]);
      expect(routed.data.selected_context.tools).toEqual([
        expect.objectContaining({ local_id: AGENT_TOOL_ID, capability_ids: [ROUTED_CAPABILITY_ID] }),
      ]);
      expect(routed.data.selected_context.actions).toEqual([]);
      const issuedTurn = getPluginToolTurnAuthority().issue({
        context: routed.data.selected_context,
        modality: "voice",
        scope,
        generative_ui_mode: "prefer",
      });
      expect(issuedTurn.token).toMatch(/^hrtoolturn1\./);

      const committedContent = {
        title: "Prefer Golden",
        summary: "Committed through the Action-exposed Tool.",
        items: ["done"],
        details: "Committed with Manager-owned fixed arguments.",
      };
      const actionArguments = { id: NODE_ID, content: committedContent };
      const unselectedRequestId = "unselected_tool_request";
      await expect(api(caller, "/plugins/tools/invoke", jsonMutation("POST", {
        request_id: unselectedRequestId,
        idempotency_key: unselectedRequestId,
        turn_token: issuedTurn.token,
        tool_wire_id: stableWireId(ACTION_TOOL_ID),
        call_id: unselectedRequestId,
        arguments: actionArguments,
      }))).rejects.toThrow(/not present in the exact selected Agent context/);
      expect(getPluginToolRequest(unselectedRequestId)).toBeUndefined();

      const largeDetails = `payload:${"x".repeat(10 * 1024)}`;
      const agentArguments = {
        id: NODE_ID,
        content: {
          title: "Prefer Golden",
          summary: "Created through a selected Agent Tool over real HTTP.",
          items: ["pending"],
          details: largeDetails,
        },
        action_arguments: actionArguments,
      };
      expect(Buffer.byteLength(JSON.stringify(agentArguments), "utf8")).toBeGreaterThan(8 * 1024);
      const managerTools = createTools(
        baseUrl,
        sessionId,
        routed.data.selected_context,
        issuedTurn.token,
      );
      const selectedDescriptor = routed.data.selected_context.tools[0]!;
      const selectedTool = requireTool(managerTools.tools, selectedDescriptor.wire_id);
      const modelCallContext = { tool_call_id: "model_tool_call_prefer_golden_001" };
      const pendingAgent = toolHandlerEnvelope<ToolBusResponse>(
        await selectedTool.handler(agentArguments, modelCallContext),
      );
      expect(pendingAgent).toMatchObject({
        success: true,
        data: {
          status: "awaiting_confirmation",
          source: "agent",
          idempotent: false,
          tool: { local_id: AGENT_TOOL_ID, wire_id: selectedDescriptor.wire_id },
          challenge: {
            effect: "write",
            permissions: [],
            effective_grants: [],
          },
        },
      });
      const duplicateAgent = toolHandlerEnvelope<ToolBusResponse>(
        await selectedTool.handler(agentArguments, modelCallContext),
      );
      expect(duplicateAgent).toMatchObject({
        success: true,
        data: {
          request_id: pendingAgent.data.request_id,
          request_digest: pendingAgent.data.request_digest,
          status: "awaiting_confirmation",
          idempotent: true,
        },
      });
      expect(managerTools.voiceSurface.pluginProjections).toEqual([]);

      const pendingCanonical = await api<ApiEnvelope<CanonicalProjection>>(
        caller,
        canonicalPath(sessionId),
      );
      expect(pendingCanonical.data).toMatchObject({
        mode: "prefer",
        authoritative: true,
        purpose: "canonical",
        document: { document_id: documentId, revision: 0, nodes: [] },
        pending_tool_confirmations: [{
          request_id: pendingAgent.data.request_id,
          request_digest: pendingAgent.data.request_digest,
          status: "awaiting_confirmation",
          source: "agent",
        }],
      });

      const committedAgent = await api<ApiEnvelope<ToolBusResponse>>(
        caller,
        `/plugins/tools/${encodeURIComponent(pendingAgent.data.request_id)}/confirmation`,
        jsonMutation("POST", {
          challenge_id: pendingAgent.data.challenge!.challenge_id,
          decision: "approved",
        }),
      );
      expect(committedAgent).toMatchObject({
        success: true,
        data: {
          request_id: pendingAgent.data.request_id,
          request_digest: pendingAgent.data.request_digest,
          status: "committed",
          source: "agent",
          result: {
            output_type: "ui_transaction",
            document_id: documentId,
            document_revision: 1,
          },
        },
      });
      expect(getPluginToolConfirmationForRequest(pendingAgent.data.request_id)).toMatchObject({
        status: "consumed",
        decision: { decision: "approved" },
      });
      expect(listPluginAgentToolContinuations(scope)).toEqual([
        expect.objectContaining({
          status: "pending",
          delivery_attempts: 0,
          payload: expect.objectContaining({
            request_id: pendingAgent.data.request_id,
            request_digest: pendingAgent.data.request_digest,
            status: "committed",
            confirmation: "approved",
            result: expect.objectContaining({ document_revision: 1 }),
          }),
        }),
      ]);
      const firstLease = leasePluginAgentToolContinuations({ scope });
      expect(firstLease.records).toEqual([
        expect.objectContaining({ status: "leased", delivery_attempts: 1 }),
      ]);
      expect(releasePluginAgentToolContinuationLease(firstLease.lease_id!)).toBe(1);
      const secondLease = leasePluginAgentToolContinuations({ scope });
      expect(secondLease.records).toEqual([
        expect.objectContaining({ status: "leased", delivery_attempts: 2 }),
      ]);
      expect(acknowledgePluginAgentToolContinuationLease(secondLease.lease_id!)).toBe(1);
      expect(listPluginAgentToolContinuations(scope)).toEqual([
        expect.objectContaining({ status: "delivered", delivery_attempts: 2 }),
      ]);

      const deniedAgent = toolHandlerEnvelope<ToolBusResponse>(
        await selectedTool.handler({
          ...agentArguments,
          content: { ...agentArguments.content, summary: "This update must be denied." },
        }, { tool_call_id: "model_tool_call_prefer_golden_002" }),
      );
      expect(deniedAgent.data.status).toBe("awaiting_confirmation");
      const deniedTerminal = await api<ApiEnvelope<ToolBusResponse>>(
        caller,
        `/plugins/tools/${encodeURIComponent(deniedAgent.data.request_id)}/confirmation`,
        jsonMutation("POST", {
          challenge_id: deniedAgent.data.challenge!.challenge_id,
          decision: "denied",
        }),
      );
      expect(deniedTerminal).toMatchObject({
        success: true,
        data: { status: "denied", source: "agent" },
      });
      expect(persistentGenerativeUiDocumentService.get(documentId, scope)?.revision).toBe(1);
      expect(listPluginAgentToolContinuations(scope)).toEqual([
        expect.objectContaining({
          status: "delivered",
          payload: expect.objectContaining({ request_id: pendingAgent.data.request_id }),
        }),
        expect.objectContaining({
          status: "pending",
          payload: expect.objectContaining({
            request_id: deniedAgent.data.request_id,
            status: "denied",
            confirmation: "denied",
          }),
        }),
      ]);

      const actionableCanonical = await api<ApiEnvelope<CanonicalProjection>>(
        caller,
        canonicalPath(sessionId),
      );
      expect(actionableCanonical.data.pending_tool_confirmations).toEqual([]);
      const initialDocument = actionableCanonical.data.document;
      const initialNode = initialDocument.nodes[0]!;
      const nodeAction = initialNode.actions?.[0]!;
      expect(initialDocument).toMatchObject({ document_id: documentId, revision: 1 });
      expect(initialNode).toMatchObject({
        id: NODE_ID,
        revision: 1,
        content: { details: largeDetails },
      });
      expect(nodeAction).toEqual({
        id: ACTION_ID,
        label: "Commit",
        intent: MANIFEST_ACTION_INTENT,
        arguments: actionArguments,
        style: "primary",
        confirmation: { required: true },
      });
      expect(nodeAction.intent).toBe(`${PLUGIN_ID}:commit`);

      const missingGrantInput = {
        request_id: "ui_missing_grant_request",
        idempotency_key: "ui_missing_grant_request",
        scope,
        document_id: initialDocument.document_id,
        document_revision: initialDocument.revision,
        node_id: initialNode.id,
        node_revision: initialNode.revision,
        action_id: nodeAction.id,
        input: {},
      };
      const missingGrant = await api<ApiEnvelope<ToolBusResponse>>(
        caller,
        "/plugins/actions",
        jsonMutation("POST", missingGrantInput),
      );
      expect(missingGrant).toMatchObject({
        success: true,
        data: {
          status: "needs_grant",
          source: "ui_action",
          tool: { local_id: ACTION_TOOL_ID },
          missing_permissions: ["artifact.write"],
        },
      });
      expect(persistentGenerativeUiDocumentService.get(documentId, scope)?.revision).toBe(1);

      const grants = await api<ApiEnvelope<{ grants: Array<{
        permission: string;
        status: string;
        revision: number;
      }> }>>(caller, `/plugins/${PLUGIN_ID}/permissions?version=${PLUGIN_VERSION}`);
      const artifactGrant = grants.data.grants.find((grant) => grant.permission === "artifact.write")!;
      expect(artifactGrant).toMatchObject({ status: "pending", revision: 1 });
      await expect(api(caller, `/plugins/${PLUGIN_ID}/permissions`, jsonMutation("PUT", {
        version: PLUGIN_VERSION,
        permission: "artifact.write",
        status: "granted",
        expected_revision: artifactGrant.revision,
      }))).resolves.toMatchObject({
        success: true,
        data: { grant: { status: "granted", revision: 2 } },
      });

      const actionInput = {
        ...missingGrantInput,
        request_id: "ui_commit_action_request",
        idempotency_key: "ui_commit_action_request",
      };
      const pendingAction = await api<ApiEnvelope<ToolBusResponse>>(
        caller,
        "/plugins/actions",
        jsonMutation("POST", actionInput),
      );
      expect(pendingAction).toMatchObject({
        success: true,
        data: {
          status: "awaiting_confirmation",
          source: "ui_action",
          tool: { local_id: ACTION_TOOL_ID },
          challenge: {
            effect: "write",
            permissions: ["artifact.write"],
            effective_grants: [{
              permission: "artifact.write",
              paths: ["artifacts/releases"],
            }],
          },
        },
      });
      const committedAction = await api<ApiEnvelope<ToolBusResponse>>(
        caller,
        `/plugins/actions/${encodeURIComponent(pendingAction.data.request_id)}/confirmation`,
        jsonMutation("POST", {
          challenge_id: pendingAction.data.challenge!.challenge_id,
          decision: "approved",
        }),
      );
      expect(committedAction).toMatchObject({
        success: true,
        data: {
          status: "committed",
          source: "ui_action",
          request_digest: pendingAction.data.request_digest,
          result: {
            output_type: "ui_transaction",
            document_id: documentId,
            document_revision: 2,
          },
        },
      });

      const committedCanonical = await api<ApiEnvelope<CanonicalProjection>>(
        caller,
        canonicalPath(sessionId),
      );
      expect(committedCanonical.data.document).toMatchObject({
        document_id: documentId,
        revision: 2,
        nodes: [{
          id: NODE_ID,
          revision: 2,
          content: committedContent,
        }],
      });
      expect(committedCanonical.data.document.nodes[0]?.actions).toBeUndefined();
      const transactions = persistentGenerativeUiDocumentService.listTransactions(documentId, scope);
      expect(transactions).toHaveLength(2);
      expect(transactions.map((entry) => entry.transaction.transaction_id)).toEqual([
        pendingAgent.data.request_id,
        pendingAction.data.request_id,
      ]);
      expect(listPluginToolEvents(pendingAgent.data.request_id).filter((event) => event.event_type === "committed"))
        .toHaveLength(1);
      expect(listPluginToolEvents(pendingAction.data.request_id).filter((event) => event.event_type === "committed"))
        .toHaveLength(1);

    },
  );

  it("rejects a 64 KiB + 1 Tool body and keeps the Manager alive", async () => {
    const oversized = await fetch(`${baseUrl}/api/plugins/tools/invoke`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: Buffer.alloc(64 * 1024 + 1, 0x61),
    });
    expect(oversized.status).toBe(413);
    expect((await oversized.json()) as unknown).toMatchObject({ success: false });
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
  });
});
