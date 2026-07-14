import AjvModule, { type ErrorObject, type ValidateFunction } from "ajv";
import {
  GenerativeUiActorType,
  analyzeGenerativeUiJsonValue,
  type GenerativeUiDocumentV1,
  type GenerativeUiKindValidatorV1,
  type GenerativeUiStoredNodeV1,
  type GenerativeUiTransactionV1,
  type GenerativeUiValidationError,
  type HomerailPluginActionDescriptorV1,
  type HomerailDeclarativeRendererV1,
  type HomerailPluginKindRegistrationV1,
  type HomerailPluginRendererRegistrationV1,
  type HomerailPluginResolvedRendererSourceV1,
  type HomerailPluginRendererV1,
  type HomerailPluginUiProjectionV1,
  validateHomerailPluginUiProjection,
} from "homerail-protocol";
import {
  getPluginRegistryState,
  listPluginPackages,
  type PluginPackageSource,
} from "../persistence/plugins.js";
import { getDbPath } from "../config/env.js";
import { pluginJsonDigest } from "../plugins/descriptor.js";
import { ensureBuiltinPluginsSynced } from "../plugins/registry.js";
import { rebindLegacyCoreGeneratedViewOwners } from "./legacy-generated-view-migration.js";
import type { GenerativeUiKindCompositionMetadataV1 } from "./surface-composer.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AjvClass = (AjvModule as any).default || AjvModule;

interface KindDefinition {
  plugin_id: string;
  plugin_version: string;
  manifest_digest: string;
  enabled: boolean;
  writable: boolean;
  kind: string;
  kind_version: number;
  schema_id: string;
  schema: Record<string, unknown>;
  allowed_surfaces: HomerailPluginKindRegistrationV1["allowed_surfaces"];
  default_surface: HomerailPluginKindRegistrationV1["allowed_surfaces"][number];
  default_variant: GenerativeUiKindCompositionMetadataV1["default_variant"];
  max_payload_bytes: number;
  preferred_visuals: string[];
  action_ids: string[];
  action_intents: Set<string>;
  validate: ValidateFunction;
  semantic_digest: string;
}

interface SemanticDigestOwner {
  plugin_version: string;
  source: PluginPackageSource;
}

const LEGACY_CORE_GENERATED_VIEW_PACKAGE_VERSIONS = new Set([
  "0.1.0",
  "0.1.1",
  "0.1.2",
  "0.1.3",
  "0.1.4",
  "0.1.5",
  "0.1.6",
  "0.1.7",
  "0.1.8",
]);

function isKnownLegacyGeneratedViewVersionCollision(input: {
  plugin_id: string;
  kind: string;
  kind_version: number;
  previous: SemanticDigestOwner;
  current: SemanticDigestOwner;
}): boolean {
  return input.plugin_id === "com.homerail.core"
    && input.kind === "com.homerail.core/generated_view"
    && input.kind_version === 1
    && input.previous.source === "builtin"
    && input.current.source === "builtin"
    && LEGACY_CORE_GENERATED_VIEW_PACKAGE_VERSIONS.has(input.previous.plugin_version)
    && LEGACY_CORE_GENERATED_VIEW_PACKAGE_VERSIONS.has(input.current.plugin_version)
    && input.previous.plugin_version !== input.current.plugin_version
    && (input.previous.plugin_version === "0.1.7" || input.current.plugin_version === "0.1.7");
}

function exactKey(pluginId: string, pluginVersion: string, kind: string, kindVersion: number): string {
  return `${pluginId}\0${pluginVersion}\0${kind}\0${kindVersion}`;
}

function semanticKey(pluginId: string, kind: string, kindVersion: number): string {
  return `${pluginId}\0${kind}\0${kindVersion}`;
}

function validationErrors(errors: ErrorObject[] | null | undefined): GenerativeUiValidationError[] {
  return (errors ?? []).map((entry) => ({
    path: `/content${entry.instancePath || ""}`,
    message: entry.message || "kind content is invalid",
    keyword: entry.keyword || "kindSchema",
  }));
}

function qualified(pluginId: string, localId: string): string {
  return `${pluginId}:${localId}`;
}

function resolvedRendererSource(
  descriptor: ReturnType<typeof listPluginPackages>[number]["descriptor"],
  source: HomerailPluginRendererV1["source"],
): HomerailPluginResolvedRendererSourceV1 {
  if (source.type === "builtin") return structuredClone(source);
  const archived = descriptor.referenced_files.find((entry) => entry.path === source.file);
  if (!archived) throw new Error(`Missing archived ${source.type} Renderer: ${source.file}`);
  if (source.type === "custom") {
    return {
      type: "custom",
      file: source.file,
      digest: archived.digest,
    };
  }
  let document: unknown;
  try {
    document = JSON.parse(Buffer.from(archived.content, "base64").toString("utf8"));
  } catch (cause) {
    throw new Error(`Invalid archived declarative Renderer ${source.file}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return {
    type: "declarative",
    file: source.file,
    digest: archived.digest,
    document: document as HomerailDeclarativeRendererV1,
  };
}

/**
 * Installed schemas validate history; only the active+enabled view authorizes
 * new writes and projects Renderers/Actions. These concerns must never merge.
 */
export class GenerativeUiKindRegistry {
  readonly #definitions = new Map<string, KindDefinition>();
  readonly #activeDefinitions: KindDefinition[] = [];
  readonly #renderers: HomerailPluginRendererRegistrationV1[] = [];
  readonly #actions: HomerailPluginActionDescriptorV1[] = [];
  readonly revision: number;
  readonly fingerprint: string;

  constructor() {
    const registry = getPluginRegistryState();
    this.revision = registry.revision;
    this.fingerprint = registry.fingerprint;
    const activeByPlugin = new Map(registry.plugins.map((plugin) => [plugin.plugin_id, plugin]));
    const semanticDigests = new Map<string, string>();
    const semanticDigestOwners = new Map<string, SemanticDigestOwner>();

    for (const pluginPackage of listPluginPackages()) {
      const { manifest } = pluginPackage.descriptor;
      const schemas = new Map(pluginPackage.descriptor.schemas.map((schema) => [schema.id, schema.schema]));
      const actions = new Map(manifest.actions.map((action) => [action.id, action]));
      const activation = activeByPlugin.get(manifest.id)?.activation;
      const active = activation?.active_version === manifest.version;
      const enabled = Boolean(active && activation?.enabled);

      for (const kind of manifest.kinds) {
        for (const version of kind.versions) {
          const schema = schemas.get(version.content_schema);
          if (!schema) throw new Error(`Missing resolved schema ${version.content_schema} for ${kind.kind}`);
          const ajv = new AjvClass({ allErrors: true, strict: false, coerceTypes: false });
          let validate: ValidateFunction;
          try {
            validate = ajv.compile(schema);
          } catch (cause) {
            throw new Error(`Cannot compile archived kind schema ${kind.kind}@${version.version}: ${cause instanceof Error ? cause.message : String(cause)}`);
          }
          const semanticDigest = pluginJsonDigest({
            schema,
            allowed_surfaces: version.allowed_surfaces,
            default_surface: version.default_surface,
            default_variant: version.default_variant,
            max_content_bytes: version.max_content_bytes,
            preferred_visuals: version.preferred_visuals,
            fallback: version.fallback,
            actions: version.actions.map((id) => actions.get(id)),
          });
          const stableKey = semanticKey(manifest.id, kind.kind, version.version);
          const previousDigest = semanticDigests.get(stableKey);
          const previousOwner = semanticDigestOwners.get(stableKey);
          let updateCanonicalDigest = true;
          if (previousDigest && previousDigest !== semanticDigest) {
            const currentOwner = {
              plugin_version: manifest.version,
              source: pluginPackage.source,
            } satisfies SemanticDigestOwner;
            if (!previousOwner || !isKnownLegacyGeneratedViewVersionCollision({
              plugin_id: manifest.id,
              kind: kind.kind,
              kind_version: version.version,
              previous: previousOwner,
              current: currentOwner,
            })) {
              throw new Error(`Kind version drift across plugin packages: ${kind.kind}@${version.version}`);
            }

            // Core 0.1.7 briefly reused generated_view@1 for A2UI. Keep that
            // archived package readable, but never let its digest become the
            // canonical v1 ViewSpec semantic contract.
            updateCanonicalDigest = manifest.version !== "0.1.7";
          }
          if (updateCanonicalDigest) {
            semanticDigests.set(stableKey, semanticDigest);
            semanticDigestOwners.set(stableKey, {
              plugin_version: manifest.version,
              source: pluginPackage.source,
            });
          }
          const definition: KindDefinition = {
            plugin_id: manifest.id,
            plugin_version: manifest.version,
            manifest_digest: pluginPackage.descriptor.manifest_digest,
            enabled,
            writable: enabled && version.version === kind.current_version,
            kind: kind.kind,
            kind_version: version.version,
            schema_id: version.content_schema,
            schema: structuredClone(schema),
            allowed_surfaces: [...version.allowed_surfaces],
            default_surface: version.default_surface,
            default_variant: version.default_variant,
            max_payload_bytes: version.max_content_bytes,
            preferred_visuals: [...version.preferred_visuals],
            action_ids: [...version.actions],
            action_intents: new Set(version.actions.map((id) => actions.get(id)?.intent).filter((value): value is string => Boolean(value))),
            validate,
            semantic_digest: semanticDigest,
          };
          this.#definitions.set(exactKey(manifest.id, manifest.version, kind.kind, version.version), definition);
          if (active) this.#activeDefinitions.push(definition);
        }
      }

      if (active) {
        for (const renderer of manifest.renderers) {
          this.#renderers.push({
            plugin_id: manifest.id,
            plugin_version: manifest.version,
            manifest_digest: pluginPackage.descriptor.manifest_digest,
            enabled,
            renderer_id: renderer.id,
            kind: renderer.kind,
            kind_version: renderer.kind_version,
            renderer_api: renderer.renderer_api,
            mode: renderer.mode,
            surfaces: [...renderer.surfaces],
            devices: [...renderer.devices],
            source: resolvedRendererSource(pluginPackage.descriptor, renderer.source),
            fallback: structuredClone(renderer.fallback),
          });
        }
        if (enabled) {
          for (const action of manifest.actions) {
            const capabilityIds = manifest.capabilities
              .filter((capability) => capability.actions.includes(action.id))
              .map((capability) => qualified(manifest.id, capability.id))
              .sort();
            this.#actions.push({
              plugin_id: manifest.id,
              plugin_version: manifest.version,
              local_id: action.id,
              qualified_id: qualified(manifest.id, action.id),
              capability_ids: capabilityIds,
              intent: action.intent,
            });
          }
        }
      }
    }
    this.#activeDefinitions.sort((left, right) => (
      left.kind.localeCompare(right.kind) || left.kind_version - right.kind_version
    ));
    this.#renderers.sort((left, right) => (
      left.kind.localeCompare(right.kind)
      || left.kind_version - right.kind_version
      || left.renderer_id.localeCompare(right.renderer_id)
    ));
    this.#actions.sort((left, right) => left.qualified_id.localeCompare(right.qualified_id));
  }

  getDefinition(node: Pick<GenerativeUiStoredNodeV1, "owner" | "kind" | "kind_version">): KindDefinition | undefined {
    return this.#definitions.get(exactKey(node.owner.id, node.owner.version, node.kind, node.kind_version));
  }

  readonly validateHistoricalNode: GenerativeUiKindValidatorV1 = (node) => {
    const definition = this.getDefinition(node);
    if (!definition) {
      return [{
        path: "/kind",
        message: `kind is not archived for ${node.owner.id}@${node.owner.version}: ${node.kind}@${node.kind_version}`,
        keyword: "kindRegistry",
      }];
    }
    const analysis = analyzeGenerativeUiJsonValue(node.content, {
      path: "/content",
      limits: { max_bytes: definition.max_payload_bytes },
    });
    if (!analysis.valid) return [analysis.error ?? {
      path: "/content",
      message: "kind content exceeds its declared budget",
      keyword: "maxPayloadBytes",
    }];
    try {
      if (!definition.validate(node.content)) return validationErrors(definition.validate.errors);
    } catch {
      return [{ path: "/content", message: "kind schema validation failed safely", keyword: "kindSchema" }];
    }
    if (
      node.presentation?.preferred_visual
      && !definition.preferred_visuals.includes(node.presentation.preferred_visual)
    ) {
      return [{
        path: "/presentation/preferred_visual",
        message: "preferred_visual is not declared by this kind version",
        keyword: "preferredVisual",
      }];
    }
    const invalidAction = node.actions?.find((action) => !definition.action_intents.has(action.intent));
    if (invalidAction) {
      return [{
        path: "/actions",
        message: `action intent is not declared by this kind version: ${invalidAction.intent}`,
        keyword: "actionRegistry",
      }];
    }
    return [];
  };

  authorizeNewTransaction(
    transaction: GenerativeUiTransactionV1,
    document: GenerativeUiDocumentV1,
  ): GenerativeUiValidationError[] {
    const existing = new Map(document.nodes.map((node) => [node.id, node]));
    const errors: GenerativeUiValidationError[] = [];
    transaction.operations.forEach((operation, index) => {
      const node = operation.op === "put" ? operation.node : existing.get(operation.node_id);
      if (!node) return;
      const definition = this.getDefinition(node as GenerativeUiStoredNodeV1);
      if (!definition || !definition.enabled) {
        errors.push({
          path: `/operations/${index}`,
          message: `plugin kind is not enabled for writes: ${node.kind}@${node.kind_version}`,
          keyword: "pluginDisabled",
        });
        return;
      }
      if (!definition.writable) {
        errors.push({
          path: `/operations/${index}`,
          message: `historical kind version is read-only: ${node.kind}@${node.kind_version}`,
          keyword: "kindVersionReadOnly",
        });
        return;
      }
      const actorPlugin = transaction.actor.plugin;
      if (transaction.actor.type === GenerativeUiActorType.PLUGIN) {
        if (
          actorPlugin?.id !== node.owner.id
          || actorPlugin.version !== node.owner.version
        ) {
          errors.push({
            path: `/operations/${index}`,
            message: "plugin actors may mutate only their exact owned version",
            keyword: "pluginOwnership",
          });
        }
      } else if (node.owner.id !== "com.homerail.core") {
        errors.push({
          path: `/operations/${index}`,
          message: "non-plugin actors require a Core broker to mutate plugin nodes",
          keyword: "pluginOwnership",
        });
      }
      if (operation.op === "put") existing.set(operation.node.id, operation.node as GenerativeUiStoredNodeV1);
      if (operation.op === "remove") existing.delete(operation.node_id);
    });
    return errors;
  }

  compositionMetadata(): GenerativeUiKindCompositionMetadataV1[] {
    return this.#activeDefinitions
      .filter((definition) => definition.writable)
      .map((definition) => ({
        kind: definition.kind,
        kind_version: definition.kind_version,
        allowed_surfaces: [...definition.allowed_surfaces],
        default_variant: definition.default_variant,
        ...(definition.plugin_id === "com.homerail.core" ? { allow_critical: true } : {}),
      }));
  }

  uiProjection(): HomerailPluginUiProjectionV1 {
    const kinds: HomerailPluginKindRegistrationV1[] = this.#activeDefinitions.map((definition) => ({
      plugin_id: definition.plugin_id,
      plugin_version: definition.plugin_version,
      manifest_digest: definition.manifest_digest,
      enabled: definition.enabled,
      schema_id: definition.schema_id,
      kind: definition.kind,
      kind_version: definition.kind_version,
      schema: structuredClone(definition.schema),
      allowed_surfaces: [...definition.allowed_surfaces],
      max_payload_bytes: definition.max_payload_bytes,
      fallback_required: true,
      preferred_visuals: [...definition.preferred_visuals],
      action_ids: [...definition.action_ids],
    }));
    const projection: HomerailPluginUiProjectionV1 = {
      registry_revision: this.revision,
      registry_fingerprint: this.fingerprint,
      kinds,
      renderers: structuredClone(this.#renderers),
      actions: structuredClone(this.#actions),
    };
    const validation = validateHomerailPluginUiProjection(projection);
    if (!validation.valid) throw new Error(`Invalid plugin UI projection: ${JSON.stringify(validation.errors)}`);
    return validation.value ?? projection;
  }
}

let cachedRegistry: GenerativeUiKindRegistry | undefined;
const migratedRegistryStates = new Set<string>();

export function getGenerativeUiKindRegistry(): GenerativeUiKindRegistry {
  ensureBuiltinPluginsSynced();
  const state = getPluginRegistryState();
  if (!cachedRegistry || cachedRegistry.fingerprint !== state.fingerprint) {
    cachedRegistry = new GenerativeUiKindRegistry();
  }
  const migrationKey = `${getDbPath()}\0${state.fingerprint}`;
  if (!migratedRegistryStates.has(migrationKey)) {
    const core = state.plugins.find((plugin) => plugin.plugin_id === "com.homerail.core");
    if (core) {
      rebindLegacyCoreGeneratedViewOwners({
        active_plugin_version: core.plugin_version,
        validate_kind: cachedRegistry.validateHistoricalNode,
      });
    }
    migratedRegistryStates.add(migrationKey);
  }
  return cachedRegistry;
}
