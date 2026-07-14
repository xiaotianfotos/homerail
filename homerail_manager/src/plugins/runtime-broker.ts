import { createHash, createPublicKey, KeyObject, randomBytes, verify } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  HomerailPluginRuntimeTrust,
  HomerailPluginPermission,
  homerailPluginRuntimeSandboxAttestationSigningInput,
  stableStringify,
  validateHomerailPluginRuntimeSandboxAttestation,
  validateHomerailPluginAuthorizedToolInvocation,
  validateHomerailPluginRuntimeRpcRequest,
  validateHomerailPluginRuntimeRpcResponse,
  type HomerailPluginToolBindingV1,
  type HomerailPluginAuthorizedToolInvocationV1,
  type HomerailPluginRuntimeRpcCancelResultV1,
  type HomerailPluginRuntimeRpcExecuteResultV1,
  type HomerailPluginRuntimeRpcHealthResultV1,
  type HomerailPluginRuntimeRpcPrepareResultV1,
  type HomerailPluginRuntimeRpcReconcileResultV1,
  type HomerailPluginRuntimeRpcRequestV1,
  type HomerailPluginRuntimeRpcResponseV1,
  type HomerailPluginRuntimeTrust as HomerailPluginRuntimeTrustValue,
  type HomerailPluginRuntimeSandboxAttestationV1,
  type HomerailPluginRuntimeArtifactUploadV1,
  type HomerailPluginToolPolicyV1,
} from "homerail-protocol";
import {
  consumePluginToolConfirmation,
  getPluginToolConfirmation,
  getPluginToolRequest,
} from "../persistence/plugin-actions.js";
import { getActivePlugin, getPluginRegistryState, type PluginPackageSource } from "../persistence/plugins.js";
import { PluginToolCapabilityTokenAuthority } from "./capability-token.js";
import { ensureBuiltinPluginsSynced } from "./registry.js";

const DEFAULT_RUNTIME_TIMEOUT_MS = 30_000;

export interface PluginRuntimeTransport {
  request(request: HomerailPluginRuntimeRpcRequestV1, signal: AbortSignal): Promise<unknown>;
}

export interface ResolvedPluginRuntimeV1 {
  plugin_id: string;
  plugin_version: string;
  package_digest: string;
  manifest_digest: string;
  registry_revision: number;
  source: PluginPackageSource;
  trust: HomerailPluginRuntimeTrustValue;
  entrypoint?: { file: string; args: string[] };
  image_digest?: string;
}

export interface PluginRuntimeSandboxGateInput {
  runtime: ResolvedPluginRuntimeV1;
  binding: HomerailPluginToolBindingV1;
  policy?: HomerailPluginToolPolicyV1;
  attestation?: HomerailPluginRuntimeSandboxAttestationV1;
  transport_identity?: PluginRuntimeTransportIdentityV1;
  now: Date;
}

export interface PluginRuntimeTransportIdentityV1 {
  node_id: string;
  runtime_instance_id: string;
  container_id: string;
  measurement_digest: string;
  image_digest: string;
}

export interface PluginRuntimeSandboxGate {
  assertAllowed(input: PluginRuntimeSandboxGateInput): void;
}

export class DenyUnverifiedPluginRuntimeSandboxGate implements PluginRuntimeSandboxGate {
  assertAllowed(input: PluginRuntimeSandboxGateInput): void {
    throw new Error(
      `Plugin runtime lacks a verified M6 sandbox capability: ${input.runtime.plugin_id}@${input.runtime.plugin_version}`,
    );
  }
}

export class VerifiedPluginRuntimeSandboxGate implements PluginRuntimeSandboxGate {
  readonly #trustedNodes = new Map<string, { node_id: string; public_key: KeyObject }>();
  readonly #profiles?: ReadonlySet<string>;

  constructor(input: {
    trusted_nodes: Array<{ key_id: string; node_id: string; public_key: KeyObject | string | Buffer }>;
    allowed_profile_ids?: ReadonlySet<string>;
  }) {
    for (const node of input.trusted_nodes) {
      if (this.#trustedNodes.has(node.key_id)) throw new Error(`Duplicate Runtime attestation key id: ${node.key_id}`);
      const publicKey = node.public_key instanceof KeyObject
        ? node.public_key
        : Buffer.isBuffer(node.public_key)
          ? createPublicKey({ key: node.public_key, format: "der", type: "spki" })
          : createPublicKey(node.public_key);
      if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("Runtime attestation keys must use Ed25519");
      this.#trustedNodes.set(node.key_id, { node_id: node.node_id, public_key: publicKey });
    }
    if (!this.#trustedNodes.size) throw new Error("At least one trusted Runtime attestation node is required");
    this.#profiles = input.allowed_profile_ids;
  }

  assertAllowed(input: PluginRuntimeSandboxGateInput): void {
    const validation = validateHomerailPluginRuntimeSandboxAttestation(input.attestation, {
      now_ms: input.now.getTime(),
    });
    if (!validation.valid || !validation.value) {
      throw new Error(`Plugin Runtime sandbox attestation is invalid: ${JSON.stringify(validation.errors)}`);
    }
    const attestation = validation.value;
    const trusted = this.#trustedNodes.get(attestation.claims.key_id);
    if (!trusted || trusted.node_id !== attestation.claims.node_id) {
      throw new Error("Plugin Runtime sandbox attestation issuer is not trusted");
    }
    if (!verify(
      null,
      Buffer.from(homerailPluginRuntimeSandboxAttestationSigningInput(attestation.claims), "utf8"),
      trusted.public_key,
      Buffer.from(attestation.signature, "base64url"),
    )) throw new Error("Plugin Runtime sandbox attestation signature is invalid");
    if (this.#profiles && !this.#profiles.has(attestation.claims.isolation.profile_id)) {
      throw new Error("Plugin Runtime sandbox profile is not approved");
    }
    const claims = attestation.claims;
    if (!input.transport_identity
      || input.transport_identity.node_id !== claims.node_id
      || input.transport_identity.runtime_instance_id !== claims.runtime_instance_id
      || input.transport_identity.container_id !== claims.container_id
      || input.transport_identity.measurement_digest !== claims.measurement_digest
      || input.transport_identity.image_digest !== claims.image_digest) {
      throw new Error("Plugin Runtime transport is not bound to the attested runtime instance");
    }
    if (!isDeepStrictEqual(claims.binding, input.binding)) {
      throw new Error("Plugin Runtime sandbox attestation does not match the exact Tool binding");
    }
    if (
      claims.binding.plugin_id !== input.runtime.plugin_id
      || claims.binding.plugin_version !== input.runtime.plugin_version
      || claims.binding.package_digest !== input.runtime.package_digest
      || claims.binding.manifest_digest !== input.runtime.manifest_digest
      || claims.binding.registry_revision !== input.runtime.registry_revision
    ) throw new Error("Plugin Runtime sandbox attestation does not match the resolved package");
    if (!input.runtime.entrypoint || !isDeepStrictEqual(claims.entrypoint, input.runtime.entrypoint)) {
      throw new Error("Plugin Runtime sandbox attestation does not match the immutable entrypoint/argv");
    }
    if (input.runtime.image_digest && claims.image_digest !== input.runtime.image_digest) {
      throw new Error("Plugin Runtime sandbox attestation does not match the pinned image digest");
    }
    if (input.policy && !isDeepStrictEqual(claims.effective_grants, input.policy.effective_grants)) {
      throw new Error("Plugin Runtime sandbox attestation does not match effective grants");
    }
    assertIsolationDoesNotWiden(input.policy?.effective_grants ?? claims.effective_grants, claims.isolation);
  }
}

function assertIsolationDoesNotWiden(
  grants: HomerailPluginToolPolicyV1["effective_grants"],
  isolation: HomerailPluginRuntimeSandboxAttestationV1["claims"]["isolation"],
): void {
  const permissions = new Set(grants.map((grant) => grant.permission));
  const networkGrant = grants.find((grant) => grant.permission === HomerailPluginPermission.NETWORK_CONNECT);
  const networkHosts = [...new Set(networkGrant?.hosts ?? [])].sort();
  if (!networkGrant) {
    if (isolation.network.mode !== "none" || isolation.network.hosts.length) {
      throw new Error("Plugin Runtime sandbox network exceeds effective grants");
    }
  } else if (
    isolation.network.mode !== "brokered"
    || !isDeepStrictEqual(isolation.network.hosts, networkHosts)
  ) throw new Error("Plugin Runtime sandbox network does not match effective host grants");
  if (!permissions.has(HomerailPluginPermission.GPU_USE)
    && (isolation.gpu.enabled || isolation.gpu.devices.length)) {
    throw new Error("Plugin Runtime sandbox GPU access exceeds effective grants");
  }
  const devicePermissions = [
    HomerailPluginPermission.DEVICE_CONTROL,
    HomerailPluginPermission.CAMERA_READ,
    HomerailPluginPermission.MICROPHONE_READ,
  ];
  if (!devicePermissions.some((permission) => permissions.has(permission)) && isolation.devices.length) {
    throw new Error("Plugin Runtime sandbox device access exceeds effective grants");
  }
  const writePermissions = [
    HomerailPluginPermission.WORKSPACE_WRITE,
    HomerailPluginPermission.ARTIFACT_WRITE,
    HomerailPluginPermission.PLUGIN_DATA_WRITE,
  ];
  if (!writePermissions.some((permission) => permissions.has(permission))
    && isolation.mounts.some((mount) => mount.mode === "rw")) {
    throw new Error("Plugin Runtime writable mounts exceed effective grants");
  }
}

interface PluginRuntimeTransportRegistration {
  transport: PluginRuntimeTransport;
  sandbox_attestation?: HomerailPluginRuntimeSandboxAttestationV1;
  sandbox_identity?: PluginRuntimeTransportIdentityV1;
  refresh_sandbox?: () => Promise<{
    sandbox_attestation: HomerailPluginRuntimeSandboxAttestationV1;
    sandbox_identity: PluginRuntimeTransportIdentityV1;
  }>;
}

export interface PluginRuntimeTransportRegistrationOptions {
  sandbox_attestation?: HomerailPluginRuntimeSandboxAttestationV1;
  sandbox_identity?: PluginRuntimeTransportIdentityV1;
  refresh_sandbox?: PluginRuntimeTransportRegistration["refresh_sandbox"];
}

function runtimeTransportKey(
  binding: HomerailPluginToolBindingV1,
  effectiveGrants: HomerailPluginToolPolicyV1["effective_grants"],
): string {
  return `${binding.plugin_id}\0${binding.plugin_version}\0${stableStringify({
    binding,
    effective_grants: effectiveGrants,
  })}`;
}

function legacyRuntimeTransportKey(pluginId: string, pluginVersion: string): string {
  return `${pluginId}\0${pluginVersion}\0*`;
}

export class PluginRuntimeTransportRegistry {
  readonly #transports = new Map<string, PluginRuntimeTransportRegistration>();

  register(
    pluginId: string,
    pluginVersion: string,
    transport: PluginRuntimeTransport,
    options: PluginRuntimeTransportRegistrationOptions = {},
  ): void {
    const attestedBinding = options.sandbox_attestation?.claims.binding;
    if (attestedBinding && (attestedBinding.plugin_id !== pluginId || attestedBinding.plugin_version !== pluginVersion)) {
      throw new Error("Plugin runtime transport registration identity differs from its attested binding");
    }
    const key = attestedBinding
      ? runtimeTransportKey(attestedBinding, options.sandbox_attestation!.claims.effective_grants)
      : legacyRuntimeTransportKey(pluginId, pluginVersion);
    if (this.#transports.has(key)) throw new Error(`Plugin runtime transport is already registered for the exact binding: ${pluginId}@${pluginVersion}`);
    this.#transports.set(key, {
      transport,
      ...(options.sandbox_attestation ? { sandbox_attestation: structuredClone(options.sandbox_attestation) } : {}),
      ...(options.sandbox_identity ? { sandbox_identity: structuredClone(options.sandbox_identity) } : {}),
      ...(options.refresh_sandbox ? { refresh_sandbox: options.refresh_sandbox } : {}),
    });
  }

  resolve(pluginId: string, pluginVersion: string): PluginRuntimeTransport | undefined {
    return this.#transports.get(legacyRuntimeTransportKey(pluginId, pluginVersion))?.transport;
  }

  resolveRegistration(
    binding: HomerailPluginToolBindingV1,
    policy?: HomerailPluginToolPolicyV1,
  ): PluginRuntimeTransportRegistration | undefined {
    let registration = policy
      ? this.#transports.get(runtimeTransportKey(binding, policy.effective_grants))
      : undefined;
    if (!registration && !policy) {
      const matches = [...this.#transports.values()].filter((candidate) => (
        candidate.sandbox_attestation
        && isDeepStrictEqual(candidate.sandbox_attestation.claims.binding, binding)
      ));
      if (matches.length > 1) {
        throw new Error(`Plugin runtime transport is ambiguous without exact policy grants: ${binding.plugin_id}@${binding.plugin_version}`);
      }
      registration = matches[0];
    }
    registration ??= this.#transports.get(legacyRuntimeTransportKey(binding.plugin_id, binding.plugin_version));
    return registration ? {
      transport: registration.transport,
      ...structuredClone({
        sandbox_attestation: registration.sandbox_attestation,
        sandbox_identity: registration.sandbox_identity,
      }),
      ...(registration.refresh_sandbox ? { refresh_sandbox: registration.refresh_sandbox } : {}),
    } : undefined;
  }

  updateSandbox(
    binding: HomerailPluginToolBindingV1,
    value: {
      sandbox_attestation: HomerailPluginRuntimeSandboxAttestationV1;
      sandbox_identity: PluginRuntimeTransportIdentityV1;
    },
  ): void {
    if (!isDeepStrictEqual(value.sandbox_attestation.claims.binding, binding)) {
      throw new Error("Plugin runtime sandbox refresh changed the exact binding");
    }
    const registration = this.#transports.get(runtimeTransportKey(
      binding,
      value.sandbox_attestation.claims.effective_grants,
    ));
    if (!registration) throw new Error(`Plugin runtime transport is unavailable for exact binding: ${binding.plugin_id}@${binding.plugin_version}`);
    registration.sandbox_attestation = structuredClone(value.sandbox_attestation);
    registration.sandbox_identity = structuredClone(value.sandbox_identity);
  }

  unregister(binding: HomerailPluginToolBindingV1, policy?: HomerailPluginToolPolicyV1): boolean {
    if (policy) return this.#transports.delete(runtimeTransportKey(binding, policy.effective_grants));
    let removed = false;
    for (const [key, registration] of this.#transports) {
      if (registration.sandbox_attestation
        && isDeepStrictEqual(registration.sandbox_attestation.claims.binding, binding)) {
        this.#transports.delete(key);
        removed = true;
      }
    }
    return removed;
  }

  unregisterTransport(transport: PluginRuntimeTransport): number {
    let removed = 0;
    for (const [key, registration] of this.#transports) {
      if (registration.transport !== transport) continue;
      this.#transports.delete(key);
      removed += 1;
    }
    return removed;
  }

  clear(): void {
    this.#transports.clear();
  }
}

export class PluginRuntimeRpcFailure extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly response: HomerailPluginRuntimeRpcResponseV1;

  constructor(response: Extract<HomerailPluginRuntimeRpcResponseV1, { message_type: "error" }>) {
    super(response.error.message);
    this.name = "PluginRuntimeRpcFailure";
    this.code = response.error.code;
    this.retryable = response.error.retryable;
    this.response = structuredClone(response);
  }
}

/**
 * The Runtime transport was dispatched, but Manager cannot prove whether the
 * plugin completed an external side effect. Callers must not retry the same
 * semantic target until a later reconciliation flow resolves the ambiguity.
 */
export class PluginRuntimeIndeterminateFailure extends Error {
  readonly code = "runtime_indeterminate";
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "PluginRuntimeIndeterminateFailure";
    this.cause = cause;
  }
}

/**
 * Signals that the concrete Runtime container can no longer safely receive
 * requests. The Broker evicts only this exact transport so the next semantic
 * request must pass through the attested lazy-launch path again.
 */
export class PluginRuntimeTerminalTransportFailure extends Error {
  readonly code = "runtime_transport_terminal";
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "PluginRuntimeTerminalTransportFailure";
    this.cause = cause;
  }
}

function postDispatchFailure(
  request: HomerailPluginRuntimeRpcRequestV1,
  message: string,
  cause?: unknown,
): Error {
  if (request.method === "execute") {
    return new PluginRuntimeIndeterminateFailure(message, cause);
  }
  return new Error(message);
}

export type PluginRuntimeResolver = (binding: HomerailPluginToolBindingV1) => ResolvedPluginRuntimeV1;
export type PluginRuntimeTransportEnsurer = (input: {
  runtime: ResolvedPluginRuntimeV1;
  binding: HomerailPluginToolBindingV1;
  policy?: HomerailPluginToolPolicyV1;
}) => Promise<void>;

function defaultRuntimeResolver(binding: HomerailPluginToolBindingV1): ResolvedPluginRuntimeV1 {
  ensureBuiltinPluginsSynced();
  const registry = getPluginRegistryState();
  const plugin = getActivePlugin(binding.plugin_id);
  if (
    !plugin
    || !plugin.activation.enabled
    || plugin.plugin_version !== binding.plugin_version
    || plugin.package_digest !== binding.package_digest
    || plugin.descriptor.manifest_digest !== binding.manifest_digest
    || registry.revision !== binding.registry_revision
  ) throw new Error(`Plugin runtime binding is stale or disabled: ${binding.plugin_id}@${binding.plugin_version}`);
  return {
    plugin_id: plugin.plugin_id,
    plugin_version: plugin.plugin_version,
    package_digest: plugin.package_digest,
    manifest_digest: plugin.descriptor.manifest_digest,
    registry_revision: registry.revision,
    source: plugin.source,
    trust: plugin.descriptor.manifest.runtime.trust,
    ...(plugin.descriptor.manifest.runtime.entrypoint
      ? { entrypoint: structuredClone(plugin.descriptor.manifest.runtime.entrypoint) }
      : {}),
  };
}

function rpcId(): string {
  return `rpc_${randomBytes(16).toString("hex")}`;
}

function assertRuntimeTrust(input: PluginRuntimeSandboxGateInput, sandbox: PluginRuntimeSandboxGate): void {
  const { runtime } = input;
  if (runtime.trust === HomerailPluginRuntimeTrust.TRUSTED_BUILTIN) {
    if (runtime.source !== "builtin") throw new Error("Only bundled plugins may use trusted_builtin runtime");
    return;
  }
  if (runtime.trust === HomerailPluginRuntimeTrust.SANDBOXED_RUNTIME) {
    sandbox.assertAllowed(input);
    return;
  }
  throw new Error(`Data-only plugin cannot receive Runtime RPC: ${runtime.plugin_id}@${runtime.plugin_version}`);
}

async function boundedRequest(
  transport: PluginRuntimeTransport,
  request: HomerailPluginRuntimeRpcRequestV1,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort(new Error("Plugin Runtime RPC deadline exceeded"));
      reject(new Error("Plugin Runtime RPC deadline exceeded"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => transport.request(structuredClone(request), controller.signal)),
      deadline,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export class PluginRuntimeBroker {
  readonly #tokens: PluginToolCapabilityTokenAuthority;
  readonly #transports: PluginRuntimeTransportRegistry;
  readonly #sandbox: PluginRuntimeSandboxGate;
  readonly #resolveRuntime: PluginRuntimeResolver;
  readonly #timeoutMs: number;
  readonly #ensureTransport?: PluginRuntimeTransportEnsurer;

  constructor(input: {
    tokens: PluginToolCapabilityTokenAuthority;
    transports: PluginRuntimeTransportRegistry;
    sandbox?: PluginRuntimeSandboxGate;
    resolve_runtime?: PluginRuntimeResolver;
    timeout_ms?: number;
    ensure_transport?: PluginRuntimeTransportEnsurer;
  }) {
    this.#tokens = input.tokens;
    this.#transports = input.transports;
    this.#sandbox = input.sandbox ?? new DenyUnverifiedPluginRuntimeSandboxGate();
    this.#resolveRuntime = input.resolve_runtime ?? defaultRuntimeResolver;
    this.#timeoutMs = input.timeout_ms ?? DEFAULT_RUNTIME_TIMEOUT_MS;
    this.#ensureTransport = input.ensure_transport;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 5 * 60_000) {
      throw new Error("Plugin Runtime RPC timeout is invalid");
    }
  }

  async #transport(
    binding: HomerailPluginToolBindingV1,
    policy: HomerailPluginToolPolicyV1 | undefined,
    now: Date,
  ): Promise<PluginRuntimeTransport> {
    const runtime = this.#resolveRuntime(binding);
    let registration = this.#transports.resolveRegistration(binding, policy);
    if (!registration && this.#ensureTransport) {
      await this.#ensureTransport({ runtime, binding, policy });
      registration = this.#transports.resolveRegistration(binding, policy);
    }
    if (!registration) throw new Error(`Plugin Runtime RPC transport is unavailable: ${binding.plugin_id}@${binding.plugin_version}`);
    const assertRegistration = (): void => assertRuntimeTrust({
        runtime,
        binding,
        policy,
        attestation: registration?.sandbox_attestation,
        transport_identity: registration?.sandbox_identity,
        now,
      }, this.#sandbox);
    const expiresAt = registration.sandbox_attestation
      ? Date.parse(registration.sandbox_attestation.claims.expires_at)
      : Number.NaN;
    let refreshed = false;
    if (registration.refresh_sandbox && Number.isFinite(expiresAt) && expiresAt <= now.getTime() + 30_000) {
      const value = await registration.refresh_sandbox();
      this.#transports.updateSandbox(binding, value);
      registration = this.#transports.resolveRegistration(binding, policy)!;
      refreshed = true;
    }
    try {
      assertRegistration();
    } catch (cause) {
      if (!registration.refresh_sandbox || refreshed) throw cause;
      const value = await registration.refresh_sandbox();
      this.#transports.updateSandbox(binding, value);
      registration = this.#transports.resolveRegistration(binding, policy)!;
      assertRegistration();
    }
    return registration.transport;
  }

  async #request(
    request: HomerailPluginRuntimeRpcRequestV1,
    transport: PluginRuntimeTransport,
    timeoutMs: number,
    expected: Parameters<typeof validateHomerailPluginRuntimeRpcResponse>[1],
  ): Promise<HomerailPluginRuntimeRpcResponseV1> {
    const requestValidation = validateHomerailPluginRuntimeRpcRequest(request, expected);
    if (!requestValidation.valid || !requestValidation.value) {
      throw new Error(`Manager produced invalid Runtime RPC: ${JSON.stringify(requestValidation.errors)}`);
    }
    let raw: unknown;
    try {
      raw = await boundedRequest(transport, requestValidation.value, timeoutMs);
    } catch (cause) {
      if (cause instanceof PluginRuntimeTerminalTransportFailure) {
        this.#transports.unregisterTransport(transport);
      }
      throw postDispatchFailure(
        request,
        `Plugin Runtime RPC failed after dispatch: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      );
    }
    const response = validateHomerailPluginRuntimeRpcResponse(raw, expected);
    if (!response.valid || !response.value) {
      throw postDispatchFailure(
        request,
        `Plugin Runtime RPC returned an invalid envelope after dispatch: ${JSON.stringify(response.errors)}`,
      );
    }
    if (response.value.rpc_id !== request.rpc_id || response.value.method !== request.method) {
      throw postDispatchFailure(request, "Plugin Runtime RPC response correlation is invalid after dispatch");
    }
    if (response.value.message_type === "error") {
      const failure = new PluginRuntimeRpcFailure(response.value);
      throw postDispatchFailure(
        request,
        `Plugin Runtime reported an error after dispatch: ${failure.message}`,
        failure,
      );
    }
    return response.value;
  }

  async execute(input: {
    authorization: HomerailPluginAuthorizedToolInvocationV1;
    capability_token: string;
    artifact_uploads?: HomerailPluginRuntimeArtifactUploadV1[];
    now?: Date;
  }): Promise<HomerailPluginRuntimeRpcExecuteResultV1> {
    const now = input.now ?? new Date();
    const validation = validateHomerailPluginAuthorizedToolInvocation(input.authorization, { now_ms: now.getTime() });
    if (!validation.valid || !validation.value) {
      throw new Error(`Runtime authorization is invalid: ${JSON.stringify(validation.errors)}`);
    }
    const authorization = validation.value;
    const transport = await this.#transport(authorization.invocation.binding, authorization.invocation.policy, now);
    if (authorization.confirmation) {
      const stored = getPluginToolConfirmation(authorization.confirmation.challenge.challenge_id);
      if (
        !stored
        || stored.status !== "approved"
        || !isDeepStrictEqual(stored.challenge, authorization.confirmation.challenge)
        || !isDeepStrictEqual(stored.decision, authorization.confirmation.decision)
      ) throw new Error("Runtime authorization confirmation is not the exact persisted approval");
      consumePluginToolConfirmation(stored.challenge.challenge_id, now.toISOString());
    }
    const claims = this.#tokens.verifyAndConsume({
      token: input.capability_token,
      invocation: authorization.invocation,
      now,
    });
    if (!isDeepStrictEqual(claims, authorization.capability)) {
      throw new Error("Runtime capability token does not match the authorized claims");
    }
    const remaining = Date.parse(authorization.invocation.deadline_at) - now.getTime();
    if (remaining <= 0) throw new Error("Plugin Tool deadline exceeded before Runtime RPC");
    const request: HomerailPluginRuntimeRpcRequestV1 = {
      runtime_rpc_version: 1,
      message_type: "request",
      method: "execute",
      rpc_id: rpcId(),
      sent_at: now.toISOString(),
      params: {
        authorization,
        ...(input.artifact_uploads?.length ? { artifact_uploads: structuredClone(input.artifact_uploads) } : {}),
      },
    };
    const response = await this.#request(
      request,
      transport,
      Math.min(this.#timeoutMs, remaining),
      {
        now_ms: now.getTime(),
        expected: {
          source: authorization.invocation.source,
          tool: authorization.invocation.tool,
          binding: authorization.invocation.binding,
          policy: authorization.invocation.policy,
          request_id: authorization.invocation.request_id,
          request_digest: authorization.invocation.request_digest,
        },
      },
    );
    if (response.method !== "execute") throw new Error("Plugin Runtime RPC returned the wrong result method");
    return response as HomerailPluginRuntimeRpcExecuteResultV1;
  }

  /**
   * Pure phase used to obtain content digests before any single-use upload
   * authority is minted. Confirmation and Tool capability are consumed only
   * by execute.
   */
  async prepare(input: {
    authorization: HomerailPluginAuthorizedToolInvocationV1;
    now?: Date;
  }): Promise<HomerailPluginRuntimeRpcPrepareResultV1> {
    const now = input.now ?? new Date();
    const validation = validateHomerailPluginAuthorizedToolInvocation(input.authorization, { now_ms: now.getTime() });
    if (!validation.valid || !validation.value) {
      throw new Error(`Runtime authorization is invalid: ${JSON.stringify(validation.errors)}`);
    }
    const authorization = validation.value;
    if (authorization.confirmation) {
      const stored = getPluginToolConfirmation(authorization.confirmation.challenge.challenge_id);
      if (!stored || stored.status !== "approved"
        || !isDeepStrictEqual(stored.challenge, authorization.confirmation.challenge)
        || !isDeepStrictEqual(stored.decision, authorization.confirmation.decision)) {
        throw new Error("Runtime prepare authorization confirmation is not the exact persisted approval");
      }
    }
    const transport = await this.#transport(authorization.invocation.binding, authorization.invocation.policy, now);
    const remaining = Date.parse(authorization.invocation.deadline_at) - now.getTime();
    if (remaining <= 0) throw new Error("Plugin Tool deadline exceeded before Runtime prepare RPC");
    const request: HomerailPluginRuntimeRpcRequestV1 = {
      runtime_rpc_version: 1,
      message_type: "request",
      method: "prepare",
      rpc_id: rpcId(),
      sent_at: now.toISOString(),
      params: { authorization },
    };
    const response = await this.#request(request, transport, Math.min(this.#timeoutMs, remaining), {
      now_ms: now.getTime(),
      expected: {
        source: authorization.invocation.source,
        tool: authorization.invocation.tool,
        binding: authorization.invocation.binding,
        policy: authorization.invocation.policy,
        request_id: authorization.invocation.request_id,
        request_digest: authorization.invocation.request_digest,
      },
    });
    if (response.method !== "prepare") throw new Error("Plugin Runtime RPC returned the wrong prepare method");
    return response as HomerailPluginRuntimeRpcPrepareResultV1;
  }

  async cancel(input: {
    request_id: string;
    request_digest: string;
    reason: "user" | "deadline" | "shutdown" | "superseded";
    now?: Date;
  }): Promise<HomerailPluginRuntimeRpcCancelResultV1> {
    const record = getPluginToolRequest(input.request_id);
    if (!record || record.request_digest !== input.request_digest) throw new Error("Plugin Tool cancel binding is invalid");
    const now = input.now ?? new Date();
    const transport = await this.#transport(record.invocation.binding, record.invocation.policy, now);
    const request: HomerailPluginRuntimeRpcRequestV1 = {
      runtime_rpc_version: 1,
      message_type: "request",
      method: "cancel",
      rpc_id: rpcId(),
      sent_at: now.toISOString(),
      params: {
        request_id: input.request_id,
        request_digest: input.request_digest,
        reason: input.reason,
      },
    };
    const response = await this.#request(request, transport, this.#timeoutMs, {
      now_ms: now.getTime(),
      expected: {
        source: record.invocation.source,
        tool: record.invocation.tool,
        binding: record.invocation.binding,
        policy: record.invocation.policy,
        request_id: record.request_id,
        request_digest: record.request_digest,
      },
    });
    if (response.method !== "cancel") throw new Error("Plugin Runtime RPC returned the wrong result method");
    return response as HomerailPluginRuntimeRpcCancelResultV1;
  }

  async reconcile(input: {
    request_id: string;
    request_digest: string;
    now?: Date;
  }): Promise<HomerailPluginRuntimeRpcReconcileResultV1> {
    const record = getPluginToolRequest(input.request_id);
    if (!record || record.request_digest !== input.request_digest) throw new Error("Plugin Tool reconciliation binding is invalid");
    if (record.status !== "running" && !(record.status === "failed" && record.error_code === "runtime_indeterminate")) {
      throw new Error("Plugin Tool request is not eligible for Runtime reconciliation");
    }
    const now = input.now ?? new Date();
    const transport = await this.#transport(record.invocation.binding, record.invocation.policy, now);
    const request: HomerailPluginRuntimeRpcRequestV1 = {
      runtime_rpc_version: 1,
      message_type: "request",
      method: "reconcile",
      rpc_id: rpcId(),
      sent_at: now.toISOString(),
      params: { request_id: input.request_id, request_digest: input.request_digest },
    };
    const response = await this.#request(request, transport, this.#timeoutMs, {
      now_ms: now.getTime(),
      expected: {
        source: record.invocation.source,
        tool: record.invocation.tool,
        binding: record.invocation.binding,
        policy: record.invocation.policy,
        request_id: record.request_id,
        request_digest: record.request_digest,
      },
    });
    if (response.method !== "reconcile") throw new Error("Plugin Runtime RPC returned the wrong reconciliation method");
    const result = response as HomerailPluginRuntimeRpcReconcileResultV1;
    if (result.status === "completed") {
      const digest = createHash("sha256").update(stableStringify(result.output)).digest("hex");
      if (!result.output || result.output_digest !== digest) {
        throw new Error("Plugin Runtime reconciliation output digest is invalid");
      }
    }
    return result;
  }

  async health(input: {
    binding: HomerailPluginToolBindingV1;
    now?: Date;
  }): Promise<HomerailPluginRuntimeRpcHealthResultV1> {
    const now = input.now ?? new Date();
    const transport = await this.#transport(input.binding, undefined, now);
    const request: HomerailPluginRuntimeRpcRequestV1 = {
      runtime_rpc_version: 1,
      message_type: "request",
      method: "health",
      rpc_id: rpcId(),
      sent_at: now.toISOString(),
      params: { binding: structuredClone(input.binding) },
    };
    const response = await this.#request(request, transport, this.#timeoutMs, {
      now_ms: now.getTime(),
      expected: {
        binding: input.binding,
        policy: {
          effect: "read",
          permissions: [],
          effective_grants: [],
          confirmation: "never",
          confirmation_required: false,
        },
      },
    });
    if (response.method !== "health") throw new Error("Plugin Runtime RPC returned the wrong result method");
    return response as HomerailPluginRuntimeRpcHealthResultV1;
  }
}
