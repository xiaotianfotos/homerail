import type { GenerativeUiStoredNodeV1 } from 'homerail-protocol'
import { computed, defineComponent, h, toRaw, type Component, type PropType } from 'vue'
import type { VoiceWidget } from '@/api/agent'
import type {
  GenerativeUiPreviewRequestV1,
  GenerativeUiRendererPropsV1,
} from './types'

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`Invalid legacy widget ${label}`)
  }
  return [...value]
}

export function legacyWidgetFromGenerativeUiNode(node: GenerativeUiStoredNodeV1): VoiceWidget {
  const candidate = record(node.content.legacy_widget)
  if (!candidate) throw new Error(`Generative UI node has no legacy widget payload: ${node.id}`)
  if (candidate.id !== node.id) throw new Error(`Legacy widget id does not match Generative UI node: ${node.id}`)
  if (typeof candidate.type !== 'string' || !candidate.type.trim()) throw new Error('Invalid legacy widget type')
  if (typeof candidate.title !== 'string' || !candidate.title.trim()) throw new Error('Invalid legacy widget title')
  if (typeof candidate.body !== 'string') throw new Error('Invalid legacy widget body')
  if (!['low', 'normal', 'high'].includes(String(candidate.priority))) throw new Error('Invalid legacy widget priority')
  if (candidate.status !== null && typeof candidate.status !== 'string') throw new Error('Invalid legacy widget status')
  if (
    candidate.active_step !== null
    && (!Number.isSafeInteger(candidate.active_step) || Number(candidate.active_step) < 0)
  ) throw new Error('Invalid legacy widget active_step')
  const data = record(candidate.data)
  if (!data) throw new Error('Invalid legacy widget data')
  return {
    id: node.id,
    type: candidate.type as VoiceWidget['type'],
    title: candidate.title,
    body: candidate.body,
    priority: candidate.priority as VoiceWidget['priority'],
    status: candidate.status as string | null,
    items: stringArray(candidate.items, 'items'),
    steps: stringArray(candidate.steps, 'steps'),
    active_step: candidate.active_step as number | null,
    data: structuredClone(toRaw(data)),
  }
}

/** Adapts a trusted, statically imported legacy scene component to the V1 renderer contract. */
export function adaptLegacyWidgetRenderer(name: string, renderer: Component): Component {
  return defineComponent({
    name,
    inheritAttrs: false,
    props: {
      node: { type: Object as PropType<GenerativeUiRendererPropsV1['node']>, required: true },
      placement: { type: Object as PropType<GenerativeUiRendererPropsV1['placement']>, required: true },
      context: { type: Object as PropType<GenerativeUiRendererPropsV1['context']>, required: true },
    },
    emits: {
      'open-preview': (payload: GenerativeUiPreviewRequestV1) => Boolean(payload),
    },
    setup(props, { emit }) {
      const widget = computed(() => legacyWidgetFromGenerativeUiNode(props.node))
      return () => h(renderer, {
        widget: widget.value,
        embedded: true,
        compact: props.placement.variant === 'glance',
        onOpenPreview: (payload: GenerativeUiPreviewRequestV1) => emit('open-preview', payload),
      })
    },
  })
}
