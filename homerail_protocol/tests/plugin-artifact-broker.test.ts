import { describe, expect, it } from "vitest";
import {
  homerailPluginArtifactCapabilitySigningInput,
  validateHomerailPluginArtifactWriteCapabilityClaims,
  type HomerailPluginArtifactWriteCapabilityClaimsV1,
} from "../src/index.js";

const now = Date.parse("2026-07-12T12:00:00.000Z");

function claims(): HomerailPluginArtifactWriteCapabilityClaimsV1 {
  return {
    artifact_capability_version: 1,
    capability_id: "artifact-capability-0001",
    audience: "homerail.artifact-broker",
    scope: "plugin.artifact.write",
    nonce: "artifact-nonce-0000001",
    single_use: true,
    binding: {
      plugin_id: "com.homerail.video-cover",
      plugin_version: "1.0.0",
      manifest_digest: "a".repeat(64),
      package_digest: "b".repeat(64),
      context_digest: "c".repeat(64),
      registry_revision: 7,
      permission_revision: 4,
    },
    request_id: "request-video-cover-0001",
    request_digest: "d".repeat(64),
    document_scope: {
      type: "project",
      id: "project-one",
      document_id: "document-one",
    },
    artifact: {
      label: "Generated video cover",
      media_type: "image/png",
      digest: "e".repeat(64),
      size_bytes: 4096,
    },
    issued_at: "2026-07-12T12:00:00.000Z",
    expires_at: "2026-07-12T12:01:00.000Z",
  };
}

describe("Plugin Artifact Broker capability protocol", () => {
  it("accepts one exact content-addressed Tool and document-scope binding", () => {
    const value = claims();
    expect(validateHomerailPluginArtifactWriteCapabilityClaims(value, {
      now_ms: now,
      expected: {
        capability_id: value.capability_id,
        plugin_id: value.binding.plugin_id,
        plugin_version: value.binding.plugin_version,
        request_id: value.request_id,
        request_digest: value.request_digest,
        document_id: value.document_scope.document_id,
        digest: value.artifact.digest,
        media_type: value.artifact.media_type,
        size_bytes: value.artifact.size_bytes,
      },
    })).toMatchObject({ valid: true, errors: [] });
    expect(homerailPluginArtifactCapabilitySigningInput(value)).toBe(
      homerailPluginArtifactCapabilitySigningInput(structuredClone(value)),
    );
  });

  it("rejects scope, package, request, MIME, size, expiry and extension drift", () => {
    const value = claims() as unknown as Record<string, unknown>;
    const unsafe = structuredClone(value) as any;
    unsafe.binding.plugin_id = "../escape";
    unsafe.request_digest = "not-a-digest";
    unsafe.document_scope.document_id = "\u0000outside";
    unsafe.artifact.media_type = "text/html";
    unsafe.artifact.size_bytes = 0;
    unsafe.extra = true;
    expect(validateHomerailPluginArtifactWriteCapabilityClaims(unsafe, { now_ms: now }).valid).toBe(false);

    const expired = claims();
    expect(validateHomerailPluginArtifactWriteCapabilityClaims(expired, {
      now_ms: Date.parse("2026-07-12T12:02:00.000Z"),
    }).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "/expires_at" }),
    ]));
  });
});
