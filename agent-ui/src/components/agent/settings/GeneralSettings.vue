<script setup lang="ts">
import { Check, Languages } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { useUiStore } from '@/stores/ui-store'
import { APP_LOCALE_OPTIONS, type AppLocale } from '@/i18n/locales'

const uiStore = useUiStore()
const { locale, t } = useI18n()

function selectLocale(nextLocale: AppLocale): void {
  uiStore.setLocale(nextLocale)
  locale.value = nextLocale
}
</script>

<template>
  <section data-testid="agent-settings-section-general" class="mt-8 space-y-6">
    <div>
      <h2 class="text-lg font-semibold text-white/90">{{ t('settings.general.title') }}</h2>
      <p class="mt-1 text-sm text-white/42">{{ t('settings.general.description') }}</p>
    </div>

    <div class="border-y border-white/10 py-6">
      <div class="flex items-start gap-3">
        <div class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-cyan-200/15 bg-cyan-200/[0.06] text-cyan-100/75">
          <Languages class="h-4 w-4" />
        </div>
        <div class="min-w-0 flex-1">
          <div class="text-sm font-medium text-white/85">{{ t('settings.general.language.title') }}</div>
          <div class="mt-1 text-sm text-white/42">{{ t('settings.general.language.description') }}</div>

          <div class="mt-4 grid max-w-2xl gap-2 sm:grid-cols-3" role="radiogroup" :aria-label="t('settings.general.language.title')">
            <button
              v-for="option in APP_LOCALE_OPTIONS"
              :key="option.code"
              class="flex min-h-16 items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors"
              :class="uiStore.locale === option.code
                ? 'border-cyan-200/40 bg-cyan-200/10 text-white'
                : 'border-white/10 bg-white/[0.025] text-white/62 hover:border-white/20 hover:bg-white/[0.05] hover:text-white/85'"
              :data-testid="`agent-settings-language-${option.code}`"
              type="button"
              role="radio"
              :aria-checked="uiStore.locale === option.code"
              @click="selectLocale(option.code)"
            >
              <span class="min-w-0 flex-1">
                <span class="block text-sm font-medium">{{ option.label }}</span>
                <span class="mt-0.5 block text-xs text-white/38">{{ t(option.translationKey) }}</span>
              </span>
              <Check v-if="uiStore.locale === option.code" class="h-4 w-4 flex-shrink-0 text-cyan-200" />
            </button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
