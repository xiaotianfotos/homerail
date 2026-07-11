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
  "dag_events",
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

function initializeSchema(db: SqliteDatabase, filePath: string): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
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
  ensureColumn(db, "dag_workflows", "head_revision", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "dag_workflows", "api_version", "TEXT");
  ensureColumn(db, "dag_workflows", "canonical_hash", "TEXT");
  ensureColumn(db, "dag_workflows", "compiler_version", "TEXT");
  seedBuiltinProviderCatalog(db);
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(2, nowIso());
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(3, nowIso());
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
  initializeSchema(db, filePath);
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
