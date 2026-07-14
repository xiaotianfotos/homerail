/**
 * Node-signed launch and isolation attestation for executable Plugin Runtimes.
 * @version 0.1.0
 */

import { stableStringify } from "../codec.js";
import {
  HomerailPluginPermission,
  type HomerailPluginEffectivePermissionGrantV1,
  type HomerailPluginToolBindingV1,
} from "./types.js";

export const HOMERAIL_RUNTIME_SANDBOX_ATTESTATION_VERSION = 1 as const;
export const HOMERAIL_RUNTIME_SANDBOX_ATTESTATION_MAX_TTL_MS = 10 * 60 * 1000;
export const HOMERAIL_RUNTIME_BLOCKED_SECRET_ENV = [
  "HOMERAIL_MANAGER_ADMIN_TOKEN",
  "HOMERAIL_PLUGIN_CAPABILITY_SECRET",
] as const;

export interface HomerailPluginRuntimeSandboxIsolationV1 {
  profile_id: string;
  uid: number;
  gid: number;
  no_new_privileges: true;
  read_only_rootfs: true;
  linux_capabilities: string[];
  seccomp_profile_digest: string;
  mounts: Array<{
    source: string;
    target: string;
    mode: "ro" | "rw";
  }>;
  tmpfs: Array<{
    target: string;
    size_bytes: number;
    noexec: true;
    nosuid: true;
    nodev: true;
  }>;
  resources: {
    pids_limit: number;
    memory_bytes: number;
    memory_swap_bytes: number;
    nano_cpus: number;
  };
  network: {
    mode: "none" | "brokered";
    hosts: string[];
    network_name: string | null;
    internal: true;
  };
  gpu: {
    enabled: boolean;
    devices: string[];
  };
  devices: string[];
  blocked_secret_env: string[];
}

/** Provider-owned Docker inspect measurement; callers never supply this object. */
export interface HomerailPluginRuntimeContainerMeasurementV1 {
  measurement_version: 1;
  container_id: string;
  image_digest: string;
  command: string[];
  env_names: string[];
  isolation: HomerailPluginRuntimeSandboxIsolationV1;
}

export interface HomerailPluginRuntimeSandboxAttestationClaimsV1 {
  sandbox_attestation_version: 1;
  issuer: "homerail-node";
  audience: "homerail-manager";
  key_id: string;
  attestation_id: string;
  runtime_instance_id: string;
  node_id: string;
  container_id: string;
  image_digest: string;
  measurement_digest: string;
  issued_at: string;
  expires_at: string;
  binding: HomerailPluginToolBindingV1;
  entrypoint: {
    file: string;
    args: string[];
  };
  isolation: HomerailPluginRuntimeSandboxIsolationV1;
  effective_grants: HomerailPluginEffectivePermissionGrantV1[];
}

export interface HomerailPluginRuntimeSandboxAttestationV1 {
  claims: HomerailPluginRuntimeSandboxAttestationClaimsV1;
  signature: string;
}

export interface HomerailPluginRuntimeSandboxAttestationValidationResultV1 {
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
  value?: HomerailPluginRuntimeSandboxAttestationV1;
}

const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
// Ed25519 signatures are exactly 64 bytes and 86 canonical base64url chars.
const SIGNATURE = /^[A-Za-z0-9_-]{85}[AQgw]$/;
const PERMISSIONS = new Set<string>(Object.values(HomerailPluginPermission));

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalStrings(value: unknown, allowEmpty = true): value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.length)) return false;
  if (!allowEmpty && value.length === 0) return false;
  return value.every((entry, index) => index === 0 || value[index - 1]! < entry);
}

function validGrant(value: unknown): value is HomerailPluginEffectivePermissionGrantV1 {
  if (!isRecord(value)) return false;
  const allowed = ["permission", ...(value.paths !== undefined ? ["paths"] : []), ...(value.hosts !== undefined ? ["hosts"] : [])];
  if (!exactKeys(value, allowed) || typeof value.permission !== "string" || !PERMISSIONS.has(value.permission)) return false;
  if (value.paths !== undefined && !canonicalStrings(value.paths, false)) return false;
  if (value.hosts !== undefined && !canonicalStrings(value.hosts, false)) return false;
  if (value.permission === HomerailPluginPermission.NETWORK_CONNECT && !canonicalStrings(value.hosts, false)) return false;
  return true;
}

export function homerailPluginRuntimeSandboxAttestationSigningInput(
  claims: HomerailPluginRuntimeSandboxAttestationClaimsV1,
): string {
  return stableStringify(claims);
}

export function homerailPluginRuntimeContainerMeasurementDigestInput(
  measurement: HomerailPluginRuntimeContainerMeasurementV1,
): string {
  return stableStringify(measurement);
}

export function validateHomerailPluginRuntimeSandboxAttestation(
  raw: unknown,
  options: { now_ms?: number; clock_skew_ms?: number } = {},
): HomerailPluginRuntimeSandboxAttestationValidationResultV1 {
  const errors: Array<{ path: string; message: string }> = [];
  if (!isRecord(raw) || !exactKeys(raw, ["claims", "signature"])) {
    return { valid: false, errors: [{ path: "", message: "sandbox attestation must be an exact object" }] };
  }
  if (!isRecord(raw.claims) || !exactKeys(raw.claims, [
    "sandbox_attestation_version", "issuer", "audience", "key_id", "attestation_id",
    "runtime_instance_id", "node_id", "container_id", "image_digest", "measurement_digest",
    "issued_at", "expires_at", "binding",
    "entrypoint", "isolation", "effective_grants",
  ])) return { valid: false, errors: [{ path: "/claims", message: "claims must be an exact object" }] };
  const claims = raw.claims;
  if (claims.sandbox_attestation_version !== 1) errors.push({ path: "/claims/sandbox_attestation_version", message: "must be 1" });
  if (claims.issuer !== "homerail-node") errors.push({ path: "/claims/issuer", message: "invalid issuer" });
  if (claims.audience !== "homerail-manager") errors.push({ path: "/claims/audience", message: "invalid audience" });
  for (const key of ["key_id", "attestation_id", "runtime_instance_id", "node_id", "container_id"] as const) {
    if (typeof claims[key] !== "string" || !ID.test(claims[key] as string)) {
      errors.push({ path: `/claims/${key}`, message: "invalid identity" });
    }
  }
  if (typeof claims.image_digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(claims.image_digest)) {
    errors.push({ path: "/claims/image_digest", message: "invalid immutable image digest" });
  }
  if (typeof claims.measurement_digest !== "string" || !DIGEST.test(claims.measurement_digest)) {
    errors.push({ path: "/claims/measurement_digest", message: "invalid measurement digest" });
  }
  if (typeof raw.signature !== "string" || !SIGNATURE.test(raw.signature)) {
    errors.push({ path: "/signature", message: "invalid signature encoding" });
  }

  const issuedAt = typeof claims.issued_at === "string" ? Date.parse(claims.issued_at) : Number.NaN;
  const expiresAt = typeof claims.expires_at === "string" ? Date.parse(claims.expires_at) : Number.NaN;
  if (!Number.isFinite(issuedAt)) errors.push({ path: "/claims/issued_at", message: "invalid timestamp" });
  if (!Number.isFinite(expiresAt)) errors.push({ path: "/claims/expires_at", message: "invalid timestamp" });
  if (Number.isFinite(issuedAt) && Number.isFinite(expiresAt)) {
    if (expiresAt <= issuedAt || expiresAt - issuedAt > HOMERAIL_RUNTIME_SANDBOX_ATTESTATION_MAX_TTL_MS) {
      errors.push({ path: "/claims/expires_at", message: "attestation lifetime is invalid" });
    }
    const now = options.now_ms ?? Date.now();
    const skew = options.clock_skew_ms ?? 10_000;
    if (issuedAt > now + skew) errors.push({ path: "/claims/issued_at", message: "attestation was issued in the future" });
    if (expiresAt <= now - skew) errors.push({ path: "/claims/expires_at", message: "attestation has expired" });
  }

  const binding = claims.binding;
  if (!isRecord(binding) || !exactKeys(binding, [
    "plugin_id", "plugin_version", "manifest_digest", "package_digest", "context_digest",
    "registry_revision", "permission_revision",
  ])) errors.push({ path: "/claims/binding", message: "invalid exact Tool binding" });
  else {
    for (const key of ["manifest_digest", "package_digest", "context_digest"] as const) {
      if (typeof binding[key] !== "string" || !DIGEST.test(binding[key] as string)) {
        errors.push({ path: `/claims/binding/${key}`, message: "invalid digest" });
      }
    }
    if (typeof binding.plugin_id !== "string" || !binding.plugin_id.length) errors.push({ path: "/claims/binding/plugin_id", message: "invalid plugin id" });
    if (typeof binding.plugin_version !== "string" || !binding.plugin_version.length) errors.push({ path: "/claims/binding/plugin_version", message: "invalid plugin version" });
    if (!Number.isSafeInteger(binding.registry_revision) || Number(binding.registry_revision) < 0) errors.push({ path: "/claims/binding/registry_revision", message: "invalid revision" });
    if (!Number.isSafeInteger(binding.permission_revision) || Number(binding.permission_revision) < 0) errors.push({ path: "/claims/binding/permission_revision", message: "invalid revision" });
  }

  const entrypoint = claims.entrypoint;
  if (!isRecord(entrypoint) || !exactKeys(entrypoint, ["file", "args"])
    || typeof entrypoint.file !== "string" || !entrypoint.file.length || entrypoint.file.startsWith("/")
    || entrypoint.file.split("/").includes("..") || !canonicalArgumentList(entrypoint.args)) {
    errors.push({ path: "/claims/entrypoint", message: "invalid package-relative entrypoint/argv" });
  }

  const isolation = claims.isolation;
  if (!isRecord(isolation) || !exactKeys(isolation, [
    "profile_id", "uid", "gid", "no_new_privileges", "read_only_rootfs", "linux_capabilities",
    "seccomp_profile_digest", "mounts", "tmpfs", "resources", "network", "gpu", "devices", "blocked_secret_env",
  ])) errors.push({ path: "/claims/isolation", message: "invalid isolation profile" });
  else validateIsolation(isolation, errors);

  if (!Array.isArray(claims.effective_grants)
    || !claims.effective_grants.every(validGrant)
    || !claims.effective_grants.every((grant, index, grants) => index === 0 || grants[index - 1]!.permission < grant.permission)) {
    errors.push({ path: "/claims/effective_grants", message: "effective grants must be exact and canonical" });
  }
  const value = raw as unknown as HomerailPluginRuntimeSandboxAttestationV1;
  return errors.length ? { valid: false, errors } : { valid: true, errors: [], value: structuredClone(value) };
}

function canonicalArgumentList(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= 128
    && value.every((entry) => typeof entry === "string" && new TextEncoder().encode(entry).byteLength <= 4096);
}

function validateIsolation(
  isolation: Record<string, unknown>,
  errors: Array<{ path: string; message: string }>,
): void {
  if (typeof isolation.profile_id !== "string" || !ID.test(isolation.profile_id)) errors.push({ path: "/claims/isolation/profile_id", message: "invalid profile id" });
  if (!Number.isSafeInteger(isolation.uid) || Number(isolation.uid) < 1) errors.push({ path: "/claims/isolation/uid", message: "runtime UID must be non-root" });
  if (!Number.isSafeInteger(isolation.gid) || Number(isolation.gid) < 1) errors.push({ path: "/claims/isolation/gid", message: "runtime GID must be non-root" });
  if (isolation.no_new_privileges !== true) errors.push({ path: "/claims/isolation/no_new_privileges", message: "must be true" });
  if (isolation.read_only_rootfs !== true) errors.push({ path: "/claims/isolation/read_only_rootfs", message: "must be true" });
  if (!Array.isArray(isolation.linux_capabilities) || isolation.linux_capabilities.length !== 0) errors.push({ path: "/claims/isolation/linux_capabilities", message: "Linux capabilities must be empty" });
  if (typeof isolation.seccomp_profile_digest !== "string" || !DIGEST.test(isolation.seccomp_profile_digest)) errors.push({ path: "/claims/isolation/seccomp_profile_digest", message: "invalid seccomp profile digest" });
  if (!Array.isArray(isolation.mounts) || !isolation.mounts.every((mount, index, mounts) => {
    if (!isRecord(mount) || !exactKeys(mount, ["source", "target", "mode"])) return false;
    if (typeof mount.source !== "string" || !mount.source.length || typeof mount.target !== "string" || !mount.target.startsWith("/")) return false;
    if (mount.mode !== "ro" && mount.mode !== "rw") return false;
    return index === 0 || (mounts[index - 1] as Record<string, unknown>).target! < mount.target;
  })) errors.push({ path: "/claims/isolation/mounts", message: "mounts must be exact and canonical" });
  if (!Array.isArray(isolation.tmpfs) || !isolation.tmpfs.every((entry, index, entries) => {
    if (!isRecord(entry) || !exactKeys(entry, ["target", "size_bytes", "noexec", "nosuid", "nodev"])) return false;
    return typeof entry.target === "string" && entry.target.startsWith("/")
      && Number.isSafeInteger(entry.size_bytes) && Number(entry.size_bytes) >= 4096
      && entry.noexec === true && entry.nosuid === true && entry.nodev === true
      && (index === 0 || (entries[index - 1] as Record<string, unknown>).target! < entry.target);
  })) errors.push({ path: "/claims/isolation/tmpfs", message: "tmpfs mounts must be exact and canonical" });
  if (!isRecord(isolation.resources) || !exactKeys(isolation.resources, [
    "pids_limit", "memory_bytes", "memory_swap_bytes", "nano_cpus",
  ]) || !Number.isSafeInteger(isolation.resources.pids_limit) || Number(isolation.resources.pids_limit) < 1
    || !Number.isSafeInteger(isolation.resources.memory_bytes) || Number(isolation.resources.memory_bytes) < 16 * 1024 * 1024
    || isolation.resources.memory_swap_bytes !== isolation.resources.memory_bytes
    || !Number.isSafeInteger(isolation.resources.nano_cpus) || Number(isolation.resources.nano_cpus) < 1_000_000) {
    errors.push({ path: "/claims/isolation/resources", message: "invalid fixed PID/memory/CPU resource limits" });
  }
  if (!isRecord(isolation.network) || !exactKeys(isolation.network, ["mode", "hosts", "network_name", "internal"])
    || (isolation.network.mode !== "none" && isolation.network.mode !== "brokered")
    || !canonicalStrings(isolation.network.hosts)
    || isolation.network.internal !== true
    || (isolation.network.mode === "none" && isolation.network.hosts.length !== 0)
    || (isolation.network.mode === "none" && isolation.network.network_name !== null)
    || (isolation.network.mode === "brokered" && isolation.network.hosts.length === 0)
    || (isolation.network.mode === "brokered" && (typeof isolation.network.network_name !== "string" || !ID.test(isolation.network.network_name)))) {
    errors.push({ path: "/claims/isolation/network", message: "invalid brokered network scope" });
  }
  if (!isRecord(isolation.gpu) || !exactKeys(isolation.gpu, ["enabled", "devices"])
    || typeof isolation.gpu.enabled !== "boolean" || !canonicalStrings(isolation.gpu.devices)
    || (!isolation.gpu.enabled && isolation.gpu.devices.length !== 0)) {
    errors.push({ path: "/claims/isolation/gpu", message: "invalid GPU scope" });
  }
  if (!canonicalStrings(isolation.devices)) errors.push({ path: "/claims/isolation/devices", message: "invalid device scope" });
  if (!Array.isArray(isolation.blocked_secret_env)
    || stableStringify(isolation.blocked_secret_env) !== stableStringify(HOMERAIL_RUNTIME_BLOCKED_SECRET_ENV)) {
    errors.push({ path: "/claims/isolation/blocked_secret_env", message: "Manager secret environment must be blocked" });
  }
}
