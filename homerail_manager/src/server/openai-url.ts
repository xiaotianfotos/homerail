// Shared normalization for user-supplied OpenAI-compatible base URLs.
//
// Novice users paste any of these into the base-URL field:
//   http://host:5000
//   http://host:5000/
//   http://host:5000/v1
//   http://host:5000/v1/models
//   http://host:5000/v1/chat/completions
//   ws-reachable realtime full URL: http://host:5002/v1/realtime
// All of them should resolve to the same API root so that probing and runtime
// calls find the right endpoint. Strip well-known endpoint suffixes from the
// tail; keep everything else (including a trailing /v1) untouched.

// Ordered: more specific suffixes first so /audio/speech/stream collapses to
// the API root in one pass instead of stopping at /audio/speech.
const ENDPOINT_SUFFIXES = [
  "/chat/completions",
  "/audio/transcriptions",
  "/audio/speech/stream",
  "/audio/speech",
  "/images/generations",
  "/completions",
  "/embeddings",
  "/responses",
  "/realtime",
  "/models",
];

export function normalizeOpenAiBaseUrl(value: string): string {
  let base = value.trim().replace(/\/+$/, "");
  for (;;) {
    const lower = base.toLowerCase();
    const suffix = ENDPOINT_SUFFIXES.find((candidate) => lower.endsWith(candidate));
    if (!suffix) return base;
    base = base.slice(0, -suffix.length).replace(/\/+$/, "");
  }
}

/** URL of the OpenAI-compatible model list endpoint for a user-supplied base. */
export function openAiModelsUrl(value: string): string {
  const base = normalizeOpenAiBaseUrl(value);
  return base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
}
