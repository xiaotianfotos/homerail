import type {
  GenerativeUiActionV1,
  GenerativeUiStoredNodeV1,
  HomerailPluginActionDescriptorV1,
} from 'homerail-protocol'
import { toRaw } from 'vue'

function key(pluginId: string, pluginVersion: string, intent: string): string {
  return `${pluginId}\u0000${pluginVersion}\u0000${intent}`
}

/** Immutable exact-owner view of Actions currently enabled by Manager. */
export class GenerativeUiActionRegistry {
  readonly #available: ReadonlySet<string>

  constructor(actions: readonly HomerailPluginActionDescriptorV1[]) {
    this.#available = new Set(actions.map(action => key(
      action.plugin_id,
      action.plugin_version,
      action.intent,
    )))
    Object.freeze(this)
  }

  allows(node: GenerativeUiStoredNodeV1, action: GenerativeUiActionV1): boolean {
    return this.#available.has(key(node.owner.id, node.owner.version, action.intent))
  }

  availableFor(node: GenerativeUiStoredNodeV1): GenerativeUiActionV1[] {
    return (node.actions ?? [])
      .filter(action => this.allows(node, action))
      .map(action => structuredClone(toRaw(action)))
  }
}

export const emptyGenerativeUiActionRegistry = new GenerativeUiActionRegistry([])
