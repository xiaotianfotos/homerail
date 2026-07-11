import * as crypto from "node:crypto";
import YAML from "yaml";
import { encodeJson, getDb, parseJsonRow, clearTables } from "./db.js";
import { nowIso } from "./time.js";
import { syncDagTriggers } from "./dag-triggers.js";
import {
  getSetting,
  isVoiceServiceSetting,
  listSettings,
  type LLMSetting,
} from "./llm-settings.js";
import type { DAGAgentConfig, ParsedDAG } from "../orchestration/graph.js";
import { parseDAGYaml } from "../orchestration/yaml-loader.js";
import { assertNoYamlProviderRuntime } from "../orchestration/runtime-selection.js";
import {
  compileWorkflowSource,
  projectCanonicalWorkflowToParsedDAG,
  type CanonicalWorkflowIR,
  type WorkflowCompilationResult,
  type WorkflowSourceFormat,
  type WorkflowSourceVersion,
} from "../orchestration/workflow-spec-v1.js";

export interface DagWorkflow {
  workflow_id: string;
  name: string;
  description?: string;
  source_path?: string;
  yaml_text: string;
  yaml_hash: string;
  head_revision: number;
  api_version: WorkflowSourceVersion;
  canonical_hash: string;
  compiler_version: string;
  node_ids: string[];
  agent_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface DagWorkflowRevision {
  workflow_id: string;
  revision: number;
  api_version: WorkflowSourceVersion;
  source_format: WorkflowSourceFormat;
  source_text: string;
  source_hash: string;
  canonical_json: string;
  canonical_hash: string;
  compiler_version: string;
  created_at: string;
}

export interface DagRuntimeProfileEntry {
  llm_setting_id?: string;
  model_alias?: string;
  agent_type?: string;
}

export interface DagRuntimeProfile {
  profile_key: string;
  workflow_id: string;
  profile_id: string;
  description?: string;
  source_path?: string;
  default?: DagRuntimeProfileEntry;
  agents: Record<string, DagRuntimeProfileEntry>;
  created_at: string;
  updated_at: string;
}

export interface DagRuntimeProfileResolvedEntry {
  llm_setting_id?: string;
  agent_type?: string;
}

export interface DagRuntimeProfileResolved {
  profile_id: string;
  workflow_id: string;
  default?: DagRuntimeProfileResolvedEntry;
  agents: Record<string, DagRuntimeProfileResolvedEntry>;
}

function _sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function _string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function _rawString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function _stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = parseJsonRow<unknown>(value);
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  }
  return [];
}

function _jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = parseJsonRow<unknown>(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function _workflowFromRow(row: Record<string, unknown>): DagWorkflow {
  const raw = _jsonObject(row.data);
  return {
    ...raw,
    workflow_id: _string(row.workflow_id) ?? _string(raw.workflow_id) ?? "",
    name: _string(row.name) ?? _string(raw.name) ?? "",
    description: _string(row.description) ?? _string(raw.description),
    source_path: _string(row.source_path) ?? _string(raw.source_path),
    yaml_text: _rawString(row.yaml_text) ?? _rawString(raw.yaml_text) ?? "",
    yaml_hash: _string(row.yaml_hash) ?? _string(raw.yaml_hash) ?? "",
    head_revision: Number(row.head_revision ?? raw.head_revision ?? 0),
    api_version: (_string(row.api_version) ?? _string(raw.api_version) ?? "legacy/v0") as WorkflowSourceVersion,
    canonical_hash: _string(row.canonical_hash) ?? _string(raw.canonical_hash) ?? "",
    compiler_version: _string(row.compiler_version) ?? _string(raw.compiler_version) ?? "1",
    node_ids: _stringArray(row.node_ids ?? raw.node_ids),
    agent_ids: _stringArray(row.agent_ids ?? raw.agent_ids),
    created_at: _string(row.created_at) ?? _string(raw.created_at) ?? nowIso(),
    updated_at: _string(row.updated_at) ?? _string(raw.updated_at) ?? nowIso(),
  };
}

function _revisionFromRow(row: Record<string, unknown>): DagWorkflowRevision {
  return {
    workflow_id: _string(row.workflow_id) ?? "",
    revision: Number(row.revision ?? 0),
    api_version: (_string(row.api_version) ?? "legacy/v0") as WorkflowSourceVersion,
    source_format: (_string(row.source_format) ?? "yaml") as WorkflowSourceFormat,
    source_text: _rawString(row.source_text) ?? "",
    source_hash: _string(row.source_hash) ?? "",
    canonical_json: _rawString(row.canonical_json) ?? "",
    canonical_hash: _string(row.canonical_hash) ?? "",
    compiler_version: _string(row.compiler_version) ?? "1",
    created_at: _string(row.created_at) ?? nowIso(),
  };
}

function _profileEntry(value: unknown): DagRuntimeProfileEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const entry: DagRuntimeProfileEntry = {};
  const llmSettingId = _string(raw.llm_setting_id ?? raw.llmSettingId ?? raw.setting_id ?? raw.settingId);
  const modelAlias = _string(raw.model_alias ?? raw.modelAlias);
  const agentType = _string(raw.agent_type ?? raw.agentType ?? raw.harness);
  if (llmSettingId) entry.llm_setting_id = llmSettingId;
  if (modelAlias) entry.model_alias = modelAlias;
  if (agentType) entry.agent_type = agentType;
  return Object.keys(entry).length > 0 ? entry : undefined;
}

function _entryFromJson(value: unknown): DagRuntimeProfileEntry | undefined {
  if (typeof value === "string" && value.trim()) return _profileEntry(_jsonObject(value));
  return _profileEntry(value);
}

function _entriesFromJson(value: unknown): Record<string, DagRuntimeProfileEntry> {
  const raw = typeof value === "string" ? _jsonObject(value) : value;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const entries: Record<string, DagRuntimeProfileEntry> = {};
  for (const [agentId, entry] of Object.entries(raw)) {
    const parsed = _profileEntry(entry);
    if (parsed) entries[agentId] = parsed;
  }
  return entries;
}

function _profileFromRow(row: Record<string, unknown>): DagRuntimeProfile {
  const raw = _jsonObject(row.data);
  const workflowId = _string(row.workflow_id) ?? _string(raw.workflow_id) ?? "";
  const profileId = _string(row.profile_id) ?? _string(raw.profile_id) ?? "";
  return {
    ...raw,
    profile_key: _string(row.profile_key) ?? _string(raw.profile_key) ?? `${workflowId}:${profileId}`,
    workflow_id: workflowId,
    profile_id: profileId,
    description: _string(row.description) ?? _string(raw.description),
    source_path: _string(row.source_path) ?? _string(raw.source_path),
    default: _entryFromJson(row.default_config ?? raw.default),
    agents: _entriesFromJson(row.agent_configs ?? raw.agents),
    created_at: _string(row.created_at) ?? _string(raw.created_at) ?? nowIso(),
    updated_at: _string(row.updated_at) ?? _string(raw.updated_at) ?? nowIso(),
  };
}

function _workflowAgentIds(parsed: ParsedDAG): string[] {
  const ids = new Set<string>();
  for (const id of Object.keys(parsed.meta.agents ?? {})) ids.add(id);
  for (const node of parsed.graph.nodes) {
    if (node.agent && node.agent !== "__gateway__") ids.add(node.agent);
  }
  return Array.from(ids).sort();
}

function _writeWorkflow(workflow: DagWorkflow): void {
  getDb().prepare(`
    INSERT INTO dag_workflows(
      workflow_id, name, description, source_path, yaml_text, yaml_hash,
      head_revision, api_version, canonical_hash, compiler_version,
      node_ids, agent_ids, created_at, updated_at, data
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workflow_id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      source_path = excluded.source_path,
      yaml_text = excluded.yaml_text,
      yaml_hash = excluded.yaml_hash,
      head_revision = excluded.head_revision,
      api_version = excluded.api_version,
      canonical_hash = excluded.canonical_hash,
      compiler_version = excluded.compiler_version,
      node_ids = excluded.node_ids,
      agent_ids = excluded.agent_ids,
      updated_at = excluded.updated_at,
      data = excluded.data
  `).run(
    workflow.workflow_id,
    workflow.name,
    workflow.description ?? null,
    workflow.source_path ?? null,
    workflow.yaml_text,
    workflow.yaml_hash,
    workflow.head_revision,
    workflow.api_version,
    workflow.canonical_hash,
    workflow.compiler_version,
    encodeJson(workflow.node_ids),
    encodeJson(workflow.agent_ids),
    workflow.created_at,
    workflow.updated_at,
    encodeJson(workflow),
  );
}

function _writeRevision(revision: DagWorkflowRevision): void {
  getDb().prepare(`
    INSERT INTO dag_workflow_revisions(
      workflow_id, revision, api_version, source_format, source_text,
      source_hash, canonical_json, canonical_hash, compiler_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    revision.workflow_id,
    revision.revision,
    revision.api_version,
    revision.source_format,
    revision.source_text,
    revision.source_hash,
    revision.canonical_json,
    revision.canonical_hash,
    revision.compiler_version,
    revision.created_at,
  );
}

function _requireCanonical(compilation: WorkflowCompilationResult): CanonicalWorkflowIR {
  if (!compilation.valid || !compilation.canonical || !compilation.canonical_json || !compilation.canonical_hash) {
    const details = compilation.diagnostics
      .map((entry) => `${entry.code} ${entry.path}: ${entry.message}`)
      .join("; ");
    throw new Error(details || "DAG workflow compilation failed");
  }
  return compilation.canonical;
}

function _ensureStoredWorkflowRevisions(): void {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM dag_workflows WHERE head_revision = 0 ORDER BY workflow_id")
    .all() as Record<string, unknown>[];
  for (const row of rows) {
    const workflow = _workflowFromRow(row);
    const compilation = compileWorkflowSource(workflow.yaml_text);
    const canonical = _requireCanonical(compilation);
    const now = workflow.created_at || nowIso();
    const migrated: DagWorkflow = {
      ...workflow,
      head_revision: 1,
      api_version: canonical.source_api_version,
      canonical_hash: compilation.canonical_hash!,
      compiler_version: canonical.compiler_version,
    };
    db.transaction(() => {
      _writeWorkflow(migrated);
      _writeRevision({
        workflow_id: workflow.workflow_id,
        revision: 1,
        api_version: canonical.source_api_version,
        source_format: compilation.source_format,
        source_text: workflow.yaml_text,
        source_hash: workflow.yaml_hash || _sha256(workflow.yaml_text),
        canonical_json: compilation.canonical_json!,
        canonical_hash: compilation.canonical_hash!,
        compiler_version: canonical.compiler_version,
        created_at: now,
      });
    })();
  }
}

function _writeProfile(profile: DagRuntimeProfile): void {
  getDb().prepare(`
    INSERT INTO dag_runtime_profiles(
      profile_key, workflow_id, profile_id, description, source_path,
      default_config, agent_configs, created_at, updated_at, data
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workflow_id, profile_id) DO UPDATE SET
      description = excluded.description,
      source_path = excluded.source_path,
      default_config = excluded.default_config,
      agent_configs = excluded.agent_configs,
      updated_at = excluded.updated_at,
      data = excluded.data
  `).run(
    profile.profile_key,
    profile.workflow_id,
    profile.profile_id,
    profile.description ?? null,
    profile.source_path ?? null,
    profile.default ? encodeJson(profile.default) : null,
    encodeJson(profile.agents),
    profile.created_at,
    profile.updated_at,
    encodeJson(profile),
  );
}

export function upsertDagWorkflowFromYaml(input: {
  yaml_text: string;
  source_path?: string;
}): { workflow: DagWorkflow; created: boolean; revision_created: boolean; parsed?: ParsedDAG } {
  const compilation = compileWorkflowSource(input.yaml_text);
  const canonical = _requireCanonical(compilation);
  const parsed = canonical.source_api_version === "legacy/v0" ? parseDAGYaml(input.yaml_text) : undefined;
  if (parsed) assertNoYamlProviderRuntime(parsed);
  const workflowId = canonical.workflow_id;
  if (!workflowId) throw new Error("DAG workflow must define a stable workflow id before it can be synced.");
  const existing = getDagWorkflow(workflowId);
  const now = nowIso();
  const revisionCreated = !existing || existing.canonical_hash !== compilation.canonical_hash;
  const headRevision = revisionCreated ? (existing?.head_revision ?? 0) + 1 : existing.head_revision;
  const workflow: DagWorkflow = {
    workflow_id: workflowId,
    name: canonical.name || workflowId,
    description: canonical.description,
    source_path: input.source_path,
    yaml_text: input.yaml_text,
    yaml_hash: _sha256(input.yaml_text),
    head_revision: headRevision,
    api_version: canonical.source_api_version,
    canonical_hash: compilation.canonical_hash!,
    compiler_version: canonical.compiler_version,
    node_ids: canonical.nodes.filter((node) => node.kind !== "terminal").map((node) => node.id),
    agent_ids: Object.keys(canonical.agents).sort(),
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  getDb().transaction(() => {
    _writeWorkflow(workflow);
    if (revisionCreated) {
      _writeRevision({
        workflow_id: workflowId,
        revision: headRevision,
        api_version: canonical.source_api_version,
        source_format: compilation.source_format,
        source_text: input.yaml_text,
        source_hash: workflow.yaml_hash,
        canonical_json: compilation.canonical_json!,
        canonical_hash: compilation.canonical_hash!,
        compiler_version: canonical.compiler_version,
        created_at: now,
      });
    }
  })();
  syncDagTriggers(workflowId, canonical.triggers);
  return { workflow, created: !existing, revision_created: revisionCreated, parsed };
}

export function listDagWorkflows(): DagWorkflow[] {
  _ensureStoredWorkflowRevisions();
  return (getDb()
    .prepare("SELECT * FROM dag_workflows ORDER BY updated_at DESC, workflow_id")
    .all() as Record<string, unknown>[])
    .map(_workflowFromRow);
}

export function getDagWorkflow(workflowId: string): DagWorkflow | undefined {
  _ensureStoredWorkflowRevisions();
  const row = getDb()
    .prepare("SELECT * FROM dag_workflows WHERE workflow_id = ?")
    .get(workflowId) as Record<string, unknown> | undefined;
  return row ? _workflowFromRow(row) : undefined;
}

export function listDagWorkflowRevisions(workflowId: string): DagWorkflowRevision[] {
  _ensureStoredWorkflowRevisions();
  return (getDb().prepare(`
    SELECT * FROM dag_workflow_revisions
    WHERE workflow_id = ?
    ORDER BY revision DESC
  `).all(workflowId) as Record<string, unknown>[]).map(_revisionFromRow);
}

export function getDagWorkflowRevision(workflowId: string, revision: number): DagWorkflowRevision | undefined {
  _ensureStoredWorkflowRevisions();
  const row = getDb().prepare(`
    SELECT * FROM dag_workflow_revisions WHERE workflow_id = ? AND revision = ?
  `).get(workflowId, revision) as Record<string, unknown> | undefined;
  return row ? _revisionFromRow(row) : undefined;
}

function _parseProfileYaml(yamlText: string, workflowIdOverride?: string): Omit<DagRuntimeProfile, "profile_key" | "created_at" | "updated_at"> {
  const raw = YAML.parse(yamlText);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Profile YAML root must be an object.");
  }
  const record = raw as Record<string, unknown>;
  const profileId = _string(record.profile_id ?? record.profileId ?? record.id ?? record.name);
  if (!profileId) throw new Error("Profile YAML must define profile_id.");
  const workflowId = workflowIdOverride ?? _string(record.workflow_id ?? record.workflowId);
  if (!workflowId) throw new Error("Profile YAML must define workflow_id or CLI must pass --workflow.");

  const defaultEntry = _profileEntry(record.default ?? record.defaults);
  const agents = _entriesFromJson(record.agents);
  _assertProfileHasNoProviderModel(record);
  _assertProfileEntriesResolvable(defaultEntry, agents);
  return {
    workflow_id: workflowId,
    profile_id: profileId,
    description: _string(record.description),
    default: defaultEntry,
    agents,
    source_path: undefined,
  };
}

function _assertProfileHasNoProviderModel(root: Record<string, unknown>): void {
  const failures: string[] = [];
  const checkEntry = (prefix: string, value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    if (_string(record.provider)) failures.push(`${prefix}.provider`);
    if (_string(record.model)) failures.push(`${prefix}.model`);
    if (_string(record.api_key ?? record.apiKey)) failures.push(`${prefix}.api_key`);
    if (_string(record.base_url ?? record.baseUrl)) failures.push(`${prefix}.base_url`);
  };
  checkEntry("default", root.default ?? root.defaults);
  const agents = root.agents;
  if (typeof agents === "object" && agents !== null && !Array.isArray(agents)) {
    for (const [agentId, value] of Object.entries(agents)) {
      checkEntry(`agents.${agentId}`, value);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Runtime profile must reference DB model_alias or llm_setting_id, not provider/model. Remove: ${failures.join(", ")}`);
  }
}

function _assertProfileEntriesResolvable(defaultEntry: DagRuntimeProfileEntry | undefined, agents: Record<string, DagRuntimeProfileEntry>): void {
  for (const [label, entry] of [["default", defaultEntry] as const, ...Object.entries(agents) as Array<[string, DagRuntimeProfileEntry]>]) {
    if (!entry) continue;
    if (entry.llm_setting_id && entry.model_alias) {
      throw new Error(`Profile entry '${label}' must use either llm_setting_id or model_alias, not both.`);
    }
    if (entry.llm_setting_id) {
      const setting = getSetting(entry.llm_setting_id);
      if (!setting?.is_active || !setting.supports_llm || isVoiceServiceSetting(setting)) {
        throw new Error(`Profile entry '${label}' references an unavailable LLM setting: ${entry.llm_setting_id}`);
      }
    }
    if (entry.model_alias) resolveModelAlias(entry.model_alias);
  }
}

export function upsertDagRuntimeProfileFromYaml(input: {
  yaml_text: string;
  workflow_id?: string;
  source_path?: string;
}): { profile: DagRuntimeProfile; created: boolean } {
  const parsed = _parseProfileYaml(input.yaml_text, input.workflow_id);
  const workflow = getDagWorkflow(parsed.workflow_id);
  if (!workflow) {
    throw new Error(`DAG workflow not found in database: ${parsed.workflow_id}. Run hr dag sync first.`);
  }
  const existing = getDagRuntimeProfile(parsed.workflow_id, parsed.profile_id);
  const now = nowIso();
  const profile: DagRuntimeProfile = {
    ...parsed,
    source_path: input.source_path,
    profile_key: `${parsed.workflow_id}:${parsed.profile_id}`,
    agents: parsed.agents,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  _writeProfile(profile);
  return { profile, created: !existing };
}

export function listDagRuntimeProfiles(workflowId?: string): DagRuntimeProfile[] {
  const rows = workflowId
    ? getDb()
      .prepare("SELECT * FROM dag_runtime_profiles WHERE workflow_id = ? ORDER BY updated_at DESC, profile_id")
      .all(workflowId) as Record<string, unknown>[]
    : getDb()
      .prepare("SELECT * FROM dag_runtime_profiles ORDER BY updated_at DESC, workflow_id, profile_id")
      .all() as Record<string, unknown>[];
  return rows.map(_profileFromRow);
}

export function getDagRuntimeProfile(workflowId: string, profileId: string): DagRuntimeProfile | undefined {
  const row = getDb()
    .prepare("SELECT * FROM dag_runtime_profiles WHERE workflow_id = ? AND profile_id = ?")
    .get(workflowId, profileId) as Record<string, unknown> | undefined;
  return row ? _profileFromRow(row) : undefined;
}

export function resolveModelAlias(alias: string): LLMSetting {
  const idMatch = getSetting(alias);
  if (idMatch?.is_active && idMatch.supports_llm && !isVoiceServiceSetting(idMatch)) return idMatch;
  const matches = listSettings().filter(
    (setting) => setting.is_active &&
      setting.supports_llm &&
      !isVoiceServiceSetting(setting) &&
      setting.display_name === alias,
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`Model alias '${alias}' is ambiguous across ${matches.length} settings. Use llm_setting_id instead.`);
  }
  throw new Error(`Model alias not found: ${alias}`);
}

function _resolveEntry(entry: DagRuntimeProfileEntry): DagRuntimeProfileResolvedEntry {
  const resolved: DagRuntimeProfileResolvedEntry = {};
  if (entry.llm_setting_id) {
    const setting = getSetting(entry.llm_setting_id);
    if (!setting?.is_active || !setting.supports_llm || isVoiceServiceSetting(setting)) {
      throw new Error(`Runtime profile references an unavailable LLM setting: ${entry.llm_setting_id}`);
    }
    resolved.llm_setting_id = entry.llm_setting_id;
  } else if (entry.model_alias) {
    resolved.llm_setting_id = resolveModelAlias(entry.model_alias).id;
  }
  if (entry.agent_type) resolved.agent_type = entry.agent_type;
  return resolved;
}

export function resolveDagRuntimeProfile(profile: DagRuntimeProfile): DagRuntimeProfileResolved {
  return {
    profile_id: profile.profile_id,
    workflow_id: profile.workflow_id,
    default: profile.default ? _resolveEntry(profile.default) : undefined,
    agents: Object.fromEntries(
      Object.entries(profile.agents).map(([agentId, entry]) => [agentId, _resolveEntry(entry)]),
    ),
  };
}

export function parseStoredDagWorkflow(workflow: DagWorkflow): ParsedDAG {
  const parsed = workflow.api_version === "homerail.ai/v1"
    ? (() => {
        const revision = getDagWorkflowRevision(workflow.workflow_id, workflow.head_revision);
        if (!revision) throw new Error(`DAG workflow revision not found: ${workflow.workflow_id}@${workflow.head_revision}`);
        return projectCanonicalWorkflowToParsedDAG(JSON.parse(revision.canonical_json) as CanonicalWorkflowIR);
      })()
    : parseDAGYaml(workflow.yaml_text);
  assertNoYamlProviderRuntime(parsed);
  return {
    ...parsed,
    meta: {
      ...parsed.meta,
      workflow_revision: workflow.head_revision,
      canonical_hash: workflow.canonical_hash,
      compiler_version: workflow.compiler_version,
      source_api_version: workflow.api_version,
    },
  };
}

export function applyDagRuntimeProfile(parsed: ParsedDAG, profile: DagRuntimeProfileResolved): ParsedDAG {
  const agentIds = _workflowAgentIds(parsed);
  const agents: Record<string, DAGAgentConfig> = {};
  for (const agentId of agentIds) {
    const base = parsed.meta.agents?.[agentId] ?? {};
    const override = profile.agents[agentId] ?? profile.default;
    agents[agentId] = {
      ...base,
      llm_setting_id: override?.llm_setting_id ?? base.llm_setting_id,
      agent_type: override?.agent_type ?? base.agent_type,
    };
  }
  return {
    meta: { ...parsed.meta, agents },
    graph: parsed.graph,
    loop_sources: parsed.loop_sources,
  };
}

export function _clearDagWorkflowTablesForTest(): void {
  clearTables(["dag_runtime_profiles", "dag_workflow_revisions", "dag_workflows"]);
}
