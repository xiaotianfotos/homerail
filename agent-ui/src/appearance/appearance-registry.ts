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

interface SkinPalette {
  id: string
  colorScheme: AppearanceColorScheme
  themeColor: string
  background: string
  panel: string
  text: string
  muted: string
  accent: string
  accentHover: string
  secondary: string
  warning: string
  danger: string
  radius?: string
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

function skinTokens(palette: SkinPalette): AppearanceTokens {
  const dark = palette.colorScheme === 'dark'
  const alpha = (color: string, amount: number): string =>
    `color-mix(in srgb, ${color} ${amount}%, transparent)`

  return {
    '--hr-bg': palette.background,
    '--hr-bg-raised': palette.panel,
    '--hr-surface-1': alpha(palette.accent, dark ? 7 : 5),
    '--hr-surface-2': alpha(palette.accent, dark ? 12 : 9),
    '--hr-surface-3': alpha(palette.accent, dark ? 18 : 14),
    '--hr-panel': palette.panel,
    '--hr-control': alpha(palette.secondary, dark ? 9 : 7),
    '--hr-control-hover': alpha(palette.accent, dark ? 15 : 12),
    '--hr-control-active': alpha(palette.accent, dark ? 22 : 17),
    '--hr-overlay': dark ? 'rgba(0, 0, 0, 0.78)' : 'rgba(38, 38, 32, 0.24)',
    '--hr-code-bg': dark ? 'rgba(0, 0, 0, 0.62)' : alpha(palette.background, 82),
    '--hr-border': alpha(palette.accent, dark ? 22 : 20),
    '--hr-border-strong': alpha(palette.accent, dark ? 40 : 34),
    '--hr-text-1': palette.text,
    '--hr-text-2': dark ? palette.text : palette.muted,
    '--hr-text-3': palette.muted,
    '--hr-text-4': alpha(palette.muted, dark ? 68 : 78),
    '--hr-on-strong': dark ? '#ffffff' : palette.background,
    '--hr-accent': palette.accent,
    '--hr-accent-hover': palette.accentHover,
    '--hr-accent-soft': alpha(palette.accent, dark ? 17 : 14),
    '--hr-accent-border': alpha(palette.accent, dark ? 48 : 42),
    '--hr-on-accent': dark ? palette.background : '#ffffff',
    '--hr-speaking': palette.secondary,
    '--hr-speaking-soft': alpha(palette.secondary, dark ? 17 : 14),
    '--hr-speaking-border': alpha(palette.secondary, dark ? 44 : 38),
    '--hr-success': palette.secondary,
    '--hr-success-soft': alpha(palette.secondary, dark ? 17 : 14),
    '--hr-success-border': alpha(palette.secondary, dark ? 44 : 38),
    '--hr-warning': palette.warning,
    '--hr-warning-soft': alpha(palette.warning, dark ? 17 : 14),
    '--hr-warning-border': alpha(palette.warning, dark ? 44 : 38),
    '--hr-danger': palette.danger,
    '--hr-danger-soft': alpha(palette.danger, dark ? 17 : 14),
    '--hr-danger-border': alpha(palette.danger, dark ? 44 : 38),
    '--hr-info': palette.secondary,
    '--hr-info-soft': alpha(palette.secondary, dark ? 17 : 14),
    '--hr-info-border': alpha(palette.secondary, dark ? 44 : 38),
    '--hr-focus-ring': alpha(palette.accent, dark ? 42 : 34),
    '--hr-selection': alpha(palette.accent, dark ? 30 : 24),
    '--hr-scrollbar-track': palette.background,
    '--hr-scrollbar': palette.accent,
    '--hr-scrollbar-hover': palette.accentHover,
    '--hr-ambient-accent': alpha(palette.accent, dark ? 20 : 12),
    '--hr-ambient-info': alpha(palette.secondary, dark ? 16 : 10),
    '--hr-canvas-ambient-primary': alpha(palette.accent, dark ? 15 : 10),
    '--hr-canvas-ambient-secondary': alpha(palette.secondary, dark ? 10 : 7),
    '--hr-decorative-accent-soft': alpha(palette.accent, dark ? 17 : 14),
    '--hr-decorative-accent-border': alpha(palette.accent, dark ? 42 : 36),
    '--hr-decorative-speaking-soft': alpha(palette.secondary, dark ? 17 : 14),
    '--hr-decorative-speaking-border': alpha(palette.secondary, dark ? 42 : 36),
    '--hr-settings-sidebar': alpha(palette.secondary, dark ? 8 : 6),
    '--hr-settings-card': alpha(palette.panel, dark ? 92 : 100),
    '--hr-settings-card-hover': alpha(palette.accent, dark ? 14 : 10),
    '--hr-settings-divider': alpha(palette.accent, dark ? 24 : 22),
    '--hr-settings-active': alpha(palette.accent, dark ? 17 : 14),
    '--hr-settings-active-border': alpha(palette.accent, dark ? 50 : 44),
    '--hr-radius-lg': palette.radius ?? (dark ? '18px' : '14px'),
    '--hr-radius-md': dark ? '13px' : '10px',
    '--hr-radius-sm': '9px',
    '--hr-shadow-panel': dark
      ? `0 22px 64px rgba(0, 0, 0, 0.38), 0 0 28px ${alpha(palette.accent, 8)}`
      : `0 12px 34px rgba(37, 50, 58, 0.08), 0 0 22px ${alpha(palette.accent, 8)}`,
    '--hr-shadow-floating': dark
      ? `0 28px 90px rgba(0, 0, 0, 0.58), 0 0 34px ${alpha(palette.accent, 12)}`
      : `0 20px 54px rgba(37, 50, 58, 0.14), 0 0 28px ${alpha(palette.accent, 10)}`,
    '--hr-shadow-accent': `0 0 28px ${alpha(palette.accent, 22)}`,
  }
}

function registerSkinTheme(palette: SkinPalette): void {
  registerAppearance({
    id: palette.id,
    colorScheme: palette.colorScheme,
    labelKey: `settings.general.appearance.options.${palette.id}.label`,
    descriptionKey: `settings.general.appearance.options.${palette.id}.description`,
    themeColor: palette.themeColor,
    preview: {
      background: palette.background,
      panel: palette.panel,
      accent: palette.accent,
      text: palette.text,
    },
    tokens: skinTokens(palette),
  })
}

// These nine palettes translate the reference gallery into Homerail's live
// semantic-token contract. The source gallery files are composite screenshots,
// so they are used as visual references rather than injected as fake UI images.
registerSkinTheme({
  id: 'skin-01', colorScheme: 'light', themeColor: '#fbf1f2', background: '#fbf1f2',
  panel: '#fffafa', text: '#50363a', muted: '#96777d', accent: '#d86c80',
  accentHover: '#bd4f66', secondary: '#e7a0ad', warning: '#c8974b', danger: '#c84e63',
})
registerSkinTheme({
  id: 'skin-02', colorScheme: 'light', themeColor: '#fbf3d9', background: '#fbf3d9',
  panel: '#fffdf1', text: '#513b1e', muted: '#92744a', accent: '#c98c25',
  accentHover: '#a96d13', secondary: '#4f8b65', warning: '#d08b28', danger: '#bd4a32',
})
registerSkinTheme({
  id: 'skin-03', colorScheme: 'light', themeColor: '#fff4f2', background: '#fff4f2',
  panel: '#fffdfc', text: '#302327', muted: '#896f75', accent: '#d93632',
  accentHover: '#b92525', secondary: '#e97771', warning: '#d28a34', danger: '#b8202a',
})
registerSkinTheme({
  id: 'skin-04', colorScheme: 'light', themeColor: '#f5f5e9', background: '#f5f5e9',
  panel: '#fffef6', text: '#3c4435', muted: '#7e866f', accent: '#87976a',
  accentHover: '#6d7e53', secondary: '#b5b98b', warning: '#b48a42', danger: '#a35f55',
})
registerSkinTheme({
  id: 'skin-05', colorScheme: 'light', themeColor: '#fff8dc', background: '#fff8dc',
  panel: '#fffef8', text: '#30342b', muted: '#72796c', accent: '#16a594',
  accentHover: '#0c8478', secondary: '#ef7a66', warning: '#e0b52c', danger: '#d95f58',
})
registerSkinTheme({
  id: 'skin-06', colorScheme: 'light', themeColor: '#f1f0ff', background: '#f1f0ff',
  panel: '#fbfaff', text: '#292b58', muted: '#6f719d', accent: '#7359db',
  accentHover: '#5b40c3', secondary: '#39a9e8', warning: '#d49d38', danger: '#c9527c',
})
registerSkinTheme({
  id: 'skin-07', colorScheme: 'light', themeColor: '#edfaff', background: '#edfaff',
  panel: '#fbffff', text: '#24435b', muted: '#64859a', accent: '#18b9d0',
  accentHover: '#0a92ad', secondary: '#e85ea8', warning: '#e4ac39', danger: '#d8586d',
})
registerSkinTheme({
  id: 'skin-08', colorScheme: 'dark', themeColor: '#141313', background: '#141313',
  panel: '#211e1c', text: '#f3e8d5', muted: '#b4a58e', accent: '#d9b56e',
  accentHover: '#f0d18c', secondary: '#b88972', warning: '#e5b84c', danger: '#d77a72',
})
registerSkinTheme({
  id: 'skin-09', colorScheme: 'dark', themeColor: '#061124', background: '#061124',
  panel: '#0b1b35', text: '#e8f1ff', muted: '#91a8c8', accent: '#6da7ff',
  accentHover: '#9bc4ff', secondary: '#9cbbf6', warning: '#efbd62', danger: '#ee8c9e',
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
  if (current === 'dream') return 'skin-09'
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
