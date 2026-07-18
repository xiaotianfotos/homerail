import { describe, expect, it } from "vitest";
import { isSafeGenerativeUiPreviewUri } from "../src/index.js";

const sha256 = "a".repeat(64);

describe("generative UI preview artifact URIs", () => {
  it("accepts the bounded DAG Actor media broker path", () => {
    expect(isSafeGenerativeUiPreviewUri(
      `/api/runs/run-01.round.2/artifacts/actor-media-${sha256}.webp/content`,
    )).toBe(true);
  });

  it("accepts stable, revision-addressed voice Artifact previews", () => {
    expect(isSafeGenerativeUiPreviewUri(
      "/api/voice-agent/sessions/session-one/artifacts/by-id/live-dashboard/preview?revision=2",
    )).toBe(true);
  });

  it.each([
    "/api/voice-agent/sessions/session-one/artifacts/by-id/live-dashboard/preview/extra",
    "/api/voice-agent/sessions/session-one/artifacts/by-id/../preview?revision=2",
    "/api/voice-agent/sessions/session-one/artifacts/by-id/live-dashboard/preview?revision=2\nscript",
  ])("rejects an unsafe stable voice Artifact path: %s", (uri) => {
    expect(isSafeGenerativeUiPreviewUri(uri)).toBe(false);
  });

  it.each([
    `/api/runs/run-01/artifacts/actor-media-${sha256}.webp`,
    `/api/runs/run-01/artifacts/actor-media-${sha256}.svg/content`,
    `/api/runs/run-01/artifacts/not-actor-media-${sha256}.webp/content`,
    `/api/runs/run-01/artifacts/actor-media-${sha256}.webp/content/extra`,
    `/api/runs/run-01/artifacts/actor-media-${sha256}.webp/content?download=1`,
    `/api/runs/run%2Fother/artifacts/actor-media-${sha256}.webp/content`,
    `/api/runs/run:other/artifacts/actor-media-${sha256}.webp/content`,
    `/api/runs/../artifacts/actor-media-${sha256}.webp/content`,
  ])("rejects an unsafe or non-canonical DAG media path: %s", (uri) => {
    expect(isSafeGenerativeUiPreviewUri(uri)).toBe(false);
  });
});
