import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildHrpArchive,
  scaffoldPluginProject,
  scanPluginSource,
  sourceFilesForPack,
} from "homerail-plugin-sdk";
import {
  GenerativeUiActorType,
  type GenerativeUiDocumentScopeV1,
  type GenerativeUiNodeV1,
} from "homerail-protocol";
import { persistentGenerativeUiDocumentService } from "../src/generative-ui/shadow-service.js";
import { closeDb } from "../src/persistence/db.js";
import {
  getPluginToolConfirmationForRequest,
  getPluginToolRequest,
  listPluginToolEvents,
} from "../src/persistence/plugin-actions.js";
import { _resetPluginActionBusForTest } from "../src/plugins/action-bus.js";
import { _requestManagerForTest as requestHostManager } from "../src/server/host-codex-manager-agent.js";
import { getManagerAgentTurnEnvelopeAuthority } from "../src/server/manager-agent-turn-envelope.js";
import { createServer } from "../src/server/http.js";
import {
  _requestManagerForTest as requestContainerManager,
  _withManagerTurnEnvelopeForTest,
} from "../../homerail_worker/src/manager-agent/server.js";

const ADMIN_TOKEN = "m5-http-action-admin-token-0123456789abcdef";
const PLUGIN_ID = "com.example.http-action";
const PLUGIN_VERSION = "1.0.0";
const ACTION_ID = "replace_card";
const NODE_ID = `${PLUGIN_ID}:current`;
const DOCUMENT_ID = "http-action-document";
let activeScope: GenerativeUiDocumentScopeV1 = {
  type: "voice_session",
  id: "http-action-session",
};
const ACTION_PATH = "/plugins/actions";

type ApiEnvelope<T> = { success: true; data: T };
type HttpCaller = (pathname: string, init?: RequestInit) => Promise<unknown>;

interface ActionResponse {
  request_id: string;
  request_digest: string;
  status: string;
  idempotent: boolean;
  tool: { local_id: string; qualified_id: string; wire_id: string };
  source: "ui_action" | "agent";
  missing_permissions?: string[];
  challenge?: {
    challenge_id: string;
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

const callerHarnesses: Array<{
  name: "Host" | "container";
  create: (baseUrl: string) => HttpCaller;
}> = [{
  name: "Host",
  create: (baseUrl) => (pathname, init) => requestHostManager(`${baseUrl}/api`, pathname, init),
}, {
  name: "container",
  create: (baseUrl) => {
    process.env.MANAGER_REST_URL = `${baseUrl}/api`;
    const envelope = getManagerAgentTurnEnvelopeAuthority().issue({
      payload: {
        session_id: activeScope.id,
        voice_session_id: activeScope.id,
        response_mode: "voice",
        generative_ui_mode: "prefer",
        // This fixture intentionally exercises the whole administrative
        // lifecycle from the Worker HTTP client. Grant only the exact routes
        // used by the scenario; production Agent turns receive the narrower
        // DEFAULT_MANAGER_AGENT_API_SCOPES set instead of an administrator
        // credential.
        manager_api_scopes: [
          "POST:/api/plugins/actions",
          "POST:/api/plugins/actions/*/confirmation",
          "POST:/api/plugins/install",
          "POST:/api/voice-agent/sessions",
          "PUT:/api/plugins/*/enabled",
          "PUT:/api/plugins/*/permissions",
        ],
      },
      target: { runtime_placement: "host_shell", worker_id: "action-golden-worker" },
    });
    return (pathname, init) => _withManagerTurnEnvelopeForTest(
      envelope,
      () => requestContainerManager(pathname, init),
    );
  },
}];

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: http.Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function addProjectionAction(sourceRoot: string): void {
  const manifestFile = path.join(sourceRoot, "homerail.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
    id: string;
    capabilities: Array<{ actions: string[] }>;
    schemas: Array<{ id: string; file: string }>;
    kinds: Array<{ versions: Array<{ actions: string[] }> }>;
    tools: Array<Record<string, unknown>>;
    actions: Array<Record<string, unknown>>;
    permissions: { optional: Array<Record<string, unknown>> };
  };
  const contentSchema = JSON.parse(
    fs.readFileSync(path.join(sourceRoot, "schemas/card-content.v1.schema.json"), "utf8"),
  ) as Record<string, unknown>;
  writeJson(path.join(sourceRoot, "schemas/card-action.v1.schema.json"), {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      id: { type: "string", minLength: manifest.id.length + 2, maxLength: 256 },
      content: contentSchema,
    },
    required: ["id", "content"],
    additionalProperties: false,
  });
  writeJson(path.join(sourceRoot, "ui/projectors/card-action.v1.json"), {
    projection_version: 1,
    type: "direct_ui_node",
    kind: `${manifest.id}/card`,
    kind_version: 1,
    node_id_pointer: "/id",
    content_pointer: "/content",
    omit_content_fields: [],
    fallback: {
      title_pointer: "/content/title",
      summary_pointer: "/content/summary",
    },
    defaults: {
      surface: "task",
      importance: "primary",
      density: "detail",
      persistence: "session",
    },
  });
  manifest.schemas.push({ id: "card-action-v1", file: "schemas/card-action.v1.schema.json" });
  manifest.capabilities[0].actions.push(ACTION_ID);
  manifest.kinds[0].versions[0].actions.push(ACTION_ID);
  manifest.permissions.optional.push({
    permission: "artifact.write",
    paths: ["artifacts/releases"],
  });
  manifest.tools.push({
    id: "replace_card_tool",
    description: "Replace the selected card through an Action-bound Tool.",
    exposure: ["action"],
    input_schema: "card-action-v1",
    output_schema: "card-content-v1",
    effect: "write",
    permissions: ["artifact.write"],
    confirmation: "always",
    handler: { type: "projection", file: "ui/projectors/card-action.v1.json" },
  });
  manifest.actions.push({
    id: ACTION_ID,
    intent: `${manifest.id}.${ACTION_ID}`,
    tool: "replace_card_tool",
  });
  writeJson(manifestFile, manifest);
}

function initialNode(): GenerativeUiNodeV1 {
  return {
    ir_version: 1,
    id: NODE_ID,
    kind: `${PLUGIN_ID}/card`,
    kind_version: 1,
    owner: { id: PLUGIN_ID, version: PLUGIN_VERSION },
    surface: "task",
    importance: "primary",
    content: {
      title: "HTTP Action Golden",
      summary: "Ready for the real HTTP pipeline.",
      items: ["pending"],
    },
    lifecycle: { persistence: "session" },
    actions: [{
      id: ACTION_ID,
      label: "Commit",
      intent: `${PLUGIN_ID}.${ACTION_ID}`,
      arguments: {
        id: NODE_ID,
        content: {
          title: "HTTP Action Golden",
          summary: "Committed by the real HTTP Action pipeline.",
          items: ["done"],
        },
      },
      confirmation: { required: true, message: "Commit this card?" },
    }],
    fallback: {
      title: "HTTP Action Golden",
      summary: "Ready for the real HTTP pipeline.",
    },
  };
}

function actionInput(suffix: "missing" | "commit"): Record<string, unknown> {
  return {
    request_id: `http_action_${suffix}_request`,
    idempotency_key: `http_action_${suffix}_idempotency`,
    scope: activeScope,
    document_id: DOCUMENT_ID,
    document_revision: 1,
    node_id: NODE_ID,
    node_revision: 1,
    action_id: ACTION_ID,
    input: {},
  };
}

function jsonMutation(method: "POST" | "PUT", body: unknown): RequestInit {
  return { method, body: JSON.stringify(body) };
}

async function api<T>(caller: HttpCaller, pathname: string, init?: RequestInit): Promise<T> {
  return await caller(pathname, init) as T;
}

describe("Plugin Action real HTTP golden scenario", () => {
  let savedEnv: NodeJS.ProcessEnv;
  let home: string;
  let sourceRoot: string;
  let server: http.Server | undefined;
  let baseUrl = "";

  beforeEach(async () => {
    savedEnv = { ...process.env };
    closeDb();
    _resetPluginActionBusForTest();
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-action-http-home-"));
    sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-action-http-source-"));
    process.env.HOMERAIL_HOME = home;
    process.env.HOMERAIL_LOCAL_NODE_AUTOSTART = "0";
    process.env.HOMERAIL_MANAGER_ADMIN_TOKEN = ADMIN_TOKEN;
    process.env.HOMERAIL_GENERATIVE_UI_MODE = "prefer";
    delete process.env.HOMERAIL_MANAGER_HOST;
    delete process.env.HOMERAIL_MANAGER_PUBLIC_URL;
    delete process.env.HOMERAIL_MANAGER_ADMIN_ORIGINS;
    scaffoldPluginProject(sourceRoot, PLUGIN_ID, {
      name: "HTTP Action Golden",
      version: PLUGIN_VERSION,
    });
    addProjectionAction(sourceRoot);
    server = createServer(0, undefined, undefined, false);
    baseUrl = await listen(server);
  });

  afterEach(async () => {
    await close(server);
    _resetPluginActionBusForTest();
    closeDb();
    process.env = savedEnv;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  });

  it.each(callerHarnesses)(
    "$name caller uses the same authenticated HTTP Action contract and commits exactly once",
    async ({ create }) => {
      const caller = create(baseUrl);
      const unauthenticated = await fetch(`${baseUrl}/api/plugins/actions`, {
        method: "POST",
        body: "{}",
      });
      expect(unauthenticated.status).toBe(401);

      const snapshot = scanPluginSource(sourceRoot);
      expect(snapshot.issues).toEqual([expect.objectContaining({
        severity: "warning",
        message: expect.stringContaining("M4 data-only"),
      })]);
      expect(snapshot).toMatchObject({
        valid: true,
        m4_data_only_eligible: false,
        m5_projection_action_eligible: true,
        m5_projection_action_eligibility_reasons: [],
      });
      const archive = buildHrpArchive(sourceFilesForPack(snapshot)).archive;
      const installed = await api<ApiEnvelope<{
        plugin_id: string;
        plugin_version: string;
        m5_projection_action_eligible: boolean;
        activation: { active_version: string; enabled: boolean; revision: number };
      }>>(caller, "/plugins/install?channel=staging", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.homerail.plugin+zip" },
        body: archive,
      });
      expect(installed).toMatchObject({
        success: true,
        data: {
          plugin_id: PLUGIN_ID,
          plugin_version: PLUGIN_VERSION,
          m5_projection_action_eligible: true,
          activation: { active_version: PLUGIN_VERSION, enabled: false, revision: 1 },
        },
      });
      await expect(api(caller, `/plugins/${PLUGIN_ID}/enabled`, jsonMutation("PUT", {
        enabled: true,
        expected_revision: installed.data.activation.revision,
        expected_active_version: installed.data.activation.active_version,
      }))).resolves.toMatchObject({
        success: true,
        data: { activation: { enabled: true, revision: 2 } },
      });

      const session = await api<ApiEnvelope<{ session_id: string; generative_ui_mode: string }>>(
        caller,
        "/voice-agent/sessions",
        jsonMutation("POST", {}),
      );
      expect(session.data.generative_ui_mode).toBe("prefer");
      activeScope = { type: "voice_session", id: session.data.session_id };

      const createdAt = new Date().toISOString();
      persistentGenerativeUiDocumentService.createOrGet({
        documentId: DOCUMENT_ID,
        scope: activeScope,
        createdAt,
        purpose: "canonical",
      });
      expect(persistentGenerativeUiDocumentService.apply({
        ir_version: 1,
        transaction_id: "seed-http-action-document",
        document_id: DOCUMENT_ID,
        base_revision: 0,
        actor: { type: GenerativeUiActorType.AGENT, id: "http-golden-test" },
        operations: [{ op: "put", node: initialNode() }],
        created_at: createdAt,
      }, activeScope)).toMatchObject({ status: "applied", revision: 1 });

      const missingInput = actionInput("missing");
      const missingEnvelope = await api<ApiEnvelope<ActionResponse>>(
        caller,
        ACTION_PATH,
        jsonMutation("POST", missingInput),
      );
      expect(missingEnvelope).toMatchObject({
        success: true,
        data: {
          request_id: missingInput.request_id,
          status: "needs_grant",
          idempotent: false,
          missing_permissions: ["artifact.write"],
        },
      });
      expect(Object.keys(missingEnvelope.data).sort()).toEqual([
        "idempotent",
        "missing_permissions",
        "request_digest",
        "request_id",
        "source",
        "status",
        "tool",
      ]);
      expect(persistentGenerativeUiDocumentService.get(DOCUMENT_ID, activeScope)).toMatchObject({ revision: 1 });

      const grants = await api<ApiEnvelope<{ grants: Array<{
        permission: string;
        status: string;
        revision: number;
        declaration: { grant: { permission: string; paths?: string[] } };
      }> }>>(caller, `/plugins/${PLUGIN_ID}/permissions?version=${PLUGIN_VERSION}`);
      const artifactGrant = grants.data.grants.find((grant) => grant.permission === "artifact.write");
      expect(artifactGrant).toMatchObject({
        status: "pending",
        revision: 1,
        declaration: {
          grant: { permission: "artifact.write", paths: ["artifacts/releases"] },
        },
      });
      await expect(api(caller, `/plugins/${PLUGIN_ID}/permissions`, jsonMutation("PUT", {
        version: PLUGIN_VERSION,
        permission: "artifact.write",
        status: "granted",
        expected_revision: artifactGrant!.revision,
      }))).resolves.toMatchObject({
        success: true,
        data: { grant: { status: "granted", revision: 2 } },
      });

      const immutableMissing = await api<ApiEnvelope<ActionResponse>>(
        caller,
        ACTION_PATH,
        jsonMutation("POST", {
          ...missingInput,
          request_digest: missingEnvelope.data.request_digest,
        }),
      );
      expect(immutableMissing).toMatchObject({
        success: true,
        data: {
          request_id: missingInput.request_id,
          request_digest: missingEnvelope.data.request_digest,
          status: "needs_grant",
          idempotent: true,
        },
      });
      expect(getPluginToolRequest(String(missingInput.request_id))).toMatchObject({ status: "needs_grant" });

      const commitInput = actionInput("commit");
      const pendingEnvelope = await api<ApiEnvelope<ActionResponse>>(
        caller,
        ACTION_PATH,
        jsonMutation("POST", commitInput),
      );
      expect(pendingEnvelope).toMatchObject({
        success: true,
        data: {
          request_id: commitInput.request_id,
          status: "awaiting_confirmation",
          idempotent: false,
          challenge: {
            effect: "write",
            permissions: ["artifact.write"],
            effective_grants: [{
              permission: "artifact.write",
              paths: ["artifacts/releases"],
            }],
            message: `Allow ${PLUGIN_ID}@${PLUGIN_VERSION} to perform write Tool replace_card_tool for Action ${ACTION_ID} on node ${NODE_ID}?`,
          },
        },
      });
      expect(Object.keys(pendingEnvelope.data).sort()).toEqual([
        "challenge",
        "idempotent",
        "request_digest",
        "request_id",
        "source",
        "status",
        "tool",
      ]);
      expect(getPluginToolRequest(String(commitInput.request_id))!.invocation.binding.permission_revision)
        .toBeGreaterThan(getPluginToolRequest(String(missingInput.request_id))!.invocation.binding.permission_revision);

      const challengeId = pendingEnvelope.data.challenge!.challenge_id;
      const committedEnvelope = await api<ApiEnvelope<ActionResponse>>(
        caller,
        `${ACTION_PATH}/${encodeURIComponent(String(commitInput.request_id))}/confirmation`,
        jsonMutation("POST", { challenge_id: challengeId, decision: "approved" }),
      );
      expect(committedEnvelope).toMatchObject({
        success: true,
        data: {
          request_id: commitInput.request_id,
          request_digest: pendingEnvelope.data.request_digest,
          status: "committed",
          idempotent: false,
          result: {
            output_type: "ui_transaction",
            transaction_id: commitInput.request_id,
            document_id: DOCUMENT_ID,
            document_revision: 2,
          },
        },
      });
      expect(Object.keys(committedEnvelope.data).sort()).toEqual([
        "idempotent",
        "request_digest",
        "request_id",
        "result",
        "source",
        "status",
        "tool",
      ]);
      expect(getPluginToolConfirmationForRequest(String(commitInput.request_id))).toMatchObject({
        status: "consumed",
        decision: {
          decision: "approved",
          actor: { type: "user", id: "authenticated_local_user" },
        },
      });
      expect(persistentGenerativeUiDocumentService.get(DOCUMENT_ID, activeScope)).toMatchObject({
        revision: 2,
        nodes: [{
          id: NODE_ID,
          revision: 2,
          content: {
            title: "HTTP Action Golden",
            summary: "Committed by the real HTTP Action pipeline.",
            items: ["done"],
          },
        }],
      });

      const committedTransactions = persistentGenerativeUiDocumentService.listTransactions(DOCUMENT_ID, activeScope);
      expect(committedTransactions.map((entry) => entry.transaction_id)).toEqual([
        "seed-http-action-document",
        commitInput.request_id,
      ]);
      expect(committedTransactions.at(-1)).toMatchObject({
        committed_revision: 2,
        transaction: {
          actor: {
            type: "plugin",
            id: `${PLUGIN_ID}:replace_card_tool`,
            plugin: { id: PLUGIN_ID, version: PLUGIN_VERSION },
          },
        },
      });

      const exactRetry = await api<ApiEnvelope<ActionResponse>>(
        caller,
        ACTION_PATH,
        jsonMutation("POST", {
          ...commitInput,
          request_digest: committedEnvelope.data.request_digest,
        }),
      );
      expect(exactRetry).toMatchObject({
        success: true,
        data: {
          request_id: committedEnvelope.data.request_id,
          request_digest: committedEnvelope.data.request_digest,
          status: "committed",
          idempotent: true,
          result: committedEnvelope.data.result,
        },
      });
      expect(exactRetry.data.result).toEqual(committedEnvelope.data.result);
      expect(exactRetry.data.challenge?.challenge_id).toBe(challengeId);
      expect(persistentGenerativeUiDocumentService.listTransactions(DOCUMENT_ID, activeScope))
        .toHaveLength(2);
      const events = listPluginToolEvents(String(commitInput.request_id));
      expect(events.filter((event) => event.event_type === "running")).toHaveLength(1);
      expect(events.filter((event) => event.event_type === "committed")).toHaveLength(1);
      expect(events.filter((event) => event.event_type === "duplicate")).toHaveLength(1);
    },
  );
});
