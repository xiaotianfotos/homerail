/**
 * HomeRail Protocol — v0.1.0
 *
 * Single source of truth for all runtime communication between
 * homerail_worker, homerail_node, and homerail_manager.
 * @version 0.1.0
 */

export const PROTOCOL_VERSION = "0.1.0";

export * from "./types.js";
export * from "./codec.js";
export * from "./schemas.js";
export * from "./validation.js";
export * from "./manager-agent.js";
export * from "./manager-agent-tools.js";
export * from "./manager-agent-widget-tools.js";
export * from "./manager-agent-prompt.js";
export * from "./telemetry-redaction.js";
export * from "./pr-closeout.js";
export * from "./pr-review.js";
