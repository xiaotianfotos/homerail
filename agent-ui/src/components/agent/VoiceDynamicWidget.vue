<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import XiaohongshuNoteWidget from './widgets/XiaohongshuNoteWidget.vue'
import TopicOutlineWidget from './widgets/TopicOutlineWidget.vue'
import SlideDeckWidget from './widgets/SlideDeckWidget.vue'
import type { VoiceWidget } from '@/api/agent'

type WidgetMetric = {
  label: string
  value: string
  unit: string
  tone: string
}

type WidgetTimelineItem = {
  time: string
  label: string
  status: string
  detail: string
}

type WidgetNode = {
  id: string
  label: string
  status: string
  detail: string
  progress: number
}

type WidgetChartValue = {
  label: string
  value: number
  tone: string
}

type WidgetPreviewRequest = {
  title?: string
  url: string
  kind?: 'html' | 'image' | 'gallery'
  layout?: 'fluid' | 'portrait'
  images?: string[]
}

const props = withDefaults(defineProps<{
  widget: VoiceWidget
  embedded?: boolean
  compact?: boolean
}>(), {
  embedded: false,
  compact: false,
})

const emit = defineEmits<{
  (event: 'open-preview', payload: WidgetPreviewRequest): void
}>()

const { t, locale } = useI18n()

const data = computed(() => props.widget.data ?? {})
const uiState = computed(() => String(data.value.ui_state || 'visible'))
const minimized = computed(() => uiState.value === 'minimized')
const statusText = computed(() => {
  const status = String(props.widget.status || '').trim()
  return ['visible', 'hidden', 'minimized'].includes(status) ? '' : status
})
const visual = computed(() => {
  const explicit = String(data.value.visual || '').trim()
  if (explicit) return explicit
  if (props.widget.type === 'html') return 'html'
  if (props.widget.type === 'metric_strip') return 'metric_strip'
  if (props.widget.type === 'timeline') return 'timeline'
  if (props.widget.type === 'dag_flow') return 'dag_flow'
  if (props.widget.type === 'chart') return 'chart'
  if (props.widget.type === 'xiaohongshu_note') return 'xiaohongshu_note'
  if (props.widget.type === 'topic_outline') return 'topic_outline'
  if (props.widget.type === 'slide_deck') return 'slide_deck'
  if (metrics.value.length) return 'metric_strip'
  if (nodes.value.length) return 'dag_flow'
  if (timeline.value.length) return 'timeline'
  if (chartValues.value.length) return 'chart'
  return 'text'
})
const kicker = computed(() => {
  if (visual.value === 'html') return 'dynamic html'
  if (visual.value === 'metric_strip') return 'metrics'
  if (visual.value === 'dag_flow') return 'dag'
  if (visual.value === 'timeline') return 'timeline'
  if (visual.value === 'chart') return 'chart'
  if (visual.value === 'xiaohongshu_note') return 'xiaohongshu'
  if (visual.value === 'topic_outline') return 'topic'
  if (visual.value === 'slide_deck') return 'deck'
  if (visual.value === 'memo') return 'memo'
  return props.widget.type || 'panel'
})
const metrics = computed<WidgetMetric[]>(() => {
  const raw = data.value.metrics
  if (!Array.isArray(raw)) return []
  return raw.map((item) => ({
    label: clean(item?.label),
    value: clean(item?.value),
    unit: clean(item?.unit),
    tone: clean(item?.tone || 'neutral'),
  })).filter(item => item.label || item.value)
})
const timeline = computed<WidgetTimelineItem[]>(() => {
  const raw = data.value.timeline
  if (!Array.isArray(raw)) return []
  return raw.map((item) => ({
    time: clean(item?.time),
    label: clean(item?.label),
    status: clean(item?.status),
    detail: clean(item?.detail),
  })).filter(item => item.time || item.label || item.detail)
})
const nodes = computed<WidgetNode[]>(() => {
  const raw = data.value.nodes
  if (!Array.isArray(raw)) return []
  return raw.map((item, index) => ({
    id: clean(item?.id || `node-${index}`),
    label: clean(item?.label || item?.id || t('voice.widgets.nodeFallback', { index: index + 1 })),
    status: clean(item?.status || 'pending'),
    detail: clean(item?.detail),
    progress: clampNumber(item?.progress),
  })).filter(item => item.label)
})
const chartValues = computed<WidgetChartValue[]>(() => {
  const raw = data.value.chart_values
  if (!Array.isArray(raw)) return []
  return raw.map((item) => ({
    label: clean(item?.label),
    value: clampNumber(item?.value),
    tone: clean(item?.tone || 'neutral'),
  })).filter(item => item.label || item.value > 0)
})
const maxChartValue = computed(() => Math.max(1, ...chartValues.value.map(item => item.value)))
const htmlDocument = computed(() => {
  const html = rawString(data.value.html, 20000)
  if (!html) return ''
  if (/<!doctype|<html[\s>]/i.test(html)) return html
  const css = rawString(data.value.css, 12000)
  return `<!doctype html>
<html lang="${locale.value}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; width: 100%; min-height: 100%; overflow: hidden; background: transparent; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
body { color: #f8ffff; }
${css}
</style>
</head>
<body>${html}</body>
</html>`
})

function clean(value: unknown, limit = 96): string {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  return String(value).replace(/\s+/g, ' ').trim().slice(0, limit)
}

function rawString(value: unknown, limit: number): string {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  return String(value).trim().slice(0, limit)
}

function clampNumber(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return Math.max(0, Math.min(100, Math.round(numeric)))
}
</script>

<template>
  <article
    class="voice-dynamic-widget"
    :class="[
      `voice-dynamic-widget--${visual}`,
      {
        'voice-dynamic-widget--embedded': embedded,
        'voice-dynamic-widget--compact': compact,
        'voice-dynamic-widget--minimized': minimized,
        'voice-dynamic-widget--tall': data.layout === 'tall',
      },
    ]"
  >
    <div v-if="visual !== 'xiaohongshu_note'" class="voice-dynamic-widget__kicker">{{ kicker }}</div>
    <div v-if="visual !== 'xiaohongshu_note'" class="voice-dynamic-widget__head">
      <h2>{{ widget.title }}</h2>
      <span v-if="statusText">{{ statusText }}</span>
    </div>

    <template v-if="!minimized">
      <iframe
        v-if="visual === 'html' && htmlDocument"
        class="voice-dynamic-widget__html"
        :srcdoc="htmlDocument"
        sandbox="allow-scripts allow-forms allow-pointer-lock allow-popups"
        loading="lazy"
        title="Dynamic widget"
      />

      <div v-else-if="visual === 'metric_strip'" class="voice-dynamic-widget__metrics">
        <div
          v-for="metric in metrics"
          :key="`${metric.label}-${metric.value}`"
          class="voice-dynamic-widget__metric"
          :data-tone="metric.tone"
        >
          <strong>{{ metric.value }}<small v-if="metric.unit">{{ metric.unit }}</small></strong>
          <span>{{ metric.label }}</span>
        </div>
      </div>

      <div v-else-if="visual === 'dag_flow'" class="voice-dynamic-widget__nodes">
        <div
          v-for="node in nodes"
          :key="node.id"
          class="voice-dynamic-widget__node"
          :data-status="node.status"
        >
          <div class="voice-dynamic-widget__node-ring">
            <span>{{ node.progress || '' }}</span>
          </div>
          <div class="voice-dynamic-widget__node-body">
            <strong>{{ node.label }}</strong>
            <span>{{ node.detail || node.status }}</span>
          </div>
        </div>
      </div>

      <div v-else-if="visual === 'timeline'" class="voice-dynamic-widget__timeline">
        <div
          v-for="item in timeline"
          :key="`${item.time}-${item.label}`"
          class="voice-dynamic-widget__time-item"
          :data-status="item.status"
        >
          <time>{{ item.time }}</time>
          <strong>{{ item.label }}</strong>
          <span>{{ item.detail || item.status }}</span>
        </div>
      </div>

      <div v-else-if="visual === 'chart'" class="voice-dynamic-widget__chart">
        <div
          v-for="item in chartValues"
          :key="item.label"
          class="voice-dynamic-widget__bar-row"
          :data-tone="item.tone"
        >
          <span>{{ item.label }}</span>
          <div><i :style="{ width: `${Math.max(4, (item.value / maxChartValue) * 100)}%` }" /></div>
          <strong>{{ item.value }}</strong>
        </div>
      </div>

      <XiaohongshuNoteWidget
        v-else-if="visual === 'xiaohongshu_note'"
        :widget="widget"
        @open-preview="emit('open-preview', $event)"
      />

      <TopicOutlineWidget
        v-else-if="visual === 'topic_outline'"
        :widget="widget"
      />

      <SlideDeckWidget
        v-else-if="visual === 'slide_deck'"
        :widget="widget"
      />

      <template v-else>
        <p v-if="widget.body">{{ widget.body }}</p>
        <ul v-if="widget.items?.length" class="voice-dynamic-widget__list">
          <li v-for="item in widget.items.slice(0, compact ? 4 : 8)" :key="item">{{ item }}</li>
        </ul>
        <ol v-if="widget.steps?.length" class="voice-dynamic-widget__steps">
          <li
            v-for="(step, index) in widget.steps.slice(0, compact ? 4 : 8)"
            :key="step"
            :class="{ 'voice-dynamic-widget__steps-item--active': index === widget.active_step }"
          >
            {{ step }}
          </li>
        </ol>
      </template>
    </template>
  </article>
</template>

<style scoped>
.voice-dynamic-widget {
  position: relative;
  display: flex;
  height: 100%;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  border: 1px solid rgba(122, 255, 238, 0.18);
  border-radius: 18px;
  padding: 18px;
  overflow: auto;
  background:
    radial-gradient(circle at 78% 8%, rgba(128, 190, 255, 0.12), transparent 34%),
    linear-gradient(135deg, rgba(19, 44, 50, 0.72), rgba(8, 13, 20, 0.82));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
}

.voice-dynamic-widget--embedded {
  min-height: 118px;
  border-radius: 12px;
  padding: 14px;
  background: rgba(255, 255, 255, 0.045);
}

.voice-dynamic-widget--compact {
  min-height: 108px;
}

.voice-dynamic-widget--xiaohongshu_note {
  overflow: hidden;
}

.voice-dynamic-widget--tall {
  min-height: 360px;
}

.voice-dynamic-widget__kicker {
  margin-bottom: 20px;
  color: #74e4e3;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0;
  text-transform: uppercase;
}

.voice-dynamic-widget__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
}

.voice-dynamic-widget__head h2 {
  margin: 0;
  color: #f5fbff;
  font-size: clamp(20px, 2vw, 30px);
  font-weight: 850;
  line-height: 1.12;
  overflow-wrap: normal;
  text-wrap: balance;
  word-break: keep-all;
}

.voice-dynamic-widget__head span {
  flex: 0 0 auto;
  border-radius: 999px;
  padding: 5px 9px;
  color: rgba(240, 255, 255, 0.82);
  background: rgba(255, 255, 255, 0.08);
  font-size: 11px;
  font-weight: 800;
}

.voice-dynamic-widget p {
  margin: 16px 0 0;
  color: rgba(235, 244, 246, 0.78);
  font-size: 14px;
  line-height: 1.7;
}

.voice-dynamic-widget__html {
  display: block;
  width: 100%;
  min-height: 0;
  flex: 1;
  height: auto;
  margin-top: 16px;
  border: 0;
  border-radius: 14px;
  background: transparent;
}

.voice-dynamic-widget :deep(.topic-outline-widget),
.voice-dynamic-widget :deep(.slide-deck-widget),
.voice-dynamic-widget :deep(.xhs-note-widget) {
  margin-top: 16px;
  min-height: 0;
  flex: 1;
}

.voice-dynamic-widget--xiaohongshu_note :deep(.xhs-note-widget) {
  margin-top: 0;
}

.voice-dynamic-widget--tall .voice-dynamic-widget__html {
  min-height: 420px;
}

.voice-dynamic-widget__metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 10px;
  margin-top: 18px;
}

.voice-dynamic-widget__metric {
  min-height: 78px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  padding: 13px;
  background: rgba(0, 0, 0, 0.16);
}

.voice-dynamic-widget__metric strong {
  display: block;
  color: #f9ffff;
  font-size: 28px;
  line-height: 1;
}

.voice-dynamic-widget__metric small {
  margin-left: 3px;
  color: rgba(224, 250, 250, 0.75);
  font-size: 13px;
}

.voice-dynamic-widget__metric span {
  display: block;
  margin-top: 8px;
  color: rgba(208, 232, 232, 0.7);
  font-size: 12px;
}

.voice-dynamic-widget__nodes,
.voice-dynamic-widget__timeline,
.voice-dynamic-widget__chart {
  display: grid;
  gap: 10px;
  margin-top: 18px;
}

.voice-dynamic-widget__node {
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr);
  gap: 12px;
  align-items: center;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  padding: 10px;
  background: rgba(0, 0, 0, 0.16);
}

.voice-dynamic-widget__node[data-status*="running"],
.voice-dynamic-widget__node[data-status*="active"] {
  border-color: rgba(91, 255, 231, 0.45);
  box-shadow: 0 0 22px rgba(29, 233, 210, 0.14);
}

.voice-dynamic-widget__node[data-status*="failed"],
.voice-dynamic-widget__node[data-status*="error"] {
  border-color: rgba(255, 112, 112, 0.48);
}

.voice-dynamic-widget__node-ring {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 999px;
  color: #dffffd;
  background: conic-gradient(from 180deg, rgba(76, 255, 234, 0.9), rgba(89, 137, 255, 0.8), rgba(255, 255, 255, 0.08));
  font-size: 10px;
  font-weight: 900;
}

.voice-dynamic-widget__node-body strong,
.voice-dynamic-widget__time-item strong {
  display: block;
  color: rgba(245, 255, 255, 0.94);
  font-size: 14px;
}

.voice-dynamic-widget__node-body span,
.voice-dynamic-widget__time-item span {
  display: block;
  margin-top: 3px;
  color: rgba(206, 230, 230, 0.66);
  font-size: 12px;
}

.voice-dynamic-widget__time-item {
  position: relative;
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  gap: 12px;
  align-items: start;
  padding: 10px 0 10px 18px;
}

.voice-dynamic-widget__time-item::before {
  content: "";
  position: absolute;
  left: 0;
  top: 17px;
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #65f7e8;
  box-shadow: 0 0 16px rgba(101, 247, 232, 0.65);
}

.voice-dynamic-widget__time-item time {
  color: rgba(198, 230, 232, 0.65);
  font-size: 12px;
  font-weight: 800;
}

.voice-dynamic-widget__bar-row {
  display: grid;
  grid-template-columns: 74px minmax(0, 1fr) 42px;
  gap: 10px;
  align-items: center;
  color: rgba(230, 246, 248, 0.8);
  font-size: 12px;
}

.voice-dynamic-widget__bar-row div {
  height: 10px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
}

.voice-dynamic-widget__bar-row i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #45f0df, #7a9bff);
}

.voice-dynamic-widget__bar-row strong {
  color: rgba(245, 255, 255, 0.9);
  text-align: right;
}

.voice-dynamic-widget__list,
.voice-dynamic-widget__steps {
  display: grid;
  gap: 8px;
  margin: 16px 0 0;
  padding: 0;
  list-style: none;
}

.voice-dynamic-widget__list li,
.voice-dynamic-widget__steps li {
  border-radius: 10px;
  padding: 8px 10px;
  color: rgba(229, 244, 244, 0.76);
  background: rgba(255, 255, 255, 0.055);
  font-size: 13px;
  line-height: 1.45;
}

.voice-dynamic-widget__steps-item--active {
  color: #ecffff !important;
  background: rgba(77, 255, 232, 0.16) !important;
}
</style>
