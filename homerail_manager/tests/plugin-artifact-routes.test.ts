import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  homerailPluginToolInvocationDigestInput,
  type HomerailPluginAuthorizedToolInvocationV1,
  type HomerailPluginToolInvocationV1,
} from "homerail-protocol";
import { closeDb } from "../src/persistence/db.js";
import { getPluginArtifactBroker } from "../src/plugins/artifact-broker.js";
import { pluginJsonDigest } from "../src/plugins/descriptor.js";
import { createServer } from "../src/server/http.js";

function iso(value: number): string {
  return new Date(value).toISOString();
}

function authorization(now: Date): HomerailPluginAuthorizedToolInvocationV1 {
  const requestId = "artifact-route-request-0001";
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
    arguments: { prompt: "A blue HomeRail train at sunrise", width: 64, height: 36 },
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

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("server did not bind");
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("Plugin Artifact Broker HTTP routes", () => {
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
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-artifact-routes-"));
    process.env.HOMERAIL_HOME = home;
    process.env.HOMERAIL_LOCAL_NODE_AUTOSTART = "0";
    // Artifact uploads use their own exact bearer capability even when the
    // generic Manager mutation surface is independently authenticated.
    process.env.HOMERAIL_MANAGER_ADMIN_TOKEN = "A".repeat(32);
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

  it("uploads with a broker capability and serves immutable no-sniff bytes with ETag", async () => {
    const now = new Date();
    const content = Buffer.from("\x89PNG\r\n\x1a\nroute-image-bytes", "binary");
    const contentDigest = createHash("sha256").update(content).digest("hex");
    const issued = getPluginArtifactBroker().issueWriteCapability({
      authorization: authorization(now),
      artifact: {
        label: "Generated video cover",
        media_type: "image/png",
        digest: contentDigest,
        size_bytes: content.byteLength,
      },
      now,
    });

    const oversized = await fetch(`${baseUrl}${issued.upload_path}`, {
      method: "PUT",
      headers: {
        Authorization: `HomerailArtifact ${issued.token}`,
        "Content-Type": "image/png",
      },
      body: Buffer.concat([content, Buffer.from([0])]),
    });
    expect(oversized.status).toBe(413);
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);

    const upload = await fetch(`${baseUrl}${issued.upload_path}`, {
      method: "PUT",
      headers: {
        Authorization: `HomerailArtifact ${issued.token}`,
        "Content-Type": "image/png",
      },
      body: content,
    });
    const uploadBody = await upload.json() as { data: { read_path: string; digest: string } };
    expect(upload.status).toBe(201);
    expect(upload.headers.get("access-control-allow-origin")).toBeNull();
    expect(uploadBody.data.digest).toBe(contentDigest);

    const read = await fetch(`${baseUrl}${uploadBody.data.read_path}`);
    const etag = read.headers.get("etag")!;
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("image/png");
    expect(read.headers.get("x-content-type-options")).toBe("nosniff");
    expect(read.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(read.headers.get("access-control-allow-origin")).toBeNull();
    expect(read.headers.get("cache-control")).toContain("immutable");
    expect(Buffer.from(await read.arrayBuffer())).toEqual(content);
    expect((await fetch(`${baseUrl}${uploadBody.data.read_path}`, {
      headers: { "If-None-Match": etag },
    })).status).toBe(304);

    const replay = await fetch(`${baseUrl}${issued.upload_path}`, {
      method: "PUT",
      headers: {
        Authorization: `HomerailArtifact ${issued.token}`,
        "Content-Type": "image/png",
      },
      body: content,
    });
    expect(replay.status).toBe(409);
  });

  it("rejects missing capabilities without weakening unrelated admin mutations", async () => {
    const missing = await fetch(`${baseUrl}/api/plugins/artifacts/uploads/artifact_cap_missing`, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: Buffer.from("x"),
    });
    expect(missing.status).toBe(401);

    const unrelated = await fetch(`${baseUrl}/api/plugins/capabilities/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ utterance: "test" }),
    });
    expect(unrelated.status).toBe(401);
  });
});
