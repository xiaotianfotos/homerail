import { describe, expect, it, vi } from 'vitest'

import {
  createAgentUiSurfaceController,
  executeHomeRailUiTool,
  resolveDagRunTarget,
  type BrowserToolRunSummary,
  type HomeRailUiSurfaceController,
} from './ui-surface-controller'
import type { HomeRailUiWidgetDescriptor, HomeRailUiWidgetTarget } from './widget-registry'

const widget: HomeRailUiWidgetDescriptor = {
  document_id: 'document-one',
  document_revision: 4,
  widget_id: 'widget-one',
  widget_revision: 2,
  kind: 'com.homerail.test/card',
  render_state: 'stable',
  status_phase: 'ready',
  renderer_resolution: 'specialized',
  placement: 'primary',
  visible: true,
  focused: false,
  expanded: false,
  collapsed: false,
  focusable: true,
  expandable: true,
  action_count: 0,
}

function widgetMethods() {
  return {
    describeWidget: vi.fn(() => widget),
    focusWidget: vi.fn(() => ({ ...widget, focused: true })),
    setWidgetExpanded: vi.fn((_target: HomeRailUiWidgetTarget, expanded: boolean) => ({ ...widget, expanded })),
  }
}

const runs: BrowserToolRunSummary[] = [
  { runId: 'run-001', workflowId: 'sync', workflowName: 'Data Sync', status: 'active' },
  { runId: 'run-002', workflowId: 'review', workflowName: 'PR Review', status: 'completed' },
  { runId: 'run-003', workflowId: 'sync-nightly', workflowName: 'Data Sync Nightly', status: 'waiting' },
]

describe('HomeRail UI surface controller', () => {
  it('reports the actual list/graph overlay state instead of a stale current run', () => {
    const store = {
      runtimeOverlayOpen: true,
      runtimeOverlayView: 'run_list',
      runtimeOverlayRunId: null,
      currentRunId: 'previous-run',
      settingsPageOpen: false,
      openRuntimeOverlay: vi.fn(),
      closeRuntimeOverlay: vi.fn(),
    }
    const controller = createAgentUiSurfaceController(store as never)
    expect(controller.getState()).toEqual({
      active_surface: 'dag_status',
      dag_run_id: null,
      dag_status_view: 'run_list',
      widgets: [],
      widgets_truncated: false,
      ambiguous_widget_count: 0,
    })

    store.runtimeOverlayView = 'dag_graph'
    store.runtimeOverlayRunId = 'selected-run'
    expect(controller.getState()).toMatchObject({
      dag_run_id: 'selected-run',
      dag_status_view: 'dag_graph',
    })
  })

  it('leaves settings and makes a semantic DAG open visibly reachable', async () => {
    const store = {
      runtimeOverlayOpen: false,
      runtimeOverlayView: 'run_list',
      runtimeOverlayRunId: null,
      currentRunId: null,
      settingsPageOpen: true,
      openRuntimeOverlay: vi.fn(async () => {}),
      closeRuntimeOverlay: vi.fn(),
    }
    const controller = createAgentUiSurfaceController(store as never)

    await controller.openDagStatus('run-002')

    expect(store.settingsPageOpen).toBe(false)
    expect(store.openRuntimeOverlay).toHaveBeenCalledWith('run-002')
  })

  it('keeps settings visible when the target cannot be opened', async () => {
    const store = {
      runtimeOverlayOpen: false,
      runtimeOverlayView: 'run_list',
      runtimeOverlayRunId: null,
      currentRunId: null,
      settingsPageOpen: true,
      openRuntimeOverlay: vi.fn(async () => { throw new Error('DAG run not found') }),
      closeRuntimeOverlay: vi.fn(),
    }
    const controller = createAgentUiSurfaceController(store as never)

    await expect(controller.openDagStatus('missing')).rejects.toThrow('not found')

    expect(store.settingsPageOpen).toBe(true)
  })

  it('resolves exact ids and unique semantic queries without guessing', () => {
    expect(resolveDagRunTarget(runs, { entity_id: 'run-002' })).toBe('run-002')
    expect(resolveDagRunTarget(runs, { query: 'PR Review' })).toBe('run-002')
    expect(resolveDagRunTarget(runs, { query: 'nightly' })).toBe('run-003')
    expect(() => resolveDagRunTarget(runs, { query: 'run-00' })).toThrow(/ambiguous/)
    expect(() => resolveDagRunTarget(runs, { query: 'missing' })).toThrow(/No DAG run matches/)
    expect(() => resolveDagRunTarget(runs, { entity_id: 'run-404' })).toThrow(/not found/)
  })

  it('opens and closes the DAG status surface through semantic actions', async () => {
    let active = false
    let selected: string | null = null
    const controller: HomeRailUiSurfaceController = {
      getState: () => ({
        active_surface: active ? 'dag_status' : null,
        dag_run_id: selected,
        dag_status_view: active ? (selected ? 'dag_graph' : 'run_list') : null,
        widgets: [],
        widgets_truncated: false,
        ambiguous_widget_count: 0,
      }),
      listDagRuns: vi.fn(async () => runs),
      openDagStatus: vi.fn(async (runId?: string) => {
        active = true
        selected = runId ?? null
      }),
      closeDagStatus: vi.fn(() => {
        active = false
        selected = null
      }),
      ...widgetMethods(),
    }

    const opened = await executeHomeRailUiTool('ui_open_surface', {
      surface: 'dag_status',
      query: 'PR Review',
    }, controller)
    expect(controller.openDagStatus).toHaveBeenCalledWith('run-002')
    expect(opened).toMatchObject({ ok: true, surface: 'dag_status', dag_run_id: 'run-002' })

    const closed = await executeHomeRailUiTool('ui_close_surface', {
      surface: 'dag_status',
    }, controller)
    expect(controller.closeDagStatus).toHaveBeenCalledOnce()
    expect(closed).toMatchObject({ ok: true, state: { active_surface: null } })
  })

  it('describes, focuses, and expands only an exact widget revision', async () => {
    const methods = widgetMethods()
    const controller: HomeRailUiSurfaceController = {
      getState: vi.fn(() => ({
        active_surface: null,
        dag_run_id: null,
        dag_status_view: null,
        widgets: [widget],
        widgets_truncated: false,
        ambiguous_widget_count: 0,
      })),
      listDagRuns: vi.fn(async () => runs),
      openDagStatus: vi.fn(async () => {}),
      closeDagStatus: vi.fn(),
      ...methods,
    }
    const target = {
      document_id: 'document-one',
      document_revision: 4,
      widget_id: 'widget-one',
      widget_revision: 2,
    }

    await expect(executeHomeRailUiTool('ui_describe_widget', target, controller))
      .resolves.toMatchObject({ ok: true, widget: { widget_id: 'widget-one' } })
    await expect(executeHomeRailUiTool('ui_focus_widget', target, controller))
      .resolves.toMatchObject({ ok: true, widget: { focused: true } })
    await expect(executeHomeRailUiTool('ui_set_widget_expanded', {
      ...target,
      expanded: true,
    }, controller)).resolves.toMatchObject({ ok: true, widget: { expanded: true } })
    expect(methods.describeWidget).toHaveBeenCalledWith(target)
    expect(methods.focusWidget).toHaveBeenCalledWith(target)
    expect(methods.setWidgetExpanded).toHaveBeenCalledWith(target, true)
  })

  it('propagates the commit boundary into a widget action before post-action failure', async () => {
    const committed = vi.fn()
    const controller: HomeRailUiSurfaceController = {
      getState: vi.fn(() => ({
        active_surface: null,
        dag_run_id: null,
        dag_status_view: null,
        widgets: [widget],
        widgets_truncated: false,
        ambiguous_widget_count: 0,
      })),
      listDagRuns: vi.fn(async () => runs),
      openDagStatus: vi.fn(async () => {}),
      closeDagStatus: vi.fn(),
      describeWidget: vi.fn(() => widget),
      focusWidget: vi.fn((_target, onActionCommitted) => {
        onActionCommitted?.()
        throw new Error('post-action descriptor check failed')
      }),
      setWidgetExpanded: vi.fn(() => widget),
    }

    await expect(executeHomeRailUiTool('ui_focus_widget', {
      document_id: widget.document_id,
      document_revision: widget.document_revision,
      widget_id: widget.widget_id,
      widget_revision: widget.widget_revision,
    }, controller, { onActionCommitted: committed })).rejects.toThrow('post-action descriptor check failed')
    expect(committed).toHaveBeenCalledOnce()
  })

  it.each([
    ['ui_get_state', { extra: true }],
    ['ui_open_surface', { surface: 'dag_status', run_id: 'run-001' }],
    ['ui_open_surface', { surface: 'dag_status', entity_id: 'run-001', query: 'sync' }],
    ['ui_close_surface', { surface: 'dag_status', query: 'sync' }],
    ['ui_focus_widget', {
      document_id: 'document-one',
      document_revision: 4,
      widget_id: 'widget-one',
    }],
    ['ui_set_widget_expanded', {
      document_id: 'document-one',
      document_revision: 4,
      widget_id: 'widget-one',
      widget_revision: 2,
      expanded: 'yes',
    }],
  ])('rejects schema-invalid %s input before any UI side effect', async (name, input) => {
    const methods = widgetMethods()
    const controller: HomeRailUiSurfaceController = {
      getState: vi.fn(() => ({
        active_surface: null,
        dag_run_id: null,
        dag_status_view: null,
        widgets: [],
        widgets_truncated: false,
        ambiguous_widget_count: 0,
      })),
      listDagRuns: vi.fn(async () => runs),
      openDagStatus: vi.fn(async () => {}),
      closeDagStatus: vi.fn(),
      ...methods,
    }

    await expect(executeHomeRailUiTool(name, input, controller)).rejects.toThrow()
    expect(controller.listDagRuns).not.toHaveBeenCalled()
    expect(controller.openDagStatus).not.toHaveBeenCalled()
    expect(controller.closeDagStatus).not.toHaveBeenCalled()
    expect(methods.describeWidget).not.toHaveBeenCalled()
    expect(methods.focusWidget).not.toHaveBeenCalled()
    expect(methods.setWidgetExpanded).not.toHaveBeenCalled()
  })
})
