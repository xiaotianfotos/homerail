import {
  validateHomerailPluginUiProjection,
  type HomerailPluginUiProjectionV1,
} from 'homerail-protocol'
import { toRaw } from 'vue'
import { resolveHomerailBuiltinRendererComponent } from '@/plugins/renderer-component-catalog'
import { GenerativeUiActionRegistry } from './action-registry'
import { legacyRendererCompatibilityRegistrations } from './legacy-renderer-compatibility'
import {
  GenerativeUiRendererRegistry,
  type GenerativeUiRendererRegistrationV1,
} from './renderer-registry'

export interface ProjectedGenerativeUiRegistryV1 {
  renderers: GenerativeUiRendererRegistry
  actions: GenerativeUiActionRegistry
  unresolved_renderer_ids: readonly string[]
}

/**
 * Builds the runtime view exclusively from Manager's validated registry
 * projection and the statically compiled component catalog.
 */
export function buildProjectedGenerativeUiRegistry(
  value: HomerailPluginUiProjectionV1,
): ProjectedGenerativeUiRegistryV1 {
  const validation = validateHomerailPluginUiProjection(toRaw(value))
  if (!validation.valid || !validation.value) {
    throw new Error(`Invalid plugin UI projection: ${JSON.stringify(validation.errors)}`)
  }
  const projection = validation.value
  const projectedKinds = new Set(projection.kinds.map(kind => (
    `${kind.plugin_id}\u0000${kind.plugin_version}\u0000${kind.kind}\u0000${kind.kind_version}`
  )))
  const registrations: GenerativeUiRendererRegistrationV1[] = legacyRendererCompatibilityRegistrations()
    .filter(registration => !projectedKinds.has(
      `${registration.plugin_id}\u0000${registration.plugin_version}\u0000${registration.kind}\u0000${registration.kind_version}`,
    ))
  const unresolved = new Set<string>()
  for (const renderer of projection.renderers) {
    if (!renderer.enabled || renderer.renderer_api !== 1) continue
    if (renderer.mode === 'declarative' && renderer.source.type === 'declarative') {
      for (const surface of renderer.surfaces) {
        for (const device of renderer.devices) {
          registrations.push({
            renderer_api_version: 1,
            plugin_id: renderer.plugin_id,
            plugin_version: renderer.plugin_version,
            manifest_digest: renderer.manifest_digest,
            renderer_id: renderer.renderer_id,
            kind: renderer.kind,
            kind_version: renderer.kind_version,
            surface,
            device,
            mode: 'declarative',
            document: structuredClone(renderer.source.document),
          })
        }
      }
      continue
    }
    if (renderer.mode === 'custom' && renderer.source.type === 'custom') {
      for (const surface of renderer.surfaces) {
        for (const device of renderer.devices) {
          registrations.push({
            renderer_api_version: 1,
            plugin_id: renderer.plugin_id,
            plugin_version: renderer.plugin_version,
            manifest_digest: renderer.manifest_digest,
            renderer_id: renderer.renderer_id,
            kind: renderer.kind,
            kind_version: renderer.kind_version,
            surface,
            device,
            mode: 'custom',
            custom_source: structuredClone(renderer.source),
          })
        }
      }
      continue
    }
    if (renderer.mode !== 'builtin' || renderer.source.type !== 'builtin') {
      unresolved.add(`${renderer.plugin_id}:${renderer.renderer_id}`)
      continue
    }
    const catalogEntry = resolveHomerailBuiltinRendererComponent(renderer.source.id)
    if (!catalogEntry) {
      unresolved.add(`${renderer.plugin_id}:${renderer.renderer_id}`)
      continue
    }
    for (const surface of renderer.surfaces) {
      for (const device of renderer.devices) {
        registrations.push({
          renderer_api_version: 1,
          plugin_id: renderer.plugin_id,
          plugin_version: renderer.plugin_version,
          manifest_digest: renderer.manifest_digest,
          renderer_id: renderer.renderer_id,
          kind: renderer.kind,
          kind_version: renderer.kind_version,
          surface,
          device,
          mode: catalogEntry.mode,
          component: catalogEntry.component,
        })
      }
    }
  }
  return Object.freeze({
    renderers: new GenerativeUiRendererRegistry(registrations),
    actions: new GenerativeUiActionRegistry(projection.actions),
    unresolved_renderer_ids: Object.freeze([...unresolved].sort()),
  })
}
