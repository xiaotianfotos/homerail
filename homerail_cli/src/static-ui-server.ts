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
//   HOMERAIL_UI_ORIGIN          exact browser-facing origin for this process
//   HOMERAIL_UI_ADMIN_PROXY_ENABLED "1" only for runtime-verified loopback mode
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { URL } from "node:url";
import {
  HOMERAIL_UNSAFE_ALLOW_PUBLIC_MANAGER_WITHOUT_AUTH,
  authorizeUiAdminProxyMutation,
  createUiAdminProxyPolicy,
  isProtectedApiMutation,
} from "./ui-admin-proxy.js";

const ROOT = path.resolve(process.env.HOMERAIL_STATIC_UI_DIR || "");
const PORT = Number(process.env.HOMERAIL_UI_PORT || 19192);
const HOST = process.env.HOMERAIL_UI_HOST || "127.0.0.1";
const MANAGER_HTTP = process.env.HOMERAIL_MANAGER_HTTP || "http://localhost:19191";
const MANAGER_WS = process.env.HOMERAIL_MANAGER_WS || "ws://localhost:19191";
const MANAGER_ADMIN_TOKEN = process.env.HOMERAIL_MANAGER_ADMIN_TOKEN || "";
const USE_HTTPS = process.env.HOMERAIL_UI_HTTPS === "1";
const BUILD_MANIFEST = "homerail-build.json";
const UI_ADMIN_PROXY = createUiAdminProxyPolicy({
  enabled: process.env.HOMERAIL_UI_ADMIN_PROXY_ENABLED === "1",
  uiOrigin: process.env.HOMERAIL_UI_ORIGIN || "",
  uiBindHost: HOST,
  managerUrl: MANAGER_HTTP,
  adminToken: MANAGER_ADMIN_TOKEN,
  unsafeAllowPublicNoAuth:
    process.env[HOMERAIL_UNSAFE_ALLOW_PUBLIC_MANAGER_WITHOUT_AUTH] === "1",
});

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
  const headers = { ...req.headers, host: target.host };
  if (isProtectedApiMutation(req.method, req.url)) {
    const authorization = authorizeUiAdminProxyMutation(
      UI_ADMIN_PROXY,
      req.headers.origin,
      req.headers["sec-fetch-site"],
    );
    if (!authorization.allowed) {
      req.resume();
      res.writeHead(403, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ success: false, error: authorization.reason }));
      return;
    }
    // The browser never receives or asserts the Manager credential. The
    // same-origin UI proxy is the only component allowed to inject it.
    delete headers.authorization;
    if (UI_ADMIN_PROXY.adminToken) {
      headers.authorization = `Bearer ${UI_ADMIN_PROXY.adminToken}`;
    }
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
  // Proxy a WebSocket upgrade to the Manager (/ws).
  const target = new URL(MANAGER_WS);
  const proxyReq = http.request(
    {
      method: "GET",
      protocol: target.protocol === "ws:" ? "http:" : "https:",
      hostname: target.hostname,
      port: target.port,
      path: req.url,
      headers: { ...req.headers, host: target.host },
    },
    () => {
      /* upgrades don't get a normal response */
    },
  );
  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n` +
        Object.entries(proxyRes.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n") +
        "\r\n\r\n",
    );
    proxySocket.write(proxyHead);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });
  proxyReq.on("error", () => socket.destroy());
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
  if ((req.url || "").startsWith("/ws")) {
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
