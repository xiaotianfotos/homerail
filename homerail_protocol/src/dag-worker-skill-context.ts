import { stableStringify } from "./codec.js";
import {
  validateHomerailA2uiSurface,
} from "./generative-ui/validation.js";
import type { HomerailA2uiSurfaceV1 } from "./generative-ui/a2ui.js";
import { HOMERAIL_PLUGIN_ID_PATTERN } from "./plugins/types.js";

/** @version 1 */
export const DAG_WORKER_SKILL_CONTEXT_VERSION = 1 as const;
export const DAG_WORKER_SKILL_MAX_COUNT = 8;
export const DAG_WORKER_SKILL_MAX_BYTES = 32 * 1024;
export const DAG_WORKER_SKILL_CONTEXT_MAX_BYTES = 64 * 1024;
export const DAG_WORKER_SKILL_RUN_MAX_BYTES = 1024 * 1024;

export const DAG_WORKER_SKILL_SOURCES = ["home", "repo", "plugin"] as const;
export type DagWorkerSkillSource = (typeof DAG_WORKER_SKILL_SOURCES)[number];

export interface DagWorkerSkillPluginV1 {
  id: string;
  version: string;
}

export interface DagWorkerSkillVisualProfileV1 {
  profile_version: 1;
  views?: Array<{
    id: string;
    a2ui: HomerailA2uiSurfaceV1;
  }>;
  data_fields?: string[];
  media_roles?: string[];
  recommended_size?: {
    width: number;
    height: number;
  };
  mobile_fallback?: "compact" | "stack" | "summary" | "text";
}

export interface DagWorkerSkillV1 {
  id: string;
  source: DagWorkerSkillSource;
  digest: string;
  content: string;
  plugin?: DagWorkerSkillPluginV1;
  visual_profile?: DagWorkerSkillVisualProfileV1;
}

export interface DagWorkerSkillContextV1 {
  context_version: typeof DAG_WORKER_SKILL_CONTEXT_VERSION;
  context_digest: string;
  total_bytes: number;
  skills: DagWorkerSkillV1[];
}

export interface DagWorkerSkillContextSummaryV1 {
  context_version: typeof DAG_WORKER_SKILL_CONTEXT_VERSION;
  context_digest: string;
  total_bytes: number;
  skills: Array<{
    id: string;
    digest: string;
    bytes: number;
  }>;
}

export interface DagWorkerSkillContextValidationIssue {
  path: string;
  message: string;
  keyword: string;
}

export interface DagWorkerSkillContextValidationResult {
  valid: boolean;
  value?: DagWorkerSkillContextV1;
  errors: DagWorkerSkillContextValidationIssue[];
}

export class DagWorkerSkillContextValidationError extends Error {
  constructor(public readonly errors: DagWorkerSkillContextValidationIssue[]) {
    super(errors.map((error) => `${error.path || "/"}: ${error.message}`).join("; "));
    this.name = "DagWorkerSkillContextValidationError";
  }
}

export type DagWorkerSkillInputV1 = Omit<DagWorkerSkillV1, "digest"> & {
  digest?: string;
};

const SHA256 = /^[a-f0-9]{64}$/;
const SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PLUGIN_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PROFILE_FIELD = /^[A-Za-z0-9_./-]{1,128}$/;
const MAX_VISUAL_PROFILE_BYTES = 64 * 1024;

const SHA256_INITIAL = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);
const SHA256_ROUND = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const FIXED_CREDENTIAL_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/i, "private key"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/, "AWS access key"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/, "GitHub token"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, "GitHub token"],
  [/\bxox[baprs]-[A-Za-z0-9-]{16,}\b/, "Slack token"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/, "API key"],
  [/\bAuthorization\s*:\s*(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=:-]{12,}/i, "authorization credential"],
  [/\bBearer\s+[A-Za-z0-9._~+\/-]{16,}\b/i, "bearer token"],
  [/\b[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s/:@]+:[^\s/@]+@/, "URL credential"],
];

const SECRET_ASSIGNMENT = /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|secret|password|credential|authorization)\b\s*[:=]\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s#;,]+))/gi;

function issue(path: string, message: string, keyword: string): never {
  throw new DagWorkerSkillContextValidationError([{ path, message, keyword }]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    issue(path, `unexpected field '${unexpected.sort()[0]}'`, "additionalProperties");
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function rotateRight(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}

/** Browser-safe synchronous SHA-256 for bounded protocol payloads. */
function sha256Utf8(value: string): string {
  const input = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const bitLength = BigInt(input.length) * 8n;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Number(bitLength >> 32n), false);
  view.setUint32(paddedLength - 4, Number(bitLength & 0xffff_ffffn), false);

  const state = new Uint32Array(SHA256_INITIAL);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15]!;
      const previous2 = words[index - 2]!;
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }

    let a = state[0]!;
    let b = state[1]!;
    let c = state[2]!;
    let d = state[3]!;
    let e = state[4]!;
    let f = state[5]!;
    let g = state[6]!;
    let h = state[7]!;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choice + SHA256_ROUND[index]! + words[index]!) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    state[0] = (state[0]! + a) >>> 0;
    state[1] = (state[1]! + b) >>> 0;
    state[2] = (state[2]! + c) >>> 0;
    state[3] = (state[3]! + d) >>> 0;
    state[4] = (state[4]! + e) >>> 0;
    state[5] = (state[5]! + f) >>> 0;
    state[6] = (state[6]! + g) >>> 0;
    state[7] = (state[7]! + h) >>> 0;
  }
  return Array.from(state, (word) => word.toString(16).padStart(8, "0")).join("");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function looksLikePlaceholder(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return true;
  if (/^(?:<[^>]+>|\[[^\]]+\]|\$\{[^}]+\}|\$[A-Z_][A-Z0-9_]*|\*+|x{4,})$/i.test(normalized)) return true;
  if (/^(?:example|placeholder|redacted|replace[_-]?me|your[_-]?|test[_-]?|dummy[_-]?)/i.test(normalized)) return true;
  if (/^(?:process\.)?env\.[A-Z_][A-Z0-9_]*$/i.test(normalized)) return true;
  return false;
}

export function detectObviousCredential(content: string): string | undefined {
  for (const [pattern, label] of FIXED_CREDENTIAL_PATTERNS) {
    if (pattern.test(content)) return label;
  }
  SECRET_ASSIGNMENT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SECRET_ASSIGNMENT.exec(content)) !== null) {
    const candidate = (match[2] ?? match[3] ?? match[4] ?? "").trim();
    if (!looksLikePlaceholder(candidate) && utf8Bytes(candidate) >= 8) {
      return `${match[1].toLowerCase()} assignment`;
    }
  }
  return undefined;
}

export function digestDagWorkerSkillContent(content: string): string {
  return sha256Utf8(content);
}

function assertString(value: unknown, path: string, minLength: number, maxLength: number): string {
  if (typeof value !== "string" || value.length < minLength || value.length > maxLength || value.includes("\0")) {
    issue(path, `must be a string between ${minLength} and ${maxLength} characters without NUL bytes`, "type");
  }
  return value;
}

function assertStringArray(
  value: unknown,
  path: string,
  maxItems: number,
  pattern: RegExp,
): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    issue(path, `must be an array with at most ${maxItems} items`, "maxItems");
  }
  const result = value.map((entry, index) => {
    const text = assertString(entry, `${path}/${index}`, 1, 128);
    if (!pattern.test(text) || text.includes("..")) issue(`${path}/${index}`, "has an invalid identifier", "pattern");
    return text;
  });
  if (new Set(result).size !== result.length) issue(path, "must not contain duplicate items", "uniqueItems");
  return result;
}

function parseVisualProfile(value: unknown, path: string): DagWorkerSkillVisualProfileV1 {
  if (!isRecord(value)) issue(path, "must be an object", "type");
  exactKeys(value, [
    "profile_version",
    "views",
    "data_fields",
    "media_roles",
    "recommended_size",
    "mobile_fallback",
  ], path);
  if (value.profile_version !== 1) issue(`${path}/profile_version`, "must equal 1", "const");

  const profile: DagWorkerSkillVisualProfileV1 = { profile_version: 1 };
  if (value.views !== undefined) {
    if (!Array.isArray(value.views) || value.views.length > 8) {
      issue(`${path}/views`, "must be an array with at most 8 items", "maxItems");
    }
    const ids = new Set<string>();
    profile.views = value.views.map((entry, index) => {
      const entryPath = `${path}/views/${index}`;
      if (!isRecord(entry)) issue(entryPath, "must be an object", "type");
      exactKeys(entry, ["id", "a2ui"], entryPath);
      const id = assertString(entry.id, `${entryPath}/id`, 1, 128);
      if (!PROFILE_ID.test(id)) issue(`${entryPath}/id`, "has an invalid identifier", "pattern");
      if (ids.has(id)) issue(`${path}/views`, `contains duplicate view id '${id}'`, "uniqueItems");
      ids.add(id);
      const validation = validateHomerailA2uiSurface(entry.a2ui);
      if (!validation.valid || !validation.value) {
        issue(`${entryPath}/a2ui`, "failed HomeRail A2UI surface validation", "a2ui");
      }
      return { id, a2ui: clone(validation.value) };
    });
  }
  if (value.data_fields !== undefined) {
    profile.data_fields = assertStringArray(value.data_fields, `${path}/data_fields`, 64, PROFILE_FIELD);
  }
  if (value.media_roles !== undefined) {
    profile.media_roles = assertStringArray(value.media_roles, `${path}/media_roles`, 32, PROFILE_FIELD);
  }
  if (value.recommended_size !== undefined) {
    if (!isRecord(value.recommended_size)) issue(`${path}/recommended_size`, "must be an object", "type");
    exactKeys(value.recommended_size, ["width", "height"], `${path}/recommended_size`);
    const width = value.recommended_size.width;
    const height = value.recommended_size.height;
    if (!Number.isSafeInteger(width) || Number(width) < 1 || Number(width) > 8192) {
      issue(`${path}/recommended_size/width`, "must be an integer between 1 and 8192", "maximum");
    }
    if (!Number.isSafeInteger(height) || Number(height) < 1 || Number(height) > 8192) {
      issue(`${path}/recommended_size/height`, "must be an integer between 1 and 8192", "maximum");
    }
    profile.recommended_size = { width: Number(width), height: Number(height) };
  }
  if (value.mobile_fallback !== undefined) {
    if (!["compact", "stack", "summary", "text"].includes(String(value.mobile_fallback))) {
      issue(`${path}/mobile_fallback`, "has an unsupported fallback", "enum");
    }
    profile.mobile_fallback = value.mobile_fallback as DagWorkerSkillVisualProfileV1["mobile_fallback"];
  }
  if (Object.keys(profile).length === 1) issue(path, "must declare at least one visual metadata field", "minProperties");
  const encoded = stableStringify(profile);
  if (utf8Bytes(encoded) > MAX_VISUAL_PROFILE_BYTES) {
    issue(path, `exceeds ${MAX_VISUAL_PROFILE_BYTES} UTF-8 bytes`, "maxBytes");
  }
  const credential = detectObviousCredential(encoded);
  if (credential) issue(path, `contains an obvious ${credential}`, "credential");
  return profile;
}

function parsePlugin(value: unknown, path: string): DagWorkerSkillPluginV1 {
  if (!isRecord(value)) issue(path, "must be an object", "type");
  exactKeys(value, ["id", "version"], path);
  const id = assertString(value.id, `${path}/id`, 1, 160);
  const version = assertString(value.version, `${path}/version`, 1, 64);
  if (!HOMERAIL_PLUGIN_ID_PATTERN.test(id)) issue(`${path}/id`, "has an invalid plugin id", "pattern");
  if (!PLUGIN_VERSION.test(version)) issue(`${path}/version`, "has an invalid plugin version", "pattern");
  return { id, version };
}

function parseSkill(value: unknown, path: string): DagWorkerSkillV1 {
  if (!isRecord(value)) issue(path, "must be an object", "type");
  exactKeys(value, ["id", "source", "digest", "content", "plugin", "visual_profile"], path);
  const id = assertString(value.id, `${path}/id`, 1, 256);
  if (!SKILL_ID.test(id)) issue(`${path}/id`, "has an invalid Skill id", "pattern");
  if (!DAG_WORKER_SKILL_SOURCES.includes(value.source as DagWorkerSkillSource)) {
    issue(`${path}/source`, "must be home, repo, or plugin", "enum");
  }
  const source = value.source as DagWorkerSkillSource;
  const content = assertString(value.content, `${path}/content`, 1, Number.MAX_SAFE_INTEGER);
  const bytes = utf8Bytes(content);
  if (bytes > DAG_WORKER_SKILL_MAX_BYTES) {
    issue(`${path}/content`, `exceeds ${DAG_WORKER_SKILL_MAX_BYTES} UTF-8 bytes`, "maxBytes");
  }
  const credential = detectObviousCredential(content);
  if (credential) issue(`${path}/content`, `contains an obvious ${credential}`, "credential");
  const digest = assertString(value.digest, `${path}/digest`, 64, 64);
  if (!SHA256.test(digest)) issue(`${path}/digest`, "must be a lowercase SHA-256 digest", "pattern");
  const expectedDigest = digestDagWorkerSkillContent(content);
  if (digest !== expectedDigest) issue(`${path}/digest`, "does not match the Skill content", "digest");
  const plugin = value.plugin === undefined ? undefined : parsePlugin(value.plugin, `${path}/plugin`);
  if (source === "plugin" && !plugin) issue(`${path}/plugin`, "is required for plugin Skills", "required");
  if (source !== "plugin" && plugin) issue(`${path}/plugin`, "is only allowed for plugin Skills", "forbidden");
  if (plugin) {
    const prefix = `${plugin.id}:`;
    const localId = id.startsWith(prefix) ? id.slice(prefix.length) : "";
    if (!localId || localId.includes(":") || id !== `${plugin.id}:${localId}`) {
      issue(`${path}/id`, "must be qualified exactly once by plugin.id", "pluginIdentity");
    }
  }
  const visualProfile = value.visual_profile === undefined
    ? undefined
    : parseVisualProfile(value.visual_profile, `${path}/visual_profile`);
  return {
    id,
    source,
    digest,
    content,
    ...(plugin ? { plugin } : {}),
    ...(visualProfile ? { visual_profile: visualProfile } : {}),
  };
}

function sortedSkills(skills: readonly DagWorkerSkillV1[]): DagWorkerSkillV1[] {
  return [...skills]
    .map((skill) => clone(skill))
    .sort((left, right) => left.id.localeCompare(right.id) || left.source.localeCompare(right.source));
}

function canonicalContext(
  skills: readonly DagWorkerSkillV1[],
  totalBytes: number,
): DagWorkerSkillContextV1 {
  const unsigned = {
    context_version: DAG_WORKER_SKILL_CONTEXT_VERSION,
    total_bytes: totalBytes,
    skills: sortedSkills(skills),
  };
  return {
    ...unsigned,
    context_digest: digestDagWorkerSkillContext(unsigned),
  };
}

function finalizeCanonicalContext(skills: readonly DagWorkerSkillV1[]): DagWorkerSkillContextV1 {
  let totalBytes = 0;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const context = canonicalContext(skills, totalBytes);
    const wireBytes = utf8Bytes(stableStringify(context));
    if (wireBytes === totalBytes) return context;
    totalBytes = wireBytes;
  }
  issue("/total_bytes", "canonical Skill Context byte size did not stabilize", "canonicalBytes");
}

export function dagWorkerSkillContextDigestInput(
  context: Pick<DagWorkerSkillContextV1, "context_version" | "total_bytes" | "skills">,
): Omit<DagWorkerSkillContextV1, "context_digest"> {
  return {
    context_version: DAG_WORKER_SKILL_CONTEXT_VERSION,
    total_bytes: context.total_bytes,
    skills: sortedSkills(context.skills),
  };
}

export function digestDagWorkerSkillContext(
  context: Pick<DagWorkerSkillContextV1, "context_version" | "total_bytes" | "skills">,
): string {
  return sha256Utf8(stableStringify(dagWorkerSkillContextDigestInput(context)));
}

export function createDagWorkerSkillContextV1(
  inputs: readonly DagWorkerSkillInputV1[],
): DagWorkerSkillContextV1 {
  if (!Array.isArray(inputs)) issue("/skills", "must be an array", "type");
  if (inputs.length > DAG_WORKER_SKILL_MAX_COUNT) {
    issue("/skills", `contains more than ${DAG_WORKER_SKILL_MAX_COUNT} Skills`, "maxItems");
  }
  const skills = sortedSkills(inputs.map((input, index) => {
    const digest = digestDagWorkerSkillContent(input.content);
    if (input.digest !== undefined && input.digest !== digest) {
      issue(`/skills/${index}/digest`, "does not match the Skill content", "digest");
    }
    return parseSkill({ ...input, digest }, `/skills/${index}`);
  }));
  if (new Set(skills.map((skill) => skill.id)).size !== skills.length) {
    issue("/skills", "contains duplicate Skill ids", "uniqueItems");
  }
  const context = finalizeCanonicalContext(skills);
  if (context.total_bytes > DAG_WORKER_SKILL_CONTEXT_MAX_BYTES) {
    issue("/total_bytes", `exceeds ${DAG_WORKER_SKILL_CONTEXT_MAX_BYTES} UTF-8 bytes`, "maxBytes");
  }
  return context;
}

export function parseDagWorkerSkillContextV1(value: unknown): DagWorkerSkillContextV1 {
  if (!isRecord(value)) issue("", "must be an object", "type");
  exactKeys(value, ["context_version", "context_digest", "total_bytes", "skills"], "");
  if (value.context_version !== DAG_WORKER_SKILL_CONTEXT_VERSION) {
    issue("/context_version", `must equal ${DAG_WORKER_SKILL_CONTEXT_VERSION}`, "const");
  }
  if (!Array.isArray(value.skills)) issue("/skills", "must be an array", "type");
  if (value.skills.length > DAG_WORKER_SKILL_MAX_COUNT) {
    issue("/skills", `contains more than ${DAG_WORKER_SKILL_MAX_COUNT} Skills`, "maxItems");
  }
  const skills = value.skills.map((skill, index) => parseSkill(skill, `/skills/${index}`));
  const canonicalSkills = sortedSkills(skills);
  if (new Set(canonicalSkills.map((skill) => skill.id)).size !== canonicalSkills.length) {
    issue("/skills", "contains duplicate Skill ids", "uniqueItems");
  }
  if (skills.some((skill, index) => skill.id !== canonicalSkills[index]?.id || skill.source !== canonicalSkills[index]?.source)) {
    issue("/skills", "must use canonical Skill id ordering", "canonicalOrder");
  }
  if (!Number.isSafeInteger(value.total_bytes) || Number(value.total_bytes) < 0) {
    issue("/total_bytes", "must be a non-negative safe integer", "type");
  }
  const contextDigest = assertString(value.context_digest, "/context_digest", 64, 64);
  if (!SHA256.test(contextDigest)) issue("/context_digest", "must be a lowercase SHA-256 digest", "pattern");
  const context: DagWorkerSkillContextV1 = {
    context_version: DAG_WORKER_SKILL_CONTEXT_VERSION,
    context_digest: contextDigest,
    total_bytes: Number(value.total_bytes),
    skills: canonicalSkills,
  };
  const wireBytes = utf8Bytes(stableStringify(context));
  if (context.total_bytes !== wireBytes) {
    issue("/total_bytes", "does not match the canonical Skill Context wire bytes", "bytes");
  }
  if (wireBytes > DAG_WORKER_SKILL_CONTEXT_MAX_BYTES) {
    issue("/total_bytes", `exceeds ${DAG_WORKER_SKILL_CONTEXT_MAX_BYTES} UTF-8 bytes`, "maxBytes");
  }
  if (digestDagWorkerSkillContext(context) !== contextDigest) {
    issue("/context_digest", "does not match the canonical Skill Context", "digest");
  }
  return context;
}

export function validateDagWorkerSkillContextV1(value: unknown): DagWorkerSkillContextValidationResult {
  try {
    return { valid: true, value: parseDagWorkerSkillContextV1(value), errors: [] };
  } catch (error) {
    if (error instanceof DagWorkerSkillContextValidationError) {
      return { valid: false, errors: error.errors };
    }
    return {
      valid: false,
      errors: [{ path: "", message: "Skill Context validation failed", keyword: "validation" }],
    };
  }
}

export function encodeDagWorkerSkillContextV1(value: DagWorkerSkillContextV1): string {
  return stableStringify(parseDagWorkerSkillContextV1(value));
}

export function summarizeDagWorkerSkillContextV1(
  value: DagWorkerSkillContextV1,
): DagWorkerSkillContextSummaryV1 {
  const context = parseDagWorkerSkillContextV1(value);
  return {
    context_version: context.context_version,
    context_digest: context.context_digest,
    total_bytes: context.total_bytes,
    skills: context.skills.map((skill) => ({
      id: skill.id,
      digest: skill.digest,
      bytes: utf8Bytes(stableStringify(skill)),
    })),
  };
}
