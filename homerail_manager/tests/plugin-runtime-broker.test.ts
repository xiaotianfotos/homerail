import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  homerailPluginToolInvocationDigestInput,
  HOMERAIL_RUNTIME_BLOCKED_SECRET_ENV,
  homerailPluginRuntimeSandboxAttestationSigningInput,
  type HomerailPluginRuntimeSandboxAttestationClaimsV1,
  type HomerailPluginRuntimeSandboxAttestationV1,
  type HomerailPluginToolInvocationV1,
  type HomerailPluginRuntimeRpcRequestV1,
} from "homerail-protocol";
import { buildHrpArchive, scaffoldPluginProject, scanPluginSource, sourceFilesForPack } from "homerail-plugin-sdk";
import { closeDb } from "../src/persistence/db.js";
import { createPluginToolRequest, getPluginToolRequest } from "../src/persistence/plugin-actions.js";
import { PluginToolCapabilityTokenAuthority } from "../src/plugins/capability-token.js";
import { pluginJsonDigest } from "../src/plugins/descriptor.js";
import { installHrpArchive } from "../src/plugins/package-lifecycle.js";
import {
  PluginRuntimeBroker,
  PluginRuntimeIndeterminateFailure,
  PluginRuntimeTerminalTransportFailure,
  PluginRuntimeTransportRegistry,
  VerifiedPluginRuntimeSandboxGate,
  type PluginRuntimeTransport,
  type ResolvedPluginRuntimeV1,
} from "../src/plugins/runtime-broker.js";

describe("plugin Runtime RPC broker", () => {
  let previousHome: string | undefined;
  let home: string;
  let source: string;

  beforeEach(() => {
    closeDb();
    previousHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-runtime-home-"));
    source = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-runtime-source-"));
    process.env.HOMERAIL_HOME = home;
    scaffoldPluginProject(source, "com.example.runtime");
    installHrpArchive(buildHrpArchive(sourceFilesForPack(scanPluginSource(source))).archive);
  });

  afterEach(() => {
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  });

  function invocation(suffix: string): HomerailPluginToolInvocationV1 {
    const value: HomerailPluginToolInvocationV1 = {
      tool_bus_version: 1,
      request_id: `runtime_request_${suffix}`,
      idempotency_key: `runtime_idempotency_${suffix}`,
      request_digest: "0".repeat(64),
      invoked_at: "2026-07-11T17:00:00.000Z",
      deadline_at: "2026-07-11T17:10:00.000Z",
      source: {
        type: "ui_action",
        target: {
          document_id: "document-runtime",
          document_revision: 1,
          node_id: "com.example.runtime:node-one",
          node_revision: 1,
          action_id: "execute",
          action_intent: "com.example.runtime.execute",
        },
        action: { local_id: "execute", qualified_id: "com.example.runtime:execute" },
        input_digest: pluginJsonDigest({}),
      },
      tool: {
        local_id: "execute_tool",
        qualified_id: "com.example.runtime:execute_tool",
        wire_id: "p_0123456789_execute_tool",
        handler: { type: "runtime", method: "execute" },
      },
      binding: {
        plugin_id: "com.example.runtime",
        plugin_version: "0.1.0",
        manifest_digest: "a".repeat(64),
        package_digest: "b".repeat(64),
        context_digest: "c".repeat(64),
        registry_revision: 3,
        permission_revision: 0,
      },
      policy: {
        effect: "external",
        permissions: [],
        effective_grants: [],
        confirmation: "never",
        confirmation_required: false,
      },
      arguments: { operation: suffix },
    };
    value.request_digest = pluginJsonDigest(homerailPluginToolInvocationDigestInput(value));
    createPluginToolRequest({ invocation: value, policy_digest: "d".repeat(64), status: "authorized" });
    return value;
  }

  function resolved(trust: ResolvedPluginRuntimeV1["trust"] = "trusted_builtin"): ResolvedPluginRuntimeV1 {
    return {
      plugin_id: "com.example.runtime",
      plugin_version: "0.1.0",
      package_digest: "b".repeat(64),
      manifest_digest: "a".repeat(64),
      registry_revision: 3,
      source: trust === "trusted_builtin" ? "builtin" : "installed",
      trust,
    };
  }

  function authorization(
    authority: PluginToolCapabilityTokenAuthority,
    request: HomerailPluginToolInvocationV1,
  ) {
    const issued = authority.issue({
      invocation: request,
      now: new Date("2026-07-11T17:01:00.000Z"),
      ttl_ms: 120_000,
    });
    return {
      token: issued.token,
      value: {
        authorization_version: 1 as const,
        invocation: request,
        capability: issued.claims,
      },
    };
  }

  it("returns a validated correlated result and consumes the capability", async () => {
    const authority = new PluginToolCapabilityTokenAuthority(Buffer.alloc(32, 0x51));
    const request = invocation("success");
    const auth = authorization(authority, request);
    let captured: HomerailPluginRuntimeRpcRequestV1 | undefined;
    const transport: PluginRuntimeTransport = {
      request: async (rpc) => {
        captured = rpc;
        if (rpc.method !== "execute") throw new Error("unexpected method");
        return {
          runtime_rpc_version: 1,
          message_type: "result",
          method: "execute",
          rpc_id: rpc.rpc_id,
          completed_at: "2026-07-11T17:01:02.000Z",
          request_id: request.request_id,
          request_digest: request.request_digest,
          binding: request.binding,
          output: { type: "domain_output", output: { ok: true } },
          logs: [{ sequence: 0, timestamp: "2026-07-11T17:01:01.500Z", level: "info", message: "done" }],
          artifacts: [],
        };
      },
    };
    const transports = new PluginRuntimeTransportRegistry();
    transports.register("com.example.runtime", "0.1.0", transport);
    const broker = new PluginRuntimeBroker({
      tokens: authority,
      transports,
      resolve_runtime: () => resolved(),
    });

    await expect(broker.execute({
      authorization: auth.value,
      capability_token: auth.token,
      now: new Date("2026-07-11T17:01:01.000Z"),
    })).resolves.toMatchObject({ output: { type: "domain_output", output: { ok: true } } });
    expect(captured).toMatchObject({ method: "execute", params: { authorization: auth.value } });
    await expect(broker.execute({
      authorization: auth.value,
      capability_token: auth.token,
      now: new Date("2026-07-11T17:01:03.000Z"),
    })).rejects.toThrow(/already consumed/);
  });

  it("contains Runtime crashes and timeouts without changing Tool state", async () => {
    const authority = new PluginToolCapabilityTokenAuthority(Buffer.alloc(32, 0x52));
    const transports = new PluginRuntimeTransportRegistry();
    transports.register("com.example.runtime", "0.1.0", {
      request: async (rpc) => {
        if (rpc.method !== "execute") throw new Error("unexpected method");
        const operation = rpc.params.authorization.invocation.arguments.operation;
        if (operation === "crash") throw new Error("runtime crashed");
        return await new Promise(() => undefined);
      },
    });
    const broker = new PluginRuntimeBroker({
      tokens: authority,
      transports,
      resolve_runtime: () => resolved(),
      timeout_ms: 10,
    });

    for (const operation of ["crash", "timeout"] as const) {
      const request = invocation(operation);
      const auth = authorization(authority, request);
      await expect(broker.execute({
        authorization: auth.value,
        capability_token: auth.token,
        now: new Date("2026-07-11T17:01:01.000Z"),
      })).rejects.toMatchObject({
        name: PluginRuntimeIndeterminateFailure.name,
        code: "runtime_indeterminate",
      });
      expect(getPluginToolRequest(request.request_id)).toMatchObject({ status: "authorized" });
    }
  });

  it("evicts only a terminal Runtime transport so the next request lazy-launches a replacement", async () => {
    const authority = new PluginToolCapabilityTokenAuthority(Buffer.alloc(32, 0x5a));
    const request = invocation("terminal-replacement");
    const transports = new PluginRuntimeTransportRegistry();
    transports.register("com.example.runtime", "0.1.0", {
      request: async () => {
        throw new PluginRuntimeTerminalTransportFailure("container was killed after exec timeout");
      },
    });
    let replacements = 0;
    const broker = new PluginRuntimeBroker({
      tokens: authority,
      transports,
      resolve_runtime: () => resolved(),
      ensure_transport: async () => {
        replacements += 1;
        transports.register("com.example.runtime", "0.1.0", {
          request: async (rpc) => ({
            runtime_rpc_version: 1,
            message_type: "result",
            method: "health",
            rpc_id: rpc.rpc_id,
            completed_at: new Date().toISOString(),
            binding: request.binding,
            status: "ready",
            runtime_api: 1,
            started_at: new Date(Date.now() - 1_000).toISOString(),
            active_requests: 0,
            logs: [],
            artifacts: [],
          }),
        });
      },
    });

    await expect(broker.health({ binding: request.binding })).rejects.toThrow(/killed after exec timeout/);
    expect(replacements).toBe(0);
    await expect(broker.health({ binding: request.binding })).resolves.toMatchObject({ status: "ready" });
    expect(replacements).toBe(1);
  });

  it("blocks an installed executable runtime when no verified M6 sandbox gate is supplied", async () => {
    const authority = new PluginToolCapabilityTokenAuthority(Buffer.alloc(32, 0x53));
    const request = invocation("sandbox");
    const auth = authorization(authority, request);
    const transports = new PluginRuntimeTransportRegistry();
    transports.register("com.example.runtime", "0.1.0", { request: async () => ({}) });
    const broker = new PluginRuntimeBroker({
      tokens: authority,
      transports,
      resolve_runtime: () => resolved("sandboxed_runtime"),
    });
    await expect(broker.execute({
      authorization: auth.value,
      capability_token: auth.token,
      now: new Date("2026-07-11T17:01:01.000Z"),
    })).rejects.toThrow(/verified M6 sandbox capability/);
  });

  it("accepts only a Node-signed sandbox attestation bound to launch isolation and exact grants", async () => {
    const request = invocation("verified-sandbox");
    const now = new Date("2026-07-11T17:01:00.000Z");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const baseClaims: HomerailPluginRuntimeSandboxAttestationClaimsV1 = {
      sandbox_attestation_version: 1,
      issuer: "homerail-node",
      audience: "homerail-manager",
      key_id: "node-key-one",
      attestation_id: "attestation-one",
      runtime_instance_id: "runtime-instance-one",
      node_id: "node-one",
      container_id: "container-one",
      image_digest: `sha256:${"d".repeat(64)}`,
      measurement_digest: "e".repeat(64),
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 60_000).toISOString(),
      binding: request.binding,
      entrypoint: { file: "runtime/index.js", args: ["--stdio"] },
      isolation: {
        profile_id: "homerail.plugin-runtime.v1",
        uid: 65532,
        gid: 65532,
        no_new_privileges: true,
        read_only_rootfs: true,
        linux_capabilities: [],
        seccomp_profile_digest: "f".repeat(64),
        mounts: [{ source: `package:${request.binding.package_digest}`, target: "/opt/homerail/plugin", mode: "ro" }],
        tmpfs: [{ target: "/tmp", size_bytes: 67_108_864, noexec: true, nosuid: true, nodev: true }],
        resources: { pids_limit: 64, memory_bytes: 536_870_912, memory_swap_bytes: 536_870_912, nano_cpus: 1_000_000_000 },
        network: { mode: "none", hosts: [], network_name: null, internal: true },
        gpu: { enabled: false, devices: [] },
        devices: [],
        blocked_secret_env: [...HOMERAIL_RUNTIME_BLOCKED_SECRET_ENV],
      },
      effective_grants: [],
    };
    const signed = (claims: HomerailPluginRuntimeSandboxAttestationClaimsV1): HomerailPluginRuntimeSandboxAttestationV1 => ({
      claims,
      signature: sign(
        null,
        Buffer.from(homerailPluginRuntimeSandboxAttestationSigningInput(claims), "utf8"),
        privateKey,
      ).toString("base64url"),
    });
    const gate = new VerifiedPluginRuntimeSandboxGate({
      trusted_nodes: [{ key_id: "node-key-one", node_id: "node-one", public_key: publicKey }],
      allowed_profile_ids: new Set(["homerail.plugin-runtime.v1"]),
    });
    const sandboxRuntime = {
      ...resolved("sandboxed_runtime"),
      entrypoint: { file: "runtime/index.js", args: ["--stdio"] },
      image_digest: `sha256:${"d".repeat(64)}`,
    };
    expect(() => gate.assertAllowed({
      runtime: sandboxRuntime,
      binding: request.binding,
      policy: request.policy,
      attestation: signed(baseClaims),
      transport_identity: { node_id: "node-one", runtime_instance_id: "runtime-instance-one", container_id: "container-one", measurement_digest: "e".repeat(64), image_digest: `sha256:${"d".repeat(64)}` },
      now,
    })).not.toThrow();
    expect(() => gate.assertAllowed({
      runtime: sandboxRuntime,
      binding: request.binding,
      policy: request.policy,
      attestation: signed(baseClaims),
      transport_identity: { node_id: "node-one", runtime_instance_id: "other-instance", container_id: "container-one", measurement_digest: "e".repeat(64), image_digest: `sha256:${"d".repeat(64)}` },
      now,
    })).toThrow(/attested runtime instance/);

    const authority = new PluginToolCapabilityTokenAuthority(Buffer.alloc(32, 0x5a));
    const auth = authorization(authority, request);
    const transports = new PluginRuntimeTransportRegistry();
    transports.register("com.example.runtime", "0.1.0", {
      request: async (rpc) => {
        if (rpc.method !== "execute") throw new Error("unexpected method");
        return {
          runtime_rpc_version: 1,
          message_type: "result",
          method: "execute",
          rpc_id: rpc.rpc_id,
          completed_at: "2026-07-11T17:01:02.000Z",
          request_id: request.request_id,
          request_digest: request.request_digest,
          binding: request.binding,
          output: { type: "domain_output", output: { isolated: true } },
          logs: [],
          artifacts: [],
        };
      },
    }, {
      sandbox_attestation: signed(baseClaims),
      sandbox_identity: { node_id: "node-one", runtime_instance_id: "runtime-instance-one", container_id: "container-one", measurement_digest: "e".repeat(64), image_digest: `sha256:${"d".repeat(64)}` },
    });
    const broker = new PluginRuntimeBroker({
      tokens: authority,
      transports,
      sandbox: gate,
      resolve_runtime: () => sandboxRuntime,
    });
    await expect(broker.execute({
      authorization: auth.value,
      capability_token: auth.token,
      now,
    })).resolves.toMatchObject({ output: { output: { isolated: true } } });

    expect(() => gate.assertAllowed({
      runtime: sandboxRuntime,
      binding: request.binding,
      policy: request.policy,
      attestation: signed({
        ...baseClaims,
        entrypoint: { file: "runtime/other.js", args: [] },
      }),
      transport_identity: { node_id: "node-one", runtime_instance_id: "runtime-instance-one", container_id: "container-one", measurement_digest: "e".repeat(64), image_digest: `sha256:${"d".repeat(64)}` },
      now,
    })).toThrow(/entrypoint/);
    expect(() => gate.assertAllowed({
      runtime: sandboxRuntime,
      binding: request.binding,
      policy: request.policy,
      attestation: signed({
        ...baseClaims,
        isolation: {
          ...baseClaims.isolation,
          network: { mode: "brokered", hosts: ["example.com"], network_name: "homerail-plugin-broker-test", internal: true },
        },
      }),
      transport_identity: { node_id: "node-one", runtime_instance_id: "runtime-instance-one", container_id: "container-one", measurement_digest: "e".repeat(64), image_digest: `sha256:${"d".repeat(64)}` },
      now,
    })).toThrow(/network/);
    const tampered = signed(baseClaims);
    tampered.signature = `${tampered.signature.startsWith("A") ? "B" : "A"}${tampered.signature.slice(1)}`;
    expect(() => gate.assertAllowed({
      runtime: sandboxRuntime,
      binding: request.binding,
      policy: request.policy,
      attestation: tampered,
      transport_identity: { node_id: "node-one", runtime_instance_id: "runtime-instance-one", container_id: "container-one", measurement_digest: "e".repeat(64), image_digest: `sha256:${"d".repeat(64)}` },
      now,
    })).toThrow(/signature/);
  });

  it("keys attested transports by complete binding and exact effective grants", () => {
    const firstInvocation = invocation("binding-first");
    const first = firstInvocation.binding;
    const second = {
      ...first,
      context_digest: "9".repeat(64),
      permission_revision: first.permission_revision + 1,
    };
    const stale = { ...first, registry_revision: first.registry_revision + 1 };
    const transports = new PluginRuntimeTransportRegistry();
    const transportOne = { request: async () => ({ first: true }) };
    const transportTwo = { request: async () => ({ second: true }) };
    const transportThree = { request: async () => ({ third: true }) };
    const registration = (
      binding: typeof first,
      suffix: string,
      effective_grants: Array<{ permission: "artifact.write" }> = [],
    ) => ({
      sandbox_attestation: {
        claims: {
          sandbox_attestation_version: 1 as const,
          issuer: "homerail-node" as const,
          audience: "homerail-manager" as const,
          key_id: "node-key-binding",
          attestation_id: `attestation-${suffix}`,
          runtime_instance_id: `runtime-${suffix}`,
          node_id: "node-binding",
          container_id: `container-${suffix}`,
          image_digest: `sha256:${"d".repeat(64)}`,
          measurement_digest: "e".repeat(64),
          issued_at: "2026-07-11T17:00:00.000Z",
          expires_at: "2026-07-11T17:05:00.000Z",
          binding,
          entrypoint: { file: "runtime/index.js", args: [] },
          isolation: {
            profile_id: "homerail.plugin-runtime.v1",
            uid: 65532,
            gid: 65532,
            no_new_privileges: true as const,
            read_only_rootfs: true as const,
            linux_capabilities: [],
            seccomp_profile_digest: "f".repeat(64),
            mounts: [],
            tmpfs: [],
            resources: { pids_limit: 64, memory_bytes: 536_870_912, memory_swap_bytes: 536_870_912, nano_cpus: 1_000_000_000 },
            network: { mode: "none" as const, hosts: [], network_name: null, internal: true as const },
            gpu: { enabled: false, devices: [] },
            devices: [],
            blocked_secret_env: [...HOMERAIL_RUNTIME_BLOCKED_SECRET_ENV],
          },
          effective_grants,
        },
        signature: "A".repeat(86),
      },
      sandbox_identity: {
        node_id: "node-binding",
        runtime_instance_id: `runtime-${suffix}`,
        container_id: `container-${suffix}`,
        measurement_digest: "e".repeat(64),
        image_digest: `sha256:${"d".repeat(64)}`,
      },
    });
    transports.register(first.plugin_id, first.plugin_version, transportOne, registration(first, "first"));
    transports.register(second.plugin_id, second.plugin_version, transportTwo, registration(second, "second"));
    transports.register(first.plugin_id, first.plugin_version, transportThree, registration(
      first,
      "third",
      [{ permission: "artifact.write" }],
    ));
    expect(transports.resolveRegistration(first, firstInvocation.policy)?.transport).toBe(transportOne);
    expect(transports.resolveRegistration(first, {
      ...firstInvocation.policy,
      permissions: ["artifact.write"],
      effective_grants: [{ permission: "artifact.write" }],
    })?.transport).toBe(transportThree);
    expect(() => transports.resolveRegistration(first)).toThrow(/ambiguous without exact policy grants/);
    expect(transports.resolveRegistration(second)?.transport).toBe(transportTwo);
    expect(transports.resolveRegistration(stale)).toBeUndefined();
  });

  it("correlates cancel and health through the exact bound Runtime", async () => {
    const authority = new PluginToolCapabilityTokenAuthority(Buffer.alloc(32, 0x54));
    const request = invocation("lifecycle");
    const seen: HomerailPluginRuntimeRpcRequestV1[] = [];
    const transports = new PluginRuntimeTransportRegistry();
    transports.register("com.example.runtime", "0.1.0", {
      request: async (rpc) => {
        seen.push(rpc);
        if (rpc.method === "cancel") {
          return {
            runtime_rpc_version: 1,
            message_type: "result",
            method: "cancel",
            rpc_id: rpc.rpc_id,
            completed_at: "2026-07-11T17:01:02.000Z",
            request_id: request.request_id,
            request_digest: request.request_digest,
            status: "accepted",
            logs: [],
            artifacts: [],
          };
        }
        if (rpc.method === "health") {
          return {
            runtime_rpc_version: 1,
            message_type: "result",
            method: "health",
            rpc_id: rpc.rpc_id,
            completed_at: "2026-07-11T17:01:02.000Z",
            binding: request.binding,
            status: "ready",
            runtime_api: 1,
            started_at: "2026-07-11T17:00:00.000Z",
            active_requests: 1,
            logs: [],
            artifacts: [],
          };
        }
        throw new Error("unexpected method");
      },
    });
    const broker = new PluginRuntimeBroker({
      tokens: authority,
      transports,
      resolve_runtime: () => resolved(),
    });

    await expect(broker.cancel({
      request_id: request.request_id,
      request_digest: request.request_digest,
      reason: "user",
      now: new Date("2026-07-11T17:01:01.000Z"),
    })).resolves.toMatchObject({ method: "cancel", status: "accepted" });
    await expect(broker.health({
      binding: request.binding,
      now: new Date("2026-07-11T17:01:01.000Z"),
    })).resolves.toMatchObject({ method: "health", status: "ready", binding: request.binding });
    expect(seen.map((rpc) => rpc.method)).toEqual(["cancel", "health"]);

    await expect(broker.cancel({
      request_id: request.request_id,
      request_digest: "f".repeat(64),
      reason: "shutdown",
    })).rejects.toThrow(/cancel binding is invalid/);
    expect(seen).toHaveLength(2);
  });

  it("bounds lifecycle RPC failures and applies the sandbox gate before dispatch", async () => {
    const authority = new PluginToolCapabilityTokenAuthority(Buffer.alloc(32, 0x55));
    const request = invocation("lifecycle-timeout");
    let dispatches = 0;
    const transports = new PluginRuntimeTransportRegistry();
    transports.register("com.example.runtime", "0.1.0", {
      request: async () => {
        dispatches += 1;
        return await new Promise(() => undefined);
      },
    });
    const timed = new PluginRuntimeBroker({
      tokens: authority,
      transports,
      resolve_runtime: () => resolved(),
      timeout_ms: 5,
    });
    await expect(timed.cancel({
      request_id: request.request_id,
      request_digest: request.request_digest,
      reason: "deadline",
    })).rejects.toThrow(/deadline exceeded/);
    await expect(timed.health({ binding: request.binding })).rejects.toThrow(/deadline exceeded/);
    expect(dispatches).toBe(2);

    const blocked = new PluginRuntimeBroker({
      tokens: authority,
      transports,
      resolve_runtime: () => resolved("sandboxed_runtime"),
    });
    await expect(blocked.health({ binding: request.binding }))
      .rejects.toThrow(/verified M6 sandbox capability/);
    expect(dispatches).toBe(2);
  });
});
