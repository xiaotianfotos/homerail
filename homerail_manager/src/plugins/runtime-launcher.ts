/** Attested Node Plugin Runtime launch and transport registration. @version 0.1.0 */

import { isDeepStrictEqual } from "node:util";
import type {
  HomerailPluginRuntimeRpcRequestV1,
  HomerailPluginRuntimeSandboxAttestationV1,
  HomerailPluginToolBindingV1,
  HomerailPluginToolPolicyV1,
} from "homerail-protocol";
import { sendLifecycleRequest } from "../node/lifecycle-request.js";
import { promoteAttestedPluginRuntimeInstallation } from "../persistence/plugins.js";
import {
  PluginRuntimeTerminalTransportFailure,
  PluginRuntimeTransportRegistry,
  type PluginRuntimeSandboxGate,
  type PluginRuntimeTransport,
  type PluginRuntimeTransportIdentityV1,
  type ResolvedPluginRuntimeV1,
} from "./runtime-broker.js";

export interface LaunchPluginRuntimeInput {
  node_id: string;
  runtime_instance_id: string;
  image: string;
  image_digest: string;
  package_path: string;
  package_payload_digest: string;
  binding: HomerailPluginToolBindingV1;
  entrypoint: { file: string; args: string[] };
  policy: HomerailPluginToolPolicyV1;
  gpu_devices?: string[];
  devices?: string[];
  runtime: ResolvedPluginRuntimeV1;
}

export interface AttestedPluginRuntimeLaunch {
  runtime_instance_id: string;
  node_id: string;
  container_id: string;
  measurement_digest: string;
  image_digest: string;
  attestation: HomerailPluginRuntimeSandboxAttestationV1;
}

export class NodePluginRuntimeTransport implements PluginRuntimeTransport {
  readonly #nodeId: string;
  readonly #runtimeInstanceId: string;

  constructor(nodeId: string, runtimeInstanceId: string) {
    this.#nodeId = nodeId;
    this.#runtimeInstanceId = runtimeInstanceId;
  }

  async request(request: HomerailPluginRuntimeRpcRequestV1, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw signal.reason ?? new Error("Plugin Runtime RPC aborted");
    const lifecycle = sendLifecycleRequest(this.#nodeId, "plugin_runtime", "rpc", {
      runtime_instance_id: this.#runtimeInstanceId,
      request,
    });
    let abortRequest: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortRequest = () => reject(signal.reason ?? new Error("Plugin Runtime RPC aborted"));
      signal.addEventListener("abort", abortRequest, { once: true });
    });
    let result;
    try {
      result = await Promise.race([lifecycle, aborted]);
    } catch (cause) {
      if (signal.aborted || /timed out|deadline exceeded/i.test(cause instanceof Error ? cause.message : String(cause))) {
        throw new PluginRuntimeTerminalTransportFailure(
          `Node Plugin Runtime transport exceeded its terminal deadline: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        );
      }
      throw cause;
    } finally {
      if (abortRequest) signal.removeEventListener("abort", abortRequest);
    }
    if (result.status !== "success" || !result.resource_data) {
      const message = `Node Plugin Runtime RPC failed: ${JSON.stringify(result.error ?? {})}`;
      if (/not running|not registered|not found|timed out|terminal|stopped/i.test(message)) {
        throw new PluginRuntimeTerminalTransportFailure(message);
      }
      throw new Error(message);
    }
    return result.resource_data;
  }
}

export async function launchAndRegisterPluginRuntime(input: {
  launch: LaunchPluginRuntimeInput;
  gate: PluginRuntimeSandboxGate;
  transports: PluginRuntimeTransportRegistry;
  promote_installation?: boolean;
}): Promise<AttestedPluginRuntimeLaunch> {
  const launch = input.launch;
  const result = await sendLifecycleRequest(launch.node_id, "plugin_runtime", "launch", {
    runtime_launch_version: 1,
    runtime_instance_id: launch.runtime_instance_id,
    image: launch.image,
    image_digest: launch.image_digest,
    package_path: launch.package_path,
    package_payload_digest: launch.package_payload_digest,
    binding: launch.binding,
    entrypoint: launch.entrypoint,
    effective_grants: launch.policy.effective_grants,
    ...(launch.gpu_devices ? { gpu_devices: launch.gpu_devices } : {}),
    ...(launch.devices ? { devices: launch.devices } : {}),
  }, { timeoutMs: 120_000 });
  if (result.status !== "success" || !result.resource_data) {
    throw new Error(`Node Plugin Runtime launch failed: ${JSON.stringify(result.error ?? {})}`);
  }
  const value = result.resource_data as unknown as AttestedPluginRuntimeLaunch;
  try {
    if (
      value.runtime_instance_id !== launch.runtime_instance_id
      || value.node_id !== launch.node_id
      || value.image_digest !== launch.image_digest
      || !isDeepStrictEqual(value.attestation?.claims?.binding, launch.binding)
      || !isDeepStrictEqual(value.attestation?.claims?.entrypoint, launch.entrypoint)
      || !isDeepStrictEqual(value.attestation?.claims?.effective_grants, launch.policy.effective_grants)
    ) throw new Error("Node Plugin Runtime launch response does not match the Manager request");
    const identity: PluginRuntimeTransportIdentityV1 = {
      node_id: value.node_id,
      runtime_instance_id: value.runtime_instance_id,
      container_id: value.container_id,
      measurement_digest: value.measurement_digest,
      image_digest: value.image_digest,
    };
    input.gate.assertAllowed({
      runtime: { ...launch.runtime, image_digest: launch.image_digest },
      binding: launch.binding,
      policy: launch.policy,
      attestation: value.attestation,
      transport_identity: identity,
      now: new Date(),
    });
    if (launch.runtime.source === "installed" && input.promote_installation !== false) {
      promoteAttestedPluginRuntimeInstallation({
        plugin_id: launch.binding.plugin_id,
        plugin_version: launch.binding.plugin_version,
        package_digest: launch.binding.package_digest,
        payload_digest: launch.package_payload_digest,
        attestation: value.attestation,
      });
    }
    input.transports.register(
    launch.binding.plugin_id,
    launch.binding.plugin_version,
    new NodePluginRuntimeTransport(launch.node_id, launch.runtime_instance_id),
    {
      sandbox_attestation: value.attestation,
      sandbox_identity: identity,
      refresh_sandbox: async () => {
        const refreshed = await sendLifecycleRequest(launch.node_id, "plugin_runtime", "refresh_attestation", {
          runtime_instance_id: launch.runtime_instance_id,
        });
        if (refreshed.status !== "success" || !refreshed.resource_data) {
          throw new Error(`Node Plugin Runtime attestation refresh failed: ${JSON.stringify(refreshed.error ?? {})}`);
        }
        const next = refreshed.resource_data as unknown as AttestedPluginRuntimeLaunch;
        if (next.runtime_instance_id !== launch.runtime_instance_id
          || next.node_id !== launch.node_id
          || next.container_id !== value.container_id
          || next.measurement_digest !== value.measurement_digest
          || next.image_digest !== launch.image_digest) {
          throw new Error("Node Plugin Runtime attestation refresh changed immutable transport identity");
        }
        const nextIdentity: PluginRuntimeTransportIdentityV1 = {
          node_id: next.node_id,
          runtime_instance_id: next.runtime_instance_id,
          container_id: next.container_id,
          measurement_digest: next.measurement_digest,
          image_digest: next.image_digest,
        };
        input.gate.assertAllowed({
          runtime: { ...launch.runtime, image_digest: launch.image_digest },
          binding: launch.binding,
          policy: launch.policy,
          attestation: next.attestation,
          transport_identity: nextIdentity,
          now: new Date(),
        });
        return { sandbox_attestation: next.attestation, sandbox_identity: nextIdentity };
      },
    },
    );
    return structuredClone(value);
  } catch (cause) {
    await sendLifecycleRequest(launch.node_id, "plugin_runtime", "remove", {
      runtime_instance_id: launch.runtime_instance_id,
    }).catch(() => undefined);
    throw cause;
  }
}
