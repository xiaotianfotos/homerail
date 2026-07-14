import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  GENERATIVE_UI_IR_VERSION,
  GenerativeUiActorType,
  GenerativeUiDocumentScopeType,
  HomerailPluginPermission,
  HOMERAIL_ACTION_CONFIRMATION_MAX_TTL_MS,
  HOMERAIL_ACTION_REQUEST_MAX_TTL_MS,
  applyHomerailDirectUiProjection,
  homerailPluginToolInvocationDigestInput,
  validateGenerativeUiInteractionEvent,
  validateGenerativeUiNode,
  validateHomerailDirectUiProjection,
  validateHomerailPluginAuthorizedToolInvocation,
  validateHomerailPluginToolInput,
  type GenerativeUiDocumentScopeV1,
  type GenerativeUiDocumentV1,
  type GenerativeUiStoredNodeV1,
  type GenerativeUiTransactionV1,
  type HomerailPluginAuthorizedToolInvocationV1,
  type HomerailPluginResolvedHandlerV1,
  type HomerailPluginRuntimeExecutionOutputV1,
  type HomerailPluginRuntimeArtifactUploadV1,
  type HomerailPluginToolConfirmationChallengeV1,
  type HomerailPluginToolConfirmationDecisionV1,
  type HomerailPluginToolDescriptorV1,
  type HomerailPluginToolExecutionEnvelopeV1,
  type HomerailPluginToolInvocationV1,
  type HomerailPluginTurnContextV1,
} from "homerail-protocol";
import { persistentGenerativeUiDocumentService } from "../generative-ui/shadow-service.js";
import type { PersistentGenerativeUiDocumentService } from "../generative-ui/persistent-document-service.js";
import { voiceCanonicalDocumentId } from "../generative-ui/canonical-voice-service.js";
import {
  resolveVoiceSessionGenerativeUiMode,
  type GenerativeUiDocumentPurpose,
} from "../generative-ui/session-mode.js";
import type { GenerativeUiMode } from "../generative-ui/mode.js";
import { getDb } from "../persistence/db.js";
import {
  appendPluginToolEvent,
  consumePluginToolConfirmation,
  createPluginToolRequest,
  decidePluginToolConfirmation,
  getPluginToolConfirmationForRequest,
  getPluginToolRequest,
  getUnresolvedPluginToolTarget,
  listPendingPluginToolConfirmationsForScope,
  resolvePluginToolRuntimeAmbiguity,
  transitionPluginToolRequest,
  type PluginToolRequestRecord,
} from "../persistence/plugin-actions.js";
import { enqueuePluginAgentToolContinuation } from "../persistence/plugin-tool-continuations.js";
import {
  getActivePlugin,
  getPluginRegistryState,
  getPluginPermissionRevision,
  type ActivePluginRecord,
} from "../persistence/plugins.js";
import {
  assemblePluginTurnContext,
  selectPluginTurnContext,
} from "./context-assembler.js";
import { PluginToolCapabilityTokenAuthority, loadPluginCapabilitySecret } from "./capability-token.js";
import { pluginJsonDigest } from "./descriptor.js";
import { resolvePluginPermissionPolicy, type PluginPermissionPolicySnapshotV1 } from "./permission-broker.js";
import {
  PluginRuntimeBroker,
  PluginRuntimeIndeterminateFailure,
  PluginRuntimeTransportRegistry,
} from "./runtime-broker.js";
import { ensureBuiltinPluginsSynced } from "./registry.js";
import { PluginToolTurnTokenAuthority } from "./tool-turn-token.js";
import { getPluginRuntimeSandboxGate } from "./runtime-sandbox-config.js";
import { getPluginArtifactBroker, type PluginArtifactBroker } from "./artifact-broker.js";
import { ensurePluginRuntimeTransport } from "./runtime-orchestrator.js";

const WIRE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;
const LOCAL_ID = /^[a-z][a-z0-9._-]{0,127}$/;
const REQUEST_TTL_MS = Math.min(10 * 60_000, HOMERAIL_ACTION_REQUEST_MAX_TTL_MS);
const CONFIRMATION_TTL_MS = Math.min(5 * 60_000, HOMERAIL_ACTION_CONFIRMATION_MAX_TTL_MS);
const MAX_ERROR_MESSAGE_BYTES = 1_000;

function normalizeArtifactBrokerBaseUrl(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  const value = new URL(raw);
  if ((value.protocol !== "http:" && value.protocol !== "https:")
    || value.username || value.password || value.search || value.hash) {
    throw new Error("Plugin Artifact Broker base URL must be an exact HTTP(S) origin/path");
  }
  if (!value.pathname.endsWith("/")) value.pathname += "/";
  return value.toString();
}

export interface PluginActionInteractionInput {
  request_id: string;
  idempotency_key: string;
  request_digest?: string;
  scope: GenerativeUiDocumentScopeV1;
  document_id: string;
  document_revision: number;
  node_id: string;
  node_revision: number;
  action_id: string;
  input?: Record<string, unknown>;
}

export interface PluginAgentToolInvocationInput {
  request_id: string;
  idempotency_key: string;
  request_digest?: string;
  turn_token: string;
  tool_wire_id: string;
  call_id: string;
  arguments: Record<string, unknown>;
}

interface PluginConfirmationInput {
  request_id: string;
  challenge_id: string;
  decision: "approved" | "denied";
  actor_id: string;
}

export interface PluginActionBusResponse {
  request_id: string;
  request_digest: string;
  status: PluginToolRequestRecord["status"];
  idempotent: boolean;
  tool: { local_id: string; qualified_id: string; wire_id: string };
  source: "ui_action" | "agent";
  missing_permissions?: string[];
  denied_permissions?: string[];
  challenge?: HomerailPluginToolConfirmationChallengeV1;
  result?: Record<string, unknown>;
  error_code?: string;
  error_message?: string;
}

export type PluginBuiltinToolHandler = (input: {
  authorization: HomerailPluginAuthorizedToolInvocationV1;
}) => Promise<HomerailPluginRuntimeExecutionOutputV1> | HomerailPluginRuntimeExecutionOutputV1;

export class PluginBuiltinToolRegistry {
  readonly #handlers = new Map<string, PluginBuiltinToolHandler>();

  register(id: string, handler: PluginBuiltinToolHandler): void {
    if (!LOCAL_ID.test(id)) throw new Error(`Invalid builtin Tool handler id: ${id}`);
    if (this.#handlers.has(id)) throw new Error(`Builtin Tool handler is already registered: ${id}`);
    this.#handlers.set(id, handler);
  }

  resolve(id: string): PluginBuiltinToolHandler | undefined {
    return this.#handlers.get(id);
  }
}

interface ResolvedTool {
  plugin: ActivePluginRecord;
  manifest_tool: ActivePluginRecord["descriptor"]["manifest"]["tools"][number];
  descriptor: HomerailPluginToolDescriptorV1;
  policy: PluginPermissionPolicySnapshotV1;
  scope: GenerativeUiDocumentScopeV1;
}

interface ResolvedAction extends ResolvedTool {
  node: GenerativeUiStoredNodeV1;
  node_action: NonNullable<GenerativeUiStoredNodeV1["actions"]>[number];
  manifest_action: ActivePluginRecord["descriptor"]["manifest"]["actions"][number];
  invocation: HomerailPluginToolInvocationV1;
}

class PluginToolCommitFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PluginToolCommitFailure";
    this.code = code;
  }
}

function identifier(prefix: string): string {
  return `${prefix}_${randomBytes(18).toString("hex")}`;
}

function assertOpaqueId(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 256
    || /[\u0000-\u001f\u007f]/.test(value)
    || !value.trim()
  ) throw new Error(`${label} is invalid`);
}

function normalizeScope(value: unknown): GenerativeUiDocumentScopeV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("scope is invalid");
  const scope = value as Record<string, unknown>;
  if (Object.keys(scope).some((key) => key !== "type" && key !== "id")) throw new Error("scope is invalid");
  if (!Object.values(GenerativeUiDocumentScopeType).includes(scope.type as GenerativeUiDocumentScopeV1["type"])) {
    throw new Error("scope.type is invalid");
  }
  assertOpaqueId(scope.id, "scope.id");
  return { type: scope.type as GenerativeUiDocumentScopeV1["type"], id: scope.id };
}

function normalizedObject(value: unknown, label: string): Record<string, unknown> {
  const input = value ?? {};
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${label} must be an object`);
  try {
    return structuredClone(input) as Record<string, unknown>;
  } catch {
    throw new Error(`${label} could not be snapshotted`);
  }
}

export function normalizePluginActionInteraction(value: unknown): PluginActionInteractionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Plugin Action request must be an object");
  const body = value as Record<string, unknown>;
  const allowed = new Set([
    "request_id", "idempotency_key", "request_digest", "scope", "document_id",
    "document_revision", "node_id", "node_revision", "action_id", "input",
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) throw new Error("Plugin Action request contains unknown fields");
  if (typeof body.request_id !== "string" || !WIRE_ID.test(body.request_id)) throw new Error("request_id is invalid");
  if (typeof body.idempotency_key !== "string" || !WIRE_ID.test(body.idempotency_key)) {
    throw new Error("idempotency_key is invalid");
  }
  if (body.request_digest !== undefined && (typeof body.request_digest !== "string" || !/^[a-f0-9]{64}$/.test(body.request_digest))) {
    throw new Error("request_digest is invalid");
  }
  assertOpaqueId(body.document_id, "document_id");
  assertOpaqueId(body.node_id, "node_id");
  if (typeof body.action_id !== "string" || !LOCAL_ID.test(body.action_id)) throw new Error("action_id is invalid");
  if (!Number.isSafeInteger(body.document_revision) || Number(body.document_revision) < 0) {
    throw new Error("document_revision is invalid");
  }
  if (!Number.isSafeInteger(body.node_revision) || Number(body.node_revision) < 1) {
    throw new Error("node_revision is invalid");
  }
  const input = normalizedObject(body.input, "Action input");
  const event = validateGenerativeUiInteractionEvent({
    ir_version: GENERATIVE_UI_IR_VERSION,
    event_id: body.request_id,
    idempotency_key: body.idempotency_key,
    document_id: body.document_id,
    node_id: body.node_id,
    node_revision: Number(body.node_revision),
    action_id: body.action_id,
    ...(Object.keys(input).length ? { input } : {}),
    created_at: new Date().toISOString(),
  });
  if (!event.valid) throw new Error(`Plugin Action interaction is invalid: ${JSON.stringify(event.errors)}`);
  return {
    request_id: body.request_id,
    idempotency_key: body.idempotency_key,
    ...(body.request_digest ? { request_digest: body.request_digest } : {}),
    scope: normalizeScope(body.scope),
    document_id: body.document_id,
    document_revision: Number(body.document_revision),
    node_id: body.node_id,
    node_revision: Number(body.node_revision),
    action_id: body.action_id,
    ...(Object.keys(input).length ? { input } : {}),
  };
}

export function normalizePluginAgentToolInvocation(value: unknown): PluginAgentToolInvocationInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Plugin Tool request must be an object");
  const body = value as Record<string, unknown>;
  const allowed = new Set([
    "request_id", "idempotency_key", "request_digest", "turn_token", "tool_wire_id",
    "call_id", "arguments",
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) throw new Error("Plugin Tool request contains unknown fields");
  for (const field of ["request_id", "idempotency_key", "call_id"] as const) {
    if (typeof body[field] !== "string" || !WIRE_ID.test(body[field])) throw new Error(`${field} is invalid`);
  }
  if (body.request_digest !== undefined && (typeof body.request_digest !== "string" || !/^[a-f0-9]{64}$/.test(body.request_digest))) {
    throw new Error("request_digest is invalid");
  }
  if (typeof body.tool_wire_id !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(body.tool_wire_id)) {
    throw new Error("tool_wire_id is invalid");
  }
  if (typeof body.turn_token !== "string" || body.turn_token.length < 32 || body.turn_token.length > 16 * 1024) {
    throw new Error("turn_token is invalid");
  }
  return {
    request_id: body.request_id as string,
    idempotency_key: body.idempotency_key as string,
    ...(body.request_digest ? { request_digest: body.request_digest as string } : {}),
    turn_token: body.turn_token,
    tool_wire_id: body.tool_wire_id,
    call_id: body.call_id as string,
    arguments: normalizedObject(body.arguments, "Tool arguments"),
  };
}

function normalizeConfirmation(requestId: string, value: unknown): PluginConfirmationInput {
  if (!WIRE_ID.test(requestId)) throw new Error("request_id is invalid");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("confirmation body must be an object");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !["challenge_id", "decision"].includes(key))) {
    throw new Error("confirmation contains unknown fields");
  }
  if (typeof body.challenge_id !== "string" || !WIRE_ID.test(body.challenge_id)) throw new Error("challenge_id is invalid");
  if (body.decision !== "approved" && body.decision !== "denied") throw new Error("confirmation decision is invalid");
  return {
    request_id: requestId,
    challenge_id: body.challenge_id,
    decision: body.decision,
    actor_id: "authenticated_local_user",
  };
}

function archivedProjectionHandler(
  plugin: ActivePluginRecord,
  file: string,
): Extract<HomerailPluginResolvedHandlerV1, { type: "projection" }> {
  const archived = plugin.descriptor.referenced_files.find((entry) => entry.path === file);
  if (!archived) throw new Error(`Plugin Tool projection is missing: ${plugin.plugin_id}:${file}`);
  const bytes = Buffer.from(archived.content, "base64");
  if (bytes.toString("base64") !== archived.content || createHash("sha256").update(bytes).digest("hex") !== archived.digest) {
    throw new Error("Plugin Tool projection archive binding is invalid");
  }
  let document: unknown;
  try { document = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Plugin Tool projection JSON is invalid"); }
  const validation = validateHomerailDirectUiProjection(document);
  if (!validation.valid || !validation.value) {
    throw new Error(`Plugin Tool projection is invalid: ${JSON.stringify(validation.errors)}`);
  }
  return {
    type: "projection",
    file,
    digest: archived.digest,
    document: validation.value as unknown as Record<string, unknown>,
  };
}

function stableWireId(pluginId: string, localId: string): string {
  const digest = createHash("sha256").update(`${pluginId}:${localId}`).digest("hex").slice(0, 10);
  const suffixBudget = 64 - 2 - digest.length - 1;
  return `p_${digest}_${localId.slice(0, suffixBudget)}`;
}

function valueAtPointer(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  let current = value;
  for (const encoded of pointer.slice(1).split("/")) {
    const segment = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!current || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function toolDescriptor(
  plugin: ActivePluginRecord,
  tool: ActivePluginRecord["descriptor"]["manifest"]["tools"][number],
  capabilityIds: readonly string[],
): HomerailPluginToolDescriptorV1 {
  const inputSchema = plugin.descriptor.schemas.find((entry) => entry.id === tool.input_schema)?.schema;
  const outputSchema = tool.output_schema
    ? plugin.descriptor.schemas.find((entry) => entry.id === tool.output_schema)?.schema
    : undefined;
  if (!inputSchema || (tool.output_schema && !outputSchema)) throw new Error(`Plugin Tool schema is missing: ${plugin.plugin_id}:${tool.id}`);
  const handler: HomerailPluginResolvedHandlerV1 = tool.handler.type === "projection"
    ? archivedProjectionHandler(plugin, tool.handler.file)
    : structuredClone(tool.handler);
  return {
    plugin_id: plugin.plugin_id,
    plugin_version: plugin.plugin_version,
    local_id: tool.id,
    qualified_id: `${plugin.plugin_id}:${tool.id}`,
    wire_id: stableWireId(plugin.plugin_id, tool.id),
    capability_ids: [...capabilityIds].sort(),
    description: `Plugin Tool ${plugin.plugin_id}:${tool.id}. ${tool.description}`,
    input_schema: structuredClone(inputSchema),
    ...(outputSchema ? { output_schema: structuredClone(outputSchema) } : {}),
    effect: tool.effect,
    permissions: [...tool.permissions],
    confirmation: tool.confirmation,
    handler,
  };
}

function handlerIdentity(handler: HomerailPluginResolvedHandlerV1): HomerailPluginToolInvocationV1["tool"]["handler"] {
  if (handler.type === "projection") return { type: "projection", digest: handler.digest };
  return structuredClone(handler);
}

function effectiveActionInput(
  nodeAction: NonNullable<GenerativeUiStoredNodeV1["actions"]>[number],
  input: Record<string, unknown>,
): Record<string, unknown> {
  const fixed = structuredClone(nodeAction.arguments ?? {});
  const conflicting = Object.keys(input).find((key) => Object.prototype.hasOwnProperty.call(fixed, key));
  if (conflicting) throw new Error(`Action input conflicts with Manager-owned fixed argument: ${conflicting}`);
  return { ...structuredClone(input), ...fixed };
}

function currentNode(document: GenerativeUiDocumentV1, nodeId: string): GenerativeUiStoredNodeV1 {
  const node = document.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`Plugin Action node is not present: ${nodeId}`);
  return node;
}

function toolPermissions(plugin: ActivePluginRecord, descriptor: HomerailPluginToolDescriptorV1): string[] {
  return [...new Set([
    ...plugin.descriptor.manifest.permissions.required.map((grant) => grant.permission),
    ...descriptor.permissions,
  ])].sort();
}

function policyFor(plugin: ActivePluginRecord, descriptor: HomerailPluginToolDescriptorV1): PluginPermissionPolicySnapshotV1 {
  return resolvePluginPermissionPolicy({
    plugin_id: plugin.plugin_id,
    plugin_version: plugin.plugin_version,
    permissions: toolPermissions(plugin, descriptor) as Parameters<typeof resolvePluginPermissionPolicy>[0]["permissions"],
    effect: descriptor.effect,
    confirmation: descriptor.confirmation,
  });
}

function buildInvocation(input: {
  request_id: string;
  idempotency_key: string;
  source: HomerailPluginToolInvocationV1["source"];
  plugin: ActivePluginRecord;
  descriptor: HomerailPluginToolDescriptorV1;
  context: HomerailPluginTurnContextV1;
  policy: PluginPermissionPolicySnapshotV1;
  arguments: Record<string, unknown>;
  invoked_at?: string;
}): HomerailPluginToolInvocationV1 {
  const inputValidation = validateHomerailPluginToolInput(input.descriptor.input_schema, input.arguments);
  if (!inputValidation.valid || !inputValidation.value) {
    throw new Error(`Plugin Tool input is invalid: ${JSON.stringify(inputValidation.errors)}`);
  }
  const invokedAt = input.invoked_at ?? new Date().toISOString();
  const unsigned: Omit<HomerailPluginToolInvocationV1, "request_digest"> = {
    tool_bus_version: 1,
    request_id: input.request_id,
    idempotency_key: input.idempotency_key,
    invoked_at: invokedAt,
    deadline_at: new Date(Date.parse(invokedAt) + REQUEST_TTL_MS).toISOString(),
    source: structuredClone(input.source),
    tool: {
      local_id: input.descriptor.local_id,
      qualified_id: input.descriptor.qualified_id,
      wire_id: input.descriptor.wire_id,
      handler: handlerIdentity(input.descriptor.handler),
    },
    binding: {
      plugin_id: input.plugin.plugin_id,
      plugin_version: input.plugin.plugin_version,
      manifest_digest: input.plugin.descriptor.manifest_digest,
      package_digest: input.plugin.package_digest,
      context_digest: input.context.context_digest,
      registry_revision: input.context.registry_revision,
      permission_revision: input.policy.permission_revision,
    },
    policy: {
      effect: input.descriptor.effect,
      permissions: toolPermissions(input.plugin, input.descriptor) as HomerailPluginToolInvocationV1["policy"]["permissions"],
      effective_grants: structuredClone(input.policy.effective_grants),
      confirmation: input.descriptor.confirmation,
      confirmation_required: input.policy.confirmation_required,
    },
    arguments: inputValidation.value,
  };
  const invocation: HomerailPluginToolInvocationV1 = {
    ...unsigned,
    request_digest: pluginJsonDigest(unsigned, 256 * 1024),
  };
  if (pluginJsonDigest(homerailPluginToolInvocationDigestInput(invocation), 256 * 1024) !== invocation.request_digest) {
    throw new Error("Manager produced a non-canonical Plugin Tool invocation");
  }
  return invocation;
}

function response(
  record: PluginToolRequestRecord,
  options: { idempotent: boolean; policy?: PluginPermissionPolicySnapshotV1; challenge?: HomerailPluginToolConfirmationChallengeV1 },
): PluginActionBusResponse {
  return {
    request_id: record.request_id,
    request_digest: record.request_digest,
    status: record.status,
    idempotent: options.idempotent,
    tool: {
      local_id: record.invocation.tool.local_id,
      qualified_id: record.invocation.tool.qualified_id,
      wire_id: record.invocation.tool.wire_id,
    },
    source: record.invocation.source.type,
    ...(options.policy?.missing_permissions.length ? { missing_permissions: options.policy.missing_permissions } : {}),
    ...(options.policy?.denied_permissions.length ? { denied_permissions: options.policy.denied_permissions } : {}),
    ...(options.challenge ? { challenge: structuredClone(options.challenge) } : {}),
    ...(record.result ? { result: structuredClone(record.result) } : {}),
    ...(record.error_code ? { error_code: record.error_code } : {}),
    ...(record.error_message ? { error_message: record.error_message } : {}),
  };
}

function failureCode(cause: unknown): string {
  if (cause instanceof PluginToolCommitFailure || cause instanceof PluginRuntimeIndeterminateFailure) return cause.code;
  const message = (cause instanceof Error ? cause.message : String(cause)).toLowerCase();
  if (message.includes("generative ui") && (message.includes("mode") || message.includes("authority"))) {
    return "mode_revoked";
  }
  if (message.includes("deadline") || message.includes("expired")) return "deadline_exceeded";
  if (message.includes("permission") || message.includes("grant")) return "permission_stale";
  if (message.includes("runtime") || message.includes("transport")) return "runtime_failure";
  if (message.includes("revision") || message.includes("stale") || message.includes("binding")) return "stale_target";
  if (message.includes("projection") || message.includes("transaction") || message.includes("kind") || message.includes("output")) return "invalid_output";
  return "tool_failed";
}

function failureMessage(cause: unknown): string {
  if (cause instanceof PluginRuntimeIndeterminateFailure) {
    return "Plugin Runtime result is indeterminate and requires reconciliation";
  }
  return (cause instanceof Error ? cause.message : String(cause))
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, MAX_ERROR_MESSAGE_BYTES);
}

function targetFor(invocation: HomerailPluginToolInvocationV1): {
  document_id: string;
  base_revision: number;
  scope: GenerativeUiDocumentScopeV1;
} {
  if (invocation.source.type === "ui_action") {
    return {
      document_id: invocation.source.target.document_id,
      base_revision: invocation.source.target.document_revision,
      scope: { type: "voice_session", id: "" },
    };
  }
  return {
    document_id: invocation.source.target.document_id,
    base_revision: invocation.source.target.base_revision,
    scope: structuredClone(invocation.source.scope),
  };
}

function exactTransactionAcl(
  transaction: GenerativeUiTransactionV1,
  record: PluginToolRequestRecord,
  document: GenerativeUiDocumentV1,
): void {
  const invocation = record.invocation;
  const plugin = { id: invocation.binding.plugin_id, version: invocation.binding.plugin_version };
  const target = targetFor(invocation);
  if (
    transaction.transaction_id !== record.request_id
    || transaction.document_id !== target.document_id
    || transaction.base_revision !== target.base_revision
    || transaction.actor.type !== GenerativeUiActorType.PLUGIN
    || transaction.actor.id !== invocation.tool.qualified_id
    || !transaction.actor.plugin
    || !isDeepStrictEqual(transaction.actor.plugin, plugin)
  ) throw new PluginToolCommitFailure("invalid_output", "Runtime UI transaction is outside the exact Tool scope");

  if (invocation.source.type === "ui_action") {
    if (transaction.operations.length !== 1) {
      throw new PluginToolCommitFailure("invalid_output", "Action Tool transaction must contain exactly one operation");
    }
    const operation = transaction.operations[0]!;
    const source = invocation.source.target;
    if (operation.op === "put") {
      if (operation.node.id !== source.node_id || !isDeepStrictEqual(operation.node.owner, plugin)) {
        throw new PluginToolCommitFailure("invalid_output", "Action Tool put is outside the exact owner/target");
      }
    } else if (operation.node_id !== source.node_id || operation.if_revision !== source.node_revision) {
      throw new PluginToolCommitFailure("invalid_output", "Action Tool mutation lacks the exact node revision guard");
    }
    return;
  }

  for (const operation of transaction.operations) {
    if (operation.op === "put") {
      const existing = document.nodes.find((node) => node.id === operation.node.id);
      if (
        !operation.node.id.startsWith(`${plugin.id}:`)
        || !isDeepStrictEqual(operation.node.owner, plugin)
        || (existing !== undefined && !isDeepStrictEqual(existing.owner, plugin))
      ) throw new PluginToolCommitFailure("invalid_output", "Agent Tool cannot put a node outside its plugin ownership");
    } else {
      const existing = document.nodes.find((node) => node.id === operation.node_id);
      if (!existing || !isDeepStrictEqual(existing.owner, plugin) || operation.if_revision !== existing.revision) {
        throw new PluginToolCommitFailure("invalid_output", "Agent Tool cannot mutate another owner or omit the live revision guard");
      }
    }
  }
}

function confirmationFor(record: PluginToolRequestRecord): HomerailPluginAuthorizedToolInvocationV1["confirmation"] {
  if (!record.invocation.policy.confirmation_required) return undefined;
  const confirmation = getPluginToolConfirmationForRequest(record.request_id);
  if (!confirmation || confirmation.status !== "approved" || !confirmation.decision) {
    throw new Error("Plugin Tool confirmation is not the exact persisted approval");
  }
  return { challenge: structuredClone(confirmation.challenge), decision: structuredClone(confirmation.decision) };
}

export class PluginToolInvocationService {
  readonly #documents: PersistentGenerativeUiDocumentService;
  readonly #tokens: PluginToolCapabilityTokenAuthority;
  readonly #runtime: PluginRuntimeBroker;
  readonly #builtins: PluginBuiltinToolRegistry;
  readonly #turns: PluginToolTurnTokenAuthority;
  readonly #artifacts: PluginArtifactBroker;
  readonly #artifactUploadBaseUrl?: string;
  readonly #resolveMode: (scope: GenerativeUiDocumentScopeV1) => GenerativeUiMode;

  constructor(input: {
    documents?: PersistentGenerativeUiDocumentService;
    tokens: PluginToolCapabilityTokenAuthority;
    runtime: PluginRuntimeBroker;
    builtins?: PluginBuiltinToolRegistry;
    turns?: PluginToolTurnTokenAuthority;
    artifacts?: PluginArtifactBroker;
    artifact_upload_base_url?: string;
    resolve_mode?: (scope: GenerativeUiDocumentScopeV1) => GenerativeUiMode;
  }) {
    this.#documents = input.documents ?? persistentGenerativeUiDocumentService;
    this.#tokens = input.tokens;
    this.#runtime = input.runtime;
    this.#builtins = input.builtins ?? new PluginBuiltinToolRegistry();
    this.#turns = input.turns ?? new PluginToolTurnTokenAuthority(loadPluginCapabilitySecret());
    this.#artifacts = input.artifacts ?? getPluginArtifactBroker();
    this.#artifactUploadBaseUrl = normalizeArtifactBrokerBaseUrl(
      input.artifact_upload_base_url ?? process.env.HOMERAIL_PLUGIN_ARTIFACT_BROKER_URL,
    );
    this.#resolveMode = input.resolve_mode ?? ((scope) => {
      if (scope.type !== "voice_session") return "off";
      return resolveVoiceSessionGenerativeUiMode(scope.id);
    });
  }

  #assertLiveUiAuthority(
    invocation: HomerailPluginToolInvocationV1,
    scope: GenerativeUiDocumentScopeV1,
  ): void {
    if (scope.type !== "voice_session" || this.#resolveMode(scope) !== "prefer") {
      throw new Error("Generative UI mode no longer authorizes Plugin Tool execution");
    }
    const canonical = this.#documents.findActiveForScope(scope, "canonical");
    if (!canonical || canonical.document_id !== targetFor(invocation).document_id) {
      throw new Error("Generative UI canonical document authority is stale");
    }
  }

  #resolveLive(record: PluginToolRequestRecord): ResolvedTool {
    ensureBuiltinPluginsSynced();
    const invocation = record.invocation;
    const plugin = getActivePlugin(invocation.binding.plugin_id);
    if (
      !plugin
      || !plugin.activation.enabled
      || plugin.plugin_version !== invocation.binding.plugin_version
      || plugin.package_digest !== invocation.binding.package_digest
      || plugin.descriptor.manifest_digest !== invocation.binding.manifest_digest
      || getPluginRegistryState().revision !== invocation.binding.registry_revision
      || getPluginPermissionRevision() !== invocation.binding.permission_revision
    ) throw new Error("Plugin Tool binding is stale");
    const manifestTool = plugin.descriptor.manifest.tools.find((tool) => tool.id === invocation.tool.local_id);
    if (!manifestTool) throw new Error("Plugin Tool is no longer declared");
    const descriptor = toolDescriptor(plugin, manifestTool, []);
    if (
      descriptor.qualified_id !== invocation.tool.qualified_id
      || descriptor.wire_id !== invocation.tool.wire_id
      || !isDeepStrictEqual(handlerIdentity(descriptor.handler), invocation.tool.handler)
    ) throw new Error("Plugin Tool handler identity is stale");
    const policy = policyFor(plugin, descriptor);
    if (
      policy.policy_digest !== record.policy_digest
      || policy.permission_revision !== invocation.binding.permission_revision
      || policy.effect !== invocation.policy.effect
      || policy.confirmation !== invocation.policy.confirmation
      || policy.confirmation_required !== invocation.policy.confirmation_required
      || !isDeepStrictEqual(toolPermissions(plugin, descriptor), invocation.policy.permissions)
      || !isDeepStrictEqual(policy.effective_grants, invocation.policy.effective_grants)
    ) throw new Error("Plugin Tool policy is stale");
    const inputValidation = validateHomerailPluginToolInput(descriptor.input_schema, invocation.arguments);
    if (!inputValidation.valid || !inputValidation.value || !isDeepStrictEqual(inputValidation.value, invocation.arguments)) {
      throw new Error("Plugin Tool arguments no longer match the immutable input schema");
    }
    const scope = invocation.source.type === "agent"
      ? invocation.source.scope
      : this.#documents.resolveScope(invocation.source.target.document_id);
    if (!scope) throw new Error("Generative UI document no longer exists");
    const document = this.#documents.get(
      invocation.source.target.document_id,
      scope,
    );
    const expectedRevision = invocation.source.type === "ui_action"
      ? invocation.source.target.document_revision
      : invocation.source.target.base_revision;
    if (!document || document.revision !== expectedRevision) throw new Error("Plugin Tool canonical document revision is stale");
    this.#assertLiveUiAuthority(invocation, scope);
    const source = invocation.source;
    if (source.type === "ui_action") {
      const node = currentNode(document, source.target.node_id);
      if (node.revision !== source.target.node_revision) throw new Error("Plugin Action node revision is stale");
      const nodeAction = node.actions?.find((action) => action.id === source.target.action_id);
      const manifestAction = plugin.descriptor.manifest.actions.find((action) => action.id === source.action.local_id);
      if (
        !nodeAction
        || !manifestAction
        || nodeAction.intent !== source.target.action_intent
        || manifestAction.intent !== nodeAction.intent
        || manifestAction.tool !== manifestTool.id
      ) throw new Error("Plugin Action to Tool binding is stale");
    }
    return { plugin, manifest_tool: manifestTool, descriptor, policy, scope };
  }

  #consumeInternalAuthorization(
    authorization: HomerailPluginAuthorizedToolInvocationV1,
    token: string,
    now: Date,
  ): void {
    const validation = validateHomerailPluginAuthorizedToolInvocation(authorization, { now_ms: now.getTime() });
    if (!validation.valid || !validation.value) {
      throw new Error(`Plugin Tool authorization is invalid: ${JSON.stringify(validation.errors)}`);
    }
    if (authorization.confirmation) {
      const stored = getPluginToolConfirmationForRequest(authorization.invocation.request_id);
      if (
        !stored
        || stored.status !== "approved"
        || !stored.decision
        || !isDeepStrictEqual(stored.challenge, authorization.confirmation.challenge)
        || !isDeepStrictEqual(stored.decision, authorization.confirmation.decision)
      ) throw new Error("Plugin Tool confirmation is not the exact persisted approval");
      consumePluginToolConfirmation(stored.challenge.challenge_id, now.toISOString());
    }
    const claims = this.#tokens.verifyAndConsume({ token, invocation: authorization.invocation, now });
    if (!isDeepStrictEqual(claims, authorization.capability)) throw new Error("Plugin Tool capability claims changed");
  }

  #projectionOutput(
    resolved: ResolvedTool,
    record: PluginToolRequestRecord,
  ): { output: HomerailPluginRuntimeExecutionOutputV1; envelope: HomerailPluginToolExecutionEnvelopeV1 } {
    if (resolved.descriptor.handler.type !== "projection" || !resolved.descriptor.output_schema) {
      throw new Error("Plugin Tool is not a declarative projection with an output schema");
    }
    const projection = applyHomerailDirectUiProjection({
      projection: resolved.descriptor.handler.document,
      plugin: { id: resolved.plugin.plugin_id, version: resolved.plugin.plugin_version },
      arguments: record.invocation.arguments,
    });
    const projectionSpec = validateHomerailDirectUiProjection(resolved.descriptor.handler.document);
    if (!projectionSpec.valid || !projectionSpec.value) throw new Error("Plugin Tool projection snapshot is invalid");
    const projectedActions = (projectionSpec.value.actions ?? []).map((declaration) => {
      const manifestAction = resolved.plugin.descriptor.manifest.actions.find((action) => action.id === declaration.id);
      if (!manifestAction) throw new Error(`Projected Action is not declared: ${declaration.id}`);
      const delegatedTool = resolved.plugin.descriptor.manifest.tools.find((tool) => tool.id === manifestAction.tool);
      if (!delegatedTool?.exposure.includes("action")) {
        throw new Error(`Projected Action does not delegate to an Action-exposed Tool: ${declaration.id}`);
      }
      const fixedArguments = declaration.arguments_pointer !== undefined
        ? valueAtPointer(record.invocation.arguments, declaration.arguments_pointer)
        : undefined;
      if (fixedArguments !== undefined && (
        !fixedArguments || typeof fixedArguments !== "object" || Array.isArray(fixedArguments)
      )) throw new Error(`Projected Action arguments must be an object: ${declaration.id}`);
      const delegatedDescriptor = toolDescriptor(resolved.plugin, delegatedTool, []);
      const delegatedPolicy = policyFor(resolved.plugin, delegatedDescriptor);
      return {
        id: manifestAction.id,
        label: declaration.label,
        intent: manifestAction.intent,
        ...(fixedArguments ? { arguments: structuredClone(fixedArguments) as Record<string, unknown> } : {}),
        ...(declaration.style ? { style: declaration.style } : {}),
        confirmation: { required: delegatedPolicy.confirmation_required },
      };
    });
    if (projectedActions.length) projection.node.actions = projectedActions;
    const nodeValidation = validateGenerativeUiNode(projection.node);
    if (!nodeValidation.valid || !nodeValidation.value) {
      throw new Error(`Plugin Tool projected an invalid actionable node: ${JSON.stringify(nodeValidation.errors)}`);
    }
    projection.node = nodeValidation.value;
    const outputValidation = validateHomerailPluginToolInput(resolved.descriptor.output_schema, projection.node.content);
    if (!outputValidation.valid) throw new Error(`Plugin Tool output is invalid: ${JSON.stringify(outputValidation.errors)}`);
    const source = record.invocation.source;
    if (source.type === "ui_action") projection.node.id = source.target.node_id;
    const envelope: HomerailPluginToolExecutionEnvelopeV1 = {
      execution_version: 1,
      status: "projected",
      committed: false,
      plugin: { id: resolved.plugin.plugin_id, version: resolved.plugin.plugin_version },
      tool: {
        local_id: resolved.descriptor.local_id,
        qualified_id: resolved.descriptor.qualified_id,
        wire_id: resolved.descriptor.wire_id,
        handler_digest: resolved.descriptor.handler.digest,
      },
      arguments: structuredClone(record.invocation.arguments),
      projection,
    };
    const target = source.type === "ui_action"
      ? { document_id: source.target.document_id, base_revision: source.target.document_revision }
      : source.target;
    return {
      envelope,
      output: {
        type: "ui_transaction",
        transaction: {
          ir_version: GENERATIVE_UI_IR_VERSION,
          transaction_id: record.request_id,
          document_id: target.document_id,
          base_revision: target.base_revision,
          actor: {
            type: GenerativeUiActorType.PLUGIN,
            id: record.invocation.tool.qualified_id,
            plugin: {
              id: record.invocation.binding.plugin_id,
              version: record.invocation.binding.plugin_version,
            },
          },
          operations: [{ op: "put", node: projection.node }],
          created_at: record.invocation.invoked_at,
        },
      },
    };
  }

  #commitOutput(
    record: PluginToolRequestRecord,
    output: HomerailPluginRuntimeExecutionOutputV1,
    now: Date,
    envelope?: HomerailPluginToolExecutionEnvelopeV1,
    expectedStatus: "running" | "failed" = "running",
  ): PluginToolRequestRecord {
    if (expectedStatus === "failed" && record.error_code !== "runtime_indeterminate") {
      throw new Error("Only an indeterminate Runtime request may reconcile to committed");
    }
    if (output.type === "domain_output") {
      return getDb().transaction(() => {
        const live = this.#resolveLive(record);
        if (live.descriptor.output_schema) {
          const validation = validateHomerailPluginToolInput(live.descriptor.output_schema, output.output);
          if (!validation.valid) throw new PluginToolCommitFailure("invalid_output", `Plugin Tool output schema rejected the result: ${JSON.stringify(validation.errors)}`);
        }
        const committed = transitionPluginToolRequest({
          request_id: record.request_id,
          expected_status: expectedStatus,
          status: "committed",
          updated_at: now.toISOString(),
          result: { output_type: "domain_output", output: structuredClone(output.output) },
        });
        appendPluginToolEvent({
          request_id: record.request_id,
          request_digest: record.request_digest,
          event_type: "committed",
          created_at: now.toISOString(),
          data: { output_type: "domain_output" },
        });
        return committed;
      }).immediate();
    }
    const target = targetFor(record.invocation);
    return getDb().transaction(() => {
      const live = this.#resolveLive(record);
      const scope = record.invocation.source.type === "ui_action" ? live.scope : target.scope;
      const document = this.#documents.get(target.document_id, scope);
      if (!document) throw new PluginToolCommitFailure("stale_target", "Generative UI document no longer exists");
      exactTransactionAcl(output.transaction, record, document);
      const result = this.#documents.apply(output.transaction, scope);
      if (result.status !== "applied") {
        throw new PluginToolCommitFailure(
          result.status === "conflict" ? "stale_target" : "invalid_output",
          `Plugin Tool UI transaction was not applied: ${result.status} ${JSON.stringify(result.errors ?? [])}`,
        );
      }
      const committed = transitionPluginToolRequest({
        request_id: record.request_id,
        expected_status: expectedStatus,
        status: "committed",
        updated_at: now.toISOString(),
        result: {
          output_type: "ui_transaction",
          transaction_id: output.transaction.transaction_id,
          document_id: output.transaction.document_id,
          document_revision: result.revision,
          ...(envelope ? { projection: envelope } : {}),
        },
      });
      appendPluginToolEvent({
        request_id: record.request_id,
        request_digest: record.request_digest,
        event_type: "committed",
        created_at: now.toISOString(),
        data: {
          output_type: "ui_transaction",
          transaction_id: output.transaction.transaction_id,
          document_revision: result.revision,
        },
      });
      return committed;
    }).immediate();
  }

  async #execute(record: PluginToolRequestRecord): Promise<PluginToolRequestRecord> {
    const now = new Date();
    let claimed = false;
    let effectCompleted = false;
    let resolved: ResolvedTool | undefined;
    try {
      resolved = this.#resolveLive(record);
      const running = transitionPluginToolRequest({
        request_id: record.request_id,
        expected_status: "authorized",
        status: "running",
        updated_at: now.toISOString(),
      });
      claimed = true;
      appendPluginToolEvent({
        request_id: record.request_id,
        request_digest: record.request_digest,
        event_type: "running",
        created_at: now.toISOString(),
        data: { handler_type: resolved.descriptor.handler.type, tool: resolved.descriptor.qualified_id },
      });
      const issued = this.#tokens.issue({ invocation: running.invocation, now, ttl_ms: 60_000 });
      const confirmation = confirmationFor(running);
      const authorization: HomerailPluginAuthorizedToolInvocationV1 = {
        authorization_version: 1,
        invocation: structuredClone(running.invocation),
        capability: issued.claims,
        ...(confirmation ? { confirmation } : {}),
      };
      let output: HomerailPluginRuntimeExecutionOutputV1;
      let envelope: HomerailPluginToolExecutionEnvelopeV1 | undefined;
      if (resolved.descriptor.handler.type === "runtime") {
        let artifactUploads: HomerailPluginRuntimeArtifactUploadV1[] | undefined;
        if (running.invocation.policy.effective_grants.some((grant) => (
          grant.permission === HomerailPluginPermission.ARTIFACT_WRITE
        ))) {
          const prepared = await this.#runtime.prepare({ authorization, now });
          if (prepared.artifact_declarations.length && !this.#artifactUploadBaseUrl) {
            throw new Error("Plugin Artifact Broker URL is required for artifact-producing Runtime Tools");
          }
          artifactUploads = prepared.artifact_declarations.map((declaration) => {
            const capability = this.#artifacts.issueWriteCapability({
              authorization,
              artifact: {
                label: declaration.label,
                media_type: declaration.media_type,
                digest: declaration.digest,
                size_bytes: declaration.size_bytes,
              },
              now: new Date(),
            });
            return {
              ...structuredClone(declaration),
              capability_id: capability.claims.capability_id,
              upload_url: new URL(capability.upload_path, this.#artifactUploadBaseUrl!).toString(),
              token: capability.token,
            };
          });
        }
        output = (await this.#runtime.execute({
          authorization,
          capability_token: issued.token,
          ...(artifactUploads?.length ? { artifact_uploads: artifactUploads } : {}),
          now: new Date(),
        })).output;
        effectCompleted = true;
      } else if (resolved.descriptor.handler.type === "projection") {
        this.#consumeInternalAuthorization(authorization, issued.token, now);
        const projected = this.#projectionOutput(resolved, running);
        output = projected.output;
        envelope = projected.envelope;
      } else {
        if (resolved.plugin.source !== "builtin") throw new Error("Only bundled plugins may use builtin Tool handlers");
        const handler = this.#builtins.resolve(resolved.descriptor.handler.id);
        if (!handler) throw new Error(`Builtin Tool handler is unavailable: ${resolved.descriptor.handler.id}`);
        this.#consumeInternalAuthorization(authorization, issued.token, now);
        // A trusted builtin may perform its declared effect before rejecting.
        // Mark ambiguity before dispatch so write/external/destructive handlers
        // can never become an ordinary retryable failure after partial work.
        effectCompleted = resolved.descriptor.effect !== "read";
        output = await handler({ authorization });
      }
      return this.#commitOutput(running, output, new Date(), envelope);
    } catch (cause) {
      const current = getPluginToolRequest(record.request_id);
      if (!claimed) {
        if (!current || current.status !== "authorized") {
          if (current) return current;
          throw cause;
        }
        const failed = transitionPluginToolRequest({
          request_id: current.request_id,
          expected_status: "authorized",
          status: "failed",
          error_code: failureCode(cause),
          error_message: failureMessage(cause),
        });
        appendPluginToolEvent({
          request_id: failed.request_id,
          request_digest: failed.request_digest,
          event_type: "failed",
          data: { error_code: failed.error_code ?? "tool_failed" },
        });
        return failed;
      }
      if (current?.status === "running") {
        const errorCode = (
          cause instanceof PluginRuntimeIndeterminateFailure
          || effectCompleted
        ) ? "runtime_indeterminate" : failureCode(cause);
        const failed = transitionPluginToolRequest({
          request_id: record.request_id,
          expected_status: "running",
          status: "failed",
          error_code: errorCode,
          error_message: failureMessage(cause),
        });
        appendPluginToolEvent({
          request_id: failed.request_id,
          request_digest: failed.request_digest,
          event_type: "failed",
          data: { error_code: failed.error_code ?? "tool_failed" },
        });
        return failed;
      }
      throw cause;
    }
  }

  async start(input: {
    invocation: HomerailPluginToolInvocationV1;
    policy: PluginPermissionPolicySnapshotV1;
  }): Promise<PluginActionBusResponse> {
    const existing = getPluginToolRequest(input.invocation.request_id);
    if (existing) {
      if (
        existing.idempotency_key !== input.invocation.idempotency_key
        || existing.request_digest !== input.invocation.request_digest
      ) throw new Error("Plugin Tool idempotency collision");
      const challenge = getPluginToolConfirmationForRequest(existing.request_id)?.challenge;
      if (existing.status === "awaiting_confirmation" && !challenge) {
        throw new Error("Plugin Tool awaiting-confirmation request is missing its atomic challenge");
      }
      appendPluginToolEvent({
        request_id: existing.request_id,
        request_digest: existing.request_digest,
        event_type: "duplicate",
        data: { status: existing.status },
      });
      return response(existing, { idempotent: true, ...(challenge ? { challenge } : {}) });
    }
    if (input.invocation.source.type === "ui_action") {
      const unresolved = getUnresolvedPluginToolTarget(input.invocation.source.target);
      if (unresolved) {
        throw new Error(`Plugin Action target is blocked by an unresolved Tool execution and requires reconciliation before retry: ${unresolved.request_id}`);
      }
    }
    const initialStatus = input.policy.runnable
      ? (input.policy.confirmation_required ? "awaiting_confirmation" : "authorized")
      : "needs_grant";
    const confirmationChallenge = initialStatus === "awaiting_confirmation"
      ? (() => {
        const issuedAt = new Date(input.invocation.invoked_at);
        const expiresAt = new Date(Math.min(
          issuedAt.getTime() + CONFIRMATION_TTL_MS,
          Date.parse(input.invocation.deadline_at),
        ));
        const sourceLabel = input.invocation.source.type === "ui_action"
          ? ` for Action ${input.invocation.source.action.local_id} on node ${input.invocation.source.target.node_id}`
          : ` for Agent call ${input.invocation.source.call_id}`;
        return {
          confirmation_version: 1 as const,
          challenge_id: identifier("confirm"),
          request_id: input.invocation.request_id,
          request_digest: input.invocation.request_digest,
          effect: input.invocation.policy.effect,
          permissions: [...input.invocation.policy.permissions],
          effective_grants: structuredClone(input.invocation.policy.effective_grants),
          message: `Allow ${input.invocation.binding.plugin_id}@${input.invocation.binding.plugin_version} `
            + `to perform ${input.invocation.policy.effect} Tool ${input.invocation.tool.local_id}${sourceLabel}?`,
          issued_at: issuedAt.toISOString(),
          expires_at: expiresAt.toISOString(),
        };
      })()
      : undefined;
    const created = createPluginToolRequest({
      invocation: input.invocation,
      policy_digest: input.policy.policy_digest,
      status: initialStatus,
      ...(confirmationChallenge ? { confirmation_challenge: confirmationChallenge } : {}),
    });
    let record = created.record;
    if (input.policy.denied_permissions.length) {
      record = transitionPluginToolRequest({
        request_id: record.request_id,
        expected_status: "needs_grant",
        status: "denied",
        error_code: "permission_denied",
        error_message: "One or more required plugin permissions were denied",
      });
      appendPluginToolEvent({
        request_id: record.request_id,
        request_digest: record.request_digest,
        event_type: "denied",
        data: { permissions: input.policy.denied_permissions },
      });
      return response(record, { idempotent: false, policy: input.policy });
    }
    if (record.status === "needs_grant") return response(record, { idempotent: false, policy: input.policy });
    if (record.status === "awaiting_confirmation") {
      const challenge = getPluginToolConfirmationForRequest(record.request_id)?.challenge;
      if (!challenge) throw new Error("Plugin Tool confirmation was not created atomically with its request");
      return response(record, { idempotent: false, policy: input.policy, challenge });
    }
    record = await this.#execute(record);
    return response(record, { idempotent: false, policy: input.policy });
  }

  async reconcile(requestId: string): Promise<PluginActionBusResponse> {
    const record = getPluginToolRequest(requestId);
    if (!record) throw new Error("Plugin Tool request does not exist");
    if (record.status !== "running" && !(record.status === "failed" && record.error_code === "runtime_indeterminate")) {
      throw new Error("Plugin Tool request is not eligible for reconciliation");
    }
    this.#resolveLive(record);
    const reconciliation = await this.#runtime.reconcile({
      request_id: record.request_id,
      request_digest: record.request_digest,
    });
    if (reconciliation.status === "running") {
      return {
        ...response(record, { idempotent: true }),
        result: { reconciliation: "running" },
      };
    }
    if (reconciliation.status === "completed") {
      if (!reconciliation.output) throw new Error("Completed Runtime reconciliation is missing output");
      const committed = this.#commitOutput(
        record,
        reconciliation.output,
        new Date(),
        undefined,
        record.status,
      );
      if (committed.invocation.source.type === "agent") enqueuePluginAgentToolContinuation(committed);
      return response(committed, { idempotent: true });
    }
    if (reconciliation.status !== "absent" && reconciliation.status !== "failed") {
      throw new Error("Plugin Runtime returned an unsupported reconciliation status");
    }
    const resolution = reconciliation.status;
    const resolved = getDb().transaction(() => {
      this.#resolveLive(record);
      const terminal = resolvePluginToolRuntimeAmbiguity({
        request_id: record.request_id,
        request_digest: record.request_digest,
        resolution,
        ...(reconciliation.error ? { error: reconciliation.error } : {}),
      });
      appendPluginToolEvent({
        request_id: terminal.request_id,
        request_digest: terminal.request_digest,
        event_type: "failed",
        data: { reconciliation: reconciliation.status },
      });
      return terminal;
    }).immediate();
    if (resolved.invocation.source.type === "agent") enqueuePluginAgentToolContinuation(resolved);
    return response(resolved, { idempotent: true });
  }

  replayAction(input: PluginActionInteractionInput): PluginActionBusResponse | undefined {
    const record = getPluginToolRequest(input.request_id);
    if (!record) return undefined;
    const source = record.invocation.source;
    const inputDigest = pluginJsonDigest(input.input ?? {});
    if (
      source.type !== "ui_action"
      || record.idempotency_key !== input.idempotency_key
      || source.target.document_id !== input.document_id
      || source.target.document_revision !== input.document_revision
      || source.target.node_id !== input.node_id
      || source.target.node_revision !== input.node_revision
      || source.target.action_id !== input.action_id
      || source.input_digest !== inputDigest
      || (input.request_digest !== undefined && input.request_digest !== record.request_digest)
    ) throw new Error("Plugin Action idempotency collision");
    const challenge = getPluginToolConfirmationForRequest(record.request_id)?.challenge;
    appendPluginToolEvent({
      request_id: record.request_id,
      request_digest: record.request_digest,
      event_type: "duplicate",
      data: { status: record.status },
    });
    return response(record, { idempotent: true, ...(challenge ? { challenge } : {}) });
  }

  async invokeAgent(value: unknown): Promise<PluginActionBusResponse> {
    const input = normalizePluginAgentToolInvocation(value);
    const turn = this.#turns.verify({ token: input.turn_token });
    const { context } = turn;
    const { modality, scope, generative_ui_mode: tokenMode, document_purpose: documentPurpose } = turn.claims;
    const currentMode = this.#resolveMode(scope);
    if (currentMode !== tokenMode || tokenMode !== "prefer" || documentPurpose !== "canonical") {
      throw new Error("Plugin Tool turn document authority is stale or non-authoritative");
    }
    const existing = getPluginToolRequest(input.request_id);
    if (existing) {
      const source = existing.invocation.source;
      if (
        source.type !== "agent"
        || existing.idempotency_key !== input.idempotency_key
        || source.call_id !== input.call_id
        || source.modality !== modality
        || source.scope.type !== scope.type
        || source.scope.id !== scope.id
        || existing.invocation.binding.context_digest !== context.context_digest
        || existing.invocation.tool.wire_id !== input.tool_wire_id
        || !isDeepStrictEqual(existing.invocation.arguments, input.arguments)
        || (input.request_digest !== undefined && existing.request_digest !== input.request_digest)
      ) throw new Error("Plugin Tool idempotency collision");
      const challenge = getPluginToolConfirmationForRequest(existing.request_id)?.challenge;
      appendPluginToolEvent({
        request_id: existing.request_id,
        request_digest: existing.request_digest,
        event_type: "duplicate",
        data: { status: existing.status },
      });
      return response(existing, { idempotent: true, ...(challenge ? { challenge } : {}) });
    }
    const descriptor = context.tools.find((tool) => tool.wire_id === input.tool_wire_id);
    if (!descriptor) throw new Error("Plugin Tool is not present in the exact selected Agent context");
    const plugin = getActivePlugin(descriptor.plugin_id);
    if (!plugin || !plugin.activation.enabled || plugin.plugin_version !== descriptor.plugin_version) {
      throw new Error("Plugin Tool owner is disabled or stale");
    }
    const manifestTool = plugin.descriptor.manifest.tools.find((tool) => tool.id === descriptor.local_id);
    if (!manifestTool || !manifestTool.exposure.includes("agent")) throw new Error("Plugin Tool is not Agent-callable");
    const exactDescriptor = toolDescriptor(plugin, manifestTool, descriptor.capability_ids);
    if (!isDeepStrictEqual(exactDescriptor, descriptor)) throw new Error("Plugin Tool descriptor is not the exact active package descriptor");
    const inputValidation = validateHomerailPluginToolInput(exactDescriptor.input_schema, input.arguments);
    if (!inputValidation.valid || !inputValidation.value || !isDeepStrictEqual(inputValidation.value, input.arguments)) {
      throw new Error(`Plugin Tool input is invalid: ${JSON.stringify(inputValidation.errors)}`);
    }
    const purpose: GenerativeUiDocumentPurpose = documentPurpose;
    const document = this.#documents.findActiveForScope(scope, purpose)
      ?? this.#documents.createOrGet({
        documentId: voiceCanonicalDocumentId(scope.id),
        scope,
        purpose,
        createdAt: turn.claims.issued_at,
      });
    const policy = policyFor(plugin, descriptor);
    const invocation = buildInvocation({
      request_id: input.request_id,
      idempotency_key: input.idempotency_key,
      source: {
        type: "agent",
        call_id: input.call_id,
        modality,
        scope,
        target: { document_id: document.document_id, base_revision: document.revision },
      },
      plugin,
      descriptor,
      context,
      policy,
      arguments: input.arguments,
    });
    if (input.request_digest !== undefined && input.request_digest !== invocation.request_digest) {
      throw new Error("Plugin Tool request digest does not match the Manager-resolved invocation");
    }
    return this.start({ invocation, policy });
  }

  async confirm(requestId: string, value: unknown): Promise<PluginActionBusResponse> {
    const input = normalizeConfirmation(requestId, value);
    const record = getPluginToolRequest(input.request_id);
    if (!record) throw new Error("Plugin Tool request does not exist");
    const challenge = getPluginToolConfirmationForRequest(record.request_id);
    if (!challenge || challenge.challenge.challenge_id !== input.challenge_id) {
      throw new Error("Plugin Tool confirmation challenge does not match the request");
    }
    const continueAgent = (current: PluginToolRequestRecord): PluginToolRequestRecord => {
      if (
        current.invocation.source.type === "agent"
        && ["committed", "denied", "failed", "cancelled"].includes(current.status)
      ) enqueuePluginAgentToolContinuation(current);
      return current;
    };
    const replayPersistedDecision = async (
      current: PluginToolRequestRecord,
      persisted: NonNullable<ReturnType<typeof getPluginToolConfirmationForRequest>>,
    ): Promise<PluginActionBusResponse> => {
      if (!persisted.decision) throw new Error("Plugin Tool confirmation decision is not persisted");
      if (
        persisted.decision.decision !== input.decision
        || persisted.decision.actor.id !== input.actor_id
        || persisted.decision.request_id !== current.request_id
        || persisted.decision.request_digest !== current.request_digest
      ) throw new Error("Plugin Tool confirmation idempotency collision");
      if (current.status === "authorized") {
        return response(continueAgent(await this.#execute(current)), {
          idempotent: true,
          challenge: persisted.challenge,
        });
      }
      return response(continueAgent(current), { idempotent: true, challenge: persisted.challenge });
    };
    if (challenge.decision) return replayPersistedDecision(record, challenge);
    if (record.status !== "awaiting_confirmation" || challenge.status !== "pending") {
      throw new Error("Plugin Tool confirmation is no longer pending");
    }
    const decision: HomerailPluginToolConfirmationDecisionV1 = {
      confirmation_version: 1,
      challenge_id: input.challenge_id,
      request_id: record.request_id,
      request_digest: record.request_digest,
      decision: input.decision,
      actor: { type: "user", id: input.actor_id },
      decided_at: new Date().toISOString(),
    };
    try {
      decidePluginToolConfirmation({ decision });
    } catch (cause) {
      const concurrentRecord = getPluginToolRequest(record.request_id);
      const concurrentChallenge = getPluginToolConfirmationForRequest(record.request_id);
      if (concurrentRecord && concurrentChallenge?.decision) {
        return replayPersistedDecision(concurrentRecord, concurrentChallenge);
      }
      throw cause;
    }
    const decided = getPluginToolRequest(record.request_id)!;
    if (decided.status === "denied" || decided.status === "failed") {
      return response(continueAgent(decided), { idempotent: false });
    }
    return response(continueAgent(await this.#execute(decided)), { idempotent: false });
  }

  status(requestId: string): PluginActionBusResponse {
    if (!WIRE_ID.test(requestId)) throw new Error("request_id is invalid");
    const record = getPluginToolRequest(requestId);
    if (!record) throw new Error("Plugin Tool request does not exist");
    const challenge = getPluginToolConfirmationForRequest(record.request_id)?.challenge;
    return response(record, { idempotent: true, ...(challenge ? { challenge } : {}) });
  }

  pendingConfirmations(scope: GenerativeUiDocumentScopeV1): PluginActionBusResponse[] {
    return listPendingPluginToolConfirmationsForScope({
      scope_type: scope.type,
      scope_id: scope.id,
    }).map(({ request, confirmation }) => response(request, {
      idempotent: true,
      challenge: confirmation.challenge,
    }));
  }
}

export class PluginActionBus {
  readonly #documents: PersistentGenerativeUiDocumentService;
  readonly #tools: PluginToolInvocationService;
  readonly #resolveMode: (scope: GenerativeUiDocumentScopeV1) => GenerativeUiMode;

  constructor(input: {
    documents?: PersistentGenerativeUiDocumentService;
    tokens: PluginToolCapabilityTokenAuthority;
    runtime: PluginRuntimeBroker;
    builtins?: PluginBuiltinToolRegistry;
    tools?: PluginToolInvocationService;
    turns?: PluginToolTurnTokenAuthority;
    resolve_mode?: (scope: GenerativeUiDocumentScopeV1) => GenerativeUiMode;
  }) {
    this.#documents = input.documents ?? persistentGenerativeUiDocumentService;
    this.#resolveMode = input.resolve_mode ?? ((scope) => (
      scope.type === "voice_session" ? resolveVoiceSessionGenerativeUiMode(scope.id) : "off"
    ));
    this.#tools = input.tools ?? new PluginToolInvocationService({
      documents: this.#documents,
      tokens: input.tokens,
      runtime: input.runtime,
      builtins: input.builtins,
      turns: input.turns,
      resolve_mode: this.#resolveMode,
    });
  }

  #resolve(input: PluginActionInteractionInput, now: Date): ResolvedAction {
    ensureBuiltinPluginsSynced();
    if (input.scope.type !== "voice_session" || this.#resolveMode(input.scope) !== "prefer") {
      throw new Error("Generative UI mode does not authorize Plugin Action execution");
    }
    const document = this.#documents.get(input.document_id, input.scope);
    if (!document) throw new Error(`Generative UI document not found: ${input.document_id}`);
    if (this.#documents.findActiveForScope(input.scope, "canonical")?.document_id !== document.document_id) {
      throw new Error("Generative UI canonical document authority is stale");
    }
    if (document.revision !== input.document_revision) throw new Error("Plugin Action document revision is stale");
    const node = currentNode(document, input.node_id);
    if (node.revision !== input.node_revision) throw new Error("Plugin Action node revision is stale");
    const nodeAction = node.actions?.find((action) => action.id === input.action_id);
    if (!nodeAction) throw new Error(`Plugin Action is not present on the current node: ${input.action_id}`);
    const plugin = getActivePlugin(node.owner.id);
    if (!plugin || !plugin.activation.enabled || plugin.plugin_version !== node.owner.version) {
      throw new Error(`Plugin Action owner is disabled or stale: ${node.owner.id}@${node.owner.version}`);
    }
    const manifestAction = plugin.descriptor.manifest.actions.find((action) => action.id === nodeAction.id);
    if (!manifestAction || manifestAction.intent !== nodeAction.intent) {
      throw new Error("Plugin Action symbolic identity does not match the active manifest");
    }
    const manifestTool = plugin.descriptor.manifest.tools.find((tool) => tool.id === manifestAction.tool);
    if (!manifestTool || !manifestTool.exposure.includes("action")) {
      throw new Error("Plugin Action does not delegate to an Action-exposed Tool");
    }
    const kind = plugin.descriptor.manifest.kinds.find((candidate) => candidate.kind === node.kind);
    const kindVersion = kind?.versions.find((candidate) => candidate.version === node.kind_version);
    if (!kindVersion?.actions.includes(manifestAction.id)) throw new Error("Plugin Action is not declared by the current Kind version");
    const userInput = normalizedObject(input.input, "Action input");
    const descriptor = toolDescriptor(plugin, manifestTool, []);
    const effective = effectiveActionInput(nodeAction, userInput);
    const inputValidation = validateHomerailPluginToolInput(descriptor.input_schema, effective);
    if (!inputValidation.valid || !inputValidation.value) {
      throw new Error(`Plugin Action Tool input is invalid: ${JSON.stringify(inputValidation.errors)}`);
    }
    const policy = policyFor(plugin, descriptor);
    const state = getPluginRegistryState();
    const fullContext = assemblePluginTurnContext(state);
    const contextAction = fullContext.actions.find((action) => (
      action.plugin_id === plugin.plugin_id
      && action.plugin_version === plugin.plugin_version
      && action.local_id === manifestAction.id
      && action.intent === manifestAction.intent
    ));
    if (!contextAction) throw new Error("Plugin Action is not reachable from an enabled capability");
    const context = selectPluginTurnContext(fullContext, contextAction.capability_ids, policy.permission_revision);
    const invocation = buildInvocation({
      request_id: input.request_id,
      idempotency_key: input.idempotency_key,
      source: {
        type: "ui_action",
        target: {
          document_id: document.document_id,
          document_revision: document.revision,
          node_id: node.id,
          node_revision: node.revision,
          action_id: manifestAction.id,
          action_intent: manifestAction.intent,
        },
        action: { local_id: manifestAction.id, qualified_id: `${plugin.plugin_id}:${manifestAction.id}` },
        input_digest: pluginJsonDigest(userInput),
      },
      plugin,
      descriptor,
      context,
      policy,
      arguments: inputValidation.value,
      invoked_at: now.toISOString(),
    });
    if (input.request_digest !== undefined && input.request_digest !== invocation.request_digest) {
      throw new Error("Plugin Action request digest does not match the Manager-resolved Tool invocation");
    }
    return {
      plugin,
      manifest_tool: manifestTool,
      descriptor,
      policy,
      scope: input.scope,
      node,
      node_action: nodeAction,
      manifest_action: manifestAction,
      invocation,
    };
  }

  async invoke(value: unknown): Promise<PluginActionBusResponse> {
    const input = normalizePluginActionInteraction(value);
    const replay = this.#tools.replayAction(input);
    if (replay) return replay;
    const resolved = this.#resolve(input, new Date());
    return this.#tools.start({ invocation: resolved.invocation, policy: resolved.policy });
  }

  confirm(requestId: string, value: unknown): Promise<PluginActionBusResponse> {
    return this.#tools.confirm(requestId, value);
  }
}

export const pluginRuntimeTransports = new PluginRuntimeTransportRegistry();
export const pluginBuiltinTools = new PluginBuiltinToolRegistry();
let defaultToolService: PluginToolInvocationService | undefined;
let defaultActionBus: PluginActionBus | undefined;
let defaultTurnAuthority: PluginToolTurnTokenAuthority | undefined;

export function getPluginToolTurnAuthority(): PluginToolTurnTokenAuthority {
  if (!defaultTurnAuthority) {
    defaultTurnAuthority = new PluginToolTurnTokenAuthority(loadPluginCapabilitySecret());
  }
  return defaultTurnAuthority;
}

export function getPluginToolInvocationService(): PluginToolInvocationService {
  if (!defaultToolService) {
    const tokens = new PluginToolCapabilityTokenAuthority(loadPluginCapabilitySecret());
    defaultToolService = new PluginToolInvocationService({
      tokens,
      runtime: new PluginRuntimeBroker({
        tokens,
        transports: pluginRuntimeTransports,
        sandbox: getPluginRuntimeSandboxGate(),
        ensure_transport: (input) => ensurePluginRuntimeTransport({
          ...input,
          transports: pluginRuntimeTransports,
        }),
      }),
      builtins: pluginBuiltinTools,
      turns: getPluginToolTurnAuthority(),
    });
  }
  return defaultToolService;
}

export function getPluginActionBus(): PluginActionBus {
  if (!defaultActionBus) {
    const tokens = new PluginToolCapabilityTokenAuthority(loadPluginCapabilitySecret());
    defaultActionBus = new PluginActionBus({
      tokens,
      runtime: new PluginRuntimeBroker({
        tokens,
        transports: pluginRuntimeTransports,
        sandbox: getPluginRuntimeSandboxGate(),
        ensure_transport: (input) => ensurePluginRuntimeTransport({
          ...input,
          transports: pluginRuntimeTransports,
        }),
      }),
      builtins: pluginBuiltinTools,
      tools: getPluginToolInvocationService(),
    });
  }
  return defaultActionBus;
}

export function _resetPluginActionBusForTest(): void {
  defaultActionBus = undefined;
  defaultToolService = undefined;
  defaultTurnAuthority = undefined;
}
