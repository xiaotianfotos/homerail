import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  homerailPluginToolInvocationDigestInput,
  type HomerailPluginAuthorizedToolInvocationV1,
  type HomerailPluginToolInvocationV1,
} from "homerail-protocol";
import { pluginJsonDigest } from "../src/plugins/descriptor.js";
import { PluginArtifactBroker } from "../src/plugins/artifact-broker.js";

const roots: string[] = [];
const NOW = new Date("2026-07-12T12:00:00.000Z");

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-artifact-broker-"));
  roots.push(root);
  return root;
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function artifactAuthorization(requestId = "artifact-request-0001"): HomerailPluginAuthorizedToolInvocationV1 {
  const invocation: HomerailPluginToolInvocationV1 = {
    tool_bus_version: 1,
    request_id: requestId,
    idempotency_key: `${requestId}-idempotency`,
    request_digest: "0".repeat(64),
    invoked_at: "2026-07-12T11:59:00.000Z",
    deadline_at: "2026-07-12T12:05:00.000Z",
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
      issued_at: "2026-07-12T11:59:30.000Z",
      expires_at: "2026-07-12T12:03:00.000Z",
    },
  };
}

describe("Plugin Artifact Broker", () => {
  it("atomically publishes and verifies a content-addressed, request-scoped artifact", () => {
    const root = temporaryRoot();
    const broker = new PluginArtifactBroker({ root, secret: Buffer.alloc(32, 0x61) });
    const content = Buffer.from("\x89PNG\r\n\x1a\nactual-image-bytes", "binary");
    const contentDigest = sha256(content);
    const issued = broker.issueWriteCapability({
      authorization: artifactAuthorization(),
      artifact: {
        label: "Generated video cover",
        media_type: "image/png",
        digest: contentDigest,
        size_bytes: content.byteLength,
      },
      now: NOW,
    });

    expect(issued.upload_path).toBe(`/api/plugins/artifacts/uploads/${issued.claims.capability_id}`);
    expect(issued.claims).toMatchObject({
      binding: { plugin_id: "com.homerail.video-cover" },
      request_id: "artifact-request-0001",
      document_scope: { type: "project", id: "project-video-cover", document_id: "document-video-cover" },
    });

    const metadata = broker.publish({
      token: issued.token,
      capability_id: issued.claims.capability_id,
      content_type: "image/png",
      content,
      now: new Date("2026-07-12T12:00:01.000Z"),
    });
    expect(metadata).toMatchObject({
      artifact_id: `sha256:${contentDigest}`,
      uri: `artifact:sha256/${contentDigest}`,
      media_type: "image/png",
      size_bytes: content.byteLength,
      integrity: { algorithm: "hmac-sha256", key_id: "manager-artifact-broker-v1" },
    });
    expect(broker.read({
      plugin_id: "com.homerail.video-cover",
      request_id: "artifact-request-0001",
      digest: contentDigest,
    }).content).toEqual(content);
    expect(() => broker.publish({
      token: issued.token,
      capability_id: issued.claims.capability_id,
      content_type: "image/png",
      content,
      now: new Date("2026-07-12T12:00:02.000Z"),
    })).toThrow(/already consumed/);

    const metadataFile = path.join(
      root,
      "metadata",
      createHash("sha256").update("com.homerail.video-cover").digest("hex"),
      createHash("sha256").update("artifact-request-0001").digest("hex"),
      `${contentDigest}.json`,
    );
    const metadataBefore = fs.readFileSync(metadataFile);
    const duplicate = broker.issueWriteCapability({
      authorization: artifactAuthorization(),
      artifact: {
        label: "Generated video cover",
        media_type: "image/png",
        digest: contentDigest,
        size_bytes: content.byteLength,
      },
      now: NOW,
    });
    expect(() => broker.publish({
      token: duplicate.token,
      capability_id: duplicate.claims.capability_id,
      content_type: "image/png",
      content,
      now: new Date("2026-07-12T12:00:03.000Z"),
    })).toThrow(/metadata already exists/);
    expect(fs.readFileSync(metadataFile)).toEqual(metadataBefore);
  });

  it("rejects forged capabilities, wrong bytes/MIME, traversal and corrupt no-replace collisions", () => {
    const root = temporaryRoot();
    const broker = new PluginArtifactBroker({ root, secret: Buffer.alloc(32, 0x62) });
    const content = Buffer.from("{\"expected\":true}\n");
    const contentDigest = sha256(content);
    const issued = broker.issueWriteCapability({
      authorization: artifactAuthorization("artifact-request-0002"),
      artifact: {
        label: "Cover metadata",
        media_type: "application/json",
        digest: contentDigest,
        size_bytes: content.byteLength,
      },
      now: NOW,
    });
    const [prefix, payload, mac] = issued.token.split(".");
    const forged = `${prefix}.${payload}.${mac[0] === "A" ? "B" : "A"}${mac.slice(1)}`;
    expect(() => broker.inspectWriteCapability({ token: forged, now: NOW }))
      .toThrow(/signature/);
    expect(() => broker.publish({
      token: issued.token,
      capability_id: issued.claims.capability_id,
      content_type: "text/html",
      content,
      now: NOW,
    })).toThrow(/Content-Type/);
    expect(() => broker.publish({
      token: issued.token,
      capability_id: issued.claims.capability_id,
      content_type: "application/json",
      content: Buffer.alloc(content.byteLength, 0x78),
      now: NOW,
    })).toThrow(/digest/);
    expect(() => broker.read({ plugin_id: "../escape", request_id: "artifact-request-0002", digest: contentDigest }))
      .toThrow(/plugin id/);

    const blobDirectory = path.join(root, "blobs", "sha256", contentDigest.slice(0, 2));
    fs.mkdirSync(blobDirectory, { recursive: true });
    const blobFile = path.join(blobDirectory, contentDigest);
    fs.writeFileSync(blobFile, Buffer.alloc(content.byteLength, 0x79));
    expect(() => broker.publish({
      token: issued.token,
      capability_id: issued.claims.capability_id,
      content_type: "application/json",
      content,
      now: NOW,
    })).toThrow(/digest is corrupt/);
    expect(fs.readFileSync(blobFile)).toEqual(Buffer.alloc(content.byteLength, 0x79));

    const mislabeled = Buffer.from("<html>not json</html>");
    const mislabeledCapability = broker.issueWriteCapability({
      authorization: artifactAuthorization("artifact-request-0004"),
      artifact: {
        label: "Mislabeled JSON",
        media_type: "application/json",
        digest: sha256(mislabeled),
        size_bytes: mislabeled.byteLength,
      },
      now: NOW,
    });
    expect(() => broker.publish({
      token: mislabeledCapability.token,
      capability_id: mislabeledCapability.claims.capability_id,
      content_type: "application/json",
      content: mislabeled,
      now: NOW,
    })).toThrow(/valid UTF-8 JSON/);
  });

  it("detects metadata tampering before returning content", () => {
    const root = temporaryRoot();
    const broker = new PluginArtifactBroker({ root, secret: Buffer.alloc(32, 0x63) });
    const content = Buffer.from("{\"ok\":true}\n");
    const contentDigest = sha256(content);
    const issued = broker.issueWriteCapability({
      authorization: artifactAuthorization("artifact-request-0003"),
      artifact: {
        label: "Cover metadata",
        media_type: "application/json",
        digest: contentDigest,
        size_bytes: content.byteLength,
      },
      now: NOW,
    });
    broker.publish({
      token: issued.token,
      capability_id: issued.claims.capability_id,
      content_type: "application/json",
      content,
      now: NOW,
    });
    const metadataFile = path.join(
      root,
      "metadata",
      createHash("sha256").update("com.homerail.video-cover").digest("hex"),
      createHash("sha256").update("artifact-request-0003").digest("hex"),
      `${contentDigest}.json`,
    );
    const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8")) as Record<string, unknown>;
    metadata.label = "tampered";
    fs.writeFileSync(metadataFile, JSON.stringify(metadata));
    expect(() => broker.read({
      plugin_id: "com.homerail.video-cover",
      request_id: "artifact-request-0003",
      digest: contentDigest,
    })).toThrow(/integrity verification failed/);
  });

  it("refuses a managed directory redirected through a symlink", () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    fs.symlinkSync(outside, path.join(root, "blobs"), "dir");
    expect(() => new PluginArtifactBroker({ root, secret: Buffer.alloc(32, 0x64) }))
      .toThrow(/real directories/);
  });
});
