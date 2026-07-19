export type AppearanceColorScheme = 'dark' | 'light'

export const APPEARANCE_TOKEN_NAMES = [
  '--hr-bg',
  '--hr-bg-raised',
  '--hr-surface-1',
  '--hr-surface-2',
  '--hr-surface-3',
  '--hr-panel',
  '--hr-control',
  '--hr-control-hover',
  '--hr-control-active',
  '--hr-overlay',
  '--hr-code-bg',
  '--hr-border',
  '--hr-border-strong',
  '--hr-text-1',
  '--hr-text-2',
  '--hr-text-3',
  '--hr-text-4',
  '--hr-on-strong',
  '--hr-accent',
  '--hr-accent-hover',
  '--hr-accent-soft',
  '--hr-accent-border',
  '--hr-on-accent',
  '--hr-speaking',
  '--hr-speaking-soft',
  '--hr-speaking-border',
  '--hr-success',
  '--hr-success-soft',
  '--hr-success-border',
  '--hr-warning',
  '--hr-warning-soft',
  '--hr-warning-border',
  '--hr-danger',
  '--hr-danger-soft',
  '--hr-danger-border',
  '--hr-info',
  '--hr-info-soft',
  '--hr-info-border',
  '--hr-focus-ring',
  '--hr-selection',
  '--hr-scrollbar-track',
  '--hr-scrollbar',
  '--hr-scrollbar-hover',
  '--hr-ambient-accent',
  '--hr-ambient-info',
  '--hr-canvas-ambient-primary',
  '--hr-canvas-ambient-secondary',
  '--hr-decorative-accent-soft',
  '--hr-decorative-accent-border',
  '--hr-decorative-speaking-soft',
  '--hr-decorative-speaking-border',
  '--hr-settings-sidebar',
  '--hr-settings-card',
  '--hr-settings-card-hover',
  '--hr-settings-divider',
  '--hr-settings-active',
  '--hr-settings-active-border',
  '--hr-radius-lg',
  '--hr-radius-md',
  '--hr-radius-sm',
  '--hr-shadow-panel',
  '--hr-shadow-floating',
  '--hr-shadow-accent',
] as const

export type AppearanceTokenName = typeof APPEARANCE_TOKEN_NAMES[number]
export type AppearanceTokens = Partial<Record<AppearanceTokenName, string>>

export interface AppearancePlugin {
  id: string
  colorScheme: AppearanceColorScheme
  labelKey: string
  descriptionKey: string
  themeColor: string
  preview: {
    background: string
    panel: string
    accent: string
    text: string
  }
  /**
   * Optional inline semantic-token overrides. A plugin can instead ship CSS
   * scoped to `:root[data-hr-appearance='<id>']`; components only consume the
   * token contract and never branch on the plugin id.
   */
  tokens?: AppearanceTokens
}

export const APPEARANCE_STORAGE_KEY = 'homerail.appearance'
export const APPEARANCE_COLOR_SCHEME_STORAGE_KEY = 'homerail.appearance-color-scheme'
export const LEGACY_SKIN_STORAGE_KEY = 'homerail.skin'
export const LEGACY_THEME_STORAGE_KEY = 'omni_theme'
export const DEFAULT_APPEARANCE_ID = 'cockpit'
export const ARTIFACT_APPEARANCE_MESSAGE_TYPE = 'homerail:artifact-appearance'

export interface ArtifactAppearanceMessage {
  type: typeof ARTIFACT_APPEARANCE_MESSAGE_TYPE
  version: 1
  colorScheme: AppearanceColorScheme
  scrollbarTrack: string
  scrollbar: string
  scrollbarHover: string
}

const registry = new Map<string, AppearancePlugin>()
const registryListeners = new Set<() => void>()
const appliedInlineTokens = new WeakMap<Document, readonly AppearanceTokenName[]>()
const appearanceTokenNames = new Set<string>(APPEARANCE_TOKEN_NAMES)

function assertAppearancePlugin(plugin: AppearancePlugin): void {
  if (!/^[a-z][a-z0-9-]*$/.test(plugin.id)) {
    throw new Error(`Invalid appearance id: ${plugin.id}`)
  }
  if (!plugin.labelKey || !plugin.descriptionKey) {
    throw new Error(`Appearance ${plugin.id} must provide translated labels`)
  }
  for (const [name, value] of Object.entries(plugin.tokens ?? {})) {
    if (!appearanceTokenNames.has(name) || typeof value !== 'string' || !value.trim()) {
      throw new Error(`Appearance ${plugin.id} has an invalid token: ${name}`)
    }
  }
}

export function registerAppearance(plugin: AppearancePlugin): AppearancePlugin {
  assertAppearancePlugin(plugin)
  if (registry.has(plugin.id)) {
    throw new Error(`Appearance already registered: ${plugin.id}`)
  }
  const frozen = Object.freeze({
    ...plugin,
    preview: Object.freeze({ ...plugin.preview }),
    ...(plugin.tokens ? { tokens: Object.freeze({ ...plugin.tokens }) } : {}),
  })
  registry.set(plugin.id, frozen)
  for (const listener of registryListeners) listener()
  return frozen
}

export function subscribeAppearanceRegistry(listener: () => void): () => void {
  registryListeners.add(listener)
  return () => registryListeners.delete(listener)
}

registerAppearance({
  id: 'cockpit',
  colorScheme: 'dark',
  labelKey: 'settings.general.appearance.options.cockpit.label',
  descriptionKey: 'settings.general.appearance.options.cockpit.description',
  themeColor: '#06080d',
  preview: {
    background: '#06080d',
    panel: '#101722',
    accent: '#4fd8e8',
    text: '#edf4fc',
  },
})

registerAppearance({
  id: 'paper',
  colorScheme: 'light',
  labelKey: 'settings.general.appearance.options.paper.label',
  descriptionKey: 'settings.general.appearance.options.paper.description',
  themeColor: '#e9edef',
  preview: {
    background: '#e9edef',
    panel: '#f7f8f7',
    accent: '#2e727a',
    text: '#26323a',
  },
})

export function listAppearancePlugins(): readonly AppearancePlugin[] {
  return [...registry.values()]
}

export function getAppearancePlugin(id: string | null | undefined): AppearancePlugin {
  return registry.get(id || '') ?? registry.get(DEFAULT_APPEARANCE_ID)!
}

export function normalizeAppearanceId(id: string | null | undefined): string {
  return getAppearancePlugin(id).id
}

function systemAppearance(matchMedia?: (query: string) => MediaQueryList): string {
  if (!matchMedia) return DEFAULT_APPEARANCE_ID
  return matchMedia('(prefers-color-scheme: light)').matches ? 'paper' : 'cockpit'
}

export function resolveStoredAppearance(
  storage?: Pick<Storage, 'getItem'>,
  matchMedia?: (query: string) => MediaQueryList,
): string {
  if (!storage) return DEFAULT_APPEARANCE_ID

  const current = storage.getItem(APPEARANCE_STORAGE_KEY)
  if (current && registry.has(current)) return current

  const legacySkin = storage.getItem(LEGACY_SKIN_STORAGE_KEY)
  if (legacySkin && registry.has(legacySkin)) return legacySkin

  const legacyTheme = storage.getItem(LEGACY_THEME_STORAGE_KEY)
  if (legacyTheme === 'light') return 'paper'
  if (legacyTheme === 'dark') return 'cockpit'
  if (legacyTheme === 'system') return systemAppearance(matchMedia)

  return DEFAULT_APPEARANCE_ID
}

function resolvedAppearanceToken(
  doc: Document,
  name: AppearanceTokenName,
  fallback: string,
): string {
  try {
    return doc.defaultView?.getComputedStyle(doc.documentElement).getPropertyValue(name).trim() || fallback
  } catch {
    return fallback
  }
}

export function artifactAppearanceMessage(doc: Document = document): ArtifactAppearanceMessage {
  const appearance = getAppearancePlugin(doc.documentElement.dataset.hrAppearance)
  const dark = appearance.colorScheme === 'dark'
  return {
    type: ARTIFACT_APPEARANCE_MESSAGE_TYPE,
    version: 1,
    colorScheme: appearance.colorScheme,
    scrollbarTrack: resolvedAppearanceToken(
      doc,
      '--hr-scrollbar-track',
      dark ? '#0a0f18' : '#eef1f2',
    ),
    scrollbar: resolvedAppearanceToken(
      doc,
      '--hr-scrollbar',
      dark ? '#2a3541' : '#c0c8cb',
    ),
    scrollbarHover: resolvedAppearanceToken(
      doc,
      '--hr-scrollbar-hover',
      dark ? '#435565' : '#8e9ca1',
    ),
  }
}

export function postAppearanceToArtifactFrame(
  frame: HTMLIFrameElement,
  doc: Document = frame.ownerDocument,
): void {
  try {
    frame.contentWindow?.postMessage(artifactAppearanceMessage(doc), '*')
  } catch {
    // A sandboxed or detaching frame may become unavailable between load and dispatch.
  }
}

function broadcastArtifactAppearance(doc: Document): void {
  for (const frame of doc.querySelectorAll<HTMLIFrameElement>('iframe[data-homerail-artifact-frame]')) {
    postAppearanceToArtifactFrame(frame, doc)
  }
}

export function applyAppearanceToDocument(
  id: string,
  doc: Document = document,
): AppearancePlugin {
  const plugin = getAppearancePlugin(id)
  const root = doc.documentElement
  root.dataset.hrAppearance = plugin.id
  delete root.dataset.hrTheme
  root.classList.toggle('dark', plugin.colorScheme === 'dark')
  root.style.colorScheme = plugin.colorScheme

  for (const tokenName of appliedInlineTokens.get(doc) ?? []) {
    root.style.removeProperty(tokenName)
  }
  const nextInlineTokens = Object.entries(plugin.tokens ?? {}) as Array<[AppearanceTokenName, string]>
  for (const [tokenName, value] of nextInlineTokens) {
    root.style.setProperty(tokenName, value)
  }
  appliedInlineTokens.set(doc, nextInlineTokens.map(([tokenName]) => tokenName))

  const themeColor = doc.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  themeColor?.setAttribute('content', plugin.themeColor)

  try {
    doc.defaultView?.localStorage.setItem(APPEARANCE_COLOR_SCHEME_STORAGE_KEY, plugin.colorScheme)
  } catch {
    // Storage can be unavailable in privacy modes; the document still receives the appearance.
  }

  broadcastArtifactAppearance(doc)

  return plugin
}

export function applyInitialAppearance(doc: Document = document): AppearancePlugin {
  let storage: Storage | undefined
  let matchMedia: ((query: string) => MediaQueryList) | undefined
  try {
    storage = doc.defaultView?.localStorage
    matchMedia = typeof doc.defaultView?.matchMedia === 'function'
      ? doc.defaultView.matchMedia.bind(doc.defaultView)
      : undefined
  } catch {
    // Fall back to the built-in default when browser storage is unavailable.
  }
  return applyAppearanceToDocument(resolveStoredAppearance(storage, matchMedia), doc)
}
