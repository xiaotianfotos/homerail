export interface ReviewRecoveryFence {
  readonly runId: string;
  readonly nodeId: string;
  readonly sessionId: string;
  readonly roundId: string;
  readonly generation: number;
}

export interface ReviewRecoveryInput {
  readonly fence: ReviewRecoveryFence;
  readonly chats: readonly unknown[];
}

export interface ReviewRecoveryDraft {
  readonly text: string;
  readonly truncated: boolean;
  readonly timestamp: number;
}

export interface ReviewRecovery {
  readonly schema: "review-recovery-v1";
  readonly mode: "read_only_verify";
  readonly trust: "unverified_model_draft";
  readonly fence: ReviewRecoveryFence;
  readonly max_builtin_tool_calls: 32;
  readonly draft: ReviewRecoveryDraft | null;
}

const MAX_DRAFT_BYTES = 8192;

export function buildReviewRecovery(input: ReviewRecoveryInput): ReviewRecovery {
  const { fence, chats } = input;
  return {
    schema: "review-recovery-v1",
    mode: "read_only_verify",
    trust: "unverified_model_draft",
    fence: { runId: fence.runId, nodeId: fence.nodeId, sessionId: fence.sessionId, roundId: fence.roundId, generation: fence.generation },
    max_builtin_tool_calls: 32,
    draft: extractDraft(fence, chats),
  };
}

function extractDraft(fence: ReviewRecoveryFence, chats: readonly unknown[]): ReviewRecoveryDraft | null {
  for (let i = chats.length - 1; i >= 0; i--) {
    const entry = chats[i];
    if (entry === null || entry === undefined || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    if (obj.role !== "worker") continue;
    if (obj.type !== "response") continue;
    const content = obj.content;
    if (content === null || content === undefined || typeof content !== "object") continue;
    const c = content as Record<string, unknown>;
    if (typeof c.text !== "string") continue;
    // content.type must be absent or "text"
    if (c.type !== undefined && c.type !== "text") continue;
    // Exact fence match required
    if (c.run_id !== fence.runId) continue;
    if (c.node_id !== fence.nodeId) continue;
    if (c.session_id !== fence.sessionId) continue;
    if (c.round_id !== fence.roundId) continue;
    if (c.generation !== fence.generation) continue;
    // Skip whitespace-only
    if (c.text.trim().length === 0) continue;
    // Require finite numeric timestamp on the entry
    const ts = obj.timestamp;
    if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
    return capToUtf8Bytes(c.text, ts);
  }
  return null;
}

function capToUtf8Bytes(text: string, timestamp: number): ReviewRecoveryDraft {
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= MAX_DRAFT_BYTES) {
    return { text, truncated: false, timestamp };
  }
  let byteCount = 0;
  let cutIndex = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const cpBytes = cp <= 0x7F ? 1 : cp <= 0x7FF ? 2 : cp <= 0xFFFF ? 3 : 4;
    if (byteCount + cpBytes > MAX_DRAFT_BYTES) break;
    byteCount += cpBytes;
    i += cp > 0xFFFF ? 2 : 1;
    cutIndex = i;
  }
  return { text: text.slice(0, cutIndex), truncated: true, timestamp };
}
