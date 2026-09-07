import { describe, expect, it, vi } from 'vitest'

import {
  HomeRailUiWidgetRegistry,
  type HomeRailUiWidgetDescriptor,
} from './widget-registry'

function descriptor(input: Partial<HomeRailUiWidgetDescriptor> = {}): HomeRailUiWidgetDescriptor {
  return {
    document_id: 'document-one',
    document_revision: 3,
    widget_id: 'widget-one',
    widget_revision: 7,
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
    action_count: 2,
    ...input,
  }
}

describe('HomeRail UI widget registry', () => {
  it('lists bounded stable identities and operates through host callbacks', () => {
    const registry = new HomeRailUiWidgetRegistry()
    let state = descriptor()
    const focus = vi.fn(() => { state = { ...state, focused: true } })
    const setExpanded = vi.fn((expanded: boolean) => { state = { ...state, expanded } })
    const remove = registry.register({
      document_id: state.document_id,
      widget_id: state.widget_id,
      describe: () => state,
      focus,
      setExpanded,
    })
    const target = {
      document_id: 'document-one',
      document_revision: 3,
      widget_id: 'widget-one',
      widget_revision: 7,
    }

    expect(registry.snapshot()).toMatchObject({
      widgets: [state],
      widgets_truncated: false,
      ambiguous_widget_count: 0,
    })
    expect(registry.focus(target)).toMatchObject({ focused: true })
    expect(focus).toHaveBeenCalledOnce()
    expect(registry.setExpanded(target, true)).toMatchObject({ expanded: true })
    expect(setExpanded).toHaveBeenCalledWith(true)

    remove()
    expect(registry.snapshot().widgets).toEqual([])
    expect(() => registry.describe(target)).toThrow(/not currently rendered/)
  })

  it('rejects stale revisions before any presentation side effect', () => {
    const registry = new HomeRailUiWidgetRegistry()
    const focus = vi.fn()
    const setExpanded = vi.fn()
    registry.register({
      document_id: 'document-one',
      widget_id: 'widget-one',
      describe: () => descriptor(),
      focus,
      setExpanded,
    })
    const stale = {
      document_id: 'document-one',
      document_revision: 2,
      widget_id: 'widget-one',
      widget_revision: 6,
    }

    expect(() => registry.focus(stale)).toThrow(/revision is stale/)
    expect(() => registry.setExpanded(stale, true)).toThrow(/revision is stale/)
    expect(focus).not.toHaveBeenCalled()
    expect(setExpanded).not.toHaveBeenCalled()
  })

  it('marks the action committed before a post-action descriptor check fails', () => {
    const registry = new HomeRailUiWidgetRegistry()
    let state = descriptor()
    const committed = vi.fn()
    registry.register({
      document_id: state.document_id,
      widget_id: state.widget_id,
      describe: () => state,
      focus: () => {
        state = { ...state, focused: true, widget_revision: state.widget_revision + 1 }
      },
      setExpanded: vi.fn(),
    })

    expect(() => registry.focus(descriptor(), committed)).toThrow(/revision is stale/)
    expect(committed).toHaveBeenCalledOnce()
  })

  it('fails closed when the same canonical identity is rendered twice', () => {
    const registry = new HomeRailUiWidgetRegistry()
    const registration = {
      document_id: 'document-one',
      widget_id: 'widget-one',
      describe: () => descriptor(),
      focus: vi.fn(),
      setExpanded: vi.fn(),
    }
    registry.register(registration)
    registry.register(registration)

    const snapshot = registry.snapshot()
    expect(snapshot.widgets).toEqual([])
    expect(snapshot.ambiguous_widget_count).toBe(1)
    expect(() => registry.describe(descriptor())).toThrow(/identity is ambiguous/)
  })

  it('preserves exact opaque IDs and does not merge whitespace-distinct widgets', () => {
    const registry = new HomeRailUiWidgetRegistry()
    const exact = descriptor({ widget_id: 'widget-one' })
    const spaced = descriptor({ document_id: ' document-one ', widget_id: ' widget-one ' })
    const exactFocus = vi.fn(() => {})
    const spacedFocus = vi.fn(() => {})
    registry.register({
      document_id: exact.document_id,
      widget_id: exact.widget_id,
      describe: () => ({ ...exact, focused: exactFocus.mock.calls.length > 0 }),
      focus: exactFocus,
      setExpanded: vi.fn(),
    })
    registry.register({
      document_id: spaced.document_id,
      widget_id: spaced.widget_id,
      describe: () => ({ ...spaced, focused: spacedFocus.mock.calls.length > 0 }),
      focus: spacedFocus,
      setExpanded: vi.fn(),
    })

    expect(registry.snapshot()).toMatchObject({
      widgets: [
        { document_id: ' document-one ', widget_id: ' widget-one ' },
        { document_id: 'document-one', widget_id: 'widget-one' },
      ],
      ambiguous_widget_count: 0,
    })
    registry.focus({
      document_id: spaced.document_id,
      document_revision: spaced.document_revision,
      widget_id: spaced.widget_id,
      widget_revision: spaced.widget_revision,
    })
    expect(spacedFocus).toHaveBeenCalledOnce()
    expect(exactFocus).not.toHaveBeenCalled()
  })

  it('sorts identities and reports truncation without selector-like lookup', () => {
    const registry = new HomeRailUiWidgetRegistry()
    for (const widgetId of ['widget-z', 'widget-a', 'widget-m']) {
      registry.register({
        document_id: 'document-one',
        widget_id: widgetId,
        describe: () => descriptor({ widget_id: widgetId }),
        focus: vi.fn(),
        setExpanded: vi.fn(),
      })
    }

    expect(registry.snapshot(2)).toMatchObject({
      widgets: [
        { widget_id: 'widget-a' },
        { widget_id: 'widget-m' },
      ],
      widgets_truncated: true,
    })
  })
})
