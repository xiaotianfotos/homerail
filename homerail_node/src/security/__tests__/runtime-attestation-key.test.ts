import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NodeRuntimeAttestationAuthority } from "../runtime-attestation-key.js";

describe("NodeRuntimeAttestationAuthority key storage", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-node-attestation-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("creates and reuses a regular Ed25519 key on the current platform", () => {
    const keyFile = path.join(root, "keys", "node.ed25519.pem");
    const first = new NodeRuntimeAttestationAuthority({ node_id: "node-test", key_file: keyFile });
    const second = new NodeRuntimeAttestationAuthority({ node_id: "node-test", key_file: keyFile });

    expect(second.publicIdentity()).toEqual(first.publicIdentity());
    expect(fs.lstatSync(keyFile).isFile()).toBe(true);
    expect(fs.lstatSync(path.dirname(keyFile)).isDirectory()).toBe(true);
  });

  it.skipIf(typeof process.getuid !== "function")("rejects a POSIX-readable key", () => {
    const keyFile = path.join(root, "keys", "node.ed25519.pem");
    new NodeRuntimeAttestationAuthority({ node_id: "node-test", key_file: keyFile });
    fs.chmodSync(keyFile, 0o644);

    expect(() => new NodeRuntimeAttestationAuthority({ node_id: "node-test", key_file: keyFile }))
      .toThrow(/must not be group\/world accessible/);
  });

  it.skipIf(typeof process.getuid !== "function")("rejects a POSIX-accessible key parent", () => {
    const parent = path.join(root, "keys");
    fs.mkdirSync(parent, { mode: 0o700 });
    fs.chmodSync(parent, 0o755);

    expect(() => new NodeRuntimeAttestationAuthority({
      node_id: "node-test",
      key_file: path.join(parent, "node.ed25519.pem"),
    })).toThrow(/parent must not be group\/world accessible/);
  });
});
