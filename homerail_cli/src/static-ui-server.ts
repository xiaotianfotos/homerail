#!/usr/bin/env node
// Minimal zero-dependency static file server for the Agent UI production build.
//
// Used by the desktop packaged shell app so it does NOT need to ship agent-ui's full
// node_modules (vite toolchain). Serves agent-ui/dist and reverse-proxies
// /api, /artifacts (HTTP) and /ws (WebSocket upgrade) to the Manager.
//
// Env:
//   HOMERAIL_STATIC_UI_DIR      absolute path to agent-ui/dist
//   HOMERAIL_UI_PORT            port to listen on (default 19192)
//   HOMERAIL_UI_HOST            bind host (default 127.0.0.1)
//   HOMERAIL_UI_HTTPS           "1" to serve over HTTPS
//   HOMERAIL_UI_HTTPS_KEY       PEM key path (HTTPS only)
//   HOMERAIL_UI_HTTPS_CERT      PEM cert path (HTTPS only)
//   HOMERAIL_MANAGER_HTTP       manager HTTP origin, e.g. http://localhost:19191
//   HOMERAIL_MANAGER_WS         manager WS origin, e.g. ws://localhost:19191
//   HOMERAIL_UI_PUBLIC_URL      explicit public/named UI URL (exact http(s) Origin) accepted
//                               for protected mutations when a reverse proxy rewrites Host;
//                               unset permits only localhost/.localhost or literal-IP self Origins
//   HOMERAIL_DAG_MUTATION_TOKEN internal token added to trusted same-origin mutations
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { URL } from "node:url";
import {
  authorizeUiAdminProxyMutation,
  isProtectedApiMutation,
  normalizeExactHttpOrigin,
} from "./ui-admin-proxy.js";

// Keep the production static server zero-dependency. Protocol tests assert
// these literals stay in sync with homerail-protocol.
const BROWSER_RENDERER_TOOLS_TICKET_PATH = "/api/browser-tools/renderer-ticket";
const BROWSER_RENDERER_TOOLS_WS_PATH = "/ws/browser-tools/renderer";

const ROOT = path.resolve(process.env.HOMERAIL_STATIC_UI_DIR || "");
const PORT = Number(process.env.HOMERAIL_UI_PORT || 19192);
const HOST = process.env.HOMERAIL_UI_HOST || "127.0.0.1";
const MANAGER_HTTP = process.env.HOMERAIL_MANAGER_HTTP || "http://localhost:19191";
const MANAGER_WS = process.env.HOMERAIL_MANAGER_WS || "ws://localhost:19191";
const DAG_MUTATION_TOKEN = process.env.HOMERAIL_DAG_MUTATION_TOKEN?.trim();
const USE_HTTPS = process.env.HOMERAIL_UI_HTTPS === "1";
const BUILD_MANIFEST = "homerail-build.json";

// Explicit operator-configured public Origin (shared name with the CLI's
// --ui-public-url / HOMERAIL_UI_PUBLIC_URL). Validated with the same exact
// HTTP(S) Origin rule the Manager admin allowlist uses; anything ambiguous
// fails the startup instead of silently widening the mutation trust boundary.
const CONFIGURED_PUBLIC_ORIGIN = resolveConfiguredPublicOrigin();

function resolveConfiguredPublicOrigin(): string | undefined {
  const configured = process.env.HOMERAIL_UI_PUBLIC_URL?.trim();
  if (!configured) return undefined;
  const normalized = normalizeExactHttpOrigin(configured);
  if (!normalized) {
    // eslint-disable-next-line no-console
    console.error(
      "static-ui-server fatal: HOMERAIL_UI_PUBLIC_URL must be an exact http(s) Origin " +
      `without wildcard, path, query, fragment, or credentials: ${configured}`,
    );
    process.exit(1);
  }
  return normalized;
}

// WebSocket upgrade allowlist. Manager-published routes that the Agent UI must
// reach same-origin are listed here; everything else is destroyed. Keep these in
// sync with the Manager's own upgrade handlers.
//
//   /ws, /ws/events                       general event stream
//   /api/voice/asr/realtime               same-origin ASR realtime
//   /api/voice-agent/sessions/<id>/live   Codex Live Voice (dynamic sessionId)
const CODEX_LIVE_VOICE_WS_PATH = /^\/api\/voice-agent\/sessions\/[^/]+\/live$/;
const ALLOWED_WS_PATHS = new Set([
  "/ws",
  "/ws/events",
  "/api/voice/asr/realtime",
  BROWSER_RENDERER_TOOLS_WS_PATH,
]);

function stripForwardingClaims(headers: http.OutgoingHttpHeaders): void {
  for (const name of Object.keys(headers)) {
    const normalized = name.toLowerCase();
    if (
      normalized === "forwarded"
      || normalized === "x-real-ip"
      || normalized.startsWith("x-forwarded-")
    ) {
      delete headers[name];
    }
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};

function sendFile(res: http.ServerResponse, filePath: string): void {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".html") {
      sendHtml(res, filePath);
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": "public, max-age=3600",
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function sendHtml(res: http.ServerResponse, filePath: string): void {
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("failed to read html");
      return;
    }
    const runtimeScript = `<script>window.__HOMERAIL_RUNTIME_CONFIG__=${JSON.stringify({
      apiBaseUrl: "",
      wsUrl: "",
      managerHttp: MANAGER_HTTP,
      managerWs: MANAGER_WS,
      uiBuild: readBuildManifest(),
    })};</script>`;
    const body = html.includes("</head>")
      ? html.replace("</head>", `${runtimeScript}</head>`)
      : `${runtimeScript}${html}`;
    res.writeHead(200, {
      "content-type": MIME[".html"],
      "cache-control": "no-cache",
    });
    res.end(body);
  });
}

function readBuildManifest(): Record<string, unknown> | null {
  try {
    const manifestPath = path.join(ROOT, BUILD_MANIFEST);
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function sendBuildManifest(res: http.ServerResponse): void {
  const manifest = readBuildManifest() ?? {
    app: "homerail-agent-ui",
    missing: true,
    static_root: ROOT,
  };
  res.writeHead(200, {
    "content-type": MIME[".json"],
    "cache-control": "no-cache",
  });
  res.end(JSON.stringify(manifest));
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname === "/__homerail_ui_build") {
    sendBuildManifest(res);
    return;
  }
  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end("bad request");
    return;
  }
  if (rel === "/" || rel === "") rel = "/index.html";
  // Guard against path traversal.
  const resolved = path.resolve(ROOT, "." + rel);
  if (resolved !== ROOT && !resolved.startsWith(`${ROOT}${path.sep}`)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  fs.stat(resolved, (err, stat) => {
    if (!err && stat.isFile()) {
      sendFile(res, resolved);
      return;
    }
    // SPA fallback to index.html for client-side routing.
    sendFile(res, path.join(ROOT, "index.html"));
  });
}

function proxyHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
  const target = new URL(MANAGER_HTTP);
  const headers: http.OutgoingHttpHeaders = { ...req.headers, host: target.host };
  if (isProtectedApiMutation(req.method, req.url)) {
    const authorization = authorizeUiAdminProxyMutation({
      protocol: USE_HTTPS ? "https" : "http",
      host: req.headers.host,
      origin: req.headers.origin,
      secFetchSite: req.headers["sec-fetch-site"],
    }, CONFIGURED_PUBLIC_ORIGIN);
    if (!authorization.allowed) {
      req.resume();
      res.writeHead(403, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ success: false, error: authorization.reason }));
      return;
    }
    // Browser credentials never override Manager's own trust decision.
    delete headers.authorization;
    delete headers["x-homerail-dag-token"];
    if (DAG_MUTATION_TOKEN) {
      headers["x-homerail-dag-token"] = DAG_MUTATION_TOKEN;
    }
  }
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  if (pathname === BROWSER_RENDERER_TOOLS_TICKET_PATH) {
    // The browser-facing Host/Origin pair was checked above. Strip any
    // forwarding metadata received from an outer proxy and write the only
    // same-origin marker Manager accepts over this loopback UI-proxy hop.
    stripForwardingClaims(headers);
    headers["sec-fetch-site"] = "same-origin";
  }
  const request = target.protocol === "https:" ? https.request : http.request;
  const proxyReq = request(
    {
      method: req.method,
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: req.url,
      headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on("error", (e) => {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`proxy error: ${e.message}`);
  });
  req.pipe(proxyReq);
}

function handleWebSocket(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
  // Proxy WebSocket upgrades to the Manager. This includes the general event
  // stream and Voice ASR's same-origin realtime endpoint.
  const target = new URL(MANAGER_WS);
  const request = target.protocol === "wss:" ? https.request : http.request;
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  const headers: http.OutgoingHttpHeaders = { ...req.headers, host: target.host };
  if (pathname === BROWSER_RENDERER_TOOLS_WS_PATH) {
    const authorization = authorizeUiAdminProxyMutation({
      protocol: USE_HTTPS ? "https" : "http",
      host: req.headers.host,
      origin: req.headers.origin,
      secFetchSite: req.headers["sec-fetch-site"],
    }, CONFIGURED_PUBLIC_ORIGIN);
    if (!authorization.allowed) {
      socket.destroy();
      return;
    }
    stripForwardingClaims(headers);
    headers["sec-fetch-site"] = "same-origin";
  }
  let proxySocket: net.Socket | undefined;
  let proxyReq: http.ClientRequest | undefined;
  const destroyUpstream = (): void => {
    if (proxySocket && !proxySocket.destroyed) {
      proxySocket.destroy();
      return;
    }
    if (proxyReq && !proxyReq.destroyed) proxyReq.destroy();
  };
  socket.on("error", destroyUpstream);
  socket.on("close", destroyUpstream);

  proxyReq = request(
    {
      method: "GET",
      protocol: target.protocol === "ws:" ? "http:" : "https:",
      hostname: target.hostname,
      port: target.port,
      path: req.url,
      headers,
    },
    (proxyRes) => {
      proxyRes.resume();
      if (!socket.destroyed) socket.destroy();
    },
  );
  proxyReq.on("upgrade", (proxyRes, upgradedSocket, proxyHead) => {
    proxySocket = upgradedSocket;
    const destroyClient = (): void => {
      if (!socket.destroyed) socket.destroy();
    };
    upgradedSocket.on("error", destroyClient);
    upgradedSocket.on("close", destroyClient);
    if (socket.destroyed) {
      upgradedSocket.destroy();
      return;
    }
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n` +
        Object.entries(proxyRes.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n") +
        "\r\n\r\n",
    );
    if (proxyHead.length > 0) socket.write(proxyHead);
    if (head.length > 0) upgradedSocket.write(head);
    upgradedSocket.pipe(socket);
    socket.pipe(upgradedSocket);
  });
  proxyReq.on("error", () => {
    if (!socket.destroyed) socket.destroy();
  });
  proxyReq.end();
}

const server = USE_HTTPS
  ? https.createServer(
      {
        key: fs.readFileSync(process.env.HOMERAIL_UI_HTTPS_KEY || ""),
        cert: fs.readFileSync(process.env.HOMERAIL_UI_HTTPS_CERT || ""),
      },
      onRequest,
    )
  : http.createServer(onRequest);

function onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = req.url || "/";
  if (url.startsWith("/api") || url.startsWith("/artifacts")) {
    proxyHttp(req, res);
    return;
  }
  serveStatic(req, res);
}

server.on("upgrade", (req, socket, head) => {
  const requestUrl = new URL(req.url || "/", "http://localhost");
  const pathname = requestUrl.pathname;
  if (pathname === BROWSER_RENDERER_TOOLS_WS_PATH && requestUrl.search) {
    socket.destroy();
    return;
  }
  if (ALLOWED_WS_PATHS.has(pathname) || CODEX_LIVE_VOICE_WS_PATH.test(pathname)) {
    handleWebSocket(req, socket as unknown as net.Socket, head);
    return;
  }
  socket.destroy();
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`hr static UI server listening on ${USE_HTTPS ? "https" : "http"}://${HOST}:${PORT} (root: ${ROOT})`);
});

// Keep detached child alive; log crashes to stderr for the parent to capture.
process.on("uncaughtException", (e) => {
  // eslint-disable-next-line no-console
  console.error("static-ui-server fatal:", e);
});
