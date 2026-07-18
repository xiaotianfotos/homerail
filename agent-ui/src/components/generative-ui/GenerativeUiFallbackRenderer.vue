<script setup lang="ts">
import type { GenerativeUiStoredNodeV1 } from 'homerail-protocol'
import { useI18n } from 'vue-i18n'

defineProps<{
  node: GenerativeUiStoredNodeV1
  unavailable?: boolean
  reason?: string
}>()

const { t } = useI18n()
</script>

<template>
  <section
    class="generative-ui-fallback"
    :class="{ 'generative-ui-fallback--unavailable': unavailable }"
    :aria-label="unavailable ? t('voice.generativeUi.unavailable') : t('voice.generativeUi.fallback')"
  >
    <header>
      <span>{{ unavailable ? t('voice.generativeUi.unavailable') : t('voice.generativeUi.fallback') }}</span>
      <em>{{ node.kind }}@{{ node.kind_version }}</em>
    </header>
    <h3>{{ node.fallback?.title || t('voice.generativeUi.untitled') }}</h3>
    <p v-if="node.fallback?.summary">{{ node.fallback.summary }}</p>
    <ul v-if="node.fallback?.items?.length">
      <li v-for="(item, index) in node.fallback.items" :key="`${index}-${item}`">{{ item }}</li>
    </ul>
    <dl v-if="node.fallback?.artifact_refs?.length">
      <div v-for="artifact in node.fallback.artifact_refs" :key="`${artifact.label}-${artifact.uri}`">
        <dt>{{ artifact.label }}</dt>
        <dd>{{ artifact.uri }}</dd>
      </div>
    </dl>
    <small v-if="unavailable && reason">{{ reason }}</small>
  </section>
</template>

<style scoped>
.generative-ui-fallback {
  display: grid;
  gap: 10px;
  min-height: 100%;
  border: 1px solid var(--hr-border);
  border-radius: 14px;
  background: var(--hr-panel);
  padding: 14px;
  color: var(--hr-text-1);
}

.generative-ui-fallback--unavailable {
  border-color: var(--hr-warning-border);
}

.generative-ui-fallback header,
.generative-ui-fallback dl > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.generative-ui-fallback header span {
  color: var(--hr-accent);
  font-size: 11px;
  font-weight: 850;
  text-transform: uppercase;
}

.generative-ui-fallback header em,
.generative-ui-fallback small,
.generative-ui-fallback dd {
  overflow-wrap: anywhere;
  color: var(--hr-text-3);
  font-size: 10px;
  font-style: normal;
}

.generative-ui-fallback h3,
.generative-ui-fallback p,
.generative-ui-fallback ul,
.generative-ui-fallback dl,
.generative-ui-fallback dd {
  margin: 0;
}

.generative-ui-fallback h3 {
  font-size: 16px;
}

.generative-ui-fallback p,
.generative-ui-fallback li {
  font-size: 13px;
  line-height: 1.55;
}

.generative-ui-fallback dl {
  display: grid;
  gap: 6px;
}
</style>
