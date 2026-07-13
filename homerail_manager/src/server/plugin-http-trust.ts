import { createHash, timingSafeEqual } from "node:crypto";
import type * as http from "node:http";
import { HOMERAIL_MANAGER_TURN_HEADER } from "homerail-protocol";

export const HOMERAIL_MANAGER_ADMIN_TOKEN = "HOMERAIL_MANAGER_ADMIN_TOKEN";
export const HOMERAIL_MANAGER_ADMIN_ORIGINS = "HOMERAIL_MANAGER_ADMIN_ORIGINS";
export const HOMERAIL_UNSAFE_ALLOW_PUBLIC_MANAGER_WITHOUT_AUTH = "HOMERAIL_UNSAFE_ALLOW_PUBLIC_MANAGER_WITHOUT_AUTH";
export const MIN_ADMIN_TOKEN_BYTES = 32;

const MAX_ADMIN_TOKEN_BYTES = 4 * 1024;
const API_PREFIX = "/api";
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const PREFLIGHT_HEADERS = new Set(["authorization", "content-type", "if-none-match", HOMERAIL_MANAGER_TURN_HEADER]);

export interface PluginHttpTrustPolicyOptions {
  bindHost?: string;
  publicUrl?: string;
  adminToken?: string;
  allowedOrigins?: string;
  unsafeAllowUnauthenticatedPublic?: boolean;
  turnAuthorizer?: (credential: string, method: string, pathname: string) => boolean;
}

export interface PluginHttpTrustPolicy {
  readonly bindHost: string;
  readonly publiclyReachable: boolean;
  readonly adminToken?: string;
  readonly allowedOrigins: readonly string[];
  readonly unsafeAllowUnauthenticatedPublic: boolean;
  readonly turnAuthorizer?: (credential: string, method: string, pathname: string) => boolean;
}

/**
 * Freeze the Manager mutation trust boundary when the HTTP server is created.
 * A Manager exposed beyond loopback must never start without an independently
 * configured admin credential.
 */
export function createPluginHttpTrustPolicy(
  options: PluginHttpTrustPolicyOptions = {},
): PluginHttpTrustPolicy {
  const bindHost = (options.bindHost ?? "127.0.0.1").trim() || "127.0.0.1";
  const adminToken = validateAdminToken(options.adminToken);
  const publiclyReachable = !isLoopbackHost(bindHost) || Boolean(options.publicUrl?.trim());
  const unsafeAllowUnauthenticatedPublic = Boolean(
    publiclyReachable && !adminToken && options.unsafeAllowUnauthenticatedPublic,
  );
  if (publiclyReachable && !adminToken && !unsafeAllowUnauthenticatedPublic) {
    throw new Error(
      `${HOMERAIL_MANAGER_ADMIN_TOKEN} must contain at least ${MIN_ADMIN_TOKEN_BYTES} bytes `
      + "before Manager can bind beyond loopback or advertise a public URL",
    );
  }
  return Object.freeze({
    bindHost,
    publiclyReachable,
    adminToken,
    allowedOrigins: Object.freeze(parseAllowedOrigins(options.allowedOrigins)),
    unsafeAllowUnauthenticatedPublic,
    turnAuthorizer: options.turnAuthorizer,
  });
}

/**
 * Enforce the trust boundary for every non-read method below /api.
 * Returns true only when a denial/preflight response has already been sent.
 */
export function pluginHttpTrustHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  policy: PluginHttpTrustPolicy,
): boolean {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  if (!isApiPath(pathname)) return false;

  const requestedMethod = req.method === "OPTIONS"
    ? singleHeader(req.headers["access-control-request-method"])?.toUpperCase()
    : undefined;
  const method = (requestedMethod || req.method || "GET").toUpperCase();
  if (!MUTATION_METHODS.has(method)) return false;

  // A wildcard CORS header is safe for public reads, but never for the admin
  // mutation surface. The exact trusted Origin is restored below when valid.
  res.removeHeader("Access-Control-Allow-Origin");
  res.removeHeader("Access-Control-Allow-Credentials");
  appendVary(res, "Origin");

  const rawOrigin = req.headers.origin;
  const origin = singleHeader(rawOrigin);
  if (rawOrigin !== undefined) {
    if (!origin || !policy.allowedOrigins.includes(origin)) {
      req.resume();
      deny(res, 403, "Manager mutation Origin is not trusted");
      return true;
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else if (req.method === "OPTIONS" || isBrowserFetch(req)) {
    req.resume();
    deny(res, 403, "Manager mutation Origin is required");
    return true;
  }

  const socketAddress = req.socket.localAddress;
  const reachedBeyondLoopback = Boolean(socketAddress && !isLoopbackHost(socketAddress));
  if (
    (policy.publiclyReachable || reachedBeyondLoopback)
    && !policy.adminToken
    && !policy.unsafeAllowUnauthenticatedPublic
  ) {
    req.resume();
    deny(res, 503, "Manager mutation authentication is not configured");
    return true;
  }

  if (req.method === "OPTIONS") {
    const requestedHeaders = parseRequestedHeaders(req.headers["access-control-request-headers"]);
    if (requestedHeaders.some((header) => !PREFLIGHT_HEADERS.has(header))) {
      req.resume();
      deny(res, 403, "Manager mutation preflight requested unsupported headers");
      return true;
    }
    res.setHeader("Access-Control-Allow-Methods", "POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", `Authorization, Content-Type, If-None-Match, ${HOMERAIL_MANAGER_TURN_HEADER}`);
    res.setHeader("Cache-Control", "no-store");
    res.writeHead(204);
    res.end();
    return true;
  }

  // Loopback keeps a zero-configuration path for a local, non-browser CLI.
  // Configuring a token opts loopback into auth too; public/LAN always has one.
  if (policy.adminToken) {
    const turnCredential = singleHeader(req.headers[HOMERAIL_MANAGER_TURN_HEADER]);
    if (turnCredential && policy.turnAuthorizer?.(turnCredential, method, pathname)) return false;
    const supplied = parseBearerToken(req.headers.authorization);
    if (!supplied) {
      req.resume();
      deny(res, 401, "Manager mutation authentication is required");
      return true;
    }
    if (!constantTimeTokenEqual(supplied, policy.adminToken)) {
      req.resume();
      deny(res, 401, "Manager mutation authentication failed");
      return true;
    }
  }

  return false;
}

export function isLoopbackHost(value: string): boolean {
  let host = value.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const zoneIndex = host.indexOf("%");
  if (zoneIndex >= 0) host = host.slice(0, zoneIndex);
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (host.startsWith("::ffff:")) host = host.slice("::ffff:".length);
  const octets = host.split(".");
  return octets.length === 4
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    && Number(octets[0]) === 127;
}

function isApiPath(pathname: string): boolean {
  return pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);
}

function validateAdminToken(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw !== raw.trim() || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new Error(`${HOMERAIL_MANAGER_ADMIN_TOKEN} must not contain surrounding whitespace or control bytes`);
  }
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes < MIN_ADMIN_TOKEN_BYTES || bytes > MAX_ADMIN_TOKEN_BYTES) {
    throw new Error(
      `${HOMERAIL_MANAGER_ADMIN_TOKEN} must contain ${MIN_ADMIN_TOKEN_BYTES}-${MAX_ADMIN_TOKEN_BYTES} UTF-8 bytes`,
    );
  }
  if (!/^[A-Za-z0-9._~+/=-]+$/.test(raw)) {
    throw new Error(`${HOMERAIL_MANAGER_ADMIN_TOKEN} must use a printable base64url, base64, or hexadecimal token`);
  }
  return raw;
}

function parseAllowedOrigins(raw: string | undefined): string[] {
  const values = (raw ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const origins = new Set<string>();
  for (const value of values) {
    if (value === "*" || value === "null") {
      throw new Error(
        `${HOMERAIL_MANAGER_ADMIN_ORIGINS} must contain exact comma-separated http(s) origins without wildcards`,
      );
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${HOMERAIL_MANAGER_ADMIN_ORIGINS} contains an invalid Origin`);
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:")
      || url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash
      || url.origin !== value
      || value === "null"
    ) {
      throw new Error(
        `${HOMERAIL_MANAGER_ADMIN_ORIGINS} must contain exact comma-separated http(s) origins without paths`,
      );
    }
    origins.add(value);
  }
  return [...origins];
}

function parseBearerToken(raw: string | string[] | undefined): string | undefined {
  const value = singleHeader(raw);
  if (!value) return undefined;
  const match = value.match(/^Bearer ([^\s,]+)$/i);
  return match?.[1];
}

function constantTimeTokenEqual(supplied: string, expected: string): boolean {
  const suppliedDigest = createHash("sha256").update(supplied, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}

function parseRequestedHeaders(raw: string | string[] | undefined): string[] {
  const value = singleHeader(raw);
  if (!value) return [];
  return value.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

function singleHeader(raw: string | string[] | undefined): string | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.includes("\n") || raw.includes("\r")) {
    return undefined;
  }
  return raw;
}

function isBrowserFetch(req: http.IncomingMessage): boolean {
  // Browsers emit Sec-Fetch-Site for navigation/fetch context. Node's fetch
  // emits Sec-Fetch-Mode even for CLI calls, so Mode alone cannot distinguish
  // a browser from the supported no-Origin CLI path.
  return req.headers["sec-fetch-site"] !== undefined;
}

function appendVary(res: http.ServerResponse, value: string): void {
  const current = res.getHeader("Vary");
  const values = (Array.isArray(current) ? current : String(current ?? "").split(","))
    .map((entry) => String(entry).trim())
    .filter(Boolean);
  if (!values.some((entry) => entry.toLowerCase() === value.toLowerCase())) values.push(value);
  res.setHeader("Vary", values.join(", "));
}

function deny(res: http.ServerResponse, status: number, error: string): void {
  res.setHeader("Cache-Control", "no-store");
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ success: false, error }));
}
