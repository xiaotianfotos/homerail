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

const MAX_SKILL_BYTES = 256 * 1024;
const MAX_SKILL_VIEW_MANIFEST_BYTES = 256 * 1024;
const MAX_SKILL_VIEW_TEMPLATES = 8;
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

export function readManagerSkillViewTemplates(id: string): ManagerAgentSkillViewTemplateV1[] {
  const normalized = id.trim();
  if (!normalized || normalized.includes(":") || normalized.includes("/") || normalized.includes("\\") || normalized === "." || normalized === "..") {
    return [];
  }
  ensureManagerSkillsInstalled();
  const skillRoot = localSkillRoot(normalized);
  if (!skillRoot) return [];
  const file = path.join(skillRoot, SKILL_VIEW_MANIFEST);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_SKILL_VIEW_MANIFEST_BYTES) return [];
    const parsed = record(JSON.parse(fs.readFileSync(file, "utf8")));
    if (parsed?.manifest_version !== 1 || !Array.isArray(parsed.templates) || parsed.templates.length > MAX_SKILL_VIEW_TEMPLATES) {
      return [];
    }
    const templates = parsed.templates.map(parseSkillViewTemplate);
    if (templates.some((template) => template === undefined)) return [];
    const valid = templates as ManagerAgentSkillViewTemplateV1[];
    if (new Set(valid.map((template) => template.id)).size !== valid.length) return [];
    return valid;
  } catch {
    return [];
  }
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
