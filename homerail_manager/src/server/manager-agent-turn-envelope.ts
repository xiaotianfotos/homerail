import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  HOMERAIL_MANAGER_TURN_ENVELOPE_REQUIRED_ENV,
  HOMERAIL_MANAGER_TURN_KEY_ID_ENV,
  HOMERAIL_MANAGER_TURN_PUBLIC_KEY_ENV,
  MANAGER_AGENT_TURN_MAX_TTL_MS,
  managerAgentTurnClaimsSigningInput,
  managerAgentTurnPayloadDigestInput,
  managerAgentTurnScopeFromPayload,
  validateManagerAgentTurnEnvelope,
  type ManagerAgentTurnEnvelopeV1,
  type ManagerAgentTurnRuntimePlacementV1,
} from "homerail-protocol";

const DEFAULT_TTL_MS = 5 * 60_000;
const MAX_CREDENTIAL_BYTES = 32 * 1024;

export const DEFAULT_MANAGER_AGENT_API_SCOPES = Object.freeze([
  "GET:/api/dag/patterns",
  "GET:/api/dag/patterns/*",
  "GET:/api/projects",
  "GET:/api/runs/*/status",
  "GET:/api/skills",
  "GET:/api/skills/*",
  "POST:/api/dag/patterns/*/instantiate",
  "POST:/api/dag/workflows/sync",
  "POST:/api/plugins/tools/invoke",
  "POST:/api/projects/*/changes",
  "POST:/api/runs/*/invoke",
  "POST:/api/runs/create-and-run",
  "POST:/api/voice-agent/widget-files/*",
  "POST:/api/voice-agent/sessions/*/artifacts/publish",
] as const);

export class ManagerAgentTurnEnvelopeAuthority {
  readonly #privateKey: KeyObject;
  readonly #publicKeyDer: Buffer;
  readonly #keyId: string;
  readonly #issued = new Map<string, ManagerAgentTurnEnvelopeV1>();

  constructor(input?: { private_key?: KeyObject; key_id?: string }) {
    const generated = input?.private_key
      ? { privateKey: input.private_key, publicKey: undefined }
      : generateKeyPairSync("ed25519");
    this.#privateKey = generated.privateKey;
    const publicKey = generated.publicKey ?? createPublicKey(this.#privateKey);
    this.#publicKeyDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    this.#keyId = input?.key_id ?? `manager_${createHash("sha256").update(this.#publicKeyDer).digest("hex").slice(0, 24)}`;
  }

  get key_id(): string {
    return this.#keyId;
  }

  workerEnvironment(): Record<string, string> {
    return {
      [HOMERAIL_MANAGER_TURN_PUBLIC_KEY_ENV]: this.#publicKeyDer.toString("base64url"),
      [HOMERAIL_MANAGER_TURN_KEY_ID_ENV]: this.#keyId,
      [HOMERAIL_MANAGER_TURN_ENVELOPE_REQUIRED_ENV]: "1",
    };
  }

  issue(input: {
    payload: Record<string, unknown>;
    target: { runtime_placement: ManagerAgentTurnRuntimePlacementV1; worker_id: string };
    now?: Date;
    ttl_ms?: number;
    turn_id?: string;
  }): ManagerAgentTurnEnvelopeV1 {
    if (Object.prototype.hasOwnProperty.call(input.payload, "turn_envelope")) {
      throw new Error("Manager Agent payload already contains a turn envelope");
    }
    const ttl = input.ttl_ms ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > MANAGER_AGENT_TURN_MAX_TTL_MS) {
      throw new Error("Manager Agent turn envelope TTL is invalid");
    }
    const now = input.now ?? new Date();
    const payloadDigest = createHash("sha256")
      .update(managerAgentTurnPayloadDigestInput(input.payload))
      .digest("hex");
    const claims = {
      turn_envelope_version: 1 as const,
      issuer: "homerail-manager" as const,
      audience: "homerail-manager-agent-worker" as const,
      key_id: this.#keyId,
      turn_id: input.turn_id ?? `turn_${randomBytes(16).toString("hex")}`,
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ttl).toISOString(),
      payload_digest: payloadDigest,
      scope: managerAgentTurnScopeFromPayload(input.payload, input.target),
    };
    const signature = sign(
      null,
      Buffer.from(managerAgentTurnClaimsSigningInput(claims), "utf8"),
      this.#privateKey,
    ).toString("base64url");
    const envelope: ManagerAgentTurnEnvelopeV1 = { claims, signature };
    const validation = validateManagerAgentTurnEnvelope(envelope, {
      payload: input.payload,
      payload_digest: payloadDigest,
      expected_scope: claims.scope,
      now_ms: now.getTime(),
      clock_skew_ms: 0,
    });
    if (!validation.valid || !validation.value) {
      throw new Error(`Manager produced an invalid Agent turn envelope: ${JSON.stringify(validation.errors)}`);
    }
    this.#prune(now.getTime());
    this.#issued.set(validation.value.claims.turn_id, structuredClone(validation.value));
    return validation.value;
  }

  seal(input: {
    payload: Record<string, unknown>;
    target: { runtime_placement: ManagerAgentTurnRuntimePlacementV1; worker_id: string };
    now?: Date;
    ttl_ms?: number;
    turn_id?: string;
  }): Record<string, unknown> {
    const payload = {
      ...structuredClone(input.payload),
      manager_api_scopes: [...DEFAULT_MANAGER_AGENT_API_SCOPES],
    };
    return {
      ...payload,
      turn_envelope: this.issue({ ...input, payload }),
    };
  }

  credential(envelope: ManagerAgentTurnEnvelopeV1): string {
    return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
  }

  authorizeApiRequest(input: {
    credential: string;
    method: string;
    pathname: string;
    now?: Date;
  }): boolean {
    if (!input.credential || Buffer.byteLength(input.credential, "utf8") > MAX_CREDENTIAL_BYTES) return false;
    let decoded: Buffer;
    try {
      decoded = Buffer.from(input.credential, "base64url");
    } catch {
      return false;
    }
    if (decoded.toString("base64url") !== input.credential) return false;
    let envelope: ManagerAgentTurnEnvelopeV1;
    try {
      envelope = JSON.parse(decoded.toString("utf8")) as ManagerAgentTurnEnvelopeV1;
    } catch {
      return false;
    }
    const now = input.now ?? new Date();
    this.#prune(now.getTime());
    const issued = envelope?.claims?.turn_id ? this.#issued.get(envelope.claims.turn_id) : undefined;
    if (!issued || !isDeepStrictEqual(issued, envelope)) return false;
    if (
      envelope.claims.key_id !== this.#keyId
      || Date.parse(envelope.claims.issued_at) > now.getTime() + 10_000
      || Date.parse(envelope.claims.expires_at) <= now.getTime()
      || !verify(
        null,
        Buffer.from(managerAgentTurnClaimsSigningInput(envelope.claims), "utf8"),
        createPublicKey(this.#privateKey),
        Buffer.from(envelope.signature, "base64url"),
      )
    ) return false;
    const method = input.method.toUpperCase();
    return envelope.claims.scope.manager_api_scopes.some((scope) => apiScopeMatches(scope, method, input.pathname));
  }

  #prune(nowMs: number): void {
    for (const [turnId, envelope] of this.#issued) {
      if (Date.parse(envelope.claims.expires_at) <= nowMs) this.#issued.delete(turnId);
    }
  }
}

function apiScopeMatches(scope: string, method: string, pathname: string): boolean {
  const split = scope.indexOf(":");
  if (split < 1 || scope.slice(0, split) !== method) return false;
  const pattern = scope.slice(split + 1).split("/");
  const actual = pathname.split("/");
  return pattern.length === actual.length
    && pattern.every((segment, index) => segment === "*" ? Boolean(actual[index]) : segment === actual[index]);
}

let authority: ManagerAgentTurnEnvelopeAuthority | undefined;

export function getManagerAgentTurnEnvelopeAuthority(): ManagerAgentTurnEnvelopeAuthority {
  authority ??= new ManagerAgentTurnEnvelopeAuthority();
  return authority;
}
