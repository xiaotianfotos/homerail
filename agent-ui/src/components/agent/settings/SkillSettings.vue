<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { FileText, RefreshCw } from 'lucide-vue-next'
import {
  listDetectedManagerSkills,
  type DetectedManagerSkillCatalog,
} from '@/api/services/skill-catalog-api'

const { t } = useI18n()
const catalog = ref<DetectedManagerSkillCatalog | null>(null)
const loading = ref(false)
const error = ref('')

async function refresh(): Promise<void> {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    catalog.value = (await listDetectedManagerSkills()).data
  } catch (cause) {
    error.value = cause && typeof cause === 'object' && 'message' in cause
      ? String((cause as { message: unknown }).message)
      : t('settings.skills.loadFailed')
  } finally {
    loading.value = false
  }
}

onMounted(() => { void refresh() })
</script>

<template>
  <section data-testid="agent-settings-section-skills" class="mt-8 space-y-5">
    <div class="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--hr-border)] bg-[var(--hr-surface-1)] px-4 py-3">
      <div class="min-w-0">
        <div class="flex items-center gap-2 text-sm font-semibold text-[var(--hr-text-1)]">
          <FileText class="h-4 w-4 text-[var(--hr-accent)]" />
          {{ t('settings.skills.catalog') }}
          <span
            data-testid="agent-settings-skills-count"
            class="rounded-full bg-[var(--hr-accent-soft)] px-2 py-0.5 text-xs text-[var(--hr-accent)]"
          >
            {{ t('settings.skills.detected', { count: catalog?.total ?? 0 }) }}
          </span>
        </div>
        <p class="mt-1 truncate font-mono text-xs text-[var(--hr-text-3)]">
          {{ catalog?.root ?? t('settings.skills.scanning') }}
        </p>
      </div>
      <button
        data-testid="agent-settings-skills-refresh"
        class="inline-flex h-9 items-center gap-2 rounded-full border border-[var(--hr-border)] px-3 text-xs text-[var(--hr-text-1)] hover:bg-[var(--hr-surface-2)] disabled:opacity-50"
        :disabled="loading"
        @click="refresh"
      >
        <RefreshCw class="h-3.5 w-3.5" :class="loading ? 'animate-spin' : ''" />
        {{ t('settings.actions.refresh') }}
      </button>
    </div>

    <p
      v-if="error"
      data-testid="agent-settings-skills-error"
      role="alert"
      aria-live="polite"
      class="rounded-xl border border-[var(--hr-danger-border)] bg-[var(--hr-danger-soft)] px-4 py-3 text-sm text-[var(--hr-danger)]"
    >
      {{ error }}
    </p>

    <div class="grid gap-3 md:grid-cols-2">
      <article
        v-for="skill in catalog?.skills ?? []"
        :key="skill.id"
        :data-testid="`agent-settings-skill-${skill.id}`"
        class="min-w-0 rounded-2xl border border-[var(--hr-border)] bg-[var(--hr-surface-1)] p-4"
      >
        <div class="flex flex-wrap items-start justify-between gap-2">
          <div class="min-w-0">
            <h2 class="truncate font-semibold text-[var(--hr-text-1)]">{{ skill.name }}</h2>
            <p class="mt-1 truncate font-mono text-[11px] text-[var(--hr-text-3)]">{{ skill.id }}</p>
          </div>
          <span class="rounded-full bg-[var(--hr-surface-2)] px-2 py-1 text-[10px] text-[var(--hr-text-2)]">
            {{ t(`settings.skills.sources.${skill.source}`) }}
          </span>
        </div>
        <p class="mt-3 text-sm leading-6 text-[var(--hr-text-2)]">{{ skill.description }}</p>
        <p class="mt-3 truncate font-mono text-[10px] text-[var(--hr-text-3)]">{{ skill.relative_path }}</p>
      </article>
    </div>

    <p
      v-if="!loading && catalog && !catalog.skills.length"
      data-testid="agent-settings-skills-empty-state"
      class="rounded-2xl border border-dashed border-[var(--hr-border-strong)] px-4 py-8 text-center text-sm text-[var(--hr-text-3)]"
    >
      {{ t('settings.skills.empty') }}
    </p>
  </section>
</template>
