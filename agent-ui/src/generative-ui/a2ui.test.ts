import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import {
  HOMERAIL_A2UI_CATALOG_ID,
  HOMERAIL_A2UI_PURE_FUNCTIONS,
  type GenerativeUiStoredNodeV1,
} from 'homerail-protocol'
import {
  evaluateA2uiValue,
  isWritableA2uiBinding,
  readA2uiPointer,
  validateA2uiSurfaceForNode,
  writeA2uiBinding,
  type A2uiEvaluationScope,
  type A2uiRuntime,
} from './a2ui'

const dataModel = ref<unknown>({
  title: 'Bound',
  amount: 1234.5,
  form: { name: 'Initial' },
})
const runtime: A2uiRuntime = {
  components: new Map(),
  dataModel,
  locale: 'en-US',
  compact: false,
  expanded: false,
  requestAction: () => undefined,
  openPreview: () => undefined,
}
const scope: A2uiEvaluationScope = {
  value: { name: 'Relative', enabled: true, '@index': 'real field' },
  key: 'item:2',
  index: 2,
}

function call(name: string, args?: Record<string, unknown>): unknown {
  return evaluateA2uiValue({ call: name, ...(args ? { args } : {}) }, runtime, scope)
}

function node(): GenerativeUiStoredNodeV1 {
  return {
    ir_version: 1,
    id: 'node-one',
    kind: 'com.example/a2ui',
    kind_version: 1,
    owner: { id: 'com.example', version: '1.0.0' },
    surface: 'result',
    importance: 'primary',
    content: dataModel.value as Record<string, unknown>,
    actions: [{ id: 'inspect', label: 'Inspect', intent: 'inspect' }],
    fallback: { title: 'A2UI' },
    revision: 1,
    updated_at: '2026-07-14T00:00:00.000Z',
  }
}

describe('A2UI evaluator', () => {
  it('implements every protocol-allowed pure function', () => {
    const testedCalls = new Set([
      '@index', 'and', 'email', 'formatCurrency', 'formatDate', 'formatNumber',
      'formatString', 'length', 'not', 'numeric', 'or', 'pluralize', 'required',
    ])
    expect(new Set(HOMERAIL_A2UI_PURE_FUNCTIONS)).toEqual(testedCalls)

    expect(call('@index', { offset: 1 })).toBe(3)
    expect(call('and', { values: [true, { call: 'not', args: { value: false } }] })).toBe(true)
    expect(call('or', { values: [false, { path: 'enabled' }] })).toBe(true)
    expect(call('not', { value: false })).toBe(true)
    expect(call('email', { value: 'dev@homerail.test' })).toBe(true)
    expect(call('formatCurrency', {
      value: { path: '/amount' }, currency: 'USD', decimals: 1, grouping: false,
    })).toBe('$1234.5')
    expect(call('formatDate', { value: '2026-07-14T08:00:00.000Z', format: 'yyyy' })).toContain('2026')
    expect(call('formatNumber', { value: 1234.56, decimals: 1, grouping: true })).toBe('1,234.6')
    expect(call('formatNumber', { value: 1234.56 })).toBe('1,234.56')
    expect(call('formatNumber', { value: 1234.56, decimals: 99 })).toBe('1,234.560000')
    expect(call('formatCurrency', { value: 1234, currency: 'JPY' })).toBe('¥1,234')
    expect(call('formatString', { value: 'Title: ${/title}' })).toBe('Title: Bound')
    expect(call('length', { value: 'HomeRail', min: 4, max: 10 })).toBe(true)
    expect(call('numeric', { value: 7, min: 1, max: 10 })).toBe(true)
    expect(call('pluralize', { value: 1, one: 'one check', other: 'many checks' })).toBe('one check')
    expect(call('required', { value: 'present' })).toBe(true)
    expect(call('required', { value: '' })).toBe(false)
    expect(call('required', { value: [] })).toBe(false)
    expect(call('required', { value: ['present'] })).toBe(true)
  })

  it('resolves absolute and template-relative JSON Pointers and writes only DataBindings', () => {
    expect(readA2uiPointer('/title', dataModel.value, scope)).toBe('Bound')
    expect(readA2uiPointer('name', dataModel.value, scope)).toBe('Relative')
    expect(readA2uiPointer('@index', dataModel.value, scope)).toBe('real field')
    expect(isWritableA2uiBinding({ path: '/form/name' })).toBe(true)
    expect(isWritableA2uiBinding('literal')).toBe(false)
    expect(isWritableA2uiBinding({ call: 'formatString', args: { value: 'x' } })).toBe(false)
    expect(writeA2uiBinding({ path: '@index' }, 'updated field', dataModel.value, scope)).toBe(true)
    expect(readA2uiPointer('@index', dataModel.value, scope)).toBe('updated field')
    expect(writeA2uiBinding({ path: '/form/name' }, 'Updated', dataModel.value, scope)).toBe(true)
    expect(readA2uiPointer('/form/name', dataModel.value, scope)).toBe('Updated')
  })

  it('requires full protocol validation before indexing canonical or custom surfaces', () => {
    const valid = {
      version: 'v1.0',
      catalogId: HOMERAIL_A2UI_CATALOG_ID,
      components: [{ id: 'root', component: 'Text', text: 'Body', variant: 'body' }],
    }
    expect(validateA2uiSurfaceForNode(valid, node()).components).toHaveLength(1)
    expect(() => validateA2uiSurfaceForNode({
      ...valid,
      components: [{ id: 'root', component: 'Text', text: 'Private heading', variant: 'h1' }],
    }, node())).toThrow(/invalid/)
    expect(() => validateA2uiSurfaceForNode({
      ...valid,
      components: [
        {
          id: 'root', component: 'Button', child: 'label',
          action: { event: { name: 'inspect', context: { forged: 'argument' } } },
        },
        { id: 'label', component: 'Text', text: 'Inspect' },
      ],
    }, node())).toThrow(/a2uiActionContext/)
  })
})
