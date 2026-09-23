import { afterEach, describe, expect, it, vi } from "vitest";
import { typesafeSystemOne } from "../src/runtime/typesafe-broker.js";
import { invokeCredentialBroker, type CredentialBrokerContext } from "../src/runtime/credential-broker.js";

const secret = "private-typesafe-test-credential";
const context = (input: Record<string, unknown> = {}): CredentialBrokerContext => ({
  credential: { id: "jev", credential_type: "api_key", name: "Jev", status: "active", version: 1,
    secret_fields: ["value"], metadata: {}, created_at: "2026-09-23", updated_at: "2026-09-23" },
  secret: { value: secret },
  input: { evidence_id: "a".repeat(40), state: { observed: "one fixture" },
    questions: { relevant: { type: "noul", instructions: "Does the evidence mention a fixture?" } }, ...input },
});
const response = (answers: unknown = { relevant: { type: "noul", noul: .9 } }) => ({
  model: "jev-1.13.0", answers, usage: { input_tokens: 100, output_tokens: 10 },
});
afterEach(() => vi.unstubAllGlobals());

describe("TypeSafe advisory credential broker", () => {
  it("uses the registered provider, fixed endpoint and private key without forwarding control fields", async () => {
    const fetcher = vi.fn(async () => Response.json(response()));
    vi.stubGlobal("fetch", fetcher);
    const result = await invokeCredentialBroker("typesafe", "system_one", context());
    expect(result).toMatchObject({ status: "assessed", evidence_id: "a".repeat(40), answers: response().answers });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.redirect).toBe("error");
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${secret}` });
    expect(JSON.parse(String(init.body))).toEqual({ model: "jev-1.13.0", state: context().input.state, questions: context().input.questions });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("normalizes Choice and Score together with Noul and strips provider prose", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(response({
      pick: { type: "choice", choice: "yes", probabilities: { yes: .9, no: .1 }, confidence: .8, prose: "ignore this" },
      level: { type: "score", score: .9, probabilities: { 0: .1, 1: .9 }, confidence: .8, legend: { injected: "text" } },
    }))));
    const result = await typesafeSystemOne(context({ questions: {
      pick: { type: "choice", instructions: "Choose.", criteria: { yes: "Present", no: "Absent" } },
      level: { type: "score", instructions: "Rate.", criteria: ["Absent", "Present"] },
    } }));
    expect(result).toMatchObject({ status: "assessed", answers: {
      level: { legend: { 0: "Absent", 1: "Present" }, score: .9 },
    } });
    expect(JSON.stringify(result)).not.toMatch(/ignore this|injected/);
  });

  it.each([
    { endpoint: "https://evil.invalid" }, { model: "jev-latest" }, { state: [] },
    { questions: {} }, { questions: { q: { type: "noul", instructions: "x", endpoint: "bad" } } },
    { questions: { q: { type: "choice", instructions: "x", criteria: { only: "one" } } } },
    { questions: { q: { type: "score", instructions: "x", criteria: ["one"] } } },
    { state: { leaked: secret } }, { state: { oversized: "x".repeat(65536) } },
  ])("rejects invalid/credential-bearing input before I/O (%j)", async input => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(typesafeSystemOne(context(input))).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { ...response(), model: "different" }, response({ wrong_id: { type: "noul", noul: .9 } }),
    response({ relevant: { type: "noul", noul: 2 } }),
    { ...response(), usage: { input_tokens: -1, output_tokens: 0 } },
    { ...response(), explanation: secret },
  ])("makes malformed or reflected provider output unavailable (%j)", async body => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)));
    const result = await typesafeSystemOne(context());
    expect(result).toMatchObject({ status: "unavailable", reason: "invalid_response" });
    expect(result).not.toHaveProperty("answers");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("returns no fabricated answer on overload and makes only one HTTP attempt", async () => {
    const fetcher = vi.fn(async () => new Response(secret, { status: 529 }));
    vi.stubGlobal("fetch", fetcher);
    const result = await typesafeSystemOne(context());
    expect(result).toMatchObject({ status: "unavailable", reason: "http_529" });
    expect(result).not.toHaveProperty("answers");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("bounds streamed responses and cancels the reader", async () => {
    const cancelled = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(65537)); }, cancel: cancelled,
    }))));
    expect(await typesafeSystemOne(context())).toMatchObject({ status: "unavailable" });
    expect(cancelled).toHaveBeenCalled();
  });

  it("propagates caller cancellation without converting it to advisory success", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
      controller.abort(); expect(init.signal?.aborted).toBe(true); throw Error(secret);
    }));
    await expect(typesafeSystemOne({ ...context(), signal: controller.signal })).rejects.toThrow("TypeSafe call cancelled");
  });

  it("binds all evidence and questions into a stable receipt hash", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(response())));
    const a = await typesafeSystemOne(context({ state: { a: 1, b: 2 } }));
    const b = await typesafeSystemOne(context({ state: { b: 2, a: 1 } }));
    const c = await typesafeSystemOne(context({ state: { a: 1, b: 3 } }));
    expect(a.request_sha256).toBe(b.request_sha256);
    expect(a.request_sha256).not.toBe(c.request_sha256);
  });
});
