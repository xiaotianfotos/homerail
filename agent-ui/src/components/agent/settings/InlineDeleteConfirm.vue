<script setup lang="ts">
import { Loader2, Trash2 } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'

defineProps<{
  message: string
  loading?: boolean
  testId: string
}>()

defineEmits<{
  confirm: []
  cancel: []
}>()

const { t } = useI18n()
</script>

<template>
  <div
    :data-testid="testId"
    class="rounded-lg border border-red-300/20 bg-[#170d10]/98 p-3 shadow-xl shadow-black/30 backdrop-blur-md"
    @click.stop
  >
    <div class="flex items-start gap-2.5">
      <span class="mt-0.5 rounded-full bg-red-400/15 p-1.5 text-red-200">
        <Trash2 class="h-3.5 w-3.5" />
      </span>
      <p class="min-w-0 flex-1 text-xs leading-relaxed text-white/65">{{ message }}</p>
    </div>
    <div class="mt-3 flex gap-2">
      <button
        type="button"
        :data-testid="`${testId}-confirm`"
        class="flex-1 rounded-md bg-red-500/20 px-3 py-1.5 text-xs font-medium text-red-100 transition hover:bg-red-500/30 disabled:opacity-45"
        :disabled="loading"
        @click="$emit('confirm')"
      >
        <Loader2 v-if="loading" class="mr-1 inline h-3 w-3 animate-spin" />
        {{ t('settings.actions.delete') }}
      </button>
      <button
        type="button"
        :data-testid="`${testId}-cancel`"
        class="flex-1 rounded-md border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-white/65 transition hover:bg-white/[0.08]"
        :disabled="loading"
        @click="$emit('cancel')"
      >
        {{ t('settings.actions.cancel') }}
      </button>
    </div>
  </div>
</template>
