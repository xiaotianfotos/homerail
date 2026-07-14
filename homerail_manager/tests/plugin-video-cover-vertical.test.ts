import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import AjvModule from "ajv";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  homerailPluginToolInvocationDigestInput,
  validateHomerailPluginRuntimeRpcResponse,
  type HomerailPluginAuthorizedToolInvocationV1,
  type HomerailPluginRuntimeArtifactV1,
  type HomerailPluginToolInvocationV1,
} from "homerail-protocol";
import { closeDb } from "../src/persistence/db.js";
import { getPluginArtifactBroker } from "../src/plugins/artifact-broker.js";
import { pluginJsonDigest } from "../src/plugins/descriptor.js";
import { createServer } from "../src/server/http.js";

const runtime = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../plugins/examples/video-cover/runtime/fake-gpu-runtime.mjs",
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AjvClass = (AjvModule as any).default || AjvModule;

function iso(value: number): string {
  return new Date(value).toISOString();
}

function authorization(now: Date): HomerailPluginAuthorizedToolInvocationV1 {
  const requestId = "video-cover-vertical-request-0001";
  const invocation: HomerailPluginToolInvocationV1 = {
    tool_bus_version: 1,
    request_id: requestId,
    idempotency_key: `${requestId}-idempotency`,
    request_digest: "0".repeat(64),
    invoked_at: iso(now.getTime() - 60_000),
    deadline_at: iso(now.getTime() + 5 * 60_000),
    source: {
      type: "agent",
      call_id: `${requestId}-call`,
      modality: "text",
      scope: { type: "project", id: "project-video-cover" },
      target: { document_id: "document-video-cover", base_revision: 3 },
    },
    tool: {
      local_id: "generate_cover",
      qualified_id: "com.homerail.video-cover:generate_cover",
      wire_id: "videoCoverGenerate",
      handler: { type: "runtime", method: "generate_video_cover" },
    },
    binding: {
      plugin_id: "com.homerail.video-cover",
      plugin_version: "1.0.0",
      manifest_digest: "a".repeat(64),
      package_digest: "b".repeat(64),
      context_digest: "c".repeat(64),
      registry_revision: 7,
      permission_revision: 4,
    },
    policy: {
      effect: "write",
      permissions: ["artifact.write", "gpu.use"],
      effective_grants: [{ permission: "artifact.write" }, { permission: "gpu.use" }],
      confirmation: "never",
      confirmation_required: false,
    },
    arguments: {
      prompt: "A blue HomeRail train crossing a luminous horizon",
      width: 64,
      height: 36,
      style: "cinematic",
    },
  };
  invocation.request_digest = pluginJsonDigest(homerailPluginToolInvocationDigestInput(invocation));
  return {
    authorization_version: 1,
    invocation,
    capability: {
      capability_version: 1,
      capability_id: `${requestId}-tool-capability`,
      audience: "homerail.plugin-runtime",
      scope: "plugin.tool.execute",
      nonce: `${requestId}-tool-nonce`,
      single_use: true,
      request_id: requestId,
      request_digest: invocation.request_digest,
      binding: structuredClone(invocation.binding),
      effect: invocation.policy.effect,
      permissions: [...invocation.policy.permissions],
      effective_grants: structuredClone(invocation.policy.effective_grants),
      issued_at: iso(now.getTime() - 30_000),
      expires_at: iso(now.getTime() + 3 * 60_000),
    },
  };
}

async function runFakeGpu(mode: "--fixture-plan" | "--fixture", input: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const safeEnv = Object.fromEntries(
      ["LANG", "LC_ALL", "PATH", "TZ"]
        .map((key) => [key, process.env[key]])
        .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
    const child = spawn(process.execPath, [runtime, mode], {
      cwd: path.dirname(runtime),
      env: safeEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("fake GPU runtime timed out"));
    }, 10_000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (cause) => {
      clearTimeout(timeout);
      reject(cause);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`fake GPU runtime exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")));
      } catch (cause) {
        reject(cause);
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("server did not bind");
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("video-cover M6 Artifact Broker vertical slice", () => {
  let server: http.Server;
  let baseUrl: string;
  let home: string;
  let previousHome: string | undefined;
  let previousAutostart: string | undefined;
  let previousAdminToken: string | undefined;

  beforeEach(async () => {
    closeDb();
    previousHome = process.env.HOMERAIL_HOME;
    previousAutostart = process.env.HOMERAIL_LOCAL_NODE_AUTOSTART;
    previousAdminToken = process.env.HOMERAIL_MANAGER_ADMIN_TOKEN;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-video-cover-vertical-"));
    process.env.HOMERAIL_HOME = home;
    process.env.HOMERAIL_LOCAL_NODE_AUTOSTART = "0";
    process.env.HOMERAIL_MANAGER_ADMIN_TOKEN = "B".repeat(32);
    server = createServer(0, undefined, undefined, false);
    baseUrl = `http://127.0.0.1:${await listen(server)}`;
  });

  afterEach(async () => {
    if (server.listening) await close(server);
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    if (previousAutostart === undefined) delete process.env.HOMERAIL_LOCAL_NODE_AUTOSTART;
    else process.env.HOMERAIL_LOCAL_NODE_AUTOSTART = previousAutostart;
    if (previousAdminToken === undefined) delete process.env.HOMERAIL_MANAGER_ADMIN_TOKEN;
    else process.env.HOMERAIL_MANAGER_ADMIN_TOKEN = previousAdminToken;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("lets a fake verified GPU Tool publish real PNG and JSON bytes using capabilities only", async () => {
    const now = new Date();
    const auth = authorization(now);
    const plan = await runFakeGpu("--fixture-plan", { arguments: auth.invocation.arguments }) as {
      gpu: { backend: string; device: string; verified: boolean };
      artifacts: Array<{
        id: string;
        label: string;
        media_type: "image/png" | "application/json";
        digest: string;
        size_bytes: number;
      }>;
    };
    expect(plan).toMatchObject({ gpu: { backend: "fake", device: "fake-gpu:0", verified: true } });
    expect(plan.artifacts.map((artifact) => artifact.id)).toEqual(["cover", "metadata"]);

    const broker = getPluginArtifactBroker();
    const uploads = plan.artifacts.map((artifact) => {
      const issued = broker.issueWriteCapability({
        authorization: auth,
        artifact: {
          label: artifact.label,
          media_type: artifact.media_type,
          digest: artifact.digest,
          size_bytes: artifact.size_bytes,
        },
        now: new Date(),
      });
      return {
        id: artifact.id,
        capability_id: issued.claims.capability_id,
        token: issued.token,
        upload_url: `${baseUrl}${issued.upload_path}`,
      };
    });
    // The child receives no Manager path or secret, only exact broker-issued
    // capabilities and their HTTP endpoints.
    expect(uploads.every((upload) => !upload.upload_url.includes(home))).toBe(true);

    const result = await runFakeGpu("--fixture", {
      arguments: auth.invocation.arguments,
      uploads,
    }) as {
      gpu: { backend: string; verified: boolean };
      output: { artifacts: HomerailPluginRuntimeArtifactV1[] };
    };
    const completedAt = new Date();
    expect(result.output.artifacts).toEqual(plan.artifacts.map((artifact) => expect.objectContaining({
      id: artifact.id,
      media_type: artifact.media_type,
      digest: artifact.digest,
      size_bytes: artifact.size_bytes,
      uri: `artifact:sha256/${artifact.digest}`,
    })));
    const outputSchema = JSON.parse(fs.readFileSync(
      path.resolve(path.dirname(runtime), "../schemas/video-cover-output.v1.schema.json"),
      "utf8",
    )) as Record<string, unknown>;
    expect(new AjvClass({ strict: true }).compile(outputSchema)(result.output)).toBe(true);

    expect(validateHomerailPluginRuntimeRpcResponse({
      runtime_rpc_version: 1,
      message_type: "result",
      method: "execute",
      rpc_id: "video-cover-fixture-rpc-0001",
      completed_at: completedAt.toISOString(),
      request_id: auth.invocation.request_id,
      request_digest: auth.invocation.request_digest,
      binding: auth.invocation.binding,
      output: { type: "domain_output", output: result.output },
      logs: [{
        sequence: 0,
        timestamp: completedAt.toISOString(),
        level: "info",
        message: "Fake GPU published content-addressed cover artifacts.",
      }],
      artifacts: result.output.artifacts,
    }, {
      now_ms: completedAt.getTime(),
      expected: {
        source: auth.invocation.source,
        tool: auth.invocation.tool,
        binding: auth.invocation.binding,
        policy: auth.invocation.policy,
        request_id: auth.invocation.request_id,
        request_digest: auth.invocation.request_digest,
      },
    })).toMatchObject({ valid: true, errors: [] });

    const cover = broker.read({
      plugin_id: auth.invocation.binding.plugin_id,
      request_id: auth.invocation.request_id,
      digest: plan.artifacts[0].digest,
    });
    expect(cover.content.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(cover.content.readUInt32BE(16)).toBe(64);
    expect(cover.content.readUInt32BE(20)).toBe(36);
    const coverHttp = await fetch(`${baseUrl}${cover.metadata.read_path}`);
    expect(coverHttp.status).toBe(200);
    expect(coverHttp.headers.get("x-content-type-options")).toBe("nosniff");

    const provenance = broker.read({
      plugin_id: auth.invocation.binding.plugin_id,
      request_id: auth.invocation.request_id,
      digest: plan.artifacts[1].digest,
    });
    expect(JSON.parse(provenance.content.toString("utf8"))).toMatchObject({
      generator: "com.homerail.video-cover/fake-gpu",
      width: 64,
      height: 36,
      cover: { digest: plan.artifacts[0].digest, media_type: "image/png" },
    });
  });
});
