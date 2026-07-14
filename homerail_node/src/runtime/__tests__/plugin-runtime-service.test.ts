import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  stableStringify,
  type HomerailPluginAuthorizedToolInvocationV1,
  type HomerailPluginRuntimeRpcRequestV1,
  type HomerailPluginToolBindingV1,
} from "homerail-protocol";
import { DockerCliProvider } from "../../providers/docker-cli-provider.js";
import { MockProvider } from "../../providers/mock-provider.js";
import type { ExecResult } from "../../providers/types.js";
import { NodeRuntimeAttestationAuthority } from "../../security/runtime-attestation-key.js";
import { PluginRuntimeService, type PluginRuntimeLaunchSpecV1 } from "../plugin-runtime-service.js";
import { PluginRuntimeBrokerCapabilityRegistry } from "../resource-broker-registry.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const fixtureRuntime = path.join(repoRoot, "plugins/examples/video-cover/runtime/fake-gpu-runtime.mjs");
const seccompProfile = path.join(repoRoot, "homerail_node/src/runtime/plugin-runtime-seccomp.json");
const image = "homerail-plugin-runtime:m6";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    makeTreeWritable(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeTreeWritable(root: string): void {
  if (!fs.existsSync(root)) return;
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory()) return;
  fs.chmodSync(root, 0o700);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) makeTreeWritable(path.join(root, entry.name));
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function temporary(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `homerail-${label}-`));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function packageFixture(root: string, pluginId = "com.homerail.video-cover"): { path: string; payload_digest: string } {
  const packagePath = path.join(root, "package");
  fs.mkdirSync(path.join(packagePath, "runtime"), { recursive: true, mode: 0o700 });
  const runtime = fs.readFileSync(fixtureRuntime);
  fs.writeFileSync(path.join(packagePath, "runtime/fake-gpu-runtime.mjs"), runtime, { mode: 0o600 });
  const files = [{
    path: "runtime/fake-gpu-runtime.mjs",
    sha256: sha256(runtime),
    size: runtime.byteLength,
  }];
  const unsigned = {
    lock_version: 1,
    manifest: "homerail.plugin.json",
    plugin: { id: pluginId, version: "1.0.0" },
    manifest_sha256: "a".repeat(64),
    files,
  };
  const payloadDigest = sha256(`${stableStringify(unsigned)}\n`);
  fs.writeFileSync(path.join(packagePath, "homerail.lock.json"), `${stableStringify({
    ...unsigned,
    payload_digest: payloadDigest,
  })}\n`, { mode: 0o600 });
  return { path: packagePath, payload_digest: payloadDigest };
}

function binding(): HomerailPluginToolBindingV1 {
  return {
    plugin_id: "com.homerail.video-cover",
    plugin_version: "1.0.0",
    manifest_digest: "a".repeat(64),
    package_digest: "b".repeat(64),
    context_digest: "c".repeat(64),
    registry_revision: 1,
    permission_revision: 1,
  };
}

function authorization(input: {
  request_id: string;
  request_digest?: string;
  artifact?: boolean;
  now?: Date;
}): HomerailPluginAuthorizedToolInvocationV1 {
  const now = input.now ?? new Date();
  const requestDigest = input.request_digest ?? sha256(input.request_id);
  const permissions = input.artifact ? ["artifact.write" as const] : [];
  const effectiveGrants = input.artifact ? [{ permission: "artifact.write" as const }] : [];
  const invocation = {
    tool_bus_version: 1 as const,
    request_id: input.request_id,
    idempotency_key: `idem_${input.request_id}`,
    request_digest: requestDigest,
    invoked_at: new Date(now.getTime() - 1_000).toISOString(),
    deadline_at: new Date(now.getTime() + 5 * 60_000).toISOString(),
    source: {
      type: "agent" as const,
      call_id: `call_${input.request_id}`,
      modality: "text" as const,
      scope: { type: "project" as const, id: "project-runtime-test" },
      target: { document_id: "document-runtime-test", base_revision: 0 },
    },
    tool: {
      local_id: "generate_cover",
      qualified_id: "com.homerail.video-cover:generate_cover",
      wire_id: "videoCoverGenerate",
      handler: { type: "runtime" as const, method: "generate_video_cover" },
    },
    binding: binding(),
    policy: {
      effect: "write" as const,
      permissions,
      effective_grants: effectiveGrants,
      confirmation: "never" as const,
      confirmation_required: false,
    },
    arguments: { prompt: "A blue rail horizon", width: 16, height: 16, style: "minimal" },
  };
  return {
    authorization_version: 1,
    invocation,
    capability: {
      capability_version: 1,
      capability_id: `cap_${input.request_id}`,
      audience: "homerail.plugin-runtime",
      scope: "plugin.tool.execute",
      nonce: `nonce_${input.request_id}`,
      single_use: true,
      request_id: input.request_id,
      request_digest: requestDigest,
      binding: binding(),
      effect: "write",
      permissions,
      effective_grants: effectiveGrants,
      issued_at: new Date(now.getTime() - 500).toISOString(),
      expires_at: new Date(now.getTime() + 60_000).toISOString(),
    },
  };
}

function request(method: "prepare" | "execute", auth: HomerailPluginAuthorizedToolInvocationV1): HomerailPluginRuntimeRpcRequestV1 {
  return {
    runtime_rpc_version: 1,
    message_type: "request",
    method,
    rpc_id: `rpc_${method}_${auth.invocation.request_id}`,
    sent_at: new Date().toISOString(),
    params: { authorization: auth },
  };
}

function launchSpec(pkg: ReturnType<typeof packageFixture>, imageDigest: string, artifact = false): PluginRuntimeLaunchSpecV1 {
  return {
    runtime_launch_version: 1,
    runtime_instance_id: "runtime-video-cover-0001",
    image,
    image_digest: imageDigest,
    package_path: pkg.path,
    package_payload_digest: pkg.payload_digest,
    binding: binding(),
    entrypoint: { file: "runtime/fake-gpu-runtime.mjs", args: ["--stdio"] },
    effective_grants: artifact ? [{ permission: "artifact.write" }] : [],
  };
}

class ScriptedProvider extends MockProvider {
  calls = 0;

  override async execInput(_id: string, _cmd: string[], input: string): Promise<ExecResult> {
    this.calls += 1;
    const rpc = JSON.parse(input) as Extract<HomerailPluginRuntimeRpcRequestV1, { method: "execute" }>;
    const invocation = rpc.params.authorization.invocation;
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        runtime_rpc_version: 1,
        message_type: "result",
        method: "execute",
        rpc_id: rpc.rpc_id,
        completed_at: new Date().toISOString(),
        request_id: invocation.request_id,
        request_digest: invocation.request_digest,
        binding: invocation.binding,
        output: { type: "domain_output", output: { ok: true } },
        logs: [],
        artifacts: [],
      }),
      stderr: "",
    };
  }
}

function service(
  root: string,
  provider: MockProvider,
  pkgRoot: string,
  imageDigest: string,
  brokers?: PluginRuntimeBrokerCapabilityRegistry,
  execTimeoutMs?: number,
): PluginRuntimeService {
  return new PluginRuntimeService({
    node_id: "node-runtime-test",
    provider,
    authority: new NodeRuntimeAttestationAuthority({
      node_id: "node-runtime-test",
      key_file: path.join(root, "keys/node.ed25519.pem"),
    }),
    data_root: path.join(root, "state"),
    package_roots: [pkgRoot],
    image_allowlist: { [image]: imageDigest },
    seccomp_profile: seccompProfile,
    ...(brokers ? { broker_registry: brokers } : {}),
    ...(execTimeoutMs ? { exec_timeout_ms: execTimeoutMs } : {}),
  });
}

describe("PluginRuntimeService persistence and idempotency", () => {
  it.each([
    { permission: "secret.use" as const, paths: ["/secrets/video-api"] },
    { permission: "workspace.read" as const, paths: ["/workspace/input.mp4"] },
    { permission: "plugin_data.write" as const, paths: ["/covers"] },
    { permission: "network.connect" as const, hosts: ["api.example.com:443"] },
  ])("denies $permission at launch when no exact Node broker is configured", async (grant) => {
    const root = temporary(`runtime-no-broker-${grant.permission}`);
    const pkg = packageFixture(root);
    const provider = new ScriptedProvider();
    const imageDigest = `sha256:${"f".repeat(64)}`;
    await expect(service(root, provider, root, imageDigest).launch({
      ...launchSpec(pkg, imageDigest),
      effective_grants: [grant],
    })).rejects.toThrow(/no configured Node broker/);
    expect(provider.containers.size).toBe(0);
  });

  it("rejects a network broker that widens the exact Manager host allowlist", async () => {
    const root = temporary("runtime-network-widening");
    const pkg = packageFixture(root);
    const provider = new ScriptedProvider();
    const imageDigest = `sha256:${"1".repeat(64)}`;
    const brokers = new PluginRuntimeBrokerCapabilityRegistry();
    brokers.register({
      permission: "network.connect",
      provision: async ({ effective_grant }) => ({
        broker_session_version: 1,
        broker_id: "network-broker-test",
        session_id: "network-session-test",
        permission: "network.connect",
        effective_grant,
        transport: "node-mediated",
        network: {
          name: "homerail-plugin-broker-widened",
          internal: true,
          hosts: ["api.example.com:443", "evil.example.com:443"],
        },
      }),
    });
    await expect(service(root, provider, root, imageDigest, brokers).launch({
      ...launchSpec(pkg, imageDigest),
      effective_grants: [{ permission: "network.connect", hosts: ["api.example.com:443"] }],
    })).rejects.toThrow(/exact host scope/);
    expect(provider.containers.size).toBe(0);
  });

  it("replays a completed execute across service restart and refreshes only the short-lived proof", async () => {
    const root = temporary("runtime-recovery");
    const pkg = packageFixture(root);
    const provider = new ScriptedProvider();
    const imageDigest = `sha256:${"d".repeat(64)}`;
    const first = service(root, provider, root, imageDigest);
    const launched = await first.launch(launchSpec(pkg, imageDigest));
    const auth = authorization({ request_id: "request_runtime_replay_0001" });
    const execute = request("execute", auth);
    await expect(first.rpc(launched.runtime_instance_id, execute)).resolves.toMatchObject({
      message_type: "result",
      method: "execute",
      output: { type: "domain_output", output: { ok: true } },
    });
    expect(provider.calls).toBe(1);

    const recovered = service(root, provider, root, imageDigest);
    await expect(recovered.rpc(launched.runtime_instance_id, {
      ...execute,
      rpc_id: "rpc_execute_replayed_after_restart",
      sent_at: new Date().toISOString(),
    })).resolves.toMatchObject({ rpc_id: "rpc_execute_replayed_after_restart" });
    expect(provider.calls).toBe(1);

    const refreshed = await recovered.refreshAttestation(launched.runtime_instance_id);
    expect(refreshed).toMatchObject({
      container_id: launched.container_id,
      measurement_digest: launched.measurement_digest,
      image_digest: launched.image_digest,
    });
    expect(refreshed.attestation.claims.attestation_id).not.toBe(launched.attestation.claims.attestation_id);
  });

  it("records an invalid execute response as a terminal failed ledger", async () => {
    class InvalidResponseProvider extends ScriptedProvider {
      override async execInput(id: string, cmd: string[], input: string): Promise<ExecResult> {
        const execution = await super.execInput(id, cmd, input);
        const response = JSON.parse(execution.stdout) as { request_digest: string };
        response.request_digest = "0".repeat(64);
        return { ...execution, stdout: JSON.stringify(response) };
      }
    }

    const root = temporary("runtime-invalid-response");
    const pkg = packageFixture(root);
    const provider = new InvalidResponseProvider();
    const imageDigest = `sha256:${"3".repeat(64)}`;
    const runtime = service(root, provider, root, imageDigest);
    const launched = await runtime.launch(launchSpec(pkg, imageDigest));
    const auth = authorization({ request_id: "request_runtime_invalid_response_0001" });

    await expect(runtime.rpc(launched.runtime_instance_id, request("execute", auth)))
      .rejects.toThrow(/Runtime returned invalid execute result/);
    expect(provider.calls).toBe(1);

    await expect(runtime.rpc(launched.runtime_instance_id, {
      runtime_rpc_version: 1,
      message_type: "request",
      method: "reconcile",
      rpc_id: "rpc_reconcile_invalid_response_0001",
      sent_at: new Date().toISOString(),
      params: {
        request_id: auth.invocation.request_id,
        request_digest: auth.invocation.request_digest,
      },
    })).resolves.toMatchObject({
      method: "reconcile",
      status: "failed",
      error: {
        code: "runtime_process_failed",
        message: expect.stringContaining("Runtime returned invalid execute result"),
      },
    });
  });

  it("converges a previous-boot running ledger to a terminal interrupted failure", async () => {
    const root = temporary("runtime-interrupted");
    const pkg = packageFixture(root);
    const provider = new ScriptedProvider();
    const imageDigest = `sha256:${"e".repeat(64)}`;
    const first = service(root, provider, root, imageDigest);
    await first.launch(launchSpec(pkg, imageDigest));
    const requestId = "request_runtime_interrupted_0001";
    const requestDigest = sha256(requestId);
    const ledgerDir = path.join(root, "state/runtime-ledger", sha256("runtime-video-cover-0001"));
    fs.mkdirSync(ledgerDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(ledgerDir, `${sha256(requestId)}.json`), `${stableStringify({
      ledger_version: 1,
      request_id: requestId,
      request_digest: requestDigest,
      status: "running",
      owner_boot_id: "boot_previous_node_process",
      updated_at: new Date().toISOString(),
    })}\n`, { mode: 0o600 });

    const recovered = service(root, provider, root, imageDigest);
    await expect(recovered.rpc("runtime-video-cover-0001", {
      runtime_rpc_version: 1,
      message_type: "request",
      method: "reconcile",
      rpc_id: "rpc_reconcile_interrupted_0001",
      sent_at: new Date().toISOString(),
      params: { request_id: requestId, request_digest: requestDigest },
    })).resolves.toMatchObject({
      method: "reconcile",
      status: "failed",
      error: { code: "runtime_interrupted" },
    });
  });

  it("kills a timed-out Runtime, reconciles terminally, and rebuilds it for a new request", async () => {
    class HangingProvider extends ScriptedProvider {
      killed = false;
      hang = true;
      override async execInput(id: string, cmd: string[], input: string): Promise<ExecResult> {
        if (this.hang) return await new Promise<ExecResult>(() => undefined);
        return super.execInput(id, cmd, input);
      }
      override async kill(id: string): Promise<void> {
        this.killed = true;
        await super.kill(id);
      }
    }
    const root = temporary("runtime-timeout");
    const pkg = packageFixture(root);
    const provider = new HangingProvider();
    const imageDigest = `sha256:${"2".repeat(64)}`;
    const runtime = service(root, provider, root, imageDigest, undefined, 20);
    const launched = await runtime.launch(launchSpec(pkg, imageDigest));
    const auth = authorization({ request_id: "request_runtime_timeout_0001" });
    await expect(runtime.rpc(launched.runtime_instance_id, request("execute", auth)))
      .rejects.toThrow(/timed out/);
    expect(provider.killed).toBe(true);
    await expect(runtime.rpc(launched.runtime_instance_id, {
      runtime_rpc_version: 1,
      message_type: "request",
      method: "reconcile",
      rpc_id: "rpc_reconcile_timeout_0001",
      sent_at: new Date().toISOString(),
      params: {
        request_id: auth.invocation.request_id,
        request_digest: auth.invocation.request_digest,
      },
    })).resolves.toMatchObject({
      status: "failed",
      error: { code: "runtime_process_failed" },
    });

    provider.hang = false;
    const relaunched = await runtime.launch(launchSpec(pkg, imageDigest));
    expect(relaunched.container_id).not.toBe(launched.container_id);
    expect(provider.containers.has(launched.container_id)).toBe(false);
    const next = authorization({ request_id: "request_runtime_after_timeout_0002" });
    await expect(runtime.rpc(relaunched.runtime_instance_id, request("execute", next)))
      .resolves.toMatchObject({
        method: "execute",
        request_id: next.invocation.request_id,
        output: { type: "domain_output", output: { ok: true } },
      });
    await expect(runtime.rpc(relaunched.runtime_instance_id, {
      runtime_rpc_version: 1,
      message_type: "request",
      method: "reconcile",
      rpc_id: "rpc_reconcile_timeout_after_relaunch_0001",
      sent_at: new Date().toISOString(),
      params: {
        request_id: auth.invocation.request_id,
        request_digest: auth.invocation.request_digest,
      },
    })).resolves.toMatchObject({
      status: "failed",
      error: { code: "runtime_process_failed" },
    });
  });
});

let dockerReady = false;
let dockerImageDigest = "";
try {
  dockerImageDigest = execFileSync("docker", ["image", "inspect", image, "--format", "{{.Id}}"], { encoding: "utf8" }).trim();
  dockerReady = /^sha256:[a-f0-9]{64}$/.test(dockerImageDigest);
} catch {
  dockerReady = false;
}

describe.runIf(dockerReady)("PluginRuntimeService real Docker runner", () => {
  it("measures a locked non-root container and completes prepare -> broker upload -> execute", async () => {
    const root = temporary("runtime-docker");
    const pkg = packageFixture(root);
    const uploads = new Map<string, { label: string; media_type: string; digest: string; size_bytes: number }>();
    const server = http.createServer((req, res) => {
      const capability = req.url?.split("/").at(-1) ?? "";
      const expected = uploads.get(capability);
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const content = Buffer.concat(chunks);
        if (!expected || req.headers.authorization !== `HomerailArtifact token-${capability}`
          || req.headers["content-type"] !== expected.media_type
          || content.byteLength !== expected.size_bytes || sha256(content) !== expected.digest) {
          res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "rejected" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: {
          label: expected.label,
          media_type: expected.media_type,
          digest: expected.digest,
          size_bytes: expected.size_bytes,
          uri: `artifact:sha256/${expected.digest}`,
        } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Artifact test server did not bind");
      const provider = new DockerCliProvider();
      const runtime = new PluginRuntimeService({
        node_id: "node-runtime-docker",
        provider,
        authority: new NodeRuntimeAttestationAuthority({
          node_id: "node-runtime-docker",
          key_file: path.join(root, "keys/node.ed25519.pem"),
        }),
        data_root: path.join(root, "state"),
        package_roots: [root],
        image_allowlist: { [image]: dockerImageDigest },
        seccomp_profile: seccompProfile,
      });
      const launched = await runtime.launch(launchSpec(pkg, dockerImageDigest, true));
      try {
        const packageSource = launched.attestation.claims.isolation.mounts[0]!.source;
        expect(fs.statSync(path.join(packageSource, "runtime/fake-gpu-runtime.mjs")).mode & 0o777).toBe(0o444);
        await expect(provider.exec(launched.container_id, [
          "head", "-c", "1", "/opt/homerail/plugin/runtime/fake-gpu-runtime.mjs",
        ])).resolves.toMatchObject({ exitCode: 0, stdout: "#" });
        expect(launched.attestation.claims.isolation).toMatchObject({
          uid: 65532,
          gid: 65532,
          no_new_privileges: true,
          read_only_rootfs: true,
          linux_capabilities: [],
          network: { mode: "none", hosts: [], network_name: null, internal: true },
          mounts: [{ target: "/opt/homerail/plugin", mode: "ro" }],
          resources: {
            pids_limit: 64,
            memory_bytes: 536_870_912,
            memory_swap_bytes: 536_870_912,
            nano_cpus: 1_000_000_000,
          },
        });
        const auth = authorization({ request_id: "request_runtime_docker_0001", artifact: true });
        const prepared = await runtime.rpc(launched.runtime_instance_id, request("prepare", auth)) as {
          artifact_declarations: Array<{ id: string; label: string; media_type: "image/png" | "application/json"; digest: string; size_bytes: number }>;
        };
        expect(prepared.artifact_declarations.map((entry) => entry.id)).toEqual(["cover", "metadata"]);
        const artifactUploads = prepared.artifact_declarations.map((declaration) => {
          const capability = `cap-${declaration.id}`;
          uploads.set(capability, declaration);
          return {
            ...declaration,
            capability_id: capability,
            upload_url: `http://127.0.0.1:${address.port}/uploads/${capability}`,
            token: `token-${capability}`.padEnd(32, "x"),
          };
        });
        for (const upload of artifactUploads) {
          // Match the protocol-minimum token sent by the service exactly.
          upload.token = `token-${upload.capability_id}`;
          while (upload.token.length < 32) upload.token += "x";
        }
        for (const [capability] of uploads) {
          uploads.set(capability, uploads.get(capability)!);
        }
        server.removeAllListeners("request");
        server.on("request", (req, res) => {
          const capability = req.url?.split("/").at(-1) ?? "";
          const expected = uploads.get(capability);
          const chunks: Buffer[] = [];
          req.on("data", (chunk: Buffer) => chunks.push(chunk));
          req.on("end", () => {
            const content = Buffer.concat(chunks);
            const token = artifactUploads.find((entry) => entry.capability_id === capability)?.token;
            if (!expected || req.headers.authorization !== `HomerailArtifact ${token}`
              || content.byteLength !== expected.size_bytes || sha256(content) !== expected.digest) {
              res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "rejected" }));
              return;
            }
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: {
              label: expected.label,
              media_type: expected.media_type,
              digest: expected.digest,
              size_bytes: expected.size_bytes,
              uri: `artifact:sha256/${expected.digest}`,
            } }));
          });
        });
        const executed = await runtime.rpc(launched.runtime_instance_id, {
          ...request("execute", auth),
          params: { authorization: auth, artifact_uploads: artifactUploads },
        });
        expect(executed).toMatchObject({
          message_type: "result",
          method: "execute",
          output: { type: "domain_output", output: { artifacts: [{ id: "cover" }, { id: "metadata" }] } },
        });
      } finally {
        await runtime.remove(launched.runtime_instance_id);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);
});
