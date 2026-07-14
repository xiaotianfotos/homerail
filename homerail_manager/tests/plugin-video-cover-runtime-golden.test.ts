import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HomerailPluginPermission } from "homerail-protocol";
import {
  buildSignedHrpArchive,
  buildSignedPluginRegistryIndex,
  scanPluginSource,
  sourceFilesForPack,
} from "homerail-plugin-sdk";
import { DockerCliProvider } from "../../homerail_node/src/providers/docker-cli-provider.js";
import { handleLifecycleRequest } from "../../homerail_node/src/control-plane/lifecycle-handler.js";
import { PluginRuntimeService } from "../../homerail_node/src/runtime/plugin-runtime-service.js";
import { NodeRuntimeAttestationAuthority } from "../../homerail_node/src/security/runtime-attestation-key.js";
import { closeDb, getDb } from "../src/persistence/db.js";
import { setPluginPublisherTrust } from "../src/persistence/plugin-distribution.js";
import {
  listPluginVersions,
  setPluginGrantStatus,
} from "../src/persistence/plugins.js";
import {
  configureRemotePluginRegistry,
  enableRemotePluginRegistryRelease,
  installRemotePluginRegistryRelease,
  syncRemotePluginRegistryIndex,
} from "../src/plugins/remote-registry.js";
import { assemblePluginTurnContext } from "../src/plugins/context-assembler.js";
import {
  _resetPluginActionBusForTest,
  getPluginToolTurnAuthority,
  pluginRuntimeTransports,
} from "../src/plugins/action-bus.js";
import {
  _resetPluginRuntimeSandboxGateForTest,
  TRUSTED_RUNTIME_NODES_ENV,
} from "../src/plugins/runtime-sandbox-config.js";
import {
  _resetPluginRuntimeOrchestratorForTest,
  PLUGIN_RUNTIME_IMAGE_DIGEST_ENV,
  PLUGIN_RUNTIME_IMAGE_ENV,
  PLUGIN_RUNTIME_NODE_ENV,
} from "../src/plugins/runtime-orchestrator.js";
import { getPluginArtifactBroker } from "../src/plugins/artifact-broker.js";
import { _clearNodes, registerNode, type NodeState } from "../src/node/registry.js";
import { resolveLifecycleResponse } from "../src/node/lifecycle-request.js";
import { createServer } from "../src/server/http.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pluginSource = path.join(repoRoot, "plugins/examples/video-cover");
const seccomp = path.join(repoRoot, "homerail_node/src/runtime/plugin-runtime-seccomp.json");
const image = "homerail-plugin-runtime:m6";
const nodeId = "node-video-cover-golden";
const adminToken = "G".repeat(48);

let imageDigest = "";
let dockerReady = false;
try {
  imageDigest = execFileSync("docker", ["image", "inspect", image, "--format", "{{.Id}}"], { encoding: "utf8" }).trim();
  dockerReady = /^sha256:[a-f0-9]{64}$/.test(imageDigest);
} catch {
  dockerReady = false;
}

function writableTree(root: string): void {
  if (!fs.existsSync(root)) return;
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory()) return;
  fs.chmodSync(root, 0o700);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) writableTree(path.join(root, entry.name));
  }
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Manager Golden server did not bind");
  return address.port;
}

async function json(response: Response): Promise<any> {
  const body = await response.json() as any;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

describe.runIf(dockerReady)("M6 signed HRP -> lazy Docker Runtime -> Artifact Broker Golden", () => {
  let home: string;
  let oldEnv: NodeJS.ProcessEnv;
  let server: http.Server;
  let baseUrl: string;
  let provider: DockerCliProvider;
  let runtime: PluginRuntimeService;
  let failNextPreflightRemove: boolean;

  beforeEach(async () => {
    closeDb();
    oldEnv = { ...process.env };
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-runtime-golden-"));
    fs.chmodSync(home, 0o700);
    process.env.HOMERAIL_HOME = home;
    process.env.HOMERAIL_LOCAL_NODE_AUTOSTART = "0";
    process.env.HOMERAIL_MANAGER_ADMIN_TOKEN = adminToken;
    process.env.HOMERAIL_GENERATIVE_UI_MODE = "prefer";
    process.env[PLUGIN_RUNTIME_NODE_ENV] = nodeId;
    process.env[PLUGIN_RUNTIME_IMAGE_ENV] = image;
    process.env[PLUGIN_RUNTIME_IMAGE_DIGEST_ENV] = imageDigest;
    fs.mkdirSync(path.join(home, "plugins", "packages"), { recursive: true, mode: 0o700 });

    provider = new DockerCliProvider();
    const authority = new NodeRuntimeAttestationAuthority({
      node_id: nodeId,
      key_file: path.join(home, "node-keys/runtime.ed25519.pem"),
    });
    const identity = authority.publicIdentity();
    process.env[TRUSTED_RUNTIME_NODES_ENV] = JSON.stringify([{
      node_id: identity.node_id,
      key_id: identity.key_id,
      public_key: identity.public_key,
    }]);
    runtime = new PluginRuntimeService({
      node_id: nodeId,
      provider,
      authority,
      data_root: path.join(home, "node-runtime"),
      package_roots: [path.join(home, "plugins", "packages")],
      image_allowlist: { [image]: imageDigest },
      seccomp_profile: seccomp,
    });
    let node!: NodeState;
    failNextPreflightRemove = false;
    node = {
      node_id: nodeId,
      project_id: "project-runtime-golden",
      socket: {
        readyState: 1,
        send(raw: string) {
          const request = JSON.parse(raw);
          queueMicrotask(() => {
            if (failNextPreflightRemove && request.resource_type === "plugin_runtime" && request.operation === "remove") {
              failNextPreflightRemove = false;
              resolveLifecycleResponse(node, request.request_id, "error", undefined, { message: "injected cleanup failure" });
              return;
            }
            void handleLifecycleRequest(request, provider, (response) => {
              resolveLifecycleResponse(
                node,
                response.request_id,
                response.status,
                response.resource_data,
                response.error,
              );
            }, { pluginRuntime: runtime });
          });
        },
      },
      status: "idle",
      capabilities: ["docker-cli", "plugin-runtime"],
      registered_at: Date.now(),
      last_heartbeat: Date.now(),
      pending_requests: new Map(),
    } as unknown as NodeState;
    registerNode(node);
    pluginRuntimeTransports.clear();
    _resetPluginRuntimeSandboxGateForTest();
    _resetPluginRuntimeOrchestratorForTest();
    _resetPluginActionBusForTest();

    server = createServer(0, undefined, undefined, false);
    baseUrl = `http://127.0.0.1:${await listen(server)}`;
    process.env.HOMERAIL_PLUGIN_ARTIFACT_BROKER_URL = baseUrl;
  });

  afterEach(async () => {
    for (const info of await provider.list().catch(() => [])) {
      const runtimeId = info.labels?.["homerail.runtime_instance_id"];
      if (runtimeId && info.labels?.["homerail.node_id"] === nodeId) {
        await runtime.remove(runtimeId).catch(() => undefined);
      }
    }
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    pluginRuntimeTransports.clear();
    _clearNodes();
    _resetPluginRuntimeSandboxGateForTest();
    _resetPluginRuntimeOrchestratorForTest();
    _resetPluginActionBusForTest();
    closeDb();
    process.env = oldEnv;
    writableTree(home);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("uses only public lifecycle and Tool APIs for the complete signed executable path", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const registryKey = generateKeyPairSync("ed25519");
    const signed = buildSignedHrpArchive(sourceFilesForPack(scanPluginSource(pluginSource)), {
      publisher: "com.homerail",
      private_key: privateKey,
    });
    setPluginPublisherTrust({
      entry: {
        publisher: signed.signature.publisher,
        key_id: signed.signature.key_id,
        public_key_spki: signed.signature.public_key_spki,
        state: "trusted",
      },
      actor: "runtime-golden",
    });
    const catalog = buildSignedPluginRegistryIndex({
      registry_id: "stable.homerail",
      sequence: 1,
      issued_at: "2026-07-12T00:00:00.000Z",
      expires_at: "2026-07-13T00:00:00.000Z",
      releases: [{
        plugin_id: signed.lock.plugin.id,
        plugin_version: signed.lock.plugin.version,
        archive_path: "releases/video-cover-1.0.0.hrp",
        archive_digest: signed.archive_digest,
        payload_digest: signed.lock.payload_digest,
        publisher_key_id: signed.signature.key_id,
      }],
    }, { private_key: registryKey.privateKey });
    configureRemotePluginRegistry({
      registry_id: "stable.homerail",
      source_url: "https://registry.homerail.example/index.json",
      root_key_id: catalog.root_pin,
    });
    syncRemotePluginRegistryIndex({
      registry_id: "stable.homerail",
      index_bytes: catalog.bytes,
      now: "2026-07-12T01:00:00.000Z",
    });
    const installedRelease = installRemotePluginRegistryRelease({
      registry_id: "stable.homerail",
      plugin_id: "com.homerail.video-cover",
      plugin_version: "1.0.0",
      archive: signed.archive,
      now: "2026-07-12T01:00:00.000Z",
    });
    const installed = installedRelease.installed;
    expect(installed).toMatchObject({
      package: { plugin_id: "com.homerail.video-cover", plugin_version: "1.0.0" },
      installation: { lifecycle_state: "staged", health_state: "unchecked", signature_state: "verified" },
      activation: { enabled: false },
    });
    for (const permission of [HomerailPluginPermission.ARTIFACT_WRITE, HomerailPluginPermission.GPU_USE]) {
      setPluginGrantStatus({
        plugin_id: "com.homerail.video-cover",
        plugin_version: "1.0.0",
        permission,
        status: "granted",
        expected_revision: 1,
        actor_type: "operator",
        actor_id: "runtime-golden",
      });
    }
    expect(() => enableRemotePluginRegistryRelease({
      registry_id: "stable.homerail",
      plugin_id: "com.homerail.video-cover",
      expected_revision: installed.activation.revision,
      expected_active_version: "1.0.0",
      now: "2026-07-12T01:00:00.000Z",
    })).toThrow(/not healthy and installed/);

    const preflight = await json(await fetch(
      `${baseUrl}/api/plugins/com.homerail.video-cover/versions/1.0.0/runtime/preflight`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
        body: "{}",
      },
    ));
    expect(preflight.data).toMatchObject({
      plugin_id: "com.homerail.video-cover",
      plugin_version: "1.0.0",
      node_id: nodeId,
      image_digest: imageDigest,
    });
    expect(listPluginVersions("com.homerail.video-cover")[0]?.installation).toMatchObject({
      lifecycle_state: "installed",
      health_state: "healthy",
      signature_state: "verified",
    });
    const enabled = enableRemotePluginRegistryRelease({
      registry_id: "stable.homerail",
      plugin_id: "com.homerail.video-cover",
      expected_revision: installed.activation.revision,
      expected_active_version: "1.0.0",
      now: "2026-07-12T01:00:00.000Z",
    });
    expect(enabled.activation.enabled).toBe(true);

    const sessionId = "voice-runtime-golden";
    getDb().prepare(
      "INSERT INTO voice_agent_sessions(session_id, project_id, updated_at, data) VALUES (?, NULL, ?, ?)",
    ).run(sessionId, new Date().toISOString(), JSON.stringify({ generative_ui_mode: "prefer" }));
    const context = assemblePluginTurnContext();
    const tool = context.tools.find((candidate) => (
      candidate.plugin_id === "com.homerail.video-cover" && candidate.local_id === "generate_cover"
    ));
    expect(tool).toBeDefined();
    const turn = getPluginToolTurnAuthority().issue({
      context,
      modality: "text",
      scope: { type: "voice_session", id: sessionId },
      generative_ui_mode: "prefer",
    });
    const requestId = "video_cover_golden_request_0001";
    const invoked = await json(await fetch(`${baseUrl}/api/plugins/tools/invoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        request_id: requestId,
        idempotency_key: "video_cover_golden_idempotency_0001",
        turn_token: turn.token,
        tool_wire_id: tool!.wire_id,
        call_id: "video_cover_golden_call_0001",
        arguments: {
          prompt: "A blue HomeRail train crossing a luminous horizon",
          width: 64,
          height: 36,
          style: "cinematic",
        },
      }),
    }));
    expect(invoked.data).toMatchObject({ status: "awaiting_confirmation" });

    const committed = await json(await fetch(
      `${baseUrl}/api/plugins/tools/${encodeURIComponent(requestId)}/confirmation`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          challenge_id: invoked.data.challenge.challenge_id,
          decision: "approved",
        }),
      },
    ));
    expect(committed.data).toMatchObject({
      status: "committed",
      result: { output_type: "domain_output", output: { artifacts: [{ id: "cover" }, { id: "metadata" }] } },
    });
    const artifacts = committed.data.result.output.artifacts as Array<{ id: string; digest: string }>;
    const cover = getPluginArtifactBroker().read({
      plugin_id: "com.homerail.video-cover",
      request_id: requestId,
      digest: artifacts.find((artifact) => artifact.id === "cover")!.digest,
    });
    expect(cover.content.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(cover.content.readUInt32BE(16)).toBe(64);
    expect(cover.content.readUInt32BE(20)).toBe(36);

    const liveContainers = (await provider.list()).filter((info) => (
      info.labels?.["homerail.node_id"] === nodeId
      && info.labels?.["homerail.plugin_id"] === "com.homerail.video-cover"
    ));
    expect(liveContainers).toHaveLength(1);
    const measuredContainer = await provider.inspect(liveContainers[0]!.id);
    expect(measuredContainer).toMatchObject({
      status: "running",
      labels: {
        "homerail.resource_type": "plugin-runtime",
        "homerail.plugin_id": "com.homerail.video-cover",
      },
      measurement: {
        user: "65532:65532",
        readOnlyRootfs: true,
        capDrop: ["ALL"],
        networkMode: "none",
        networkNames: [],
        resourceLimits: {
          pids: 64,
          memoryBytes: 536_870_912,
          memorySwapBytes: 536_870_912,
          nanoCpus: 1_000_000_000,
        },
      },
    });
  }, 60_000);

  it("keeps the executable HRP staged when preflight container cleanup fails", async () => {
    const publisherKey = generateKeyPairSync("ed25519");
    const registryKey = generateKeyPairSync("ed25519");
    const signed = buildSignedHrpArchive(sourceFilesForPack(scanPluginSource(pluginSource)), {
      publisher: "com.homerail",
      private_key: publisherKey.privateKey,
    });
    setPluginPublisherTrust({
      entry: {
        publisher: signed.signature.publisher,
        key_id: signed.signature.key_id,
        public_key_spki: signed.signature.public_key_spki,
        state: "trusted",
      },
      actor: "runtime-cleanup-test",
    });
    const catalog = buildSignedPluginRegistryIndex({
      registry_id: "cleanup.homerail",
      sequence: 1,
      issued_at: "2026-07-12T00:00:00.000Z",
      expires_at: "2026-07-13T00:00:00.000Z",
      releases: [{
        plugin_id: signed.lock.plugin.id,
        plugin_version: signed.lock.plugin.version,
        archive_path: "releases/video-cover-1.0.0.hrp",
        archive_digest: signed.archive_digest,
        payload_digest: signed.lock.payload_digest,
        publisher_key_id: signed.signature.key_id,
      }],
    }, { private_key: registryKey.privateKey });
    configureRemotePluginRegistry({
      registry_id: "cleanup.homerail",
      source_url: "https://cleanup.homerail.example/index.json",
      root_key_id: catalog.root_pin,
    });
    syncRemotePluginRegistryIndex({
      registry_id: "cleanup.homerail",
      index_bytes: catalog.bytes,
      now: "2026-07-12T01:00:00.000Z",
    });
    installRemotePluginRegistryRelease({
      registry_id: "cleanup.homerail",
      plugin_id: "com.homerail.video-cover",
      plugin_version: "1.0.0",
      archive: signed.archive,
      now: "2026-07-12T01:00:00.000Z",
    });
    for (const permission of [HomerailPluginPermission.ARTIFACT_WRITE, HomerailPluginPermission.GPU_USE]) {
      setPluginGrantStatus({
        plugin_id: "com.homerail.video-cover",
        plugin_version: "1.0.0",
        permission,
        status: "granted",
        expected_revision: 1,
        actor_type: "operator",
        actor_id: "runtime-cleanup-test",
      });
    }
    failNextPreflightRemove = true;
    const response = await fetch(
      `${baseUrl}/api/plugins/com.homerail.video-cover/versions/1.0.0/runtime/preflight`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
        body: "{}",
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/cleanup failed/) });
    expect(listPluginVersions("com.homerail.video-cover")[0]?.installation).toMatchObject({
      lifecycle_state: "staged",
      health_state: "unchecked",
    });
  }, 30_000);
});
