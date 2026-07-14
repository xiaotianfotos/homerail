<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Boxes, LockKeyhole, RefreshCw } from 'lucide-vue-next'
import {
  listHomerailPlugins,
  setHomerailPluginEnabled,
  type HomerailPluginRegistrySummaryV1,
} from '@/api/services/plugin-api'

const { t } = useI18n()
const registry = ref<HomerailPluginRegistrySummaryV1 | null>(null)
const loading = ref(false)
const saving = ref<string | null>(null)
const error = ref('')

function adoptRegistry(next: HomerailPluginRegistrySummaryV1): void {
  if (!registry.value || next.registry_revision >= registry.value.registry_revision) {
    registry.value = next
  }
}

async function refresh(): Promise<void> {
  if (loading.value || saving.value) return
  loading.value = true
  error.value = ''
  try {
    adoptRegistry((await listHomerailPlugins()).data)
  } catch (cause) {
    error.value = cause && typeof cause === 'object' && 'message' in cause
      ? String((cause as { message: unknown }).message)
      : t('settings.plugins.loadFailed')
  } finally {
    loading.value = false
  }
}

async function toggle(pluginId: string, enabled: boolean): Promise<void> {
  if (loading.value || saving.value) return
  const plugin = registry.value?.plugins.find(candidate => candidate.id === pluginId)
  const previousEnabled = plugin?.enabled
  if (!plugin) return
  if (registry.value) {
    registry.value = {
      ...registry.value,
      plugins: registry.value.plugins.map(plugin => (
        plugin.id === pluginId ? { ...plugin, enabled } : plugin
      )),
    }
  }
  saving.value = pluginId
  error.value = ''
  try {
    adoptRegistry((await setHomerailPluginEnabled(
      pluginId,
      enabled,
      plugin.activation_revision,
      plugin.version,
    )).data.registry)
  } catch (cause) {
    // The browser toggles a checkbox before the request completes. Replacing
    // the snapshot forces :checked back to the last confirmed registry state
    // when the mutation fails instead of displaying an uncommitted value.
    if (registry.value && previousEnabled !== undefined) {
      registry.value = {
        ...registry.value,
        plugins: registry.value.plugins.map(plugin => (
          plugin.id === pluginId ? { ...plugin, enabled: previousEnabled } : plugin
        )),
      }
    }
    error.value = cause && typeof cause === 'object' && 'message' in cause
      ? String((cause as { message: unknown }).message)
      : t('settings.plugins.updateFailed')
  } finally {
    saving.value = null
  }
}

onMounted(() => { void refresh() })
</script>

<template>
  <section data-testid="agent-settings-section-plugins" class="mt-8 space-y-5">
    <div class="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-cyan-200/12 bg-cyan-200/[0.045] px-4 py-3">
      <div>
        <div class="flex items-center gap-2 text-sm font-semibold text-cyan-50">
          <Boxes class="h-4 w-4 text-cyan-200" />
          {{ t('settings.plugins.registry') }}
        </div>
        <p class="mt-1 text-xs text-white/45">
          {{ t('settings.plugins.revision', { revision: registry?.registry_revision ?? 0 }) }}
          <span v-if="registry" class="ml-2 font-mono">{{ registry.registry_fingerprint.slice(0, 12) }}</span>
        </p>
      </div>
      <button
        data-testid="agent-settings-plugins-refresh"
        class="inline-flex h-9 items-center gap-2 rounded-full border border-cyan-200/16 px-3 text-xs text-cyan-50 hover:bg-cyan-200/10 disabled:opacity-50"
        :disabled="loading || saving !== null"
        @click="refresh"
      >
        <RefreshCw class="h-3.5 w-3.5" :class="loading ? 'animate-spin' : ''" />
        {{ t('settings.actions.refresh') }}
      </button>
    </div>

    <p
      v-if="error"
      data-testid="agent-settings-plugins-error"
      role="alert"
      aria-live="polite"
      class="rounded-xl border border-red-400/20 bg-red-400/8 px-4 py-3 text-sm text-red-200"
    >
      {{ error }}
    </p>

    <div class="grid gap-3">
      <article
        v-for="plugin in registry?.plugins ?? []"
        :key="`${plugin.id}@${plugin.version}`"
        :data-testid="`agent-settings-plugin-${plugin.id}`"
        class="grid gap-4 rounded-2xl border border-white/10 bg-black/18 p-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center"
      >
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <h2 class="truncate font-semibold text-white/90">{{ plugin.name }}</h2>
            <span class="rounded-full bg-white/6 px-2 py-0.5 font-mono text-[10px] text-white/50">{{ plugin.version }}</span>
            <span v-if="plugin.locked" class="inline-flex items-center gap-1 rounded-full bg-cyan-200/10 px-2 py-0.5 text-[10px] text-cyan-100/75">
              <LockKeyhole class="h-3 w-3" /> {{ t('settings.plugins.core') }}
            </span>
          </div>
          <p class="mt-1 break-all font-mono text-xs text-white/42">{{ plugin.id }}</p>
          <div class="mt-3 flex flex-wrap gap-2 text-[11px] text-white/55">
            <span>{{ t('settings.plugins.counts.capabilities', { count: plugin.capabilities.length }) }}</span>
            <span>{{ t('settings.plugins.counts.skills', { count: plugin.skills.length }) }}</span>
            <span>{{ t('settings.plugins.counts.tools', { count: plugin.tools.length }) }}</span>
            <span>{{ t('settings.plugins.counts.kinds', { count: plugin.kinds.length }) }}</span>
            <span>{{ t('settings.plugins.counts.renderers', { count: plugin.renderers.length }) }}</span>
          </div>
        </div>
        <label class="inline-flex items-center justify-between gap-3 md:justify-end">
          <span class="text-xs" :class="plugin.enabled ? 'text-emerald-200' : 'text-white/45'">
            {{ plugin.enabled ? t('settings.plugins.enabled') : t('settings.plugins.disabled') }}
          </span>
          <input
            :data-testid="`agent-settings-plugin-toggle-${plugin.id}`"
            type="checkbox"
            class="peer sr-only"
            :aria-label="t('settings.plugins.toggleLabel', {
              name: plugin.name,
              state: plugin.enabled ? t('settings.plugins.enabled') : t('settings.plugins.disabled'),
            })"
            :checked="plugin.enabled"
            :disabled="plugin.locked || loading || saving !== null"
            @change="toggle(plugin.id, ($event.target as HTMLInputElement).checked)"
          >
          <span
            aria-hidden="true"
            class="relative inline-flex h-6 w-11 flex-none rounded-full border transition-colors duration-150 peer-focus-visible:ring-2 peer-focus-visible:ring-cyan-200/70 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-black"
            :class="[
              plugin.enabled ? 'border-cyan-200/60 bg-cyan-300/80' : 'border-white/20 bg-white/10',
              plugin.locked || loading || saving !== null ? 'cursor-not-allowed opacity-45' : 'cursor-pointer',
            ]"
          >
            <span
              class="absolute top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-150"
              :class="plugin.enabled ? 'translate-x-6' : 'translate-x-1'"
            />
          </span>
        </label>
      </article>
    </div>

    <p v-if="!loading && registry && !registry.plugins.length" class="rounded-2xl border border-dashed border-white/12 px-4 py-8 text-center text-sm text-white/40">
      {{ t('settings.plugins.empty') }}
    </p>
  </section>
</template>
