import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildHrpArchive,
  buildSignedHrpArchive,
  canonicalHrpJsonBytes,
  decodeHrpZip,
  encodeHrpZip,
  extractVerifiedHrpArchive,
  HRP_LOCK_FILE,
  HRP_MANIFEST_FILE,
  HRP_SIGNATURE_FILE,
  normalizeHrpPath,
  verifyHrpArchive,
} from "../src/archive.js";

const manifest = Buffer.from('{"manifest_version":1,"id":"com.example.release-notes","version":"1.0.0"}\n');
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function files() {
  return [
    { path: "skills/release/SKILL.md", content: Buffer.from("# Release notes\n") },
    { path: HRP_MANIFEST_FILE, content: manifest },
    { path: "schemas/release.schema.json", content: Buffer.from('{"type":"object"}\n') },
  ];
}

function rewriteArchivePath(archive: Buffer, from: string, to: string): Buffer {
  const fromBytes = Buffer.from(from, "utf8");
  const toBytes = Buffer.from(to, "utf8");
  expect(toBytes.byteLength).toBe(fromBytes.byteLength);
  const rewritten = Buffer.from(archive);
  let matches = 0;
  let cursor = 0;
  while ((cursor = rewritten.indexOf(fromBytes, cursor)) >= 0) {
    toBytes.copy(rewritten, cursor);
    cursor += toBytes.byteLength;
    matches += 1;
  }
  expect(matches).toBe(2); // local and central directory names
  return rewritten;
}

describe("deterministic HRP archive", () => {
  it("produces byte-identical sorted ZIP packages with a complete digest lock", () => {
    const first = buildHrpArchive(files());
    const second = buildHrpArchive([...files()].reverse());
    expect(first.archive.equals(second.archive)).toBe(true);
    expect(first.archive_digest).toBe(second.archive_digest);
    expect(first.lock.files.map((entry) => entry.path)).toEqual([
      HRP_MANIFEST_FILE,
      "schemas/release.schema.json",
      "skills/release/SKILL.md",
    ]);
    const verified = verifyHrpArchive(first.archive);
    expect(verified.archive_digest).toBe(first.archive_digest);
    expect(verified.files.get(HRP_MANIFEST_FILE)?.equals(manifest)).toBe(true);
    expect(verified.files.has(HRP_LOCK_FILE)).toBe(true);
  });

  it("extracts only verified files under a fresh staging root", () => {
    const verified = verifyHrpArchive(buildHrpArchive(files()).archive);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-hrp-extract-"));
    tempRoots.push(root);
    extractVerifiedHrpArchive(verified, root);
    expect(fs.readFileSync(path.join(root, "skills", "release", "SKILL.md"), "utf8"))
      .toBe("# Release notes\n");
    expect(fs.statSync(path.join(root, HRP_LOCK_FILE)).isFile()).toBe(true);
    expect(() => extractVerifiedHrpArchive(verified, root)).toThrow(/empty directory/);
  });

  it("rejects traversal, absolute, Windows, Unicode alias, and portable case collisions", () => {
    for (const unsafe of [
      "../escape", "/absolute", "C:/drive", "folder\\file", "a/./b", "a//b",
      "CON", "assets/NUL.json", "assets/LPT1", "assets/trailing.",
    ]) {
      expect(() => normalizeHrpPath(unsafe)).toThrow();
    }
    expect(() => normalizeHrpPath("cafe\u0301/file.json")).toThrow(/NFC/);
    expect(() => encodeHrpZip([
      { path: "A/file.json", content: Buffer.from("a") },
      { path: "a/FILE.json", content: Buffer.from("b") },
    ])).toThrow(/colliding/);
    expect(() => encodeHrpZip([
      { path: "assets", content: Buffer.from("file") },
      { path: "assets/view.json", content: Buffer.from("nested") },
    ])).toThrow(/prefix collision/);

    for (const collidingPaths of [
      ["A", "a/x.json"],
      ["a/x.json", "A"],
      ["DIR", "dir/File.json"],
      ["dir/File.json", "DIR"],
      ["ROOT/Leaf", "root/leaf/deep.json"],
      ["root/leaf/deep.json", "ROOT/Leaf"],
    ]) {
      expect(() => encodeHrpZip(collidingPaths.map((filePath) => ({
        path: filePath,
        content: Buffer.from(filePath),
      })))).toThrow(/prefix collision/);
    }

    const archive = encodeHrpZip([
      { path: "aa/evil", content: Buffer.from("payload") },
      { path: HRP_MANIFEST_FILE, content: manifest },
    ]);
    const mutated = Buffer.from(archive);
    let cursor = 0;
    while ((cursor = mutated.indexOf("aa/evil", cursor, "utf8")) >= 0) {
      mutated.write("../evil", cursor, "utf8");
      cursor += 7;
    }
    expect(() => decodeHrpZip(mutated)).toThrow(/portable/);
  });

  it("enforces portable UTF-8 byte limits for each segment and complete path", () => {
    expect(normalizeHrpPath("a".repeat(240))).toBe("a".repeat(240));
    expect(() => normalizeHrpPath("a".repeat(256))).toThrow(/segment exceeds 255 UTF-8 bytes/);
    expect(() => normalizeHrpPath(`${"a".repeat(120)}/${"b".repeat(120)}`))
      .toThrow(/path exceeds 240 UTF-8 bytes/);
    expect(() => normalizeHrpPath("é".repeat(128))).toThrow(/segment exceeds 255 UTF-8 bytes/);
  });

  it("rejects case-folded file/directory prefix collisions while decoding in either entry order", () => {
    const prefixFirst = rewriteArchivePath(encodeHrpZip([
      { path: "A", content: Buffer.from("file") },
      { path: "b/x.json", content: Buffer.from("nested") },
    ]), "b/x.json", "a/x.json");
    expect(() => decodeHrpZip(prefixFirst)).toThrow(/prefix collision/);

    const nestedFirst = rewriteArchivePath(encodeHrpZip([
      { path: "A/x.json", content: Buffer.from("nested") },
      { path: "b", content: Buffer.from("file") },
    ]), "b", "a");
    expect(() => decodeHrpZip(nestedFirst)).toThrow(/prefix collision/);

    const multiSegmentPrefixFirst = rewriteArchivePath(encodeHrpZip([
      { path: "DIR", content: Buffer.from("file") },
      { path: "eir/File.json", content: Buffer.from("nested") },
    ]), "eir/File.json", "dir/File.json");
    expect(() => decodeHrpZip(multiSegmentPrefixFirst)).toThrow(/prefix collision/);

    const multiSegmentNestedFirst = rewriteArchivePath(encodeHrpZip([
      { path: "DIR/File.json", content: Buffer.from("nested") },
      { path: "eir", content: Buffer.from("file") },
    ]), "eir", "dir");
    expect(() => decodeHrpZip(multiSegmentNestedFirst)).toThrow(/prefix collision/);
  });

  it("rejects symlinks, CRC corruption, hidden unlocked files, and noncanonical metadata", () => {
    const valid = buildHrpArchive(files()).archive;

    const symlink = Buffer.from(valid);
    const central = symlink.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(central).toBeGreaterThan(0);
    symlink.writeUInt32LE((0o120777 << 16) >>> 0, central + 38);
    expect(() => decodeHrpZip(symlink)).toThrow(/symlinks/);

    const corrupted = Buffer.from(valid);
    const payload = corrupted.indexOf(manifest);
    expect(payload).toBeGreaterThan(0);
    corrupted[payload] ^= 0xff;
    expect(() => decodeHrpZip(corrupted)).toThrow(/CRC/);

    const verified = verifyHrpArchive(valid);
    const hidden = encodeHrpZip([
      ...[...verified.files.entries()].map(([filePath, content]) => ({ path: filePath, content })),
      { path: "hidden/payload.bin", content: Buffer.from("hidden") },
    ]);
    expect(() => verifyHrpArchive(hidden)).toThrow(/exact archive file set/);

    const compressedFlag = Buffer.from(valid);
    compressedFlag.writeUInt16LE(8, 8);
    expect(() => decodeHrpZip(compressedFlag)).toThrow(/deterministic stored files|metadata disagree/);
  });

  it("requires the lock itself to use canonical JSON bytes", () => {
    const valid = buildHrpArchive(files()).archive;
    const decoded = decodeHrpZip(valid);
    const lock = JSON.parse(decoded.get(HRP_LOCK_FILE)!.toString("utf8")) as unknown;
    decoded.set(HRP_LOCK_FILE, Buffer.from(`${JSON.stringify(lock, null, 2)}\n`));
    const noncanonical = encodeHrpZip([...decoded.entries()].map(([filePath, content]) => ({ path: filePath, content })));
    expect(() => verifyHrpArchive(noncanonical)).toThrow(/canonical JSON bytes/);
  });

  it("signs the immutable lock deterministically and resolves publisher trust", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const first = buildSignedHrpArchive(files(), {
      publisher: "Example Publisher",
      private_key: privateKey,
    });
    const second = buildSignedHrpArchive([...files()].reverse(), {
      publisher: "Example Publisher",
      private_key: privateKey,
    });
    expect(first.archive.equals(second.archive)).toBe(true);

    const untrusted = verifyHrpArchive(first.archive, { allow_signature: true });
    expect(untrusted.signature_state).toBe("untrusted");
    expect(untrusted.signature?.statement).toEqual(first.signature);

    const trustEntry = {
      publisher: first.signature.publisher,
      key_id: first.signature.key_id,
      public_key_spki: first.signature.public_key_spki,
      state: "trusted" as const,
    };
    expect(verifyHrpArchive(first.archive, {
      allow_signature: true,
      trust_store: [trustEntry],
      require_trusted_signature: true,
    }).signature_state).toBe("verified");
    expect(verifyHrpArchive(first.archive, {
      allow_signature: true,
      trust_store: [{ ...trustEntry, state: "revoked" }],
    }).signature_state).toBe("revoked");
    expect(() => verifyHrpArchive(first.archive, {
      allow_signature: true,
      trust_store: [{ ...trustEntry, state: "revoked" }],
      require_trusted_signature: true,
    })).toThrow(/requires a trusted publisher signature; received revoked/);
  });

  it("rejects signature tampering, noncanonical metadata, and unsigned trust requirements", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const signed = buildSignedHrpArchive(files(), {
      publisher: "Example Publisher",
      private_key: privateKey,
    });
    const decoded = decodeHrpZip(signed.archive);
    const statement = JSON.parse(decoded.get(HRP_SIGNATURE_FILE)!.toString("utf8")) as Record<string, unknown>;
    statement.signature = Buffer.alloc(64, 0xa5).toString("base64url");
    decoded.set(HRP_SIGNATURE_FILE, canonicalHrpJsonBytes(statement));
    const tampered = encodeHrpZip([...decoded.entries()].map(([filePath, content]) => ({ path: filePath, content })));
    expect(() => verifyHrpArchive(tampered, { allow_signature: true })).toThrow(/signature is invalid/);

    const noncanonicalFiles = decodeHrpZip(signed.archive);
    const validStatement = JSON.parse(noncanonicalFiles.get(HRP_SIGNATURE_FILE)!.toString("utf8")) as unknown;
    noncanonicalFiles.set(HRP_SIGNATURE_FILE, Buffer.from(`${JSON.stringify(validStatement, null, 2)}\n`));
    const noncanonical = encodeHrpZip([...noncanonicalFiles.entries()]
      .map(([filePath, content]) => ({ path: filePath, content })));
    expect(() => verifyHrpArchive(noncanonical, { allow_signature: true })).toThrow(/canonical JSON bytes/);

    expect(() => verifyHrpArchive(buildHrpArchive(files()).archive, {
      require_trusted_signature: true,
    })).toThrow(/received unsigned/);
  });

  it("fails boundedly for oversized files and entry counts", () => {
    expect(() => buildHrpArchive([
      { path: HRP_MANIFEST_FILE, content: manifest },
      { path: "assets/huge.bin", content: Buffer.alloc(512 * 1024 + 1) },
    ])).toThrow(/size limit/);
    const many = Array.from({ length: 257 }, (_, index) => ({
      path: `assets/file-${String(index).padStart(3, "0")}.bin`,
      content: Buffer.alloc(0),
    }));
    expect(() => encodeHrpZip(many)).toThrow(/file count/);
    expect(() => buildHrpArchive([
      { path: HRP_MANIFEST_FILE, content: manifest },
      { path: HRP_SIGNATURE_FILE, content: Buffer.from("{}") },
    ])).toThrow(/metadata/);
  });
});
