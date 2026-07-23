import type { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import type { DagWorkspaceAccess } from "homerail-protocol";
import { realpathSync } from "node:fs";
import path from "node:path";

const READ_TOOL_PATH_FIELDS = new Map<string, string>([
  ["Read", "file_path"],
  ["Grep", "path"],
  ["Glob", "path"],
  ["LS", "path"],
]);

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function safePolicyPath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  return Boolean(normalized)
    && !path.posix.isAbsolute(normalized)
    && !/^[A-Za-z]:\//.test(normalized)
    && !normalized.split("/").includes("..")
    && !normalized.includes("\0");
}

function safeGlobPattern(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) return false;
  const normalized = value.replace(/\\/g, "/");
  return !path.posix.isAbsolute(normalized)
    && !/^[A-Za-z]:\//.test(normalized)
    && !normalized.split("/").includes("..");
}

function policyRootPaths(workspaceRoot: string, access: DagWorkspaceAccess): string[] {
  const roots = new Set<string>();
  for (const configured of [...access.writable_paths, ...(access.readonly_paths ?? [])]) {
    if (!safePolicyPath(configured)) {
      throw new Error(`workspace read policy path must be relative and traversal-free: ${configured}`);
    }
    const rootPath = path.resolve(workspaceRoot, configured);
    if (!isWithin(workspaceRoot, rootPath)) {
      throw new Error(`workspace read policy root escapes workspace: ${configured}`);
    }
    try {
      const root = realpathSync(rootPath);
      if (!isWithin(workspaceRoot, root)) {
        throw new Error(`workspace read policy root escapes workspace: ${configured}`);
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
      // A writable path may be created later in the agent turn. Keep its
      // lexical location now, then resolve and contain it at each tool call.
    }
    roots.add(rootPath);
  }
  return [...roots];
}

function isInsideResolvedPolicyRoot(
  workspaceRoot: string,
  policyRootPath: string,
  target: string,
): boolean {
  try {
    const root = realpathSync(policyRootPath);
    return isWithin(workspaceRoot, root) && isWithin(root, target);
  } catch {
    return false;
  }
}

function deny(reason: string): ReturnType<HookCallback> {
  return Promise.resolve({
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

/**
 * Confines Claude's built-in read/search tools to paths declared by the DAG
 * workspace policy. The SDK's cwd and `workspace_access` snapshot are not a
 * read sandbox on their own: absolute paths and symlinks must be rejected
 * before the tool executes.
 */
export function createWorkspaceReadToolHook(
  workspace: string,
  access: DagWorkspaceAccess,
): HookCallback {
  const workspaceRoot = realpathSync(path.resolve(workspace));
  const policyRoots = policyRootPaths(workspaceRoot, access);
  return async (input) => {
    const event = input as PreToolUseHookInput;
    const pathField = READ_TOOL_PATH_FIELDS.get(event.tool_name);
    if (!pathField) return { continue: true };
    const toolInput = event.tool_input;
    if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) {
      return deny(`${event.tool_name} requires a path inside the declared workspace roots`);
    }
    const record = toolInput as Record<string, unknown>;
    const requestedPath = record[pathField];
    if (typeof requestedPath !== "string" || !requestedPath.trim() || requestedPath.includes("\0")) {
      return deny(`${event.tool_name}.${pathField} must name a path inside the declared workspace roots`);
    }
    if (event.tool_name === "Glob" && !safeGlobPattern(record.pattern)) {
      return deny("Glob.pattern must be relative and traversal-free");
    }
    let target: string;
    try {
      target = realpathSync(path.resolve(workspaceRoot, requestedPath));
    } catch {
      return deny(`${event.tool_name} target could not be resolved inside the declared workspace roots`);
    }
    if (!policyRoots.some((root) => isInsideResolvedPolicyRoot(workspaceRoot, root, target))) {
      return deny(`${event.tool_name} target is outside the declared workspace roots`);
    }
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    };
  };
}
