import * as fs from "node:fs";
import * as path from "node:path";

import {
  DAG_WORKER_SKILL_MAX_BYTES,
  DAG_WORKER_SKILL_MAX_COUNT,
  DAG_WORKER_SKILL_RUN_MAX_BYTES,
  HOMERAIL_PLUGIN_ID_PATTERN,
  createDagWorkerSkillContextV1,
  type DagWorkerSkillContextV1,
  type DagWorkerSkillInputV1,
  type DagWorkerSkillVisualProfileV1,
} from "homerail-protocol";

import { repoRoot } from "../assets/root.js";
import { getHomerailHome } from "../config/env.js";
import { readArchivedPluginSkill } from "../plugins/context-assembler.js";
import {
  getActivePlugin,
  isTrustedRegistryPluginAgentAsset,
  type ActivePluginRecord,
} from "../persistence/plugins.js";

export const DAG_WORKER_SKILL_VISUAL_PROFILE_PATH = path.join(
  "assets",
  "homerail",
  "worker-visual-profile.json",
);

interface ArchivedWorkerSkill {
  descriptor: {
    plugin_id: string;
    plugin_version: string;
    local_id: string;
    qualified_id: string;
    digest: string;
  };
  content: string;
  visual_profile?: DagWorkerSkillVisualProfileV1;
}

export interface DagWorkerSkillResolverOptions {
  homerail_home?: string;
  repository_root?: string;
  read_archived_plugin_skill?: (qualifiedId: string) => ArchivedWorkerSkill | undefined;
  get_active_plugin?: (pluginId: string) => ActivePluginRecord | undefined;
  is_trusted_registry_plugin_asset?: (pluginId: string, pluginVersion: string) => boolean;
}

const LOCAL_SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_VISUAL_PROFILE_FILE_BYTES = 64 * 1024;

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeRoot(value: string, label: string): string | undefined {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync(resolved);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`${label} is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function readBoundedFile(
  file: string,
  maxBytes: number,
  label: string,
  trustedRoots: readonly string[],
): { content: string; real_file: string } | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`${label} cannot be inspected: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!stat.isFile()) throw new Error(`${label} is not a regular file`);
  if (stat.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);

  let realFile: string;
  try {
    realFile = fs.realpathSync(file);
  } catch (cause) {
    throw new Error(`${label} cannot be resolved: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!trustedRoots.some((root) => pathIsWithin(root, realFile))) {
    throw new Error(`${label} resolves outside the trusted Skill roots`);
  }
  const bytes = fs.readFileSync(realFile);
  if (bytes.byteLength > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  return { content: decodeUtf8(bytes, label), real_file: realFile };
}

function visualProfileForLocalSkill(
  skillFile: string,
  trustedRoots: readonly string[],
): DagWorkerSkillVisualProfileV1 | undefined {
  const profileFile = path.join(path.dirname(skillFile), DAG_WORKER_SKILL_VISUAL_PROFILE_PATH);
  const profile = readBoundedFile(
    profileFile,
    MAX_VISUAL_PROFILE_FILE_BYTES,
    `Worker Skill visual profile ${profileFile}`,
    trustedRoots,
  );
  if (!profile) return undefined;
  try {
    return JSON.parse(profile.content) as DagWorkerSkillVisualProfileV1;
  } catch {
    throw new Error(`Worker Skill visual profile ${profileFile} is not valid JSON`);
  }
}

function resolveLocalSkill(
  id: string,
  homeRoot: string,
  repositoryRoot: string,
): DagWorkerSkillInputV1 | undefined {
  const homeSkillsRoot = normalizeRoot(path.join(homeRoot, "skills"), "HOMERAIL_HOME Skill root");
  const repoSkillsRoot = normalizeRoot(path.join(repositoryRoot, "skills"), "Repository Skill root");
  const trustedRoots = [homeSkillsRoot, repoSkillsRoot].filter((root): root is string => root !== undefined);
  const candidates = [
    { source: "home" as const, root: homeSkillsRoot },
    { source: "repo" as const, root: repoSkillsRoot },
  ].filter((candidate): candidate is { source: "home" | "repo"; root: string } => (
    candidate.root !== undefined
  ));
  for (const candidate of candidates) {
    const file = path.join(candidate.root, id, "SKILL.md");
    const loaded = readBoundedFile(file, DAG_WORKER_SKILL_MAX_BYTES, `Worker Skill ${id}`, trustedRoots);
    if (!loaded) continue;
    const visualProfile = visualProfileForLocalSkill(loaded.real_file, trustedRoots);
    return {
      id,
      source: candidate.source,
      content: loaded.content,
      ...(visualProfile === undefined ? {} : { visual_profile: visualProfile }),
    };
  }
  return undefined;
}

function resolvePluginSkill(
  qualifiedId: string,
  options: DagWorkerSkillResolverOptions,
): DagWorkerSkillInputV1 {
  const separator = qualifiedId.indexOf(":");
  if (separator < 1 || separator !== qualifiedId.lastIndexOf(":")) {
    throw new Error(`Plugin Worker Skill id must be '<plugin-id>:<skill-id>': ${qualifiedId}`);
  }
  const pluginId = qualifiedId.slice(0, separator);
  const localId = qualifiedId.slice(separator + 1);
  if (
    pluginId.length > 160
    || !HOMERAIL_PLUGIN_ID_PATTERN.test(pluginId)
    || !LOCAL_SKILL_ID.test(localId)
    || localId.includes("..")
  ) {
    throw new Error(`Plugin Worker Skill id is invalid: ${qualifiedId}`);
  }
  const readArchived = options.read_archived_plugin_skill ?? readArchivedPluginSkill;
  const archived = readArchived(qualifiedId);
  if (!archived || archived.descriptor.qualified_id !== qualifiedId) {
    throw new Error(`Declared Plugin Worker Skill is unavailable: ${qualifiedId}`);
  }
  if (
    archived.descriptor.plugin_id !== pluginId
    || archived.descriptor.local_id !== localId
  ) {
    throw new Error(`Archived Plugin Worker Skill identity mismatch: ${qualifiedId}`);
  }
  const getActive = options.get_active_plugin ?? getActivePlugin;
  const active = getActive(pluginId);
  if (
    !active
    || !active.activation.enabled
    || active.plugin_version !== archived.descriptor.plugin_version
  ) {
    throw new Error(`Declared Plugin Worker Skill is not from the active Plugin version: ${qualifiedId}`);
  }
  const trustedRegistry = options.is_trusted_registry_plugin_asset
    ?? isTrustedRegistryPluginAgentAsset;
  if (active.source !== "builtin" && (
    active.source !== "installed"
    || !trustedRegistry(pluginId, active.plugin_version)
  )) {
    throw new Error(`Declared Plugin Worker Skill is not a trusted archived asset: ${qualifiedId}`);
  }
  return {
    id: qualifiedId,
    source: "plugin",
    digest: archived.descriptor.digest,
    content: archived.content,
    ...(archived.visual_profile === undefined
      ? {}
      : { visual_profile: structuredClone(archived.visual_profile) }),
    plugin: {
      id: pluginId,
      version: archived.descriptor.plugin_version,
    },
  };
}

function resolveSkill(
  id: string,
  options: DagWorkerSkillResolverOptions,
): DagWorkerSkillInputV1 {
  if (id.includes(":")) return resolvePluginSkill(id, options);
  if (!LOCAL_SKILL_ID.test(id) || id.includes("..")) {
    throw new Error(`Worker Skill id is invalid: ${id}`);
  }
  const homeRoot = path.resolve(options.homerail_home ?? getHomerailHome());
  const repositoryRoot = path.resolve(options.repository_root ?? repoRoot());
  const local = resolveLocalSkill(id, homeRoot, repositoryRoot);
  if (!local) throw new Error(`Declared Worker Skill is unavailable: ${id}`);
  return local;
}

export function resolveDagWorkerSkillContext(input: {
  agent_id: string;
  skills: readonly string[];
  options?: DagWorkerSkillResolverOptions;
}): DagWorkerSkillContextV1 {
  if (!Array.isArray(input.skills)) {
    throw new Error(`Workflow agent ${input.agent_id} skills must be an array`);
  }
  if (input.skills.length > DAG_WORKER_SKILL_MAX_COUNT) {
    throw new Error(`Workflow agent ${input.agent_id} declares more than ${DAG_WORKER_SKILL_MAX_COUNT} Skills`);
  }
  const ids = input.skills.map((skill) => {
    if (typeof skill !== "string" || skill.trim() !== skill || !skill) {
      throw new Error(`Workflow agent ${input.agent_id} contains an invalid Skill id`);
    }
    return skill;
  });
  if (new Set(ids).size !== ids.length) {
    throw new Error(`Workflow agent ${input.agent_id} contains duplicate Skill ids`);
  }
  return createDagWorkerSkillContextV1(ids.map((id) => resolveSkill(id, input.options ?? {})));
}

function availableSurfaceViewIds(context: DagWorkerSkillContextV1): Set<string> {
  const result = new Set<string>();
  const localCounts = new Map<string, number>();
  for (const skill of context.skills) {
    for (const view of skill.visual_profile?.views ?? []) {
      result.add(`${skill.id}:${view.id}`);
      localCounts.set(view.id, (localCounts.get(view.id) ?? 0) + 1);
    }
  }
  for (const [viewId, count] of localCounts) {
    if (count === 1) result.add(viewId);
  }
  return result;
}

export function assertDagWorkerSurfaceViewAllowlist(input: {
  agent_id: string;
  context: DagWorkerSkillContextV1;
  allowed_surface_views?: readonly string[];
}): void {
  if (input.allowed_surface_views === undefined) return;
  if (!Array.isArray(input.allowed_surface_views) || input.allowed_surface_views.length > 64) {
    throw new Error(`Workflow agent ${input.agent_id} allowed_surface_views must contain at most 64 ids`);
  }
  const ids = input.allowed_surface_views.map((viewId) => {
    if (typeof viewId !== "string"
      || !viewId
      || viewId.trim() !== viewId
      || viewId.length > 385
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(viewId)) {
      throw new Error(`Workflow agent ${input.agent_id} contains an invalid allowed Surface view id`);
    }
    return viewId;
  });
  if (new Set(ids).size !== ids.length) {
    throw new Error(`Workflow agent ${input.agent_id} contains duplicate allowed Surface view ids`);
  }
  const available = availableSurfaceViewIds(input.context);
  const unknown = ids.filter((viewId) => !available.has(viewId)).sort();
  if (unknown.length > 0) {
    throw new Error(
      `Workflow agent ${input.agent_id} allows unavailable pinned Surface view '${unknown[0]}'`,
    );
  }
}

export function resolveDeclaredDagWorkerSkillContexts(input: {
  agents: Readonly<Record<string, {
    skills?: readonly string[];
    allowed_surface_views?: readonly string[];
  }>>;
  options?: DagWorkerSkillResolverOptions;
}): Record<string, DagWorkerSkillContextV1> {
  const result: Record<string, DagWorkerSkillContextV1> = {};
  let runBytes = 0;
  for (const [agentId, agent] of Object.entries(input.agents).sort(([left], [right]) => left.localeCompare(right))) {
    const context = resolveDagWorkerSkillContext({
      agent_id: agentId,
      skills: agent.skills ?? [],
      options: input.options,
    });
    assertDagWorkerSurfaceViewAllowlist({
      agent_id: agentId,
      context,
      allowed_surface_views: agent.allowed_surface_views,
    });
    runBytes += context.total_bytes;
    if (runBytes > DAG_WORKER_SKILL_RUN_MAX_BYTES) {
      throw new Error(`Workflow Worker Skill Context total exceeds ${DAG_WORKER_SKILL_RUN_MAX_BYTES} UTF-8 bytes`);
    }
    result[agentId] = context;
  }
  return result;
}
