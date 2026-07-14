import { getDb, parseJsonRow } from "../persistence/db.js";
import { readManagerAgentConfig } from "../persistence/manager-agent-config.js";
import {
  resolveConfiguredGenerativeUiModeDetails,
  resolveSessionGenerativeUiMode,
  type GenerativeUiMode,
} from "./mode.js";

export type GenerativeUiDocumentPurpose = "canonical" | "legacy_widget_shadow";

export class VoiceGenerativeUiSessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Voice workspace not found: ${sessionId}`);
    this.name = "VoiceGenerativeUiSessionNotFoundError";
  }
}

/**
 * Resolve the live, fail-closed rollout authority for a persisted Voice
 * session. This is shared by the read projection and the Tool Bus so an
 * operational `off` switch revokes both rendering and in-flight Tool writes.
 */
export function resolveVoiceSessionGenerativeUiMode(sessionId: string): GenerativeUiMode {
  const row = getDb().prepare(`
    SELECT data FROM voice_agent_sessions WHERE session_id = ?
  `).get(sessionId) as { data: string } | undefined;
  if (!row) throw new VoiceGenerativeUiSessionNotFoundError(sessionId);
  try {
    const workspace = parseJsonRow<{ generative_ui_mode?: unknown }>(row.data);
    const globalMode = resolveConfiguredGenerativeUiModeDetails(
      readManagerAgentConfig().generative_ui_mode,
    ).effective_mode;
    return resolveSessionGenerativeUiMode(workspace.generative_ui_mode, globalMode);
  } catch {
    return "off";
  }
}

export function documentPurposeForGenerativeUiMode(
  mode: GenerativeUiMode,
): GenerativeUiDocumentPurpose | undefined {
  if (mode === "prefer") return "canonical";
  if (mode === "shadow") return "legacy_widget_shadow";
  return undefined;
}
