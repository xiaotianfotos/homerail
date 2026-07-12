import { resolveConfiguredManagerUrl } from "./local-config.js";
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
  mutationToken?: string;
}

export class HomeRailClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly mutationToken?: string;

  constructor(opts: HomeRailClientOptions = {}) {
    this.baseUrl = HomeRailClient.resolveBaseUrl(opts.baseUrl);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.mutationToken = opts.mutationToken ?? process.env.HOMERAIL_DAG_MUTATION_TOKEN;
  }

  static resolveBaseUrl(override?: string): string {
    return resolveConfiguredManagerUrl(override).replace(/\/+$/, "");
  }

  async get<T = BaseResponse>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  async post<T = BaseResponse>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  async put<T = BaseResponse>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }

  async delete<T = BaseResponse>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
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
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const init: RequestInit = {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(method !== "GET" && this.mutationToken
            ? { "X-Homerail-Dag-Token": this.mutationToken }
            : {}),
        },
        signal: controller.signal,
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }

      const response = await fetch(url, init);

      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const errBody = (await response.json()) as Record<string, unknown>;
          if (typeof errBody.message === "string") {
            message = errBody.message;
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
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
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
