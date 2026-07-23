import type { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { AGENT_BUILTIN_TOOL_NAMES } from "homerail-protocol";

const BUILTIN_TOOLS = new Set<string>(AGENT_BUILTIN_TOOL_NAMES);

/**
 * Enforces the workflow's per-node built-in tool budget without blocking MCP
 * handoff. Once inspection is exhausted, the Agent can still submit its
 * structured result instead of ending in an unbounded read loop.
 */
export function createBuiltinToolBudgetHook(maxCalls: number): HookCallback {
  if (!Number.isInteger(maxCalls) || maxCalls < 1) {
    throw new Error("built-in tool budget must be a positive integer");
  }
  let calls = 0;
  return async (input) => {
    const event = input as PreToolUseHookInput;
    if (!BUILTIN_TOOLS.has(event.tool_name)) return { continue: true };
    if (calls >= maxCalls) {
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `Built-in tool budget exhausted (${maxCalls}/${maxCalls}). Stop inspecting and call an allowed HomeRail DAG handoff tool now; DAG tools remain available.`,
        },
      };
    }
    calls += 1;
    return { continue: true };
  };
}
