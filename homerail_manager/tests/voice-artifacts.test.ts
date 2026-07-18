import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDefaultWorkspacePath } from "../src/config/env.js";
import { closeDb, getDb } from "../src/persistence/db.js";
import {
  publishVoiceArtifact,
  resolveVoiceArtifact,
  resolveVoiceArtifactRevision,
  VoiceArtifactRevisionConflictError,
} from "../src/server/voice-artifacts.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

describe("voice artifact publishing", () => {
  let home: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    closeDb();
    oldHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-artifact-"));
    process.env.HOMERAIL_HOME = home;
  });

  afterEach(() => {
    closeDb();
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
      revision: 1,
      kind: "image",
      media_type: "image/png",
      size_bytes: ONE_PIXEL_PNG.byteLength,
    });
    expect(published.url).toBe(`/api/voice-agent/sessions/session-one/artifacts/${published.filename}`);
    expect(published.preview_url).toBe(`${published.stable_url}?revision=1`);
    expect(published.stable_url).toContain(`/artifacts/by-id/${published.artifact_id}/preview`);
    expect(fs.readFileSync(resolveVoiceArtifact("session-one", published.filename))).toEqual(ONE_PIXEL_PNG);
  });

  it("publishes standalone HTML and reuses the same immutable digest path", () => {
    const workspace = getDefaultWorkspacePath();
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "story.html"), "<!doctype html><title>AI story</title>");

    const first = publishVoiceArtifact({ session_id: "session-two", source_path: "story.html" });
    const second = publishVoiceArtifact({ session_id: "session-two", source_path: "story.html" });

    expect(first.artifact_id).not.toBe(second.artifact_id);
    expect(first.filename).toBe(second.filename);
    expect(first.digest).toBe(second.digest);
    expect(first.kind).toBe("html");
    expect(first.url).toContain("/artifacts/story-");
  });

  it("updates one stable Artifact with immutable revisions and refreshable preview URLs", () => {
    const workspace = getDefaultWorkspacePath();
    fs.mkdirSync(workspace, { recursive: true });
    const source = path.join(workspace, "dashboard.html");
    fs.writeFileSync(source, "<!doctype html><button id=counter>First</button>");

    const first = publishVoiceArtifact({
      session_id: "session-stable",
      source_path: "dashboard.html",
      artifact_id: "live-dashboard",
      expected_revision: 0,
    });
    fs.writeFileSync(source, "<!doctype html><button id=counter>Second</button>");
    const second = publishVoiceArtifact({
      session_id: "session-stable",
      source_path: "dashboard.html",
      artifact_id: first.artifact_id,
      expected_revision: first.revision,
    });

    expect(second.artifact_id).toBe(first.artifact_id);
    expect(second.revision).toBe(2);
    expect(second.stable_url).toBe(first.stable_url);
    expect(second.preview_url).not.toBe(first.preview_url);
    expect(fs.readFileSync(resolveVoiceArtifactRevision("session-stable", "live-dashboard", 1).path, "utf8"))
      .toContain("First");
    expect(fs.readFileSync(resolveVoiceArtifactRevision("session-stable", "live-dashboard").path, "utf8"))
      .toContain("Second");
  });

  it("rejects stale or unguarded updates without changing the current revision", () => {
    const workspace = getDefaultWorkspacePath();
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "status.html"), "<!doctype html><p>one</p>");
    const first = publishVoiceArtifact({
      session_id: "session-cas",
      source_path: "status.html",
      artifact_id: "status",
    });
    fs.writeFileSync(path.join(workspace, "status.html"), "<!doctype html><p>two</p>");

    expect(() => publishVoiceArtifact({
      session_id: "session-cas",
      source_path: "status.html",
      artifact_id: "status",
    })).toThrow(VoiceArtifactRevisionConflictError);
    expect(() => publishVoiceArtifact({
      session_id: "session-cas",
      source_path: "status.html",
      artifact_id: "status",
      expected_revision: 0,
    })).toThrow("revision conflict");
    expect(resolveVoiceArtifactRevision("session-cas", "status").revision).toBe(first.revision);
  });

  it("installs the versioned Artifact schema with immutable revision rows", () => {
    const workspace = getDefaultWorkspacePath();
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "schema.html"), "<!doctype html><p>schema</p>");
    const artifact = publishVoiceArtifact({ session_id: "session-schema", source_path: "schema.html" });

    const db = getDb();
    expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 32 });
    expect(() => db.prepare(`
      UPDATE voice_artifact_revisions SET title = 'changed'
      WHERE session_id = ? AND artifact_id = ? AND revision = 1
    `).run("session-schema", artifact.artifact_id)).toThrow("append-only");
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
