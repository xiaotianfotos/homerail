/**
 * HomeRail Protocol
 *
 * Single source of truth for all runtime communication between
 * homerail_worker, homerail_node, and homerail_manager.
 * @version 0.1.0-beta.1
 */

/**
 * Compatibility contract shared by Manager and Worker.
 *
 * This is intentionally independent from the HomeRail release version. Bump it
 * only when a Manager/Worker wire or runtime contract changes incompatibly.
 */
export const WORKER_CONTRACT_VERSION = "1";

export * from "./types.js";
export * from "./sha256.js";
export * from "./dag-activity.js";
export * from "./dag-observability.js";
export * from "./dag-worker-skill-context.js";
export * from "./dag-credentials.js";
export * from "./dag-run-inputs.js";
export * from "./dag-actor-surface-patch.js";
export * from "./dag-actor-surface-media.js";
export * from "./codec.js";
export * from "./schemas.js";
export * from "./validation.js";
export * from "./manager-agent.js";
export * from "./codex-responses.js";
export * from "./codex-provider-profiles.js";
export * from "./manager-agent-tools.js";
export * from "./manager-agent-widget-tools.js";
export * from "./manager-agent-prompt.js";
export * from "./manager-agent-skill-views.js";
export * from "./manager-agent-turn-envelope.js";
export * from "./generative-ui/index.js";
export * from "./plugins/index.js";
export * from "./telemetry-redaction.js";
export * from "./pr-closeout.js";
export * from "./pr-review.js";
export * from "./runtime-environment.js";
export * from "./browser-tools.js";
export * from "./tool-providers.js";
