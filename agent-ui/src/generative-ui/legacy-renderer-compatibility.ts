import type { GenerativeUiDevice, GenerativeUiSurface } from 'homerail-protocol'
import VoiceDynamicWidget from '@/components/agent/VoiceDynamicWidget.vue'
import SlideDeckWidget from '@/components/agent/widgets/SlideDeckWidget.vue'
import TopicOutlineWidget from '@/components/agent/widgets/TopicOutlineWidget.vue'
import XiaohongshuNoteWidget from '@/components/agent/widgets/XiaohongshuNoteWidget.vue'
import { adaptLegacyWidgetRenderer } from './legacy-widget-adapter'
import type { GenerativeUiRendererRegistrationV1 } from './renderer-registry'

const DEVICES: readonly GenerativeUiDevice[] = ['phone', 'desktop', 'tv']

function register(input: {
  plugin_id: string
  plugin_version: string
  renderer_id: string
  kind: string
  surfaces: readonly GenerativeUiSurface[]
  component: GenerativeUiRendererRegistrationV1['component']
  mode: GenerativeUiRendererRegistrationV1['mode']
}): GenerativeUiRendererRegistrationV1[] {
  return input.surfaces.flatMap(surface => DEVICES.map(device => ({
    renderer_api_version: 1 as const,
    plugin_id: input.plugin_id,
    plugin_version: input.plugin_version,
    renderer_id: input.renderer_id,
    kind: input.kind,
    kind_version: 1,
    surface,
    device,
    mode: input.mode,
    component: input.component,
  })))
}

/**
 * Explicit M2 debt for scenes not migrated to manifests yet. New scenes must
 * never be added here; each entry disappears when its exact owner is packaged.
 */
export function legacyRendererCompatibilityRegistrations(): GenerativeUiRendererRegistrationV1[] {
  return [
    ...register({
      plugin_id: 'com.homerail.content',
      plugin_version: '0.1.0',
      renderer_id: 'legacy-topic-outline',
      kind: 'com.homerail.content/topic_outline',
      surfaces: ['task'],
      component: adaptLegacyWidgetRenderer('LegacyTopicOutlineGenerativeUiRenderer', TopicOutlineWidget),
      mode: 'specialized',
    }),
    ...register({
      plugin_id: 'com.homerail.content',
      plugin_version: '0.1.0',
      renderer_id: 'legacy-xiaohongshu-note',
      kind: 'com.homerail.content/xiaohongshu_note',
      surfaces: ['result'],
      component: adaptLegacyWidgetRenderer('XiaohongshuGenerativeUiRenderer', XiaohongshuNoteWidget),
      mode: 'specialized',
    }),
    ...register({
      plugin_id: 'com.homerail.presentation',
      plugin_version: '0.1.0',
      renderer_id: 'legacy-slide-deck',
      kind: 'com.homerail.presentation/slide_deck',
      surfaces: ['result'],
      component: adaptLegacyWidgetRenderer('SlideDeckGenerativeUiRenderer', SlideDeckWidget),
      mode: 'specialized',
    }),
    ...register({
      plugin_id: 'com.homerail.legacy',
      plugin_version: '0.1.0',
      renderer_id: 'legacy-rich-content',
      kind: 'com.homerail.legacy/rich_content',
      surfaces: ['result'],
      component: adaptLegacyWidgetRenderer('LegacyRichContentProjection', VoiceDynamicWidget),
      mode: 'core_projection',
    }),
  ]
}
