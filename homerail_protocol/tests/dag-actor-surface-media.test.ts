import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DAG_ACTOR_SURFACE_MEDIA_SCHEMA_VERSION,
  validateDagActorSurfaceMediaV1,
  type DagActorSurfaceMediaV1,
} from "../src/index.js";

function media(bytes = Buffer.from("image")): DagActorSurfaceMediaV1 {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    schema_version: DAG_ACTOR_SURFACE_MEDIA_SCHEMA_VERSION,
    run_id: "run-1",
    node_id: "research",
    session_id: "session-1",
    round_id: "round-1",
    actor_id: "actor-research",
    generation: 1,
    lease_generation: 2,
    artifact_name: `actor-media-${sha256}.webp`,
    media_type: "image/webp",
    size_bytes: bytes.byteLength,
    sha256,
    content_base64: bytes.toString("base64"),
  };
}

describe("DagActorSurfaceMediaV1", () => {
  it("accepts canonical bounded media and rejects extra identity", () => {
    expect(validateDagActorSurfaceMediaV1(media())).toEqual({ valid: true, errors: [] });
    expect(validateDagActorSurfaceMediaV1({ ...media(), source_url: "https://private.example/image" }).valid)
      .toBe(false);
  });

  it("binds artifact identity to the digest, type, and declared size", () => {
    expect(validateDagActorSurfaceMediaV1({ ...media(), artifact_name: "actor-media-bad.webp" }).valid)
      .toBe(false);
    expect(validateDagActorSurfaceMediaV1({ ...media(), size_bytes: 2 })).toMatchObject({
      valid: false,
      errors: [{ keyword: "mediaSize" }],
    });
    expect(validateDagActorSurfaceMediaV1({ ...media(), media_type: "text/html" }).valid).toBe(false);
  });
});
