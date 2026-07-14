<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ExternalLink, Lightbulb, Target, Users } from 'lucide-vue-next'
import { isSafeGenerativeUiArtifactUri } from 'homerail-protocol'
import type { VoiceWidget } from '@/api/agent'

type OutlineSection = {
  title: string
  status: string
  points: string[]
}

type TopicSource = {
  title: string
  url: string
  note: string
}

const props = defineProps<{
  widget?: VoiceWidget
  content?: Record<string, unknown>
}>()

const { t } = useI18n()

const data = computed(() => props.content ?? props.widget?.data ?? {})
const brief = computed(() => text(data.value.brief || props.widget?.body, 220))
const audience = computed(() => text(data.value.audience, 60))
const angle = computed(() => text(data.value.angle, 90))
const thesis = computed(() => text(data.value.thesis, 140))
const nextAction = computed(() => text(data.value.next_action, 120))
const confidence = computed(() => clampPercent(data.value.confidence))

const outline = computed<OutlineSection[]>(() => {
  const raw = data.value.outline
  if (!Array.isArray(raw)) return []
  return raw.map((item, index) => {
    const row = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    const points = Array.isArray(row.points) ? row.points.map(point => text(point, 120)).filter(Boolean) : []
    return {
      title: text(row.title || t('voice.widgets.section', { index: index + 1 }), 72),
      status: text(row.status || 'draft', 28),
      points,
    }
  }).filter(item => item.title || item.points.length)
})

const sources = computed<TopicSource[]>(() => {
  const raw = data.value.sources
  if (!Array.isArray(raw)) return []
  return raw.map((item) => {
    const row = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    return {
      title: text(row.title, 72),
      url: safeExternalUrl(row.url),
      note: text(row.note, 96),
    }
  }).filter(item => item.title || item.url || item.note)
})

const questions = computed(() => {
  const raw = data.value.questions
  if (!Array.isArray(raw)) return []
  return raw.map(item => text(item, 120)).filter(Boolean)
})

function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  return String(value).replace(/\s+/g, ' ').trim().slice(0, limit)
}

function safeExternalUrl(value: unknown): string {
  if (typeof value !== 'string') return ''
  const candidate = value.trim()
  if (!isSafeGenerativeUiArtifactUri(candidate)) return ''
  try {
    const parsed = new URL(candidate)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? candidate : ''
  } catch {
    return ''
  }
}

function clampPercent(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return Math.max(0, Math.min(100, Math.round(numeric)))
}
</script>

<template>
  <section class="topic-outline-widget">
    <div class="topic-outline-widget__brief-pane">
      <div class="topic-outline-widget__pane-head">
        <span>{{ t('voice.widgets.requirements') }}</span>
        <em>live</em>
      </div>

      <div class="topic-outline-widget__summary">
        <p v-if="brief">{{ brief }}</p>
        <div class="topic-outline-widget__meta">
          <span v-if="audience"><Users :size="14" />{{ audience }}</span>
          <span v-if="angle"><Lightbulb :size="14" />{{ angle }}</span>
          <span v-if="confidence"><Target :size="14" />{{ confidence }}%</span>
        </div>
      </div>

      <div v-if="thesis" class="topic-outline-widget__thesis">
        <span>{{ t('voice.widgets.claim') }}</span>
        <strong>{{ thesis }}</strong>
      </div>

      <div v-if="questions.length" class="topic-outline-widget__questions">
        <span>{{ t('voice.widgets.pending') }}</span>
        <p v-for="item in questions.slice(0, 3)" :key="item">{{ item }}</p>
      </div>

      <div v-if="sources.length" class="topic-outline-widget__sources">
        <a
          v-for="source in sources.slice(0, 4)"
          :key="`${source.title}-${source.url}`"
          :href="source.url || undefined"
          target="_blank"
          rel="noopener noreferrer"
        >
          <span>{{ source.title || source.note || source.url }}</span>
          <ExternalLink v-if="source.url" :size="13" />
        </a>
      </div>

      <footer v-if="nextAction" class="topic-outline-widget__next">{{ nextAction }}</footer>
    </div>

    <div class="topic-outline-widget__outline-pane">
      <div class="topic-outline-widget__pane-head">
        <span>{{ t('voice.widgets.outline') }}</span>
        <em v-if="outline.length">{{ t('voice.widgets.sections', { count: outline.length }) }}</em>
      </div>

      <div v-if="outline.length" class="topic-outline-widget__outline">
        <article
          v-for="(section, index) in outline"
          :key="`${section.title}-${index}`"
          class="topic-outline-widget__section"
        >
          <header>
            <b>{{ index + 1 }}</b>
            <strong>{{ section.title }}</strong>
            <em>{{ section.status }}</em>
          </header>
          <ul v-if="section.points.length">
            <li v-for="point in section.points.slice(0, 4)" :key="point">{{ point }}</li>
          </ul>
        </article>
      </div>

      <div v-else class="topic-outline-widget__empty">{{ t('voice.widgets.waitingOutline') }}</div>
    </div>
  </section>
</template>

<style scoped>
.topic-outline-widget {
  display: grid;
  grid-template-columns: minmax(220px, 0.9fr) minmax(300px, 1.35fr);
  gap: 14px;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  color: rgba(239, 252, 252, 0.9);
}

.topic-outline-widget__brief-pane,
.topic-outline-widget__outline-pane {
  display: flex;
  min-height: 0;
  flex-direction: column;
  overflow-x: hidden;
  overflow-y: auto;
  border: 1px solid rgba(122, 255, 238, 0.1);
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.12);
  padding: 12px;
  scrollbar-gutter: stable;
  scrollbar-color: rgba(116, 228, 227, 0.42) transparent;
  scrollbar-width: thin;
}

.topic-outline-widget__brief-pane::-webkit-scrollbar,
.topic-outline-widget__outline-pane::-webkit-scrollbar {
  width: 6px;
}

.topic-outline-widget__brief-pane::-webkit-scrollbar-track,
.topic-outline-widget__outline-pane::-webkit-scrollbar-track {
  background: transparent;
}

.topic-outline-widget__brief-pane::-webkit-scrollbar-thumb,
.topic-outline-widget__outline-pane::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: rgba(116, 228, 227, 0.34);
}

.topic-outline-widget__brief-pane::-webkit-scrollbar-thumb:hover,
.topic-outline-widget__outline-pane::-webkit-scrollbar-thumb:hover {
  background: rgba(116, 228, 227, 0.52);
}

.topic-outline-widget__pane-head {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}

.topic-outline-widget__pane-head span {
  color: #74e4e3;
  font-size: 11px;
  font-weight: 850;
  letter-spacing: 0;
}

.topic-outline-widget__pane-head em {
  flex: 0 0 auto;
  border-radius: 999px;
  background: rgba(116, 228, 227, 0.1);
  padding: 3px 7px;
  color: rgba(209, 255, 250, 0.62);
  font-size: 10px;
  font-style: normal;
  font-weight: 800;
}

.topic-outline-widget__summary p {
  margin: 0;
  color: rgba(229, 244, 244, 0.78);
  font-size: 14px;
  line-height: 1.6;
}

.topic-outline-widget__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.topic-outline-widget__meta span,
.topic-outline-widget__thesis,
.topic-outline-widget__questions,
.topic-outline-widget__next {
  border: 1px solid rgba(122, 255, 238, 0.13);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.18);
}

.topic-outline-widget__meta span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 9px;
  color: rgba(216, 244, 244, 0.78);
  font-size: 12px;
  font-weight: 750;
}

.topic-outline-widget__thesis {
  display: grid;
  gap: 6px;
  margin-top: 10px;
  padding: 12px;
}

.topic-outline-widget__thesis span,
.topic-outline-widget__questions span {
  color: #74e4e3;
  font-size: 11px;
  font-weight: 850;
  letter-spacing: 0;
}

.topic-outline-widget__thesis strong {
  color: #f6ffff;
  font-size: 15px;
  line-height: 1.45;
}

.topic-outline-widget__outline {
  display: grid;
  gap: 9px;
  min-height: 0;
}

.topic-outline-widget__section {
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 10px;
  background: rgba(255, 255, 255, 0.045);
}

.topic-outline-widget__section header {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
}

.topic-outline-widget__section b {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 999px;
  color: #03191b;
  background: #65f7e8;
  font-size: 12px;
}

.topic-outline-widget__section strong {
  overflow: hidden;
  color: #f5fbff;
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.topic-outline-widget__section em {
  color: rgba(207, 232, 232, 0.62);
  font-size: 11px;
  font-style: normal;
  font-weight: 800;
}

.topic-outline-widget__section ul {
  display: grid;
  gap: 5px;
  margin: 9px 0 0;
  padding-left: 18px;
}

.topic-outline-widget__section li {
  color: rgba(220, 240, 240, 0.72);
  font-size: 12px;
  line-height: 1.5;
}

.topic-outline-widget__questions {
  display: grid;
  gap: 7px;
  margin-top: 10px;
  padding: 11px;
}

.topic-outline-widget__questions p {
  margin: 0;
  color: rgba(231, 245, 245, 0.78);
  font-size: 12px;
  line-height: 1.45;
}

.topic-outline-widget__sources {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 10px;
}

.topic-outline-widget__sources a {
  display: inline-flex;
  max-width: 100%;
  align-items: center;
  gap: 5px;
  border: 1px solid rgba(122, 255, 238, 0.14);
  border-radius: 999px;
  padding: 6px 9px;
  color: rgba(220, 246, 246, 0.74);
  background: rgba(255, 255, 255, 0.045);
  font-size: 11px;
  font-weight: 750;
  text-decoration: none;
}

.topic-outline-widget__sources span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.topic-outline-widget__next {
  margin-top: 10px;
  padding: 10px 11px;
  color: #dffffc;
  font-size: 12px;
  font-weight: 780;
}

.topic-outline-widget__empty {
  display: grid;
  min-height: 180px;
  place-items: center;
  border: 1px dashed rgba(122, 255, 238, 0.14);
  border-radius: 12px;
  color: rgba(220, 246, 246, 0.44);
  font-size: 12px;
  font-weight: 760;
}

@media (max-width: 880px) {
  .topic-outline-widget {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
