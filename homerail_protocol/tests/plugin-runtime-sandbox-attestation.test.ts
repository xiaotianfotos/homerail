import { describe, expect, it } from "vitest";
import {
  HOMERAIL_RUNTIME_BLOCKED_SECRET_ENV,
  homerailPluginRuntimeSandboxAttestationSigningInput,
  validateHomerailPluginRuntimeSandboxAttestation,
  type HomerailPluginRuntimeSandboxAttestationV1,
} from "../src/index.js";

describe("Plugin Runtime sandbox attestation protocol", () => {
  const now = Date.parse("2026-07-12T10:00:00.000Z");

  function attestation(): HomerailPluginRuntimeSandboxAttestationV1 {
    return {
      claims: {
        sandbox_attestation_version: 1,
        issuer: "homerail-node",
        audience: "homerail-manager",
        key_id: "node-key-one",
        attestation_id: "attestation-one",
        runtime_instance_id: "runtime-one",
        node_id: "node-one",
        container_id: "container-one",
        image_digest: `sha256:${"d".repeat(64)}`,
        measurement_digest: "e".repeat(64),
        issued_at: "2026-07-12T10:00:00.000Z",
        expires_at: "2026-07-12T10:01:00.000Z",
        binding: {
          plugin_id: "com.example.runtime",
          plugin_version: "1.0.0",
          manifest_digest: "a".repeat(64),
          package_digest: "b".repeat(64),
          context_digest: "c".repeat(64),
          registry_revision: 7,
          permission_revision: 4,
        },
        entrypoint: { file: "runtime/index.js", args: ["--stdio"] },
        isolation: {
          profile_id: "homerail.plugin-runtime.v1",
          uid: 65532,
          gid: 65532,
          no_new_privileges: true,
          read_only_rootfs: true,
          linux_capabilities: [],
          seccomp_profile_digest: "f".repeat(64),
          mounts: [{ source: "package:runtime", target: "/opt/homerail/plugin", mode: "ro" }],
          tmpfs: [{ target: "/tmp", size_bytes: 67_108_864, noexec: true, nosuid: true, nodev: true }],
          resources: { pids_limit: 64, memory_bytes: 536_870_912, memory_swap_bytes: 536_870_912, nano_cpus: 1_000_000_000 },
          network: { mode: "none", hosts: [], network_name: null, internal: true },
          gpu: { enabled: false, devices: [] },
          devices: [],
          blocked_secret_env: [...HOMERAIL_RUNTIME_BLOCKED_SECRET_ENV],
        },
        effective_grants: [],
      },
      signature: "A".repeat(86),
    };
  }

  it("accepts an exact non-root, no-secret, canonical launch claim", () => {
    const value = attestation();
    expect(validateHomerailPluginRuntimeSandboxAttestation(value, { now_ms: now }))
      .toMatchObject({ valid: true, errors: [] });
    expect(homerailPluginRuntimeSandboxAttestationSigningInput(value.claims))
      .toContain('"permission_revision":4');
  });

  it("rejects root, writable-root, secret, network, expiry, and extension drift", () => {
    const value = attestation();
    const unsafe = structuredClone(value);
    unsafe.claims.isolation.uid = 0;
    unsafe.claims.isolation.read_only_rootfs = false as true;
    unsafe.claims.isolation.blocked_secret_env = ["HOMERAIL_MANAGER_ADMIN_TOKEN"];
    unsafe.claims.isolation.network = {
      mode: "none", hosts: ["example.com"], network_name: null, internal: true,
    };
    const paths = validateHomerailPluginRuntimeSandboxAttestation(unsafe, { now_ms: now })
      .errors.map((error) => error.path);
    expect(paths).toEqual(expect.arrayContaining([
      "/claims/isolation/uid",
      "/claims/isolation/read_only_rootfs",
      "/claims/isolation/blocked_secret_env",
      "/claims/isolation/network",
    ]));
    expect(validateHomerailPluginRuntimeSandboxAttestation(value, {
      now_ms: Date.parse("2026-07-12T10:03:00.000Z"),
      clock_skew_ms: 0,
    }).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "/claims/expires_at" }),
    ]));
    expect(validateHomerailPluginRuntimeSandboxAttestation({ ...value, extra: true }, { now_ms: now }).valid)
      .toBe(false);
  });
});
