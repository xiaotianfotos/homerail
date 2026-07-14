import { createHash } from "node:crypto";
import {
  applyHomerailKindMigrationV1,
  isHomerailDeclarativeKindMigrationManifest,
  parseHomerailKindMigrationV1,
  type HomerailKindMigrationV1,
} from "homerail-plugin-sdk";
import {
  GENERATIVE_UI_IR_VERSION,
  GenerativeUiActorType,
  type GenerativeUiNodeV1,
  type GenerativeUiStoredNodeV1,
} from "homerail-protocol";
import { PersistentGenerativeUiDocumentService } from "../generative-ui/persistent-document-service.js";
import { GenerativeUiKindRegistry } from "../generative-ui/kind-registry.js";
import { getDb } from "../persistence/db.js";
import { nowIso } from "../persistence/time.js";
import {
  getActivePlugin,
  listPluginVersions,
  type PluginActivationRecord,
  type PluginVersionRecord,
} from "../persistence/plugins.js";
import { activateInstalledPlugin } from "./package-lifecycle.js";

export interface RegistryKindMigrationActivationResult {
  activation: PluginActivationRecord;
  migrated_documents: number;
  migrated_nodes: number;
  committed_transactions: number;
}

interface RegistryKindMigrationActivationInput {
  plugin_id: string;
  plugin_version: string;
  expected_revision: number;
  timestamp?: string;
}

function assertDeclarativeCandidatePolicy(
  active: ReturnType<typeof getActivePlugin>,
  target: PluginVersionRecord,
): void {
  const manifest = target.descriptor.manifest;
  if (manifest.state.migrations.length > 0 || manifest.state.schema_version !== 1) {
    throw new Error("Plugin state migrations are not implemented and remain fail-closed");
  }
  if (active && (
    active.descriptor.manifest.state.migrations.length > 0
    || active.descriptor.manifest.state.schema_version !== manifest.state.schema_version
  )) throw new Error("Plugin state schema changes are not implemented and remain fail-closed");
  if (!isHomerailDeclarativeKindMigrationManifest(manifest)) {
    throw new Error("Registry Kind migration candidate must remain strictly data-only and declarative");
  }
  if (
    target.installation?.channel !== "registry"
    || target.installation.lifecycle_state !== "staged"
    || target.installation.health_state !== "unchecked"
    || target.installation.signature_state !== "verified"
  ) throw new Error("Registry Kind migration candidate must be an exact verified staged package");
}

export function loadVerifiedKindMigrationPlan(
  target: PluginVersionRecord,
): Map<string, Map<number, HomerailKindMigrationV1>> {
  const byPath = new Map(target.descriptor.referenced_files.map((file) => [file.path, file]));
  const plan = new Map<string, Map<number, HomerailKindMigrationV1>>();
  for (const kind of target.descriptor.manifest.kinds) {
    const steps = new Map<number, HomerailKindMigrationV1>();
    for (const declaration of kind.migrations) {
      const file = byPath.get(declaration.file);
      if (!file) throw new Error(`Archived Kind migration file is missing: ${declaration.file}`);
      const bytes = Buffer.from(file.content, "base64");
      if (createHash("sha256").update(bytes).digest("hex") !== file.digest) {
        throw new Error(`Archived Kind migration digest mismatch: ${declaration.file}`);
      }
      const migration = parseHomerailKindMigrationV1(bytes, {
        from: declaration.from,
        to: declaration.to,
      });
      steps.set(migration.from, migration);
    }
    plan.set(kind.kind, steps);
  }
  return plan;
}

function migratedNode(
  node: GenerativeUiStoredNodeV1,
  target: PluginVersionRecord,
  plan: Map<string, Map<number, HomerailKindMigrationV1>>,
): GenerativeUiNodeV1 {
  const kind = target.descriptor.manifest.kinds.find((candidate) => candidate.kind === node.kind);
  if (!kind) throw new Error(`Target plugin removed a live Kind: ${node.kind}`);
  if (node.kind_version > kind.current_version) {
    throw new Error(`Kind schema downgrade is not supported: ${node.kind}@${node.kind_version}`);
  }
  let content = structuredClone(node.content);
  let version = node.kind_version;
  while (version < kind.current_version) {
    const migration = plan.get(node.kind)?.get(version);
    if (!migration) throw new Error(`Kind migration chain is incomplete: ${node.kind}@${version}`);
    content = applyHomerailKindMigrationV1(content, migration);
    version = migration.to;
  }
  const { revision: _revision, updated_at: _updatedAt, ...base } = node;
  return {
    ...base,
    owner: { id: node.owner.id, version: target.plugin_version },
    kind_version: version,
    content,
  };
}

function transactionId(input: {
  plugin_id: string;
  plugin_version: string;
  package_digest: string;
  document_id: string;
  base_revision: number;
  chunk: number;
}): string {
  const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return `registry-kind-migration-${digest}`;
}

export function migrateCanonicalDocumentsAndActivateStagedRegistryPlugin(input: {
  plugin_id: string;
  plugin_version: string;
  expected_revision: number;
  timestamp?: string;
}): RegistryKindMigrationActivationResult {
  return getDb().transaction(() => migrateAndActivate(input)).immediate();
}

/** Package promotion, document heads, ledger rows, and activation share this transaction/savepoint. */
function migrateAndActivate(
  input: RegistryKindMigrationActivationInput,
): RegistryKindMigrationActivationResult {
  const active = getActivePlugin(input.plugin_id);
  const target = targetVersion(input.plugin_id, input.plugin_version);
  assertDeclarativeCandidatePolicy(active, target);
  const plan = loadVerifiedKindMigrationPlan(target);
  const timestamp = input.timestamp ?? nowIso();

  const promoted = getDb().prepare(`
    UPDATE plugin_installations
    SET lifecycle_state = 'installed', health_state = 'healthy', updated_at = ?
    WHERE plugin_id = ? AND plugin_version = ? AND channel = 'registry'
      AND lifecycle_state = 'staged' AND health_state = 'unchecked'
      AND signature_state = 'verified'
  `).run(timestamp, input.plugin_id, input.plugin_version);
  if (promoted.changes !== 1) throw new Error("Registry Kind migration candidate promotion conflict");

  const kindRegistry = new GenerativeUiKindRegistry();
  const documents = new PersistentGenerativeUiDocumentService(kindRegistry.validateHistoricalNode);
  let migratedDocuments = 0;
  let migratedNodes = 0;
  let committedTransactions = 0;
  for (const document of documents.listActiveCanonicalDocuments()) {
    const nodes = document.nodes
      .filter((node) => node.owner.id === input.plugin_id)
      .map((node) => migratedNode(node, target, plan));
    if (!nodes.length) continue;
    migratedDocuments += 1;
    migratedNodes += nodes.length;
    for (let offset = 0, chunk = 0; offset < nodes.length; offset += 32, chunk += 1) {
      const current = documents.get(document.document_id, document.scope);
      if (!current) throw new Error(`Canonical document disappeared during migration: ${document.document_id}`);
      const createdAt = Date.parse(current.updated_at) > Date.parse(timestamp)
        ? current.updated_at
        : timestamp;
      const operations = nodes.slice(offset, offset + 32).map((node) => ({ op: "put" as const, node }));
      const result = documents.apply({
        ir_version: GENERATIVE_UI_IR_VERSION,
        transaction_id: transactionId({
          plugin_id: input.plugin_id,
          plugin_version: input.plugin_version,
          package_digest: target.package_digest,
          document_id: document.document_id,
          base_revision: current.revision,
          chunk,
        }),
        document_id: document.document_id,
        base_revision: current.revision,
        actor: { type: GenerativeUiActorType.SYSTEM, id: "registry-kind-migration" },
        operations,
        created_at: createdAt,
      }, document.scope);
      if (result.status !== "applied") {
        throw new Error(
          `Canonical Kind migration was rejected for ${document.document_id}: ${JSON.stringify(result.errors ?? [])}`,
        );
      }
      committedTransactions += 1;
    }
  }

  const activation = activateInstalledPlugin(
    input.plugin_id,
    input.plugin_version,
    input.expected_revision,
    { registry_authorized: true },
  );
  return {
    activation,
    migrated_documents: migratedDocuments,
    migrated_nodes: migratedNodes,
    committed_transactions: committedTransactions,
  };
}

function targetVersion(pluginId: string, pluginVersion: string): PluginVersionRecord {
  // Decode through the persistence boundary so corrupt descriptors fail closed.
  const target = listPluginVersions(pluginId).find((candidate) => candidate.plugin_version === pluginVersion);
  if (!target) throw new Error(`Plugin version is not installed: ${pluginId}@${pluginVersion}`);
  return target;
}
