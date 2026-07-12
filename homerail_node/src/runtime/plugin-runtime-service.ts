/**
 * Node-owned Plugin Runtime launch, measurement, RPC, and idempotency service.
 * @version 0.1.0
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  HOMERAIL_RUNTIME_BLOCKED_SECRET_ENV,
  HomerailPluginPermission,
  homerailPluginRuntimeContainerMeasurementDigestInput,
  stableStringify,
  validateHomerailPluginRuntimeRpcRequest,
  validateHomerailPluginRuntimeRpcResponse,
  type HomerailPluginEffectivePermissionGrantV1,
  type HomerailPluginRuntimeContainerMeasurementV1,
  type HomerailPluginRuntimeArtifactDeclarationV1,
  type HomerailPluginRuntimeArtifactUploadV1,
  type HomerailPluginRuntimeRpcPrepareResultV1,
  type HomerailPluginRuntimeRpcRequestV1,
  type HomerailPluginRuntimeRpcResponseV1,
  type HomerailPluginRuntimeSandboxAttestationClaimsV1,
  type HomerailPluginRuntimeSandboxAttestationV1,
  type HomerailPluginToolBindingV1,
} from "homerail-protocol";
import type {
  ContainerConfig,
  ContainerInfo,
  ContainerInspectMeasurement,
  ExecutionProvider,
} from "../providers/types.js";
import { NodeRuntimeAttestationAuthority } from "../security/runtime-attestation-key.js";
import {
  HOMERAIL_RUNTIME_BROKERED_PERMISSIONS,
  PluginRuntimeBrokerCapabilityRegistry,
} from "./resource-broker-registry.js";

const RUNTIME_MOUNT = "/opt/homerail/plugin";
const TMP_SIZE = 64 * 1024 * 1024;
const RUNTIME_PIDS_LIMIT = 64;
const RUNTIME_MEMORY_BYTES = 512 * 1024 * 1024;
const RUNTIME_NANO_CPUS = 1_000_000_000;
// Deliberately shorter than Manager's 30s transport deadline so Node can kill,
// persist the terminal ledger, and answer before the outer channel expires.
const RUNTIME_EXEC_MAX_MS = 25_000;
const ATTESTATION_TTL_MS = 10 * 60_000;
const MAX_LEDGER_BYTES = 512 * 1024;
const MAX_RUNTIME_RECORD_BYTES = 1024 * 1024;
const DEFAULT_RUNTIME_IMAGE_ENV = ["NODE_VERSION", "PATH", "YARN_VERSION"] as const;

export interface PluginRuntimeLaunchSpecV1 {
  runtime_launch_version: 1;
  runtime_instance_id: string;
  image: string;
  image_digest: string;
  package_path: string;
  package_payload_digest: string;
  binding: HomerailPluginToolBindingV1;
  entrypoint: { file: string; args: string[] };
  effective_grants: HomerailPluginEffectivePermissionGrantV1[];
  gpu_devices?: string[];
  devices?: string[];
}

export interface PluginRuntimeLaunchResultV1 {
  runtime_instance_id: string;
  node_id: string;
  container_id: string;
  measurement_digest: string;
  image_digest: string;
  attestation: HomerailPluginRuntimeSandboxAttestationV1;
}

interface RuntimeRecord extends PluginRuntimeLaunchResultV1 {
  spec: PluginRuntimeLaunchSpecV1;
  binding: HomerailPluginToolBindingV1;
  entrypoint: { file: string; args: string[] };
  effective_grants: HomerailPluginEffectivePermissionGrantV1[];
  rpc_command: string[];
  provider_measurement: ContainerInspectMeasurement;
  network_name: string | null;
  terminal?: {
    code: "runtime_exec_timeout";
    message: string;
    terminated_at: string;
  };
}

interface RuntimeLedgerRecordV1 {
  ledger_version: 1;
  request_id: string;
  request_digest: string;
  status: "running" | "completed" | "failed";
  owner_boot_id?: string;
  updated_at: string;
  response?: HomerailPluginRuntimeRpcResponseV1;
  output_digest?: string;
  error?: { code: string; message: string };
}

interface RuntimePreparationRecordV1 {
  preparation_version: 1;
  request_id: string;
  request_digest: string;
  updated_at: string;
  response: HomerailPluginRuntimeRpcPrepareResultV1;
}

interface RuntimeRunnerBrokerWriteV1 {
  id: string;
  media_type: string;
  digest: string;
  size_bytes: number;
  content_base64: string;
}

interface RuntimeRunnerResponseV1 {
  runner_rpc_version: 1;
  response: unknown;
  broker_writes: RuntimeRunnerBrokerWriteV1[];
}

interface PersistedRuntimeRecordV1 {
  record_version: 1;
  runtime_instance_id: string;
  node_id: string;
  container_id: string;
  measurement_digest: string;
  image_digest: string;
  attestation: HomerailPluginRuntimeSandboxAttestationV1;
  spec: PluginRuntimeLaunchSpecV1;
  rpc_command: string[];
  provider_measurement: ContainerInspectMeasurement;
  network_name: string | null;
  terminal?: RuntimeRecord["terminal"];
}

export interface PluginRuntimeServiceOptions {
  node_id: string;
  provider: ExecutionProvider;
  authority: NodeRuntimeAttestationAuthority;
  data_root: string;
  package_roots: string[];
  image_allowlist: Record<string, string>;
  seccomp_profile: string;
  allowed_devices?: string[];
  allowed_gpus?: string[];
  runtime_runner?: string;
  allowed_image_env?: string[];
  broker_registry?: PluginRuntimeBrokerCapabilityRegistry;
  now?: () => Date;
  exec_timeout_ms?: number;
}

export class PluginRuntimeService {
  readonly #nodeId: string;
  readonly #provider: ExecutionProvider;
  readonly #authority: NodeRuntimeAttestationAuthority;
  readonly #dataRoot: string;
  readonly #packageRoots: string[];
  readonly #images: Readonly<Record<string, string>>;
  readonly #seccompFile: string;
  readonly #seccompDigest: string;
  readonly #allowedDevices: ReadonlySet<string>;
  readonly #allowedGpus: ReadonlySet<string>;
  readonly #runner: string;
  readonly #allowedImageEnv: ReadonlySet<string>;
  readonly #brokers: PluginRuntimeBrokerCapabilityRegistry;
  readonly #now: () => Date;
  readonly #execTimeoutMs: number;
  readonly #bootId = `boot_${randomBytes(16).toString("hex")}`;
  readonly #records = new Map<string, RuntimeRecord>();

  constructor(options: PluginRuntimeServiceOptions) {
    this.#nodeId = options.node_id;
    this.#provider = options.provider;
    this.#authority = options.authority;
    this.#dataRoot = secureDirectory(path.resolve(options.data_root));
    this.#packageRoots = options.package_roots.map((root) => fs.realpathSync(root));
    if (!this.#packageRoots.length) throw new Error("Plugin Runtime requires at least one package root allowlist");
    this.#images = Object.freeze({ ...options.image_allowlist });
    if (!Object.keys(this.#images).length) throw new Error("Plugin Runtime requires an immutable image allowlist");
    this.#seccompFile = secureRegularFile(options.seccomp_profile);
    let seccomp: unknown;
    try {
      seccomp = JSON.parse(fs.readFileSync(this.#seccompFile, "utf8"));
    } catch {
      throw new Error("Plugin Runtime seccomp profile must be valid JSON");
    }
    this.#seccompDigest = sha256(stableStringify(seccomp));
    this.#allowedDevices = new Set(options.allowed_devices ?? []);
    this.#allowedGpus = new Set(options.allowed_gpus ?? []);
    this.#runner = options.runtime_runner ?? "/usr/local/bin/homerail-plugin-runtime";
    if (!this.#runner.startsWith("/")) throw new Error("Plugin Runtime runner must be an absolute image path");
    this.#allowedImageEnv = new Set(options.allowed_image_env ?? DEFAULT_RUNTIME_IMAGE_ENV);
    if ([...this.#allowedImageEnv].some((name) => !/^[A-Z][A-Z0-9_]{0,127}$/.test(name)
      || /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY|API_KEY)/.test(name))) {
      throw new Error("Plugin Runtime image environment allowlist is unsafe");
    }
    this.#brokers = options.broker_registry ?? new PluginRuntimeBrokerCapabilityRegistry();
    this.#now = options.now ?? (() => new Date());
    this.#execTimeoutMs = options.exec_timeout_ms ?? RUNTIME_EXEC_MAX_MS;
    if (!Number.isSafeInteger(this.#execTimeoutMs) || this.#execTimeoutMs < 10 || this.#execTimeoutMs > RUNTIME_EXEC_MAX_MS) {
      throw new Error("Plugin Runtime exec timeout is outside the fixed containment limit");
    }
    this.#loadPersistedRecords();
  }

  async launch(raw: unknown): Promise<PluginRuntimeLaunchResultV1> {
    const spec = validateLaunchSpec(raw);
    const existing = this.#records.get(spec.runtime_instance_id);
    if (existing) {
      if (!deepEqual(existing.spec, spec)) throw new Error("Plugin Runtime instance identity collides with another launch spec");
      if (!existing.terminal) return this.refreshAttestation(spec.runtime_instance_id);
      // A timed-out exec kills the whole container because its side effects can
      // no longer be bounded. Keep its ledger available for reconciliation,
      // but replace the dead container on the next deterministic lazy launch.
      await this.#provider.stop(existing.container_id).catch(() => undefined);
      await this.#provider.remove(existing.container_id).catch(() => undefined);
      this.#records.delete(spec.runtime_instance_id);
      fs.rmSync(this.#runtimeRecordFile(spec.runtime_instance_id), { force: true });
    }
    const pinnedImage = this.#images[spec.image];
    if (!pinnedImage || pinnedImage !== spec.image_digest) throw new Error("Plugin Runtime image is not explicitly pinned");
    const packagePath = this.#materializePackage(spec);
    const permissions = new Set(spec.effective_grants.map((grant) => grant.permission));
    const gpuDevices = canonicalSubset(spec.gpu_devices, this.#allowedGpus, "GPU");
    const devices = canonicalSubset(spec.devices, this.#allowedDevices, "device");
    if (gpuDevices.length && !permissions.has(HomerailPluginPermission.GPU_USE)) {
      throw new Error("Plugin Runtime GPU request exceeds effective grants");
    }
    if (devices.length && ![
      HomerailPluginPermission.DEVICE_CONTROL,
      HomerailPluginPermission.CAMERA_READ,
      HomerailPluginPermission.MICROPHONE_READ,
    ].some((permission) => permissions.has(permission))) {
      throw new Error("Plugin Runtime device request exceeds effective grants");
    }
    const brokerSessions = [];
    for (const grant of spec.effective_grants) {
      if (!HOMERAIL_RUNTIME_BROKERED_PERMISSIONS.has(grant.permission)) continue;
      brokerSessions.push(await this.#brokers.provision({
        runtime_instance_id: spec.runtime_instance_id,
        binding: spec.binding,
        effective_grant: grant,
      }));
    }
    const networkGrant = spec.effective_grants.find((grant) => grant.permission === HomerailPluginPermission.NETWORK_CONNECT);
    const networkHosts = [...(networkGrant?.hosts ?? [])];
    const networkSession = brokerSessions.find((session) => session.permission === HomerailPluginPermission.NETWORK_CONNECT);
    const networkName = networkSession?.network?.name;
    if (networkGrant && !networkName) throw new Error("Plugin Runtime network grant has no exact broker session");
    if (networkName) {
      const network = await this.#provider.inspectNetwork(networkName);
      if (!network.internal || network.name !== networkName) throw new Error("Plugin Runtime broker network is not internal");
    }
    const runtimePath = `${RUNTIME_MOUNT}/${spec.entrypoint.file}`;
    const serveCommand = [this.#runner, "--serve", "--entrypoint", runtimePath, "--", ...spec.entrypoint.args];
    const rpcCommand = [this.#runner, "--rpc-once", "--entrypoint", runtimePath, "--", ...spec.entrypoint.args];
    const config: ContainerConfig = {
      image: spec.image,
      expectedImageDigest: spec.image_digest,
      command: serveCommand,
      name: `homerail-plugin-runtime-${sha256(spec.runtime_instance_id).slice(0, 20)}`,
      user: "65532:65532",
      readOnlyRootfs: true,
      noNewPrivileges: true,
      capDrop: ["ALL"],
      securityOpts: [`seccomp=${this.#seccompFile}`],
      network: networkName ?? "none",
      mounts: [{ host: packagePath, container: RUNTIME_MOUNT, mode: "ro" }],
      tmpfs: [{ target: "/tmp", sizeBytes: TMP_SIZE }],
      resourceLimits: {
        pids: RUNTIME_PIDS_LIMIT,
        memoryBytes: RUNTIME_MEMORY_BYTES,
        memorySwapBytes: RUNTIME_MEMORY_BYTES,
        nanoCpus: RUNTIME_NANO_CPUS,
      },
      devices: devices.map((device) => ({ host: device, container: device, permissions: "r" })),
      gpus: gpuDevices,
      env: {
        HOMERAIL_RUNTIME_INSTANCE_ID: spec.runtime_instance_id,
        HOMERAIL_PLUGIN_ID: spec.binding.plugin_id,
        HOMERAIL_PLUGIN_VERSION: spec.binding.plugin_version,
      },
      labels: {
        "homerail.resource_type": "plugin-runtime",
        "homerail.node_id": this.#nodeId,
        "homerail.runtime_instance_id": spec.runtime_instance_id,
        "homerail.plugin_id": spec.binding.plugin_id,
        "homerail.plugin_version": spec.binding.plugin_version,
        "homerail.package_digest": spec.binding.package_digest,
      },
    };
    let containerId: string | undefined;
    try {
      const created = await this.#provider.create(config);
      containerId = created.id;
      await this.#provider.start(containerId);
      const inspected = await this.#provider.inspect(containerId);
      const measurement = await this.#measure(inspected, config, spec, networkHosts, networkName ?? null);
      const measurementDigest = sha256(homerailPluginRuntimeContainerMeasurementDigestInput(measurement));
      const now = this.#now();
      const identity = this.#authority.publicIdentity();
      const claims: HomerailPluginRuntimeSandboxAttestationClaimsV1 = {
        sandbox_attestation_version: 1,
        issuer: "homerail-node",
        audience: "homerail-manager",
        key_id: identity.key_id,
        attestation_id: `attest_${randomBytes(16).toString("hex")}`,
        runtime_instance_id: spec.runtime_instance_id,
        node_id: this.#nodeId,
        container_id: containerId,
        image_digest: spec.image_digest,
        measurement_digest: measurementDigest,
        issued_at: now.toISOString(),
        expires_at: new Date(now.getTime() + ATTESTATION_TTL_MS).toISOString(),
        binding: structuredClone(spec.binding),
        entrypoint: structuredClone(spec.entrypoint),
        isolation: structuredClone(measurement.isolation),
        effective_grants: structuredClone(spec.effective_grants),
      };
      const result: RuntimeRecord = {
        runtime_instance_id: spec.runtime_instance_id,
        node_id: this.#nodeId,
        container_id: containerId,
        measurement_digest: measurementDigest,
        image_digest: spec.image_digest,
        attestation: this.#authority.issue(claims, now),
        spec: structuredClone(spec),
        binding: structuredClone(spec.binding),
        entrypoint: structuredClone(spec.entrypoint),
        effective_grants: structuredClone(spec.effective_grants),
        rpc_command: rpcCommand,
        provider_measurement: structuredClone(inspected.measurement!),
        network_name: networkName ?? null,
      };
      this.#records.set(spec.runtime_instance_id, result);
      this.#writeRuntimeRecord(result);
      return publicLaunchResult(result);
    } catch (cause) {
      if (containerId) {
        await this.#provider.stop(containerId).catch(() => undefined);
        await this.#provider.remove(containerId).catch(() => undefined);
      }
      throw cause;
    }
  }

  async rpc(runtimeInstanceId: string, raw: unknown): Promise<unknown> {
    const record = this.#record(runtimeInstanceId);
    const validation = validateHomerailPluginRuntimeRpcRequest(raw, {
      expected: {
        binding: record.binding,
        ...(isRequestCorrelation(raw) ? {
          request_id: raw.params.request_id,
          request_digest: raw.params.request_digest,
        } : {}),
      },
      now_ms: this.#now().getTime(),
    });
    if (!validation.valid || !validation.value) throw new Error(`Invalid Runtime RPC request: ${JSON.stringify(validation.errors)}`);
    const request = validation.value;
    if (request.method === "reconcile") return this.#reconcile(record, request);
    if (record.terminal) throw new Error(`Plugin Runtime instance is terminal: ${record.terminal.message}`);
    await this.#assertMeasurementStillCurrent(record);
    if (request.method === "prepare") return this.#prepare(record, request);
    if (request.method === "execute") return this.#execute(record, request);
    return this.#invokeRuntime(record, request);
  }

  async remove(runtimeInstanceId: string): Promise<void> {
    const record = this.#record(runtimeInstanceId);
    await this.#provider.stop(record.container_id).catch(() => undefined);
    await this.#provider.remove(record.container_id).catch(() => undefined);
    this.#records.delete(runtimeInstanceId);
    fs.rmSync(this.#runtimeRecordFile(runtimeInstanceId), { force: true });
  }

  /**
   * Re-measure the live container and issue a fresh short-lived proof. The
   * private Node identity never crosses the lifecycle channel.
   */
  async refreshAttestation(runtimeInstanceId: string): Promise<PluginRuntimeLaunchResultV1> {
    const record = this.#record(runtimeInstanceId);
    if (record.terminal) throw new Error(`Plugin Runtime instance is terminal: ${record.terminal.message}`);
    await this.#assertMeasurementStillCurrent(record);
    const now = this.#now();
    const identity = this.#authority.publicIdentity();
    record.attestation = this.#authority.issue({
      ...structuredClone(record.attestation.claims),
      key_id: identity.key_id,
      attestation_id: `attest_${randomBytes(16).toString("hex")}`,
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ATTESTATION_TTL_MS).toISOString(),
    }, now);
    this.#writeRuntimeRecord(record);
    return publicLaunchResult(record);
  }

  async #prepare(
    record: RuntimeRecord,
    request: Extract<HomerailPluginRuntimeRpcRequestV1, { method: "prepare" }>,
  ): Promise<unknown> {
    if (!deepEqual(request.params.authorization.invocation.binding, record.binding)
      || !deepEqual(request.params.authorization.invocation.policy.effective_grants, record.effective_grants)) {
      throw new Error("Runtime prepare authority differs from the attested launch grants");
    }
    const invocation = request.params.authorization.invocation;
    const existing = this.#readPreparation(record.runtime_instance_id, invocation.request_id);
    if (existing) {
      if (existing.request_digest !== invocation.request_digest) {
        return rpcError(request, "idempotency_collision", "request id is bound to another preparation digest");
      }
      return correlatedResponse(existing.response, request.rpc_id);
    }
    const raw = await this.#invokeRuntime(record, request, false);
    const validation = validateHomerailPluginRuntimeRpcResponse(raw, {
      expected: {
        binding: record.binding,
        source: invocation.source,
        tool: invocation.tool,
        policy: invocation.policy,
        request_id: invocation.request_id,
        request_digest: invocation.request_digest,
      },
      now_ms: this.#now().getTime(),
    });
    if (!validation.valid || !validation.value
      || validation.value.message_type !== "result" || validation.value.method !== "prepare") {
      throw new Error(`Runtime returned invalid prepare result: ${JSON.stringify(validation.errors)}`);
    }
    const hasArtifactGrant = record.effective_grants.some((grant) => (
      grant.permission === HomerailPluginPermission.ARTIFACT_WRITE
    ));
    if (!hasArtifactGrant && validation.value.artifact_declarations.length) {
      throw new Error("Runtime prepared artifacts without artifact.write authority");
    }
    this.#writePreparation(record.runtime_instance_id, {
      preparation_version: 1,
      request_id: invocation.request_id,
      request_digest: invocation.request_digest,
      updated_at: this.#now().toISOString(),
      response: validation.value,
    });
    return validation.value;
  }

  async #execute(record: RuntimeRecord, request: Extract<HomerailPluginRuntimeRpcRequestV1, { method: "execute" }>): Promise<unknown> {
    if (!deepEqual(request.params.authorization.invocation.binding, record.binding)
      || !deepEqual(request.params.authorization.invocation.policy.effective_grants, record.effective_grants)) {
      throw new Error("Runtime execute authority differs from the attested launch grants");
    }
    const invocation = request.params.authorization.invocation;
    this.#assertPreparedUploads(record, invocation.request_id, invocation.request_digest, request.params.artifact_uploads);
    const existing = this.#readLedger(record.runtime_instance_id, invocation.request_id);
    if (existing) {
      if (existing.request_digest !== invocation.request_digest) return rpcError(request, "idempotency_collision", "request id is bound to another digest");
      if (existing.status === "completed" && existing.response) return correlatedResponse(existing.response, request.rpc_id);
      if (existing.status === "failed") return rpcError(request, existing.error?.code ?? "internal", existing.error?.message ?? "runtime request failed");
      return rpcError(request, "runtime_unavailable", "request is already running or requires reconciliation");
    }
    this.#writeLedger(record.runtime_instance_id, {
      ledger_version: 1,
      request_id: invocation.request_id,
      request_digest: invocation.request_digest,
      status: "running",
      owner_boot_id: this.#bootId,
      updated_at: this.#now().toISOString(),
    });
    let response: unknown;
    try {
      response = await this.#invokeRuntime(record, request, false);
    } catch (cause) {
      this.#writeLedger(record.runtime_instance_id, {
        ledger_version: 1,
        request_id: invocation.request_id,
        request_digest: invocation.request_digest,
        status: "failed",
        updated_at: this.#now().toISOString(),
        error: {
          code: "runtime_process_failed",
          message: boundedErrorMessage(cause),
        },
      });
      throw cause;
    }
    const result = validateHomerailPluginRuntimeRpcResponse(response, {
      expected: {
        binding: record.binding,
        source: invocation.source,
        tool: invocation.tool,
        policy: invocation.policy,
        request_id: invocation.request_id,
        request_digest: invocation.request_digest,
      },
      now_ms: this.#now().getTime(),
    });
    if (!result.valid || !result.value) {
      const cause = new Error(`Runtime returned invalid execute result: ${JSON.stringify(result.errors)}`);
      this.#writeLedger(record.runtime_instance_id, {
        ledger_version: 1,
        request_id: invocation.request_id,
        request_digest: invocation.request_digest,
        status: "failed",
        updated_at: this.#now().toISOString(),
        error: {
          code: "runtime_process_failed",
          message: boundedErrorMessage(cause),
        },
      });
      throw cause;
    }
    if (result.value.message_type === "result" && result.value.method === "execute") {
      this.#writeLedger(record.runtime_instance_id, {
        ledger_version: 1,
        request_id: invocation.request_id,
        request_digest: invocation.request_digest,
        status: "completed",
        updated_at: this.#now().toISOString(),
        response: result.value,
        output_digest: sha256(stableStringify(result.value.output)),
      });
    } else if (result.value.message_type === "error") {
      this.#writeLedger(record.runtime_instance_id, {
        ledger_version: 1,
        request_id: invocation.request_id,
        request_digest: invocation.request_digest,
        status: "failed",
        updated_at: this.#now().toISOString(),
        response: result.value,
        error: { code: result.value.error.code, message: result.value.error.message },
      });
    }
    return result.value;
  }

  #reconcile(record: RuntimeRecord, request: Extract<HomerailPluginRuntimeRpcRequestV1, { method: "reconcile" }>): unknown {
    const ledger = this.#readLedger(record.runtime_instance_id, request.params.request_id);
    const base = {
      runtime_rpc_version: 1 as const,
      message_type: "result" as const,
      method: "reconcile" as const,
      rpc_id: request.rpc_id,
      completed_at: this.#now().toISOString(),
      request_id: request.params.request_id,
      request_digest: request.params.request_digest,
      binding: structuredClone(record.binding),
      logs: [],
      artifacts: [],
    };
    if (!ledger) return { ...base, status: "absent" as const };
    if (ledger.request_digest !== request.params.request_digest) {
      return rpcError(request, "idempotency_collision", "request id is bound to another digest");
    }
    if (ledger.status === "completed" && ledger.response?.message_type === "result" && ledger.response.method === "execute") {
      return {
        ...base,
        status: "completed" as const,
        output_digest: ledger.output_digest,
        output: structuredClone(ledger.response.output),
      };
    }
    if (ledger.status === "failed") return { ...base, status: "failed" as const, error: ledger.error };
    return { ...base, status: "running" as const };
  }

  async #invokeRuntime(record: RuntimeRecord, request: HomerailPluginRuntimeRpcRequestV1, validate = true): Promise<unknown> {
    const runnerRequest = sanitizedRunnerRequest(request);
    const deadline = (request.method === "prepare" || request.method === "execute")
      ? Date.parse(request.params.authorization.invocation.deadline_at)
      : this.#now().getTime() + this.#execTimeoutMs;
    const timeoutMs = Math.max(1, Math.min(this.#execTimeoutMs, deadline - this.#now().getTime()));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let execution;
    try {
      execution = await Promise.race([
        this.#provider.execInput(
          record.container_id,
          record.rpc_command,
          JSON.stringify(runnerRequest),
          { timeoutMs },
        ),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`Plugin Runtime exec timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    } catch (cause) {
      const message = boundedErrorMessage(cause);
      if (message.includes("timed out")) {
        await this.#provider.kill(record.container_id).catch(() => undefined);
        await this.#provider.remove(record.container_id).catch(() => undefined);
        record.terminal = {
          code: "runtime_exec_timeout",
          message,
          terminated_at: this.#now().toISOString(),
        };
        this.#writeRuntimeRecord(record);
      }
      throw cause;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (execution.exitCode !== 0) throw new Error(`Plugin Runtime RPC process failed: ${execution.stderr || `exit ${execution.exitCode}`}`);
    let raw: unknown;
    try {
      raw = JSON.parse(execution.stdout);
    } catch {
      throw new Error("Plugin Runtime RPC output is not JSON");
    }
    if (isRunnerResponse(raw)) {
      if (request.method === "execute") {
        await this.#publishBrokerWrites(request.params.artifact_uploads ?? [], raw.broker_writes, raw.response);
      } else if (raw.broker_writes.length) {
        throw new Error("Plugin Runtime runner attempted broker writes outside execute");
      }
      raw = raw.response;
    }
    if (!validate) return raw;
    const result = validateHomerailPluginRuntimeRpcResponse(raw, { now_ms: this.#now().getTime(), expected: { binding: record.binding } });
    if (!result.valid || !result.value) throw new Error(`Plugin Runtime RPC output is invalid: ${JSON.stringify(result.errors)}`);
    return result.value;
  }

  async #publishBrokerWrites(
    uploads: HomerailPluginRuntimeArtifactUploadV1[],
    writes: RuntimeRunnerBrokerWriteV1[],
    response: unknown,
  ): Promise<void> {
    if (writes.length !== uploads.length) throw new Error("Plugin Runtime broker writes do not match issued upload capabilities");
    const published = new Map<string, Record<string, unknown>>();
    for (let index = 0; index < uploads.length; index += 1) {
      const upload = uploads[index]!;
      const write = writes[index]!;
      if (!isExactBrokerWrite(write) || write.id !== upload.id || write.media_type !== upload.media_type
        || write.digest !== upload.digest || write.size_bytes !== upload.size_bytes) {
        throw new Error("Plugin Runtime broker write differs from its prepared declaration");
      }
      let content: Buffer;
      try {
        content = Buffer.from(write.content_base64, "base64");
      } catch {
        throw new Error("Plugin Runtime broker write encoding is invalid");
      }
      if (content.toString("base64") !== write.content_base64
        || content.byteLength !== upload.size_bytes || sha256(content) !== upload.digest) {
        throw new Error("Plugin Runtime broker write bytes do not match the declared digest/size");
      }
      const target = new URL(upload.upload_url);
      if ((target.protocol !== "http:" && target.protocol !== "https:")
        || target.username || target.password || target.hash) {
        throw new Error("Plugin Runtime Artifact Broker endpoint is invalid");
      }
      const result = await fetch(target, {
        method: "PUT",
        redirect: "error",
        headers: {
          Authorization: `HomerailArtifact ${upload.token}`,
          "Content-Type": upload.media_type,
        },
        body: new Uint8Array(content) as unknown as BodyInit,
      });
      const envelope = await result.json().catch(() => undefined) as { data?: Record<string, unknown> } | undefined;
      const data = envelope?.data;
      if (!result.ok || !data || data.digest !== upload.digest || data.size_bytes !== upload.size_bytes
        || data.media_type !== upload.media_type || data.label !== upload.label
        || data.uri !== `artifact:sha256/${upload.digest}`) {
        throw new Error(`Manager Artifact Broker rejected prepared write ${upload.id}`);
      }
      published.set(upload.id, data);
    }
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      throw new Error("Plugin Runtime runner response is invalid after broker publication");
    }
    const artifacts = (response as { artifacts?: unknown }).artifacts;
    if (!Array.isArray(artifacts) || artifacts.length !== uploads.length) {
      throw new Error("Plugin Runtime passive artifact references do not match broker publications");
    }
    for (const artifact of artifacts) {
      if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
        throw new Error("Plugin Runtime passive artifact reference is invalid");
      }
      const value = artifact as Record<string, unknown>;
      const data = typeof value.id === "string" ? published.get(value.id) : undefined;
      if (!data || value.label !== data.label || value.uri !== data.uri || value.media_type !== data.media_type
        || value.digest !== data.digest || value.size_bytes !== data.size_bytes) {
        throw new Error("Plugin Runtime passive artifact reference differs from broker metadata");
      }
    }
  }

  async #measure(
    inspected: ContainerInfo,
    config: ContainerConfig,
    spec: PluginRuntimeLaunchSpecV1,
    networkHosts: string[],
    networkName: string | null,
  ): Promise<HomerailPluginRuntimeContainerMeasurementV1> {
    const actual = inspected.measurement;
    if (!actual || inspected.id.length < 1) throw new Error("Docker inspect did not return a security measurement");
    if (actual.imageDigest !== spec.image_digest) throw new Error("Docker image measurement differs from the pinned digest");
    if (!deepEqual(actual.command, config.command)) throw new Error("Docker command measurement differs from the fixed runtime runner");
    if (actual.user !== "65532:65532" || !actual.readOnlyRootfs) throw new Error("Docker runtime identity/rootfs measurement is unsafe");
    if (!actual.securityOpts.includes("no-new-privileges:true") && !actual.securityOpts.includes("no-new-privileges")) {
      throw new Error("Docker no-new-privileges measurement is missing");
    }
    const measuredSeccomp = actual.securityOpts.find((option) => option.startsWith("seccomp="));
    if (!measuredSeccomp || !this.#matchesSeccompMeasurement(measuredSeccomp) || !deepEqual(actual.capDrop, ["ALL"])) {
      throw new Error("Docker seccomp/capability measurement differs from policy");
    }
    const packageMount = config.mounts?.find((mount) => mount.container === RUNTIME_MOUNT);
    if (!packageMount) throw new Error("Plugin Runtime package mount is missing from Node policy");
    const expectedMounts = [{ source: fs.realpathSync(packageMount.host), target: RUNTIME_MOUNT, mode: "ro" as const }];
    if (!deepEqual(actual.mounts, expectedMounts)) throw new Error("Docker mount measurement differs from the package-only allowlist");
    const expectedTmpfs = [{ target: "/tmp", options: ["nodev", "noexec", "nosuid", "rw", `size=${TMP_SIZE}`].sort() }];
    if (!deepEqual(actual.tmpfs, expectedTmpfs)) throw new Error("Docker tmpfs measurement differs from policy");
    if (actual.networkMode !== (networkName ?? "none")) throw new Error("Docker network measurement differs from policy");
    if (networkName) {
      const network = await this.#provider.inspectNetwork(networkName);
      if (!network.internal || !actual.networkNames.includes(networkName)) throw new Error("Docker broker network is not internal or attached");
    } else if (actual.networkNames.length) throw new Error("Network-disabled Runtime has an attached network");
    const requiredEnv = ["HOMERAIL_PLUGIN_ID", "HOMERAIL_PLUGIN_VERSION", "HOMERAIL_RUNTIME_INSTANCE_ID"];
    const permittedEnv = new Set([...requiredEnv, ...this.#allowedImageEnv]);
    if (!requiredEnv.every((name) => actual.envNames.includes(name))
      || actual.envNames.some((name) => !permittedEnv.has(name)
        || /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY|API_KEY)/.test(name))
      || HOMERAIL_RUNTIME_BLOCKED_SECRET_ENV.some((name) => actual.envNames.includes(name))) {
      throw new Error("Docker Runtime environment contains unapproved authority");
    }
    const expectedDevices = (config.devices ?? []).map((device) => ({
      host: device.host, container: device.container ?? device.host, permissions: device.permissions ?? "rwm",
    })).sort((left, right) => left.container.localeCompare(right.container));
    if (!deepEqual(actual.devices, expectedDevices) || !deepEqual(actual.gpus, config.gpus ?? [])) {
      throw new Error("Docker device/GPU measurement differs from exact grants");
    }
    if (!deepEqual(actual.resourceLimits, {
      pids: RUNTIME_PIDS_LIMIT,
      memoryBytes: RUNTIME_MEMORY_BYTES,
      memorySwapBytes: RUNTIME_MEMORY_BYTES,
      nanoCpus: RUNTIME_NANO_CPUS,
    })) throw new Error("Docker PID/memory/CPU measurement differs from fixed limits");
    return {
      measurement_version: 1,
      container_id: inspected.id,
      image_digest: actual.imageDigest,
      command: [...actual.command],
      env_names: [...actual.envNames],
      isolation: {
        profile_id: "homerail.plugin-runtime.v1",
        uid: 65532,
        gid: 65532,
        no_new_privileges: true,
        read_only_rootfs: true,
        linux_capabilities: [],
        seccomp_profile_digest: this.#seccompDigest,
        mounts: expectedMounts,
        tmpfs: [{ target: "/tmp", size_bytes: TMP_SIZE, noexec: true, nosuid: true, nodev: true }],
        resources: {
          pids_limit: RUNTIME_PIDS_LIMIT,
          memory_bytes: RUNTIME_MEMORY_BYTES,
          memory_swap_bytes: RUNTIME_MEMORY_BYTES,
          nano_cpus: RUNTIME_NANO_CPUS,
        },
        network: {
          mode: networkName ? "brokered" : "none",
          hosts: [...networkHosts],
          network_name: networkName,
          internal: true,
        },
        gpu: { enabled: actual.gpus.length > 0, devices: [...actual.gpus] },
        devices: actual.devices.map((device) => device.container).sort(),
        blocked_secret_env: [...HOMERAIL_RUNTIME_BLOCKED_SECRET_ENV],
      },
    };
  }

  async #assertMeasurementStillCurrent(record: RuntimeRecord): Promise<void> {
    const inspected = await this.#provider.inspect(record.container_id);
    if (inspected.status !== "running" || !inspected.measurement) throw new Error("Attested Plugin Runtime is not running");
    const claims = record.attestation.claims;
    if (!deepEqual(inspected.measurement, record.provider_measurement)) {
      throw new Error("Plugin Runtime Docker inspect measurement drifted after attestation");
    }
    if (record.network_name) {
      const network = await this.#provider.inspectNetwork(record.network_name);
      if (!network.internal || network.name !== record.network_name) {
        throw new Error("Plugin Runtime broker network drifted after attestation");
      }
    }
    const measurement: HomerailPluginRuntimeContainerMeasurementV1 = {
      measurement_version: 1,
      container_id: record.container_id,
      image_digest: inspected.measurement.imageDigest,
      command: [...inspected.measurement.command],
      env_names: [...inspected.measurement.envNames],
      isolation: structuredClone(claims.isolation),
    };
    if (
      sha256(homerailPluginRuntimeContainerMeasurementDigestInput(measurement)) !== claims.measurement_digest
      || record.measurement_digest !== claims.measurement_digest
    ) throw new Error("Plugin Runtime measurement drifted after attestation");
  }

  #matchesSeccompMeasurement(option: string): boolean {
    if (option === `seccomp=${this.#seccompFile}`) return true;
    try {
      return sha256(stableStringify(JSON.parse(option.slice("seccomp=".length)))) === this.#seccompDigest;
    } catch {
      return false;
    }
  }

  #record(runtimeInstanceId: string): RuntimeRecord {
    const record = this.#records.get(runtimeInstanceId);
    if (!record) throw new Error("Plugin Runtime instance is not registered on this Node");
    return record;
  }

  #runtimeRecordDirectory(): string {
    return secureDirectory(path.join(this.#dataRoot, "runtime-records"));
  }

  #runtimeRecordFile(runtimeInstanceId: string): string {
    return path.join(this.#runtimeRecordDirectory(), `${sha256(runtimeInstanceId)}.json`);
  }

  #writeRuntimeRecord(record: RuntimeRecord): void {
    const file = this.#runtimeRecordFile(record.runtime_instance_id);
    const value: PersistedRuntimeRecordV1 = {
      record_version: 1,
      runtime_instance_id: record.runtime_instance_id,
      node_id: record.node_id,
      container_id: record.container_id,
      measurement_digest: record.measurement_digest,
      image_digest: record.image_digest,
      attestation: structuredClone(record.attestation),
      spec: structuredClone(record.spec),
      rpc_command: [...record.rpc_command],
      provider_measurement: structuredClone(record.provider_measurement),
      network_name: record.network_name,
      ...(record.terminal ? { terminal: structuredClone(record.terminal) } : {}),
    };
    atomicSecureJson(file, value, MAX_RUNTIME_RECORD_BYTES);
  }

  #loadPersistedRecords(): void {
    const directory = this.#runtimeRecordDirectory();
    for (const name of fs.readdirSync(directory).sort()) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error("Plugin Runtime record directory contains an unexpected file");
      const file = path.join(directory, name);
      const value = readSecureJson(file, MAX_RUNTIME_RECORD_BYTES) as Partial<PersistedRuntimeRecordV1>;
      if (value.record_version !== 1
        || typeof value.runtime_instance_id !== "string"
        || typeof value.container_id !== "string"
        || value.node_id !== this.#nodeId
        || typeof value.measurement_digest !== "string"
        || typeof value.image_digest !== "string"
        || !value.attestation
        || !value.provider_measurement
        || !Array.isArray(value.rpc_command)
        || (value.network_name !== null && typeof value.network_name !== "string")
        || (value.terminal !== undefined && (
          value.terminal.code !== "runtime_exec_timeout"
          || typeof value.terminal.message !== "string"
          || typeof value.terminal.terminated_at !== "string"
        ))) {
        throw new Error(`Plugin Runtime record is invalid: ${name}`);
      }
      const spec = validateLaunchSpec(value.spec);
      if (sha256(spec.runtime_instance_id) + ".json" !== name
        || spec.runtime_instance_id !== value.runtime_instance_id
        || spec.image_digest !== value.image_digest
        || value.attestation.claims.runtime_instance_id !== value.runtime_instance_id
        || value.attestation.claims.node_id !== this.#nodeId
        || value.attestation.claims.container_id !== value.container_id
        || value.attestation.claims.measurement_digest !== value.measurement_digest
        || !deepEqual(value.attestation.claims.binding, spec.binding)
        || !deepEqual(value.attestation.claims.entrypoint, spec.entrypoint)
        || !deepEqual(value.attestation.claims.effective_grants, spec.effective_grants)) {
        throw new Error(`Plugin Runtime record binding is invalid: ${name}`);
      }
      this.#verifyPackage(spec);
      this.#records.set(spec.runtime_instance_id, {
        runtime_instance_id: spec.runtime_instance_id,
        node_id: this.#nodeId,
        container_id: value.container_id,
        measurement_digest: value.measurement_digest,
        image_digest: value.image_digest,
        attestation: structuredClone(value.attestation),
        spec: structuredClone(spec),
        binding: structuredClone(spec.binding),
        entrypoint: structuredClone(spec.entrypoint),
        effective_grants: structuredClone(spec.effective_grants),
        rpc_command: [...value.rpc_command],
        provider_measurement: structuredClone(value.provider_measurement),
        network_name: value.network_name,
        ...(value.terminal ? { terminal: structuredClone(value.terminal) } : {}),
      });
    }
  }

  #ledgerFile(runtimeInstanceId: string, requestId: string): string {
    const dir = secureDirectory(path.join(this.#dataRoot, "runtime-ledger", sha256(runtimeInstanceId)));
    return path.join(dir, `${sha256(requestId)}.json`);
  }

  #preparationFile(runtimeInstanceId: string, requestId: string): string {
    const dir = secureDirectory(path.join(this.#dataRoot, "runtime-preparations", sha256(runtimeInstanceId)));
    return path.join(dir, `${sha256(requestId)}.json`);
  }

  #readPreparation(runtimeInstanceId: string, requestId: string): RuntimePreparationRecordV1 | undefined {
    const file = this.#preparationFile(runtimeInstanceId, requestId);
    if (!fs.existsSync(file)) return undefined;
    const value = readSecureJson(file, MAX_LEDGER_BYTES) as RuntimePreparationRecordV1;
    if (value.preparation_version !== 1 || value.request_id !== requestId
      || value.response?.message_type !== "result" || value.response.method !== "prepare") {
      throw new Error("Plugin Runtime preparation record is corrupt");
    }
    return value;
  }

  #writePreparation(runtimeInstanceId: string, value: RuntimePreparationRecordV1): void {
    atomicSecureJson(this.#preparationFile(runtimeInstanceId, value.request_id), value, MAX_LEDGER_BYTES);
  }

  #assertPreparedUploads(
    record: RuntimeRecord,
    requestId: string,
    requestDigest: string,
    uploads: HomerailPluginRuntimeArtifactUploadV1[] | undefined,
  ): void {
    const hasArtifactGrant = record.effective_grants.some((grant) => (
      grant.permission === HomerailPluginPermission.ARTIFACT_WRITE
    ));
    if (!hasArtifactGrant) {
      if (uploads?.length) throw new Error("Runtime execute received Artifact Broker authority without artifact.write grant");
      return;
    }
    const preparation = this.#readPreparation(record.runtime_instance_id, requestId);
    if (!preparation || preparation.request_digest !== requestDigest) {
      throw new Error("Runtime execute is missing the exact pure prepare record");
    }
    const declarations = preparation.response.artifact_declarations;
    if ((uploads?.length ?? 0) !== declarations.length) {
      throw new Error("Runtime Artifact Broker capabilities do not match prepared declarations");
    }
    for (let index = 0; index < declarations.length; index += 1) {
      const declaration = declarations[index]!;
      const upload = uploads![index]!;
      const expected: HomerailPluginRuntimeArtifactDeclarationV1 = {
        id: upload.id,
        label: upload.label,
        media_type: upload.media_type,
        digest: upload.digest,
        size_bytes: upload.size_bytes,
      };
      if (!deepEqual(expected, declaration)) {
        throw new Error("Runtime Artifact Broker capability widens or changes a prepared declaration");
      }
    }
  }

  #readLedger(runtimeInstanceId: string, requestId: string): RuntimeLedgerRecordV1 | undefined {
    const file = this.#ledgerFile(runtimeInstanceId, requestId);
    if (!fs.existsSync(file)) return undefined;
    const value = readSecureJson(file, MAX_LEDGER_BYTES) as RuntimeLedgerRecordV1;
    if (value.ledger_version !== 1 || value.request_id !== requestId) throw new Error("Plugin Runtime ledger record is corrupt");
    if (value.status === "running" && value.owner_boot_id !== this.#bootId) {
      const interrupted: RuntimeLedgerRecordV1 = {
        ...value,
        status: "failed",
        updated_at: this.#now().toISOString(),
        error: {
          code: "runtime_interrupted",
          message: "Node restarted while the Runtime request outcome was not durably recorded",
        },
      };
      this.#writeLedger(runtimeInstanceId, interrupted);
      return interrupted;
    }
    return value;
  }

  #writeLedger(runtimeInstanceId: string, value: RuntimeLedgerRecordV1): void {
    const file = this.#ledgerFile(runtimeInstanceId, value.request_id);
    atomicSecureJson(file, value, MAX_LEDGER_BYTES);
  }

  #materializePackage(spec: PluginRuntimeLaunchSpecV1): string {
    const source = this.#verifyPackage(spec);
    const root = secureDirectory(path.join(this.#dataRoot, "runtime-packages"));
    const target = path.join(root, spec.package_payload_digest);
    if (fs.existsSync(target)) {
      const snapshotSpec = { ...spec, package_path: target };
      return this.#verifyPackage(snapshotSpec);
    }
    const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    fs.mkdirSync(temporary, { mode: 0o700 });
    try {
      for (const relative of listPackageFiles(source)) {
        const from = resolvePackageFile(source, relative);
        const to = path.join(temporary, ...relative.split("/"));
        fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o755 });
        fs.writeFileSync(to, fs.readFileSync(from), { flag: "wx", mode: 0o444 });
        fs.chmodSync(to, 0o444);
      }
      for (const directory of listDirectoriesDepthFirst(temporary)) fs.chmodSync(directory, 0o555);
      fs.chmodSync(temporary, 0o555);
      try {
        fs.renameSync(temporary, target);
      } catch (cause) {
        if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause;
      }
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
    return this.#verifyPackage({ ...spec, package_path: target });
  }

  #verifyPackage(spec: PluginRuntimeLaunchSpecV1): string {
    const packagePath = fs.realpathSync(spec.package_path);
    const snapshotRoot = path.join(this.#dataRoot, "runtime-packages");
    if (![...this.#packageRoots, snapshotRoot].some((root) => packagePath === root || packagePath.startsWith(`${root}${path.sep}`))) {
      throw new Error("Plugin Runtime package path is outside the Node allowlist");
    }
    const lockPath = path.join(packagePath, "homerail.lock.json");
    const lock = JSON.parse(fs.readFileSync(secureRegularFile(lockPath), "utf8")) as Record<string, unknown>;
    if (lock.payload_digest !== spec.package_payload_digest) throw new Error("Plugin Runtime package payload digest is not pinned");
    const plugin = lock.plugin as Record<string, unknown> | undefined;
    if (plugin?.id !== spec.binding.plugin_id || plugin.version !== spec.binding.plugin_version || !Array.isArray(lock.files)) {
      throw new Error("Plugin Runtime package lock identity is invalid");
    }
    const unsignedLock = {
      lock_version: lock.lock_version,
      manifest: lock.manifest,
      plugin: lock.plugin,
      manifest_sha256: lock.manifest_sha256,
      files: lock.files,
    };
    if (sha256(`${stableStringify(unsignedLock)}\n`) !== lock.payload_digest) {
      throw new Error("Plugin Runtime package lock digest is invalid");
    }
    const lockedPaths: string[] = [];
    for (const item of lock.files) {
      if (!item || typeof item !== "object") throw new Error("Plugin Runtime package lock entry is invalid");
      const entry = item as Record<string, unknown>;
      if (typeof entry.path !== "string" || typeof entry.sha256 !== "string" || !Number.isSafeInteger(entry.size)) throw new Error("Plugin Runtime package lock entry is invalid");
      const file = resolvePackageFile(packagePath, entry.path);
      const bytes = fs.readFileSync(file);
      if (bytes.byteLength !== entry.size || sha256(bytes) !== entry.sha256) throw new Error(`Plugin Runtime package file digest mismatch: ${entry.path}`);
      lockedPaths.push(entry.path);
    }
    const actualPaths = listPackageFiles(packagePath).filter((file) => !["homerail.lock.json", "homerail.signature.json"].includes(file));
    if (!deepEqual(actualPaths, [...lockedPaths].sort())) throw new Error("Plugin Runtime package contains unlocked files");
    if (!lockedPaths.includes(spec.entrypoint.file)) throw new Error("Plugin Runtime entrypoint is not locked by the package");
    return packagePath;
  }
}

function validateLaunchSpec(raw: unknown): PluginRuntimeLaunchSpecV1 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Plugin Runtime launch spec must be an object");
  const value = structuredClone(raw) as PluginRuntimeLaunchSpecV1;
  if (value.runtime_launch_version !== 1 || typeof value.runtime_instance_id !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(value.runtime_instance_id)) throw new Error("Plugin Runtime launch identity is invalid");
  if (typeof value.image !== "string" || typeof value.image_digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.image_digest)) throw new Error("Plugin Runtime image pin is invalid");
  if (typeof value.package_path !== "string" || !path.isAbsolute(value.package_path) || !/^[a-f0-9]{64}$/.test(value.package_payload_digest)) throw new Error("Plugin Runtime package pin is invalid");
  if (!value.binding || !value.entrypoint || !Array.isArray(value.entrypoint.args) || !Array.isArray(value.effective_grants)) throw new Error("Plugin Runtime launch binding is invalid");
  if (value.entrypoint.file.startsWith("/") || value.entrypoint.file.split("/").includes("..")) throw new Error("Plugin Runtime entrypoint escapes the package");
  return value;
}

function canonicalSubset(raw: string[] | undefined, allowed: ReadonlySet<string>, label: string): string[] {
  const values = [...new Set(raw ?? [])].sort();
  if (values.length !== (raw ?? []).length || values.some((value) => !allowed.has(value))) throw new Error(`Plugin Runtime ${label} selection is not allowlisted`);
  return values;
}

function secureDirectory(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new Error(`Unsafe Plugin Runtime directory: ${dir}`);
  return fs.realpathSync(dir);
}

function secureRegularFile(file: string): string {
  const resolved = path.resolve(file);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Plugin Runtime file must be regular: ${resolved}`);
  return fs.realpathSync(resolved);
}

function readSecureJson(file: string, maxBytes: number): unknown {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0
    || stat.size < 2 || stat.size > maxBytes) {
    throw new Error("Plugin Runtime state file is unsafe");
  }
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(descriptor);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) {
      throw new Error("Plugin Runtime state file changed while opening");
    }
    return JSON.parse(fs.readFileSync(descriptor, "utf8"));
  } finally {
    fs.closeSync(descriptor);
  }
}

function atomicSecureJson(file: string, value: unknown, maxBytes: number): void {
  const temp = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const encoded = `${stableStringify(value)}\n`;
  if (Buffer.byteLength(encoded) > maxBytes) throw new Error("Plugin Runtime state record is too large");
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.writeFileSync(descriptor, encoded, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temp, file);
    const directory = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temp, { force: true });
  }
}

function resolvePackageFile(root: string, relative: string): string {
  const candidate = path.resolve(root, ...relative.split("/"));
  const rel = path.relative(root, candidate);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Plugin Runtime package file escapes root");
  return secureRegularFile(candidate);
}

function listPackageFiles(root: string, relative = ""): string[] {
  const directory = path.join(root, relative);
  const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  return entries.flatMap((entry) => {
    if (entry.isSymbolicLink()) throw new Error("Plugin Runtime package cannot contain symlinks");
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return listPackageFiles(root, child);
    if (!entry.isFile()) throw new Error("Plugin Runtime package contains a special file");
    return [child];
  });
}

function listDirectoriesDepthFirst(root: string, relative = ""): string[] {
  const directory = path.join(root, relative);
  const children = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  return children.flatMap((entry) => {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    return [...listDirectoriesDepthFirst(root, child), path.join(root, child)];
  });
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedErrorMessage(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause))
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 1000);
}

function deepEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function publicLaunchResult(record: RuntimeRecord): PluginRuntimeLaunchResultV1 {
  return {
    runtime_instance_id: record.runtime_instance_id,
    node_id: record.node_id,
    container_id: record.container_id,
    measurement_digest: record.measurement_digest,
    image_digest: record.image_digest,
    attestation: structuredClone(record.attestation),
  };
}

function isRequestCorrelation(value: unknown): value is { params: { request_id: string; request_digest: string } } {
  if (!value || typeof value !== "object") return false;
  const params = (value as { params?: unknown }).params;
  return Boolean(params && typeof params === "object" && "request_id" in params && "request_digest" in params);
}

function sanitizedRunnerRequest(request: HomerailPluginRuntimeRpcRequestV1): unknown {
  if (request.method !== "execute" || !request.params.artifact_uploads) return structuredClone(request);
  return {
    ...structuredClone(request),
    params: {
      authorization: structuredClone(request.params.authorization),
      artifact_uploads: request.params.artifact_uploads.map((upload) => ({
        id: upload.id,
        label: upload.label,
        media_type: upload.media_type,
        digest: upload.digest,
        size_bytes: upload.size_bytes,
      })),
    },
  };
}

function isRunnerResponse(value: unknown): value is RuntimeRunnerResponseV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join("\0") === ["broker_writes", "response", "runner_rpc_version"].sort().join("\0")
    && record.runner_rpc_version === 1
    && Array.isArray(record.broker_writes);
}

function isExactBrokerWrite(value: unknown): value is RuntimeRunnerBrokerWriteV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join("\0") === ["id", "media_type", "digest", "size_bytes", "content_base64"].sort().join("\0")
    && typeof record.id === "string"
    && typeof record.media_type === "string"
    && typeof record.digest === "string"
    && Number.isSafeInteger(record.size_bytes)
    && typeof record.content_base64 === "string";
}

function rpcError(
  request: Extract<HomerailPluginRuntimeRpcRequestV1, { method: "prepare" | "execute" | "reconcile" }>,
  code: string,
  message: string,
): unknown {
  const correlation = request.method === "reconcile"
    ? request.params
    : request.params.authorization.invocation;
  return {
    runtime_rpc_version: 1,
    message_type: "error",
    method: request.method,
    rpc_id: request.rpc_id,
    completed_at: new Date().toISOString(),
    request_id: correlation.request_id,
    request_digest: correlation.request_digest,
    error: { code, message, retryable: false },
    logs: [],
    artifacts: [],
  };
}

function correlatedResponse(response: HomerailPluginRuntimeRpcResponseV1, rpcId: string): HomerailPluginRuntimeRpcResponseV1 {
  return { ...structuredClone(response), rpc_id: rpcId };
}
