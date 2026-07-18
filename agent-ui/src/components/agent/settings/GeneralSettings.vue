<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { Check, Languages, Palette } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { useUiStore } from '@/stores/ui-store'
import { APP_LOCALE_OPTIONS, type AppLocale } from '@/i18n/locales'
import {
  listAppearancePlugins,
  subscribeAppearanceRegistry,
  type AppearancePlugin,
} from '@/appearance/appearance-registry'

const uiStore = useUiStore()
const { locale, t } = useI18n()
const appearancePlugins = ref<readonly AppearancePlugin[]>(listAppearancePlugins())
let unsubscribeAppearanceRegistry: (() => void) | null = null

onMounted(() => {
  unsubscribeAppearanceRegistry = subscribeAppearanceRegistry(() => {
    appearancePlugins.value = listAppearancePlugins()
  })
})

onUnmounted(() => {
  unsubscribeAppearanceRegistry?.()
  unsubscribeAppearanceRegistry = null
})

function selectLocale(nextLocale: AppLocale): void {
  uiStore.setLocale(nextLocale)
  locale.value = nextLocale
}
</script>

<template>
  <section data-testid="agent-settings-section-general" class="mt-8 space-y-6">
    <div>
      <h2 class="text-lg font-semibold text-[var(--hr-text-1)]">{{ t('settings.general.title') }}</h2>
      <p class="mt-1 text-sm text-[var(--hr-text-3)]">{{ t('settings.general.description') }}</p>
    </div>

    <div class="border-y border-[var(--hr-border)] py-6">
      <div class="flex items-start gap-3">
        <div class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-[var(--hr-border)] bg-[var(--hr-surface-1)] text-[var(--hr-text-2)]">
          <Palette class="h-4 w-4" />
        </div>
        <div class="min-w-0 flex-1">
          <div class="text-sm font-medium text-[var(--hr-text-1)]">{{ t('settings.general.appearance.title') }}</div>
          <div class="mt-1 text-sm text-[var(--hr-text-3)]">{{ t('settings.general.appearance.description') }}</div>

          <div class="mt-4 grid max-w-2xl gap-3 sm:grid-cols-2" role="radiogroup" :aria-label="t('settings.general.appearance.title')">
            <button
              v-for="appearance in appearancePlugins"
              :key="appearance.id"
              class="group flex min-h-24 items-center gap-4 rounded-xl border px-4 py-3 text-left transition-colors"
              :class="uiStore.appearanceId === appearance.id
                ? 'border-[var(--hr-settings-active-border)] bg-[var(--hr-settings-active)] text-[var(--hr-text-1)]'
                : 'border-[var(--hr-settings-divider)] bg-[var(--hr-settings-card)] text-[var(--hr-text-2)] hover:border-[var(--hr-border-strong)] hover:bg-[var(--hr-settings-card-hover)] hover:text-[var(--hr-text-1)]'"
              :data-testid="`agent-settings-appearance-${appearance.id}`"
              type="button"
              role="radio"
              :aria-checked="uiStore.appearanceId === appearance.id"
              @click="uiStore.setAppearance(appearance.id)"
            >
              <span
                class="relative h-14 w-20 flex-shrink-0 overflow-hidden rounded-lg border"
                :style="{ background: appearance.preview.background, borderColor: appearance.preview.panel }"
                aria-hidden="true"
              >
                <span
                  class="absolute inset-x-2 bottom-2 top-3 rounded-md shadow-sm"
                  :style="{ background: appearance.preview.panel }"
                />
                <span
                  class="absolute left-4 top-5 h-2 w-8 rounded-full"
                  :style="{ background: appearance.preview.text, opacity: '0.82' }"
                />
                <span
                  class="absolute bottom-3 right-3 h-3 w-3 rounded-full"
                  :style="{ background: appearance.preview.accent }"
                />
              </span>
              <span class="min-w-0 flex-1">
                <span class="block text-sm font-semibold text-[var(--hr-text-1)]">{{ t(appearance.labelKey) }}</span>
                <span class="mt-1 block text-xs leading-5 text-[var(--hr-text-3)]">{{ t(appearance.descriptionKey) }}</span>
              </span>
              <Check v-if="uiStore.appearanceId === appearance.id" class="h-4 w-4 flex-shrink-0 text-[var(--hr-accent)]" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="border-b border-[var(--hr-border)] pb-6">
      <div class="flex items-start gap-3">
        <div class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-[var(--hr-border)] bg-[var(--hr-surface-1)] text-[var(--hr-text-2)]">
          <Languages class="h-4 w-4" />
        </div>
        <div class="min-w-0 flex-1">
          <div class="text-sm font-medium text-[var(--hr-text-1)]">{{ t('settings.general.language.title') }}</div>
          <div class="mt-1 text-sm text-[var(--hr-text-3)]">{{ t('settings.general.language.description') }}</div>

          <div class="mt-4 grid max-w-2xl gap-2 sm:grid-cols-3" role="radiogroup" :aria-label="t('settings.general.language.title')">
            <button
              v-for="option in APP_LOCALE_OPTIONS"
              :key="option.code"
              class="flex min-h-16 items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors"
              :class="uiStore.locale === option.code
                ? 'border-[var(--hr-settings-active-border)] bg-[var(--hr-settings-active)] text-[var(--hr-text-1)]'
                : 'border-[var(--hr-settings-divider)] bg-[var(--hr-settings-card)] text-[var(--hr-text-2)] hover:border-[var(--hr-border-strong)] hover:bg-[var(--hr-settings-card-hover)] hover:text-[var(--hr-text-1)]'"
              :data-testid="`agent-settings-language-${option.code}`"
              type="button"
              role="radio"
              :aria-checked="uiStore.locale === option.code"
              @click="selectLocale(option.code)"
            >
              <span class="min-w-0 flex-1">
                <span class="block text-sm font-medium">{{ option.label }}</span>
                <span class="mt-0.5 block text-xs text-[var(--hr-text-3)]">{{ t(option.translationKey) }}</span>
              </span>
              <Check v-if="uiStore.locale === option.code" class="h-4 w-4 flex-shrink-0 text-[var(--hr-accent)]" />
            </button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
