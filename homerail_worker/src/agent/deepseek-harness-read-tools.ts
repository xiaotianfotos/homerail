import {
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { AgentBuiltinToolName, DagWorkspaceAccess } from "homerail-protocol";
import type { DagToolDefinition } from "./types.js";

const SUPPORTED_READ_TOOLS = new Set<string>(["Read", "Grep", "Glob", "LS"]);
const MAX_DIRECTORY_ENTRIES = 20_000;
const MAX_GLOB_RESULTS = 1_000;
const MAX_GREP_RESULTS = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_READ_LINES = 2_000;
const MAX_RESULT_CHARS = 120_000;
const DEFAULT_GREP_TIMEOUT_MS = 2_000;
const MAX_GREP_TIMEOUT_MS = 30_000;

interface ReadToolOptions {
  workspace: string;
  workspaceAccess: DagWorkspaceAccess;
  allowedTools: AgentBuiltinToolName[];
  maxCalls?: number;
  grepTimeoutMs?: number;
}

interface PolicyRoots {
  workspace: string;
  roots: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeRelativePath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  return Boolean(normalized)
    && !path.posix.isAbsolute(normalized)
    && !/^[A-Za-z]:\//.test(normalized)
    && !normalized.split("/").includes("..")
    && !normalized.includes("\0");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function policyRoots(options: ReadToolOptions): PolicyRoots {
  const workspace = realpathSync(path.resolve(options.workspace));
  const configured = [
    ...options.workspaceAccess.writable_paths,
    ...(options.workspaceAccess.readonly_paths ?? []),
  ];
  const roots = configured.map((entry) => {
    if (!safeRelativePath(entry)) {
      throw new Error(`DSH workspace read policy path must be relative and traversal-free: ${entry}`);
    }
    const lexical = path.resolve(workspace, entry);
    if (!isWithin(workspace, lexical)) {
      throw new Error(`DSH workspace read policy root escapes workspace: ${entry}`);
    }
    try {
      const resolved = realpathSync(lexical);
      if (!isWithin(workspace, resolved)) {
        throw new Error(`DSH workspace read policy root escapes workspace: ${entry}`);
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
      // A declared root may be staged after the turn starts. Preserve its
      // lexical location now and resolve it again for every tool call.
    }
    return lexical;
  });
  return { workspace, roots: [...new Set(roots)] };
}

function stringArg(args: Record<string, unknown>, key: string, fallback?: string): string {
  const value = args[key] ?? fallback;
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error(`${key} must be a non-empty path or pattern`);
  }
  return value.trim();
}

function positiveIntegerArg(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  maximum: number,
): number {
  const value = args[key];
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error(`${key} must be an integer from 1 through ${maximum}`);
  }
  return Number(value);
}

function resolveTarget(policy: PolicyRoots, requested: string): string {
  if (!safeRelativePath(requested)) {
    throw new Error(`path must be relative and traversal-free: ${requested}`);
  }
  const resolved = realpathSync(path.resolve(policy.workspace, requested));
  const insideRoot = policy.roots.some((rootPath) => {
    try {
      const root = realpathSync(rootPath);
      return isWithin(policy.workspace, root) && isWithin(root, resolved);
    } catch {
      return false;
    }
  });
  if (!isWithin(policy.workspace, resolved) || !insideRoot) {
    throw new Error(`path is outside the declared workspace roots: ${requested}`);
  }
  return resolved;
}

function bounded(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n[output truncated at ${MAX_RESULT_CHARS} characters]`;
}

function result(text: string, isError = false): Awaited<ReturnType<DagToolDefinition["handler"]>> {
  return {
    content: [{ type: "text", text: bounded(text) }],
    ...(isError ? { is_error: true } : {}),
  };
}

function globMatcher(pattern: string): (candidate: string) => boolean {
  if (!pattern.trim() || pattern.length > 2_000 || pattern.includes("\0") || path.isAbsolute(pattern)) {
    throw new Error("pattern must be a relative glob of at most 2000 characters");
  }
  const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized.split("/").includes("..")) {
    throw new Error("pattern must not traverse outside the search path");
  }
  const patternSegments = normalized.split("/");
  if (patternSegments.some((segment) => !segment || (segment.includes("**") && segment !== "**"))) {
    throw new Error("globstar must occupy a complete, non-empty path segment");
  }

  const matchSegment = (segmentPattern: string, value: string): boolean => {
    let patternIndex = 0;
    let valueIndex = 0;
    let starIndex = -1;
    let retryIndex = -1;
    while (valueIndex < value.length) {
      const character = segmentPattern[patternIndex];
      if (character === "?" || character === value[valueIndex]) {
        patternIndex += 1;
        valueIndex += 1;
      } else if (character === "*") {
        starIndex = patternIndex;
        retryIndex = valueIndex;
        patternIndex += 1;
      } else if (starIndex >= 0) {
        patternIndex = starIndex + 1;
        retryIndex += 1;
        valueIndex = retryIndex;
      } else {
        return false;
      }
    }
    while (segmentPattern[patternIndex] === "*") patternIndex += 1;
    return patternIndex === segmentPattern.length;
  };

  return (candidate: string): boolean => {
    const valueSegments = candidate.split("/");
    let states = new Set<number>([0]);
    const closeGlobstars = (input: Set<number>): Set<number> => {
      const closed = new Set(input);
      for (const state of closed) {
        if (patternSegments[state] === "**") closed.add(state + 1);
      }
      return closed;
    };
    states = closeGlobstars(states);
    for (const value of valueSegments) {
      const next = new Set<number>();
      for (const state of states) {
        const segment = patternSegments[state];
        if (segment === "**") next.add(state);
        else if (segment !== undefined && matchSegment(segment, value)) next.add(state + 1);
      }
      states = closeGlobstars(next);
      if (states.size === 0) return false;
    }
    return closeGlobstars(states).has(patternSegments.length);
  };
}

const GREP_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { lstatSync, readFileSync } = require("node:fs");

function run(expression) {
  const matches = [];
  let outputChars = 0;
  for (const entry of workerData.files) {
    const stats = lstatSync(entry.path);
    if (!stats.isFile() || stats.size > workerData.maxFileBytes) continue;
    const content = readFileSync(entry.path);
    if (content.includes(0)) continue;
    const lines = content.toString("utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      expression.lastIndex = 0;
      if (!expression.test(lines[index])) continue;
      const rendered = entry.display + ":" + (index + 1) + ":" + lines[index];
      const separatorChars = matches.length > 0 ? 1 : 0;
      if (outputChars + separatorChars + rendered.length > workerData.maxResultChars) {
        const remaining = workerData.maxResultChars - outputChars - separatorChars;
        if (remaining > 0) matches.push(rendered.slice(0, remaining));
        return matches.join("\n") + "\n[output truncated at " + workerData.maxResultChars + " characters]";
      }
      matches.push(rendered);
      outputChars += separatorChars + rendered.length;
      if (matches.length >= workerData.maxResults) {
        return matches.join("\n") + "\n[results truncated at " + workerData.maxResults + " matches]";
      }
    }
  }
  return matches.join("\n");
}

let expression;
try {
  expression = new RegExp(workerData.pattern, workerData.flags);
} catch (error) {
  parentPort.postMessage({
    errorType: "invalid_regex",
    error: error instanceof Error ? error.message : String(error),
  });
}
if (expression) {
  try {
    parentPort.postMessage({ text: run(expression) });
  } catch (error) {
    parentPort.postMessage({
      errorType: "runtime",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
`;

interface GrepWorkerFile {
  path: string;
  display: string;
}

function grepInWorker(
  files: GrepWorkerFile[],
  pattern: string,
  caseInsensitive: boolean,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(GREP_WORKER_SOURCE, {
      eval: true,
      workerData: {
        files,
        pattern,
        flags: caseInsensitive ? "i" : "",
        maxFileBytes: MAX_FILE_BYTES,
        maxResults: MAX_GREP_RESULTS,
        maxResultChars: MAX_RESULT_CHARS,
      },
    });
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeAllListeners();
      void worker.terminate();
      callback();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`Grep search timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    worker.once("message", (message: unknown) => {
      finish(() => {
        if (!isRecord(message)) {
          reject(new Error("Grep worker returned an invalid response"));
        } else if (message.errorType === "invalid_regex" && typeof message.error === "string") {
          reject(new Error(`invalid Grep regular expression: ${message.error}`));
        } else if (typeof message.error === "string") {
          reject(new Error(`Grep worker failed: ${message.error}`));
        } else if (typeof message.text === "string") {
          resolve(message.text);
        } else {
          reject(new Error("Grep worker returned an invalid response"));
        }
      });
    });
    worker.once("error", (error) => finish(() => reject(error)));
    worker.once("exit", (code) => {
      if (code !== 0) finish(() => reject(new Error(`Grep worker exited with code ${code}`)));
      else finish(() => reject(new Error("Grep worker exited without a response")));
    });
  });
}

function enumerateFiles(root: string): string[] {
  const files: string[] = [];
  const pending = [root];
  let entries = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      entries += 1;
      if (entries > MAX_DIRECTORY_ENTRIES) {
        throw new Error(`workspace search exceeded ${MAX_DIRECTORY_ENTRIES} directory entries`);
      }
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile()) files.push(candidate);
    }
  }
  return files;
}

function relativeToSearchRoot(root: string, candidate: string): string {
  return path.relative(root, candidate).split(path.sep).join("/");
}

function readHandler(policy: PolicyRoots, args: Record<string, unknown>) {
  const requested = stringArg(args, "file_path");
  const target = resolveTarget(policy, requested);
  const stats = statSync(target);
  if (!stats.isFile()) throw new Error(`Read target is not a file: ${requested}`);
  if (stats.size > MAX_FILE_BYTES) {
    throw new Error(`Read target exceeds ${MAX_FILE_BYTES} bytes: ${requested}`);
  }
  const offset = positiveIntegerArg(args, "offset", 1, 10_000_000);
  const limit = positiveIntegerArg(args, "limit", 400, MAX_READ_LINES);
  const lines = readFileSync(target, "utf8").split(/\r?\n/);
  const selected = lines.slice(offset - 1, offset - 1 + limit);
  const width = String(Math.min(lines.length, offset + selected.length)).length;
  return selected.map((line, index) => `${String(offset + index).padStart(width)}\t${line}`).join("\n");
}

function lsHandler(policy: PolicyRoots, args: Record<string, unknown>) {
  const requested = stringArg(args, "path");
  const target = resolveTarget(policy, requested);
  const stats = statSync(target);
  if (!stats.isDirectory()) throw new Error(`LS target is not a directory: ${requested}`);
  const entries = readdirSync(target, { withFileTypes: true });
  if (entries.length > MAX_GLOB_RESULTS) {
    throw new Error(`LS target exceeds ${MAX_GLOB_RESULTS} entries: ${requested}`);
  }
  return entries
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : entry.isSymbolicLink() ? "@" : ""}`)
    .join("\n");
}

function globHandler(policy: PolicyRoots, args: Record<string, unknown>) {
  const requested = stringArg(args, "path");
  const root = resolveTarget(policy, requested);
  if (!statSync(root).isDirectory()) throw new Error(`Glob path is not a directory: ${requested}`);
  const matches = globMatcher(stringArg(args, "pattern"));
  const paths = enumerateFiles(root)
    .map((candidate) => relativeToSearchRoot(root, candidate))
    .filter((candidate) => matches(candidate))
    .sort();
  if (paths.length > MAX_GLOB_RESULTS) {
    return `${paths.slice(0, MAX_GLOB_RESULTS).join("\n")}\n[${paths.length - MAX_GLOB_RESULTS} additional paths omitted]`;
  }
  return paths.join("\n");
}

async function grepHandler(policy: PolicyRoots, args: Record<string, unknown>, timeoutMs: number): Promise<string> {
  const requested = stringArg(args, "path");
  const target = resolveTarget(policy, requested);
  const pattern = stringArg(args, "pattern");
  if (pattern.length > 2_000) throw new Error("pattern must be at most 2000 characters");
  const include = typeof args.glob === "string" && args.glob.trim()
    ? globMatcher(args.glob.trim())
    : undefined;
  const targetIsFile = statSync(target).isFile();
  const files = targetIsFile ? [target] : enumerateFiles(target);
  const workerFiles: GrepWorkerFile[] = [];
  for (const file of files) {
    const relative = targetIsFile ? path.basename(file) : relativeToSearchRoot(target, file);
    if (include && !include(relative)) continue;
    workerFiles.push({ path: file, display: relative });
  }
  return grepInWorker(workerFiles, pattern, args.case_insensitive === true, timeoutMs);
}

function schemaFor(name: AgentBuiltinToolName): Record<string, unknown> {
  const pathProperty = { type: "string", description: "Workspace-relative path inside a declared HomeRail root." };
  if (name === "Read") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["file_path"],
      properties: {
        file_path: pathProperty,
        offset: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1, maximum: MAX_READ_LINES },
      },
    };
  }
  if (name === "Grep") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["pattern", "path"],
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression." },
        path: pathProperty,
        glob: { type: "string", description: "Optional relative glob limiting searched files." },
        case_insensitive: { type: "boolean" },
      },
    };
  }
  if (name === "Glob") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["pattern", "path"],
      properties: {
        pattern: { type: "string", description: "Relative glob such as **/*.ts." },
        path: pathProperty,
      },
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: { path: pathProperty },
  };
}

function descriptionFor(name: AgentBuiltinToolName): string {
  if (name === "Read") return "Read a bounded line range from one file inside the HomeRail-declared workspace roots.";
  if (name === "Grep") return "Search file contents inside the HomeRail-declared workspace roots with bounded results.";
  if (name === "Glob") return "Find files by relative glob inside one HomeRail-declared workspace root.";
  return "List one directory inside the HomeRail-declared workspace roots.";
}

export function supportsDeepSeekHarnessReadTools(tools: readonly string[]): boolean {
  return tools.every((tool) => SUPPORTED_READ_TOOLS.has(tool));
}

export function createDeepSeekHarnessReadTools(options: ReadToolOptions): DagToolDefinition[] {
  if (!supportsDeepSeekHarnessReadTools(options.allowedTools)) {
    const unsupported = options.allowedTools.filter((tool) => !SUPPORTED_READ_TOOLS.has(tool));
    throw new Error(`DeepSeek Harness only supports HomeRail-managed read tools; unsupported: ${unsupported.join(", ")}`);
  }
  if (options.maxCalls !== undefined && (!Number.isInteger(options.maxCalls) || options.maxCalls < 1)) {
    throw new Error("built-in tool budget must be a positive integer");
  }
  const grepTimeoutMs = options.grepTimeoutMs ?? DEFAULT_GREP_TIMEOUT_MS;
  if (!Number.isInteger(grepTimeoutMs) || grepTimeoutMs < 1 || grepTimeoutMs > MAX_GREP_TIMEOUT_MS) {
    throw new Error(`Grep timeout must be an integer from 1 through ${MAX_GREP_TIMEOUT_MS}`);
  }
  const policy = policyRoots(options);
  let calls = 0;
  return options.allowedTools.map((name) => ({
    name,
    description: descriptionFor(name),
    input_schema: schemaFor(name),
    handler: async (args) => {
      if (!isRecord(args)) return result(`${name} arguments must be an object`, true);
      if (options.maxCalls !== undefined && calls >= options.maxCalls) {
        return result(
          `Built-in tool budget exhausted (${options.maxCalls}/${options.maxCalls}). Stop inspecting and call an allowed HomeRail DAG handoff tool now.`,
          true,
        );
      }
      calls += 1;
      try {
        const text = name === "Read"
          ? readHandler(policy, args)
          : name === "Grep"
            ? await grepHandler(policy, args, grepTimeoutMs)
            : name === "Glob"
              ? globHandler(policy, args)
              : lsHandler(policy, args);
        return result(text || "No results.");
      } catch (error) {
        return result(error instanceof Error ? error.message : String(error), true);
      }
    },
  }));
}
