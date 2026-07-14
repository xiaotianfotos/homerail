import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  GenerativeUiDocumentScopeV1,
  HomerailPluginModality,
  HomerailPluginTurnContextV1,
} from "homerail-protocol";
import type { GenerativeUiMode } from "../generative-ui/mode.js";
import { assemblePluginTurnContext, selectPluginTurnContext } from "./context-assembler.js";

const PREFIX = "hrtoolturn1";
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_TTL_MS = 15 * 60_000;

export interface PluginToolTurnClaimsV1 {
  version: 1;
  turn_id: string;
  context_digest: string;
  capability_ids: string[];
  modality: HomerailPluginModality;
  scope: GenerativeUiDocumentScopeV1;
  generative_ui_mode: Exclude<GenerativeUiMode, "off">;
  document_purpose: "canonical" | "legacy_widget_shadow";
  issued_at: string;
  expires_at: string;
}

function signature(secret: Buffer, payload: string): Buffer {
  return createHmac("sha256", secret).update(`${PREFIX}.${payload}`, "utf8").digest();
}

function capabilityIds(context: HomerailPluginTurnContextV1): string[] {
  return [...new Set([
    ...context.skills.flatMap((entry) => entry.capability_ids),
    ...context.tools.flatMap((entry) => entry.capability_ids),
    ...context.actions.flatMap((entry) => entry.capability_ids),
  ])].sort();
}

function assertClaims(value: unknown): asserts value is PluginToolTurnClaimsV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Plugin Tool turn token claims are invalid");
  const claims = value as Record<string, unknown>;
  const keys = [
    "version", "turn_id", "context_digest", "capability_ids", "modality", "scope",
    "generative_ui_mode", "document_purpose", "issued_at", "expires_at",
  ];
  if (Object.keys(claims).sort().join("\0") !== [...keys].sort().join("\0")) throw new Error("Plugin Tool turn token claims are invalid");
  if (claims.version !== 1 || typeof claims.turn_id !== "string" || !/^[A-Za-z0-9._:-]{8,160}$/.test(claims.turn_id)) {
    throw new Error("Plugin Tool turn token identity is invalid");
  }
  if (typeof claims.context_digest !== "string" || !/^[a-f0-9]{64}$/.test(claims.context_digest)) {
    throw new Error("Plugin Tool turn context digest is invalid");
  }
  if (
    !Array.isArray(claims.capability_ids)
    || claims.capability_ids.some((entry) => typeof entry !== "string")
    || claims.capability_ids.some((entry, index, values) => index > 0 && entry <= values[index - 1])
  ) throw new Error("Plugin Tool turn capabilities are invalid");
  if (!["voice", "text", "touch", "gamepad", "automation"].includes(String(claims.modality))) {
    throw new Error("Plugin Tool turn modality is invalid");
  }
  if (!claims.scope || typeof claims.scope !== "object" || Array.isArray(claims.scope)) throw new Error("Plugin Tool turn scope is invalid");
  const scope = claims.scope as Record<string, unknown>;
  if (scope.type !== "voice_session" || typeof scope.id !== "string" || !scope.id) {
    throw new Error("Plugin Tool turn scope is invalid");
  }
  if (
    !["shadow", "prefer"].includes(String(claims.generative_ui_mode))
    || !["canonical", "legacy_widget_shadow"].includes(String(claims.document_purpose))
    || (claims.generative_ui_mode === "prefer") !== (claims.document_purpose === "canonical")
  ) throw new Error("Plugin Tool turn document authority is invalid");
  if (typeof claims.issued_at !== "string" || typeof claims.expires_at !== "string") throw new Error("Plugin Tool turn timestamps are invalid");
}

export class PluginToolTurnTokenAuthority {
  readonly #secret: Buffer;

  constructor(secret: Buffer | string) {
    this.#secret = Buffer.isBuffer(secret) ? Buffer.from(secret) : Buffer.from(secret, "utf8");
    if (this.#secret.byteLength < 32) throw new Error("Plugin Tool turn secret is too short");
  }

  issue(input: {
    context: HomerailPluginTurnContextV1;
    modality: HomerailPluginModality;
    scope: GenerativeUiDocumentScopeV1;
    generative_ui_mode: Exclude<GenerativeUiMode, "off">;
    now?: Date;
    ttl_ms?: number;
  }): { token: string; claims: PluginToolTurnClaimsV1 } {
    const now = input.now ?? new Date();
    const ttl = input.ttl_ms ?? 10 * 60_000;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > MAX_TTL_MS) throw new Error("Plugin Tool turn TTL is invalid");
    if (input.scope.type !== "voice_session" || !input.scope.id) {
      throw new Error("M5 Plugin Tool turns require a bound voice session scope");
    }
    const ids = capabilityIds(input.context);
    const current = selectPluginTurnContext(assemblePluginTurnContext(), ids, input.context.permission_revision);
    if (current.context_digest !== input.context.context_digest) {
      throw new Error("Plugin Tool turn context is not the exact current routed selection");
    }
    const claims: PluginToolTurnClaimsV1 = {
      version: 1,
      turn_id: `turn_${randomBytes(18).toString("hex")}`,
      context_digest: current.context_digest,
      capability_ids: ids,
      modality: input.modality,
      scope: structuredClone(input.scope),
      generative_ui_mode: input.generative_ui_mode,
      document_purpose: input.generative_ui_mode === "prefer" ? "canonical" : "legacy_widget_shadow",
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ttl).toISOString(),
    };
    const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const token = `${PREFIX}.${payload}.${signature(this.#secret, payload).toString("base64url")}`;
    if (Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) throw new Error("Plugin Tool turn token is too large");
    return { token, claims };
  }

  verify(input: { token: string; now?: Date }): {
    claims: PluginToolTurnClaimsV1;
    context: HomerailPluginTurnContextV1;
  } {
    if (Buffer.byteLength(input.token, "utf8") > MAX_TOKEN_BYTES) throw new Error("Plugin Tool turn token is too large");
    const parts = input.token.split(".");
    if (parts.length !== 3 || parts[0] !== PREFIX || !parts[1] || !parts[2]) throw new Error("Plugin Tool turn token format is invalid");
    let supplied: Buffer;
    let claimsValue: unknown;
    try {
      const payloadBytes = Buffer.from(parts[1], "base64url");
      supplied = Buffer.from(parts[2], "base64url");
      if (payloadBytes.toString("base64url") !== parts[1] || supplied.toString("base64url") !== parts[2]) throw new Error("noncanonical");
      claimsValue = JSON.parse(payloadBytes.toString("utf8"));
    } catch {
      throw new Error("Plugin Tool turn token encoding is invalid");
    }
    const expected = signature(this.#secret, parts[1]);
    if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
      throw new Error("Plugin Tool turn token signature is invalid");
    }
    assertClaims(claimsValue);
    const claims = claimsValue;
    const now = (input.now ?? new Date()).getTime();
    const issued = Date.parse(claims.issued_at);
    const expires = Date.parse(claims.expires_at);
    if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued || expires - issued > MAX_TTL_MS || now < issued || now >= expires) {
      throw new Error("Plugin Tool turn token is expired or not active");
    }
    const context = selectPluginTurnContext(assemblePluginTurnContext(), claims.capability_ids);
    if (context.context_digest !== claims.context_digest) throw new Error("Plugin Tool turn context is stale");
    return { claims: structuredClone(claims), context };
  }
}
