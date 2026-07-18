import type * as http from "node:http";
import {
  createCredential,
  deleteCredential,
  getCredential,
  listCredentialAuditEvents,
  listCredentials,
  revokeCredential,
  rotateCredential,
  type CredentialMetadata,
} from "../persistence/credentials.js";

const BASE_PATH = "/api/credentials";
const MAX_BODY_BYTES = 3 * 1024 * 1024;

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function actorFor(req: http.IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? "unknown";
  return `credential-api:${remote}`.slice(0, 256);
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error("Credential request body exceeds 3 MiB");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Credential request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing required field: ${key}`);
  return value;
}

function secretObject(body: Record<string, unknown>): Record<string, string> {
  const value = body.secret;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Missing required object: secret");
  }
  const entries = Object.entries(value);
  if (!entries.every(([, entry]) => typeof entry === "string")) {
    throw new Error("Every credential secret field must be a string");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function metadataObject(body: Record<string, unknown>): CredentialMetadata | undefined {
  const value = body.metadata;
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("metadata must be an object");
  }
  return value as CredentialMetadata;
}

function idFromPath(pathname: string): { id: string; action?: "rotate" | "revoke" | "audit" } | undefined {
  if (!pathname.startsWith(`${BASE_PATH}/`)) return undefined;
  const parts = pathname.slice(BASE_PATH.length + 1).split("/").map(decodeURIComponent);
  if (parts.length === 1 && parts[0]) return { id: parts[0] };
  if (parts.length === 2 && parts[0] && ["rotate", "revoke", "audit"].includes(parts[1])) {
    return { id: parts[0], action: parts[1] as "rotate" | "revoke" | "audit" };
  }
  return undefined;
}

export function credentialRoutesHandler(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  const match = idFromPath(pathname);

  if (pathname === BASE_PATH && req.method === "GET") {
    json(res, 200, { success: true, message: "Credentials retrieved", data: { credentials: listCredentials() } });
    return true;
  }

  if (pathname === BASE_PATH && req.method === "POST") {
    void readJsonBody(req).then((body) => {
      const credential = createCredential({
        id: requiredString(body, "id"),
        credential_type: requiredString(body, "credential_type"),
        name: requiredString(body, "name"),
        secret: secretObject(body),
        metadata: metadataObject(body),
        expires_at: typeof body.expires_at === "string" ? body.expires_at : undefined,
      }, { actor: actorFor(req) });
      json(res, 201, { success: true, message: "Credential created", data: { credential } });
    }).catch((error) => json(res, 400, {
      success: false,
      message: error instanceof Error ? error.message : String(error),
    }));
    return true;
  }

  if (match?.action === "audit" && req.method === "GET") {
    json(res, 200, {
      success: true,
      message: "Credential audit retrieved",
      data: { events: listCredentialAuditEvents(match.id) },
    });
    return true;
  }

  if (match?.action === "rotate" && req.method === "POST") {
    void readJsonBody(req).then((body) => {
      const credential = rotateCredential(match.id, {
        secret: secretObject(body),
        expires_at: typeof body.expires_at === "string" ? body.expires_at : undefined,
      }, { actor: actorFor(req) });
      json(res, 200, { success: true, message: "Credential rotated", data: { credential } });
    }).catch((error) => json(res, 400, {
      success: false,
      message: error instanceof Error ? error.message : String(error),
    }));
    return true;
  }

  if (match?.action === "revoke" && req.method === "POST") {
    try {
      const credential = revokeCredential(match.id, { actor: actorFor(req) });
      json(res, 200, { success: true, message: "Credential revoked", data: { credential } });
    } catch (error) {
      json(res, 400, { success: false, message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (match && !match.action && req.method === "GET") {
    const credential = getCredential(match.id);
    if (!credential) {
      json(res, 404, { success: false, message: `Credential not found: ${match.id}` });
    } else {
      json(res, 200, { success: true, message: "Credential retrieved", data: { credential } });
    }
    return true;
  }

  if (match && !match.action && req.method === "DELETE") {
    try {
      deleteCredential(match.id, { actor: actorFor(req) });
      json(res, 200, { success: true, message: "Credential deleted", data: { id: match.id } });
    } catch (error) {
      json(res, 400, { success: false, message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  return false;
}
