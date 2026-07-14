/** Default M6 executable HRP preflight and exact-binding lazy launcher. @version 0.1.0 */

import { createHash } from "node:crypto";
import {
  HomerailPluginRuntimeTrust,
  stableStringify,
  type HomerailPluginToolBindingV1,
  type HomerailPluginToolPolicyV1,
} from "homerail-protocol";
import { getNode } from "../node/registry.js";
import { sendLifecycleRequest } from "../node/lifecycle-request.js";
import {
  getPluginPermissionRevision,
  getPluginRegistryState,
  listPluginVersions,
  promoteAttestedPluginRuntimeInstallation,
} from "../persistence/plugins.js";
import { resolvePluginPermissionPolicy } from "./permission-broker.js";
import {
  PluginRuntimeTransportRegistry,
  type ResolvedPluginRuntimeV1,
} from "./runtime-broker.js";
import { launchAndRegisterPluginRuntime, type AttestedPluginRuntimeLaunch } from "./runtime-launcher.js";
import { getPluginRuntimeSandboxGate } from "./runtime-sandbox-config.js";

export const PLUGIN_RUNTIME_NODE_ENV = "HOMERAIL_PLUGIN_RUNTIME_NODE_ID";
export const PLUGIN_RUNTIME_IMAGE_ENV = "HOMERAIL_PLUGIN_RUNTIME_IMAGE";
export const PLUGIN_RUNTIME_IMAGE_DIGEST_ENV = "HOMERAIL_PLUGIN_RUNTIME_IMAGE_DIGEST";

interface RuntimeLaunchConfiguration {
  node_id: string;
  image: string;
  image_digest: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function launchConfiguration(env: NodeJS.ProcessEnv = process.env): RuntimeLaunchConfiguration {
  const nodeId = env[PLUGIN_RUNTIME_NODE_ENV]?.trim();
  const image = env[PLUGIN_RUNTIME_IMAGE_ENV]?.trim();
  const imageDigest = env[PLUGIN_RUNTIME_IMAGE_DIGEST_ENV]?.trim();
  if (!nodeId || !image || !imageDigest) {
    throw new Error(
      `Executable Plugin Runtime requires ${PLUGIN_RUNTIME_NODE_ENV}, ${PLUGIN_RUNTIME_IMAGE_ENV}, and ${PLUGIN_RUNTIME_IMAGE_DIGEST_ENV}`,
    );
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest)) {
    throw new Error(`${PLUGIN_RUNTIME_IMAGE_DIGEST_ENV} must be an immutable sha256 image id`);
  }
  const node = getNode(nodeId);
  if (!node || node.socket.readyState !== 1 || !node.capabilities.includes("plugin-runtime")) {
    throw new Error(`Configured Plugin Runtime Node is not connected and runtime-capable: ${nodeId}`);
  }
  return { node_id: nodeId, image, image_digest: imageDigest };
}

function installationFor(runtime: ResolvedPluginRuntimeV1): NonNullable<ReturnType<typeof listPluginVersions>[number]["installation"]> {
  const version = listPluginVersions(runtime.plugin_id).find((candidate) => (
    candidate.plugin_version === runtime.plugin_version
  ));
  const installation = version?.installation;
  if (!installation || version?.package_digest !== runtime.package_digest
    || installation.lifecycle_state === "removed" || installation.signature_state === "revoked") {
    throw new Error(`Executable Plugin Runtime installation is unavailable: ${runtime.plugin_id}@${runtime.plugin_version}`);
  }
  return installation;
}

function runtimeInstanceId(input: {
  phase: "preflight" | "active";
  config: RuntimeLaunchConfiguration;
  binding: HomerailPluginToolBindingV1;
  policy: HomerailPluginToolPolicyV1;
}): string {
  return `runtime_${input.phase}_${sha256(stableStringify(input)).slice(0, 40)}`;
}

const launches = new Map<string, Promise<void>>();

export async function ensurePluginRuntimeTransport(input: {
  runtime: ResolvedPluginRuntimeV1;
  binding: HomerailPluginToolBindingV1;
  policy?: HomerailPluginToolPolicyV1;
  transports: PluginRuntimeTransportRegistry;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  if (input.runtime.trust !== HomerailPluginRuntimeTrust.SANDBOXED_RUNTIME
    || input.runtime.source !== "installed" || !input.runtime.entrypoint || !input.policy) {
    throw new Error("Lazy Runtime launch is restricted to installed sandboxed_runtime HRPs with exact Tool policy");
  }
  if (input.transports.resolveRegistration(input.binding, input.policy)) return;
  const config = launchConfiguration(input.env);
  const installation = installationFor(input.runtime);
  if (installation.lifecycle_state !== "installed" || installation.health_state !== "healthy") {
    throw new Error("Executable Plugin Runtime must pass attested preflight before lazy launch");
  }
  const key = stableStringify({ binding: input.binding, policy: input.policy, config });
  let pending = launches.get(key);
  if (!pending) {
    pending = (async () => {
      if (input.transports.resolveRegistration(input.binding, input.policy)) return;
      await launchAndRegisterPluginRuntime({
        launch: {
          node_id: config.node_id,
          runtime_instance_id: runtimeInstanceId({ phase: "active", config, binding: input.binding, policy: input.policy! }),
          image: config.image,
          image_digest: config.image_digest,
          package_path: installation.package_path,
          package_payload_digest: installation.payload_digest,
          binding: input.binding,
          entrypoint: input.runtime.entrypoint!,
          policy: input.policy!,
          runtime: input.runtime,
        },
        gate: getPluginRuntimeSandboxGate(),
        transports: input.transports,
      });
    })().finally(() => launches.delete(key));
    launches.set(key, pending);
  }
  await pending;
}

/**
 * Public service transition for staged executable HRPs. It proves one exact
 * package/policy on a real Node, promotes through persistence, then removes
 * the preflight container. It never enables the plugin implicitly.
 */
export async function preflightInstalledPluginRuntime(input: {
  plugin_id: string;
  plugin_version: string;
  env?: NodeJS.ProcessEnv;
}): Promise<AttestedPluginRuntimeLaunch> {
  const version = listPluginVersions(input.plugin_id).find((candidate) => (
    candidate.plugin_version === input.plugin_version
  ));
  const installation = version?.installation;
  if (!version || !installation || version.source !== "installed"
    || installation.lifecycle_state !== "staged" || installation.health_state !== "unchecked"
    || version.descriptor.manifest.runtime.trust !== HomerailPluginRuntimeTrust.SANDBOXED_RUNTIME
    || !version.descriptor.manifest.runtime.entrypoint) {
    throw new Error("Plugin Runtime preflight requires an exact staged executable HRP");
  }
  const tool = version.descriptor.manifest.tools.find((candidate) => candidate.handler.type === "runtime");
  if (!tool) throw new Error("Plugin Runtime preflight requires a declared Runtime Tool");
  const resolvedPolicy = resolvePluginPermissionPolicy({
    plugin_id: input.plugin_id,
    plugin_version: input.plugin_version,
    permissions: tool.permissions,
    effect: tool.effect,
    confirmation: tool.confirmation,
  });
  if (!resolvedPolicy.runnable) throw new Error("Plugin Runtime preflight requires all exact Tool grants");
  const policy: HomerailPluginToolPolicyV1 = {
    effect: resolvedPolicy.effect,
    permissions: [...tool.permissions],
    effective_grants: structuredClone(resolvedPolicy.effective_grants),
    confirmation: resolvedPolicy.confirmation,
    confirmation_required: resolvedPolicy.confirmation_required,
  };
  const config = launchConfiguration(input.env);
  const state = getPluginRegistryState();
  const binding: HomerailPluginToolBindingV1 = {
    plugin_id: input.plugin_id,
    plugin_version: input.plugin_version,
    manifest_digest: version.descriptor.manifest_digest,
    package_digest: version.package_digest,
    context_digest: "0".repeat(64),
    registry_revision: state.revision,
    permission_revision: getPluginPermissionRevision(),
  };
  const runtime: ResolvedPluginRuntimeV1 = {
    plugin_id: input.plugin_id,
    plugin_version: input.plugin_version,
    package_digest: version.package_digest,
    manifest_digest: version.descriptor.manifest_digest,
    registry_revision: binding.registry_revision,
    source: "installed",
    trust: HomerailPluginRuntimeTrust.SANDBOXED_RUNTIME,
    entrypoint: structuredClone(version.descriptor.manifest.runtime.entrypoint),
  };
  const transports = new PluginRuntimeTransportRegistry();
  const runtimeId = runtimeInstanceId({ phase: "preflight", config, binding, policy });
  const launched = await launchAndRegisterPluginRuntime({
    launch: {
      node_id: config.node_id,
      runtime_instance_id: runtimeId,
      image: config.image,
      image_digest: config.image_digest,
      package_path: installation.package_path,
      package_payload_digest: installation.payload_digest,
      binding,
      entrypoint: runtime.entrypoint!,
      policy,
      runtime,
    },
    gate: getPluginRuntimeSandboxGate(),
    transports,
    promote_installation: false,
  });
  transports.unregister(binding, policy);
  const removed = await sendLifecycleRequest(config.node_id, "plugin_runtime", "remove", {
    runtime_instance_id: runtimeId,
  });
  if (removed.status !== "success") throw new Error("Plugin Runtime preflight container cleanup failed");
  promoteAttestedPluginRuntimeInstallation({
    plugin_id: input.plugin_id,
    plugin_version: input.plugin_version,
    package_digest: version.package_digest,
    payload_digest: installation.payload_digest,
    attestation: launched.attestation,
  });
  return launched;
}

export function _resetPluginRuntimeOrchestratorForTest(): void {
  launches.clear();
}
