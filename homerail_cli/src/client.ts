import {
  resolveConfiguredManagerAdminToken,
  resolveConfiguredManagerUrl,
} from "./local-config.js";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface BaseResponse {
  success: boolean;
  message: string;
  data?: unknown;
  error?: string;
}

export interface HomeRailClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  adminToken?: string;
  mutationToken?: string;
}

export class HomeRailClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  private readonly adminToken?: string;
  readonly mutationToken?: string;

  constructor(opts: HomeRailClientOptions = {}) {
    this.baseUrl = HomeRailClient.resolveBaseUrl(opts.baseUrl);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.adminToken = opts.adminToken === undefined
      ? resolveConfiguredManagerAdminToken()
      : opts.adminToken || undefined;
    this.mutationToken = opts.mutationToken ?? process.env.HOMERAIL_DAG_MUTATION_TOKEN;
  }

  static resolveBaseUrl(override?: string): string {
    return resolveConfiguredManagerUrl(override).replace(/\/+$/, "");
  }

  async get<T = BaseResponse>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  async post<T = BaseResponse>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body === undefined ? undefined : {
      type: "json",
      value: body,
    });
  }

  async postBinary<T = BaseResponse>(
    path: string,
    body: Uint8Array,
    contentType = "application/vnd.homerail.plugin+zip",
  ): Promise<T> {
    return this.request<T>("POST", path, {
      type: "binary",
      value: Uint8Array.from(body),
      contentType,
    });
  }

  async put<T = BaseResponse>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", path, body === undefined ? undefined : {
      type: "json",
      value: body,
    });
  }

  async patch<T = BaseResponse>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body === undefined ? undefined : {
      type: "json",
      value: body,
    });
  }

  async delete<T = BaseResponse>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("DELETE", path, body === undefined ? undefined : {
      type: "json",
      value: body,
    });
  }

  async getRunStatus(runId: string): Promise<BaseResponse> {
    return this.get(`/api/runs/${encodeURIComponent(runId)}/status`);
  }

  async getDagStatus(runId: string): Promise<BaseResponse> {
    return this.get(`/api/dag-status/${encodeURIComponent(runId)}`);
  }

  async getDagEvents(runId: string): Promise<BaseResponse> {
    return this.get(`/api/dag-status/${encodeURIComponent(runId)}/events/history`);
  }

  async getNodeChat(runId: string, nodeId: string): Promise<BaseResponse> {
    return this.get(
      `/api/dag-status/${encodeURIComponent(runId)}/node/${encodeURIComponent(nodeId)}/chat`,
    );
  }

  async getScorecard(runId: string): Promise<BaseResponse> {
    return this.get(`/api/runs/${encodeURIComponent(runId)}/scorecard`);
  }

  async getScorecardWithOptions(
    runId: string,
    opts: { sourceIssue?: string } = {},
  ): Promise<BaseResponse> {
    return this.get(
      withQuery(`/api/runs/${encodeURIComponent(runId)}/scorecard`, {
        source_issue: opts.sourceIssue,
      }),
    );
  }

  async getEvalRun(
    runId: string,
    opts: {
      events?: number;
      tools?: number;
      contentLimit?: number;
      sourceIssue?: string;
    } = {},
  ): Promise<BaseResponse> {
    return this.get(
      withQuery(`/api/runs/${encodeURIComponent(runId)}/eval-run`, {
        events: opts.events,
        tools: opts.tools,
        content_limit: opts.contentLimit,
        source_issue: opts.sourceIssue,
      }),
    );
  }

  async getReplay(
    runId: string,
    opts: { sourceIssue?: string } = {},
  ): Promise<BaseResponse> {
    return this.get(
      withQuery(`/api/runs/${encodeURIComponent(runId)}/replay`, {
        source_issue: opts.sourceIssue,
      }),
    );
  }

  async inject(
    runId: string,
    nodeId: string,
    instruction: string,
    mode: string,
  ): Promise<BaseResponse> {
    return this.post(`/api/runs/${encodeURIComponent(runId)}/inject`, {
      node_id: nodeId,
      instruction,
      mode,
    });
  }

  async checkpointResume(
    runId: string,
    nodeId: string,
    opts: {
      instruction: string;
      uuid?: string;
      last?: number;
      sessionId?: string;
    },
  ): Promise<BaseResponse> {
    return this.post(
      `/api/runs/${encodeURIComponent(runId)}/node/${encodeURIComponent(nodeId)}/checkpoint-resume`,
      {
        instruction: opts.instruction,
        uuid: opts.uuid,
        last: opts.last,
        session_id: opts.sessionId,
      },
    );
  }

  private async request<T>(
    method: string,
    path: string,
    payload?:
      | { type: "json"; value: unknown }
      | { type: "binary"; value: Uint8Array; contentType: string },
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const init: RequestInit = {
        method,
        headers: {
          Accept: "application/json",
          ...(this.adminToken && isProtectedApiMutationRequest(method, path) ? {
            Authorization: `Bearer ${this.adminToken}`,
          } : {}),
          ...(method !== "GET" && this.mutationToken
            ? { "X-Homerail-Dag-Token": this.mutationToken }
            : {}),
          ...(payload ? {
            "Content-Type": payload.type === "json"
              ? "application/json"
              : payload.contentType,
          } : {}),
        },
        signal: controller.signal,
      };
      if (payload?.type === "json") {
        init.body = JSON.stringify(payload.value);
      } else if (payload?.type === "binary") {
        init.body = payload.value as BodyInit;
      }

      const response = await fetch(url, init);

      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const errBody = (await response.json()) as Record<string, unknown>;
          if (typeof errBody.message === "string") {
            message = errBody.message;
          } else if (typeof errBody.error === "string") {
            message = errBody.error;
          }
        } catch {
          // ignore parse error on error body
        }
        throw new Error(message);
      }

      return (await response.json()) as T;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Request timed out after ${this.timeoutMs}ms`);
      }
      throw redactClientError(err, this.adminToken, this.mutationToken);
    } finally {
      clearTimeout(timer);
    }
  }
}

function isProtectedApiMutationRequest(method: string, pathValue: string): boolean {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase())) return false;
  try {
    const pathname = new URL(pathValue, "http://localhost").pathname;
    return pathname === "/api" || pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

function redactClientError(
  error: unknown,
  adminToken: string | undefined,
  mutationToken: string | undefined,
): Error {
  let message = error instanceof Error ? error.message : String(error);
  if (adminToken) message = message.split(adminToken).join("***REDACTED***");
  if (mutationToken) message = message.split(mutationToken).join("***REDACTED***");
  message = message.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1***REDACTED***");
  const safe = new Error(message);
  if (error instanceof Error) safe.name = error.name;
  return safe;
}

function withQuery(
  path: string,
  params: Record<string, string | number | undefined>,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      query.set(key, String(value));
    }
  }
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}
