<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronLeft, ChevronRight, ExternalLink, Heart, Star, MessageCircle } from 'lucide-vue-next'
import type { VoiceWidget } from '@/api/agent'

interface XhsAuthor {
  nickname: string
  avatar_url: string
}

const props = defineProps<{
  widget: VoiceWidget
}>()

const emit = defineEmits<{
  (event: 'open-preview', payload: { title: string; url: string; kind: 'html' | 'image' | 'gallery'; layout?: 'fluid' | 'portrait'; images?: string[] }): void
}>()

const { t } = useI18n()

const data = computed(() => props.widget.data as Record<string, unknown>)
const images = computed<string[]>(() => normalizeImages((data.value.images as string[]) ?? []))
const currentIndex = ref(0)

const currentImage = computed(() =>
  images.value.length > 0 ? images.value[currentIndex.value] : null
)

const canGoPrev = computed(() => currentIndex.value > 0)
const canGoNext = computed(() => currentIndex.value < images.value.length - 1)
const previewUrl = computed(() => {
  const explicit = text(data.value.preview_url || data.value.url, 500)
  const runId = text(data.value.run_id, 120)
  const artifactId = text(data.value.artifact_id, 120)
  if (explicit && !explicit.startsWith('/artifacts/')) return explicit
  if (!runId || !artifactId) return ''
  return artifactFileUrl(runId, artifactId, 'index.html')
})
const pageCount = computed(() => {
  const value = Number(data.value.page_count)
  if (Number.isFinite(value) && value > 0) return Math.round(value)
  return images.value.length
})
const noteTitle = computed(() => text(data.value.title || props.widget.title, 160) || t('voice.widgets.noteTitle'))

function prevImage() {
  if (canGoPrev.value) currentIndex.value--
}

function nextImage() {
  if (canGoNext.value) currentIndex.value++
}

function openPreview() {
  if (images.value.length > 0) {
    emit('open-preview', {
      title: noteTitle.value,
      url: currentImage.value || images.value[0],
      kind: 'gallery',
      layout: 'portrait',
      images: images.value,
    })
    return
  }
  if (!previewUrl.value) return
  emit('open-preview', {
    title: noteTitle.value,
    url: previewUrl.value,
    kind: 'html',
    layout: 'portrait',
  })
}

const tags = computed(() => {
  const raw = data.value.tags
  if (!Array.isArray(raw)) return []
  return raw.map((t: unknown) => {
    const s = String(t)
    return s.startsWith('#') ? s : `#${s}`
  })
})

const bodyParagraphs = computed(() => {
  const text = String(data.value.body || '')
  return text.split('\n').filter(p => p.trim())
})

const author = computed<XhsAuthor>(() => {
  const raw = data.value.author
  if (raw && typeof raw === 'object' && raw !== null) {
    const a = raw as Record<string, unknown>
    return {
      nickname: String(a.nickname || t('voice.widgets.assistant')),
      avatar_url: String(a.avatar_url || ''),
    }
  }
  return { nickname: t('voice.widgets.assistant'), avatar_url: '' }
})

function normalizeImages(rawImages: string[]): string[] {
  const runId = text(data.value.run_id, 120)
  const artifactId = text(data.value.artifact_id, 120)
  return rawImages
    .map(image => text(image, 1000))
    .filter(Boolean)
    .map((image) => {
      if (
        image.startsWith('http://')
        || image.startsWith('https://')
        || image.startsWith('/api/')
        || image.startsWith('/artifacts/')
        || image.startsWith('data:')
      ) return image
      if (runId && artifactId) {
        const clean = image.replace(/^\/+/, '')
        return artifactFileUrl(runId, artifactId, clean)
      }
      return image
    })
}

function artifactFileUrl(runId: string, artifactId: string, filePath: string): string {
  const encodedPath = filePath.split('/').map(part => encodeURIComponent(part)).join('/')
  return `/api/artifacts/${encodeURIComponent(runId)}/${encodeURIComponent(artifactId)}/files/${encodedPath}`
}

function text(value: unknown, limit = 96): string {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  return String(value).trim().slice(0, limit)
}
</script>

<template>
  <article class="xhs-note-widget">
    <div v-if="images.length > 0" class="xhs-note-widget__gallery">
      <img
        v-if="currentImage"
        :src="currentImage"
        class="xhs-note-widget__image"
        :alt="t('voice.widgets.noteImage')"
      />

      <!-- 图片计数器 -->
      <div v-if="images.length > 1" class="xhs-note-widget__counter">
        {{ currentIndex + 1 }} / {{ images.length }}
      </div>

      <!-- 左右切换按钮 -->
      <button
        v-if="images.length > 1"
        class="xhs-note-widget__nav xhs-note-widget__nav--prev"
        :disabled="!canGoPrev"
        @click="prevImage"
      >
        <ChevronLeft :size="20" />
      </button>
      <button
        v-if="images.length > 1"
        class="xhs-note-widget__nav xhs-note-widget__nav--next"
        :disabled="!canGoNext"
        @click="nextImage"
      >
        <ChevronRight :size="20" />
      </button>
    </div>

    <div v-if="images.length > 1" class="xhs-note-widget__dots" :aria-label="t('voice.widgets.pagination')">
      <button
        v-for="(_, i) in images"
        :key="i"
        class="xhs-note-widget__dot"
        :class="{ 'xhs-note-widget__dot--active': i === currentIndex }"
        :aria-label="t('voice.widgets.goToPage', { page: i + 1 })"
        @click="currentIndex = i"
      />
    </div>

    <section class="xhs-note-widget__copy">
      <div class="xhs-note-widget__author">
        <img v-if="author.avatar_url" :src="author.avatar_url" class="xhs-note-widget__avatar" />
        <div v-else class="xhs-note-widget__avatar xhs-note-widget__avatar--placeholder">AI</div>
        <div class="xhs-note-widget__author-text">
          <span class="xhs-note-widget__nickname">{{ author.nickname }}</span>
          <small v-if="pageCount">{{ t('voice.widgets.pageCount', { count: pageCount }) }}</small>
        </div>
        <button
          v-if="previewUrl || images.length > 0"
          class="xhs-note-widget__preview-link"
          type="button"
          @click="openPreview"
        >
          <ExternalLink :size="14" />
          <span>{{ t('voice.widgets.fullPreview') }}</span>
        </button>
      </div>

      <h2 class="xhs-note-widget__title">{{ noteTitle }}</h2>

      <div class="xhs-note-widget__body">
        <p v-for="(para, i) in bodyParagraphs" :key="i">{{ para }}</p>
      </div>

      <div v-if="tags.length > 0" class="xhs-note-widget__tags">
        <span v-for="tag in tags.slice(0, 4)" :key="tag" class="xhs-note-widget__tag">{{ tag }}</span>
      </div>

      <div class="xhs-note-widget__actions">
        <span><Heart :size="15" /> {{ (data.likes as number) || 0 }}</span>
        <span><Star :size="15" /> {{ (data.collects as number) || 0 }}</span>
        <span><MessageCircle :size="15" /> {{ (data.comments as number) || 0 }}</span>
      </div>
    </section>
  </article>
</template>

<style scoped>
.xhs-note-widget {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding-right: 4px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}

.xhs-note-widget::-webkit-scrollbar {
  width: 4px;
}

.xhs-note-widget::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: rgba(207, 226, 229, 0.2);
}

.xhs-note-widget__author {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  flex-shrink: 0;
}

.xhs-note-widget__author-text {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.xhs-note-widget__avatar {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}

.xhs-note-widget__avatar--placeholder {
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, #ff2442, #ff6b7a);
  color: white;
  font-size: 12px;
  font-weight: 700;
}

.xhs-note-widget__nickname {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.85);
  font-weight: 600;
}

.xhs-note-widget__author-text small {
  font-size: 11px;
  color: rgba(207, 226, 229, 0.58);
  line-height: 1;
}

.xhs-note-widget__preview-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: auto;
  padding: 5px 8px;
  border: 1px solid rgba(122, 255, 238, 0.22);
  border-radius: 999px;
  color: rgba(222, 252, 249, 0.86);
  font-size: 11px;
  font-weight: 650;
  line-height: 1;
  text-decoration: none;
  background: rgba(9, 29, 32, 0.45);
  cursor: pointer;
}

.xhs-note-widget__preview-link:hover {
  border-color: rgba(122, 255, 238, 0.38);
  background: rgba(29, 73, 78, 0.45);
}

.xhs-note-widget__gallery {
  position: relative;
  flex: 0 0 auto;
  width: 100%;
  aspect-ratio: 3 / 4;
  border-radius: 18px;
  overflow: hidden;
  background: #f7f2e7;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.15);
}

.xhs-note-widget__image {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

.xhs-note-widget__counter {
  position: absolute;
  top: 10px;
  right: 10px;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.5);
  color: white;
  font-size: 12px;
  font-weight: 600;
}

.xhs-note-widget__nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.4);
  color: white;
  cursor: pointer;
  display: grid;
  place-items: center;
  transition: background 0.2s;
  z-index: 2;
}

.xhs-note-widget__nav:hover:not(:disabled) {
  background: rgba(0, 0, 0, 0.6);
}

.xhs-note-widget__nav:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.xhs-note-widget__nav--prev { left: 8px; }
.xhs-note-widget__nav--next { right: 8px; }

.xhs-note-widget__dots {
  display: flex;
  flex: 0 0 auto;
  justify-content: center;
  gap: 7px;
  padding: 8px 0 6px;
}

.xhs-note-widget__dot {
  width: 7px;
  height: 7px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: rgba(207, 226, 229, 0.32);
  cursor: pointer;
  transition: background 0.2s;
}

.xhs-note-widget__dot--active {
  background: #ff3b58;
}

.xhs-note-widget__copy {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  overflow: visible;
}

.xhs-note-widget__title {
  margin: 0 0 8px;
  font-size: 18px;
  font-weight: 700;
  color: #f5fbff;
  line-height: 1.3;
  flex-shrink: 0;
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.xhs-note-widget__body {
  margin-bottom: 10px;
  overflow: visible;
}

.xhs-note-widget__body p {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  color: rgba(235, 244, 246, 0.82);
}

.xhs-note-widget__body p + p {
  margin-top: 4px;
}

.xhs-note-widget__body p:last-child {
  margin-bottom: 0;
}

.xhs-note-widget__tags {
  display: flex;
  min-height: 23px;
  gap: 6px;
  margin-bottom: 10px;
  overflow: hidden;
  flex-shrink: 0;
}

.xhs-note-widget__tag {
  flex: 0 0 auto;
  padding: 4px 8px;
  border-radius: 999px;
  background: rgba(255, 36, 66, 0.15);
  color: #ff6b7a;
  font-size: 11px;
  font-weight: 600;
}

.xhs-note-widget__actions {
  display: flex;
  gap: 16px;
  padding-top: 9px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  margin-top: auto;
  flex-shrink: 0;
}

.xhs-note-widget__actions span {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);
}
</style>
