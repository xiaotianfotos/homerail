<script setup lang="ts">
/**
 * DagRuntimeOverlay — DAG Runtime 全屏可视化覆盖层（三态状态机）。
 *
 * 三态：run_list（默认）→ dag_graph（焦点导航）→ dag_detail（节点日志抽屉）。
 * 手柄：复用 useDagRuntimeGamepad + voice-gamepad-router intent 模型。
 * 触摸/鼠标：所有操作有大触摸目标，手柄是快捷方式。
 * 渐进返回：○ detail→graph→list→退出。
 */

import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAgentStore } from '@/stores/agent-store'
import { useDagRuntime } from './useDagRuntime'
import { useDagRuntimeGamepad, type DagGamepadEvent, type DagGamepadAnalog } from './useDagRuntimeGamepad'
import { useRunList } from './useRunList'
import DagRuntimeCanvas from './DagRuntimeCanvas.vue'
import DagRuntimeToolbar from './DagRuntimeToolbar.vue'
import DagRuntimeNodeLegend from './DagRuntimeNodeLegend.vue'
import DagNodeDetailDrawer from './DagNodeDetailDrawer.vue'
import DagRunList from './DagRunList.vue'
import { nextDagTraversalNodeId } from './dagTraversal'
import type { VoiceGamepadInputContext } from '@/components/agent/voice-gamepad-router'
import type { VoiceGamepadButtonIntent, VoiceGamepadDirectionIntent } from '@/components/agent/voice-gamepad-router'

type OverlayView = 'run_list' | 'dag_graph'

const props = defineProps<{
  initialRunId?: string
  captureMode?: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

const store = useAgentStore()
const { t } = useI18n()
const { runs, loading: runsLoading, refresh: refreshRuns } = useRunList()

// ── 视图状态 ──────────────────────────────────────────────────
const view = ref<OverlayView>('run_list')
const selectedRunId = ref<string | null>(null)
const focusedRunIndex = ref(0)
const focusedNodeId = ref<string | null>(null)
const selectedNodeId = ref<string | null>(null)
const physicsPaused = ref(Boolean(props.captureMode))
const canvasRef = ref<InstanceType<typeof DagRuntimeCanvas> | null>(null)
const drawerRef = ref<InstanceType<typeof DagNodeDetailDrawer> | null>(null)

// 抽屉双面板状态
type PanelKey = 'task' | 'logs'
const panelFocus = ref<PanelKey>('logs')
const expandedPanels = ref<Set<PanelKey>>(new Set<PanelKey>(['logs']))

const runId = computed(() => selectedRunId.value)
const { metrics, loading: metricsLoading } = useDagRuntime(runId)

const hasDagContext = computed(() => Boolean(
  selectedRunId.value || store.dagExecution || store.nodes.length > 0,
))

// ── gamepad context（决定 intent 映射）─────────────────────────
const gamepadContext = computed<VoiceGamepadInputContext>(() => {
  if (view.value === 'run_list') return 'dag_run_list'
  if (selectedNodeId.value) return 'dag_detail'
  return 'dag_graph'
})

const { gamepadConnected } = useDagRuntimeGamepad(gamepadContext, handleGamepadEvent, handleGamepadAnalog)

// ============================================================================
// 手柄事件分发
// ============================================================================

function handleGamepadEvent(event: DagGamepadEvent): void {
  const intent = event.intent as VoiceGamepadButtonIntent | VoiceGamepadDirectionIntent
  switch (intent) {
    // run list
    case 'run_previous':
      if (view.value === 'run_list') moveRunFocus(-1)
      break
    case 'run_next':
      if (view.value === 'run_list') moveRunFocus(1)
      break
    case 'run_confirm':
      if (view.value === 'run_list') confirmRunFocus()
      break
    // graph node navigation
    case 'node_navigate_up':
      moveNodeFocus('up')
      break
    case 'node_navigate_down':
      moveNodeFocus('down')
      break
    case 'node_navigate_left':
      moveNodeFocus('left')
      break
    case 'node_navigate_right':
      moveNodeFocus('right')
      break
    case 'node_direction':
      if (event.direction) moveNodeFocus(event.direction)
      break
    case 'node_confirm':
      confirmNodeFocus()
      break
    // 抽屉双面板操作（仅 detail 态）
    case 'panel_toggle':
      togglePanel()
      break
    case 'panel_up':
    case 'panel_down':
      switchPanel(intent === 'panel_up' ? -1 : 1)
      break
    // progressive back
    case 'detail_close':
      closeDetail()
      break
    case 'runtime_exit':
      progressiveExit()
      break
    // 全局快捷键：覆盖层内 touchpad 已在覆盖层（忽略避免重复）；
    // menu 打开设置会切到设置页，覆盖层自动隐藏。
    case 'open_runtime':
      break
    case 'open_settings':
      emit('close')
      store.settingsPageOpen = true
      break
  }
}

// ============================================================================
// 手柄连续模拟量（摇杆/扳机）— 每帧调用
// ============================================================================

const PAN_SPEED = 8      // px/frame at full stick deflection
const ZOOM_SPEED = 0.012 // per frame at full trigger
const SCROLL_SPEED = 28  // px/frame at full stick

function handleGamepadAnalog(analog: DagGamepadAnalog): void {
  // 画布 pan + zoom 仅在 dag_graph 态生效
  if (view.value === 'dag_graph') {
    if (analog.panX !== 0 || analog.panY !== 0) {
      canvasRef.value?.applyPan(analog.panX * PAN_SPEED, analog.panY * PAN_SPEED)
    }
    if (analog.zoomIn > 0.05) {
      canvasRef.value?.applyZoom(analog.zoomIn * ZOOM_SPEED)
    } else if (analog.zoomOut > 0.05) {
      canvasRef.value?.applyZoom(-analog.zoomOut * ZOOM_SPEED)
    }
  }
  // 日志滚动仅在 detail 抽屉打开时生效
  if (selectedNodeId.value && analog.scrollY !== 0) {
    drawerRef.value?.scrollBy(analog.scrollY * SCROLL_SPEED)
  }
}

// ============================================================================
// run 列表导航
// ============================================================================

function moveRunFocus(delta: number): void {
  if (!runs.value.length) return
  const len = runs.value.length
  focusedRunIndex.value = (focusedRunIndex.value + delta + len) % len
}

function confirmRunFocus(): void {
  const run = runs.value[focusedRunIndex.value]
  if (run) selectRun(run.runId)
}

let runLoadSequence = 0

function selectRun(runId: string): void {
  selectedRunId.value = runId
  view.value = 'dag_graph'
  focusedNodeId.value = null
  selectedNodeId.value = null
  const sequence = ++runLoadSequence
  void loadSelectedRun(runId, sequence)
}

async function loadSelectedRun(runId: string, sequence: number): Promise<void> {
  await store.switchToRun(runId)
  if (sequence !== runLoadSequence || selectedRunId.value !== runId) return
  if (!store.dagExecution || store.nodes.length === 0) {
    // A short display suffix or unknown id must not masquerade as an idle
    // 0/0 graph. Return to the real run list, where only complete ids can be
    // selected.
    selectedRunId.value = null
    view.value = 'run_list'
    await refreshRuns()
    return
  }
  initNodeFocus()
  await nextTick()
  if (props.captureMode) {
    physicsPaused.value = true
    canvasRef.value?.fitCanvasGraph()
    canvasRef.value?.freezeLayout()
  }
}

// ============================================================================
// 图内焦点导航
// ============================================================================

function initNodeFocus(): void {
  const nodes = store.nodes
  if (!nodes.length) {
    focusedNodeId.value = null
    return
  }
  const running = nodes.find(n => n.status === 'running' || n.status === 'ready' || n.status === 'waiting_for_command')
  const completed = nodes.find(n => n.status === 'completed')
  focusedNodeId.value = (running ?? completed ?? nodes[0]).id
}

function moveNodeFocus(direction: 'up' | 'down' | 'left' | 'right'): void {
  const cur = focusedNodeId.value
  if (!cur) { initNodeFocus(); return }

  if (direction === 'left' || direction === 'right') {
    const nextId = nextDagTraversalNodeId(store.nodes, store.edges, cur, direction === 'left' ? -1 : 1)
    if (nextId) focusedNodeId.value = nextId
    syncSelectedNodeWithFocus()
    return
  }

  const edges = store.edges
  // 上/下保留为局部上游/下游移动。左右键使用全局 DAG 遍历序列，
  // 这样 detail 抽屉里上下键可以留给面板切换。
  const goUpstream = direction === 'up'
  if (goUpstream) {
    // 当前节点作为 target，找 source（前驱）
    const preds = edges.filter(e => e.target === cur).map(e => e.source)
    if (preds.length) focusedNodeId.value = preds[0]
  } else {
    // 当前节点作为 source，找 target（后继）
    const succs = edges.filter(e => e.source === cur).map(e => e.target)
    if (succs.length) focusedNodeId.value = succs[0]
  }
  syncSelectedNodeWithFocus()
}

function syncSelectedNodeWithFocus(): void {
  // 抽屉打开时，焦点切换同步更新选中节点，让抽屉内容跟随。
  if (selectedNodeId.value && focusedNodeId.value !== selectedNodeId.value) {
    selectedNodeId.value = focusedNodeId.value
    store.selectNode(focusedNodeId.value)
  }
}

function confirmNodeFocus(): void {
  if (focusedNodeId.value) {
    selectedNodeId.value = focusedNodeId.value
    store.selectNode(focusedNodeId.value)
    resetPanels()
  }
}

/** 打开抽屉时重置面板：默认聚焦日志并展开 */
function resetPanels(): void {
  panelFocus.value = 'logs'
  expandedPanels.value = new Set<PanelKey>(['logs'])
}

// ── 抽屉双面板操作 ────────────────────────────────────────────

const PANEL_ORDER: PanelKey[] = ['task', 'logs']

/** 方块(■)：展开/折叠当前聚焦的面板 */
function togglePanel(panel = panelFocus.value): void {
  panelFocus.value = panel
  const cur = panel
  const next = new Set(expandedPanels.value)
  if (next.has(cur)) next.delete(cur)
  else next.add(cur)
  expandedPanels.value = next
}

/** dpad↑↓：在两个面板间切换焦点 */
function switchPanel(delta: number): void {
  const idx = PANEL_ORDER.indexOf(panelFocus.value)
  const nextIdx = (idx + delta + PANEL_ORDER.length) % PANEL_ORDER.length
  panelFocus.value = PANEL_ORDER[nextIdx]
  // 切到的面板若未展开，自动展开
  if (!expandedPanels.value.has(panelFocus.value)) {
    expandedPanels.value = new Set(expandedPanels.value).add(panelFocus.value)
  }
}

// ============================================================================
// 渐进返回
// ============================================================================

function closeDetail(): void {
  selectedNodeId.value = null
  store.selectNode(null)
}

function progressiveExit(): void {
  if (selectedNodeId.value) {
    closeDetail()
  } else if (view.value === 'dag_graph') {
    view.value = 'run_list'
    selectedRunId.value = null
    void refreshRuns()
  } else {
    emit('close')
  }
}

// ============================================================================
// 键盘（鼠标用户的快捷键，手柄的补充）
// ============================================================================

function onKeydown(evt: KeyboardEvent): void {
  if (evt.key === 'Escape') {
    progressiveExit()
  } else if (evt.key === 'ArrowUp' && view.value === 'run_list') {
    moveRunFocus(-1)
  } else if (evt.key === 'ArrowDown' && view.value === 'run_list') {
    moveRunFocus(1)
  } else if (evt.key === 'Enter' && view.value === 'run_list') {
    confirmRunFocus()
  }
}

// ============================================================================
// 生命周期
// ============================================================================

watch(physicsPaused, (paused) => {
  if (paused) canvasRef.value?.freezeLayout()
  else canvasRef.value?.wakeLayout()
})

watch(
  () => props.captureMode,
  async (enabled) => {
    if (!enabled) return
    physicsPaused.value = true
    await nextTick()
    canvasRef.value?.freezeLayout()
  },
)

// 列表加载后，焦点默认在第一个（或当前 run）
watch(runs, (list) => {
  if (!list.length) return
  if (store.currentRunId) {
    const idx = list.findIndex(r => r.runId === store.currentRunId)
    focusedRunIndex.value = idx >= 0 ? idx : 0
  } else {
    focusedRunIndex.value = 0
  }
})

// 拓扑变化时重新初始化焦点
watch(() => store.nodes.length, () => {
  if (view.value === 'dag_graph' && !focusedNodeId.value) initNodeFocus()
})

// The store follows a live handoff only when the user was already following
// the active node. Mirror that authoritative selection into the overlay's
// keyboard focus and, when open, the detail drawer.
watch(
  () => store.selectedNodeId,
  (nodeId) => {
    if (view.value !== 'dag_graph') return
    if (!nodeId) {
      if (selectedNodeId.value) selectedNodeId.value = null
      return
    }
    focusedNodeId.value = nodeId
    if (selectedNodeId.value) selectedNodeId.value = nodeId
  },
)

watch(
  () => props.initialRunId,
  (runId) => {
    if (!runId || runId === selectedRunId.value) return
    selectRun(runId)
  },
  { immediate: true },
)

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  if (props.captureMode) {
    await nextTick()
    canvasRef.value?.freezeLayout()
  }
})

onUnmounted(() => {
  runLoadSequence += 1
  window.removeEventListener('keydown', onKeydown)
  store.selectNode(null)
})
</script>

<template>
  <transition name="overlay-zoom">
    <div class="dag-runtime-overlay fixed inset-0 z-[200] flex flex-col overflow-hidden bg-[var(--hr-bg)]">
      <!-- 氛围层 -->
      <div class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_22%_18%,var(--hr-canvas-ambient-primary),transparent_38%),radial-gradient(circle_at_78%_72%,var(--hr-canvas-ambient-secondary),transparent_42%)]" />

      <!-- 顶部工具栏（仅 graph 态显示完整工具栏；list 态显示精简版） -->
      <DagRuntimeToolbar
        :metrics="metrics"
        :view="view"
        :runs-count="runs.length"
        :show-back="view === 'dag_graph'"
        v-model:physics-paused="physicsPaused"
        @close="emit('close')"
        @back="progressiveExit()"
        @fit-view="canvasRef?.fitCanvasGraph()"
      />

      <!-- run 列表态 -->
      <div v-if="view === 'run_list'" class="relative z-10 min-h-0 flex-1 overflow-hidden">
        <DagRunList
          :runs="runs"
          :loading="runsLoading"
          :focused-index="focusedRunIndex"
          :current-run-id="store.currentRunId"
          @select-run="selectRun"
        />
      </div>

      <!-- dag_graph 态 -->
      <template v-else>
        <div class="relative z-10 min-h-0 flex-1">
          <DagRuntimeCanvas
            ref="canvasRef"
            :metrics="metrics"
            :reduced-motion="captureMode"
            :focused-node-id="focusedNodeId"
            :selected-node-id="selectedNodeId"
            @select-node="(id) => { selectedNodeId = id; if (id) { store.selectNode(id); resetPanels() } }"
            @focus-node="(id) => focusedNodeId = id"
          />

          <DagRuntimeNodeLegend />

          <div
            v-if="metricsLoading"
            class="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-[var(--hr-border)] bg-[var(--hr-panel)] px-3 py-1.5 text-[10px] text-[var(--hr-text-3)] backdrop-blur"
          >
            {{ t('dag.overlay.loadingMetrics') }}
          </div>
        </div>

        <!-- 右侧节点详情抽屉 -->
        <DagNodeDetailDrawer
          ref="drawerRef"
          :metrics="metrics"
          :selected-node-id="selectedNodeId"
          :open="Boolean(selectedNodeId)"
          :panel-focus="panelFocus"
          :expanded-panels="expandedPanels"
          @close="closeDetail"
          @toggle-panel="togglePanel"
        />
      </template>

      <!-- 底部操作提示条（手柄连接时显示） -->
      <div
        v-if="gamepadConnected"
        class="pointer-events-none absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-full border border-[var(--hr-border)] bg-[var(--hr-panel)] px-6 py-2.5 text-sm text-[var(--hr-text-2)] backdrop-blur"
      >
        <template v-if="view === 'run_list'">
          {{ t('dag.overlay.runListHelp') }}
        </template>
        <template v-else-if="selectedNodeId">
          {{ t('dag.overlay.detailHelp') }}
        </template>
        <template v-else>
          {{ t('dag.overlay.graphHelp') }}
        </template>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.dag-runtime-overlay {
  box-shadow: var(--hr-shadow-floating);
}

.overlay-zoom-enter-active {
  transition: transform 240ms cubic-bezier(0.22, 1, 0.36, 1), opacity 200ms ease;
}
.overlay-zoom-leave-active {
  transition: transform 160ms cubic-bezier(0.4, 0, 1, 1), opacity 140ms ease;
}
.overlay-zoom-enter-from {
  transform: scale(0.92);
  opacity: 0;
}
.overlay-zoom-leave-to {
  transform: scale(0.96);
  opacity: 0;
}
</style>
