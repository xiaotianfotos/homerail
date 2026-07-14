import type {
  HomerailResolvedPluginDescriptorV1,
} from "homerail-protocol";
import {
  getPluginRegistryState,
  getActivePlugin,
  setPluginEnabled,
  syncPluginPackage,
  type ActivePluginRecord,
  type PluginActivationRecord,
  type PluginRegistryState,
} from "../persistence/plugins.js";
import {
  getBuiltinPluginRoot,
  listBuiltinPluginPackageRoots,
  loadPluginPackage,
} from "./manifest-loader.js";
import { getDbPath } from "../config/env.js";

export const CORE_PLUGIN_ID = "com.homerail.core" as const;

/** Precompiled components are a finite host catalog, never manifest imports. */
export const M3_BUILTIN_RENDERER_IDS: ReadonlySet<string> = new Set([
  "core-legacy-widget",
  "pr-closeout",
  "topic-outline",
  "a2ui",
  "view-spec",
]);

/** Temporary migration allowlist. Ordinary data-only plugins cannot target the
 * legacy Widget renderer path. */
export const M3_LEGACY_BRIDGE_PLUGIN_IDS: ReadonlySet<string> = new Set([
  "com.homerail.topic-outline",
]);

const TRUSTED_BUILTIN_IDS: ReadonlySet<string> = new Set([CORE_PLUGIN_ID]);
const synchronizedDbPaths = new Set<string>();

export interface SyncBuiltinPluginsResult {
  root: string;
  plugins: ActivePluginRecord[];
}

export function syncBuiltinPlugins(root = getBuiltinPluginRoot()): SyncBuiltinPluginsResult {
  const descriptors: HomerailResolvedPluginDescriptorV1[] = listBuiltinPluginPackageRoots(root)
    .map((packageRoot) => loadPluginPackage(packageRoot, {
      source: "builtin",
      trusted_builtin_ids: TRUSTED_BUILTIN_IDS,
      builtin_renderer_ids: M3_BUILTIN_RENDERER_IDS,
      legacy_bridge_plugin_ids: M3_LEGACY_BRIDGE_PLUGIN_IDS,
    }))
    .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
  const seen = new Set<string>();
  const plugins = descriptors.map((descriptor) => {
    if (seen.has(descriptor.manifest.id)) {
      throw new Error(`Multiple bundled packages declare plugin id: ${descriptor.manifest.id}`);
    }
    seen.add(descriptor.manifest.id);
    return syncPluginPackage({
      descriptor,
      source: "builtin",
      locked: descriptor.manifest.id === CORE_PLUGIN_ID,
      default_enabled: true,
      // Bundled packages ship with HomeRail itself. Refresh their persisted
      // descriptor when a local/pre-release build changes without weakening
      // same-version immutability for installed or development packages.
      refresh_builtin: true,
    });
  });
  if (!seen.has(CORE_PLUGIN_ID)) {
    throw new Error(`Missing locked builtin plugin: ${CORE_PLUGIN_ID}`);
  }
  synchronizedDbPaths.add(getDbPath());
  return { root, plugins };
}

export function ensureBuiltinPluginsSynced(root = getBuiltinPluginRoot()): void {
  if (!synchronizedDbPaths.has(getDbPath()) || !getActivePlugin(CORE_PLUGIN_ID)) syncBuiltinPlugins(root);
}

export class HomerailPluginRegistry {
  readonly #builtinRoot: string;

  constructor(builtinRoot = getBuiltinPluginRoot()) {
    this.#builtinRoot = builtinRoot;
  }

  syncBuiltins(): SyncBuiltinPluginsResult {
    return syncBuiltinPlugins(this.#builtinRoot);
  }

  snapshot(): PluginRegistryState {
    ensureBuiltinPluginsSynced(this.#builtinRoot);
    return getPluginRegistryState();
  }

  setEnabled(
    pluginId: string,
    enabled: boolean,
    options: { expected_revision?: number; expected_active_version?: string } = {},
  ): PluginActivationRecord {
    ensureBuiltinPluginsSynced(this.#builtinRoot);
    return setPluginEnabled(pluginId, enabled, options);
  }
}
