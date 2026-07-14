import {
  resolvePrCloseout,
  type PrCloseoutEvidence as SharedPrCloseoutEvidence,
  type PrCloseoutRunSnapshot,
  type ResolvedPrCloseoutInput as SharedResolvedPrCloseoutInput,
} from "homerail-protocol";

import type { HomeRailClient } from "../client.js";

export type PrCloseoutEvidence = SharedPrCloseoutEvidence;
export type ResolvedPrCloseoutInput = SharedResolvedPrCloseoutInput;

interface ResolveOptions {
  client?: HomeRailClient;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  apiBaseUrl?: string;
}

function githubHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const token = env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "HomeRail-PR-Closeout",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function githubJson(
  fetchImpl: typeof fetch,
  baseUrl: string,
  endpoint: string,
  env: NodeJS.ProcessEnv,
): Promise<unknown> {
  const response = await fetchImpl(`${baseUrl}${endpoint}`, { headers: githubHeaders(env) });
  if (!response.ok) throw new Error(`GitHub closeout lookup failed for ${endpoint}: HTTP ${response.status}`);
  return await response.json() as unknown;
}

async function githubReviewThreads(
  fetchImpl: typeof fetch,
  baseUrl: string,
  repo: string,
  pr: number,
  env: NodeJS.ProcessEnv,
): Promise<{ verified: boolean; unresolved: number | null }> {
  const token = env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
  if (!token) return { verified: false, unresolved: null };
  const [owner, name] = repo.split("/");
  const response = await fetchImpl(`${baseUrl}/graphql`, {
    method: "POST",
    headers: { ...githubHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify({
      query: "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}}}}}",
      variables: { owner, name, number: pr },
    }),
  });
  if (!response.ok) return { verified: false, unresolved: null };
  const body = await response.json() as Record<string, unknown>;
  if (Array.isArray(body.errors) && body.errors.length > 0) return { verified: false, unresolved: null };
  const data = body.data as Record<string, unknown> | undefined;
  const repository = data?.repository as Record<string, unknown> | undefined;
  const pullRequest = repository?.pullRequest as Record<string, unknown> | undefined;
  const threads = pullRequest?.reviewThreads as Record<string, unknown> | undefined;
  const nodes = Array.isArray(threads?.nodes) ? threads.nodes as Record<string, unknown>[] : undefined;
  return nodes
    ? { verified: true, unresolved: nodes.filter((node) => node.isResolved !== true).length }
    : { verified: false, unresolved: null };
}

function responseData(response: unknown): Record<string, unknown> {
  const data = (response as { data?: unknown }).data;
  return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
}

async function managerRunSnapshot(client: HomeRailClient, runId: string): Promise<PrCloseoutRunSnapshot> {
  const encoded = encodeURIComponent(runId);
  const metadata = responseData(await client.get(`/api/runs/${encoded}`));
  const status = responseData(await client.get(`/api/runs/${encoded}/status`));
  const handoffData = responseData(await client.get(`/api/runs/${encoded}/handoffs`));
  const handoffs = Array.isArray(handoffData.handoffs)
    ? handoffData.handoffs.filter(
        (item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)),
      )
    : [];
  return { metadata, status, handoffs };
}

export async function resolvePrCloseoutInput(
  input: Record<string, unknown>,
  options: ResolveOptions = {},
): Promise<ResolvedPrCloseoutInput> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const env = options.env ?? process.env;
  const apiBaseUrl = (options.apiBaseUrl ?? env.HOMERAIL_GITHUB_API_BASE_URL ?? "https://api.github.com")
    .replace(/\/+$/, "");
  return await resolvePrCloseout(input, {
    github: (endpoint) => githubJson(fetchImpl, apiBaseUrl, endpoint, env),
    reviewThreads: (repo, pr) => githubReviewThreads(fetchImpl, apiBaseUrl, repo, pr, env),
    ...(options.client ? { run: (runId: string) => managerRunSnapshot(options.client!, runId) } : {}),
  });
}

export function manualCloseoutEnvelope(input: ResolvedPrCloseoutInput): Record<string, unknown> {
  return {
    trigger_id: "manual",
    trigger_type: "manual",
    fire_key: `pr-closeout:${input.repo}#${input.pr}:${input.head}:${input.phase}`,
    payload: input,
  };
}
