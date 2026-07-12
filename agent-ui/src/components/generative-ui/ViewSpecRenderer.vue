<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { buildHomerailViewModel, type GenerativeUiCompositionItemV1, type GenerativeUiStoredNodeV1, type GenerativeUiSurfaceContextV1 } from 'homerail-protocol'
import ViewSpecNode from './ViewSpecNode'

const props = defineProps<{
  node: GenerativeUiStoredNodeV1
  placement: GenerativeUiCompositionItemV1
  context: GenerativeUiSurfaceContextV1
}>()
const emit = defineEmits<{ (event: 'request-action', actionId: string): void }>()
const { locale } = useI18n()
const model = computed(() => {
  if (!props.node.view) throw new Error(`Generated View node has no ViewSpec: ${props.node.id}`)
  return buildHomerailViewModel(props.node.view, props.node.content, { locale: locale.value })
})
</script>

<template>
  <section class="homerail-view-spec" :data-variant="placement.variant" :data-viewport="context.viewport">
    <ViewSpecNode :model="model.root" :compact="context.viewport === 'compact'" @request-action="emit('request-action', $event)" />
  </section>
</template>

<style>
.homerail-view-spec { --hr-gap-xs:4px; --hr-gap-sm:8px; --hr-gap-md:14px; --hr-gap-lg:20px; min-width:0; min-height:100%; color:#edf8f7; }
.hr-view__node { min-width:0; }
.hr-view__stack,.hr-view__repeat { display:grid; align-content:start; }
.hr-view__grid { display:grid; grid-template-columns:repeat(var(--columns),minmax(0,1fr)); align-content:start; }
.hr-view__node[data-gap="none"] { gap:0; }.hr-view__node[data-gap="xs"] { gap:var(--hr-gap-xs); }.hr-view__node[data-gap="sm"] { gap:var(--hr-gap-sm); }.hr-view__node[data-gap="md"] { gap:var(--hr-gap-md); }.hr-view__node[data-gap="lg"] { gap:var(--hr-gap-lg); }
.hr-view__node[data-align="start"] { align-items:start; }.hr-view__node[data-align="center"] { align-items:center; }.hr-view__node[data-align="end"] { align-items:end; }.hr-view__node[data-align="stretch"] { align-items:stretch; }
.hr-view__section { display:grid; gap:11px; border-top:1px solid rgba(255,255,255,.09); padding-top:12px; }
.hr-view__section > header { color:#6fe3d9; font-size:10px; font-weight:850; text-transform:uppercase; }
.hr-view__heading { margin:0; color:#f7ffff; line-height:1.14; letter-spacing:0; text-wrap:balance; }.hr-view__heading:is(h1) { font-size:28px; }.hr-view__heading:is(h2) { font-size:21px; }.hr-view__heading:is(h3) { font-size:15px; }
.hr-view__text,.hr-view__markdown { display:-webkit-box; margin:0; overflow:hidden; color:rgba(222,239,237,.72); font-size:12px; line-height:1.58; white-space:pre-wrap; -webkit-box-orient:vertical; -webkit-line-clamp:var(--max-lines); }
.hr-view__markdown > :first-child { margin-top:0; }.hr-view__markdown > :last-child { margin-bottom:0; }.hr-view__markdown a { color:#75ded6; }
.hr-view__icon { display:grid; place-items:center; width:34px; height:34px; border:1px solid rgba(255,255,255,.1); border-radius:7px; color:#91aaa7; background:rgba(255,255,255,.035); }
.hr-view__badge { display:inline-flex; width:max-content; align-items:center; border:1px solid rgba(255,255,255,.1); border-radius:999px; padding:4px 8px; color:#bcd0ce; background:rgba(255,255,255,.04); font-size:9px; font-weight:800; }
.hr-view__node[data-tone="positive"] { --tone:#45d5a4; }.hr-view__node[data-tone="info"] { --tone:#5ed9cf; }.hr-view__node[data-tone="warning"] { --tone:#efb34f; }.hr-view__node[data-tone="critical"] { --tone:#f17478; }.hr-view__node[data-tone="neutral"] { --tone:#91aaa7; }
.hr-view__badge,.hr-view__icon { border-color:color-mix(in srgb,var(--tone) 34%,transparent); color:var(--tone); }
.hr-view__divider { width:100%; margin:0; border:0; border-top:1px solid rgba(255,255,255,.08); }
.hr-view__metric { display:grid; min-height:78px; align-content:center; border:1px solid rgba(255,255,255,.08); border-left:3px solid var(--tone); border-radius:7px; padding:10px 12px; background:rgba(255,255,255,.025); }
.hr-view__metric span { color:rgba(207,228,225,.52); font-size:9px; }.hr-view__metric strong { margin-top:3px; color:#f7ffff; font-size:21px; }.hr-view__metric small { margin-left:4px; color:rgba(215,233,231,.56); font-size:9px; }
.hr-view__progress { display:grid; gap:7px; }.hr-view__progress > header { display:flex; justify-content:space-between; gap:10px; color:rgba(219,237,235,.64); font-size:10px; }.hr-view__progress-track { height:5px; overflow:hidden; border-radius:999px; background:rgba(255,255,255,.08); }.hr-view__progress-track i { display:block; height:100%; border-radius:inherit; background:var(--tone); transition:width .25s ease; }
.hr-view__list,.hr-view__timeline { display:grid; gap:7px; margin:0; padding:0; list-style:none; }.hr-view__list li { display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:8px; align-items:center; border-bottom:1px solid rgba(255,255,255,.06); padding:8px 1px; }.hr-view__list li > i { width:7px; height:7px; border-radius:999px; background:var(--tone,#91aaa7); }.hr-view__list strong,.hr-view__list p { margin:0; }.hr-view__list strong { font-size:11px; }.hr-view__list p { margin-top:2px; color:rgba(208,228,225,.52); font-size:9px; }.hr-view__list li > span { border-radius:999px; padding:3px 6px; color:rgba(221,238,236,.6); background:rgba(255,255,255,.05); font-size:8px; }
.hr-view__table-scroll { overflow:auto; border:1px solid rgba(255,255,255,.08); border-radius:7px; }.hr-view__table { width:100%; border-collapse:collapse; font-size:10px; }.hr-view__table th,.hr-view__table td { padding:9px 10px; border-bottom:1px solid rgba(255,255,255,.06); text-align:left; white-space:nowrap; }.hr-view__table th { color:#70ddd4; font-size:8px; text-transform:uppercase; }.hr-view__table td { color:rgba(226,241,239,.72); }
.hr-view__timeline li { position:relative; display:grid; grid-template-columns:auto minmax(0,1fr); gap:4px 10px; padding:4px 0 10px; }.hr-view__timeline li > i { grid-row:1 / span 2; width:9px; height:9px; margin-top:3px; border:2px solid var(--tone,#91aaa7); border-radius:999px; }.hr-view__timeline time { color:rgba(201,224,221,.45); font-size:8px; }.hr-view__timeline strong { font-size:11px; }.hr-view__timeline p { margin:3px 0 0; color:rgba(209,228,226,.54); font-size:9px; }
.hr-view__bar_chart { display:grid; gap:8px; }.hr-view__bar_chart > div { display:grid; grid-template-columns:minmax(80px,.7fr) minmax(120px,2fr) auto; gap:9px; align-items:center; font-size:9px; }.hr-view__bar_chart > div > i { height:6px; overflow:hidden; border-radius:999px; background:rgba(255,255,255,.07); }.hr-view__bar_chart > div > i b { display:block; height:100%; border-radius:inherit; background:var(--tone,#5ed9cf); }
.hr-view__action { min-height:34px; border:1px solid rgba(255,255,255,.14); border-radius:6px; padding:0 12px; color:#eafffd; background:rgba(255,255,255,.04); font:inherit; font-size:10px; font-weight:800; cursor:pointer; }.hr-view__action[data-style="primary"] { border-color:rgba(94,217,207,.38); background:rgba(70,190,178,.15); }.hr-view__action[data-style="danger"] { border-color:rgba(241,116,120,.38); color:#ffc7c9; }
.hr-view__disclosure { border-top:1px solid rgba(255,255,255,.08); padding-top:8px; }.hr-view__disclosure summary { color:#dcebea; font-size:10px; font-weight:800; cursor:pointer; }.hr-view__disclosure > div { display:grid; gap:9px; margin-top:9px; }
.hr-view__link { display:inline-flex; width:max-content; align-items:center; gap:6px; color:#70ddd4; font-size:10px; font-weight:750; text-decoration:none; }
.hr-view__dag-scroll { overflow:auto; border:1px solid rgba(255,255,255,.07); border-radius:7px; background-image:linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px); background-size:24px 24px; }.hr-view__dag { position:relative; }.hr-view__dag > svg { position:absolute; inset:0; width:100%; height:100%; }.hr-view__dag > svg > path { fill:none; stroke:rgba(128,158,155,.4); stroke-width:1.5; stroke-dasharray:5 5; animation:hr-view-edge 1.5s linear infinite; }.hr-view__dag marker path { fill:#78918f; }.hr-view__dag-node { position:absolute; display:grid; grid-template-columns:auto minmax(0,1fr); gap:6px; align-content:center; border:1px solid color-mix(in srgb,var(--tone) 45%,rgba(255,255,255,.12)); border-radius:7px; padding:8px 9px 11px; background:rgba(11,21,22,.96); }.hr-view__dag-node > svg { color:var(--tone); }.hr-view__dag-node strong,.hr-view__dag-node span { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.hr-view__dag-node strong { font-size:10px; }.hr-view__dag-node span { margin-top:2px; color:rgba(204,224,221,.52); font-size:8px; }.hr-view__dag-node > i { position:absolute; right:9px; bottom:6px; left:9px; height:2px; overflow:hidden; background:rgba(255,255,255,.07); }.hr-view__dag-node > i b { display:block; width:var(--progress); height:100%; background:var(--tone); }
@keyframes hr-view-edge { to { stroke-dashoffset:-20; } }
.homerail-view-spec[data-viewport="compact"] .hr-view__grid { grid-template-columns:repeat(var(--compact-columns),minmax(0,1fr)); }.homerail-view-spec[data-viewport="compact"] .hr-view__node { grid-column:span 1 !important; }
@media (prefers-reduced-motion:reduce) { .homerail-view-spec * { animation:none !important; transition:none !important; } }
</style>
