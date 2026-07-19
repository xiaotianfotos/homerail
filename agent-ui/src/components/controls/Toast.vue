<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition ease-out duration-200"
      enter-from-class="opacity-0 -translate-y-2"
      enter-to-class="opacity-100 translate-y-0"
      leave-active-class="transition ease-in duration-150"
      leave-from-class="opacity-100 translate-y-0"
      leave-to-class="opacity-0 -translate-y-2"
    >
      <div v-if="show" class="toast-container" data-testid="global-toast">
        <div :class="['toast', `toast-${type}`]">
          <div class="toast-icon">
            <component :is="toastIcon" class="h-4 w-4" />
          </div>
          <div class="toast-content">
            {{ message }}
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-vue-next'
import { useToast } from './useToast'

const { message, show, showToast, type } = useToast()

const toastIcon = computed(() => {
  if (type.value === 'success') return CheckCircle2
  if (type.value === 'error') return XCircle
  if (type.value === 'warning') return AlertTriangle
  return Info
})

defineExpose({
  showToast
})
</script>

<style scoped>
.toast-container {
  @apply pointer-events-none fixed left-1/2 top-6 z-[10000] flex max-w-[calc(100vw-32px)] -translate-x-1/2 justify-center px-4;
}

.toast {
  @apply flex min-h-11 min-w-[240px] max-w-[680px] items-center gap-2 rounded-2xl border px-4 py-2.5 text-sm backdrop-blur-xl;
  box-shadow: var(--hr-shadow-floating);
}

.toast-success {
  border-color: var(--hr-success-border);
  background: color-mix(in srgb, var(--hr-success) 12%, var(--hr-panel));
  color: var(--hr-success);
}

.toast-error {
  border-color: var(--hr-danger-border);
  background: color-mix(in srgb, var(--hr-danger) 12%, var(--hr-panel));
  color: var(--hr-danger);
}

.toast-info {
  border-color: var(--hr-info-border);
  background: color-mix(in srgb, var(--hr-info) 12%, var(--hr-panel));
  color: var(--hr-info);
}

.toast-warning {
  border-color: var(--hr-warning-border);
  background: color-mix(in srgb, var(--hr-warning) 12%, var(--hr-panel));
  color: var(--hr-warning);
}

.toast-icon {
  @apply flex-shrink-0;
}

.toast-content {
  @apply min-w-0 flex-1 whitespace-pre-wrap break-words text-center text-sm leading-6;
}
</style>
