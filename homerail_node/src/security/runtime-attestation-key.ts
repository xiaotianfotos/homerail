/**
 * Persistent Node-owned Ed25519 identity for Plugin Runtime measurements.
 * Private key bytes never leave this module or the Node host.
 * @version 0.1.0
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  homerailPluginRuntimeSandboxAttestationSigningInput,
  validateHomerailPluginRuntimeSandboxAttestation,
  type HomerailPluginRuntimeSandboxAttestationClaimsV1,
  type HomerailPluginRuntimeSandboxAttestationV1,
} from "homerail-protocol";

const MAX_KEY_BYTES = 16 * 1024;

export interface NodeRuntimeAttestationPublicIdentity {
  node_id: string;
  key_id: string;
  public_key: string;
}

function assertPosixPrivateOwnership(stat: fs.Stats, subject: "key" | "parent"): void {
  if (typeof process.getuid !== "function") return;
  const label = subject === "key" ? "Node attestation key" : "Node attestation key parent";
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be group/world accessible`);
  }
  if (stat.uid !== process.getuid()) {
    throw new Error(`${label} is owned by another user`);
  }
}

function assertSecureFile(file: string): fs.Stats {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Node attestation key must be a regular file");
  assertPosixPrivateOwnership(stat, "key");
  if (stat.size < 1 || stat.size > MAX_KEY_BYTES) throw new Error("Node attestation key size is invalid");
  return stat;
}

function ensureSecureParent(parent: string): void {
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(parent);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Node attestation key parent must be a real directory");
  assertPosixPrivateOwnership(stat, "parent");
}

export function nodeRuntimeAttestationKeyPath(
  nodeId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env.HOMERAIL_NODE_ATTESTATION_KEY_FILE?.trim();
  if (explicit) return path.resolve(explicit);
  const home = env.HOMERAIL_HOME?.trim() || path.join(os.homedir(), ".homerail");
  const safeNodeId = nodeId.replace(/[^A-Za-z0-9_.-]/g, "-");
  return path.join(path.resolve(home), "node-keys", `${safeNodeId}.ed25519.pem`);
}

function loadOrCreatePrivateKey(file: string): KeyObject {
  const parent = path.dirname(file);
  ensureSecureParent(parent);
  if (!fs.existsSync(file)) {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      fs.writeFileSync(fd, pem, { encoding: "utf8" });
      fs.fsyncSync(fd);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  assertSecureFile(file);
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  let bytes: Buffer;
  try {
    const before = fs.fstatSync(fd);
    bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
      throw new Error("Node attestation key changed while opening");
    }
  } finally {
    fs.closeSync(fd);
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(bytes);
  } catch {
    throw new Error("Node attestation key is invalid");
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Node attestation key must use Ed25519");
  return key;
}

export class NodeRuntimeAttestationAuthority {
  readonly #nodeId: string;
  readonly #privateKey: KeyObject;
  readonly #identity: NodeRuntimeAttestationPublicIdentity;

  constructor(input: { node_id: string; key_file?: string; env?: NodeJS.ProcessEnv }) {
    this.#nodeId = input.node_id;
    const file = input.key_file ?? nodeRuntimeAttestationKeyPath(input.node_id, input.env);
    this.#privateKey = loadOrCreatePrivateKey(file);
    const publicDer = createPublicKey(this.#privateKey).export({ format: "der", type: "spki" }) as Buffer;
    this.#identity = Object.freeze({
      node_id: input.node_id,
      key_id: `node_${createHash("sha256").update(publicDer).digest("hex").slice(0, 24)}`,
      public_key: publicDer.toString("base64url"),
    });
  }

  publicIdentity(): NodeRuntimeAttestationPublicIdentity {
    return { ...this.#identity };
  }

  issue(claims: HomerailPluginRuntimeSandboxAttestationClaimsV1, now: Date = new Date()): HomerailPluginRuntimeSandboxAttestationV1 {
    if (claims.node_id !== this.#nodeId || claims.key_id !== this.#identity.key_id) {
      throw new Error("Runtime attestation claims do not match the Node signing identity");
    }
    const value = {
      claims: structuredClone(claims),
      signature: sign(
        null,
        Buffer.from(homerailPluginRuntimeSandboxAttestationSigningInput(claims), "utf8"),
        this.#privateKey,
      ).toString("base64url"),
    };
    const validation = validateHomerailPluginRuntimeSandboxAttestation(value, { now_ms: now.getTime(), clock_skew_ms: 0 });
    if (!validation.valid || !validation.value) {
      throw new Error(`Node produced invalid Runtime attestation: ${JSON.stringify(validation.errors)}`);
    }
    return validation.value;
  }
}
