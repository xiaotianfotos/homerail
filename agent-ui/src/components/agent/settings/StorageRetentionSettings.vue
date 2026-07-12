<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Loader2 } from 'lucide-vue-next'

import {
  agentSettingsApi,
  type AgentStorageRetentionInfo,
} from '@/api/agent'
import { useToast } from '@/components/controls/useToast'

const { showToast } = useToast()
const storageInfo = ref<AgentStorageRetentionInfo | null>(null)
const loading = ref(true)
const saving = ref<string | null>(null)
const form = ref({
  enabled: true,
  success_days: 7,
  failure_days: 7,
})

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String((error as { message?: string })?.message || error)
}

async function load(): Promise<void> {
  loading.value = true
  try {
    storageInfo.value = await agentSettingsApi.getStorageInfo()
    form.value = { ...storageInfo.value.workspace_retention }
  } catch (error) {
    showToast(messageOf(error), 'error', 3600)
  } finally {
    loading.value = false
  }
}

function normalizedDays(value: number): number {
  if (!Number.isFinite(value)) return 7
  return Math.max(0, Math.min(3650, Math.round(value)))
}

async function save(): Promise<void> {
  saving.value = 'save'
  try {
    const settings = await agentSettingsApi.updateWorkspaceRetention({
      enabled: form.value.enabled,
      success_days: normalizedDays(form.value.success_days),
      failure_days: normalizedDays(form.value.failure_days),
    })
    form.value = { ...settings }
    if (storageInfo.value) storageInfo.value.workspace_retention = { ...settings }
    showToast('工作区保留策略已保存', 'success', 2600)
  } catch (error) {
    showToast(messageOf(error), 'error', 3600)
  } finally {
    saving.value = null
  }
}

async function cleanup(dryRun: boolean): Promise<void> {
  if (!dryRun && !window.confirm('立即删除已超过保留期限且未固定的运行工作区？')) return
  saving.value = dryRun ? 'preview' : 'cleanup'
  try {
    const report = await agentSettingsApi.cleanupRunWorkspaces(dryRun)
    if (!dryRun) await load()
    const action = dryRun ? '预览' : '清理'
    showToast(
      `${action}完成：符合条件 ${report.eligible}，已删除 ${report.removed}，失败 ${report.failed}`,
      'success',
      2600,
    )
  } catch (error) {
    showToast(messageOf(error), 'error', 3600)
  } finally {
    saving.value = null
  }
}

onMounted(load)
</script>

<template>
  <section class="mt-5 rounded-lg border border-white/10 bg-white/[0.045] p-4" data-testid="agent-settings-storage-info">
    <div class="flex items-center justify-between gap-3">
      <div>
        <h2 class="font-semibold text-white/88">Storage & Retention</h2>
        <p class="mt-1 text-sm text-white/42">配置已结束运行的工作区保留期限。</p>
      </div>
      <span v-if="storageInfo" class="rounded-full bg-emerald-500/10 px-2 py-1 text-xs text-emerald-200">已连接</span>
      <span v-else class="rounded-full bg-yellow-500/10 px-2 py-1 text-xs text-yellow-200">{{ loading ? '加载中...' : '不可用' }}</span>
    </div>

    <div v-if="storageInfo" class="mt-4 space-y-4">
      <div class="grid gap-3 sm:grid-cols-3">
        <div class="rounded-md bg-black/20 p-3">
          <div class="text-xs text-white/42">Data Root</div>
          <div class="mt-1 break-all font-mono text-sm text-white/75">{{ storageInfo.data_root }}</div>
        </div>
        <div class="rounded-md bg-black/20 p-3">
          <div class="text-xs text-white/42">Runs</div>
          <div class="mt-1 text-lg font-semibold">{{ storageInfo.runs_count }}</div>
        </div>
        <div class="rounded-md bg-black/20 p-3">
          <div class="text-xs text-white/42">Sessions Dir</div>
          <div class="mt-1 break-all font-mono text-sm text-white/75">{{ storageInfo.sessions_dir }}</div>
        </div>
      </div>

      <div class="border-t border-white/10 pt-4" data-testid="agent-settings-workspace-retention-form">
        <div class="flex items-center justify-between gap-4">
          <div>
            <div class="text-sm font-medium">运行工作区自动清理</div>
            <div class="mt-1 text-xs text-white/42">只清理已结束、未固定且超过保留期限的工作区。</div>
          </div>
          <label class="flex shrink-0 items-center gap-2 whitespace-nowrap text-sm">
            <input v-model="form.enabled" type="checkbox" class="h-4 w-4 accent-cyan-400" data-testid="agent-settings-workspace-retention-enabled" />
            启用
          </label>
        </div>
        <div class="mt-4 grid gap-3 sm:grid-cols-2">
          <label class="text-sm">
            <span class="text-white/55">成功运行保留天数</span>
            <input v-model.number="form.success_days" type="number" min="0" max="3650" step="1" class="mt-1 h-10 w-full rounded-md border border-white/10 bg-black/20 px-3 outline-none focus:border-cyan-400/60" data-testid="agent-settings-workspace-retention-success-days" />
          </label>
          <label class="text-sm">
            <span class="text-white/55">失败或取消运行保留天数</span>
            <input v-model.number="form.failure_days" type="number" min="0" max="3650" step="1" class="mt-1 h-10 w-full rounded-md border border-white/10 bg-black/20 px-3 outline-none focus:border-cyan-400/60" data-testid="agent-settings-workspace-retention-failure-days" />
          </label>
        </div>
        <div class="mt-4 flex flex-wrap justify-end gap-2">
          <button class="h-9 rounded-md border border-white/10 px-3 text-sm hover:bg-white/5 disabled:opacity-50" :disabled="saving !== null" data-testid="agent-settings-workspace-cleanup-preview" @click="cleanup(true)">
            <Loader2 v-if="saving === 'preview'" class="mr-2 inline h-4 w-4 animate-spin" />
            预览清理
          </button>
          <button class="h-9 rounded-md border border-red-400/30 px-3 text-sm text-red-200 hover:bg-red-400/10 disabled:opacity-50" :disabled="saving !== null" data-testid="agent-settings-workspace-cleanup-run" @click="cleanup(false)">
            <Loader2 v-if="saving === 'cleanup'" class="mr-2 inline h-4 w-4 animate-spin" />
            立即清理
          </button>
          <button class="h-9 rounded-md bg-cyan-500 px-4 text-sm font-medium text-black hover:bg-cyan-400 disabled:opacity-50" :disabled="saving !== null" data-testid="agent-settings-workspace-retention-save" @click="save">
            <Loader2 v-if="saving === 'save'" class="mr-2 inline h-4 w-4 animate-spin" />
            保存策略
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
