/**
 * Agent client types for homerail_worker.
 *
 * Shared agent client interface for HomeRail workers.
 * @version 0.1.0
 */

import type { AgentBuiltinToolName, AgentToolDefinition, DagWorkspaceAccess } from "homerail-protocol";
import type { AgentTurnController } from "./turn-controller.js";

/** Tool definition with a runtime handler (extends protocol's AgentToolDefinition). */
export interface DagToolDefinition extends AgentToolDefinition {
  handler: (args: Record<string, unknown>, context?: { tool_call_id?: string }) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    is_error?: boolean;
  }>;
}

/** A trusted Skill body projected into an agent backend for one turn. */
export interface AgentSkillDefinition {
  id: string;
  name?: string;
  description?: string;
  content: string;
}

/**
 * Explicit Skill visibility for one agent turn. Backends must not add ambient
 * user or project Skills when this projection is present.
 */
export interface AgentSkillProjection {
  mode: "explicit";
  directories?: string[];
  definitions?: AgentSkillDefinition[];
}

/** Token usage snapshot reported by the model backend. All fields optional —
 * different agent backends expose different subsets. The prompt-runner
 * accumulates these per node and forwards the totals to the manager. */
export interface AgentUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  /** Provider-advertised output token cap; absent when the provider hides it. */
  output_token_limit?: number;
}

/**
 * Turn-local sink for complete backend-native trace records. Implementations
 * must keep these records outside the Manager control-plane event stream.
 */
export interface AgentRawTraceSink {
  write(record: Record<string, unknown>): Promise<void>;
}

/** Events emitted by an agent during execution. */
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "progress"; text: string }
  | { type: "commentary"; text: string }
  | { type: "thinking"; text: string }
  | { type: "debug"; source: string; message: string; data?: Record<string, unknown> }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  | {
      type: "usage";
      usage: AgentUsage;
      /** Latest provider finish/stop reason seen so far; null when unknown. */
      finish_reason?: string | null;
      /** Latest provider output token cap seen so far; null when unknown. */
      output_token_limit?: number | null;
    }
  | { type: "error"; message: string }
  | { type: "turn_complete" }
  | {
      type: "done";
      usage?: AgentUsage;
      duration_ms?: number;
      num_turns?: number;
      /** Provider finish/stop reason; null/undefined when unavailable. */
      finish_reason?: string | null;
      /** Provider-advertised output token cap; null/undefined when unavailable. */
      output_token_limit?: number | null;
    };

/** Abstract agent client interface. */
export interface AgentClient {
  /**
   * Run the agent with a prompt and available tools.
   * Returns an async iterable of events.
   */
  run(
    prompt: string,
    tools: DagToolDefinition[],
    context: AgentRunContext,
  ): AsyncIterable<AgentEvent>;

  /** Resume a paused/interrupted session from disk. Returns stored context or null. */
  resume?(sessionId: string): Promise<AgentRunContext | null>;
}

/** Context passed to the agent for a single run. */
export interface AgentRunContext {
  systemPrompt?: string;
  /**
   * `append` preserves the Claude Code preset and adds HomeRail instructions.
   * Claude SDK defaults to `append`; `replace` remains available for explicit
   * experiments. Other backends keep their existing custom prompt behavior.
   */
  systemPromptMode?: "replace" | "append";
  provider?: string;
  protocol?: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  /** Provider-owned reasoning selector chosen by the runtime profile. */
  reasoningEffort?: string;
  /** Selectable reasoning ids mapped to the configured provider's wire values. */
  reasoningEffortMap?: Record<string, string | null> | false;
  /** Explicit command sandbox selected by the trusted DAG runtime policy. */
  codexSandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** Optional provider service tier; null means provider default. */
  serviceTier?: string | null;
  /** Claude-compatible gateway credential header contract. */
  anthropicAuthMode?: "api_key" | "auth_token";
  maxIterations?: number;
  workspace?: string;
  /** Stable backend-native session id for multi-turn Manager Agent use. */
  sessionId?: string;
  /** Resume the backend-native transcript identified by sessionId. */
  resumeSession?: boolean;
  /** Keep backend configuration and transcript storage across turns. */
  persistSession?: boolean;
  abortSignal?: AbortSignal;
  /** Provider-neutral control plane for the currently executing agent turn. */
  turnController?: AgentTurnController;
  /** Contract-correction turns may only submit a DAG handoff. */
  handoffOnly?: boolean;
  /** Exact allowlist for backend-provided shell and file tools. */
  allowedBuiltinTools?: AgentBuiltinToolName[];
  /** Hard per-turn budget for built-in tools; HomeRail DAG tools are not counted or denied. */
  maxBuiltinToolCalls?: number;
  /** Filesystem roots available to built-in tools for this DAG turn. */
  workspaceAccess?: DagWorkspaceAccess;
  /**
   * Claude Agent SDK permission policy for this run. Docker DAG Workers use
   * the adapter default (`bypassPermissions`); the host Manager Agent uses
   * `dontAsk` with every exposed built-in and HomeRail MCP tool pre-approved.
   */
  claudePermissionMode?: "bypassPermissions" | "dontAsk";
  /** Trusted Skills visible to this turn. */
  skillProjection?: AgentSkillProjection;
  /** Turn-scoped environment assembled from encrypted credential references. */
  environmentVariables?: Readonly<Record<string, string>>;
  /** Optional durable backend-native trace sink owned by the prompt runner. */
  rawTraceSink?: AgentRawTraceSink;
}
