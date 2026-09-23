import { createHash } from "node:crypto";
import type { CredentialBrokerContext } from "./credential-broker.js";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-1.13.0";
const MAX_BYTES = 64 * 1024;
type ObjectValue = Record<string, unknown>;
type Question = { type: "noul" | "choice" | "score"; instructions: string; criteria?: unknown };

function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}
function keys(value: ObjectValue, allowed: string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}
function finite(value: unknown, max = 1): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function questions(value: unknown): Record<string, Question> {
  if (!object(value) || Object.keys(value).length < 1 || Object.keys(value).length > 32) {
    throw new Error("TypeSafe requires 1-32 questions");
  }
  for (const [id, q] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(id) || !object(q)
      || !keys(q, ["type", "instructions", "criteria"]) || !text(q.instructions, 4000)) {
      throw new Error("Invalid TypeSafe question");
    }
    if (q.type === "noul") {
      if (q.criteria !== undefined && !text(q.criteria, 4000)) throw new Error("Invalid Noul criteria");
    } else if (q.type === "choice") {
      if (!object(q.criteria) || Object.keys(q.criteria).length < 2 || Object.keys(q.criteria).length > 32
        || !Object.entries(q.criteria).every(([key, v]) => /^[a-z][a-z0-9_]{0,63}$/.test(key) && text(v, 2000))) {
        throw new Error("Invalid Choice criteria");
      }
    } else if (q.type === "score") {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10
        || !q.criteria.every(v => text(v, 2000))) throw new Error("Invalid Score criteria");
    } else throw new Error("Unsupported TypeSafe question type");
  }
  return value as Record<string, Question>;
}

function normalizeResponse(raw: unknown, model: string, request: Record<string, Question>) {
  if (!object(raw) || raw.model !== model || !object(raw.answers) || !object(raw.usage)
    || JSON.stringify(Object.keys(raw.answers).sort()) !== JSON.stringify(Object.keys(request).sort())
    || ![raw.usage.input_tokens, raw.usage.output_tokens].every(v => Number.isSafeInteger(v) && Number(v) >= 0)) {
    throw new Error("Invalid TypeSafe response identity");
  }
  const answers: ObjectValue = {};
  for (const [id, q] of Object.entries(request)) {
    const a = raw.answers[id];
    if (!object(a) || a.type !== q.type) throw new Error("Invalid TypeSafe answer type");
    if (q.type === "noul") {
      if (!finite(a.noul)) throw new Error("Invalid Noul probability");
      answers[id] = { type: q.type, noul: a.noul };
      continue;
    }
    const options = q.type === "choice" ? Object.keys(q.criteria as ObjectValue)
      : (q.criteria as string[]).map((_, i) => String(i));
    if (!finite(a.confidence) || !object(a.probabilities)
      || JSON.stringify(Object.keys(a.probabilities).sort()) !== JSON.stringify([...options].sort())
      || !Object.values(a.probabilities).every(v => finite(v))) throw new Error("Invalid answer probabilities");
    const probabilities = a.probabilities as Record<string, number>;
    if (Math.abs(Object.values(probabilities).reduce((sum, p) => sum + p, 0) - 1) > .02) {
      throw new Error("Invalid probability total");
    }
    if (q.type === "choice") {
      if (typeof a.choice !== "string" || !options.includes(a.choice)
        || probabilities[a.choice] + .001 < Math.max(...Object.values(probabilities))) throw new Error("Invalid Choice answer");
      answers[id] = { type: q.type, choice: a.choice, probabilities, confidence: a.confidence };
    } else {
      const criteria = q.criteria as string[];
      if (!finite(a.score, criteria.length - 1)
        || Math.abs(a.score - Object.entries(probabilities).reduce((sum, [key, p]) => sum + Number(key) * p, 0)) > .04) {
        throw new Error("Invalid Score answer");
      }
      // The caller's criteria own the legend; do not relay arbitrary provider text.
      answers[id] = { type: q.type, score: a.score, probabilities, confidence: a.confidence,
        legend: Object.fromEntries(criteria.map((v, i) => [String(i), v])) };
    }
  }
  return { answers, usage: { input_tokens: raw.usage.input_tokens, output_tokens: raw.usage.output_tokens } };
}

async function boundedResponse(response: Response): Promise<string> {
  if (!response.body) throw new Error("Missing TypeSafe response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BYTES) throw new Error("TypeSafe response too large");
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Typed advisory inference through the existing Manager credential boundary. */
export async function typesafeSystemOne({ credential, secret, input, signal }: CredentialBrokerContext) {
  if (credential.credential_type !== "api_key" || !secret.value) throw new Error("TypeSafe requires an API key credential");
  if (!keys(input, ["evidence_id", "state", "questions"]) || !text(input.evidence_id, 256) || !object(input.state)) {
    throw new Error("TypeSafe requires evidence_id, object state and questions");
  }
  const model = credential.metadata.labels?.model ?? DEFAULT_MODEL;
  if (!/^jev-\d+\.\d+\.\d+$/.test(model)) throw new Error("TypeSafe credential must select a pinned Jev version");
  const questionMap = questions(input.questions);
  const serialized = JSON.stringify(canonical({ model, ...input }));
  if (Buffer.byteLength(serialized) > MAX_BYTES || Object.values(secret).some(s => serialized.includes(s))) {
    throw new Error("TypeSafe input exceeds limit or contains a credential");
  }
  const identity = { model, evidence_id: input.evidence_id,
    request_sha256: createHash("sha256").update(serialized).digest("hex") };
  if (signal?.aborted) throw new Error("TypeSafe call cancelled");
  const started = performance.now();
  const timeout = AbortSignal.timeout(15_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let reason = "transport_or_timeout";
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST", redirect: "error", signal: combined,
      headers: { "content-type": "application/json", Authorization: `Bearer ${secret.value}` },
      body: JSON.stringify({ model, state: input.state, questions: questionMap }),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      reason = `http_${response.status}`;
      throw new Error("TypeSafe request failed");
    }
    reason = "invalid_response";
    const body = await boundedResponse(response);
    if (Object.values(secret).some(s => body.includes(s))) throw new Error("Reflected credential");
    const normalized = normalizeResponse(JSON.parse(body), model, questionMap);
    if (combined.aborted) throw new Error("TypeSafe call cancelled");
    return { status: "assessed", ...identity, ...normalized, elapsed_ms: Math.round(performance.now() - started) };
  } catch {
    if (signal?.aborted) throw new Error("TypeSafe call cancelled");
    // An unavailable adviser never invents probabilities or approval. No retries.
    return { status: "unavailable", ...identity, reason, elapsed_ms: Math.round(performance.now() - started) };
  }
}
