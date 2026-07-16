import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { getDbPath } from "../config/env.js";
import { listCatalogProviders } from "./provider-catalog.js";
import { nowIso } from "./time.js";

type SqliteDatabase = Database.Database;

let currentDbPath: string | undefined;
let currentDb: SqliteDatabase | undefined;

const CLEARABLE_TABLES = new Set([
  "llm_settings",
  "llm_custom_providers",
  "llm_provider_models",
  "llm_provider_endpoints",
  "llm_providers",
  "git_servers",
  "mcp_servers",
  "projects",
  "changes",
  "change_runs",
  "voice_settings",
  "memories",
  "agent_messages",
  "agent_sessions",
  "sessions",
  "session_messages",
  "session_activity_logs",
  "voice_ui_events",
  "dag_session_index",
  "dag_metrics",
  "dag_chats",
  "dag_handoffs",
  "dag_artifacts",
  "dag_actor_dispatch_exclusions",
  "dag_surface_generation_snapshots",
  "dag_actor_interventions",
  "dag_run_rounds",
  "dag_actor_provisioned_workers",
  "dag_actor_checkpoints",
  "dag_actor_runtimes",
  "dag_surface_projection_controls",
  "dag_surface_projection_queue",
  "dag_surface_projections",
  "dag_actor_commands",
  "dag_actors",
  "dag_activity_events",
  "dag_events",
  "dag_run_admissions",
  "dag_runs",
  "dag_workflow_revisions",
  "dag_runtime_profiles",
  "dag_workflows",
  "experience_ingest_jobs",
  "event_records",
  "worker_container_mappings",
  "nodes",
  "node_sessions",
  "orchestrations",
  "agents",
  "prompts",
  "skills",
  "manager_agent_config",
  "voice_agent_config",
  "voice_agent_sessions",
  "generative_ui_user_overrides",
  "generative_ui_transactions",
  "generative_ui_documents",
  "plugin_activation_events",
  "plugin_action_events",
  "plugin_capability_nonces",
  "plugin_confirmation_challenges",
  "plugin_action_requests",
  "plugin_tool_events",
  "plugin_tool_capability_nonces",
  "plugin_tool_confirmation_challenges",
  "plugin_agent_tool_continuations",
  "plugin_tool_requests",
  "plugin_permission_events",
  "plugin_permission_grants",
  "plugin_installations",
  "plugin_activations",
  "plugin_packages",
  "plugin_publisher_trust_events",
  "plugin_publisher_trust",
  "plugin_distribution_meta",
  "plugin_package_signatures",
  "plugin_registry_update_attempts",
  "plugin_registry_releases",
  "plugin_registry_sources",
  "experience_nodes",
  "experience_relationships",
  "storages",
  "storage_node_statuses",
  "container_volumes",
  "storage_usage_trackers",
  "encrypted_credentials",
  "temporary_keys",
  "security_policies",
  "security_audit_logs",
]);

function ensureDbDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function chmodPrivate(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort on platforms that do not support POSIX modes.
  }
}

function hasColumn(db: SqliteDatabase, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function ensureColumn(db: SqliteDatabase, table: string, column: string, definition: string): void {
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function ensureExpandedColumns(db: SqliteDatabase): void {
  const columns: Record<string, Array<[string, string]>> = {
    llm_settings: [
      ["display_name", "TEXT"],
      ["endpoint_name", "TEXT"],
      ["plan_type", "TEXT"],
      ["protocol", "TEXT"],
      ["auth_type", "TEXT"],
      ["key_hint", "TEXT"],
      ["base_url", "TEXT"],
      ["chat_completions_base_url", "TEXT"],
      ["responses_base_url", "TEXT"],
      ["anthropic_base_url", "TEXT"],
      ["resource_id", "TEXT"],
      ["voice_adapter", "TEXT"],
      ["tts_http_url", "TEXT"],
      ["tts_realtime_url", "TEXT"],
      ["tts_bidirectional_url", "TEXT"],
      ["asr_realtime_url", "TEXT"],
      ["asr_async_url", "TEXT"],
      ["tts_voice", "TEXT"],
      ["tts_format", "TEXT"],
      ["tts_sample_rate", "INTEGER"],
      ["models", "TEXT"],
      ["supports_llm", "INTEGER"],
      ["supports_asr", "INTEGER"],
      ["supports_tts", "INTEGER"],
      ["supports_audio_input", "INTEGER"],
      ["supports_image_input", "INTEGER"],
      ["supports_video_input", "INTEGER"],
      ["is_active", "INTEGER"],
      ["is_default", "INTEGER"],
      ["created_at", "TEXT"],
      ["api_key_encrypted", "TEXT"],
      ["secret_storage", "TEXT"],
    ],
    llm_providers: [
      ["chat_completions_base_url", "TEXT"],
      ["responses_base_url", "TEXT"],
      ["anthropic_base_url", "TEXT"],
    ],
    llm_provider_endpoints: [
      ["responses_base_url", "TEXT"],
      ["tts_http_url", "TEXT"],
      ["tts_realtime_url", "TEXT"],
      ["tts_bidirectional_url", "TEXT"],
      ["asr_realtime_url", "TEXT"],
      ["asr_async_url", "TEXT"],
      ["tts_voice", "TEXT"],
      ["tts_format", "TEXT"],
      ["tts_sample_rate", "INTEGER"],
      ["region", "TEXT"],
      ["region_label", "TEXT"],
    ],
    projects: [
      ["name", "TEXT"],
      ["description", "TEXT"],
      ["status", "TEXT"],
      ["workspace_path", "TEXT"],
      ["project_root", "TEXT"],
      ["git_server_id", "TEXT"],
      ["git_repo_name", "TEXT"],
      ["git_default_branch", "TEXT"],
      ["default_image_id", "TEXT"],
      ["default_node_id", "TEXT"],
      ["metadata", "TEXT"],
      ["created_at", "TEXT"],
    ],
    changes: [
      ["title", "TEXT"],
      ["task", "TEXT"],
      ["description", "TEXT"],
      ["content", "TEXT"],
      ["source_issue", "TEXT"],
      ["status", "TEXT"],
      ["orchestration_id", "TEXT"],
      ["orchestration_yaml_path", "TEXT"],
      ["orchestration_yaml_content", "TEXT"],
      ["task_yaml_path", "TEXT"],
      ["phases", "TEXT"],
      ["metadata", "TEXT"],
      ["storage_id", "TEXT"],
      ["base_branch", "TEXT"],
      ["git_branch", "TEXT"],
      ["next_run_number", "INTEGER"],
      ["runtime_profile", "TEXT"],
      ["model_map", "TEXT"],
      ["created_at", "TEXT"],
      ["completed_at", "TEXT"],
    ],
    dag_runs: [
      ["change_run_id", "TEXT"],
      ["change_id", "TEXT"],
      ["project_id", "TEXT"],
      ["workflow_id", "TEXT"],
      ["workflow_name", "TEXT"],
      ["completed_at", "INTEGER"],
      ["graph", "TEXT"],
      ["node_states", "TEXT"],
    ],
    dag_session_index: [
      ["attempt", "INTEGER NOT NULL DEFAULT 1"],
      ["parent_session_id", "TEXT"],
      ["forked_from_entry_uuid", "TEXT"],
      ["resume_instruction", "TEXT"],
      ["status", "TEXT NOT NULL DEFAULT 'active'"],
    ],
  };

  for (const [table, tableColumns] of Object.entries(columns)) {
    for (const [column, definition] of tableColumns) {
      ensureColumn(db, table, column, definition);
    }
  }
}

function boolToInt(value?: boolean): number {
  return value ? 1 : 0;
}

function seedBuiltinProviderCatalog(db: SqliteDatabase): void {
  const now = nowIso();
  const providers = listCatalogProviders();
  db.transaction(() => {
    const providerIds = providers.map((provider) => provider.id);
    if (providerIds.length) {
      const placeholders = providerIds.map(() => "?").join(", ");
      db.prepare(`DELETE FROM llm_providers WHERE source = 'builtin' AND id NOT IN (${placeholders})`).run(...providerIds);
    }
    db.prepare("DELETE FROM llm_provider_models WHERE source = 'builtin'").run();
    db.prepare("DELETE FROM llm_provider_endpoints WHERE source = 'builtin'").run();

    const providerStmt = db.prepare(`
      INSERT INTO llm_providers(
        id, name, status, source, readonly, default_model, base_url,
        chat_completions_base_url, responses_base_url, anthropic_base_url, docs_url,
        supports_llm, supports_asr, supports_tts, supports_audio_input,
        supports_image_input, supports_video_input, updated_at, data
      )
      VALUES (?, ?, ?, 'builtin', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        status = excluded.status,
        source = 'builtin',
        readonly = 1,
        default_model = excluded.default_model,
        base_url = excluded.base_url,
        chat_completions_base_url = excluded.chat_completions_base_url,
        responses_base_url = excluded.responses_base_url,
        anthropic_base_url = excluded.anthropic_base_url,
        docs_url = excluded.docs_url,
        supports_llm = excluded.supports_llm,
        supports_asr = excluded.supports_asr,
        supports_tts = excluded.supports_tts,
        supports_audio_input = excluded.supports_audio_input,
        supports_image_input = excluded.supports_image_input,
        supports_video_input = excluded.supports_video_input,
        updated_at = excluded.updated_at,
        data = excluded.data
    `);
    const endpointStmt = db.prepare(`
      INSERT INTO llm_provider_endpoints(
        id, provider_id, name, source, readonly, plan_type, protocol, auth_type,
        base_url, chat_completions_base_url, responses_base_url, anthropic_base_url, default_model,
        resource_id, voice_adapter, tts_http_url, tts_realtime_url,
        tts_bidirectional_url, asr_realtime_url, asr_async_url, tts_voice,
        tts_format, tts_sample_rate, region, region_label, docs_url,
        key_hint, key_prefix_hint,
        supports_llm, supports_asr, supports_tts, supports_audio_input,
        supports_image_input, supports_video_input, updated_at, data
      )
      VALUES (?, ?, ?, 'builtin', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const modelStmt = db.prepare(`
      INSERT INTO llm_provider_models(
        id, provider_id, endpoint_id, model_id, source, readonly, display_name,
        recommended, resource_id, supports_llm, supports_asr, supports_tts,
        supports_audio_input, supports_image_input, supports_video_input,
        updated_at, data
      )
      VALUES (?, ?, ?, ?, 'builtin', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const provider of providers) {
      providerStmt.run(
        provider.id,
        provider.name,
        provider.status,
        provider.default_model,
        provider.base_url ?? null,
        provider.chat_completions_base_url ?? null,
        provider.responses_base_url ?? null,
        provider.anthropic_base_url ?? null,
        provider.docs_url ?? null,
        boolToInt(provider.supports_llm ?? true),
        boolToInt(provider.supports_asr),
        boolToInt(provider.supports_tts),
        boolToInt(provider.supports_audio_input),
        boolToInt(provider.supports_image_input),
        boolToInt(provider.supports_video_input),
        now,
        encodeJson(provider),
      );

      for (const endpoint of provider.endpoints) {
        endpointStmt.run(
          endpoint.id,
          provider.id,
          endpoint.name,
          endpoint.plan_type,
          endpoint.protocol,
          endpoint.auth_type,
          endpoint.base_url,
          endpoint.chat_completions_base_url ?? null,
          endpoint.responses_base_url ?? null,
          endpoint.anthropic_base_url ?? null,
          endpoint.default_model,
          endpoint.resource_id ?? null,
          endpoint.voice_adapter ?? null,
          endpoint.tts_http_url ?? null,
          endpoint.tts_realtime_url ?? null,
          endpoint.tts_bidirectional_url ?? null,
          endpoint.asr_realtime_url ?? null,
          endpoint.asr_async_url ?? null,
          endpoint.tts_voice ?? null,
          endpoint.tts_format ?? null,
          endpoint.tts_sample_rate ?? null,
          endpoint.region ?? null,
          endpoint.region_label ?? null,
          endpoint.docs_url ?? null,
          endpoint.key_hint ?? null,
          endpoint.key_prefix_hint ?? null,
          boolToInt(endpoint.supports_llm ?? true),
          boolToInt(endpoint.supports_asr),
          boolToInt(endpoint.supports_tts),
          boolToInt(endpoint.supports_audio_input),
          boolToInt(endpoint.supports_image_input),
          boolToInt(endpoint.supports_video_input),
          now,
          encodeJson(endpoint),
        );

        for (const model of endpoint.models) {
          modelStmt.run(
            `${endpoint.id}:${model.id}`,
            provider.id,
            endpoint.id,
            model.id,
            model.display_name ?? model.name ?? model.id,
            boolToInt(model.recommended),
            model.resource_id ?? null,
            boolToInt(model.supports_llm ?? true),
            boolToInt(model.supports_asr),
            boolToInt(model.supports_tts),
            boolToInt(model.supports_audio_input),
            boolToInt(model.supports_image_input),
            boolToInt(model.supports_video_input),
            now,
            encodeJson(model),
          );
        }
      }
    }
  })();
}

interface SchemaMigration {
  version: number;
  up: (db: SqliteDatabase) => void;
  validate?: (db: SqliteDatabase) => void;
}

function runSchemaMigrations(db: SqliteDatabase, migrations: readonly SchemaMigration[]): void {
  const ordered = [...migrations].sort((left, right) => left.version - right.version);
  if (ordered.some((migration, index) => migration.version < 3 || (index > 0 && migration.version === ordered[index - 1].version))) {
    throw new Error("Schema migrations must have unique versions >= 3");
  }
  const supportedVersion = ordered.at(-1)?.version ?? 2;
  const currentVersion = (db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as {
    version: number | null;
  }).version ?? 0;
  if (currentVersion > supportedVersion) {
    throw new Error(`Database schema version ${currentVersion} is newer than supported version ${supportedVersion}`);
  }
  const applied = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?");
  const record = db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)");
  for (const migration of ordered) {
    db.transaction(() => {
      const alreadyApplied = Boolean(applied.get(migration.version));
      if (!alreadyApplied) migration.up(db);
      migration.validate?.(db);
      if (!alreadyApplied) record.run(migration.version, nowIso());
    }).immediate();
  }
}

function hasTable(db: SqliteDatabase, table: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table));
}

/**
 * main used migration ids 3/4/5/6 for DAG schema work while the A2UI branch independently
 * used the same ids for Generative UI and plugins. Detect only databases that
 * already have main's physical DAG schema and no Generative UI schema, then
 * free those ids so the merged 3-14 chain can run. The DAG changes receive
 * durable ids 15/16/17/18.
 */
function legacyMainMigrationVersions(db: SqliteDatabase): number[] {
  if (!hasTable(db, "schema_migrations") || hasTable(db, "generative_ui_documents")) return [];
  const hasVersion = (version: number) => Boolean(db.prepare(
    "SELECT 1 FROM schema_migrations WHERE version = ?",
  ).get(version));
  const versions: number[] = [];
  if (
    hasVersion(3)
    && hasTable(db, "dag_workflow_revisions")
    && hasColumn(db, "dag_workflows", "head_revision")
    && hasColumn(db, "dag_workflows", "canonical_hash")
  ) versions.push(3);
  if (
    hasVersion(4)
    && hasTable(db, "dag_approvals")
    && hasColumn(db, "dag_approvals", "proposer_actor")
  ) versions.push(4);
  if (
    hasVersion(5)
    && hasTable(db, "dag_run_admissions")
    && !hasTable(db, "plugin_packages")
  ) versions.push(5);
  if (
    hasVersion(6)
    && hasTable(db, "dag_artifacts")
    && !hasTable(db, "plugin_packages")
  ) versions.push(6);
  return versions;
}

function validateDagWorkflowSchemaV15(db: SqliteDatabase): void {
  if (!hasTable(db, "dag_workflow_revisions")) {
    throw new Error("Schema migration 15 is incomplete: missing table dag_workflow_revisions");
  }
  for (const column of ["head_revision", "api_version", "canonical_hash", "compiler_version"]) {
    if (!hasColumn(db, "dag_workflows", column)) {
      throw new Error(`Schema migration 15 is incomplete: dag_workflows is missing column ${column}`);
    }
  }
}

function validateDagApprovalIdentityV16(db: SqliteDatabase): void {
  if (!hasTable(db, "dag_approvals") || !hasColumn(db, "dag_approvals", "proposer_actor")) {
    throw new Error("Schema migration 16 is incomplete: dag_approvals proposer identity is missing");
  }
}

function validateDagRunAdmissionSchemaV17(db: SqliteDatabase): void {
  if (!hasTable(db, "dag_run_admissions")) {
    throw new Error("Schema migration 17 is incomplete: missing table dag_run_admissions");
  }
  for (const column of ["run_id", "workflow_id", "source", "created_at"]) {
    if (!hasColumn(db, "dag_run_admissions", column)) {
      throw new Error(`Schema migration 17 is incomplete: dag_run_admissions is missing column ${column}`);
    }
  }
}

function validateDagArtifactSchemaV18(db: SqliteDatabase): void {
  if (!hasTable(db, "dag_artifacts")) {
    throw new Error("Schema migration 18 is incomplete: missing table dag_artifacts");
  }
  for (const column of [
    "run_id",
    "name",
    "artifact_id",
    "status",
    "upload_token_hash",
    "upload_expires_at",
    "created_at",
    "updated_at",
    "data",
  ]) {
    if (!hasColumn(db, "dag_artifacts", column)) {
      throw new Error(`Schema migration 18 is incomplete: dag_artifacts is missing column ${column}`);
    }
  }
}

function validateDagActivitySchemaV19(db: SqliteDatabase): void {
  const table = "dag_activity_events";
  if (!hasTable(db, table)) {
    throw new Error(`Schema migration 19 is incomplete: missing table ${table}`);
  }
  for (const column of [
    "seq",
    "event_id",
    "schema_version",
    "run_id",
    "round_id",
    "node_id",
    "actor_id",
    "generation",
    "surface_id",
    "activity_sequence",
    "activity_type",
    "timestamp",
    "received_at",
    "event_digest",
    "event_json",
  ]) {
    if (!hasColumn(db, table, column)) {
      throw new Error(`Schema migration 19 is incomplete: ${table} is missing column ${column}`);
    }
  }

  const indexes = new Map((db.prepare(`PRAGMA index_list(${table})`).all() as Array<{
    name: string;
    unique: number;
  }>).map((index) => [index.name, index]));
  for (const [name, unique, expectedColumns] of [
    ["idx_dag_activity_events_event_id", 1, ["event_id"]],
    ["idx_dag_activity_events_actor_sequence", 1, ["run_id", "actor_id", "generation", "activity_sequence"]],
    ["idx_dag_activity_events_run_seq", 0, ["run_id", "seq"]],
    ["idx_dag_activity_events_run_actor_seq", 0, ["run_id", "actor_id", "seq"]],
  ] as const) {
    if (indexes.get(name)?.unique !== unique) {
      throw new Error(`Schema migration 19 is incomplete: index ${name} is missing or invalid`);
    }
    const columns = (db.prepare(`PRAGMA index_info(${name})`).all() as Array<{
      seqno: number;
      name: string;
    }>).sort((left, right) => left.seqno - right.seqno).map((entry) => entry.name);
    if (columns.length !== expectedColumns.length || columns.some((column, index) => column !== expectedColumns[index])) {
      throw new Error(`Schema migration 19 is incomplete: index ${name} has invalid columns`);
    }
  }

  const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (!foreignKeys.some((entry) => (
    entry.table === "dag_runs"
    && entry.from === "run_id"
    && entry.to === "run_id"
    && entry.on_delete.toUpperCase() === "CASCADE"
  ))) throw new Error("Schema migration 19 is incomplete: activity run retention constraint is missing");
}

function validateDagActivityRoundIndexV25(db: SqliteDatabase): void {
  const name = "idx_dag_activity_events_run_round_actor_generation_type_seq";
  const index = (db.prepare("PRAGMA index_list(dag_activity_events)").all() as Array<{
    name: string;
    unique: number;
  }>).find((entry) => entry.name === name);
  if (!index || index.unique !== 0) {
    throw new Error(`Schema migration 25 is incomplete: index ${name} is missing or invalid`);
  }
  const columns = (db.prepare(`PRAGMA index_info(${name})`).all() as Array<{
    seqno: number;
    name: string;
  }>).sort((left, right) => left.seqno - right.seqno).map((entry) => entry.name);
  const expected = ["run_id", "round_id", "actor_id", "generation", "activity_type", "seq"];
  if (columns.length !== expected.length || columns.some((column, index) => column !== expected[index])) {
    throw new Error(`Schema migration 25 is incomplete: index ${name} has invalid columns`);
  }
}

function validateDagActorSchemaV20(db: SqliteDatabase): void {
  const requiredColumns: Record<string, readonly string[]> = {
    dag_actors: [
      "run_id",
      "actor_id",
      "node_id",
      "role",
      "generation",
      "attempt",
      "version",
      "session_id",
      "model_profile_json",
      "surface_id",
      "workspace_ref",
      "checkpoint_ref",
      "created_at",
      "updated_at",
    ],
    dag_actor_commands: [
      "command_id",
      "run_id",
      "actor_id",
      "round_id",
      "target_generation",
      "status",
      "idempotency_key",
      "payload_digest",
      "payload_json",
      "claimed_generation",
      "created_at",
      "delivered_at",
      "claimed_at",
      "completed_at",
      "failure_json",
    ],
  };
  for (const [table, columns] of Object.entries(requiredColumns)) {
    if (!hasTable(db, table)) {
      throw new Error(`Schema migration 20 is incomplete: missing table ${table}`);
    }
    for (const column of columns) {
      if (!hasColumn(db, table, column)) {
        throw new Error(`Schema migration 20 is incomplete: ${table} is missing column ${column}`);
      }
    }
  }

  const expectedIndexes: Record<string, readonly string[]> = {
    idx_dag_actors_run_node: ["run_id", "node_id"],
    idx_dag_actors_run_surface: ["run_id", "surface_id"],
    idx_dag_actor_commands_idempotency: ["run_id", "actor_id", "idempotency_key"],
    idx_dag_actor_commands_actor_status: ["run_id", "actor_id", "status", "created_at", "command_id"],
    idx_dag_actor_commands_round: ["run_id", "round_id", "created_at", "command_id"],
  };
  for (const [name, expectedColumns] of Object.entries(expectedIndexes)) {
    const index = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(name) as { name: string; sql: string | null } | undefined;
    if (!index) throw new Error(`Schema migration 20 is incomplete: missing index ${name}`);
    const columns = (db.prepare(`PRAGMA index_info(${name})`).all() as Array<{
      seqno: number;
      name: string;
    }>).sort((left, right) => left.seqno - right.seqno).map((entry) => entry.name);
    if (columns.length !== expectedColumns.length || columns.some((column, position) => column !== expectedColumns[position])) {
      throw new Error(`Schema migration 20 is incomplete: index ${name} has invalid columns`);
    }
    if (name !== "idx_dag_actor_commands_actor_status" && name !== "idx_dag_actor_commands_round") {
      const unique = (db.prepare(`PRAGMA index_list(${name.startsWith("idx_dag_actors") ? "dag_actors" : "dag_actor_commands"})`)
        .all() as Array<{ name: string; unique: number }>).find((entry) => entry.name === name)?.unique;
      if (unique !== 1) throw new Error(`Schema migration 20 is incomplete: index ${name} must be unique`);
    }
  }

  const actorForeignKeys = db.prepare("PRAGMA foreign_key_list(dag_actors)").all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (!actorForeignKeys.some((entry) => (
    entry.table === "dag_runs"
    && entry.from === "run_id"
    && entry.to === "run_id"
    && entry.on_delete.toUpperCase() === "CASCADE"
  ))) throw new Error("Schema migration 20 is incomplete: actor run retention constraint is missing");

  const commandForeignKeys = db.prepare("PRAGMA foreign_key_list(dag_actor_commands)").all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  for (const [from, to] of [["run_id", "run_id"], ["actor_id", "actor_id"]] as const) {
    if (!commandForeignKeys.some((entry) => (
      entry.table === "dag_actors"
      && entry.from === from
      && entry.to === to
      && entry.on_delete.toUpperCase() === "CASCADE"
    ))) throw new Error(`Schema migration 20 is incomplete: command actor ${from} constraint is missing`);
  }
}

function compactSchemaSql(db: SqliteDatabase, type: "table" | "index" | "trigger", name: string): string {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?")
    .get(type, name) as { sql: string | null } | undefined;
  return row?.sql?.toLowerCase().replace(/\s+/g, "") ?? "";
}

function dagActorCommandsSupportsCancelled(db: SqliteDatabase): boolean {
  const sql = compactSchemaSql(db, "table", "dag_actor_commands");
  return sql.includes(
    "statusin('pending','delivered','claimed','acknowledged','failed','cancelled')",
  ) && sql.includes(
    "(status='cancelled'andclaimed_generationisnullandclaimed_atisnullandcompleted_atisnotnullandfailure_jsonisnotnull)",
  );
}

function upgradeDagActorCommandsV23(db: SqliteDatabase): void {
  if (dagActorCommandsSupportsCancelled(db)) return;

  db.exec(`
    DROP TABLE IF EXISTS dag_actor_commands_v23;
    CREATE TABLE dag_actor_commands_v23 (
      command_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      round_id TEXT NOT NULL,
      target_generation INTEGER NOT NULL CHECK(target_generation >= 1),
      status TEXT NOT NULL CHECK(status IN ('pending', 'delivered', 'claimed', 'acknowledged', 'failed', 'cancelled')),
      idempotency_key TEXT NOT NULL,
      payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64),
      payload_json TEXT NOT NULL,
      claimed_generation INTEGER CHECK(claimed_generation IS NULL OR claimed_generation >= 1),
      created_at INTEGER NOT NULL CHECK(created_at >= 0),
      delivered_at INTEGER CHECK(delivered_at IS NULL OR delivered_at >= created_at),
      claimed_at INTEGER CHECK(claimed_at IS NULL OR claimed_at >= created_at),
      completed_at INTEGER CHECK(completed_at IS NULL OR completed_at >= created_at),
      failure_json TEXT,
      CHECK(
        (status = 'pending' AND delivered_at IS NULL AND claimed_generation IS NULL AND claimed_at IS NULL AND completed_at IS NULL AND failure_json IS NULL)
        OR (status = 'delivered' AND delivered_at IS NOT NULL AND claimed_generation IS NULL AND claimed_at IS NULL AND completed_at IS NULL AND failure_json IS NULL)
        OR (status = 'claimed' AND claimed_generation IS NOT NULL AND claimed_at IS NOT NULL AND completed_at IS NULL AND failure_json IS NULL)
        OR (status = 'acknowledged' AND claimed_generation IS NOT NULL AND claimed_at IS NOT NULL AND completed_at IS NOT NULL AND failure_json IS NULL)
        OR (status = 'failed' AND claimed_generation IS NOT NULL AND claimed_at IS NOT NULL AND completed_at IS NOT NULL AND failure_json IS NOT NULL)
        OR (status = 'cancelled' AND claimed_generation IS NULL AND claimed_at IS NULL AND completed_at IS NOT NULL AND failure_json IS NOT NULL)
      ),
      FOREIGN KEY(run_id, actor_id) REFERENCES dag_actors(run_id, actor_id) ON DELETE CASCADE
    );
    INSERT INTO dag_actor_commands_v23(
      command_id, run_id, actor_id, round_id, target_generation, status,
      idempotency_key, payload_digest, payload_json, claimed_generation,
      created_at, delivered_at, claimed_at, completed_at, failure_json
    )
    SELECT
      command_id, run_id, actor_id, round_id, target_generation, status,
      idempotency_key, payload_digest, payload_json, claimed_generation,
      created_at, delivered_at, claimed_at, completed_at, failure_json
    FROM dag_actor_commands;
    DROP TABLE dag_actor_commands;
    ALTER TABLE dag_actor_commands_v23 RENAME TO dag_actor_commands;
    CREATE UNIQUE INDEX idx_dag_actor_commands_idempotency
      ON dag_actor_commands(run_id, actor_id, idempotency_key);
    CREATE INDEX idx_dag_actor_commands_actor_status
      ON dag_actor_commands(run_id, actor_id, status, created_at, command_id);
    CREATE INDEX idx_dag_actor_commands_round
      ON dag_actor_commands(run_id, round_id, created_at, command_id);
  `);
}

function validateDagRunRoundSchemaV23(db: SqliteDatabase): void {
  const table = "dag_run_rounds";
  if (!hasTable(db, table)) {
    throw new Error(`Schema migration 23 is incomplete: missing table ${table}`);
  }

  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    cid: number;
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }>;
  const expectedColumns = [
    ["run_id", "TEXT", 1, 1],
    ["round_id", "TEXT", 1, 2],
    ["ordinal", "INTEGER", 1, 0],
    ["status", "TEXT", 1, 0],
    ["target_actor_ids_json", "TEXT", 1, 0],
    ["await_node_id", "TEXT", 0, 0],
    ["opened_at", "INTEGER", 1, 0],
    ["closed_at", "INTEGER", 0, 0],
    ["expires_at", "INTEGER", 0, 0],
  ] as const;
  if (columns.length !== expectedColumns.length) {
    throw new Error(`Schema migration 23 is incomplete: ${table} has invalid columns`);
  }
  for (const [position, [name, type, notnull, pk]] of expectedColumns.entries()) {
    const column = columns[position];
    if (
      column.name !== name
      || column.type.toUpperCase() !== type
      || column.notnull !== notnull
      || column.pk !== pk
    ) {
      throw new Error(`Schema migration 23 is incomplete: ${table} column ${name} is invalid`);
    }
  }

  const tableSql = compactSchemaSql(db, "table", table);
  for (const fragment of [
    "statusin('active','waiting','completed','cancelled','failed')",
    "check(ordinal>=1)",
    "check(opened_at>=0)",
    "check(closed_atisnullorclosed_at>=opened_at)",
    "check(expires_atisnullorexpires_at>=opened_at)",
    "(status='active'andawait_node_idisnullandclosed_atisnull)",
    "(status='waiting'andawait_node_idisnotnullandclosed_atisnotnull)",
    "(statusin('completed','cancelled','failed')andclosed_atisnotnull)",
  ]) {
    if (!tableSql.includes(fragment)) {
      throw new Error(`Schema migration 23 is incomplete: ${table} constraints are invalid`);
    }
  }

  const indexes = new Map((db.prepare(`PRAGMA index_list(${table})`).all() as Array<{
    name: string;
    unique: number;
    partial: number;
  }>).map((index) => [index.name, index]));
  for (const [name, expectedColumnsForIndex, partial] of [
    ["idx_dag_run_rounds_run_ordinal", ["run_id", "ordinal"], 0],
    ["idx_dag_run_rounds_current", ["run_id"], 1],
  ] as const) {
    const index = indexes.get(name);
    if (index?.unique !== 1 || index.partial !== partial) {
      throw new Error(`Schema migration 23 is incomplete: index ${name} is missing or invalid`);
    }
    const actualColumns = (db.prepare(`PRAGMA index_info(${name})`).all() as Array<{
      seqno: number;
      name: string;
    }>).sort((left, right) => left.seqno - right.seqno).map((entry) => entry.name);
    if (
      actualColumns.length !== expectedColumnsForIndex.length
      || actualColumns.some((column, indexPosition) => column !== expectedColumnsForIndex[indexPosition])
    ) {
      throw new Error(`Schema migration 23 is incomplete: index ${name} has invalid columns`);
    }
  }
  if (!compactSchemaSql(db, "index", "idx_dag_run_rounds_current").includes(
    "wherestatusin('active','waiting')",
  )) {
    throw new Error("Schema migration 23 is incomplete: current round index predicate is invalid");
  }

  const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (
    foreignKeys.length !== 1
    || foreignKeys[0].table !== "dag_runs"
    || foreignKeys[0].from !== "run_id"
    || foreignKeys[0].to !== "run_id"
    || foreignKeys[0].on_delete.toUpperCase() !== "CASCADE"
  ) {
    throw new Error("Schema migration 23 is incomplete: round run retention constraint is invalid");
  }

  validateDagActorSchemaV20(db);
  if (!dagActorCommandsSupportsCancelled(db)) {
    throw new Error("Schema migration 23 is incomplete: dag_actor_commands does not support cancelled commands");
  }
}

function validateDagActorLeaseSchemaV24(db: SqliteDatabase): void {
  const expectedTables = {
    dag_actor_runtimes: [
      ["run_id", "TEXT", 1, 1, null],
      ["actor_id", "TEXT", 1, 2, null],
      ["state", "TEXT", 1, 0, null],
      ["lease_generation", "INTEGER", 1, 0, "0"],
      ["target_type", "TEXT", 0, 0, null],
      ["target_id", "TEXT", 0, 0, null],
      ["idle_deadline", "INTEGER", 0, 0, null],
      ["pinned", "INTEGER", 1, 0, "0"],
      ["retained_until", "INTEGER", 0, 0, null],
      ["state_changed_at", "INTEGER", 1, 0, null],
      ["created_at", "INTEGER", 1, 0, null],
      ["updated_at", "INTEGER", 1, 0, null],
      ["version", "INTEGER", 1, 0, "1"],
    ],
    dag_actor_checkpoints: [
      ["run_id", "TEXT", 1, 1, null],
      ["actor_id", "TEXT", 1, 2, null],
      ["checkpoint_version", "INTEGER", 1, 3, null],
      ["schema_version", "INTEGER", 1, 0, null],
      ["actor_generation", "INTEGER", 1, 0, null],
      ["round_id", "TEXT", 1, 0, null],
      ["captured_at", "INTEGER", 1, 0, null],
      ["checkpoint_sha256", "TEXT", 1, 0, null],
      ["checkpoint_json", "TEXT", 1, 0, null],
      ["created_at", "INTEGER", 1, 0, null],
    ],
    dag_actor_provisioned_workers: [
      ["run_id", "TEXT", 1, 1, null],
      ["actor_id", "TEXT", 1, 2, null],
      ["lease_generation", "INTEGER", 1, 3, null],
      ["worker_id", "TEXT", 1, 4, null],
      ["node_id", "TEXT", 1, 0, null],
      ["container_id", "TEXT", 1, 0, null],
      ["docker_node_id", "TEXT", 1, 0, null],
      ["status", "TEXT", 1, 0, null],
      ["registered_at", "INTEGER", 1, 0, null],
      ["updated_at", "INTEGER", 1, 0, null],
      ["release_requested_at", "INTEGER", 0, 0, null],
      ["terminal_at", "INTEGER", 0, 0, null],
      ["failure_json", "TEXT", 0, 0, null],
      ["version", "INTEGER", 1, 0, "1"],
    ],
  } as const;

  for (const [table, expectedColumns] of Object.entries(expectedTables)) {
    if (!hasTable(db, table)) {
      throw new Error(`Schema migration 24 is incomplete: missing table ${table}`);
    }
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | number | null;
      pk: number;
    }>;
    if (columns.length !== expectedColumns.length) {
      throw new Error(`Schema migration 24 is incomplete: ${table} has invalid columns`);
    }
    for (const [position, [name, type, notnull, pk, defaultValue]] of expectedColumns.entries()) {
      const column = columns[position];
      if (
        column.name !== name
        || column.type.toUpperCase() !== type
        || column.notnull !== notnull
        || column.pk !== pk
        || (column.dflt_value === null ? null : String(column.dflt_value)) !== defaultValue
      ) {
        throw new Error(`Schema migration 24 is incomplete: ${table} column ${name} is invalid`);
      }
    }
  }

  const tableFragments: Record<string, readonly string[]> = {
    dag_actor_runtimes: [
      "statein('leased','dormant','retired')",
      "check(lease_generation>=0)",
      "check(pinnedin(0,1))",
      "check(version>=1)",
      "updated_at>=created_at",
      "state_changed_at>=created_at",
      "state_changed_at<=updated_at",
      "state='leased'andlease_generation>=1",
      "target_typeisnotnull",
      "target_idisnotnull",
      "idle_deadlineisnotnull",
      "idle_deadline>=state_changed_at",
      "retained_untilisnull",
      "statein('dormant','retired')",
      "target_typeisnull",
      "target_idisnull",
      "idle_deadlineisnull",
      "retained_untilisnotnull",
      "retained_until>=updated_at",
    ],
    dag_actor_checkpoints: [
      "check(checkpoint_version>=1)",
      "check(schema_version=1)",
      "check(actor_generation>=1)",
      "check(captured_at>=0)",
      "length(checkpoint_sha256)=64",
      "checkpoint_sha256notglob'*[^0-9a-f]*'",
      "length(checkpoint_json)between2and262144",
      "check(created_at>=0)",
    ],
    dag_actor_provisioned_workers: [
      "check(lease_generation>=1)",
      "statusin('active','releasing','released','failed')",
      "check(version>=1)",
      "updated_at>=registered_at",
      "release_requested_atisnullorrelease_requested_at>=registered_at",
      "terminal_atisnullorterminal_at>=registered_at",
      "status='active'andrelease_requested_atisnullandterminal_atisnullandfailure_jsonisnull",
      "status='releasing'andrelease_requested_atisnotnullandterminal_atisnullandfailure_jsonisnull",
      "status='released'andrelease_requested_atisnotnullandterminal_atisnotnullandfailure_jsonisnull",
      "status='failed'andterminal_atisnotnullandfailure_jsonisnotnull",
    ],
  };
  for (const [table, fragments] of Object.entries(tableFragments)) {
    const sql = compactSchemaSql(db, "table", table);
    if (fragments.some((fragment) => !sql.includes(fragment))) {
      throw new Error(`Schema migration 24 is incomplete: ${table} constraints are invalid`);
    }
  }

  const expectedIndexes = [
    ["dag_actor_runtimes", "idx_dag_actor_runtimes_expired", 0, 1, ["idle_deadline", "run_id", "actor_id"]],
    ["dag_actor_runtimes", "idx_dag_actor_runtimes_retention", 0, 1, ["retained_until", "run_id", "actor_id"]],
    ["dag_actor_checkpoints", "idx_dag_actor_checkpoints_generation", 0, 0, ["run_id", "actor_id", "actor_generation", "checkpoint_version"]],
    ["dag_actor_provisioned_workers", "idx_dag_actor_provisioned_workers_container", 1, 0, ["container_id"]],
    ["dag_actor_provisioned_workers", "idx_dag_actor_provisioned_workers_restart", 0, 0, ["status", "docker_node_id", "updated_at", "run_id", "actor_id"]],
    ["dag_actor_provisioned_workers", "idx_dag_actor_provisioned_workers_current", 1, 1, ["run_id", "actor_id", "lease_generation"]],
  ] as const;
  for (const [table, name, unique, partial, expectedColumns] of expectedIndexes) {
    const index = (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{
      name: string;
      unique: number;
      partial: number;
    }>).find((entry) => entry.name === name);
    if (index?.unique !== unique || index.partial !== partial) {
      throw new Error(`Schema migration 24 is incomplete: index ${name} is missing or invalid`);
    }
    const actualColumns = (db.prepare(`PRAGMA index_info(${name})`).all() as Array<{
      seqno: number;
      name: string;
    }>).sort((left, right) => left.seqno - right.seqno).map((entry) => entry.name);
    if (
      actualColumns.length !== expectedColumns.length
      || actualColumns.some((column, position) => column !== expectedColumns[position])
    ) {
      throw new Error(`Schema migration 24 is incomplete: index ${name} has invalid columns`);
    }
  }
  const indexPredicates: Record<string, string> = {
    idx_dag_actor_runtimes_expired: "wherestate='leased'andpinned=0",
    idx_dag_actor_runtimes_retention: "wherestatein('dormant','retired')andpinned=0",
    idx_dag_actor_provisioned_workers_current: "wherestatusin('active','releasing')",
  };
  for (const [name, predicate] of Object.entries(indexPredicates)) {
    if (!compactSchemaSql(db, "index", name).includes(predicate)) {
      throw new Error(`Schema migration 24 is incomplete: index ${name} predicate is invalid`);
    }
  }

  for (const table of Object.keys(expectedTables)) {
    const foreignKeys = (db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string;
      on_update: string;
      on_delete: string;
    }>).sort((left, right) => left.seq - right.seq);
    if (
      foreignKeys.length !== 2
      || foreignKeys[0].id !== foreignKeys[1].id
      || foreignKeys[0].table !== "dag_actors"
      || foreignKeys[1].table !== "dag_actors"
      || foreignKeys[0].from !== "run_id"
      || foreignKeys[0].to !== "run_id"
      || foreignKeys[1].from !== "actor_id"
      || foreignKeys[1].to !== "actor_id"
      || foreignKeys.some((entry) => entry.on_update.toUpperCase() !== "RESTRICT")
      || foreignKeys.some((entry) => entry.on_delete.toUpperCase() !== "CASCADE")
    ) {
      throw new Error(`Schema migration 24 is incomplete: ${table} actor ownership constraint is invalid`);
    }
  }

  const checkpointTrigger = compactSchemaSql(db, "trigger", "trg_dag_actor_checkpoints_no_update");
  if (!checkpointTrigger.includes("beforeupdateondag_actor_checkpoints") || !checkpointTrigger.includes("raise(abort,'dagactorcheckpointsareappend-only')")) {
    throw new Error("Schema migration 24 is incomplete: checkpoint append-only trigger is missing or invalid");
  }
}

function validateDagLiveSurfaceSchemaV21(db: SqliteDatabase): void {
  const requiredColumns: Record<string, readonly string[]> = {
    dag_surface_projections: [
      "run_id",
      "actor_id",
      "node_id",
      "surface_id",
      "document_id",
      "generation",
      "last_activity_sequence",
      "journal_cursor",
      "surface_revision",
      "activity_state",
      "visibility_state",
      "last_event_id",
      "focused_until",
      "created_at",
      "updated_at",
    ],
    dag_surface_projection_queue: [
      "journal_seq",
      "event_id",
      "run_id",
      "actor_id",
      "node_id",
      "surface_id",
      "generation",
      "activity_sequence",
      "status",
      "transaction_id",
      "surface_revision",
      "queued_at",
      "applied_at",
      "failure_json",
    ],
    dag_surface_projection_controls: [
      "control_id",
      "run_id",
      "actor_id",
      "node_id",
      "surface_id",
      "operation",
      "expected_surface_revision",
      "committed_surface_revision",
      "focused_until",
      "transaction_id",
      "input_digest",
      "created_at",
    ],
  };
  for (const [table, columns] of Object.entries(requiredColumns)) {
    if (!hasTable(db, table)) {
      throw new Error(`Schema migration 21 is incomplete: missing table ${table}`);
    }
    for (const column of columns) {
      if (!hasColumn(db, table, column)) {
        throw new Error(`Schema migration 21 is incomplete: ${table} is missing column ${column}`);
      }
    }
  }

  type IndexEntry = { name: string; unique: number; partial: number };
  const indexColumns = (name: string): string[] => (
    db.prepare(`PRAGMA index_info(${name})`).all() as Array<{ seqno: number; name: string }>
  ).sort((left, right) => left.seqno - right.seqno).map((entry) => entry.name);
  const columnsMatch = (actual: readonly string[], expected: readonly string[]): boolean => (
    actual.length === expected.length && actual.every((column, position) => column === expected[position])
  );
  const requirePrimaryKey = (table: string, expectedColumns: readonly string[]): void => {
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
      pk: number;
    }>).filter((entry) => entry.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((entry) => entry.name);
    if (!columnsMatch(columns, expectedColumns)) {
      throw new Error(`Schema migration 21 is incomplete: ${table} has an invalid primary key`);
    }
  };
  const requireNamedIndex = (
    table: string,
    name: string,
    expectedColumns: readonly string[],
    unique: number,
    partial: number,
  ): void => {
    const index = (db.prepare(`PRAGMA index_list(${table})`).all() as IndexEntry[])
      .find((entry) => entry.name === name);
    if (!index || index.unique !== unique || index.partial !== partial) {
      throw new Error(`Schema migration 21 is incomplete: index ${name} is missing or invalid`);
    }
    if (!columnsMatch(indexColumns(name), expectedColumns)) {
      throw new Error(`Schema migration 21 is incomplete: index ${name} has invalid columns`);
    }
  };
  const requireUniqueConstraint = (table: string, expectedColumns: readonly string[]): void => {
    const indexes = db.prepare(`PRAGMA index_list(${table})`).all() as IndexEntry[];
    const found = indexes.some((index) => (
      index.unique === 1
      && index.partial === 0
      && columnsMatch(indexColumns(index.name), expectedColumns)
    ));
    if (!found) {
      throw new Error(
        `Schema migration 21 is incomplete: ${table} is missing unique constraint (${expectedColumns.join(", ")})`,
      );
    }
  };
  requireNamedIndex(
    "dag_actors",
    "idx_dag_actors_projection_identity",
    ["run_id", "actor_id", "node_id", "surface_id"],
    1,
    0,
  );
  requirePrimaryKey("dag_surface_projections", ["run_id", "actor_id"]);
  requireUniqueConstraint("dag_surface_projections", ["document_id", "surface_id"]);
  requirePrimaryKey("dag_surface_projection_queue", ["journal_seq"]);
  requireUniqueConstraint("dag_surface_projection_queue", ["event_id"]);
  requireUniqueConstraint(
    "dag_surface_projection_queue",
    ["run_id", "actor_id", "generation", "activity_sequence"],
  );
  requireNamedIndex(
    "dag_surface_projection_queue",
    "idx_dag_surface_projection_queue_actor_status",
    ["run_id", "actor_id", "status", "generation", "activity_sequence"],
    0,
    0,
  );
  requireNamedIndex(
    "dag_surface_projection_queue",
    "idx_dag_surface_projection_queue_transaction_id",
    ["transaction_id"],
    1,
    1,
  );
  const transactionIndexSql = (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
  ).get("idx_dag_surface_projection_queue_transaction_id") as { sql: string | null } | undefined)?.sql
    ?.replace(/\s+/g, " ").trim().toLowerCase();
  if (!transactionIndexSql || !/\bwhere transaction_id is not null;?$/.test(transactionIndexSql)) {
    throw new Error(
      "Schema migration 21 is incomplete: index idx_dag_surface_projection_queue_transaction_id has an invalid predicate",
    );
  }
  requirePrimaryKey("dag_surface_projection_controls", ["control_id"]);
  requireUniqueConstraint("dag_surface_projection_controls", ["transaction_id"]);
  requireUniqueConstraint(
    "dag_surface_projection_controls",
    ["run_id", "actor_id", "committed_surface_revision"],
  );
  requireNamedIndex(
    "dag_surface_projection_controls",
    "idx_dag_surface_projection_controls_actor_created",
    ["run_id", "actor_id", "created_at", "control_id"],
    0,
    0,
  );

  type ForeignKeyEntry = {
    id: number;
    seq: number;
    table: string;
    from: string;
    to: string;
    on_delete: string;
  };
  const hasForeignKey = (
    table: string,
    referencedTable: string,
    fromColumns: readonly string[],
    toColumns: readonly string[],
    onDelete: "CASCADE" | "RESTRICT",
  ): boolean => {
    const entries = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as ForeignKeyEntry[];
    const groups = new Map<number, ForeignKeyEntry[]>();
    for (const entry of entries) {
      const group = groups.get(entry.id) ?? [];
      group.push(entry);
      groups.set(entry.id, group);
    }
    return [...groups.values()].some((group) => {
      const ordered = group.sort((left, right) => left.seq - right.seq);
      return ordered.length === fromColumns.length
        && ordered.every((entry, position) => (
          entry.table === referencedTable
          && entry.from === fromColumns[position]
          && entry.to === toColumns[position]
          && entry.on_delete.toUpperCase() === onDelete
        ));
    });
  };
  const actorIdentityColumns = ["run_id", "actor_id", "node_id", "surface_id"] as const;
  for (const table of Object.keys(requiredColumns)) {
    if (!hasForeignKey(table, "dag_actors", actorIdentityColumns, actorIdentityColumns, "CASCADE")) {
      throw new Error(`Schema migration 21 is incomplete: ${table} actor identity constraint is missing`);
    }
  }
  if (!hasForeignKey(
    "dag_surface_projections",
    "generative_ui_documents",
    ["document_id"],
    ["document_id"],
    "RESTRICT",
  )) {
    throw new Error("Schema migration 21 is incomplete: projection document retention constraint is missing");
  }
  if (!hasForeignKey(
    "dag_surface_projection_queue",
    "dag_activity_events",
    ["journal_seq"],
    ["seq"],
    "CASCADE",
  )) {
    throw new Error("Schema migration 21 is incomplete: projection queue journal constraint is missing");
  }
}

const DAG_SURFACE_QUEUE_JOURNAL_IDENTITY_TRIGGER_V22 = `
  CREATE TRIGGER trg_dag_surface_projection_queue_journal_identity
    BEFORE INSERT ON dag_surface_projection_queue
    WHEN NOT EXISTS (
      SELECT 1
      FROM dag_activity_events e
      WHERE e.seq = NEW.journal_seq
        AND e.event_id = NEW.event_id
        AND e.run_id = NEW.run_id
        AND e.actor_id = NEW.actor_id
        AND e.node_id = NEW.node_id
        AND e.generation = NEW.generation
        AND e.activity_sequence = NEW.activity_sequence
        AND (e.surface_id IS NULL OR e.surface_id = NEW.surface_id)
    )
    BEGIN
      SELECT RAISE(ABORT, 'projection queue journal identity mismatch');
    END
`;

const DAG_SURFACE_QUEUE_IMMUTABLE_IDENTITY_TRIGGER_V22 = `
  CREATE TRIGGER trg_dag_surface_projection_queue_identity_immutable
    BEFORE UPDATE OF journal_seq, event_id, run_id, actor_id, node_id,
      surface_id, generation, activity_sequence
    ON dag_surface_projection_queue
    BEGIN
      SELECT RAISE(ABORT, 'projection queue identity is immutable');
    END
`;

function normalizedSchemaSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().replace(/;$/, "").toLowerCase();
}

function validateDagLiveSurfaceQueueTriggersV22(db: SqliteDatabase): void {
  const requireTrigger = (name: string, expectedSql: string): void => {
    const trigger = db.prepare(`
      SELECT tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND name = ?
    `).get(name) as { tbl_name: string; sql: string | null } | undefined;
    if (
      !trigger
      || trigger.tbl_name !== "dag_surface_projection_queue"
      || !trigger.sql
      || normalizedSchemaSql(trigger.sql) !== normalizedSchemaSql(expectedSql)
    ) {
      throw new Error(`Schema migration 22 is incomplete: trigger ${name} is missing or invalid`);
    }
  };
  requireTrigger(
    "trg_dag_surface_projection_queue_journal_identity",
    DAG_SURFACE_QUEUE_JOURNAL_IDENTITY_TRIGGER_V22,
  );
  requireTrigger(
    "trg_dag_surface_projection_queue_identity_immutable",
    DAG_SURFACE_QUEUE_IMMUTABLE_IDENTITY_TRIGGER_V22,
  );
}

function validateDagActorInterventionSchemaV26(db: SqliteDatabase): void {
  const requiredColumns: Record<string, readonly string[]> = {
    dag_actor_interventions: [
      "intervention_id", "run_id", "actor_id", "operation", "status", "idempotency_key",
      "payload_digest", "payload_json", "expected_actor_generation", "expected_actor_version",
      "checkpoint_version", "from_generation", "to_generation", "resulting_actor_version",
      "created_at", "started_at", "completed_at", "failure_json",
    ],
    dag_surface_generation_snapshots: [
      "run_id", "actor_id", "generation", "node_id", "surface_id", "document_id",
      "node_revision", "document_revision", "surface_revision", "activity_state",
      "visibility_state", "last_event_id", "node_snapshot_sha256", "node_snapshot_json",
      "superseded_by_generation", "intervention_id", "created_at",
    ],
  };
  for (const [table, names] of Object.entries(requiredColumns)) {
    if (!hasTable(db, table)) {
      throw new Error(`Schema migration 26 is incomplete: missing table ${table}`);
    }
    const actual = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((row) => row.name));
    const missing = names.filter((name) => !actual.has(name));
    if (missing.length > 0) {
      throw new Error(`Schema migration 26 is incomplete: ${table} is missing ${missing.join(", ")}`);
    }
  }
  const requireIndex = (
    table: string,
    name: string,
    expectedColumns: readonly string[],
    unique: number,
    partial: number,
  ): void => {
    const index = (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{
      name: string;
      unique: number;
      partial: number;
    }>).find((entry) => entry.name === name);
    if (!index || index.unique !== unique || index.partial !== partial) {
      throw new Error(`Schema migration 26 is incomplete: index ${name} is missing or invalid`);
    }
    const columns = (db.prepare(`PRAGMA index_info(${name})`).all() as Array<{ seqno: number; name: string }>)
      .sort((left, right) => left.seqno - right.seqno)
      .map((entry) => entry.name);
    if (columns.length !== expectedColumns.length || columns.some((column, indexPosition) => column !== expectedColumns[indexPosition])) {
      throw new Error(`Schema migration 26 is incomplete: index ${name} has invalid columns`);
    }
  };
  requireIndex(
    "dag_actor_interventions",
    "idx_dag_actor_interventions_idempotency",
    ["run_id", "actor_id", "idempotency_key"],
    1,
    0,
  );
  requireIndex(
    "dag_actor_interventions",
    "idx_dag_actor_interventions_active_actor",
    ["run_id", "actor_id"],
    1,
    1,
  );
  requireIndex(
    "dag_actor_interventions",
    "idx_dag_actor_interventions_actor_created",
    ["run_id", "actor_id", "created_at", "intervention_id"],
    0,
    0,
  );
  requireIndex(
    "dag_surface_generation_snapshots",
    "idx_dag_surface_generation_snapshots_actor_created",
    ["run_id", "actor_id", "created_at", "generation"],
    0,
    0,
  );
  const activeSql = normalizedSchemaSql((db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_dag_actor_interventions_active_actor'",
  ).get() as { sql?: string } | undefined)?.sql ?? "");
  if (!activeSql.includes("where status in ('queued', 'applying')")) {
    throw new Error("Schema migration 26 is incomplete: active intervention index predicate is invalid");
  }
  const triggerSql = normalizedSchemaSql((db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_dag_surface_generation_snapshots_no_update'",
  ).get() as { sql?: string } | undefined)?.sql ?? "");
  if (!triggerSql.includes("dag surface generation snapshots are append-only")) {
    throw new Error("Schema migration 26 is incomplete: generation snapshot append-only trigger is missing or invalid");
  }
  const foreignKeyTables = new Set(
    (db.prepare("PRAGMA foreign_key_list(dag_surface_generation_snapshots)").all() as Array<{ table: string }>)
      .map((entry) => entry.table),
  );
  if (!foreignKeyTables.has("dag_actors") || !foreignKeyTables.has("dag_actor_interventions")) {
    throw new Error("Schema migration 26 is incomplete: generation snapshot ownership constraints are invalid");
  }
  if (!(db.prepare("PRAGMA foreign_key_list(dag_actor_interventions)").all() as Array<{ table: string }>)
    .some((entry) => entry.table === "dag_actors")) {
    throw new Error("Schema migration 26 is incomplete: intervention actor ownership constraint is invalid");
  }
}

function validateDagActorDispatchExclusionSchemaV27(db: SqliteDatabase): void {
  if (!hasTable(db, "dag_actor_dispatch_exclusions")) {
    throw new Error("Schema migration 27 is incomplete: missing table dag_actor_dispatch_exclusions");
  }
  const requiredColumns = [
    "run_id",
    "actor_id",
    "node_id",
    "target_type",
    "target_id",
    "intervention_id",
    "created_at",
  ];
  const actualColumns = new Set(
    (db.prepare("PRAGMA table_info(dag_actor_dispatch_exclusions)").all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  const missing = requiredColumns.filter((name) => !actualColumns.has(name));
  if (missing.length > 0) {
    throw new Error(`Schema migration 27 is incomplete: dag_actor_dispatch_exclusions is missing ${missing.join(", ")}`);
  }
  const targetIndex = (db.prepare("PRAGMA index_list(dag_actor_dispatch_exclusions)").all() as Array<{
    name: string;
    unique: number;
  }>).find((entry) => entry.name === "idx_dag_actor_dispatch_exclusions_target");
  if (!targetIndex || targetIndex.unique !== 0) {
    throw new Error("Schema migration 27 is incomplete: dispatch exclusion target index is missing or invalid");
  }
  const targetColumns = (db.prepare("PRAGMA index_info(idx_dag_actor_dispatch_exclusions_target)").all() as Array<{
    seqno: number;
    name: string;
  }>).sort((left, right) => left.seqno - right.seqno).map((entry) => entry.name);
  if (targetColumns.join(",") !== "target_type,target_id") {
    throw new Error("Schema migration 27 is incomplete: dispatch exclusion target index has invalid columns");
  }
  const foreignKeyTables = new Set(
    (db.prepare("PRAGMA foreign_key_list(dag_actor_dispatch_exclusions)").all() as Array<{ table: string }>)
      .map((entry) => entry.table),
  );
  if (!foreignKeyTables.has("dag_actors") || !foreignKeyTables.has("dag_actor_interventions")) {
    throw new Error("Schema migration 27 is incomplete: dispatch exclusion ownership constraints are invalid");
  }
}

function validateGenerativeUiSchemaV3(db: SqliteDatabase): void {
  const requiredColumns: Record<string, readonly string[]> = {
    generative_ui_documents: [
      "document_id",
      "purpose",
      "scope_type",
      "scope_id",
      "ir_version",
      "revision",
      "snapshot_json",
      "snapshot_hash",
      "created_at",
      "updated_at",
      "deleted_at",
    ],
    generative_ui_transactions: [
      "seq",
      "document_id",
      "transaction_id",
      "fingerprint",
      "base_revision",
      "committed_revision",
      "transaction_json",
      "producer_created_at",
      "committed_at",
    ],
  };
  for (const [table, required] of Object.entries(requiredColumns)) {
    const tableRow = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table);
    if (!tableRow) throw new Error(`Schema migration 3 is incomplete: missing table ${table}`);
    const columns = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
    );
    const missing = required.filter((column) => !columns.has(column));
    if (missing.length > 0) {
      throw new Error(`Schema migration 3 is incomplete: ${table} is missing columns ${missing.join(", ")}`);
    }
  }

  const documentIndexes = db.prepare("PRAGMA index_list(generative_ui_documents)").all() as Array<{
    name: string;
    unique: number;
    partial: number;
  }>;
  const activeScope = documentIndexes.find((index) => index.name === "idx_generative_ui_documents_active_scope");
  if (!activeScope || activeScope.unique !== 1 || activeScope.partial !== 1) {
    throw new Error("Schema migration 3 is incomplete: active Generative UI scope index is not unique and partial");
  }

  const foreignKeys = db.prepare("PRAGMA foreign_key_list(generative_ui_transactions)").all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  const documentForeignKey = foreignKeys.find((foreignKey) => (
    foreignKey.table === "generative_ui_documents"
    && foreignKey.from === "document_id"
    && foreignKey.to === "document_id"
    && foreignKey.on_delete.toUpperCase() === "RESTRICT"
  ));
  if (!documentForeignKey) {
    throw new Error("Schema migration 3 is incomplete: Generative UI transaction ownership constraint is missing");
  }
}

function validateGenerativeUiSchemaV4(db: SqliteDatabase): void {
  const table = "generative_ui_user_overrides";
  const tableRow = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table);
  if (!tableRow) throw new Error(`Schema migration 4 is incomplete: missing table ${table}`);
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>;
  const byName = new Map(columns.map((column) => [column.name, column]));
  const required = ["document_id", "node_id", "visibility", "pinned", "preferred_surface", "updated_at"];
  const missing = required.filter((column) => !byName.has(column));
  if (missing.length) {
    throw new Error(`Schema migration 4 is incomplete: ${table} is missing columns ${missing.join(", ")}`);
  }
  if (byName.get("document_id")?.pk !== 1 || byName.get("node_id")?.pk !== 2) {
    throw new Error("Schema migration 4 is incomplete: Generative UI override identity constraint is missing");
  }
  const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  const documentForeignKey = foreignKeys.find((foreignKey) => (
    foreignKey.table === "generative_ui_documents"
    && foreignKey.from === "document_id"
    && foreignKey.to === "document_id"
    && foreignKey.on_delete.toUpperCase() === "RESTRICT"
  ));
  if (!documentForeignKey) {
    throw new Error("Schema migration 4 is incomplete: Generative UI override ownership constraint is missing");
  }
}

function validatePluginRegistrySchemaV5(db: SqliteDatabase): void {
  const requiredColumns: Record<string, readonly string[]> = {
    plugin_packages: [
      "plugin_id",
      "plugin_version",
      "manifest_version",
      "package_digest",
      "manifest_json",
      "resolved_descriptor_json",
      "source",
      "installed_at",
    ],
    plugin_activations: [
      "plugin_id",
      "active_version",
      "enabled",
      "locked",
      "revision",
      "updated_at",
    ],
  };
  for (const [table, required] of Object.entries(requiredColumns)) {
    const tableRow = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table) as { sql: string } | undefined;
    if (!tableRow) throw new Error(`Schema migration 5 is incomplete: missing table ${table}`);
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
      pk: number;
    }>;
    const byName = new Map(columns.map((column) => [column.name, column]));
    const missing = required.filter((column) => !byName.has(column));
    if (missing.length) {
      throw new Error(`Schema migration 5 is incomplete: ${table} is missing columns ${missing.join(", ")}`);
    }
    if (table === "plugin_packages") {
      if (byName.get("plugin_id")?.pk !== 1 || byName.get("plugin_version")?.pk !== 2) {
        throw new Error("Schema migration 5 is incomplete: plugin package identity constraint is missing");
      }
    } else if (byName.get("plugin_id")?.pk !== 1) {
      throw new Error("Schema migration 5 is incomplete: plugin activation identity constraint is missing");
    }
  }

  const foreignKeys = db.prepare("PRAGMA foreign_key_list(plugin_activations)").all() as Array<{
    id: number;
    seq: number;
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  const packageForeignKeys = foreignKeys.filter((foreignKey) => (
    foreignKey.table === "plugin_packages"
    && foreignKey.on_delete.toUpperCase() === "RESTRICT"
  ));
  const grouped = new Map<number, Map<string, string>>();
  for (const foreignKey of packageForeignKeys) {
    const columns = grouped.get(foreignKey.id) ?? new Map<string, string>();
    columns.set(foreignKey.from, foreignKey.to);
    grouped.set(foreignKey.id, columns);
  }
  const packageOwnership = [...grouped.values()].some((columns) => (
    columns.get("plugin_id") === "plugin_id"
    && columns.get("active_version") === "plugin_version"
  ));
  if (!packageOwnership) {
    throw new Error("Schema migration 5 is incomplete: plugin activation package constraint is missing");
  }

  const activationSql = (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'plugin_activations'",
  ).get() as { sql: string }).sql.replace(/\s+/g, " ").toLowerCase();
  if (!activationSql.includes("check(locked = 0 or enabled = 1)")) {
    throw new Error("Schema migration 5 is incomplete: locked plugins are not protected");
  }
}

function validatePluginLifecycleSchemaV6(db: SqliteDatabase): void {
  const requiredColumns: Record<string, readonly string[]> = {
    plugin_installations: [
      "plugin_id", "plugin_version", "archive_digest", "payload_digest", "channel",
      "lifecycle_state", "health_state", "signature_state", "package_path",
      "installed_at", "updated_at", "removed_at",
    ],
    plugin_permission_grants: [
      "plugin_id", "plugin_version", "permission", "grant_json", "status", "revision", "updated_at",
    ],
    plugin_activation_events: [
      "seq", "plugin_id", "event_type", "from_version", "to_version",
      "activation_revision", "created_at", "data_json",
    ],
  };
  for (const [table, required] of Object.entries(requiredColumns)) {
    const tableRow = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table) as { sql: string } | undefined;
    if (!tableRow) throw new Error(`Schema migration 6 is incomplete: missing table ${table}`);
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>;
    const names = new Set(columns.map((column) => column.name));
    const missing = required.filter((column) => !names.has(column));
    if (missing.length) throw new Error(`Schema migration 6 is incomplete: ${table} is missing ${missing.join(", ")}`);
  }
  const installationPk = new Map((db.prepare("PRAGMA table_info(plugin_installations)").all() as Array<{
    name: string; pk: number;
  }>).map((column) => [column.name, column.pk]));
  if (installationPk.get("plugin_id") !== 1 || installationPk.get("plugin_version") !== 2) {
    throw new Error("Schema migration 6 is incomplete: plugin installation identity is not composite");
  }
  const grantPk = new Map((db.prepare("PRAGMA table_info(plugin_permission_grants)").all() as Array<{
    name: string; pk: number;
  }>).map((column) => [column.name, column.pk]));
  if (grantPk.get("plugin_id") !== 1 || grantPk.get("plugin_version") !== 2 || grantPk.get("permission") !== 3) {
    throw new Error("Schema migration 6 is incomplete: plugin grant identity is not composite");
  }
  for (const table of ["plugin_installations", "plugin_permission_grants", "plugin_activation_events"]) {
    const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
      table: string; on_delete: string;
    }>;
    if (!foreignKeys.some((foreignKey) => (
      foreignKey.table === "plugin_packages" && foreignKey.on_delete.toUpperCase() === "RESTRICT"
    ))) throw new Error(`Schema migration 6 is incomplete: ${table} package retention constraint is missing`);
  }
}

function validatePluginRegistryRevisionSchemaV7(db: SqliteDatabase): void {
  const table = "plugin_registry_meta";
  const tableRow = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table) as { sql: string } | undefined;
  if (!tableRow) throw new Error(`Schema migration 7 is incomplete: missing table ${table}`);
  const columns = new Map((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    pk: number;
  }>).map((column) => [column.name, column]));
  if (columns.get("singleton")?.pk !== 1 || !columns.has("revision")) {
    throw new Error("Schema migration 7 is incomplete: plugin registry revision identity is invalid");
  }
  const row = db.prepare(`SELECT singleton, revision FROM ${table}`).get() as {
    singleton: number;
    revision: number;
  } | undefined;
  const count = (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  if (count !== 1 || row?.singleton !== 1 || !Number.isSafeInteger(row.revision) || row.revision < 0) {
    throw new Error("Schema migration 7 is incomplete: plugin registry revision singleton is invalid");
  }
  const requiredTriggers = [
    "plugin_registry_revision_after_activation_insert",
    "plugin_registry_revision_after_activation_update",
    "plugin_registry_revision_after_activation_delete",
  ];
  const triggers = new Set((db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (?, ?, ?)
  `).all(...requiredTriggers) as Array<{ name: string }>).map((entry) => entry.name));
  const missing = requiredTriggers.filter((name) => !triggers.has(name));
  if (missing.length) {
    throw new Error(`Schema migration 7 is incomplete: missing plugin registry triggers ${missing.join(", ")}`);
  }
}

function validatePluginPermissionAuditSchemaV8(db: SqliteDatabase): void {
  const requiredColumns: Record<string, readonly string[]> = {
    plugin_permission_meta: ["singleton", "revision"],
    plugin_permission_events: [
      "seq", "plugin_id", "plugin_version", "permission", "event_type",
      "from_status", "to_status", "grant_revision", "permission_revision",
      "actor_type", "actor_id", "request_digest", "created_at", "data_json",
    ],
  };
  for (const [table, required] of Object.entries(requiredColumns)) {
    const tableRow = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table);
    if (!tableRow) throw new Error(`Schema migration 8 is incomplete: missing table ${table}`);
    const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>).map((column) => column.name));
    const missing = required.filter((column) => !columns.has(column));
    if (missing.length) {
      throw new Error(`Schema migration 8 is incomplete: ${table} is missing ${missing.join(", ")}`);
    }
  }
  const meta = db.prepare("SELECT singleton, revision FROM plugin_permission_meta").get() as {
    singleton: number;
    revision: number;
  } | undefined;
  const metaCount = (db.prepare("SELECT COUNT(*) AS count FROM plugin_permission_meta").get() as {
    count: number;
  }).count;
  if (metaCount !== 1 || meta?.singleton !== 1 || !Number.isSafeInteger(meta.revision) || meta.revision < 0) {
    throw new Error("Schema migration 8 is incomplete: plugin permission revision singleton is invalid");
  }
  const requiredTriggers = [
    "plugin_permission_revision_after_grant_insert",
    "plugin_permission_revision_after_grant_update",
    "plugin_permission_revision_after_grant_delete",
  ];
  const triggers = new Set((db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (?, ?, ?)
  `).all(...requiredTriggers) as Array<{ name: string }>).map((entry) => entry.name));
  const missingTriggers = requiredTriggers.filter((name) => !triggers.has(name));
  if (missingTriggers.length) {
    throw new Error(`Schema migration 8 is incomplete: missing plugin permission triggers ${missingTriggers.join(", ")}`);
  }
  const foreignKeys = db.prepare("PRAGMA foreign_key_list(plugin_permission_events)").all() as Array<{
    id: number;
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  const packageKeys = foreignKeys.filter((entry) => (
    entry.table === "plugin_packages" && entry.on_delete.toUpperCase() === "RESTRICT"
  ));
  const grouped = new Map<number, Map<string, string>>();
  for (const entry of packageKeys) {
    const columns = grouped.get(entry.id) ?? new Map<string, string>();
    columns.set(entry.from, entry.to);
    grouped.set(entry.id, columns);
  }
  if (![...grouped.values()].some((columns) => (
    columns.get("plugin_id") === "plugin_id" && columns.get("plugin_version") === "plugin_version"
  ))) {
    throw new Error("Schema migration 8 is incomplete: plugin permission audit retention constraint is missing");
  }
}

function validatePluginActionBusSchemaV9(db: SqliteDatabase): void {
  const requiredColumns: Record<string, readonly string[]> = {
    plugin_action_requests: [
      "request_id", "idempotency_key", "request_digest", "plugin_id", "plugin_version",
      "document_id", "document_revision", "node_id", "node_revision", "action_id",
      "action_intent", "status", "policy_digest", "permission_revision",
      "invocation_json", "result_json", "error_code", "error_message", "created_at", "updated_at",
    ],
    plugin_confirmation_challenges: [
      "challenge_id", "request_id", "request_digest", "status", "challenge_json",
      "decision_json", "expires_at", "created_at", "decided_at", "consumed_at",
    ],
    plugin_capability_nonces: [
      "nonce", "capability_id", "request_id", "request_digest", "token_digest",
      "expires_at", "created_at", "consumed_at",
    ],
    plugin_action_events: [
      "seq", "request_id", "request_digest", "event_type", "created_at", "data_json",
    ],
  };
  for (const [table, required] of Object.entries(requiredColumns)) {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    if (!exists) throw new Error(`Schema migration 9 is incomplete: missing table ${table}`);
    const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>).map((column) => column.name));
    const missing = required.filter((column) => !columns.has(column));
    if (missing.length) throw new Error(`Schema migration 9 is incomplete: ${table} is missing ${missing.join(", ")}`);
  }
  const actionIndexes = db.prepare("PRAGMA index_list(plugin_action_requests)").all() as Array<{
    name: string;
    unique: number;
  }>;
  if (!actionIndexes.some((index) => index.name === "idx_plugin_action_requests_idempotency" && index.unique === 1)) {
    throw new Error("Schema migration 9 is incomplete: Action idempotency identity is not unique");
  }
  for (const table of ["plugin_action_requests", "plugin_confirmation_challenges", "plugin_capability_nonces", "plugin_action_events"]) {
    const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
      table: string;
      on_delete: string;
    }>;
    if (table === "plugin_action_requests") {
      if (!foreignKeys.some((entry) => (
        entry.table === "plugin_packages" && entry.on_delete.toUpperCase() === "RESTRICT"
      ))) throw new Error("Schema migration 9 is incomplete: Action package retention constraint is missing");
    } else if (!foreignKeys.some((entry) => (
      entry.table === "plugin_action_requests" && entry.on_delete.toUpperCase() === "RESTRICT"
    ))) {
      throw new Error(`Schema migration 9 is incomplete: ${table} Action retention constraint is missing`);
    }
  }
}

function validatePluginToolBusSchemaV10(db: SqliteDatabase): void {
  const requiredColumns: Record<string, readonly string[]> = {
    plugin_tool_requests: [
      "request_id", "idempotency_key", "request_digest", "plugin_id", "plugin_version",
      "source_type", "document_id", "document_revision", "node_id", "node_revision",
      "action_id", "action_intent", "tool_id", "tool_wire_id", "status", "policy_digest",
      "permission_revision", "invocation_json", "result_json", "error_code", "error_message",
      "created_at", "updated_at",
    ],
    plugin_tool_confirmation_challenges: [
      "challenge_id", "request_id", "request_digest", "status", "challenge_json",
      "decision_json", "expires_at", "created_at", "decided_at", "consumed_at",
    ],
    plugin_tool_capability_nonces: [
      "nonce", "capability_id", "request_id", "request_digest", "token_digest",
      "expires_at", "created_at", "consumed_at",
    ],
    plugin_tool_events: [
      "seq", "request_id", "request_digest", "event_type", "created_at", "data_json",
    ],
  };
  for (const [table, required] of Object.entries(requiredColumns)) {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    if (!exists) throw new Error(`Schema migration 10 is incomplete: missing table ${table}`);
    const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>).map((column) => column.name));
    const missing = required.filter((column) => !columns.has(column));
    if (missing.length) throw new Error(`Schema migration 10 is incomplete: ${table} is missing ${missing.join(", ")}`);
  }
  const indexes = db.prepare("PRAGMA index_list(plugin_tool_requests)").all() as Array<{
    name: string;
    unique: number;
  }>;
  if (!indexes.some((index) => index.name === "idx_plugin_tool_requests_idempotency" && index.unique === 1)) {
    throw new Error("Schema migration 10 is incomplete: Tool idempotency identity is not unique");
  }
  for (const table of [
    "plugin_tool_requests",
    "plugin_tool_confirmation_challenges",
    "plugin_tool_capability_nonces",
    "plugin_tool_events",
  ]) {
    const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
      table: string;
      on_delete: string;
    }>;
    if (table === "plugin_tool_requests") {
      if (!foreignKeys.some((entry) => (
        entry.table === "plugin_packages" && entry.on_delete.toUpperCase() === "RESTRICT"
      ))) throw new Error("Schema migration 10 is incomplete: Tool package retention constraint is missing");
    } else if (!foreignKeys.some((entry) => (
      entry.table === "plugin_tool_requests" && entry.on_delete.toUpperCase() === "RESTRICT"
    ))) {
      throw new Error(`Schema migration 10 is incomplete: ${table} Tool retention constraint is missing`);
    }
  }
}

function validatePluginPublisherTrustSchemaV11(db: SqliteDatabase): void {
  const requiredColumns: Record<string, readonly string[]> = {
    plugin_distribution_meta: ["singleton", "revision"],
    plugin_publisher_trust: [
      "key_id", "publisher", "public_key_spki", "state", "revision",
      "reason", "created_at", "updated_at",
    ],
    plugin_publisher_trust_events: [
      "seq", "key_id", "publisher", "from_state", "to_state",
      "trust_revision", "distribution_revision", "actor", "reason", "created_at", "data_json",
    ],
  };
  for (const [table, required] of Object.entries(requiredColumns)) {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    if (!exists) throw new Error(`Schema migration 11 is incomplete: missing table ${table}`);
    const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>).map((column) => column.name));
    const missing = required.filter((column) => !columns.has(column));
    if (missing.length) throw new Error(`Schema migration 11 is incomplete: ${table} is missing ${missing.join(", ")}`);
  }
  const meta = db.prepare("SELECT singleton, revision FROM plugin_distribution_meta").get() as {
    singleton: number;
    revision: number;
  } | undefined;
  const count = (db.prepare("SELECT COUNT(*) AS count FROM plugin_distribution_meta").get() as {
    count: number;
  }).count;
  if (count !== 1 || meta?.singleton !== 1 || !Number.isSafeInteger(meta.revision) || meta.revision < 0) {
    throw new Error("Schema migration 11 is incomplete: plugin distribution revision singleton is invalid");
  }
  const trustPk = new Map((db.prepare("PRAGMA table_info(plugin_publisher_trust)").all() as Array<{
    name: string;
    pk: number;
  }>).map((column) => [column.name, column.pk]));
  if (trustPk.get("key_id") !== 1) {
    throw new Error("Schema migration 11 is incomplete: publisher trust key identity is invalid");
  }
  const triggers = new Set((db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (
      'plugin_distribution_revision_after_trust_insert',
      'plugin_distribution_revision_after_trust_update'
    )
  `).all() as Array<{ name: string }>).map((entry) => entry.name));
  if (triggers.size !== 2) {
    throw new Error("Schema migration 11 is incomplete: publisher trust revision triggers are missing");
  }
  const eventForeignKeys = db.prepare("PRAGMA foreign_key_list(plugin_publisher_trust_events)").all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (!eventForeignKeys.some((entry) => (
    entry.table === "plugin_publisher_trust"
    && entry.from === "key_id"
    && entry.to === "key_id"
    && entry.on_delete.toUpperCase() === "RESTRICT"
  ))) throw new Error("Schema migration 11 is incomplete: publisher trust audit retention constraint is missing");
}

function validatePluginPackageSignatureSchemaV12(db: SqliteDatabase): void {
  const table = "plugin_package_signatures";
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!exists) throw new Error(`Schema migration 12 is incomplete: missing table ${table}`);
  const columns = new Map((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    pk: number;
  }>).map((column) => [column.name, column]));
  for (const column of [
    "plugin_id", "plugin_version", "key_id", "publisher", "public_key_spki",
    "payload_digest", "created_at",
  ]) {
    if (!columns.has(column)) throw new Error(`Schema migration 12 is incomplete: ${table} is missing ${column}`);
  }
  if (columns.get("plugin_id")?.pk !== 1 || columns.get("plugin_version")?.pk !== 2) {
    throw new Error("Schema migration 12 is incomplete: package signature identity is invalid");
  }
  const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
    id: number;
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  const packageKeys = foreignKeys.filter((entry) => (
    entry.table === "plugin_packages" && entry.on_delete.toUpperCase() === "RESTRICT"
  ));
  const grouped = new Map<number, Map<string, string>>();
  for (const entry of packageKeys) {
    const values = grouped.get(entry.id) ?? new Map<string, string>();
    values.set(entry.from, entry.to);
    grouped.set(entry.id, values);
  }
  if (![...grouped.values()].some((values) => (
    values.get("plugin_id") === "plugin_id" && values.get("plugin_version") === "plugin_version"
  ))) throw new Error("Schema migration 12 is incomplete: package signature retention constraint is missing");
}

function validatePluginRemoteRegistrySchemaV13(db: SqliteDatabase): void {
  const requiredColumns: Record<string, readonly string[]> = {
    plugin_registry_sources: [
      "registry_id", "source_url", "root_key_id", "last_sequence", "last_index_digest",
      "last_issued_at", "last_expires_at", "last_synced_at", "created_at", "updated_at",
    ],
    plugin_registry_releases: [
      "registry_id", "plugin_id", "plugin_version", "archive_path", "archive_digest",
      "payload_digest", "publisher_key_id", "index_sequence", "created_at",
    ],
    plugin_registry_update_attempts: [
      "seq", "attempt_id", "registry_id", "operation", "status", "plugin_id",
      "from_version", "to_version", "index_sequence", "index_digest",
      "rollback_version", "error", "created_at", "completed_at", "data_json",
    ],
  };
  for (const [table, required] of Object.entries(requiredColumns)) {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    if (!exists) throw new Error(`Schema migration 13 is incomplete: missing table ${table}`);
    const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>).map((column) => column.name));
    const missing = required.filter((column) => !columns.has(column));
    if (missing.length) throw new Error(`Schema migration 13 is incomplete: ${table} is missing ${missing.join(", ")}`);
  }
  const sourcePk = new Map((db.prepare("PRAGMA table_info(plugin_registry_sources)").all() as Array<{
    name: string;
    pk: number;
  }>).map((column) => [column.name, column.pk]));
  if (sourcePk.get("registry_id") !== 1) {
    throw new Error("Schema migration 13 is incomplete: registry source identity is invalid");
  }
  const releasePk = new Map((db.prepare("PRAGMA table_info(plugin_registry_releases)").all() as Array<{
    name: string;
    pk: number;
  }>).map((column) => [column.name, column.pk]));
  if (
    releasePk.get("registry_id") !== 1
    || releasePk.get("plugin_id") !== 2
    || releasePk.get("plugin_version") !== 3
  ) throw new Error("Schema migration 13 is incomplete: registry release identity is invalid");
  for (const table of ["plugin_registry_releases", "plugin_registry_update_attempts"]) {
    const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
      table: string;
      on_delete: string;
    }>;
    if (!foreignKeys.some((entry) => (
      entry.table === "plugin_registry_sources" && entry.on_delete.toUpperCase() === "RESTRICT"
    ))) throw new Error(`Schema migration 13 is incomplete: ${table} audit retention constraint is missing`);
  }
}

function validatePluginAgentToolContinuationSchemaV14(db: SqliteDatabase): void {
  const table = "plugin_agent_tool_continuations";
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!exists) throw new Error(`Schema migration 14 is incomplete: missing table ${table}`);
  const columns = new Map((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    pk: number;
  }>).map((column) => [column.name, column]));
  for (const column of [
    "request_id", "scope_type", "scope_id", "call_id", "status", "payload_json",
    "lease_id", "lease_expires_at", "delivery_attempts", "created_at", "delivered_at",
  ]) {
    if (!columns.has(column)) throw new Error(`Schema migration 14 is incomplete: ${table} is missing ${column}`);
  }
  if (columns.get("request_id")?.pk !== 1) {
    throw new Error("Schema migration 14 is incomplete: Agent Tool continuation identity is invalid");
  }
  const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (!foreignKeys.some((entry) => (
    entry.table === "plugin_tool_requests"
    && entry.from === "request_id"
    && entry.to === "request_id"
    && entry.on_delete.toUpperCase() === "RESTRICT"
  ))) throw new Error("Schema migration 14 is incomplete: Agent Tool continuation retention constraint is missing");
}

const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 3,
    up: (db) => db.exec(`
      CREATE TABLE generative_ui_documents (
        document_id TEXT PRIMARY KEY,
        purpose TEXT NOT NULL CHECK(purpose IN ('canonical', 'legacy_widget_shadow')),
        scope_type TEXT NOT NULL CHECK(scope_type IN ('voice_session', 'project', 'run')),
        scope_id TEXT NOT NULL,
        ir_version INTEGER NOT NULL CHECK(ir_version = 1),
        revision INTEGER NOT NULL CHECK(revision >= 0),
        snapshot_json TEXT NOT NULL,
        snapshot_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE INDEX idx_generative_ui_documents_scope
        ON generative_ui_documents(scope_type, scope_id, deleted_at, updated_at);
      CREATE UNIQUE INDEX idx_generative_ui_documents_active_scope
        ON generative_ui_documents(scope_type, scope_id, purpose)
        WHERE deleted_at IS NULL;

      CREATE TABLE generative_ui_transactions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id TEXT NOT NULL,
        transaction_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        base_revision INTEGER NOT NULL CHECK(base_revision >= 0),
        committed_revision INTEGER NOT NULL CHECK(committed_revision >= 1),
        transaction_json TEXT NOT NULL,
        producer_created_at TEXT NOT NULL,
        committed_at TEXT NOT NULL,
        CHECK(committed_revision = base_revision + 1),
        UNIQUE(document_id, transaction_id),
        UNIQUE(document_id, committed_revision),
        FOREIGN KEY(document_id) REFERENCES generative_ui_documents(document_id) ON DELETE RESTRICT
      );
      CREATE INDEX idx_generative_ui_transactions_document_seq
        ON generative_ui_transactions(document_id, seq);
    `),
    validate: validateGenerativeUiSchemaV3,
  },
  {
    version: 4,
    up: (db) => db.exec(`
      CREATE TABLE generative_ui_user_overrides (
        document_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        visibility TEXT CHECK(visibility IN ('visible', 'minimized', 'hidden')),
        pinned INTEGER CHECK(pinned IN (0, 1)),
        preferred_surface TEXT CHECK(preferred_surface IN ('task', 'execution', 'result', 'ambient')),
        updated_at TEXT NOT NULL,
        CHECK(visibility IS NOT NULL OR pinned IS NOT NULL OR preferred_surface IS NOT NULL),
        PRIMARY KEY(document_id, node_id),
        FOREIGN KEY(document_id) REFERENCES generative_ui_documents(document_id) ON DELETE RESTRICT
      );
      CREATE INDEX idx_generative_ui_user_overrides_document
        ON generative_ui_user_overrides(document_id, node_id);
    `),
    validate: validateGenerativeUiSchemaV4,
  },
  {
    version: 5,
    up: (db) => db.exec(`
      CREATE TABLE plugin_packages (
        plugin_id TEXT NOT NULL,
        plugin_version TEXT NOT NULL,
        manifest_version INTEGER NOT NULL CHECK(manifest_version = 1),
        package_digest TEXT NOT NULL CHECK(length(package_digest) = 64),
        manifest_json TEXT NOT NULL,
        resolved_descriptor_json TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('builtin', 'installed', 'development')),
        installed_at TEXT NOT NULL,
        PRIMARY KEY(plugin_id, plugin_version)
      );

      CREATE TABLE plugin_activations (
        plugin_id TEXT PRIMARY KEY,
        active_version TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        locked INTEGER NOT NULL CHECK(locked IN (0, 1)),
        revision INTEGER NOT NULL CHECK(revision >= 1),
        updated_at TEXT NOT NULL,
        CHECK(locked = 0 OR enabled = 1),
        FOREIGN KEY(plugin_id, active_version)
          REFERENCES plugin_packages(plugin_id, plugin_version)
          ON UPDATE RESTRICT ON DELETE RESTRICT
      );
      CREATE INDEX idx_plugin_packages_id_installed
        ON plugin_packages(plugin_id, installed_at, plugin_version);
    `),
    validate: validatePluginRegistrySchemaV5,
  },
  {
    version: 6,
    up: (db) => db.exec(`
      CREATE TABLE plugin_installations (
        plugin_id TEXT NOT NULL,
        plugin_version TEXT NOT NULL,
        archive_digest TEXT NOT NULL CHECK(length(archive_digest) = 64),
        payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64),
        channel TEXT NOT NULL CHECK(channel IN ('staging', 'local', 'registry')),
        lifecycle_state TEXT NOT NULL CHECK(lifecycle_state IN ('staged', 'installed', 'removed', 'failed')),
        health_state TEXT NOT NULL CHECK(health_state IN ('unchecked', 'healthy', 'unhealthy')),
        signature_state TEXT NOT NULL CHECK(signature_state IN ('unsigned', 'verified', 'untrusted', 'revoked')),
        package_path TEXT NOT NULL,
        installed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        removed_at TEXT,
        PRIMARY KEY(plugin_id, plugin_version),
        FOREIGN KEY(plugin_id, plugin_version)
          REFERENCES plugin_packages(plugin_id, plugin_version)
          ON UPDATE RESTRICT ON DELETE RESTRICT
      );
      CREATE INDEX idx_plugin_installations_state
        ON plugin_installations(lifecycle_state, updated_at, plugin_id, plugin_version);

      CREATE TABLE plugin_permission_grants (
        plugin_id TEXT NOT NULL,
        plugin_version TEXT NOT NULL,
        permission TEXT NOT NULL,
        grant_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'granted', 'denied')),
        revision INTEGER NOT NULL CHECK(revision >= 1),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(plugin_id, plugin_version, permission),
        FOREIGN KEY(plugin_id, plugin_version)
          REFERENCES plugin_packages(plugin_id, plugin_version)
          ON UPDATE RESTRICT ON DELETE RESTRICT
      );
      CREATE INDEX idx_plugin_permission_grants_status
        ON plugin_permission_grants(plugin_id, plugin_version, status, permission);

      CREATE TABLE plugin_activation_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        plugin_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK(event_type IN ('install', 'activate', 'enable', 'disable', 'rollback', 'uninstall')),
        from_version TEXT,
        to_version TEXT,
        activation_revision INTEGER NOT NULL CHECK(activation_revision >= 0),
        created_at TEXT NOT NULL,
        data_json TEXT NOT NULL,
        FOREIGN KEY(plugin_id, to_version)
          REFERENCES plugin_packages(plugin_id, plugin_version)
          ON UPDATE RESTRICT ON DELETE RESTRICT
      );
      CREATE INDEX idx_plugin_activation_events_plugin
        ON plugin_activation_events(plugin_id, seq);
    `),
    validate: validatePluginLifecycleSchemaV6,
  },
  {
    version: 7,
    up: (db) => db.exec(`
      CREATE TABLE plugin_registry_meta (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        revision INTEGER NOT NULL CHECK(revision >= 0)
      );

      INSERT INTO plugin_registry_meta(singleton, revision)
      SELECT 1, COALESCE(SUM(history.max_revision), 0)
      FROM (
        SELECT plugin_id, MAX(revision) AS max_revision
        FROM (
          SELECT plugin_id, revision FROM plugin_activations
          UNION ALL
          SELECT plugin_id, activation_revision AS revision FROM plugin_activation_events
        ) revisions
        GROUP BY plugin_id
      ) history;

      CREATE TRIGGER plugin_registry_revision_after_activation_insert
      AFTER INSERT ON plugin_activations
      BEGIN
        UPDATE plugin_registry_meta SET revision = revision + 1 WHERE singleton = 1;
      END;

      CREATE TRIGGER plugin_registry_revision_after_activation_update
      AFTER UPDATE OF active_version, enabled, locked, revision ON plugin_activations
      BEGIN
        UPDATE plugin_registry_meta SET revision = revision + 1 WHERE singleton = 1;
      END;

      CREATE TRIGGER plugin_registry_revision_after_activation_delete
      AFTER DELETE ON plugin_activations
      BEGIN
        UPDATE plugin_registry_meta SET revision = revision + 1 WHERE singleton = 1;
      END;
    `),
    validate: validatePluginRegistryRevisionSchemaV7,
  },
  {
    version: 8,
    up: (db) => db.exec(`
      CREATE TABLE plugin_permission_meta (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        revision INTEGER NOT NULL CHECK(revision >= 0)
      );
      INSERT INTO plugin_permission_meta(singleton, revision)
      SELECT 1, COALESCE(SUM(revision), 0) FROM plugin_permission_grants;

      CREATE TRIGGER plugin_permission_revision_after_grant_insert
      AFTER INSERT ON plugin_permission_grants
      BEGIN
        UPDATE plugin_permission_meta SET revision = revision + 1 WHERE singleton = 1;
      END;

      CREATE TRIGGER plugin_permission_revision_after_grant_update
      AFTER UPDATE OF grant_json, status, revision ON plugin_permission_grants
      BEGIN
        UPDATE plugin_permission_meta SET revision = revision + 1 WHERE singleton = 1;
      END;

      CREATE TRIGGER plugin_permission_revision_after_grant_delete
      AFTER DELETE ON plugin_permission_grants
      BEGIN
        UPDATE plugin_permission_meta SET revision = revision + 1 WHERE singleton = 1;
      END;

      CREATE TABLE plugin_permission_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        plugin_id TEXT NOT NULL,
        plugin_version TEXT NOT NULL,
        permission TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK(event_type IN ('declared', 'granted', 'denied', 'reset')),
        from_status TEXT CHECK(from_status IN ('pending', 'granted', 'denied')),
        to_status TEXT NOT NULL CHECK(to_status IN ('pending', 'granted', 'denied')),
        grant_revision INTEGER NOT NULL CHECK(grant_revision >= 1),
        permission_revision INTEGER NOT NULL CHECK(permission_revision >= 1),
        actor_type TEXT NOT NULL CHECK(actor_type IN ('system', 'operator', 'action')),
        actor_id TEXT,
        request_digest TEXT CHECK(request_digest IS NULL OR length(request_digest) = 64),
        created_at TEXT NOT NULL,
        data_json TEXT NOT NULL,
        FOREIGN KEY(plugin_id, plugin_version)
          REFERENCES plugin_packages(plugin_id, plugin_version)
          ON UPDATE RESTRICT ON DELETE RESTRICT
      );
      CREATE INDEX idx_plugin_permission_events_target
        ON plugin_permission_events(plugin_id, plugin_version, seq);
      CREATE INDEX idx_plugin_permission_events_revision
        ON plugin_permission_events(permission_revision, seq);
    `),
    validate: validatePluginPermissionAuditSchemaV8,
  },
  {
    version: 9,
    up: (db) => db.exec(`
      CREATE TABLE plugin_action_requests (
        request_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL,
        request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),
        plugin_id TEXT NOT NULL,
        plugin_version TEXT NOT NULL,
        document_id TEXT NOT NULL,
        document_revision INTEGER NOT NULL CHECK(document_revision >= 0),
        node_id TEXT NOT NULL,
        node_revision INTEGER NOT NULL CHECK(node_revision >= 1),
        action_id TEXT NOT NULL,
        action_intent TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN (
          'needs_grant', 'awaiting_confirmation', 'authorized', 'running',
          'committed', 'denied', 'failed', 'cancelled'
        )),
        policy_digest TEXT NOT NULL CHECK(length(policy_digest) = 64),
        permission_revision INTEGER NOT NULL CHECK(permission_revision >= 0),
        invocation_json TEXT NOT NULL,
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(plugin_id, plugin_version)
          REFERENCES plugin_packages(plugin_id, plugin_version)
          ON UPDATE RESTRICT ON DELETE RESTRICT
      );
      CREATE UNIQUE INDEX idx_plugin_action_requests_idempotency
        ON plugin_action_requests(plugin_id, plugin_version, idempotency_key);
      CREATE INDEX idx_plugin_action_requests_target
        ON plugin_action_requests(document_id, node_id, created_at, request_id);
      CREATE INDEX idx_plugin_action_requests_status
        ON plugin_action_requests(status, updated_at, request_id);

      CREATE TABLE plugin_confirmation_challenges (
        challenge_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),
        status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'denied', 'consumed', 'expired')),
        challenge_json TEXT NOT NULL,
        decision_json TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        consumed_at TEXT,
        FOREIGN KEY(request_id) REFERENCES plugin_action_requests(request_id)
          ON UPDATE RESTRICT ON DELETE RESTRICT
      );
      CREATE INDEX idx_plugin_confirmation_challenges_status
        ON plugin_confirmation_challenges(status, expires_at, challenge_id);

      CREATE TABLE plugin_capability_nonces (
        nonce TEXT PRIMARY KEY,
        capability_id TEXT NOT NULL UNIQUE,
        request_id TEXT NOT NULL UNIQUE,
        request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),
        token_digest TEXT NOT NULL UNIQUE CHECK(length(token_digest) = 64),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        consumed_at TEXT,
        FOREIGN KEY(request_id) REFERENCES plugin_action_requests(request_id)
          ON UPDATE RESTRICT ON DELETE RESTRICT
      );
      CREATE INDEX idx_plugin_capability_nonces_expiry
        ON plugin_capability_nonces(expires_at, consumed_at, nonce);

      CREATE TABLE plugin_action_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL,
        request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),
        event_type TEXT NOT NULL CHECK(event_type IN (
          'requested', 'needs_grant', 'confirmation_issued', 'confirmed',
          'denied', 'authorized', 'running', 'committed', 'failed',
          'cancelled', 'duplicate'
        )),
        created_at TEXT NOT NULL,
        data_json TEXT NOT NULL,
        FOREIGN KEY(request_id) REFERENCES plugin_action_requests(request_id)
          ON UPDATE RESTRICT ON DELETE RESTRICT
      );
      CREATE INDEX idx_plugin_action_events_request
        ON plugin_action_events(request_id, seq);
    `),
    validate: validatePluginActionBusSchemaV9,
  },
  {
    version: 10,
    up: (db) => db.exec(`
      CREATE TABLE plugin_tool_requests (
        request_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL,
        request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),
        plugin_id TEXT NOT NULL,
        plugin_version TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK(source_type IN ('ui_action', 'agent')),
        document_id TEXT NOT NULL,
        document_revision INTEGER NOT NULL CHECK(document_revision >= 0),
        node_id TEXT,
        node_revision INTEGER CHECK(node_revision IS NULL OR node_revision >= 1),
        action_id TEXT,
        action_intent TEXT,
        tool_id TEXT NOT NULL,
        tool_wire_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN (
          'needs_grant', 'awaiting_confirmation', 'authorized', 'running',
          'committed', 'denied', 'failed', 'cancelled'
        )),
        policy_digest TEXT NOT NULL CHECK(length(policy_digest) = 64),
        permission_revision INTEGER NOT NULL CHECK(permission_revision >= 0),
        invocation_json TEXT NOT NULL,
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(
          (source_type = 'ui_action' AND node_id IS NOT NULL AND node_revision IS NOT NULL
            AND action_id IS NOT NULL AND action_intent IS NOT NULL)
          OR
          (source_type = 'agent' AND node_id IS NULL AND node_revision IS NULL
            AND action_id IS NULL AND action_intent IS NULL)
        ),
        FOREIGN KEY(plugin_id, plugin_version)
          REFERENCES plugin_packages(plugin_id, plugin_version)
          ON UPDATE RESTRICT ON DELETE RESTRICT
      );
      CREATE UNIQUE INDEX idx_plugin_tool_requests_idempotency
        ON plugin_tool_requests(plugin_id, plugin_version, idempotency_key);
      CREATE INDEX idx_plugin_tool_requests_target
        ON plugin_tool_requests(document_id, node_id, created_at, request_id);
      CREATE INDEX idx_plugin_tool_requests_status
        ON plugin_tool_requests(status, updated_at, request_id);

      CREATE TABLE plugin_tool_confirmation_challenges (
        challenge_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),
        status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'denied', 'consumed', 'expired')),
        challenge_json TEXT NOT NULL,
        decision_json TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        consumed_at TEXT,
        FOREIGN KEY(request_id) REFERENCES plugin_tool_requests(request_id)
          ON UPDATE RESTRICT ON DELETE RESTRICT
      );
      CREATE INDEX idx_plugin_tool_confirmation_challenges_status
        ON plugin_tool_confirmation_challenges(status, expires_at, challenge_id);

      CREATE TABLE plugin_tool_capability_nonces (
        nonce TEXT PRIMARY KEY,
        capability_id TEXT NOT NULL UNIQUE,
        request_id TEXT NOT NULL UNIQUE,
        request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),
        token_digest TEXT NOT NULL UNIQUE CHECK(length(token_digest) = 64),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        consumed_at TEXT,
        FOREIGN KEY(request_id) REFERENCES plugin_tool_requests(request_id)
          ON UPDATE RESTRICT ON DELETE RESTRICT
      );
      CREATE INDEX idx_plugin_tool_capability_nonces_expiry
        ON plugin_tool_capability_nonces(expires_at, consumed_at, nonce);

      CREATE TABLE plugin_tool_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL,
        request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),
        event_type TEXT NOT NULL CHECK(event_type IN (
          'requested', 'needs_grant', 'confirmation_issued', 'confirmed',
          'denied', 'authorized', 'running', 'committed', 'failed',
          'cancelled', 'duplicate'
        )),
        created_at TEXT NOT NULL,
        data_json TEXT NOT NULL,
        FOREIGN KEY(request_id) REFERENCES plugin_tool_requests(request_id)
          ON UPDATE RESTRICT ON DELETE RESTRICT
      );
      CREATE INDEX idx_plugin_tool_events_request
        ON plugin_tool_events(request_id, seq);
    `),
    validate: validatePluginToolBusSchemaV10,
  },
  {
    version: 11,
    up: (db) => db.exec(`
      CREATE TABLE plugin_distribution_meta (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        revision INTEGER NOT NULL CHECK(revision >= 0)
      );
      INSERT INTO plugin_distribution_meta(singleton, revision) VALUES (1, 0);

      CREATE TABLE plugin_publisher_trust (
        key_id TEXT PRIMARY KEY CHECK(length(key_id) = 71),
        publisher TEXT NOT NULL CHECK(length(publisher) BETWEEN 1 AND 128),
        public_key_spki TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('trusted', 'revoked')),
        revision INTEGER NOT NULL CHECK(revision >= 1),
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_plugin_publisher_trust_state
        ON plugin_publisher_trust(state, publisher, key_id);

      CREATE TRIGGER plugin_distribution_revision_after_trust_insert
      AFTER INSERT ON plugin_publisher_trust
      BEGIN
        UPDATE plugin_distribution_meta SET revision = revision + 1 WHERE singleton = 1;
      END;

      CREATE TRIGGER plugin_distribution_revision_after_trust_update
      AFTER UPDATE OF publisher, public_key_spki, state, revision, reason ON plugin_publisher_trust
      BEGIN
        UPDATE plugin_distribution_meta SET revision = revision + 1 WHERE singleton = 1;
      END;

      CREATE TABLE plugin_publisher_trust_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        key_id TEXT NOT NULL,
        publisher TEXT NOT NULL,
        from_state TEXT CHECK(from_state IN ('trusted', 'revoked')),
        to_state TEXT NOT NULL CHECK(to_state IN ('trusted', 'revoked')),
        trust_revision INTEGER NOT NULL CHECK(trust_revision >= 1),
        distribution_revision INTEGER NOT NULL CHECK(distribution_revision >= 1),
        actor TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL,
        data_json TEXT NOT NULL,
        FOREIGN KEY(key_id) REFERENCES plugin_publisher_trust(key_id)
          ON UPDATE RESTRICT ON DELETE RESTRICT
      );
      CREATE INDEX idx_plugin_publisher_trust_events_key
        ON plugin_publisher_trust_events(key_id, seq);
      CREATE INDEX idx_plugin_publisher_trust_events_revision
        ON plugin_publisher_trust_events(distribution_revision, seq);
    `),
    validate: validatePluginPublisherTrustSchemaV11,
  },
  {
    version: 12,
    up: (db) => db.exec(`
      CREATE TABLE plugin_package_signatures (
        plugin_id TEXT NOT NULL,
        plugin_version TEXT NOT NULL,
        key_id TEXT NOT NULL CHECK(length(key_id) = 71),
        publisher TEXT NOT NULL CHECK(length(publisher) BETWEEN 1 AND 128),
        public_key_spki TEXT NOT NULL,
        payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64),
        created_at TEXT NOT NULL,
        PRIMARY KEY(plugin_id, plugin_version),
        FOREIGN KEY(plugin_id, plugin_version)
          REFERENCES plugin_packages(plugin_id, plugin_version)
          ON UPDATE RESTRICT ON DELETE RESTRICT
      );
      CREATE INDEX idx_plugin_package_signatures_key
        ON plugin_package_signatures(key_id, plugin_id, plugin_version);
    `),
    validate: validatePluginPackageSignatureSchemaV12,
  },
  {
    version: 13,
    up: (db) => db.exec(`
      CREATE TABLE plugin_registry_sources (
        registry_id TEXT PRIMARY KEY,
        source_url TEXT NOT NULL,
        root_key_id TEXT NOT NULL CHECK(length(root_key_id) = 71),
        last_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_sequence >= 0),
        last_index_digest TEXT CHECK(last_index_digest IS NULL OR length(last_index_digest) = 64),
        last_issued_at TEXT,
        last_expires_at TEXT,
        last_synced_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_plugin_registry_sources_updated
        ON plugin_registry_sources(updated_at, registry_id);

      CREATE TABLE plugin_registry_releases (
        registry_id TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        plugin_version TEXT NOT NULL,
        archive_path TEXT NOT NULL,
        archive_digest TEXT NOT NULL CHECK(length(archive_digest) = 64),
        payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64),
        publisher_key_id TEXT NOT NULL CHECK(length(publisher_key_id) = 71),
        index_sequence INTEGER NOT NULL CHECK(index_sequence >= 1),
        created_at TEXT NOT NULL,
        PRIMARY KEY(registry_id, plugin_id, plugin_version),
        UNIQUE(registry_id, archive_path),
        FOREIGN KEY(registry_id) REFERENCES plugin_registry_sources(registry_id)
          ON UPDATE RESTRICT ON DELETE RESTRICT
      );
      CREATE INDEX idx_plugin_registry_releases_plugin
        ON plugin_registry_releases(plugin_id, plugin_version, registry_id);

      CREATE TABLE plugin_registry_update_attempts (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        attempt_id TEXT NOT NULL UNIQUE,
        registry_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK(operation IN (
          'configure', 'sync', 'install', 'update', 'activate', 'rollback'
        )),
        status TEXT NOT NULL CHECK(status IN ('succeeded', 'failed')),
        plugin_id TEXT,
        from_version TEXT,
        to_version TEXT,
        index_sequence INTEGER CHECK(index_sequence IS NULL OR index_sequence >= 1),
        index_digest TEXT CHECK(index_digest IS NULL OR length(index_digest) = 64),
        rollback_version TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        data_json TEXT NOT NULL,
        FOREIGN KEY(registry_id) REFERENCES plugin_registry_sources(registry_id)
          ON UPDATE RESTRICT ON DELETE RESTRICT
      );
      CREATE INDEX idx_plugin_registry_update_attempts_target
        ON plugin_registry_update_attempts(registry_id, plugin_id, seq);
      CREATE INDEX idx_plugin_registry_update_attempts_status
        ON plugin_registry_update_attempts(status, completed_at, seq);
    `),
    validate: validatePluginRemoteRegistrySchemaV13,
  },
  {
    version: 14,
    up: (db) => db.exec(`
      CREATE TABLE plugin_agent_tool_continuations (
        request_id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL CHECK(scope_type IN ('voice_session', 'project', 'run')),
        scope_id TEXT NOT NULL,
        call_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'leased', 'delivered')),
        payload_json TEXT NOT NULL,
        lease_id TEXT,
        lease_expires_at TEXT,
        delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK(delivery_attempts >= 0),
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        CHECK(
          (status = 'pending' AND lease_id IS NULL AND lease_expires_at IS NULL AND delivered_at IS NULL)
          OR (status = 'leased' AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL AND delivered_at IS NULL)
          OR (status = 'delivered' AND lease_id IS NULL AND lease_expires_at IS NULL AND delivered_at IS NOT NULL)
        ),
        FOREIGN KEY(request_id) REFERENCES plugin_tool_requests(request_id)
          ON UPDATE RESTRICT ON DELETE RESTRICT
      );
      CREATE INDEX idx_plugin_agent_tool_continuations_scope
        ON plugin_agent_tool_continuations(scope_type, scope_id, status, created_at, request_id);
      CREATE INDEX idx_plugin_agent_tool_continuations_lease
        ON plugin_agent_tool_continuations(status, lease_expires_at, lease_id);
    `),
    validate: validatePluginAgentToolContinuationSchemaV14,
  },
  {
    version: 15,
    up: (db) => {
      ensureColumn(db, "dag_workflows", "head_revision", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn(db, "dag_workflows", "api_version", "TEXT");
      ensureColumn(db, "dag_workflows", "canonical_hash", "TEXT");
      ensureColumn(db, "dag_workflows", "compiler_version", "TEXT");
    },
    validate: validateDagWorkflowSchemaV15,
  },
  {
    version: 16,
    up: (db) => {
      ensureColumn(db, "dag_approvals", "proposer_actor", "TEXT NOT NULL DEFAULT ''");
      db.prepare(`
        UPDATE dag_approvals
        SET expires_at = 0, decision = NULL, actor = NULL, updated_at = ?
        WHERE status = 'waiting' AND TRIM(COALESCE(proposer_actor, '')) = ''
      `).run(Date.now());
    },
    validate: validateDagApprovalIdentityV16,
  },
  {
    version: 17,
    up: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS dag_run_admissions (
        run_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dag_run_admissions_workflow
        ON dag_run_admissions(workflow_id, created_at);
    `),
    validate: validateDagRunAdmissionSchemaV17,
  },
  {
    version: 18,
    up: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS dag_artifacts (
        run_id TEXT NOT NULL,
        name TEXT NOT NULL,
        artifact_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        upload_token_hash TEXT,
        upload_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY(run_id, name),
        FOREIGN KEY(run_id) REFERENCES dag_runs(run_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_dag_artifacts_run_status
        ON dag_artifacts(run_id, status, name);
    `),
    validate: validateDagArtifactSchemaV18,
  },
  {
    version: 19,
    up: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS dag_activity_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL CHECK(schema_version = 1),
        run_id TEXT NOT NULL,
        round_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK(generation >= 1),
        surface_id TEXT,
        activity_sequence INTEGER NOT NULL CHECK(activity_sequence >= 1),
        activity_type TEXT NOT NULL CHECK(activity_type IN (
          'started', 'progress', 'finding', 'tool_used', 'blocked', 'completed', 'failed'
        )),
        timestamp INTEGER NOT NULL CHECK(timestamp >= 0),
        received_at INTEGER NOT NULL CHECK(received_at >= 0),
        event_digest TEXT NOT NULL CHECK(length(event_digest) = 64),
        event_json TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES dag_runs(run_id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_dag_activity_events_event_id
        ON dag_activity_events(event_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_dag_activity_events_actor_sequence
        ON dag_activity_events(run_id, actor_id, generation, activity_sequence);
      CREATE INDEX IF NOT EXISTS idx_dag_activity_events_run_seq
        ON dag_activity_events(run_id, seq);
      CREATE INDEX IF NOT EXISTS idx_dag_activity_events_run_actor_seq
        ON dag_activity_events(run_id, actor_id, seq);
    `),
    validate: validateDagActivitySchemaV19,
  },
  {
    version: 20,
    up: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS dag_actors (
        run_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        role TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 1 CHECK(generation >= 1),
        attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt >= 1),
        version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
        session_id TEXT,
        model_profile_json TEXT NOT NULL,
        surface_id TEXT NOT NULL,
        workspace_ref TEXT,
        checkpoint_ref TEXT,
        created_at INTEGER NOT NULL CHECK(created_at >= 0),
        updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
        PRIMARY KEY(run_id, actor_id),
        FOREIGN KEY(run_id) REFERENCES dag_runs(run_id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_dag_actors_run_node
        ON dag_actors(run_id, node_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_dag_actors_run_surface
        ON dag_actors(run_id, surface_id);

      CREATE TABLE IF NOT EXISTS dag_actor_commands (
        command_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        round_id TEXT NOT NULL,
        target_generation INTEGER NOT NULL CHECK(target_generation >= 1),
        status TEXT NOT NULL CHECK(status IN ('pending', 'delivered', 'claimed', 'acknowledged', 'failed')),
        idempotency_key TEXT NOT NULL,
        payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64),
        payload_json TEXT NOT NULL,
        claimed_generation INTEGER CHECK(claimed_generation IS NULL OR claimed_generation >= 1),
        created_at INTEGER NOT NULL CHECK(created_at >= 0),
        delivered_at INTEGER CHECK(delivered_at IS NULL OR delivered_at >= created_at),
        claimed_at INTEGER CHECK(claimed_at IS NULL OR claimed_at >= created_at),
        completed_at INTEGER CHECK(completed_at IS NULL OR completed_at >= created_at),
        failure_json TEXT,
        CHECK(
          (status = 'pending' AND delivered_at IS NULL AND claimed_generation IS NULL AND claimed_at IS NULL AND completed_at IS NULL AND failure_json IS NULL)
          OR (status = 'delivered' AND delivered_at IS NOT NULL AND claimed_generation IS NULL AND claimed_at IS NULL AND completed_at IS NULL AND failure_json IS NULL)
          OR (status = 'claimed' AND claimed_generation IS NOT NULL AND claimed_at IS NOT NULL AND completed_at IS NULL AND failure_json IS NULL)
          OR (status = 'acknowledged' AND claimed_generation IS NOT NULL AND claimed_at IS NOT NULL AND completed_at IS NOT NULL AND failure_json IS NULL)
          OR (status = 'failed' AND claimed_generation IS NOT NULL AND claimed_at IS NOT NULL AND completed_at IS NOT NULL AND failure_json IS NOT NULL)
        ),
        FOREIGN KEY(run_id, actor_id) REFERENCES dag_actors(run_id, actor_id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_dag_actor_commands_idempotency
        ON dag_actor_commands(run_id, actor_id, idempotency_key);
      CREATE INDEX IF NOT EXISTS idx_dag_actor_commands_actor_status
        ON dag_actor_commands(run_id, actor_id, status, created_at, command_id);
      CREATE INDEX IF NOT EXISTS idx_dag_actor_commands_round
        ON dag_actor_commands(run_id, round_id, created_at, command_id);
    `),
    validate: validateDagActorSchemaV20,
  },
  {
    version: 21,
    up: (db) => db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_dag_actors_projection_identity
        ON dag_actors(run_id, actor_id, node_id, surface_id);

      CREATE TABLE IF NOT EXISTS dag_surface_projections (
        run_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        surface_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK(generation >= 1),
        last_activity_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_activity_sequence >= 0),
        journal_cursor INTEGER NOT NULL DEFAULT 0 CHECK(journal_cursor >= 0),
        surface_revision INTEGER NOT NULL DEFAULT 0 CHECK(surface_revision >= 0),
        activity_state TEXT NOT NULL CHECK(activity_state IN (
          'started', 'progress', 'finding', 'blocked', 'completed', 'failed'
        )),
        visibility_state TEXT NOT NULL DEFAULT 'visible' CHECK(visibility_state IN (
          'visible', 'focused', 'removed'
        )),
        last_event_id TEXT,
        focused_until INTEGER CHECK(focused_until IS NULL OR focused_until >= 0),
        created_at INTEGER NOT NULL CHECK(created_at >= 0),
        updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
        PRIMARY KEY(run_id, actor_id),
        UNIQUE(document_id, surface_id),
        FOREIGN KEY(run_id, actor_id, node_id, surface_id)
          REFERENCES dag_actors(run_id, actor_id, node_id, surface_id) ON DELETE CASCADE,
        FOREIGN KEY(document_id) REFERENCES generative_ui_documents(document_id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS dag_surface_projection_queue (
        journal_seq INTEGER PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        surface_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK(generation >= 1),
        activity_sequence INTEGER NOT NULL CHECK(activity_sequence >= 1),
        status TEXT NOT NULL CHECK(status IN ('pending', 'applied', 'stale', 'rejected')),
        transaction_id TEXT,
        surface_revision INTEGER CHECK(surface_revision IS NULL OR surface_revision >= 0),
        queued_at INTEGER NOT NULL CHECK(queued_at >= 0),
        applied_at INTEGER CHECK(applied_at IS NULL OR applied_at >= queued_at),
        failure_json TEXT,
        CHECK(
          (status = 'pending' AND applied_at IS NULL AND transaction_id IS NULL AND surface_revision IS NULL AND failure_json IS NULL)
          OR (status = 'applied' AND applied_at IS NOT NULL AND surface_revision IS NOT NULL AND failure_json IS NULL)
          OR (status = 'stale' AND applied_at IS NOT NULL AND transaction_id IS NULL AND surface_revision IS NULL AND failure_json IS NULL)
          OR (status = 'rejected' AND applied_at IS NOT NULL AND transaction_id IS NULL AND surface_revision IS NULL AND failure_json IS NOT NULL)
        ),
        UNIQUE(run_id, actor_id, generation, activity_sequence),
        FOREIGN KEY(journal_seq) REFERENCES dag_activity_events(seq) ON DELETE CASCADE,
        FOREIGN KEY(run_id, actor_id, node_id, surface_id)
          REFERENCES dag_actors(run_id, actor_id, node_id, surface_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_dag_surface_projection_queue_actor_status
        ON dag_surface_projection_queue(run_id, actor_id, status, generation, activity_sequence);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_dag_surface_projection_queue_transaction_id
        ON dag_surface_projection_queue(transaction_id)
        WHERE transaction_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS dag_surface_projection_controls (
        control_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        surface_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK(operation IN ('focused', 'removed')),
        expected_surface_revision INTEGER NOT NULL CHECK(expected_surface_revision >= 0),
        committed_surface_revision INTEGER NOT NULL CHECK(committed_surface_revision >= 1),
        focused_until INTEGER CHECK(focused_until IS NULL OR focused_until >= 0),
        transaction_id TEXT NOT NULL UNIQUE,
        input_digest TEXT NOT NULL CHECK(length(input_digest) = 64),
        created_at INTEGER NOT NULL CHECK(created_at >= 0),
        UNIQUE(run_id, actor_id, committed_surface_revision),
        FOREIGN KEY(run_id, actor_id, node_id, surface_id)
          REFERENCES dag_actors(run_id, actor_id, node_id, surface_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_dag_surface_projection_controls_actor_created
        ON dag_surface_projection_controls(run_id, actor_id, created_at, control_id);
    `),
    validate: validateDagLiveSurfaceSchemaV21,
  },
  {
    version: 22,
    up: (db) => db.exec([
      DAG_SURFACE_QUEUE_JOURNAL_IDENTITY_TRIGGER_V22,
      DAG_SURFACE_QUEUE_IMMUTABLE_IDENTITY_TRIGGER_V22,
    ].map((sql) => `${sql.replace("CREATE TRIGGER", "CREATE TRIGGER IF NOT EXISTS")};`).join("\n")),
    validate: validateDagLiveSurfaceQueueTriggersV22,
  },
  {
    version: 23,
    up: (db) => {
      upgradeDagActorCommandsV23(db);
      db.exec(`
        CREATE TABLE IF NOT EXISTS dag_run_rounds (
          run_id TEXT NOT NULL,
          round_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL CHECK(ordinal >= 1),
          status TEXT NOT NULL CHECK(status IN ('active', 'waiting', 'completed', 'cancelled', 'failed')),
          target_actor_ids_json TEXT NOT NULL,
          await_node_id TEXT,
          opened_at INTEGER NOT NULL CHECK(opened_at >= 0),
          closed_at INTEGER CHECK(closed_at IS NULL OR closed_at >= opened_at),
          expires_at INTEGER CHECK(expires_at IS NULL OR expires_at >= opened_at),
          PRIMARY KEY(run_id, round_id),
          CHECK(
            (status = 'active' AND await_node_id IS NULL AND closed_at IS NULL)
            OR (status = 'waiting' AND await_node_id IS NOT NULL AND closed_at IS NOT NULL)
            OR (status IN ('completed', 'cancelled', 'failed') AND closed_at IS NOT NULL)
          ),
          FOREIGN KEY(run_id) REFERENCES dag_runs(run_id) ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_dag_run_rounds_run_ordinal
          ON dag_run_rounds(run_id, ordinal);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_dag_run_rounds_current
          ON dag_run_rounds(run_id)
          WHERE status IN ('active', 'waiting');
      `);
    },
    validate: validateDagRunRoundSchemaV23,
  },
  {
    version: 24,
    up: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS dag_actor_runtimes (
        run_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('leased', 'dormant', 'retired')),
        lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(lease_generation >= 0),
        target_type TEXT,
        target_id TEXT,
        idle_deadline INTEGER,
        pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0, 1)),
        retained_until INTEGER,
        state_changed_at INTEGER NOT NULL CHECK(state_changed_at >= 0),
        created_at INTEGER NOT NULL CHECK(created_at >= 0),
        updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
        version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
        PRIMARY KEY(run_id, actor_id),
        CHECK(state_changed_at >= created_at AND state_changed_at <= updated_at),
        CHECK(
          (
            state = 'leased'
            AND lease_generation >= 1
            AND target_type IS NOT NULL
            AND length(target_type) BETWEEN 1 AND 64
            AND target_id IS NOT NULL
            AND length(target_id) BETWEEN 1 AND 512
            AND idle_deadline IS NOT NULL
            AND idle_deadline >= state_changed_at
            AND retained_until IS NULL
          )
          OR (
            state IN ('dormant', 'retired')
            AND target_type IS NULL
            AND target_id IS NULL
            AND idle_deadline IS NULL
            AND retained_until IS NOT NULL
            AND retained_until >= updated_at
          )
        ),
        FOREIGN KEY(run_id, actor_id) REFERENCES dag_actors(run_id, actor_id)
          ON UPDATE RESTRICT ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_dag_actor_runtimes_expired
        ON dag_actor_runtimes(idle_deadline, run_id, actor_id)
        WHERE state = 'leased' AND pinned = 0;
      CREATE INDEX IF NOT EXISTS idx_dag_actor_runtimes_retention
        ON dag_actor_runtimes(retained_until, run_id, actor_id)
        WHERE state IN ('dormant', 'retired') AND pinned = 0;

      CREATE TABLE IF NOT EXISTS dag_actor_checkpoints (
        run_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        checkpoint_version INTEGER NOT NULL CHECK(checkpoint_version >= 1),
        schema_version INTEGER NOT NULL CHECK(schema_version = 1),
        actor_generation INTEGER NOT NULL CHECK(actor_generation >= 1),
        round_id TEXT NOT NULL CHECK(length(round_id) BETWEEN 1 AND 256),
        captured_at INTEGER NOT NULL CHECK(captured_at >= 0),
        checkpoint_sha256 TEXT NOT NULL CHECK(
          length(checkpoint_sha256) = 64
          AND checkpoint_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        checkpoint_json TEXT NOT NULL CHECK(length(checkpoint_json) BETWEEN 2 AND 262144),
        created_at INTEGER NOT NULL CHECK(created_at >= 0),
        PRIMARY KEY(run_id, actor_id, checkpoint_version),
        FOREIGN KEY(run_id, actor_id) REFERENCES dag_actors(run_id, actor_id)
          ON UPDATE RESTRICT ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_dag_actor_checkpoints_generation
        ON dag_actor_checkpoints(run_id, actor_id, actor_generation, checkpoint_version);
      CREATE TRIGGER IF NOT EXISTS trg_dag_actor_checkpoints_no_update
      BEFORE UPDATE ON dag_actor_checkpoints
      BEGIN
        SELECT RAISE(ABORT, 'DAG actor checkpoints are append-only');
      END;

      CREATE TABLE IF NOT EXISTS dag_actor_provisioned_workers (
        run_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        lease_generation INTEGER NOT NULL CHECK(lease_generation >= 1),
        worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 256),
        node_id TEXT NOT NULL CHECK(length(node_id) BETWEEN 1 AND 256),
        container_id TEXT NOT NULL CHECK(length(container_id) BETWEEN 1 AND 512),
        docker_node_id TEXT NOT NULL CHECK(length(docker_node_id) BETWEEN 1 AND 256),
        status TEXT NOT NULL CHECK(status IN ('active', 'releasing', 'released', 'failed')),
        registered_at INTEGER NOT NULL CHECK(registered_at >= 0),
        updated_at INTEGER NOT NULL CHECK(updated_at >= registered_at),
        release_requested_at INTEGER CHECK(
          release_requested_at IS NULL OR release_requested_at >= registered_at
        ),
        terminal_at INTEGER CHECK(terminal_at IS NULL OR terminal_at >= registered_at),
        failure_json TEXT CHECK(failure_json IS NULL OR length(failure_json) BETWEEN 2 AND 65536),
        version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
        PRIMARY KEY(run_id, actor_id, lease_generation, worker_id),
        CHECK(
          (status = 'active' AND release_requested_at IS NULL AND terminal_at IS NULL AND failure_json IS NULL)
          OR (status = 'releasing' AND release_requested_at IS NOT NULL AND terminal_at IS NULL AND failure_json IS NULL)
          OR (status = 'released' AND release_requested_at IS NOT NULL AND terminal_at IS NOT NULL AND failure_json IS NULL)
          OR (status = 'failed' AND terminal_at IS NOT NULL AND failure_json IS NOT NULL)
        ),
        FOREIGN KEY(run_id, actor_id) REFERENCES dag_actors(run_id, actor_id)
          ON UPDATE RESTRICT ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_dag_actor_provisioned_workers_container
        ON dag_actor_provisioned_workers(container_id);
      CREATE INDEX IF NOT EXISTS idx_dag_actor_provisioned_workers_restart
        ON dag_actor_provisioned_workers(status, docker_node_id, updated_at, run_id, actor_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_dag_actor_provisioned_workers_current
        ON dag_actor_provisioned_workers(run_id, actor_id, lease_generation)
        WHERE status IN ('active', 'releasing');
    `),
    validate: validateDagActorLeaseSchemaV24,
  },
  {
    version: 25,
    up: (db) => db.exec(`
      CREATE INDEX IF NOT EXISTS idx_dag_activity_events_run_round_actor_generation_type_seq
        ON dag_activity_events(run_id, round_id, actor_id, generation, activity_type, seq);
    `),
    validate: validateDagActivityRoundIndexV25,
  },
  {
    version: 26,
    up: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS dag_actor_interventions (
        intervention_id TEXT PRIMARY KEY CHECK(length(intervention_id) BETWEEN 1 AND 256),
        run_id TEXT NOT NULL CHECK(length(run_id) BETWEEN 1 AND 256),
        actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 256),
        operation TEXT NOT NULL CHECK(operation IN ('interrupt', 'cancel', 'retry', 'reassign', 'checkpoint_fork')),
        status TEXT NOT NULL CHECK(status IN ('queued', 'applying', 'applied', 'failed')),
        idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
        payload_digest TEXT NOT NULL CHECK(
          length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'
        ),
        payload_json TEXT NOT NULL CHECK(length(payload_json) BETWEEN 2 AND 65536),
        expected_actor_generation INTEGER NOT NULL CHECK(expected_actor_generation >= 1),
        expected_actor_version INTEGER NOT NULL CHECK(expected_actor_version >= 1),
        checkpoint_version INTEGER CHECK(checkpoint_version IS NULL OR checkpoint_version >= 1),
        from_generation INTEGER CHECK(from_generation IS NULL OR from_generation >= 1),
        to_generation INTEGER CHECK(to_generation IS NULL OR to_generation >= 1),
        resulting_actor_version INTEGER CHECK(resulting_actor_version IS NULL OR resulting_actor_version >= 1),
        created_at INTEGER NOT NULL CHECK(created_at >= 0),
        started_at INTEGER CHECK(started_at IS NULL OR started_at >= created_at),
        completed_at INTEGER CHECK(completed_at IS NULL OR completed_at >= created_at),
        failure_json TEXT CHECK(failure_json IS NULL OR length(failure_json) BETWEEN 2 AND 65536),
        UNIQUE(intervention_id, run_id, actor_id),
        CHECK(
          (operation = 'checkpoint_fork' AND checkpoint_version IS NOT NULL)
          OR (operation <> 'checkpoint_fork' AND checkpoint_version IS NULL)
        ),
        CHECK(to_generation IS NULL OR (from_generation IS NOT NULL AND to_generation = from_generation + 1)),
        CHECK(
          (status = 'queued' AND started_at IS NULL AND completed_at IS NULL AND failure_json IS NULL
            AND from_generation IS NULL AND to_generation IS NULL AND resulting_actor_version IS NULL)
          OR (status = 'applying' AND started_at IS NOT NULL AND completed_at IS NULL AND failure_json IS NULL
            AND to_generation IS NULL AND resulting_actor_version IS NULL)
          OR (status = 'applied' AND started_at IS NOT NULL AND completed_at IS NOT NULL AND failure_json IS NULL
            AND from_generation IS NOT NULL AND to_generation IS NOT NULL AND resulting_actor_version IS NOT NULL)
          OR (status = 'failed' AND completed_at IS NOT NULL AND failure_json IS NOT NULL
            AND to_generation IS NULL AND resulting_actor_version IS NULL)
        ),
        UNIQUE(run_id, actor_id, idempotency_key),
        FOREIGN KEY(run_id, actor_id) REFERENCES dag_actors(run_id, actor_id)
          ON UPDATE RESTRICT ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_dag_actor_interventions_idempotency
        ON dag_actor_interventions(run_id, actor_id, idempotency_key);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_dag_actor_interventions_active_actor
        ON dag_actor_interventions(run_id, actor_id)
        WHERE status IN ('queued', 'applying');
      CREATE INDEX IF NOT EXISTS idx_dag_actor_interventions_actor_created
        ON dag_actor_interventions(run_id, actor_id, created_at, intervention_id);

      CREATE TABLE IF NOT EXISTS dag_surface_generation_snapshots (
        run_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK(generation >= 1),
        node_id TEXT NOT NULL CHECK(length(node_id) BETWEEN 1 AND 256),
        surface_id TEXT NOT NULL CHECK(length(surface_id) BETWEEN 1 AND 512),
        document_id TEXT NOT NULL CHECK(length(document_id) BETWEEN 1 AND 256),
        node_revision INTEGER NOT NULL CHECK(node_revision >= 1),
        document_revision INTEGER NOT NULL CHECK(document_revision >= 1),
        surface_revision INTEGER NOT NULL CHECK(surface_revision >= 1),
        activity_state TEXT NOT NULL CHECK(activity_state IN ('started', 'progress', 'finding', 'blocked', 'completed', 'failed')),
        visibility_state TEXT NOT NULL CHECK(visibility_state IN ('visible', 'focused', 'removed')),
        last_event_id TEXT CHECK(last_event_id IS NULL OR length(last_event_id) BETWEEN 1 AND 256),
        node_snapshot_sha256 TEXT NOT NULL CHECK(
          length(node_snapshot_sha256) = 64 AND node_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        node_snapshot_json TEXT NOT NULL CHECK(length(node_snapshot_json) BETWEEN 2 AND 262144),
        superseded_by_generation INTEGER NOT NULL CHECK(superseded_by_generation = generation + 1),
        intervention_id TEXT NOT NULL CHECK(length(intervention_id) BETWEEN 1 AND 256),
        created_at INTEGER NOT NULL CHECK(created_at >= 0),
        PRIMARY KEY(run_id, actor_id, generation),
        UNIQUE(intervention_id),
        FOREIGN KEY(run_id, actor_id) REFERENCES dag_actors(run_id, actor_id)
          ON UPDATE RESTRICT ON DELETE CASCADE,
        FOREIGN KEY(intervention_id, run_id, actor_id)
          REFERENCES dag_actor_interventions(intervention_id, run_id, actor_id)
          ON UPDATE RESTRICT ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_dag_surface_generation_snapshots_actor_created
        ON dag_surface_generation_snapshots(run_id, actor_id, created_at, generation);
      CREATE TRIGGER IF NOT EXISTS trg_dag_surface_generation_snapshots_no_update
      BEFORE UPDATE ON dag_surface_generation_snapshots
      BEGIN
        SELECT RAISE(ABORT, 'DAG surface generation snapshots are append-only');
      END;
    `),
    validate: validateDagActorInterventionSchemaV26,
  },
  {
    version: 27,
    up: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS dag_actor_dispatch_exclusions (
        run_id TEXT NOT NULL CHECK(length(run_id) BETWEEN 1 AND 256),
        actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 256),
        node_id TEXT NOT NULL CHECK(length(node_id) BETWEEN 1 AND 256),
        target_type TEXT NOT NULL CHECK(target_type IN ('worker', 'node')),
        target_id TEXT NOT NULL CHECK(length(target_id) BETWEEN 1 AND 256),
        intervention_id TEXT NOT NULL CHECK(length(intervention_id) BETWEEN 1 AND 256),
        created_at INTEGER NOT NULL CHECK(created_at >= 0),
        PRIMARY KEY(run_id, node_id),
        UNIQUE(intervention_id),
        FOREIGN KEY(run_id, actor_id) REFERENCES dag_actors(run_id, actor_id)
          ON UPDATE RESTRICT ON DELETE CASCADE,
        FOREIGN KEY(intervention_id, run_id, actor_id)
          REFERENCES dag_actor_interventions(intervention_id, run_id, actor_id)
          ON UPDATE RESTRICT ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_dag_actor_dispatch_exclusions_target
        ON dag_actor_dispatch_exclusions(target_type, target_id);
    `),
    validate: validateDagActorDispatchExclusionSchemaV27,
  },
];

function initializeSchema(db: SqliteDatabase, filePath: string): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  const collidingMainVersions = legacyMainMigrationVersions(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS llm_settings (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      model_name TEXT NOT NULL,
      endpoint_id TEXT,
      endpoint_name TEXT,
      display_name TEXT,
      plan_type TEXT,
      protocol TEXT,
      auth_type TEXT,
      key_hint TEXT,
      base_url TEXT,
      chat_completions_base_url TEXT,
      responses_base_url TEXT,
      anthropic_base_url TEXT,
      resource_id TEXT,
      voice_adapter TEXT,
      tts_http_url TEXT,
      tts_realtime_url TEXT,
      tts_bidirectional_url TEXT,
      asr_realtime_url TEXT,
      asr_async_url TEXT,
      tts_voice TEXT,
      tts_format TEXT,
      tts_sample_rate INTEGER,
      models TEXT,
      supports_llm INTEGER,
      supports_asr INTEGER,
      supports_tts INTEGER,
      supports_audio_input INTEGER,
      supports_image_input INTEGER,
      supports_video_input INTEGER,
      is_active INTEGER,
      is_default INTEGER,
      created_at TEXT,
      api_key_encrypted TEXT,
      secret_storage TEXT,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_llm_settings_provider ON llm_settings(provider_id);

    CREATE TABLE IF NOT EXISTS llm_custom_providers (
      id TEXT PRIMARY KEY,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS llm_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      source TEXT NOT NULL DEFAULT 'custom',
      readonly INTEGER NOT NULL DEFAULT 0,
      default_model TEXT,
      base_url TEXT,
      chat_completions_base_url TEXT,
      responses_base_url TEXT,
      anthropic_base_url TEXT,
      docs_url TEXT,
      supports_llm INTEGER NOT NULL DEFAULT 1,
      supports_asr INTEGER NOT NULL DEFAULT 0,
      supports_tts INTEGER NOT NULL DEFAULT 0,
      supports_audio_input INTEGER NOT NULL DEFAULT 0,
      supports_image_input INTEGER NOT NULL DEFAULT 0,
      supports_video_input INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_llm_providers_source ON llm_providers(source);

    CREATE TABLE IF NOT EXISTS llm_provider_endpoints (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      name TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'custom',
      readonly INTEGER NOT NULL DEFAULT 0,
      plan_type TEXT NOT NULL,
      protocol TEXT NOT NULL,
      auth_type TEXT,
      base_url TEXT NOT NULL,
      chat_completions_base_url TEXT,
      responses_base_url TEXT,
      anthropic_base_url TEXT,
      default_model TEXT,
      resource_id TEXT,
      voice_adapter TEXT,
      tts_http_url TEXT,
      tts_realtime_url TEXT,
      tts_bidirectional_url TEXT,
      asr_realtime_url TEXT,
      asr_async_url TEXT,
      tts_voice TEXT,
      tts_format TEXT,
      tts_sample_rate INTEGER,
      region TEXT,
      region_label TEXT,
      docs_url TEXT,
      key_hint TEXT,
      key_prefix_hint TEXT,
      supports_llm INTEGER NOT NULL DEFAULT 1,
      supports_asr INTEGER NOT NULL DEFAULT 0,
      supports_tts INTEGER NOT NULL DEFAULT 0,
      supports_audio_input INTEGER NOT NULL DEFAULT 0,
      supports_image_input INTEGER NOT NULL DEFAULT 0,
      supports_video_input INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL,
      FOREIGN KEY(provider_id) REFERENCES llm_providers(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_llm_provider_endpoints_provider ON llm_provider_endpoints(provider_id);

    CREATE TABLE IF NOT EXISTS llm_provider_models (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      endpoint_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'custom',
      readonly INTEGER NOT NULL DEFAULT 0,
      display_name TEXT,
      recommended INTEGER NOT NULL DEFAULT 0,
      resource_id TEXT,
      supports_llm INTEGER NOT NULL DEFAULT 1,
      supports_asr INTEGER NOT NULL DEFAULT 0,
      supports_tts INTEGER NOT NULL DEFAULT 0,
      supports_audio_input INTEGER NOT NULL DEFAULT 0,
      supports_image_input INTEGER NOT NULL DEFAULT 0,
      supports_video_input INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL,
      UNIQUE(endpoint_id, model_id),
      FOREIGN KEY(provider_id) REFERENCES llm_providers(id) ON DELETE CASCADE,
      FOREIGN KEY(endpoint_id) REFERENCES llm_provider_endpoints(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_llm_provider_models_provider ON llm_provider_models(provider_id);
    CREATE INDEX IF NOT EXISTS idx_llm_provider_models_endpoint ON llm_provider_models(endpoint_id);

    CREATE TABLE IF NOT EXISTS git_servers (
      server_id TEXT PRIMARY KEY,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL UNIQUE,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS changes (
      id TEXT PRIMARY KEY,
      change_id TEXT NOT NULL UNIQUE,
      project_id TEXT,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_changes_project ON changes(project_id);

    CREATE TABLE IF NOT EXISTS change_runs (
      id TEXT PRIMARY KEY,
      change_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      worker_container_id TEXT,
      workspace_id TEXT,
      name TEXT,
      description TEXT,
      created_at TEXT NOT NULL,
      orchestration_id TEXT,
      orchestration_yaml_snapshot TEXT,
      orchestration_version TEXT,
      run_number INTEGER,
      git_branch TEXT,
      worktree_path TEXT,
      storage_backend TEXT,
      manager_agent_config TEXT,
      worker_model_config TEXT,
      manager_provider_name TEXT,
      manager_model_name TEXT,
      worker_provider_name TEXT,
      worker_model_name TEXT,
      runtime_profile TEXT,
      model_map TEXT,
      status TEXT NOT NULL,
      current_phase TEXT,
      phases TEXT,
      started_at TEXT,
      completed_at TEXT,
      result_summary TEXT,
      error_message TEXT,
      data TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_change_runs_change_created ON change_runs(change_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_change_runs_project ON change_runs(project_id);
    CREATE INDEX IF NOT EXISTS idx_change_runs_status ON change_runs(status);

    CREATE TABLE IF NOT EXISTS voice_settings (
      id TEXT PRIMARY KEY,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      last_accessed TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
    CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);

    CREATE TABLE IF NOT EXISTS agent_sessions (
      session_id TEXT PRIMARY KEY,
      project_id TEXT,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_project ON agent_sessions(project_id);

    CREATE TABLE IF NOT EXISTS agent_messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      message_id TEXT,
      role TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      data TEXT NOT NULL,
      FOREIGN KEY(session_id) REFERENCES agent_sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_agent_messages_session ON agent_messages(session_id, seq);

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE,
      session_type TEXT NOT NULL,
      change_id TEXT,
      worker_id TEXT,
      project_id TEXT,
      parent_session_id TEXT,
      current_session_id TEXT,
      status TEXT NOT NULL,
      prompt TEXT,
      start_time TEXT,
      end_time TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      tool_use_count INTEGER NOT NULL DEFAULT 0,
      thinking_count INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd REAL NOT NULL DEFAULT 0,
      response_ids TEXT,
      run_ids TEXT,
      manager_provider_name TEXT,
      manager_model_name TEXT,
      manager_agent_config TEXT,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      data TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_type_project ON sessions(session_type, project_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_change ON sessions(change_id);

    CREATE TABLE IF NOT EXISTS session_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      message_type TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      timestamp TEXT NOT NULL,
      synced INTEGER NOT NULL DEFAULT 0,
      data TEXT,
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_messages_session_sequence ON session_messages(session_id, sequence);

    CREATE TABLE IF NOT EXISTS session_activity_logs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      activity_type TEXT NOT NULL,
      activity_data TEXT,
      message TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'info',
      timestamp TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_activity_logs_session ON session_activity_logs(session_id, timestamp);

    CREATE TABLE IF NOT EXISTS voice_ui_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      voice_message_id TEXT,
      sequence INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      widget_id TEXT,
      widget_type TEXT,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_ui_events_session_sequence ON voice_ui_events(session_id, sequence);

    CREATE TABLE IF NOT EXISTS dag_session_index (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      project_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      parent_session_id TEXT,
      forked_from_entry_uuid TEXT,
      resume_instruction TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(run_id, node_id)
    );
    CREATE INDEX IF NOT EXISTS idx_dag_session_index_session ON dag_session_index(project_key, session_id);

    CREATE TABLE IF NOT EXISTS dag_runs (
      run_id TEXT PRIMARY KEY,
      status TEXT,
      created_at INTEGER,
      updated_at INTEGER NOT NULL,
      metadata TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dag_workflows (
      workflow_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      source_path TEXT,
      yaml_text TEXT NOT NULL,
      yaml_hash TEXT NOT NULL,
      node_ids TEXT NOT NULL,
      agent_ids TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dag_workflow_revisions (
      workflow_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      api_version TEXT NOT NULL,
      source_format TEXT NOT NULL,
      source_text TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      canonical_json TEXT NOT NULL,
      canonical_hash TEXT NOT NULL,
      compiler_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(workflow_id, revision),
      UNIQUE(workflow_id, canonical_hash),
      FOREIGN KEY(workflow_id) REFERENCES dag_workflows(workflow_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_dag_workflow_revisions_hash
      ON dag_workflow_revisions(workflow_id, canonical_hash);

    CREATE TABLE IF NOT EXISTS dag_runtime_profiles (
      profile_key TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      description TEXT,
      source_path TEXT,
      default_config TEXT,
      agent_configs TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL,
      UNIQUE(workflow_id, profile_id),
      FOREIGN KEY(workflow_id) REFERENCES dag_workflows(workflow_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_dag_runtime_profiles_workflow ON dag_runtime_profiles(workflow_id);

    CREATE TABLE IF NOT EXISTS dag_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      data TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES dag_runs(run_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_dag_events_run ON dag_events(run_id, seq);

    CREATE TABLE IF NOT EXISTS dag_handoffs (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      data TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES dag_runs(run_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_dag_handoffs_run ON dag_handoffs(run_id, seq);

    CREATE TABLE IF NOT EXISTS dag_artifacts (
      run_id TEXT NOT NULL,
      name TEXT NOT NULL,
      artifact_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      upload_token_hash TEXT,
      upload_expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY(run_id, name),
      FOREIGN KEY(run_id) REFERENCES dag_runs(run_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_dag_artifacts_run_status
      ON dag_artifacts(run_id, status, name);

    CREATE TABLE IF NOT EXISTS dag_chats (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      timestamp INTEGER,
      data TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES dag_runs(run_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_dag_chats_run_node ON dag_chats(run_id, node_id, seq);

    CREATE TABLE IF NOT EXISTS dag_metrics (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      timestamp INTEGER,
      data TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES dag_runs(run_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_dag_metrics_run ON dag_metrics(run_id, seq);

    CREATE TABLE IF NOT EXISTS dag_approvals (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      approval_id TEXT NOT NULL,
      status TEXT NOT NULL,
      proposal_hash TEXT NOT NULL,
      proposal_json TEXT NOT NULL,
      proposer_actor TEXT NOT NULL,
      authorized_actors TEXT NOT NULL,
      decision TEXT,
      actor TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER,
      PRIMARY KEY(run_id, node_id),
      FOREIGN KEY(run_id) REFERENCES dag_runs(run_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_dag_approvals_status ON dag_approvals(status, updated_at);

    CREATE TABLE IF NOT EXISTS dag_state_records (
      namespace TEXT NOT NULL,
      state_key TEXT NOT NULL,
      version INTEGER NOT NULL,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(namespace, state_key)
    );

    CREATE TABLE IF NOT EXISTS dag_state_history (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      namespace TEXT NOT NULL,
      state_key TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT NOT NULL,
      version INTEGER NOT NULL,
      run_id TEXT,
      node_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dag_state_history_key ON dag_state_history(namespace, state_key, seq);

    CREATE TABLE IF NOT EXISTS dag_triggers (
      trigger_key TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      trigger_id TEXT NOT NULL,
      type TEXT NOT NULL,
      config_json TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      next_fire_at INTEGER,
      updated_at INTEGER NOT NULL,
      UNIQUE(workflow_id, trigger_id),
      FOREIGN KEY(workflow_id) REFERENCES dag_workflows(workflow_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_dag_triggers_due ON dag_triggers(enabled, next_fire_at);

    CREATE TABLE IF NOT EXISTS dag_trigger_deliveries (
      delivery_key TEXT PRIMARY KEY,
      trigger_key TEXT NOT NULL,
      fire_key TEXT NOT NULL,
      status TEXT NOT NULL,
      run_id TEXT,
      payload_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(trigger_key, fire_key),
      FOREIGN KEY(trigger_key) REFERENCES dag_triggers(trigger_key) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS dag_run_admissions (
      run_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dag_run_admissions_workflow
      ON dag_run_admissions(workflow_id, created_at);

    CREATE TABLE IF NOT EXISTS experience_ingest_jobs (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      trigger_event TEXT,
      terminal_status TEXT,
      mode TEXT NOT NULL DEFAULT 'hybrid',
      summary_provider TEXT,
      summary_model TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      exit_code INTEGER,
      error_message TEXT,
      output TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_experience_ingest_jobs_run ON experience_ingest_jobs(run_id);
    CREATE INDEX IF NOT EXISTS idx_experience_ingest_jobs_status ON experience_ingest_jobs(status);

    CREATE TABLE IF NOT EXISTS event_records (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      project_id TEXT,
      worker_id TEXT,
      change_id TEXT,
      claude_session_id TEXT,
      event_data TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      is_persistent INTEGER NOT NULL DEFAULT 1,
      is_processed INTEGER NOT NULL DEFAULT 0,
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      processed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_event_records_event_id ON event_records(event_id);
    CREATE INDEX IF NOT EXISTS idx_event_records_type_timestamp ON event_records(event_type, timestamp);
    CREATE INDEX IF NOT EXISTS idx_event_records_project_timestamp ON event_records(project_id, timestamp);

    CREATE TABLE IF NOT EXISTS worker_container_mappings (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      change_id TEXT,
      run_id TEXT,
      orchestration_id TEXT,
      container_id TEXT,
      node_id TEXT NOT NULL,
      container_name TEXT NOT NULL,
      image_id TEXT NOT NULL,
      status TEXT NOT NULL,
      port_mappings TEXT,
      ssh_keys TEXT,
      active_instance_ids TEXT,
      flows TEXT,
      current_flow TEXT,
      change_context TEXT,
      created_at TEXT NOT NULL,
      last_heartbeat TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_worker_container_mappings_run ON worker_container_mappings(run_id);
    CREATE INDEX IF NOT EXISTS idx_worker_container_mappings_node_status ON worker_container_mappings(node_id, status);

    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      name TEXT,
      description TEXT,
      status TEXT NOT NULL,
      capabilities TEXT NOT NULL,
      region TEXT,
      tags TEXT NOT NULL,
      version TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_seen TEXT,
      config TEXT NOT NULL,
      metadata TEXT NOT NULL,
      runtime_info TEXT NOT NULL,
      system_resources TEXT NOT NULL,
      is_local INTEGER NOT NULL DEFAULT 0,
      manager_host TEXT
    );

    CREATE TABLE IF NOT EXISTS node_sessions (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      status TEXT NOT NULL,
      connected_at TEXT NOT NULL,
      last_heartbeat TEXT NOT NULL,
      websocket_connection_id TEXT,
      client_address TEXT,
      capabilities TEXT NOT NULL,
      metadata TEXT NOT NULL,
      version TEXT,
      system_info TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_node_sessions_node ON node_sessions(node_id);

    CREATE TABLE IF NOT EXISTS orchestrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      category TEXT NOT NULL,
      version TEXT NOT NULL,
      image_name TEXT,
      graph TEXT,
      flows TEXT,
      worker_definitions TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS manager_agent_config (
      id TEXT PRIMARY KEY,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS voice_agent_config (
      id TEXT PRIMARY KEY,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS voice_agent_sessions (
      session_id TEXT PRIMARY KEY,
      project_id TEXT,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_voice_agent_sessions_project ON voice_agent_sessions(project_id);

    CREATE TABLE IF NOT EXISTS experience_nodes (
      id TEXT PRIMARY KEY,
      node_type TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_experience_nodes_type ON experience_nodes(node_type);

    CREATE TABLE IF NOT EXISTS experience_relationships (
      rel_key TEXT PRIMARY KEY,
      rel_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_experience_relationships_source ON experience_relationships(source_id);

    CREATE TABLE IF NOT EXISTS storages (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      storage_type TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS storage_node_statuses (
      id TEXT PRIMARY KEY,
      storage_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      status TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS container_volumes (
      id TEXT PRIMARY KEY,
      storage_id TEXT,
      container_id TEXT,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS storage_usage_trackers (
      id TEXT PRIMARY KEY,
      storage_id TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS encrypted_credentials (
      id TEXT PRIMARY KEY,
      credential_type TEXT NOT NULL,
      name TEXT NOT NULL,
      encrypted_payload TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS temporary_keys (
      id TEXT PRIMARY KEY,
      key_type TEXT NOT NULL,
      encrypted_payload TEXT NOT NULL,
      expires_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS security_policies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS security_audit_logs (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      actor TEXT,
      target TEXT,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(1, nowIso());
  ensureExpandedColumns(db);
  seedBuiltinProviderCatalog(db);
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(2, nowIso());
  if (collidingMainVersions.length > 0) {
    const remove = db.prepare("DELETE FROM schema_migrations WHERE version = ?");
    db.transaction(() => {
      for (const version of collidingMainVersions) remove.run(version);
    })();
  }
  runSchemaMigrations(db, SCHEMA_MIGRATIONS);
  chmodPrivate(filePath);
}

export function getDb(): SqliteDatabase {
  const filePath = getDbPath();
  if (currentDb && currentDbPath === filePath) return currentDb;
  if (currentDb) {
    currentDb.close();
    currentDb = undefined;
  }
  ensureDbDir(filePath);
  const db = new Database(filePath);
  try {
    initializeSchema(db, filePath);
  } catch (cause) {
    try { db.close(); } catch { /* Preserve the initialization failure. */ }
    throw cause;
  }
  currentDbPath = filePath;
  currentDb = db;
  return db;
}

export function closeDb(): void {
  if (currentDb) {
    currentDb.close();
    currentDb = undefined;
    currentDbPath = undefined;
  }
}

export function dbTransaction<T>(fn: () => T): T {
  return getDb().transaction(fn)();
}

export function parseJsonRow<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function encodeJson(value: unknown): string {
  return JSON.stringify(value);
}

export function clearTables(tables: string[]): void {
  const db = getDb();
  dbTransaction(() => {
    for (const table of tables) {
      if (!CLEARABLE_TABLES.has(table)) {
        throw new Error(`Refusing to clear unknown table: ${table}`);
      }
      db.prepare(`DELETE FROM ${table}`).run();
    }
  });
}
