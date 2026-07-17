import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import {
  HOMERAIL_MANAGER_TURN_ENVELOPE_REQUIRED_ENV,
  HOMERAIL_MANAGER_TURN_KEY_ID_ENV,
  HOMERAIL_MANAGER_TURN_PUBLIC_KEY_ENV,
  managerAgentTurnClaimsSigningInput,
  managerAgentTurnPayloadDigestInput,
  managerAgentTurnScopeFromPayload,
  validateManagerAgentTurnEnvelope,
  type ManagerAgentTurnEnvelopeV1,
  type ManagerAgentTurnRuntimePlacementV1,
} from "homerail-protocol";

export class ManagerAgentTurnAuthenticationError extends Error {
  readonly statusCode = 401;

  constructor(message: string) {
    super(message);
    this.name = "ManagerAgentTurnAuthenticationError";
  }
}

function requiredByEnvironment(env: NodeJS.ProcessEnv): boolean {
  const value = env[HOMERAIL_MANAGER_TURN_ENVELOPE_REQUIRED_ENV];
  return env.MANAGER_AGENT_MODE === "1"
    || value === "1"
    || value?.toLowerCase() === "true"
    || Boolean(env[HOMERAIL_MANAGER_TURN_PUBLIC_KEY_ENV]);
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function expectedPlacement(env: NodeJS.ProcessEnv): ManagerAgentTurnRuntimePlacementV1 {
  const placement = env.HOMERAIL_MANAGER_AGENT_RUNTIME_PLACEMENT;
  if (placement === "host_shell") return placement;
  throw new Error("Manager Agent turn verification requires the host-shell placement");
}

function publicKeyFromEnvironment(env: NodeJS.ProcessEnv): KeyObject {
  const encoded = nonEmpty(env[HOMERAIL_MANAGER_TURN_PUBLIC_KEY_ENV]);
  if (!encoded || encoded.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error("Manager Agent turn public key is missing or malformed");
  }
  let key: KeyObject;
  try {
    key = createPublicKey({ key: Buffer.from(encoded, "base64url"), format: "der", type: "spki" });
  } catch {
    throw new Error("Manager Agent turn public key is invalid");
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Manager Agent turn public key must use Ed25519");
  return key;
}

export class ManagerAgentTurnEnvelopeVerifier {
  readonly #required: boolean;
  readonly #publicKey?: KeyObject;
  readonly #keyId?: string;
  readonly #placement?: ManagerAgentTurnRuntimePlacementV1;
  readonly #workerId?: string;
  readonly #projectId: string | null;
  readonly #consumed = new Map<string, number>();

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.#required = requiredByEnvironment(env);
    this.#projectId = nonEmpty(env.PROJECT_ID) ?? null;
    if (!this.#required) return;
    this.#publicKey = publicKeyFromEnvironment(env);
    this.#keyId = nonEmpty(env[HOMERAIL_MANAGER_TURN_KEY_ID_ENV]);
    this.#workerId = nonEmpty(env.HOMERAIL_WORKER_ID) ?? nonEmpty(env.WORKER_ID);
    this.#placement = expectedPlacement(env);
    if (!this.#keyId || !this.#workerId) {
      throw new Error("Manager Agent turn verification requires key and Worker identities");
    }
  }

  get required(): boolean {
    return this.#required;
  }

  authenticate(payload: Record<string, unknown>, now: Date = new Date()): ManagerAgentTurnEnvelopeV1 | undefined {
    if (!this.#required) return undefined;
    const raw = payload.turn_envelope;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ManagerAgentTurnAuthenticationError("Manager-signed turn envelope is required");
    }
    const expectedScope = managerAgentTurnScopeFromPayload(payload, {
      runtime_placement: this.#placement!,
      worker_id: this.#workerId!,
    });
    if (expectedScope.project_id !== this.#projectId) {
      throw new ManagerAgentTurnAuthenticationError("Manager Agent turn project scope does not match this Worker");
    }
    const payloadDigest = createHash("sha256")
      .update(managerAgentTurnPayloadDigestInput(payload))
      .digest("hex");
    const validation = validateManagerAgentTurnEnvelope(raw, {
      payload,
      payload_digest: payloadDigest,
      expected_scope: expectedScope,
      now_ms: now.getTime(),
    });
    if (!validation.valid || !validation.value) {
      throw new ManagerAgentTurnAuthenticationError(`Invalid Manager Agent turn envelope: ${JSON.stringify(validation.errors)}`);
    }
    const envelope = validation.value;
    if (envelope.claims.key_id !== this.#keyId) {
      throw new ManagerAgentTurnAuthenticationError("Manager Agent turn signing key is not trusted");
    }
    let signature: Buffer;
    try {
      signature = Buffer.from(envelope.signature, "base64url");
    } catch {
      throw new ManagerAgentTurnAuthenticationError("Manager Agent turn signature is malformed");
    }
    if (!verify(
      null,
      Buffer.from(managerAgentTurnClaimsSigningInput(envelope.claims), "utf8"),
      this.#publicKey!,
      signature,
    )) throw new ManagerAgentTurnAuthenticationError("Manager Agent turn signature verification failed");

    const nowMs = now.getTime();
    for (const [turnId, expiresAt] of this.#consumed) {
      if (expiresAt <= nowMs) this.#consumed.delete(turnId);
    }
    if (this.#consumed.has(envelope.claims.turn_id)) {
      throw new ManagerAgentTurnAuthenticationError("Manager Agent turn envelope was already consumed");
    }
    // Keep the replay marker through the same clock-skew window accepted by
    // protocol validation; otherwise a just-expired envelope could be reused.
    this.#consumed.set(envelope.claims.turn_id, Date.parse(envelope.claims.expires_at) + 10_000);
    return envelope;
  }
}
