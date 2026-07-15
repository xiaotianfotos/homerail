<script setup lang="ts">
import { computed, ref, toRaw, watch, type Ref } from 'vue'
import type {
  GenerativeUiCompositionItemV1,
  GenerativeUiStoredNodeV1,
  GenerativeUiSurfaceContextV1,
  HomerailA2uiSurfaceV1,
} from 'homerail-protocol'
import { useI18n } from 'vue-i18n'
import {
  a2uiActionNames,
  indexA2uiSurface,
  validateA2uiSurfaceForNode,
  type A2uiRuntime,
} from '@/generative-ui/a2ui'
import type { GenerativeUiPreviewRequestV1 } from '@/generative-ui/types'
import A2uiNode from './A2uiNode'

const props = defineProps<{
  node: GenerativeUiStoredNodeV1
  placement: GenerativeUiCompositionItemV1
  context: GenerativeUiSurfaceContextV1
  expanded?: boolean
  surface?: unknown
}>()

const emit = defineEmits<{
  (event: 'request-action', name: string): void
  (event: 'open-preview', payload: GenerativeUiPreviewRequestV1): void
  (event: 'surface-actions', names: string[]): void
}>()

const { locale } = useI18n()
const resolvedSurface = computed<HomerailA2uiSurfaceV1>(() => validateA2uiSurfaceForNode(
  structuredClone(toRaw(props.surface ?? props.node.a2ui)),
  structuredClone(toRaw(props.node)),
))
const components = computed(() => indexA2uiSurface(resolvedSurface.value))
const dataModel = ref<unknown>(structuredClone(toRaw(props.node.content)))

watch(
  () => `${props.node.id}:${props.node.revision}`,
  () => { dataModel.value = structuredClone(toRaw(props.node.content)) },
)
watch(resolvedSurface, value => emit('surface-actions', [...a2uiActionNames(value)]), { immediate: true })

const runtime = computed<A2uiRuntime>(() => ({
  components: components.value,
  dataModel: dataModel as Ref<unknown>,
  locale: locale.value,
  compact: props.context.viewport === 'compact',
  expanded: props.expanded === true,
  requestAction: name => emit('request-action', name),
  openPreview: preview => emit('open-preview', preview),
}))
const rootScope = computed(() => ({ value: dataModel.value, key: 'root' }))
</script>

<template>
  <section
    class="homerail-a2ui"
    :data-variant="placement.variant"
    :data-device="context.device"
    :data-viewport="context.viewport"
    :data-expanded="expanded ? 'true' : 'false'"
  >
    <A2uiNode
      :key="`${node.id}:${node.revision}`"
      component-id="root"
      :runtime="runtime"
      :scope="rootScope"
    />
  </section>
</template>

<style>
.homerail-a2ui {
  --hr-a2ui-gap-xs: 6px;
  --hr-a2ui-gap-sm: 10px;
  --hr-a2ui-gap-md: 16px;
  --hr-a2ui-gap-lg: 24px;
  --tone: #91aaa7;
  min-width: 0;
  min-height: 100%;
  overflow: visible;
  color: #edf8f7;
  font-size: 14px;
}

.hr-a2ui__node {
  min-width: 0;
}

.hr-a2ui__row,
.hr-a2ui__column,
.hr-a2ui__list {
  display: flex;
  gap: var(--hr-a2ui-gap-sm);
  min-width: 0;
}

.hr-a2ui__row[data-direction='row'],
.hr-a2ui__list[data-direction='row'] {
  flex-flow: row wrap;
}

.hr-a2ui__column[data-direction='column'],
.hr-a2ui__list[data-direction='column'] {
  flex-direction: column;
}

.hr-a2ui__node[data-align='start'] { align-items: flex-start; }
.hr-a2ui__node[data-align='center'] { align-items: center; }
.hr-a2ui__node[data-align='end'] { align-items: flex-end; }
.hr-a2ui__node[data-align='stretch'] { align-items: stretch; }
.hr-a2ui__node[data-justify='start'] { justify-content: flex-start; }
.hr-a2ui__node[data-justify='center'] { justify-content: center; }
.hr-a2ui__node[data-justify='end'] { justify-content: flex-end; }
.hr-a2ui__node[data-justify='spaceBetween'] { justify-content: space-between; }
.hr-a2ui__node[data-justify='spaceAround'] { justify-content: space-around; }
.hr-a2ui__node[data-justify='spaceEvenly'] { justify-content: space-evenly; }
.hr-a2ui__node[data-justify='stretch'] { justify-content: stretch; }

.hr-a2ui__text {
  min-width: 0;
  overflow-wrap: anywhere;
  color: rgba(222, 239, 237, 0.8);
  line-height: 1.6;
}

.hr-a2ui__text > :first-child { margin-top: 0; }
.hr-a2ui__text > :last-child { margin-bottom: 0; }
.hr-a2ui__text :is(h1, h2, h3, h4, h5) {
  margin: 0 0 0.5em;
  color: #f7ffff;
  line-height: 1.18;
  letter-spacing: 0;
  text-wrap: balance;
}
.hr-a2ui__text h1 { font-size: 32px; }
.hr-a2ui__text h2 { font-size: 26px; }
.hr-a2ui__text h3 { font-size: 19px; }
.hr-a2ui__text[data-variant='caption'] { color: rgba(208, 228, 225, 0.58); font-size: 12px; }

.hr-a2ui__image,
.hr-a2ui__video {
  display: block;
  width: 100%;
  max-height: 360px;
  border-radius: 7px;
  object-fit: contain;
}
.hr-a2ui__image[data-fit='cover'] { object-fit: cover; }
.hr-a2ui__image[data-fit='fill'] { object-fit: fill; }
.hr-a2ui__image[data-fit='none'] { object-fit: none; }
.hr-a2ui__image[data-fit='scaleDown'] { object-fit: scale-down; }
.hr-a2ui__image[data-variant='icon'] { width: 36px; height: 36px; }
.hr-a2ui__image[data-variant='avatar'] { width: 58px; height: 58px; border-radius: 50%; }
.hr-a2ui__image[data-variant='smallFeature'] { height: 92px; }
.hr-a2ui__image[data-variant='mediumFeature'] { height: 168px; }
.hr-a2ui__image[data-variant='largeFeature'] { height: 248px; }
.hr-a2ui__image[data-variant='header'] { height: 196px; }
.hr-a2ui__image[data-unavailable='true'],
.hr-a2ui__video[data-unavailable='true'] {
  min-height: 72px;
  border: 1px dashed rgba(255, 255, 255, 0.12);
}
.hr-a2ui__audio-player { display: grid; gap: 7px; }
.hr-a2ui__audio-player figcaption { color: rgba(208, 228, 225, 0.62); font-size: 12px; }
.hr-a2ui__audio-player audio { width: 100%; }

.hr-a2ui__icon {
  display: grid;
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 7px;
  color: #91aaa7;
  background: rgba(255, 255, 255, 0.035);
}

.hr-a2ui__card {
  display: grid;
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 7px;
  padding: 14px;
  background: rgba(255, 255, 255, 0.025);
}

.hr-a2ui__tabs { display: grid; gap: 12px; }
.hr-a2ui__tab-list {
  display: flex;
  gap: 4px;
  overflow-x: auto;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.hr-a2ui__tab-list button {
  min-height: 36px;
  border: 0;
  border-bottom: 2px solid transparent;
  padding: 0 10px;
  color: rgba(222, 239, 237, 0.62);
  background: transparent;
  font: inherit;
  cursor: pointer;
}
.hr-a2ui__tab-list button[aria-selected='true'] { border-color: #5ed9cf; color: #f2fffe; }
.hr-a2ui__tab-panel { min-width: 0; }

.hr-a2ui__modal-trigger { display: contents; }
.hr-a2ui__modal-backdrop {
  position: fixed;
  z-index: 1001;
  inset: 0;
  display: grid;
  overflow: auto;
  place-items: center;
  padding: 24px;
  background: rgba(1, 6, 8, 0.78);
}
.hr-a2ui__modal-panel {
  position: relative;
  width: min(640px, 100%);
  max-height: min(720px, calc(100dvh - 48px));
  overflow: auto;
  border: 1px solid rgba(116, 228, 227, 0.24);
  border-radius: 8px;
  padding: 24px;
  background: #0b1517;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.5);
}
.hr-a2ui__modal-close {
  position: absolute;
  top: 8px;
  right: 8px;
  display: grid;
  width: 36px;
  height: 36px;
  place-items: center;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  color: #eafffd;
  background: rgba(255, 255, 255, 0.05);
  cursor: pointer;
}

.hr-a2ui__divider {
  width: 100%;
  margin: 0;
  border: 0;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}
.hr-a2ui__divider[data-axis='vertical'] { width: 1px; min-height: 24px; border-top: 0; border-left: 1px solid rgba(255, 255, 255, 0.08); }

.hr-a2ui__button {
  display: grid;
  gap: 5px;
  width: max-content;
  max-width: 100%;
}
.hr-a2ui__button > button {
  display: inline-flex;
  min-height: 38px;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 6px;
  padding: 0 14px;
  color: #eafffd;
  background: rgba(255, 255, 255, 0.04);
  font: inherit;
  font-size: 13px;
  font-weight: 800;
  cursor: pointer;
}
.hr-a2ui__button[data-variant='primary'] > button { border-color: rgba(94, 217, 207, 0.38); background: rgba(70, 190, 178, 0.15); }
.hr-a2ui__button[data-variant='borderless'] > button { border-color: transparent; color: #70ddd4; background: transparent; }
.hr-a2ui__button > button:disabled { opacity: 0.45; cursor: not-allowed; }
.hr-a2ui__button > button > .hr-a2ui__text > p { margin: 0; color: inherit; line-height: 1.2; }

.hr-a2ui__text-field,
.hr-a2ui__choice-picker,
.hr-a2ui__slider,
.hr-a2ui__date-time-input {
  display: grid;
  gap: 7px;
  color: rgba(222, 239, 237, 0.74);
  font-size: 12px;
}
.hr-a2ui__choice-picker {
  min-width: 0;
  margin: 0;
  border: 0;
  padding: 0;
}
.hr-a2ui__choice-picker legend { margin-bottom: 7px; padding: 0; }
.hr-a2ui__choice-filter {
  width: 100%;
  min-height: 38px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  padding: 8px 10px;
  color: #effffc;
  background: rgba(3, 12, 15, 0.68);
  font: inherit;
}
.hr-a2ui__choice-options { display: flex; flex-wrap: wrap; gap: 7px; }
.hr-a2ui__choice-options label {
  display: inline-flex;
  min-height: 36px;
  align-items: center;
  gap: 7px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  padding: 6px 9px;
  background: rgba(255, 255, 255, 0.025);
  cursor: pointer;
}
.hr-a2ui__choice-picker[data-display-style='chips'] .hr-a2ui__choice-options label {
  border-radius: 999px;
}
.hr-a2ui__choice-picker[data-display-style='chips'] .hr-a2ui__choice-options input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
.hr-a2ui__choice-options label[data-selected='true'] {
  border-color: rgba(94, 217, 207, 0.55);
  color: #edfffd;
  background: rgba(70, 190, 178, 0.16);
}
.hr-a2ui__text-field :is(input, textarea),
.hr-a2ui__choice-picker select,
.hr-a2ui__date-time-input input {
  width: 100%;
  min-height: 38px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  padding: 8px 10px;
  color: #effffc;
  background: rgba(3, 12, 15, 0.68);
  font: inherit;
}
.hr-a2ui__text-field textarea { resize: vertical; }
.hr-a2ui__check-box { display: inline-grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px; align-items: center; }
.hr-a2ui__check-box .hr-a2ui__validation { grid-column: 1 / -1; }
.hr-a2ui__slider { grid-template-columns:minmax(0,1fr) auto; align-items:center; }
.hr-a2ui__slider > span { grid-column: 1 / -1; }
.hr-a2ui__slider input { min-width: 120px; }
.hr-a2ui__validation { color: #f4a1a4; font-size: 11px; line-height: 1.35; }

.hr-a2ui__grid {
  display: grid;
  grid-template-columns: repeat(var(--columns), minmax(0, 1fr));
  align-content: start;
}
.hr-a2ui__node[data-gap='none'] { gap: 0; }
.hr-a2ui__node[data-gap='xs'] { gap: var(--hr-a2ui-gap-xs); }
.hr-a2ui__node[data-gap='sm'] { gap: var(--hr-a2ui-gap-sm); }
.hr-a2ui__node[data-gap='md'] { gap: var(--hr-a2ui-gap-md); }
.hr-a2ui__node[data-gap='lg'] { gap: var(--hr-a2ui-gap-lg); }
.hr-a2ui__grid-item { display: grid; min-width: 0; }
.hr-a2ui__grid[data-compact-columns='3'] .hr-a2ui__image[data-variant='smallFeature'] {
  width: 100%;
  height: auto;
  max-height: 92px;
  aspect-ratio: 1;
}

.hr-a2ui__section {
  display: grid;
  gap: 11px;
  border-top: 1px solid rgba(255, 255, 255, 0.09);
  padding-top: 12px;
}
.hr-a2ui__section > header { color: #6fe3d9; font-size: 12px; font-weight: 850; text-transform: uppercase; }

.homerail-a2ui [data-tone='positive'] { --tone: #45d58a; }
.homerail-a2ui [data-tone='info'] { --tone: #59b8ff; }
.homerail-a2ui [data-tone='warning'] { --tone: #efb34f; }
.homerail-a2ui [data-tone='critical'] { --tone: #f17478; }
.homerail-a2ui [data-tone='neutral'] { --tone: #91aaa7; }

.hr-a2ui__metric {
  display: grid;
  min-height: 92px;
  align-content: center;
  border: 1px solid color-mix(in srgb, var(--tone) 24%, rgba(255, 255, 255, 0.08));
  border-left: 3px solid var(--tone);
  border-radius: 7px;
  padding: 12px 14px;
  background: color-mix(in srgb, var(--tone) 8%, rgba(255, 255, 255, 0.025));
}
.hr-a2ui__metric span { color: rgba(207, 228, 225, 0.56); font-size: 12px; }
.hr-a2ui__metric strong { margin-top: 4px; color: #f7ffff; font-size: 28px; }
.hr-a2ui__metric small { margin-left: 5px; color: rgba(215, 233, 231, 0.6); font-size: 11px; }

.hr-a2ui__status-badge {
  display: inline-flex;
  width: max-content;
  max-width: 100%;
  align-items: center;
  border: 1px solid color-mix(in srgb, var(--tone) 34%, transparent);
  border-radius: 999px;
  padding: 5px 9px;
  overflow-wrap: anywhere;
  color: var(--tone);
  background: color-mix(in srgb, var(--tone) 10%, rgba(255, 255, 255, 0.04));
  font-size: 11px;
  font-weight: 800;
}

.hr-a2ui__progress { display: grid; gap: 9px; }
.hr-a2ui__progress > header { display: flex; justify-content: space-between; gap: 10px; color: rgba(219, 237, 235, 0.68); font-size: 12px; }
.hr-a2ui__progress-track { height: 7px; overflow: hidden; border-radius: 999px; background: rgba(255, 255, 255, 0.08); }
.hr-a2ui__progress-track i { display: block; height: 100%; border-radius: inherit; background: var(--tone); transition: width 0.25s ease; }

.hr-a2ui__step {
  position: relative;
  display: grid;
  grid-template-columns: 38px minmax(0, 1fr);
  gap: 11px;
  --tone: #5ed9cf;
}
.hr-a2ui__step-rail { position: relative; display: flex; justify-content: center; }
.hr-a2ui__step-rail::after {
  position: absolute;
  top: 34px;
  bottom: -18px;
  width: 2px;
  content: '';
  background: color-mix(in srgb, var(--tone) 45%, rgba(255, 255, 255, 0.08));
}
.hr-a2ui__step:last-child .hr-a2ui__step-rail::after { display: none; }
.hr-a2ui__step-rail > span {
  position: relative;
  z-index: 1;
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--tone) 68%, rgba(255, 255, 255, 0.16));
  border-radius: 7px;
  color: var(--tone);
  background: #0a1415;
  font-size: 12px;
  font-weight: 900;
}
.hr-a2ui__step-content { display: grid; min-width: 0; gap: 10px; padding-bottom: 16px; }
.hr-a2ui__step-content > header { display: flex; min-width: 0; align-items: baseline; justify-content: space-between; gap: 10px; }
.hr-a2ui__step-content > header strong { color: #ecf9f7; font-size: 15px; }
.hr-a2ui__step-content > header small { overflow: hidden; color: rgba(210, 229, 227, 0.58); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }

.hr-a2ui__list,
.hr-a2ui__timeline {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.hr-a2ui__list li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; align-items: center; border-bottom: 1px solid rgba(255, 255, 255, 0.06); padding: 10px 1px; }
.hr-a2ui__list li > i { width: 8px; height: 8px; border-radius: 999px; background: var(--tone, #91aaa7); }
.hr-a2ui__list strong,
.hr-a2ui__list p { margin: 0; }
.hr-a2ui__list strong { font-size: 14px; }
.hr-a2ui__list p { margin-top: 3px; color: rgba(208, 228, 225, 0.58); font-size: 12px; }
.hr-a2ui__list li > span { border-radius: 999px; padding: 4px 7px; color: rgba(221, 238, 236, 0.66); background: rgba(255, 255, 255, 0.05); font-size: 10px; }

.hr-a2ui__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
div.hr-a2ui__table { overflow-x: auto; overflow-y: visible; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 7px; }
.hr-a2ui__table th,
.hr-a2ui__table td { padding: 11px 12px; border-bottom: 1px solid rgba(255, 255, 255, 0.06); text-align: left; white-space: nowrap; }
.hr-a2ui__table th { color: #70ddd4; font-size: 11px; text-transform: uppercase; }
.hr-a2ui__table td { color: rgba(226, 241, 239, 0.76); }

.hr-a2ui__timeline li { position: relative; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 11px; padding: 5px 0 12px; }
.hr-a2ui__timeline li > i { grid-row: 1 / span 2; width: 10px; height: 10px; margin-top: 4px; border: 2px solid var(--tone, #91aaa7); border-radius: 999px; }
.hr-a2ui__timeline time { color: rgba(201, 224, 221, 0.5); font-size: 10px; }
.hr-a2ui__timeline strong { font-size: 14px; }
.hr-a2ui__timeline p { margin: 4px 0 0; color: rgba(209, 228, 226, 0.6); font-size: 12px; }

.hr-a2ui__bar-chart { display: grid; gap: 10px; }
.hr-a2ui__bar-chart > div { display: grid; grid-template-columns: minmax(90px, 0.7fr) minmax(120px, 2fr) auto; gap: 10px; align-items: center; font-size: 12px; }
.hr-a2ui__bar-chart > div > i { height: 7px; overflow: hidden; border-radius: 999px; background: rgba(255, 255, 255, 0.07); }
.hr-a2ui__bar-chart > div > i b { display: block; height: 100%; border-radius: inherit; background: var(--tone, #5ed9cf); }

.hr-a2ui__disclosure { border-top: 1px solid rgba(255, 255, 255, 0.08); padding-top: 10px; }
.hr-a2ui__disclosure summary { color: #dcebea; font-size: 13px; font-weight: 800; cursor: pointer; }
.hr-a2ui__disclosure > div { display: grid; gap: 10px; margin-top: 10px; }

.hr-a2ui__artifact {
  position: relative;
  min-height: 160px;
  overflow: hidden;
  border: 1px solid rgba(116, 228, 227, 0.18);
  border-radius: 7px;
  color: #effffc;
  background: rgba(3, 12, 15, 0.7);
}
button.hr-a2ui__artifact { display: grid; width: 100%; padding: 0; text-align: left; cursor: pointer; }
.hr-a2ui__artifact > img { width: 100%; height: 100%; min-height: 160px; max-height: 360px; object-fit: cover; transition: transform 0.24s ease; }
.hr-a2ui__artifact:hover > img { transform: scale(1.015); }
.hr-a2ui__artifact > span { display: grid; gap: 3px; padding: 13px 14px; }
.hr-a2ui__artifact strong { font-size: 15px; }
.hr-a2ui__artifact small,
.hr-a2ui__artifact p { color: rgba(218, 239, 236, 0.66); font-size: 12px; }
div.hr-a2ui__artifact { display: grid; min-height: 220px; grid-template-rows: minmax(0, 1fr) auto; }
.hr-a2ui__artifact iframe { width: 100%; height: 100%; min-height: 180px; border: 0; background: #fff; pointer-events: none; }
.hr-a2ui__artifact > button { display: flex; min-height: 42px; align-items: center; justify-content: center; gap: 8px; border: 0; border-top: 1px solid rgba(116, 228, 227, 0.16); color: #dcfffc; background: rgba(13, 35, 38, 0.94); font: inherit; font-weight: 800; cursor: pointer; }
.hr-a2ui__artifact > p { margin: 0; padding: 0 12px 12px; background: rgba(13, 35, 38, 0.94); }
.hr-a2ui__artifact[data-unavailable='true'] { display: flex; min-height: 92px; align-items: center; gap: 12px; padding: 16px; }

.hr-a2ui__link {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 2px 10px;
  align-items: center;
  border: 1px solid rgba(94, 217, 207, 0.18);
  border-radius: 7px;
  padding: 10px 12px;
  color: #8fe6df;
  background: rgba(70, 190, 178, 0.06);
  text-decoration: none;
}
.hr-a2ui__link > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-weight: 800; white-space: nowrap; }
.hr-a2ui__link > small { grid-column: 1; overflow: hidden; color: rgba(208, 228, 225, 0.58); text-overflow: ellipsis; white-space: nowrap; }
.hr-a2ui__link > svg { grid-column: 2; grid-row: 1 / span 2; transition: transform 0.18s ease; }
.hr-a2ui__link:hover { border-color: rgba(94, 217, 207, 0.42); background: rgba(70, 190, 178, 0.11); }
.hr-a2ui__link:hover > svg { transform: translateX(2px); }
.hr-a2ui__link[data-unavailable='true'] { color: rgba(208, 228, 225, 0.48); }

.homerail-a2ui[data-variant='summary'][data-expanded='false'] button.hr-a2ui__artifact { min-height: 88px; place-items: center; }
.homerail-a2ui[data-variant='summary'][data-expanded='false'] button.hr-a2ui__artifact img { width: auto; height: 88px; min-height: 0; max-width: 100%; max-height: 88px; object-fit: contain; }
.homerail-a2ui[data-expanded='true'] { height: 100%; }
.homerail-a2ui[data-expanded='true'] div.hr-a2ui__artifact { min-height: max(520px, calc(100dvh - 190px)); }
.homerail-a2ui[data-expanded='true'] button.hr-a2ui__artifact { min-height: 240px; place-items: center; }
.homerail-a2ui[data-expanded='true'] button.hr-a2ui__artifact img { width: auto; height: auto; min-height: 0; max-width: 100%; max-height: min(52dvh, 560px); object-fit: contain; }
.homerail-a2ui[data-expanded='true'] .hr-a2ui__artifact iframe { min-height: max(460px, calc(100dvh - 236px)); pointer-events: auto; }

.hr-a2ui__dag-scroll {
  overflow-x: auto;
  overflow-y: hidden;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 7px;
  background-image: linear-gradient(rgba(255, 255, 255, 0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(255, 255, 255, 0.025) 1px, transparent 1px);
  background-size: 24px 24px;
}
.hr-a2ui__dag { position: relative; }
.hr-a2ui__dag > svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.hr-a2ui__dag > svg > path { fill: none; stroke: rgba(128, 158, 155, 0.4); stroke-width: 1.5; stroke-dasharray: 5 5; animation: hr-a2ui-edge 1.5s linear infinite; }
.hr-a2ui__dag marker path { fill: #78918f; }
.hr-a2ui__dag-node { position: absolute; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 7px; align-content: center; border: 1px solid color-mix(in srgb, var(--tone) 45%, rgba(255, 255, 255, 0.12)); border-radius: 7px; padding: 10px 11px 13px; background: rgba(11, 21, 22, 0.96); }
.hr-a2ui__dag-node > svg { color: var(--tone); }
.hr-a2ui__dag-node strong,
.hr-a2ui__dag-node span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hr-a2ui__dag-node strong { font-size: 13px; }
.hr-a2ui__dag-node span { margin-top: 3px; color: rgba(204, 224, 221, 0.58); font-size: 11px; }
.hr-a2ui__dag-node > i { position: absolute; right: 10px; bottom: 7px; left: 10px; height: 3px; overflow: hidden; background: rgba(255, 255, 255, 0.07); }
.hr-a2ui__dag-node > i b { display: block; width: var(--progress); height: 100%; background: var(--tone); }
@keyframes hr-a2ui-edge { to { stroke-dashoffset: -20; } }

@container generative-ui-block (max-width: 420px) {
  .homerail-a2ui {
    --hr-a2ui-gap-sm: 8px;
    --hr-a2ui-gap-md: 12px;
    --hr-a2ui-gap-lg: 16px;
    font-size: 13px;
  }

  .hr-a2ui__text h1 { font-size: 24px; }
  .hr-a2ui__text h2 { font-size: 21px; }
  .hr-a2ui__text h3 { font-size: 17px; }
  .hr-a2ui__card { padding: 10px; }
  .hr-a2ui__metric strong { font-size: 23px; }
  .hr-a2ui__list li { gap: 7px; padding-block: 8px; }
  .hr-a2ui__image[data-variant='mediumFeature'] { height: 132px; }
  .hr-a2ui__image[data-variant='largeFeature'] { height: 180px; }
  .hr-a2ui__image[data-variant='header'] { height: 150px; }
}

@container generative-ui-block (min-width: 760px) {
  .homerail-a2ui {
    --hr-a2ui-gap-sm: 12px;
    --hr-a2ui-gap-md: 20px;
    --hr-a2ui-gap-lg: 28px;
    font-size: 15px;
  }

  .hr-a2ui__text h1 { font-size: 36px; }
  .hr-a2ui__text h2 { font-size: 29px; }
  .hr-a2ui__text h3 { font-size: 21px; }
}

@container generative-ui-block (max-height: 360px) {
  .homerail-a2ui {
    --hr-a2ui-gap-sm: 7px;
    --hr-a2ui-gap-md: 10px;
    --hr-a2ui-gap-lg: 14px;
  }

  .hr-a2ui__card { padding: 9px; }
  .hr-a2ui__list li { padding-block: 7px; }
  .hr-a2ui__image,
  .hr-a2ui__video { max-height: 180px; }
}

.homerail-a2ui[data-viewport='compact'] .hr-a2ui__grid { grid-template-columns: repeat(var(--compact-columns), minmax(0, 1fr)); }
.homerail-a2ui[data-viewport='compact'] .hr-a2ui__grid-item { grid-column: span 1 !important; }
.homerail-a2ui[data-viewport='compact'] .hr-a2ui__grid[data-compact-columns='2'] > .hr-a2ui__grid-item:last-child:nth-child(odd) { grid-column: 1 / -1 !important; }
.homerail-a2ui[data-viewport='compact'] .hr-a2ui__bar-chart > div { grid-template-columns: minmax(70px, 1fr) minmax(84px, 1.4fr) auto; }
.homerail-a2ui[data-viewport='compact'] .hr-a2ui__text h1 { font-size: 27px; }
.homerail-a2ui[data-viewport='compact'] .hr-a2ui__text h2 { font-size: 23px; }
.homerail-a2ui[data-viewport='compact'] .hr-a2ui__text h3 { font-size: 18px; }
.homerail-a2ui[data-viewport='compact'] .hr-a2ui__step { grid-template-columns: 32px minmax(0, 1fr); gap: 8px; }
.homerail-a2ui[data-viewport='compact'] .hr-a2ui__step-rail > span { width: 27px; height: 27px; }
.homerail-a2ui[data-viewport='compact'] .hr-a2ui__grid[data-compact-columns='3'] .hr-a2ui__image[data-variant='smallFeature'] { max-height: 82px; }

@media (max-width: 520px) {
  .hr-a2ui__modal-backdrop { padding: 10px; place-items: end stretch; }
  .hr-a2ui__modal-panel { max-height: calc(100dvh - 20px); padding: 20px 16px; }
  .hr-a2ui__button,
  .hr-a2ui__button > button { width: 100%; }
}

@media (prefers-reduced-motion: reduce) {
  .homerail-a2ui * { animation: none !important; transition: none !important; }
}
</style>
