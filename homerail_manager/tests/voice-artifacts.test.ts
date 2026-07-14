import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDefaultWorkspacePath } from "../src/config/env.js";
import {
  publishVoiceArtifact,
  resolveVoiceArtifact,
} from "../src/server/voice-artifacts.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

describe("voice artifact publishing", () => {
  let home: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-artifact-"));
    process.env.HOMERAIL_HOME = home;
  });

  afterEach(() => {
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("publishes a content-addressed image with a persistent browser URL", () => {
    const workspace = getDefaultWorkspacePath();
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "cover.png"), ONE_PIXEL_PNG);

    const published = publishVoiceArtifact({
      session_id: "session-one",
      source_path: "cover.png",
      title: "AI cover",
    });

    expect(published).toMatchObject({
      kind: "image",
      media_type: "image/png",
      size_bytes: ONE_PIXEL_PNG.byteLength,
    });
    expect(published.url).toBe(`/api/voice-agent/sessions/session-one/artifacts/${published.filename}`);
    expect(fs.readFileSync(resolveVoiceArtifact("session-one", published.filename))).toEqual(ONE_PIXEL_PNG);
  });

  it("publishes standalone HTML and reuses the same digest path", () => {
    const workspace = getDefaultWorkspacePath();
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "story.html"), "<!doctype html><title>AI story</title>");

    const first = publishVoiceArtifact({ session_id: "session-two", source_path: "story.html" });
    const second = publishVoiceArtifact({ session_id: "session-two", source_path: "story.html" });

    expect(first).toEqual(second);
    expect(first.kind).toBe("html");
    expect(first.url).toContain("/artifacts/story-");
  });

  it("rejects workspace escapes and disguised images", () => {
    const workspace = getDefaultWorkspacePath();
    fs.mkdirSync(workspace, { recursive: true });
    const outside = path.join(home, "outside.html");
    fs.writeFileSync(outside, "<!doctype html><title>Outside</title>");
    fs.writeFileSync(path.join(workspace, "fake.png"), "not a png");

    expect(() => publishVoiceArtifact({ session_id: "session-three", source_path: outside }))
      .toThrow("outside the project workspace");
    expect(() => publishVoiceArtifact({ session_id: "session-three", source_path: "fake.png" }))
      .toThrow("signature is invalid");
  });
});
