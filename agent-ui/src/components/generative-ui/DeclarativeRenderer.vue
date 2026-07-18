<script setup lang="ts">
import { computed } from 'vue'
import type { GenerativeUiStoredNodeV1, HomerailDeclarativeRendererV1 } from 'homerail-protocol'
import { buildDeclarativeRendererModel } from '@/generative-ui/declarative-renderer'

const props = defineProps<{ node: GenerativeUiStoredNodeV1; document: HomerailDeclarativeRendererV1 }>()
const model = computed(() => buildDeclarativeRendererModel(props.document, props.node.content))
</script>

<template>
  <section class="declarative-renderer" data-testid="generative-ui-declarative-renderer">
    <header>
      <h2>{{ model.title }}</h2>
      <p v-if="model.subtitle">{{ model.subtitle }}</p>
    </header>
    <div v-if="model.sections.length" class="declarative-renderer__sections">
      <section v-for="section in model.sections" :key="section.id" :data-section-type="section.type">
        <h3 v-if="section.label">{{ section.label }}</h3>
        <p v-if="section.type === 'text'" class="declarative-renderer__text" :style="{ '--max-lines': section.max_lines }">
          {{ section.text }}
        </p>
        <ol v-else-if="section.type === 'list'" class="declarative-renderer__list">
          <li v-for="(item, index) in section.items" :key="`${item.title}:${index}`">
            <div><strong>{{ item.title }}</strong><p v-if="item.detail">{{ item.detail }}</p></div>
            <span v-if="item.badge">{{ item.badge }}</span>
          </li>
        </ol>
        <dl v-else-if="section.type === 'metrics'" class="declarative-renderer__metrics">
          <div v-for="item in section.items" :key="item.label"><dt>{{ item.label }}</dt><dd>{{ item.value }}</dd></div>
        </dl>
        <ul v-else class="declarative-renderer__links">
          <li v-for="item in section.items" :key="item.uri"><a :href="item.uri" target="_blank" rel="noopener noreferrer">{{ item.label }}</a></li>
        </ul>
      </section>
    </div>
    <p v-else class="declarative-renderer__empty">{{ model.empty_message }}</p>
  </section>
</template>

<style scoped>
.declarative-renderer { display:grid; gap:14px; min-width:0; border:1px solid var(--hr-accent-border); border-radius:18px; background:linear-gradient(145deg,var(--hr-panel),var(--hr-bg-raised)); padding:16px; color:var(--hr-text-1); }
header h2, section h3, p, ol, ul, dl { margin:0; }
header h2 { font-size:16px; font-weight:800; }
header p { margin-top:5px; color:var(--hr-text-2); font-size:13px; white-space:pre-wrap; }
.declarative-renderer__sections { display:grid; gap:13px; }
.declarative-renderer__sections > section { display:grid; gap:7px; }
.declarative-renderer__sections h3 { color:var(--hr-accent); font-size:11px; text-transform:uppercase; letter-spacing:.08em; }
.declarative-renderer__text { display:-webkit-box; overflow:hidden; color:var(--hr-text-2); white-space:pre-wrap; -webkit-box-orient:vertical; -webkit-line-clamp:var(--max-lines); }
.declarative-renderer__list,.declarative-renderer__links { display:grid; gap:7px; padding:0; list-style:none; }
.declarative-renderer__list li { display:flex; justify-content:space-between; gap:12px; border-radius:11px; background:var(--hr-surface-1); padding:9px 10px; }
.declarative-renderer__list strong { font-size:13px; }
.declarative-renderer__list p { margin-top:3px; color:var(--hr-text-3); font-size:12px; }
.declarative-renderer__list span { align-self:start; border-radius:999px; background:var(--hr-accent-soft); padding:3px 7px; color:var(--hr-accent); font-size:10px; }
.declarative-renderer__metrics { display:grid; grid-template-columns:repeat(auto-fit,minmax(100px,1fr)); gap:8px; }
.declarative-renderer__metrics div { border-radius:11px; background:var(--hr-surface-1); padding:9px; }
.declarative-renderer__metrics dt { color:var(--hr-text-3); font-size:10px; }
.declarative-renderer__metrics dd { margin:3px 0 0; font-size:16px; font-weight:800; }
.declarative-renderer__links a { color:var(--hr-accent); font-size:12px; text-decoration:underline; text-underline-offset:3px; }
.declarative-renderer__empty { color:var(--hr-text-4); font-size:12px; }
</style>
