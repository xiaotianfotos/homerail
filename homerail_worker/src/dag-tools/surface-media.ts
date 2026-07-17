import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import * as https from "node:https";
import { isIP } from "node:net";
import {
  DAG_ACTOR_SURFACE_MEDIA_EXTENSIONS,
  DAG_ACTOR_SURFACE_MEDIA_MAX_BYTES,
  DAG_ACTOR_SURFACE_MEDIA_SCHEMA_VERSION,
  DAG_ACTOR_SURFACE_MEDIA_TYPES,
  type DagActorSurfaceBodyV1,
  type DagActorSurfaceMediaTypeV1,
  type DagActorSurfaceMediaV1,
} from "homerail-protocol";
import type { DagToolsState } from "./index.js";

export const DAG_ACTOR_SURFACE_MEDIA_MAX_ITEMS = 16;
export const DAG_ACTOR_SURFACE_MEDIA_MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

const MEDIA_TYPES = new Set<string>(DAG_ACTOR_SURFACE_MEDIA_TYPES);

export class SurfaceMediaError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SurfaceMediaError";
  }
}

export interface DownloadedSurfaceMedia {
  bytes: Uint8Array;
  media_type: DagActorSurfaceMediaTypeV1;
}

export type SurfaceMediaDownloader = (sourceUrl: string) => Promise<DownloadedSurfaceMedia>;
export type SurfaceMediaEmitter = (media: DagActorSurfaceMediaV1) => void;
export type SurfaceMediaPublisher = (sourceUrl: string) => Promise<string>;

function ipv4Parts(address: string): number[] | undefined {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : undefined;
}

/** Rejects non-routable, private, link-local, documentation, and multicast ranges. */
export function isPublicSurfaceMediaAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = ipv4Parts(address)!;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 0 && c === 0) return false;
    if (a === 192 && b === 0 && c === 2) return false;
    if (a === 192 && b === 168) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (family !== 6) return false;
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return false;
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    return isIP(mapped) === 4 && isPublicSurfaceMediaAddress(mapped);
  }
  const first = Number.parseInt(normalized.split(":", 1)[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return false;
  if ((first & 0xffc0) === 0xfe80) return false;
  if ((first & 0xff00) === 0xff00) return false;
  if (normalized.startsWith("100:")) return false;
  if (normalized.startsWith("2001:db8:")) return false;
  return true;
}

function normalizedRemoteUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SurfaceMediaError("invalid_media_url", "media URL is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw new SurfaceMediaError(
      "unsafe_media_url",
      "remote media must use credential-free HTTPS on the default port",
    );
  }
  const hostname = url.hostname.toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new SurfaceMediaError("unsafe_media_url", "remote media hostname is not public");
  }
  url.hash = "";
  return url;
}

async function pinnedPublicAddress(url: URL): Promise<{ address: string; family: 4 | 6 }> {
  if (isIP(url.hostname)) {
    if (!isPublicSurfaceMediaAddress(url.hostname)) {
      throw new SurfaceMediaError("unsafe_media_address", "remote media address is not public");
    }
    return { address: url.hostname, family: isIP(url.hostname) as 4 | 6 };
  }
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true }) as Array<{
      address: string;
      family: number;
    }>;
  } catch {
    throw new SurfaceMediaError("media_dns_failed", "remote media hostname could not be resolved");
  }
  if (!addresses.length || addresses.some((entry) => !isPublicSurfaceMediaAddress(entry.address))) {
    throw new SurfaceMediaError("unsafe_media_address", "remote media hostname resolves outside public addresses");
  }
  const selected = addresses[0]!;
  return { address: selected.address, family: selected.family as 4 | 6 };
}

async function requestSurfaceMedia(url: URL, redirects: number): Promise<DownloadedSurfaceMedia> {
  if (redirects > MAX_REDIRECTS) {
    throw new SurfaceMediaError("media_redirect_limit", `remote media exceeded ${MAX_REDIRECTS} redirects`);
  }
  const pinned = await pinnedPublicAddress(url);
  return new Promise<DownloadedSurfaceMedia>((resolve, reject) => {
    const request = https.request({
      method: "GET",
      hostname: pinned.address,
      family: pinned.family,
      port: 443,
      path: `${url.pathname}${url.search}`,
      servername: isIP(url.hostname) ? undefined : url.hostname,
      headers: {
        Host: url.host,
        Accept: DAG_ACTOR_SURFACE_MEDIA_TYPES.join(", "),
        "Accept-Encoding": "identity",
        "User-Agent": "HomeRail-Worker/0.1 surface-media",
      },
    });
    request.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      request.destroy(new SurfaceMediaError("media_timeout", "remote media download timed out"));
    });
    request.once("error", (error) => {
      reject(error instanceof SurfaceMediaError
        ? error
        : new SurfaceMediaError("media_download_failed", "remote media download failed"));
    });
    request.once("response", (response) => {
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.location;
        response.resume();
        if (!location) {
          reject(new SurfaceMediaError("media_redirect_invalid", "remote media redirect is missing a location"));
          return;
        }
        let redirected: URL;
        try {
          redirected = normalizedRemoteUrl(new URL(location, url).toString());
        } catch (error) {
          reject(error);
          return;
        }
        void requestSurfaceMedia(redirected, redirects + 1).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new SurfaceMediaError("media_http_status", `remote media returned HTTP ${status}`));
        return;
      }
      const rawType = Array.isArray(response.headers["content-type"])
        ? response.headers["content-type"][0]
        : response.headers["content-type"];
      const mediaType = rawType?.split(";", 1)[0]?.trim().toLowerCase();
      if (!mediaType || !MEDIA_TYPES.has(mediaType)) {
        response.resume();
        reject(new SurfaceMediaError("media_type_rejected", "remote media type is not allowed"));
        return;
      }
      const declaredLength = Number(response.headers["content-length"] ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > DAG_ACTOR_SURFACE_MEDIA_MAX_BYTES) {
        response.resume();
        reject(new SurfaceMediaError("media_too_large", "remote media exceeds the per-item byte limit"));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > DAG_ACTOR_SURFACE_MEDIA_MAX_BYTES) {
          response.destroy(new SurfaceMediaError("media_too_large", "remote media exceeds the per-item byte limit"));
          return;
        }
        chunks.push(chunk);
      });
      response.once("error", (error) => reject(error));
      response.once("end", () => {
        if (size < 1) {
          reject(new SurfaceMediaError("media_empty", "remote media is empty"));
          return;
        }
        resolve({ bytes: Buffer.concat(chunks), media_type: mediaType as DagActorSurfaceMediaTypeV1 });
      });
    });
    request.end();
  });
}

export async function downloadSurfaceMedia(sourceUrl: string): Promise<DownloadedSurfaceMedia> {
  return requestSurfaceMedia(normalizedRemoteUrl(sourceUrl), 0);
}

function lockedMediaIdentity(state: DagToolsState): Omit<
  DagActorSurfaceMediaV1,
  "schema_version" | "artifact_name" | "media_type" | "size_bytes" | "sha256" | "content_base64"
> {
  if (!state.roundId || !state.actorId || !state.generation || !state.leaseGeneration) {
    throw new SurfaceMediaError("identity_unavailable", "Actor media identity is unavailable");
  }
  return {
    run_id: state.runId,
    node_id: state.nodeId,
    session_id: state.sessionId,
    round_id: state.roundId,
    actor_id: state.actorId,
    generation: state.generation,
    lease_generation: state.leaseGeneration,
  };
}

export function createSurfaceMediaPublisher(
  state: DagToolsState,
  emit: SurfaceMediaEmitter,
  download: SurfaceMediaDownloader = downloadSurfaceMedia,
): SurfaceMediaPublisher {
  const cache = new Map<string, Promise<string>>();
  let itemCount = 0;
  let totalBytes = 0;
  return (sourceUrl) => {
    const existing = cache.get(sourceUrl);
    if (existing) return existing;
    const pending = (async () => {
      if (itemCount >= DAG_ACTOR_SURFACE_MEDIA_MAX_ITEMS) {
        throw new SurfaceMediaError("media_item_limit", "Actor surface contains too many distinct media items");
      }
      const downloaded = await download(sourceUrl);
      if (downloaded.bytes.byteLength < 1 || downloaded.bytes.byteLength > DAG_ACTOR_SURFACE_MEDIA_MAX_BYTES) {
        throw new SurfaceMediaError("media_too_large", "Actor surface media violates the per-item byte limit");
      }
      if (!MEDIA_TYPES.has(downloaded.media_type)) {
        throw new SurfaceMediaError("media_type_rejected", "Actor surface media type is not allowed");
      }
      if (totalBytes + downloaded.bytes.byteLength > DAG_ACTOR_SURFACE_MEDIA_MAX_TOTAL_BYTES) {
        throw new SurfaceMediaError("media_total_limit", "Actor surface media exceeds the per-turn byte limit");
      }
      itemCount += 1;
      totalBytes += downloaded.bytes.byteLength;
      const sha256 = createHash("sha256").update(downloaded.bytes).digest("hex");
      const artifactName = `actor-media-${sha256}.${DAG_ACTOR_SURFACE_MEDIA_EXTENSIONS[downloaded.media_type]}`;
      emit({
        schema_version: DAG_ACTOR_SURFACE_MEDIA_SCHEMA_VERSION,
        ...lockedMediaIdentity(state),
        artifact_name: artifactName,
        media_type: downloaded.media_type,
        size_bytes: downloaded.bytes.byteLength,
        sha256,
        content_base64: Buffer.from(downloaded.bytes).toString("base64"),
      });
      return `/api/runs/${encodeURIComponent(state.runId)}/artifacts/${encodeURIComponent(artifactName)}/content`;
    })();
    cache.set(sourceUrl, pending);
    pending.catch(() => cache.delete(sourceUrl));
    return pending;
  };
}

interface MutableReference {
  parent: Record<string, unknown> | unknown[];
  key: string | number;
}

function readReference(reference: MutableReference): unknown {
  return Array.isArray(reference.parent)
    ? reference.parent[reference.key as number]
    : reference.parent[reference.key as string];
}

function writeReference(reference: MutableReference, value: unknown): void {
  if (Array.isArray(reference.parent)) reference.parent[reference.key as number] = value;
  else reference.parent[reference.key as string] = value;
}

interface EvaluationScope {
  inTemplate: boolean;
  value: unknown;
}

function pointerReference(root: unknown, path: string): MutableReference | undefined {
  if (!path.startsWith("/") || path === "/") return undefined;
  const tokens = path.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current = root;
  for (const [index, token] of tokens.entries()) {
    const final = index === tokens.length - 1;
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(token)) return undefined;
      const key = Number(token);
      if (final) return { parent: current, key };
      current = current[key];
    } else if (current && typeof current === "object") {
      if (final) return { parent: current as Record<string, unknown>, key: token };
      current = (current as Record<string, unknown>)[token];
    } else {
      return undefined;
    }
  }
  return undefined;
}

function pathValue(dataModel: Record<string, unknown>, path: string, scope: EvaluationScope): unknown {
  const root = path.startsWith("/") ? dataModel : scope.inTemplate ? scope.value : dataModel;
  const reference = pointerReference(root, path.startsWith("/") ? path : `/${path}`);
  return reference ? readReference(reference) : undefined;
}

function bindingReference(
  dataModel: Record<string, unknown>,
  binding: unknown,
  scope: EvaluationScope,
): MutableReference | undefined {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) return undefined;
  const path = (binding as { path?: unknown }).path;
  if (typeof path !== "string") return undefined;
  const root = path.startsWith("/") ? dataModel : scope.inTemplate ? scope.value : dataModel;
  return pointerReference(root, path.startsWith("/") ? path : `/${path}`);
}

function childEdges(component: Record<string, unknown>): Array<{ id: string; templatePath?: string }> {
  const children = component.children;
  if (Array.isArray(children)) {
    return children.filter((entry): entry is string => typeof entry === "string").map((id) => ({ id }));
  }
  if (children && typeof children === "object" && !Array.isArray(children)) {
    const path = (children as Record<string, unknown>).path;
    const id = (children as Record<string, unknown>).componentId;
    return typeof path === "string" && typeof id === "string" ? [{ id, templatePath: path }] : [];
  }
  if (typeof component.child === "string") return [{ id: component.child }];
  if (Array.isArray(component.tabs)) {
    return component.tabs.flatMap((tab) => tab && typeof tab === "object" && typeof (tab as { child?: unknown }).child === "string"
      ? [{ id: (tab as { child: string }).child }]
      : []);
  }
  return [];
}

function mediaFields(component: Record<string, unknown>): string[] {
  switch (component.component) {
    case "Image": return ["url"];
    case "Video": return component.posterUrl === undefined ? ["url"] : ["url", "posterUrl"];
    case "AudioPlayer": return ["url"];
    default: return [];
  }
}

function isBrokerUri(value: string): boolean {
  return value.startsWith("/api/runs/") || value.startsWith("/api/plugins/artifacts/");
}

function normalizedMediaSource(value: string): string | undefined {
  if (value !== value.trim() || /[\\\s\u0000-\u001f]/.test(value)) return undefined;
  if (value.startsWith("https://")) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return undefined;
  const candidate = value.startsWith("//") ? `https:${value}` : `https://${value}`;
  try {
    const url = normalizedRemoteUrl(candidate);
    if (!url.hostname.includes(".") && isIP(url.hostname) === 0) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Rewrites only media-bound values; normal links remain external URLs. */
export async function brokerSurfaceMediaBody(
  body: DagActorSurfaceBodyV1,
  publish?: SurfaceMediaPublisher,
): Promise<DagActorSurfaceBodyV1> {
  const cloned = structuredClone(body);
  const components = new Map<string, Record<string, unknown>>();
  for (const component of cloned.a2ui.components as unknown as Record<string, unknown>[]) {
    if (typeof component.id === "string") components.set(component.id, component);
  }
  const dataModel: Record<string, unknown> = { actor_view: { data: cloned.data } };
  const references: MutableReference[] = [];
  const referenceKeys = new WeakMap<object, Set<string | number>>();
  const addReference = (reference: MutableReference | undefined) => {
    if (!reference) return;
    let keys = referenceKeys.get(reference.parent);
    if (!keys) {
      keys = new Set();
      referenceKeys.set(reference.parent, keys);
    }
    if (keys.has(reference.key)) return;
    keys.add(reference.key);
    references.push(reference);
  };
  const surfaceProperties = cloned.a2ui.surfaceProperties as Record<string, unknown> | undefined;
  if (surfaceProperties && typeof surfaceProperties.iconUrl === "string") {
    addReference({ parent: surfaceProperties, key: "iconUrl" });
  }
  for (const artifact of cloned.fallback.artifact_refs ?? []) {
    addReference({ parent: artifact as unknown as Record<string, unknown>, key: "uri" });
  }
  const visit = (id: string, scope: EvaluationScope, ancestors: ReadonlySet<string>) => {
    const component = components.get(id);
    if (!component || ancestors.has(id)) return;
    for (const field of mediaFields(component)) {
      const value = component[field];
      if (typeof value === "string") addReference({ parent: component, key: field });
      else {
        const path = value && typeof value === "object" && !Array.isArray(value)
          ? (value as { path?: unknown }).path
          : undefined;
        const reference = bindingReference(dataModel, value, scope);
        if (typeof path === "string" && (!reference || typeof readReference(reference) !== "string")) {
          throw new SurfaceMediaError(
            "missing_media_binding",
            `pinned view data must provide media path '${path}' as a string`,
          );
        }
        addReference(reference);
      }
    }
    const next = new Set(ancestors);
    next.add(id);
    for (const edge of childEdges(component)) {
      if (!edge.templatePath) {
        visit(edge.id, scope, next);
        continue;
      }
      const items = pathValue(dataModel, edge.templatePath, scope);
      if (!Array.isArray(items)) continue;
      for (const item of items) visit(edge.id, { inTemplate: true, value: item }, next);
    }
  };
  visit("root", { inTemplate: false, value: dataModel }, new Set());

  for (const reference of references) {
    const value = readReference(reference);
    if (typeof value !== "string" || isBrokerUri(value)) continue;
    const sourceUrl = normalizedMediaSource(value);
    if (!sourceUrl) {
      throw new SurfaceMediaError("unsafe_media_url", "Actor media must be a broker URI or public HTTPS URL");
    }
    if (!publish) {
      throw new SurfaceMediaError("media_broker_unavailable", "Worker media brokering is unavailable");
    }
    writeReference(reference, await publish(sourceUrl));
  }
  return cloned;
}
