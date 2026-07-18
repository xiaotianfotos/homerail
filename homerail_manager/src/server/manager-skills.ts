import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";

import { repoRoot } from "../assets/root.js";
import { getHomerailHome } from "../config/env.js";
import {
  assemblePluginTurnContext,
  readArchivedPluginSkill,
  readExactArchivedPluginSkill,
} from "../plugins/context-assembler.js";
import {
  analyzeHomerailPluginSchemaPolicy,
  validateHomerailA2uiSurface,
  type HomerailPluginTurnContextV1,
  type ManagerAgentSkillViewCanvasSizeV1,
  type ManagerAgentSkillViewTemplateV1,
} from "homerail-protocol";

export interface ManagerSkillSummary {
  id: string;
  name: string;
  description: string;
  relative_path: string;
  source: "home" | "repo" | "plugin";
  enabled: true;
  plugin_id?: string;
  plugin_version?: string;
  digest?: string;
}

export interface ManagerSkillDetail extends ManagerSkillSummary {
  content: string;
}

export interface ManagerSkillInstallResult {
  root: string;
  installed: string[];
  existing: string[];
  errors: Array<{ id: string; message: string }>;
}

export interface ManagerSkillViewPresenter {
  skill_root: string;
  command: string;
  args: string[];
  timeout_ms: number;
}

const MAX_SKILL_BYTES = 256 * 1024;
const MAX_SKILL_VIEW_MANIFEST_BYTES = 256 * 1024;
const MAX_SKILL_VIEW_TEMPLATES = 8;
const MAX_SKILL_VIEW_PRESENTER_ARGUMENTS = 32;
const MAX_SKILL_VIEW_PRESENTER_ARGUMENT_BYTES = 512;
const MAX_SKILL_VIEW_PRESENTER_ARGUMENT_TOTAL_BYTES = 8 * 1024;
const MAX_SKILL_VIEW_PRESENTER_OUTPUT_BYTES = 1024 * 1024;
const MAX_SKILL_VIEW_PRESENTER_TIMEOUT_MS = 5 * 60 * 1000;
const SKILL_VIEW_MANIFEST = path.join("assets", "homerail", "view-templates.json");
const VIEW_SURFACES = new Set(["task", "execution", "result", "ambient"]);
const VIEW_IMPORTANCE = new Set(["critical", "primary", "secondary", "ambient"]);
const VIEW_DENSITIES = new Set(["glance", "summary", "detail"]);
const VIEW_CANVAS_SIZES = new Set<ManagerAgentSkillViewCanvasSizeV1>(["1x1", "1x2", "2x2", "3x3"]);
const VIEW_PERSISTENCE = new Set(["turn", "session", "project"]);

function skillDescription(content: string): { name?: string; description?: string } {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end < 0) return {};
  try {
    const parsed = YAML.parse(content.slice(3, end)) as Record<string, unknown> | null;
    const name = typeof parsed?.name === "string" ? parsed.name.trim() : undefined;
    const description = typeof parsed?.description === "string"
      ? parsed.description.replace(/\s+/g, " ").trim()
      : undefined;
    return { name, description };
  } catch {
    return {};
  }
}

function readSkillFile(file: string): string | undefined {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) return undefined;
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function validTemplateDataSchema(value: unknown): value is Record<string, unknown> {
  const schema = record(value);
  if (!schema || schema.type !== "object" || schema.additionalProperties !== false) return false;
  const properties = record(schema.properties);
  const title = record(properties?.title);
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  if (!title || title.type !== "string" || !required.includes("title")) return false;
  return analyzeHomerailPluginSchemaPolicy(schema).length === 0;
}

function parseSkillViewTemplate(value: unknown): ManagerAgentSkillViewTemplateV1 | undefined {
  const template = record(value);
  if (!template) return undefined;
  const defaults = record(template.defaults);
  const id = typeof template.id === "string" ? template.id.trim() : "";
  const description = typeof template.description === "string" ? template.description.trim() : "";
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) || !description || description.length > 1000 || !defaults) {
    return undefined;
  }
  if (
    !VIEW_SURFACES.has(String(defaults.surface))
    || !VIEW_IMPORTANCE.has(String(defaults.importance))
    || !VIEW_DENSITIES.has(String(defaults.density))
    || !VIEW_CANVAS_SIZES.has(String(defaults.canvas_size) as ManagerAgentSkillViewCanvasSizeV1)
    || !VIEW_PERSISTENCE.has(String(defaults.persistence))
    || !validTemplateDataSchema(template.data_schema)
  ) return undefined;
  const a2ui = validateHomerailA2uiSurface(template.a2ui);
  if (!a2ui.valid || !a2ui.value) return undefined;
  const allowed = Array.isArray(template.allowed_canvas_sizes)
    ? Array.from(new Set(template.allowed_canvas_sizes.map(String)))
    : undefined;
  if (allowed?.some((item) => !VIEW_CANVAS_SIZES.has(item as ManagerAgentSkillViewCanvasSizeV1))) return undefined;
  if (allowed && !allowed.includes(String(defaults.canvas_size))) return undefined;
  return {
    id,
    description,
    data_schema: structuredClone(template.data_schema as Record<string, unknown>),
    a2ui: a2ui.value,
    defaults: {
      surface: defaults.surface as ManagerAgentSkillViewTemplateV1["defaults"]["surface"],
      importance: defaults.importance as ManagerAgentSkillViewTemplateV1["defaults"]["importance"],
      density: defaults.density as ManagerAgentSkillViewTemplateV1["defaults"]["density"],
      canvas_size: defaults.canvas_size as ManagerAgentSkillViewCanvasSizeV1,
      persistence: defaults.persistence as ManagerAgentSkillViewTemplateV1["defaults"]["persistence"],
    },
    ...(allowed?.length ? { allowed_canvas_sizes: allowed as ManagerAgentSkillViewCanvasSizeV1[] } : {}),
  };
}

function localSkillRoot(id: string): string | undefined {
  for (const root of [getManagerSkillsRoot(), path.join(repoRoot(), "skills")]) {
    const skillRoot = path.join(root, id);
    if (readSkillFile(path.join(skillRoot, "SKILL.md")) !== undefined) return skillRoot;
  }
  return undefined;
}

function readSkillViewManifest(id: string): {
  skill_root: string;
  manifest: Record<string, unknown>;
} | undefined {
  const normalized = id.trim();
  if (!normalized || normalized.includes(":") || normalized.includes("/") || normalized.includes("\\") || normalized === "." || normalized === "..") {
    return undefined;
  }
  ensureManagerSkillsInstalled();
  const skillRoot = localSkillRoot(normalized);
  if (!skillRoot) return undefined;
  const file = path.join(skillRoot, SKILL_VIEW_MANIFEST);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_SKILL_VIEW_MANIFEST_BYTES) return undefined;
    const manifest = record(JSON.parse(fs.readFileSync(file, "utf8")));
    if (manifest?.manifest_version !== 1) return undefined;
    return { skill_root: fs.realpathSync(skillRoot), manifest };
  } catch {
    return undefined;
  }
}

export function readManagerSkillViewTemplates(id: string): ManagerAgentSkillViewTemplateV1[] {
  const loaded = readSkillViewManifest(id);
  if (!loaded || !Array.isArray(loaded.manifest.templates) || loaded.manifest.templates.length > MAX_SKILL_VIEW_TEMPLATES) {
    return [];
  }
  const templates = loaded.manifest.templates.map(parseSkillViewTemplate);
  if (templates.some((template) => template === undefined)) return [];
  const valid = templates as ManagerAgentSkillViewTemplateV1[];
  if (new Set(valid.map((template) => template.id)).size !== valid.length) return [];
  return valid;
}

export function readManagerSkillViewPresenter(id: string): ManagerSkillViewPresenter | undefined {
  const loaded = readSkillViewManifest(id);
  const presenter = record(loaded?.manifest.presenter);
  if (!loaded || !presenter) return undefined;
  const command = typeof presenter.command === "string" ? presenter.command.trim() : "";
  const args = Array.isArray(presenter.args) ? presenter.args : [];
  const timeoutMs = presenter.timeout_ms === undefined ? 30_000 : Number(presenter.timeout_ms);
  if (
    !command
    || command.length > 200
    || path.isAbsolute(command)
    || command.includes("/")
    || command.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(command)
    || args.length > 8
    || !Number.isInteger(timeoutMs)
    || timeoutMs < 1_000
    || timeoutMs > MAX_SKILL_VIEW_PRESENTER_TIMEOUT_MS
  ) return undefined;
  const normalizedArgs = args.map((item) => typeof item === "string" ? item : "");
  if (normalizedArgs.some((item) => (
    !item
    || Buffer.byteLength(item, "utf8") > MAX_SKILL_VIEW_PRESENTER_ARGUMENT_BYTES
    || /[\u0000\r\n]/.test(item)
  ))) return undefined;
  return {
    skill_root: loaded.skill_root,
    command,
    args: normalizedArgs,
    timeout_ms: timeoutMs,
  };
}

function normalizeSkillViewPresenterArgv(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SKILL_VIEW_PRESENTER_ARGUMENTS) {
    throw new Error("Skill view presenter argv must contain 1 to 32 arguments");
  }
  const argv = value.map((item) => typeof item === "string" ? item : "");
  if (argv.some((item) => (
    !item
    || Buffer.byteLength(item, "utf8") > MAX_SKILL_VIEW_PRESENTER_ARGUMENT_BYTES
    || /[\u0000\r\n]/.test(item)
  ))) throw new Error("Skill view presenter argv contains an invalid argument");
  if (Buffer.byteLength(argv.join("\0"), "utf8") > MAX_SKILL_VIEW_PRESENTER_ARGUMENT_TOTAL_BYTES) {
    throw new Error("Skill view presenter argv is too large");
  }
  return argv;
}

function skillViewPresenterEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOMERAIL_HOME: getHomerailHome() };
  for (const key of [
    "PATH",
    "HOME",
    "USERPROFILE",
    "SystemRoot",
    "WINDIR",
    "PATHEXT",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

export async function executeManagerSkillViewPresenter(
  id: string,
  argvValue: unknown,
): Promise<Record<string, unknown>> {
  const presenter = readManagerSkillViewPresenter(id);
  if (!presenter) throw new Error("Skill view presenter not found");
  const argv = normalizeSkillViewPresenterArgv(argvValue);
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      presenter.command,
      [...presenter.args, ...argv],
      {
        cwd: presenter.skill_root,
        env: skillViewPresenterEnv(),
        timeout: presenter.timeout_ms,
        maxBuffer: MAX_SKILL_VIEW_PRESENTER_OUTPUT_BYTES,
        windowsHide: true,
        encoding: "utf8",
      },
      (error, value) => {
        if (!error) {
          resolve(value);
          return;
        }
        const killed = (error as NodeJS.ErrnoException & { killed?: boolean }).killed;
        reject(new Error(killed ? "Skill view presenter timed out" : "Skill view presenter failed"));
      },
    );
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new Error("Skill view presenter returned invalid JSON");
  }
  const output = record(parsed);
  if (!output) throw new Error("Skill view presenter returned an invalid result");
  return output;
}

function scanSkills(root: string, source: ManagerSkillSummary["source"]): ManagerSkillDetail[] {
  if (!fs.existsSync(root)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .flatMap((entry) => {
      const file = path.join(root, entry.name, "SKILL.md");
      const content = readSkillFile(file);
      if (content === undefined) return [];
      const metadata = skillDescription(content);
      return [{
        id: entry.name,
        name: metadata.name || entry.name,
        description: metadata.description || "HomeRail Manager Agent skill",
        relative_path: path.posix.join("skills", entry.name, "SKILL.md"),
        source,
        enabled: true as const,
        content,
      }];
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function getManagerSkillsRoot(): string {
  return path.join(getHomerailHome(), "skills");
}

export function ensureManagerSkillsInstalled(): ManagerSkillInstallResult {
  const destinationRoot = getManagerSkillsRoot();
  const sourceRoot = path.join(repoRoot(), "skills");
  const result: ManagerSkillInstallResult = { root: destinationRoot, installed: [], existing: [], errors: [] };
  fs.mkdirSync(destinationRoot, { recursive: true });
  if (!fs.existsSync(sourceRoot)) return result;

  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("homerail-")) continue;
    const source = path.join(sourceRoot, entry.name);
    if (!fs.existsSync(path.join(source, "SKILL.md"))) continue;
    const destination = path.join(destinationRoot, entry.name);
    try {
      const existing = fs.lstatSync(destination);
      if (existing.isSymbolicLink() && !fs.existsSync(destination)) {
        fs.unlinkSync(destination);
      } else {
        result.existing.push(entry.name);
        continue;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        result.errors.push({ id: entry.name, message: error instanceof Error ? error.message : String(error) });
        continue;
      }
    }
    try {
      fs.symlinkSync(source, destination, process.platform === "win32" ? "junction" : "dir");
      result.installed.push(entry.name);
    } catch (error) {
      result.errors.push({
        id: entry.name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

export function listManagerSkills(
  pluginContext: HomerailPluginTurnContextV1 | null = assemblePluginTurnContext(),
): ManagerSkillSummary[] {
  ensureManagerSkillsInstalled();
  const homeSkills = scanSkills(getManagerSkillsRoot(), "home");
  const byId = new Map(homeSkills.map((skill) => [skill.id, skill]));
  for (const skill of scanSkills(path.join(repoRoot(), "skills"), "repo")) {
    if (!byId.has(skill.id)) byId.set(skill.id, skill);
  }
  const local = Array.from(byId.values())
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(({ content: _content, ...summary }) => summary);
  const plugin = (pluginContext?.skills ?? []).map((skill): ManagerSkillSummary => ({
    id: skill.qualified_id,
    name: skill.local_id,
    description: skill.description,
    relative_path: `plugin://${skill.plugin_id}@${skill.plugin_version}/skills/${skill.local_id}`,
    source: "plugin",
    enabled: true,
    plugin_id: skill.plugin_id,
    plugin_version: skill.plugin_version,
    digest: skill.digest,
  }));
  return [...local, ...plugin].sort((a, b) => a.id.localeCompare(b.id));
}

export function readManagerSkill(
  id: string,
  exactPlugin?: { plugin_version: string; digest: string },
): ManagerSkillDetail | undefined {
  const normalized = id.trim();
  if (!normalized || normalized.includes("/") || normalized.includes("\\") || normalized === "." || normalized === "..") {
    return undefined;
  }
  if (normalized.includes(":")) {
    const separator = normalized.lastIndexOf(":");
    const pluginId = normalized.slice(0, separator);
    const localId = normalized.slice(separator + 1);
    const plugin = exactPlugin
      ? readExactArchivedPluginSkill({
        plugin_id: pluginId,
        plugin_version: exactPlugin.plugin_version,
        local_id: localId,
        qualified_id: normalized,
        digest: exactPlugin.digest,
      })
      : readArchivedPluginSkill(normalized);
    if (!plugin) return undefined;
    return {
      id: plugin.descriptor.qualified_id,
      name: plugin.descriptor.local_id,
      description: plugin.descriptor.description,
      relative_path: `plugin://${plugin.descriptor.plugin_id}@${plugin.descriptor.plugin_version}/skills/${plugin.descriptor.local_id}`,
      source: "plugin",
      enabled: true,
      plugin_id: plugin.descriptor.plugin_id,
      plugin_version: plugin.descriptor.plugin_version,
      digest: plugin.descriptor.digest,
      content: plugin.content,
    };
  }
  ensureManagerSkillsInstalled();
  const home = scanSkills(getManagerSkillsRoot(), "home").find((skill) => skill.id === normalized);
  if (home) return home;
  return scanSkills(path.join(repoRoot(), "skills"), "repo").find((skill) => skill.id === normalized);
}
