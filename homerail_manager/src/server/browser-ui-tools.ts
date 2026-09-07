import {
  HOMERAIL_MANAGER_TURN_HEADER,
  HOMERAIL_UI_SURFACES,
  HOMERAIL_UI_TOOL_NAMES,
  validateBrowserToolsTurnBinding,
  validateHomeRailUiToolInput,
  type BrowserRendererConnectionRefV1,
  type BrowserToolsTurnBindingV1,
  type BrowserToolsTurnTransportV1,
  type HomeRailUiToolName,
} from "homerail-protocol";
import type * as http from "node:http";
import {
  listPersistedRunSummaries,
  type PersistedRunSummary,
} from "../persistence/store.js";
import { getBrowserToolsBroker } from "./browser-tools-websocket.js";
import { getBrowserRendererToolsBroker } from "./browser-renderer-tools-websocket.js";
import { getManagerAgentTurnEnvelopeAuthority } from "./manager-agent-turn-envelope.js";

const BROWSER_UI_INVOKE_PATH = "/api/browser-tools/invoke";
const MAX_BROWSER_UI_REQUEST_BYTES = 128 * 1024;

/** Resolve a request-owned route once. Never infer another transport. */
export function pinHomeRailBrowserUiTurnBinding(
  rawTransport: unknown,
  rawTarget: unknown,
): BrowserToolsTurnBindingV1 {
  const binding = validateBrowserToolsTurnBinding(rawTransport, rawTarget);
  if (binding.browser_tools_transport === "renderer") {
    const broker = getBrowserRendererToolsBroker();
    if (!broker) throw new Error("HomeRail browser renderer is unavailable");
    return {
      browser_tools_transport: "renderer",
      browser_tools_target: broker.requireConnection(binding.browser_tools_target!),
    };
  }
  if (binding.browser_tools_transport === "desktop" && !getBrowserToolsBroker()?.ready()) {
    throw new Error("HomeRail Desktop Browser Tools is unavailable");
  }
  return binding;
}

export function homeRailBrowserUiToolsAvailable(
  browserToolsTransport: BrowserToolsTurnTransportV1 = "none",
  browserToolsTarget?: BrowserRendererConnectionRefV1 | null,
): boolean {
  try {
    const binding = validateBrowserToolsTurnBinding(browserToolsTransport, browserToolsTarget);
    if (binding.browser_tools_transport === "none") return false;
    if (binding.browser_tools_transport === "desktop") {
      return getBrowserToolsBroker()?.ready() ?? false;
    }
    return Boolean(getBrowserRendererToolsBroker()?.requireConnection(binding.browser_tools_target!));
  } catch {
    return false;
  }
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function searchableValues(run: PersistedRunSummary): string[] {
  return [run.runId, run.workflowId, run.workflowName]
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map(normalized);
}

export function resolveBrowserUiDagRun(
  runs: readonly PersistedRunSummary[],
  input: { entity_id?: unknown; query?: unknown },
): string | undefined {
  const entityId = optionalString(input.entity_id, "entity_id");
  const query = optionalString(input.query, "query");
  if (entityId && query) throw new Error("Provide entity_id or query, not both");
  if (!entityId && !query) return undefined;

  if (entityId) {
    const exact = runs.find((run) => run.runId === entityId);
    if (!exact) throw new Error(`DAG run not found: ${entityId}`);
    return exact.runId;
  }

  const needle = normalized(query!);
  const exact = runs.filter((run) => searchableValues(run).includes(needle));
  if (exact.length === 1) return exact[0]!.runId;
  if (exact.length > 1) throw ambiguousRunError(query!, exact);
  const partial = runs.filter((run) => searchableValues(run).some((value) => value.includes(needle)));
  if (partial.length === 1) return partial[0]!.runId;
  if (partial.length > 1) throw ambiguousRunError(query!, partial);
  throw new Error(`No DAG run matches: ${query}`);
}

function ambiguousRunError(query: string, runs: readonly PersistedRunSummary[]): Error {
  return new Error(`DAG query is ambiguous: ${query}; matches=${runs.map((run) => run.runId).join(",")}`);
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const result = value.trim();
  if (!result || result.length > 256 || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new Error(`${label} must contain 1-256 printable characters`);
  }
  return result;
}

function inputRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("HomeRail UI tool input must be an object");
  }
  return value as Record<string, unknown>;
}

function normalizeWebMcpOutput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (Buffer.byteLength(value, "utf8") > 64 * 1024) {
    throw new Error("HomeRail UI tool returned oversized text");
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export async function invokeHomeRailBrowserUiTool(
  name: HomeRailUiToolName,
  rawInput: unknown,
  options: {
    browser_tools_transport?: BrowserToolsTurnTransportV1;
    browser_tools_target?: BrowserRendererConnectionRefV1 | null;
    signal?: AbortSignal;
  } = {},
): Promise<unknown> {
  const input = validateHomeRailUiToolInput(name, rawInput);
  const binding = validateBrowserToolsTurnBinding(
    options.browser_tools_transport,
    options.browser_tools_target,
  );
  if (binding.browser_tools_transport === "none") {
    throw new Error("HomeRail Browser Tools is unavailable for this turn");
  }
  const rendererTarget = binding.browser_tools_target;
  const rendererBroker = binding.browser_tools_transport === "renderer"
    ? getBrowserRendererToolsBroker()
    : null;
  const desktopBroker = binding.browser_tools_transport === "desktop"
    ? getBrowserToolsBroker()
    : null;
  if (rendererTarget) rendererBroker?.requireConnection(rendererTarget);
  if (desktopBroker && !desktopBroker.ready()) {
    throw new Error("HomeRail Desktop Browser Tools catalog is unavailable");
  }
  if (!rendererBroker && !desktopBroker) throw new Error("HomeRail Browser Tools is unavailable");
  const invoke = (toolName: HomeRailUiToolName, toolInput: unknown): Promise<unknown> => (
    binding.browser_tools_transport === "renderer"
      ? rendererBroker!.invoke(rendererTarget!, toolName, toolInput, undefined, options.signal)
      : desktopBroker!.invoke(toolName, toolInput, undefined, options.signal)
  );

  if (name === "ui_open_surface") {
    const surface = optionalString(input.surface, "surface");
    if (!surface || !HOMERAIL_UI_SURFACES.includes(surface as "dag_status")) {
      throw new Error(`Unsupported UI surface: ${surface ?? "(missing)"}`);
    }
    const runId = resolveBrowserUiDagRun(listPersistedRunSummaries(), input);
    return normalizeWebMcpOutput(await invoke(name, {
      surface,
      ...(runId ? { entity_id: runId } : {}),
    }));
  }

  // Every other stable contract has already been normalized above. Manager
  // remains the policy entry point while the renderer owns these bounded
  // presentational/read executors.
  return normalizeWebMcpOutput(await invoke(name, input));
}

async function readBrowserUiRequest(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_BROWSER_UI_REQUEST_BYTES) {
      throw new Error("Browser UI tool request exceeded the allowed size");
    }
    chunks.push(bytes);
  }
  return inputRecord(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

function singleHeader(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

function defaultTurnTarget(req: http.IncomingMessage): {
  authorized: boolean;
  browser_tools_transport: BrowserToolsTurnTransportV1;
  browser_tools_target: BrowserRendererConnectionRefV1 | null;
} {
  const scope = getManagerAgentTurnEnvelopeAuthority().authorizeApiRequestScope({
    credential: singleHeader(req.headers[HOMERAIL_MANAGER_TURN_HEADER]),
    method: req.method ?? "",
    pathname: BROWSER_UI_INVOKE_PATH,
  });
  return {
    authorized: Boolean(scope),
    browser_tools_transport: scope?.browser_tools_transport ?? "none",
    browser_tools_target: scope?.browser_tools_target ?? null,
  };
}

export function browserUiToolRoutesHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: {
    authorize?: (req: http.IncomingMessage) => boolean;
    browser_tools_transport?: BrowserToolsTurnTransportV1;
    browser_tools_target?: BrowserRendererConnectionRefV1 | null;
    invoke?: (
      name: HomeRailUiToolName,
      input: unknown,
      options?: {
        browser_tools_transport?: BrowserToolsTurnTransportV1;
        browser_tools_target?: BrowserRendererConnectionRefV1 | null;
        signal?: AbortSignal;
      },
    ) => Promise<unknown>;
  } = {},
): boolean {
  const pathname = new URL(req.url || "/", "http://localhost").pathname.replace(/\/$/, "");
  if (pathname !== BROWSER_UI_INVOKE_PATH) return false;
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
    res.end(JSON.stringify({ success: false, error: "method not allowed" }));
    return true;
  }
  const defaultTarget = options.authorize
    ? {
        authorized: options.authorize(req),
        browser_tools_transport: options.browser_tools_transport ?? "none",
        browser_tools_target: options.browser_tools_target ?? null,
      }
    : defaultTurnTarget(req);
  if (!defaultTarget.authorized) {
    req.resume();
    res.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ success: false, error: "Manager Agent turn authorization required" }));
    return true;
  }
  void readBrowserUiRequest(req)
    .then(async (body) => {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!HOMERAIL_UI_TOOL_NAMES.includes(name as HomeRailUiToolName)) {
        throw new Error(`Unsupported HomeRail UI tool: ${name || "(missing)"}`);
      }
      const input = validateHomeRailUiToolInput(name as HomeRailUiToolName, body.input);
      const abort = new AbortController();
      const cancel = (): void => abort.abort();
      req.once("aborted", cancel);
      res.once("close", cancel);
      let result: unknown;
      try {
        result = await (options.invoke ?? invokeHomeRailBrowserUiTool)(
          name as HomeRailUiToolName,
          input,
          {
            browser_tools_transport: defaultTarget.browser_tools_transport,
            browser_tools_target: defaultTarget.browser_tools_target,
            signal: abort.signal,
          },
        );
      } finally {
        req.removeListener("aborted", cancel);
        res.removeListener("close", cancel);
      }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ success: true, data: { result } }));
    })
    .catch((error) => {
      if (res.headersSent) return;
      res.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message.slice(0, 2_000) : "Browser UI tool failed",
      }));
    });
  return true;
}
