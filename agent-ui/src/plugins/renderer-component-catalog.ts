import type { Component } from 'vue'
import VoiceDynamicWidget from '@/components/agent/VoiceDynamicWidget.vue'
import TopicOutlineRenderer from './builtin/topic-outline/TopicOutlineRenderer.vue'
import PrCloseoutRenderer from './builtin/pr-closeout/PrCloseoutRenderer.vue'
import A2uiRenderer from '@/components/generative-ui/A2uiRenderer.vue'
import ViewSpecRenderer from '@/components/generative-ui/ViewSpecRenderer.vue'
import { adaptLegacyWidgetRenderer } from '@/generative-ui/legacy-widget-adapter'
import type { GenerativeUiRendererMode } from '@/generative-ui/renderer-registry'

export interface HomerailBuiltinRendererComponentV1 {
  component: Component
  mode: GenerativeUiRendererMode
}

const catalog = new Map<string, HomerailBuiltinRendererComponentV1>([
  ['core-legacy-widget', {
    component: adaptLegacyWidgetRenderer('CoreLegacyWidgetProjection', VoiceDynamicWidget),
    mode: 'core_projection',
  }],
  ['topic-outline', {
    component: TopicOutlineRenderer,
    mode: 'specialized',
  }],
  ['pr-closeout', {
    component: PrCloseoutRenderer,
    mode: 'specialized',
  }],
  ['a2ui', {
    component: A2uiRenderer,
    mode: 'specialized',
  }],
  ['view-spec', {
    component: ViewSpecRenderer,
    mode: 'specialized',
  }],
])

/** Static trust boundary: manifests may select an ID, never an import path. */
export function resolveHomerailBuiltinRendererComponent(
  rendererId: string,
): HomerailBuiltinRendererComponentV1 | undefined {
  return catalog.get(rendererId)
}
