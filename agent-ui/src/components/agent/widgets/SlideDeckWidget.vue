<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ExternalLink, MonitorPlay, Presentation, StickyNote } from 'lucide-vue-next'
import type { VoiceWidget } from '@/api/agent'

type SlideRow = {
  title: string
  subtitle: string
  bullets: string[]
  speaker_notes: string
  visual: string
  status: string
}

const props = defineProps<{
  widget: VoiceWidget
}>()

const { t } = useI18n()

const data = computed(() => props.widget.data ?? {})
const activeIndex = ref(0)
const deckTitle = computed(() => text(data.value.deck_title || data.value.title || props.widget.title, 90))
const deckSubtitle = computed(() => text(data.value.deck_subtitle || props.widget.body, 160))
const format = computed(() => text(data.value.format || 'HTML deck', 48))
const updatedAt = computed(() => text(data.value.updated_at, 40))
const previewUrl = computed(() => {
  const explicit = text(data.value.preview_url || data.value.url, 500)
  if (explicit) return explicit
  const runId = text(data.value.run_id, 120)
  const artifactId = text(data.value.artifact_id, 120)
  if (!runId || !artifactId) return ''
  return `/artifacts/${encodeURIComponent(runId)}/${encodeURIComponent(artifactId)}/preview`
})

const slides = computed<SlideRow[]>(() => {
  const raw = data.value.slides
  if (!Array.isArray(raw)) return []
  return raw.map((item, index) => {
    const row = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    const bullets = Array.isArray(row.bullets) ? row.bullets.map(point => text(point, 120)).filter(Boolean) : []
    return {
      title: text(row.title || `Slide ${index + 1}`, 86),
      subtitle: text(row.subtitle, 120),
      bullets,
      speaker_notes: text(row.speaker_notes, 220),
      visual: text(row.visual, 120),
      status: text(row.status || 'draft', 28),
    }
  }).filter(item => item.title || item.bullets.length)
})

const activeSlide = computed(() => slides.value[Math.min(activeIndex.value, Math.max(0, slides.value.length - 1))])

function selectSlide(index: number): void {
  activeIndex.value = index
}

function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  return String(value).replace(/\s+/g, ' ').trim().slice(0, limit)
}
</script>

<template>
  <section class="slide-deck-widget">
    <header class="slide-deck-widget__summary">
      <div>
        <span><Presentation :size="14" />{{ format }}</span>
        <h3>{{ deckTitle }}</h3>
        <p v-if="deckSubtitle">{{ deckSubtitle }}</p>
      </div>
      <a
        v-if="previewUrl"
        :href="previewUrl"
        target="_blank"
        rel="noreferrer"
        class="slide-deck-widget__open"
      >
        <MonitorPlay :size="15" />
        {{ t('voice.widgets.open') }}
      </a>
    </header>

    <div
      v-if="previewUrl || slides.length"
      class="slide-deck-widget__body"
      :class="{
        'slide-deck-widget__body--preview': previewUrl && slides.length,
        'slide-deck-widget__body--preview-only': previewUrl && !slides.length,
      }"
    >
      <div v-if="previewUrl" class="slide-deck-widget__preview">
        <iframe
          :src="previewUrl"
          title="PPT preview"
          sandbox="allow-scripts allow-forms allow-pointer-lock allow-popups"
          loading="lazy"
        />
      </div>

      <nav v-if="slides.length" class="slide-deck-widget__rail">
        <button
          v-for="(slide, index) in slides"
          :key="`${slide.title}-${index}`"
          :class="{ 'slide-deck-widget__thumb--active': index === activeIndex }"
          type="button"
          @click="selectSlide(index)"
        >
          <b>{{ index + 1 }}</b>
          <span>{{ slide.title }}</span>
        </button>
      </nav>

      <article v-if="activeSlide" class="slide-deck-widget__slide">
        <div class="slide-deck-widget__canvas">
          <span>{{ activeSlide.status }}</span>
          <h4>{{ activeSlide.title }}</h4>
          <p v-if="activeSlide.subtitle">{{ activeSlide.subtitle }}</p>
          <ul v-if="activeSlide.bullets.length">
            <li v-for="point in activeSlide.bullets.slice(0, 5)" :key="point">{{ point }}</li>
          </ul>
        </div>

        <div v-if="activeSlide.visual || activeSlide.speaker_notes" class="slide-deck-widget__notes">
          <p v-if="activeSlide.visual"><ExternalLink :size="13" />{{ activeSlide.visual }}</p>
          <p v-if="activeSlide.speaker_notes"><StickyNote :size="13" />{{ activeSlide.speaker_notes }}</p>
        </div>
      </article>
    </div>

    <div v-else class="slide-deck-widget__empty">
      <Presentation :size="22" />
      <span>{{ t('voice.widgets.waitingSlides') }}</span>
    </div>

    <footer v-if="updatedAt" class="slide-deck-widget__footer">{{ updatedAt }}</footer>
  </section>
</template>

<style scoped>
.slide-deck-widget {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  gap: 12px;
  min-height: 0;
  color: rgba(239, 252, 252, 0.9);
}

.slide-deck-widget__summary {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.slide-deck-widget__summary span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #74e4e3;
  font-size: 11px;
  font-weight: 850;
  letter-spacing: 0;
}

.slide-deck-widget__summary h3 {
  margin: 7px 0 0;
  color: #f7ffff;
  font-size: 17px;
  line-height: 1.25;
}

.slide-deck-widget__summary p {
  margin: 6px 0 0;
  color: rgba(226, 244, 244, 0.68);
  font-size: 12px;
  line-height: 1.45;
}

.slide-deck-widget__open {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  border: 1px solid rgba(101, 247, 232, 0.24);
  border-radius: 999px;
  padding: 7px 10px;
  color: #eaffff;
  background: rgba(101, 247, 232, 0.08);
  font-size: 12px;
  font-weight: 820;
  text-decoration: none;
}

.slide-deck-widget__body {
  display: grid;
  grid-template-columns: 112px minmax(0, 1fr);
  gap: 12px;
  min-height: 0;
}

.slide-deck-widget__body--preview {
  grid-template-columns: minmax(0, 1fr) minmax(210px, 260px);
  grid-template-rows: minmax(118px, 0.62fr) minmax(0, 1fr);
}

.slide-deck-widget__body--preview-only {
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
}

.slide-deck-widget__preview {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 1px solid rgba(122, 255, 238, 0.16);
  border-radius: 10px;
  background: #ffffff;
}

.slide-deck-widget__body--preview .slide-deck-widget__preview {
  grid-column: 1;
  grid-row: 1 / span 2;
}

.slide-deck-widget__body--preview-only .slide-deck-widget__preview {
  grid-column: 1;
  grid-row: 1;
}

.slide-deck-widget__preview iframe {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: #ffffff;
}

.slide-deck-widget__rail {
  display: grid;
  align-content: start;
  gap: 7px;
  min-height: 0;
  overflow: auto;
}

.slide-deck-widget__body--preview .slide-deck-widget__rail {
  grid-column: 2;
  grid-row: 1;
}

.slide-deck-widget__rail button {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr);
  gap: 7px;
  align-items: center;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 7px;
  color: rgba(225, 245, 245, 0.72);
  background: rgba(255, 255, 255, 0.04);
  cursor: pointer;
  text-align: left;
}

.slide-deck-widget__rail b {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  color: rgba(233, 252, 252, 0.78);
  background: rgba(255, 255, 255, 0.08);
  font-size: 11px;
}

.slide-deck-widget__rail span {
  overflow: hidden;
  font-size: 11px;
  font-weight: 760;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.slide-deck-widget__thumb--active {
  border-color: rgba(101, 247, 232, 0.46) !important;
  background: rgba(101, 247, 232, 0.1) !important;
}

.slide-deck-widget__slide {
  display: grid;
  gap: 9px;
  min-width: 0;
  min-height: 0;
}

.slide-deck-widget__body--preview .slide-deck-widget__slide {
  grid-column: 2;
  grid-row: 2;
  overflow-y: auto;
}

.slide-deck-widget__canvas {
  position: relative;
  min-height: 190px;
  border: 1px solid rgba(122, 255, 238, 0.16);
  border-radius: 8px;
  padding: 18px;
  overflow: hidden;
  background:
    linear-gradient(135deg, rgba(12, 31, 36, 0.9), rgba(4, 8, 12, 0.95)),
    repeating-linear-gradient(90deg, rgba(255, 255, 255, 0.04) 0 1px, transparent 1px 28px);
}

.slide-deck-widget__canvas > span {
  display: inline-flex;
  border-radius: 999px;
  padding: 4px 8px;
  color: rgba(221, 244, 244, 0.74);
  background: rgba(255, 255, 255, 0.075);
  font-size: 10px;
  font-weight: 850;
}

.slide-deck-widget__canvas h4 {
  margin: 16px 0 0;
  color: #fbffff;
  font-size: 22px;
  line-height: 1.12;
}

.slide-deck-widget__canvas p {
  margin: 8px 0 0;
  color: rgba(219, 239, 239, 0.72);
  font-size: 13px;
  line-height: 1.45;
}

.slide-deck-widget__canvas ul {
  display: grid;
  gap: 7px;
  margin: 14px 0 0;
  padding-left: 19px;
}

.slide-deck-widget__canvas li {
  color: rgba(233, 249, 249, 0.8);
  font-size: 12px;
  line-height: 1.45;
}

.slide-deck-widget__notes {
  display: grid;
  gap: 6px;
}

.slide-deck-widget__notes p {
  display: flex;
  gap: 6px;
  margin: 0;
  color: rgba(218, 239, 239, 0.68);
  font-size: 11px;
  line-height: 1.45;
}

.slide-deck-widget__empty {
  display: grid;
  place-items: center;
  min-height: 180px;
  border: 1px dashed rgba(122, 255, 238, 0.18);
  border-radius: 8px;
  color: rgba(218, 239, 239, 0.62);
  font-size: 12px;
}

.slide-deck-widget__footer {
  color: rgba(203, 231, 231, 0.58);
  font-size: 11px;
}

@media (max-width: 720px) {
  .slide-deck-widget__body {
    grid-template-columns: 1fr;
  }

  .slide-deck-widget__body--preview,
  .slide-deck-widget__body--preview-only {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(240px, 1fr) auto auto;
  }

  .slide-deck-widget__body--preview .slide-deck-widget__preview,
  .slide-deck-widget__body--preview-only .slide-deck-widget__preview {
    grid-column: 1;
    grid-row: 1;
    min-height: 240px;
  }

  .slide-deck-widget__body--preview .slide-deck-widget__rail {
    grid-column: 1;
    grid-row: 2;
  }

  .slide-deck-widget__body--preview .slide-deck-widget__slide {
    grid-column: 1;
    grid-row: 3;
  }

  .slide-deck-widget__rail {
    grid-auto-flow: column;
    grid-auto-columns: minmax(104px, 1fr);
    overflow-x: auto;
  }
}
</style>
