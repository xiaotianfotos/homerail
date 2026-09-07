<script setup lang="ts">
import { FlaskConical, Focus } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { useUiStore } from '@/stores/ui-store'
import BrowserToolsSettings from './BrowserToolsSettings.vue'

const { t } = useI18n()
const uiStore = useUiStore()
</script>

<template>
  <section
    data-testid="agent-settings-section-experimental"
    class="mt-8 space-y-6"
  >
    <div>
      <div class="flex items-center gap-2">
        <FlaskConical class="h-5 w-5 text-[var(--hr-accent)]" />
        <h2 class="text-lg font-semibold text-[var(--hr-text-1)]">
          {{ t('settings.experimental.title') }}
        </h2>
      </div>
      <p class="mt-1 text-sm text-[var(--hr-text-3)]">
        {{ t('settings.experimental.description') }}
      </p>
    </div>

    <BrowserToolsSettings />

    <div
      class="rounded-2xl border border-[var(--hr-settings-divider)] bg-[var(--hr-settings-card)] p-5"
    >
      <div class="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div class="flex min-w-0 items-start gap-3">
          <div
            class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border border-[var(--hr-border)] bg-[var(--hr-surface-1)] text-[var(--hr-accent)]"
          >
            <Focus class="h-5 w-5" />
          </div>
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <h3 class="text-sm font-semibold text-[var(--hr-text-1)]">
                {{ t('settings.experimental.liveVoiceImmersive.title') }}
              </h3>
              <span
                class="rounded-full border border-[var(--hr-warning-border)] bg-[var(--hr-warning-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--hr-warning)]"
              >
                {{ t('settings.experimental.badge') }}
              </span>
            </div>
            <p class="mt-1 max-w-2xl text-sm leading-6 text-[var(--hr-text-3)]">
              {{ t('settings.experimental.liveVoiceImmersive.description') }}
            </p>
          </div>
        </div>

        <div class="inline-flex flex-shrink-0 items-center gap-3 sm:pl-4">
          <span
            class="text-xs font-medium"
            :class="
              uiStore.liveVoiceImmersiveEnabled
                ? 'text-[var(--hr-info)]'
                : 'text-[var(--hr-text-3)]'
            "
          >
            {{
              uiStore.liveVoiceImmersiveEnabled
                ? t('settings.actions.enabled')
                : t('settings.actions.disabled')
            }}
          </span>
          <button
            data-testid="agent-settings-live-voice-immersive-toggle"
            type="button"
            role="switch"
            class="relative h-7 w-12 rounded-full border transition"
            :class="
              uiStore.liveVoiceImmersiveEnabled
                ? 'border-[var(--hr-info-border)] bg-[var(--hr-info)]'
                : 'border-[var(--hr-border-strong)] bg-[var(--hr-surface-2)]'
            "
            :aria-checked="uiStore.liveVoiceImmersiveEnabled"
            :aria-label="t('settings.experimental.liveVoiceImmersive.title')"
            @click="
              uiStore.setLiveVoiceImmersiveEnabled(
                !uiStore.liveVoiceImmersiveEnabled
              )
            "
          >
            <span
              class="absolute left-1 top-1 h-5 w-5 rounded-full bg-white shadow transition-transform"
              :class="
                uiStore.liveVoiceImmersiveEnabled
                  ? 'translate-x-5'
                  : 'translate-x-0'
              "
            />
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
