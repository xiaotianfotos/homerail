import {
  defineComponent,
  h,
  ref,
  type CSSProperties,
  type Component,
  type PropType,
  type VNode,
} from 'vue'
import MarkdownIt from 'markdown-it'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Bell,
  BellOff,
  CalendarDays,
  Camera,
  Check,
  Circle,
  CircleAlert,
  CircleHelp,
  CreditCard,
  Download,
  Eye,
  EyeOff,
  FastForward,
  File,
  Folder,
  Heart,
  HeartOff,
  Home,
  Image as ImageIcon,
  Info,
  Lock,
  Mail,
  MapPin,
  Menu,
  Monitor,
  MoreHorizontal,
  MoreVertical,
  Paperclip,
  Pause,
  Pencil,
  Phone,
  Play,
  Plus,
  Printer,
  RefreshCw,
  Rewind,
  Search,
  Send,
  Settings,
  Share2,
  ShoppingCart,
  SkipBack,
  SkipForward,
  Square,
  Star,
  StarHalf,
  Trash2,
  Unlock,
  Upload,
  User,
  UserCircle,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from 'lucide-vue-next'
import {
  isSafeGenerativeUiExternalUri,
  isSafeGenerativeUiPreviewUri,
} from 'homerail-protocol'
import {
  HOMERAIL_A2UI_MAX_DEPTH,
  HOMERAIL_A2UI_MAX_SOURCE_ITEMS,
  a2uiNumber,
  a2uiText,
  a2uiTone,
  evaluateA2uiValue,
  isA2uiRecord,
  isWritableA2uiBinding,
  readA2uiItemPointer,
  readA2uiPointer,
  writeA2uiBinding,
  type A2uiEvaluationScope,
  type A2uiRuntime,
  type A2uiComponentV1,
} from '@/generative-ui/a2ui'
import A2uiDag, { type A2uiDagItem } from './A2uiDag.vue'

const icons: Record<string, Component> = {
  accountCircle: UserCircle,
  add: Plus,
  arrowBack: ArrowLeft,
  arrowForward: ArrowRight,
  attachFile: Paperclip,
  calendarToday: CalendarDays,
  call: Phone,
  camera: Camera,
  check: Check,
  close: X,
  delete: Trash2,
  download: Download,
  edit: Pencil,
  event: CalendarDays,
  error: CircleAlert,
  fastForward: FastForward,
  favorite: Heart,
  favoriteOff: HeartOff,
  folder: Folder,
  help: CircleHelp,
  home: Home,
  info: Info,
  locationOn: MapPin,
  lock: Lock,
  lockOpen: Unlock,
  mail: Mail,
  menu: Menu,
  moreVert: MoreVertical,
  moreHoriz: MoreHorizontal,
  notificationsOff: BellOff,
  notifications: Bell,
  pause: Pause,
  payment: CreditCard,
  person: User,
  phone: Phone,
  photo: ImageIcon,
  play: Play,
  print: Printer,
  refresh: RefreshCw,
  rewind: Rewind,
  search: Search,
  send: Send,
  settings: Settings,
  share: Share2,
  shoppingCart: ShoppingCart,
  skipNext: SkipForward,
  skipPrevious: SkipBack,
  star: Star,
  starHalf: StarHalf,
  starOff: Circle,
  stop: Square,
  upload: Upload,
  visibility: Eye,
  visibilityOff: EyeOff,
  volumeDown: Volume1,
  volumeMute: VolumeX,
  volumeOff: VolumeX,
  volumeUp: Volume2,
  warning: AlertTriangle,
}

const markdown = new MarkdownIt({ html: false, linkify: false, breaks: true, typographer: true })
markdown.inline.ruler.disable(['link', 'image', 'autolink', 'html_inline'])
markdown.block.ruler.disable(['html_block'])

const GAP_VALUES = new Set(['none', 'xs', 'sm', 'md', 'lg'])
const ALIGN_VALUES = new Set(['start', 'center', 'end', 'stretch'])
const JUSTIFY_VALUES = new Set(['start', 'center', 'end', 'spaceBetween', 'spaceAround', 'spaceEvenly', 'stretch'])

function className(component: string): string {
  return component.replace(/^Hr/, '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

function componentAttrs(component: A2uiComponentV1, extra: Record<string, unknown> = {}) {
  const weight = a2uiNumber('weight' in component ? component.weight : undefined)
  return {
    class: ['hr-a2ui__node', `hr-a2ui__${className(component.component)}`],
    'data-component': component.component,
    'data-a2ui-id': component.id,
    ...(weight !== undefined ? { style: { flexGrow: Math.max(0, weight) } } : {}),
    ...extra,
  }
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const number = a2uiNumber(value)
  return number === undefined ? fallback : Math.max(min, Math.min(max, Math.round(number)))
}

function evaluated(componentValue: unknown, runtime: A2uiRuntime, scope: A2uiEvaluationScope): unknown {
  return evaluateA2uiValue(componentValue, runtime, scope)
}

function text(componentValue: unknown, runtime: A2uiRuntime, scope: A2uiEvaluationScope): string {
  return a2uiText(evaluated(componentValue, runtime, scope))
}

function tone(componentValue: unknown, runtime: A2uiRuntime, scope: A2uiEvaluationScope): string {
  return a2uiTone(evaluated(componentValue, runtime, scope))
}

function itemText(item: unknown, path: unknown): string {
  return a2uiText(readA2uiItemPointer(item, path))
}

function itemNumber(item: unknown, path: unknown): number | undefined {
  return a2uiNumber(readA2uiItemPointer(item, path))
}

function sourceItems(
  component: A2uiComponentV1,
  runtime: A2uiRuntime,
  scope: A2uiEvaluationScope,
): unknown[] {
  if (!('source' in component)) return []
  const source = evaluated(component.source, runtime, scope)
  if (!Array.isArray(source)) return []
  const maxItems = boundedInteger(
    'maxItems' in component ? component.maxItems : undefined,
    HOMERAIL_A2UI_MAX_SOURCE_ITEMS,
    1,
    HOMERAIL_A2UI_MAX_SOURCE_ITEMS,
  )
  return source.slice(0, maxItems)
}

function formattedCell(value: unknown, format: unknown, runtime: A2uiRuntime, scope: A2uiEvaluationScope): string {
  if (format === 'number') return a2uiText(evaluateA2uiValue({ call: 'formatNumber', args: { value } }, runtime, scope))
  if (format === 'percent') {
    const number = a2uiNumber(value)
    if (number === undefined) return ''
    return new Intl.NumberFormat(runtime.locale, { style: 'percent', maximumFractionDigits: 1 }).format(
      Math.abs(number) > 1 ? number / 100 : number,
    )
  }
  if (format === 'duration') {
    const milliseconds = a2uiNumber(value)
    if (milliseconds === undefined) return ''
    const seconds = Math.max(0, Math.round(milliseconds / 1_000))
    const hours = Math.floor(seconds / 3_600)
    const minutes = Math.floor((seconds % 3_600) / 60)
    const remainder = seconds % 60
    return [hours ? `${hours}h` : '', minutes ? `${minutes}m` : '', remainder || (!hours && !minutes) ? `${remainder}s` : '']
      .filter(Boolean)
      .slice(0, 2)
      .join(' ')
  }
  if (format === 'datetime') {
    const date = new Date(value as string | number)
    return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(runtime.locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date)
  }
  return a2uiText(value)
}

function validationMessages(
  component: A2uiComponentV1,
  runtime: A2uiRuntime,
  scope: A2uiEvaluationScope,
): string[] {
  if (!('checks' in component) || !Array.isArray(component.checks)) return []
  return component.checks.flatMap(check => {
    if (!isA2uiRecord(check) || evaluated(check.condition, runtime, scope) !== false) return []
    return [a2uiText(check.message) || 'Invalid value']
  })
}

function validationFeedback(messages: readonly string[]): VNode[] {
  return messages.map(message => h('small', {
    class: 'hr-a2ui__validation',
    role: 'alert',
  }, message))
}

function renderNode(
  component: A2uiComponentV1,
  runtime: A2uiRuntime,
  scope: A2uiEvaluationScope,
  ancestors: string[],
  selectedTab: { value: number },
  modalOpen: { value: boolean },
  choiceFilter: { value: string },
): VNode {
  const componentName: string = component.component
  if (ancestors.includes(component.id) || ancestors.length >= HOMERAIL_A2UI_MAX_DEPTH) {
    throw new Error(`Generated A2UI component graph is cyclic or too deep at ${component.id}`)
  }
  const nextAncestors = [...ancestors, component.id]
  const accessibilityLabel = text(component.accessibility?.label, runtime, scope)
  const accessibilityDescription = text(component.accessibility?.description, runtime, scope)
  const nodeAttrs = (extra: Record<string, unknown> = {}) => componentAttrs(component, {
    ...(accessibilityLabel ? { 'aria-label': accessibilityLabel } : {}),
    ...(accessibilityDescription ? { 'aria-description': accessibilityDescription } : {}),
    ...extra,
  })
  const child = (id: unknown, childScope = scope, key = a2uiText(id)): VNode => {
    if (typeof id !== 'string' || !runtime.components.has(id)) {
      throw new Error(`Generated A2UI component reference is missing: ${String(id)}`)
    }
    return h(A2uiNode, {
      key: `${key}:${childScope.key}`,
      runtime,
      componentId: id,
      scope: childScope,
      ancestors: nextAncestors,
    })
  }
  const children = (value: unknown): VNode[] => {
    if (Array.isArray(value)) return value.map((id, index) => child(id, scope, `${String(id)}:${index}`))
    if (!isA2uiRecord(value) || typeof value.path !== 'string' || typeof value.componentId !== 'string') return []
    const collection = readA2uiPointer(value.path, runtime.dataModel.value, scope)
    if (!Array.isArray(collection)) return []
    return collection.slice(0, HOMERAIL_A2UI_MAX_SOURCE_ITEMS).map((item, index) => child(
      value.componentId,
      { value: item, key: `${scope.key}:${value.path}:${index}`, index },
      `${value.componentId}:${index}`,
    ))
  }

  if (component.component === 'Text') {
    const value = text(component.text, runtime, scope)
    const variant = typeof component.variant === 'string' ? component.variant : 'body'
    return h('div', {
      ...nodeAttrs(),
      'data-variant': variant,
      innerHTML: markdown.render(value),
    })
  }
  if (component.component === 'Image') {
    const url = text(component.url, runtime, scope)
    const description = text(component.description, runtime, scope)
    if (!isSafeGenerativeUiPreviewUri(url)) {
      return h('div', { ...nodeAttrs(), 'data-unavailable': 'true', role: 'img', 'aria-label': accessibilityLabel || description })
    }
    return h('img', {
      ...nodeAttrs(),
      src: url,
      alt: description,
      loading: 'lazy',
      referrerpolicy: 'no-referrer',
      'data-fit': typeof component.fit === 'string' ? component.fit : 'fill',
      'data-variant': typeof component.variant === 'string' ? component.variant : 'mediumFeature',
    })
  }
  if (component.component === 'Icon') {
    const name = text(component.name, runtime, scope)
    const Icon = icons[name] ?? Info
    return h('i', nodeAttrs(), [h(Icon, { size: 18, 'aria-hidden': true })])
  }
  if (component.component === 'Video' || component.component === 'AudioPlayer') {
    const url = text(component.url, runtime, scope)
    if (!isSafeGenerativeUiPreviewUri(url)) return h('div', { ...nodeAttrs(), 'data-unavailable': 'true' })
    if (component.component === 'Video') {
      const poster = text(component.posterUrl, runtime, scope)
      return h('video', {
        ...nodeAttrs(),
        src: url,
        ...(isSafeGenerativeUiPreviewUri(poster) ? { poster } : {}),
        controls: true,
        preload: 'metadata',
        referrerpolicy: 'no-referrer',
      })
    }
    return h('figure', nodeAttrs(), [
      text(component.description, runtime, scope) ? h('figcaption', text(component.description, runtime, scope)) : null,
      h('audio', { src: url, controls: true, preload: 'metadata', referrerpolicy: 'no-referrer' }),
    ])
  }
  if (component.component === 'Row' || component.component === 'Column' || component.component === 'List') {
    const direction = component.component === 'Row'
      ? 'row'
      : component.component === 'List' && component.direction === 'horizontal' ? 'row' : 'column'
    return h('div', nodeAttrs({
      'data-direction': direction,
      'data-justify': 'justify' in component && JUSTIFY_VALUES.has(String(component.justify)) ? component.justify : 'start',
      'data-align': ALIGN_VALUES.has(String(component.align)) ? component.align : 'stretch',
    }), children(component.children))
  }
  if (component.component === 'Card') return h('article', nodeAttrs(), [child(component.child)])
  if (component.component === 'Tabs') {
    const tabs = Array.isArray(component.tabs) ? component.tabs.filter(isA2uiRecord) : []
    const active = Math.min(selectedTab.value, Math.max(0, tabs.length - 1))
    const activeTab = tabs[active]
    return h('section', nodeAttrs(), [
      h('div', { class: 'hr-a2ui__tab-list', role: 'tablist' }, tabs.map((tab, index) => h('button', {
        key: `tab:${index}`,
        type: 'button',
        role: 'tab',
        'aria-selected': index === active,
        onClick: () => { selectedTab.value = index },
      }, text(tab.title, runtime, scope)))),
      activeTab ? h('div', { class: 'hr-a2ui__tab-panel', role: 'tabpanel' }, [child(activeTab.child)]) : null,
    ])
  }
  if (component.component === 'Modal') {
    return h('div', nodeAttrs(), [
      h('div', {
        class: 'hr-a2ui__modal-trigger',
        onClickCapture: (event: MouseEvent) => {
          event.stopPropagation()
          modalOpen.value = true
        },
      }, [child(component.trigger)]),
      modalOpen.value ? h('div', { class: 'hr-a2ui__modal-backdrop', role: 'presentation' }, [
        h('section', { class: 'hr-a2ui__modal-panel', role: 'dialog', 'aria-modal': 'true' }, [
          h('button', {
            class: 'hr-a2ui__modal-close', type: 'button', title: 'Close', 'aria-label': 'Close',
            onClick: () => { modalOpen.value = false },
          }, [h(X, { size: 18, 'aria-hidden': true })]),
          child(component.content),
        ]),
      ]) : null,
    ])
  }
  if (component.component === 'Divider') {
    return h('hr', nodeAttrs({ 'data-axis': component.axis === 'vertical' ? 'vertical' : 'horizontal' }))
  }
  if (component.component === 'Button') {
    const action = 'event' in component.action && isA2uiRecord(component.action.event) ? component.action.event : undefined
    const name = typeof action?.name === 'string' ? action.name : ''
    const messages = validationMessages(component, runtime, scope)
    return h('div', nodeAttrs({
      'data-variant': typeof component.variant === 'string' ? component.variant : 'default',
    }), [
      h('button', {
        type: 'button',
        disabled: !name || messages.length > 0,
        onClick: (event: MouseEvent) => {
          event.stopPropagation()
          if (name && messages.length === 0) runtime.requestAction(name)
        },
      }, [child(component.child)]),
      ...validationFeedback(messages),
    ])
  }
  if (component.component === 'TextField') {
    const messages = validationMessages(component, runtime, scope)
    const current = text(component.value, runtime, scope)
    const writable = isWritableA2uiBinding(component.value)
    const input = component.variant === 'longText'
      ? h('textarea', {
          value: current,
          placeholder: text(component.placeholder, runtime, scope),
          rows: 3,
          disabled: !writable,
          'aria-invalid': messages.length > 0 ? 'true' : undefined,
          onInput: (event: Event) => writeA2uiBinding(component.value, (event.target as HTMLTextAreaElement).value, runtime.dataModel.value, scope),
        })
      : h('input', {
          value: current,
          placeholder: text(component.placeholder, runtime, scope),
          type: component.variant === 'obscured' ? 'password' : component.variant === 'number' ? 'number' : 'text',
          disabled: !writable,
          'aria-invalid': messages.length > 0 ? 'true' : undefined,
          onInput: (event: Event) => writeA2uiBinding(
            component.value,
            (event.target as HTMLInputElement).value,
            runtime.dataModel.value,
            scope,
          ),
        })
    return h('label', nodeAttrs(), [
      h('span', text(component.label, runtime, scope)), input,
      ...validationFeedback(messages),
    ])
  }
  if (component.component === 'CheckBox') {
    const messages = validationMessages(component, runtime, scope)
    const writable = isWritableA2uiBinding(component.value)
    return h('label', nodeAttrs(), [
      h('input', {
        type: 'checkbox',
        checked: Boolean(evaluated(component.value, runtime, scope)),
        disabled: !writable,
        'aria-invalid': messages.length > 0 ? 'true' : undefined,
        onChange: (event: Event) => writeA2uiBinding(component.value, (event.target as HTMLInputElement).checked, runtime.dataModel.value, scope),
      }),
      h('span', text(component.label, runtime, scope)),
      ...validationFeedback(messages),
    ])
  }
  if (component.component === 'ChoicePicker') {
    const options = Array.isArray(component.options) ? component.options.filter(isA2uiRecord) : []
    const selected = evaluated(component.value, runtime, scope)
    const selectedValues = Array.isArray(selected) ? selected.map(a2uiText) : []
    const messages = validationMessages(component, runtime, scope)
    const writable = isWritableA2uiBinding(component.value)
    const query = choiceFilter.value.trim().toLocaleLowerCase(runtime.locale)
    const visibleOptions = query
      ? options.filter(option => text(option.label, runtime, scope).toLocaleLowerCase(runtime.locale).includes(query))
      : options
    const multiple = component.variant === 'multipleSelection'
    const displayStyle = component.displayStyle === 'chips' ? 'chips' : 'checkbox'
    const setSelection = (value: string, checked: boolean): void => {
      const next = multiple
        ? checked
          ? [...new Set([...selectedValues, value])]
          : selectedValues.filter(candidate => candidate !== value)
        : checked ? [value] : []
      writeA2uiBinding(component.value, next, runtime.dataModel.value, scope)
    }
    return h('fieldset', nodeAttrs({
      'data-display-style': displayStyle,
      'data-variant': multiple ? 'multipleSelection' : 'mutuallyExclusive',
    }), [
      text(component.label, runtime, scope) ? h('legend', text(component.label, runtime, scope)) : null,
      component.filterable ? h('input', {
        class: 'hr-a2ui__choice-filter',
        type: 'search',
        value: choiceFilter.value,
        'aria-label': text(component.label, runtime, scope),
        onInput: (event: Event) => { choiceFilter.value = (event.target as HTMLInputElement).value },
      }) : null,
      h('div', { class: 'hr-a2ui__choice-options' }, visibleOptions.map(option => {
        const value = a2uiText(option.value)
        return h('label', { key: value, 'data-selected': selectedValues.includes(value) ? 'true' : 'false' }, [
          h('input', {
            type: multiple ? 'checkbox' : 'radio',
            name: multiple ? undefined : `choice:${component.id}:${scope.key}`,
            value,
            checked: selectedValues.includes(value),
            disabled: !writable,
            'aria-invalid': messages.length > 0 ? 'true' : undefined,
            onChange: (event: Event) => setSelection(value, (event.target as HTMLInputElement).checked),
          }),
          h('span', text(option.label, runtime, scope)),
        ])
      })),
      ...validationFeedback(messages),
    ])
  }
  if (component.component === 'Slider') {
    const current = a2uiNumber(evaluated(component.value, runtime, scope)) ?? 0
    const messages = validationMessages(component, runtime, scope)
    const writable = isWritableA2uiBinding(component.value)
    const min = a2uiNumber(component.min) ?? 0
    const max = a2uiNumber(component.max) ?? 100
    const divisions = a2uiNumber(component.steps)
    const step = divisions === undefined ? 'any' : Math.max(Number.EPSILON, (max - min) / divisions)
    return h('label', nodeAttrs(), [
      text(component.label, runtime, scope) ? h('span', text(component.label, runtime, scope)) : null,
      h('input', {
        type: 'range', value: current, min, max,
        step,
        disabled: !writable,
        'aria-invalid': messages.length > 0 ? 'true' : undefined,
        onInput: (event: Event) => writeA2uiBinding(component.value, Number((event.target as HTMLInputElement).value), runtime.dataModel.value, scope),
      }),
      h('output', String(current)),
      ...validationFeedback(messages),
    ])
  }
  if (component.component === 'DateTimeInput') {
    const type = component.enableDate && component.enableTime ? 'datetime-local' : component.enableTime ? 'time' : 'date'
    const messages = validationMessages(component, runtime, scope)
    const writable = isWritableA2uiBinding(component.value)
    return h('label', nodeAttrs(), [
      text(component.label, runtime, scope) ? h('span', text(component.label, runtime, scope)) : null,
      h('input', {
        type, value: text(component.value, runtime, scope), min: text(component.min, runtime, scope), max: text(component.max, runtime, scope),
        disabled: !writable,
        'aria-invalid': messages.length > 0 ? 'true' : undefined,
        onInput: (event: Event) => writeA2uiBinding(component.value, (event.target as HTMLInputElement).value, runtime.dataModel.value, scope),
      }),
      ...validationFeedback(messages),
    ])
  }
  if (component.component === 'HrGrid') {
    const columns: Record<string, unknown> = isA2uiRecord(component.columns) ? component.columns : {}
    const compactColumns = boundedInteger(columns.compact, 1, 1, 3)
    return h('div', nodeAttrs({
      'data-gap': GAP_VALUES.has(String(component.gap)) ? component.gap : 'md',
      'data-align': ALIGN_VALUES.has(String(component.align)) ? component.align : 'stretch',
      'data-compact-columns': compactColumns,
      style: {
        '--columns': boundedInteger(columns.default, 1, 1, 3),
        '--compact-columns': compactColumns,
      },
    }), children(component.children))
  }
  if (component.component === 'HrGridItem') {
    const span = boundedInteger(component.span, 1, 1, 3)
    return h('div', nodeAttrs({ style: { gridColumn: `span ${span}` }, 'data-span': span }), [child(component.child)])
  }
  if (component.component === 'HrSection') {
    return h('section', nodeAttrs({ 'data-tone': tone(component.tone, runtime, scope) }), [
      component.title === undefined ? null : h('header', text(component.title, runtime, scope)),
      ...children(component.children),
    ])
  }
  if (component.component === 'HrMetric') {
    return h('article', nodeAttrs({ 'data-tone': tone(component.tone, runtime, scope) }), [
      h('span', text(component.label, runtime, scope)),
      h('strong', [text(component.value, runtime, scope), component.unit === undefined ? null : h('small', text(component.unit, runtime, scope))]),
    ])
  }
  if (component.component === 'HrStatusBadge') {
    return h('span', nodeAttrs({ 'data-tone': tone(component.tone, runtime, scope) }), text(component.text, runtime, scope))
  }
  if (component.component === 'HrProgress') {
    const value = Math.max(0, Math.min(100, a2uiNumber(evaluated(component.value, runtime, scope)) ?? 0))
    return h('div', nodeAttrs({ 'data-tone': tone(component.tone, runtime, scope) }), [
      component.label === undefined ? null : h('header', [h('span', text(component.label, runtime, scope)), h('strong', `${value}%`)]),
      h('div', { class: 'hr-a2ui__progress-track', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': value }, [
        h('i', { style: { width: `${value}%` } }),
      ]),
    ])
  }
  if (component.component === 'HrStep') {
    const index = text(component.index, runtime, scope) || String((scope.index ?? 0) + 1)
    const detail = text(component.detail, runtime, scope)
    return h('article', nodeAttrs({ 'data-tone': tone(component.tone, runtime, scope) }), [
      h('div', { class: 'hr-a2ui__step-rail', 'aria-hidden': true }, [h('span', index)]),
      h('div', { class: 'hr-a2ui__step-content' }, [
        h('header', [
          h('strong', text(component.label, runtime, scope)),
          detail ? h('small', detail) : null,
        ]),
        child(component.child),
      ]),
    ])
  }
  if (component.component === 'HrList') {
    return h('ul', nodeAttrs(), sourceItems(component, runtime, scope).map((item, index) => {
      const itemTone = a2uiTone(readA2uiItemPointer(item, component.itemStatusPath))
      return h('li', { key: `item:${index}`, 'data-tone': itemTone }, [
        h('i'),
        h('div', [
          h('strong', itemText(item, component.itemTitlePath)),
          component.itemDetailPath === undefined ? null : h('p', itemText(item, component.itemDetailPath)),
        ]),
        component.itemBadgePath === undefined ? null : h('span', itemText(item, component.itemBadgePath)),
      ])
    }))
  }
  if (component.component === 'HrTable') {
    const columns = Array.isArray(component.columns) ? component.columns.filter(isA2uiRecord) : []
    return h('div', nodeAttrs(), [h('table', { class: 'hr-a2ui__table' }, [
      h('thead', [h('tr', columns.map(column => h('th', { key: a2uiText(column.id) }, text(column.label, runtime, scope))))]),
      h('tbody', sourceItems(component, runtime, scope).map((item, rowIndex) => h('tr', { key: `row:${rowIndex}` }, columns.map(column => {
        const value = readA2uiItemPointer(item, column.path)
        return h('td', { key: a2uiText(column.id), 'data-format': column.format }, formattedCell(value, column.format, runtime, scope))
      })))),
    ])])
  }
  if (component.component === 'HrTimeline') {
    return h('ol', nodeAttrs(), sourceItems(component, runtime, scope).map((item, index) => {
      const status = itemText(item, component.itemStatusPath)
      return h('li', { key: `timeline:${index}`, 'data-tone': a2uiTone(status) }, [
        h('i'),
        component.itemTimePath === undefined ? null : h('time', itemText(item, component.itemTimePath)),
        h('div', [
          h('strong', itemText(item, component.itemTitlePath)),
          component.itemDetailPath === undefined ? null : h('p', itemText(item, component.itemDetailPath)),
        ]),
      ])
    }))
  }
  if (component.component === 'HrBarChart') {
    const items = sourceItems(component, runtime, scope)
    const values = items.map(item => itemNumber(item, component.itemValuePath) ?? 0)
    const max = Math.max(1, ...values)
    return h('div', nodeAttrs(), items.map((item, index) => {
      const itemTone = a2uiTone(readA2uiItemPointer(item, component.itemTonePath))
      const value = values[index] ?? 0
      return h('div', { key: `bar:${index}`, 'data-tone': itemTone }, [
        h('span', itemText(item, component.itemLabelPath)),
        h('i', [h('b', { style: { width: `${Math.max(2, (value / max) * 100)}%` } })]),
        h('strong', formattedCell(value, 'number', runtime, scope)),
      ])
    }))
  }
  if (component.component === 'HrDag') {
    const items: A2uiDagItem[] = sourceItems(component, runtime, scope).map((item, index) => {
      const status = itemText(item, component.itemStatusPath)
      const dependencies = readA2uiItemPointer(item, component.itemDependsOnPath)
      return {
        id: itemText(item, component.itemIdPath) || `node-${index}`,
        title: itemText(item, component.itemLabelPath),
        detail: itemText(item, component.itemDetailPath),
        status,
        tone: a2uiTone(status),
        progress: itemNumber(item, component.itemProgressPath),
        dependsOn: Array.isArray(dependencies) ? dependencies.map(a2uiText).filter(Boolean) : [],
      }
    })
    return h(A2uiDag, { ...nodeAttrs(), items })
  }
  if (component.component === 'HrDisclosure') {
    return h('details', { ...nodeAttrs(), open: runtime.expanded || Boolean(evaluated(component.open, runtime, scope)) }, [
      h('summary', text(component.title, runtime, scope)),
      h('div', children(component.children)),
    ])
  }
  if (component.component === 'HrLink') {
    const url = text(component.url, runtime, scope)
    const label = text(component.label, runtime, scope)
    const description = text(component.description, runtime, scope)
    if (!isSafeGenerativeUiExternalUri(url)) {
      return h('span', { ...nodeAttrs(), 'data-unavailable': 'true' }, label || 'Link unavailable')
    }
    return h('a', {
      ...nodeAttrs(),
      href: url,
      target: '_blank',
      rel: 'noopener noreferrer',
      referrerpolicy: 'no-referrer',
    }, [
      h('span', label),
      description ? h('small', description) : null,
      h(ArrowRight, { size: 15, 'aria-hidden': true }),
    ])
  }
  if (component.component === 'HrArtifact') {
    const uri = text(component.uri, runtime, scope)
    const title = text(component.title, runtime, scope)
    const description = text(component.description, runtime, scope)
    const kind = component.kind === 'image' || component.kind === 'html' ? component.kind : 'file'
    if (!isSafeGenerativeUiPreviewUri(uri)) {
      return h('div', { ...nodeAttrs(), 'data-unavailable': 'true' }, [h(File, { size: 18 }), h('span', title || 'Artifact unavailable')])
    }
    const preview = () => runtime.openPreview({
      title: title || undefined,
      url: uri,
      kind: kind === 'image' ? 'image' : 'html',
      layout: component.layout === 'portrait' ? 'portrait' : 'fluid',
    })
    if (kind === 'image') {
      return h('button', { ...nodeAttrs(), type: 'button', onClick: preview }, [
        h('img', {
          src: uri,
          alt: text(component.alt, runtime, scope) || title,
          loading: 'lazy',
          referrerpolicy: 'no-referrer',
        }),
        h('span', [h('strong', title), description ? h('small', description) : null]),
      ])
    }
    if (kind === 'html') {
      return h('div', nodeAttrs(), [
        h('iframe', {
          src: uri,
          sandbox: 'allow-scripts',
          referrerpolicy: 'no-referrer',
          allow: '',
          tabindex: '-1',
          title: title || 'HTML artifact preview',
        }),
        h('button', { type: 'button', onClick: preview }, [h(Monitor, { size: 16, 'aria-hidden': true }), title || 'Open preview']),
        description ? h('p', description) : null,
      ])
    }
    return h('button', { ...nodeAttrs(), type: 'button', onClick: preview }, [
      h(File, { size: 18, 'aria-hidden': true }),
      h('span', [h('strong', title || 'Artifact'), description ? h('small', description) : null]),
    ])
  }
  if (component.component === 'HrIf') {
    return h('div', nodeAttrs(), Boolean(evaluated(component.condition, runtime, scope)) ? children(component.children) : [])
  }
  throw new Error(`Generated A2UI component is not in the HomeRail Catalog: ${componentName}`)
}

const A2uiNode = defineComponent({
  name: 'A2uiNode',
  props: {
    runtime: { type: Object as PropType<A2uiRuntime>, required: true },
    componentId: { type: String, required: true },
    scope: { type: Object as PropType<A2uiEvaluationScope>, required: true },
    ancestors: { type: Array as PropType<string[]>, default: () => [] },
  },
  setup(props) {
    const selectedTab = ref(0)
    const modalOpen = ref(false)
    const choiceFilter = ref('')
    return () => {
      const component = props.runtime.components.get(props.componentId)
      if (!component) throw new Error(`Generated A2UI component is missing: ${props.componentId}`)
      return renderNode(component, props.runtime, props.scope, props.ancestors, selectedTab, modalOpen, choiceFilter)
    }
  },
})

export default A2uiNode
