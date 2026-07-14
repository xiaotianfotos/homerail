export type VoiceGenerativeUiMode = 'off' | 'shadow' | 'prefer'

export interface VoiceGenerativeUiPresentation {
  show_shadow: boolean
  request_canonical: boolean
  show_canonical: boolean
  show_legacy: boolean
}

/**
 * `prefer` adds authoritative canonical plugin nodes only after Manager proves
 * that a projection exists, while retaining the legacy core canvas through M6.
 * Shadow remains an explicit, read-only developer surface; off is always the
 * exact legacy path.
 */
export function resolveVoiceGenerativeUiPresentation(input: {
  mode?: VoiceGenerativeUiMode
  canonical_available: boolean
  shadow_preview_requested: boolean
}): VoiceGenerativeUiPresentation {
  const showShadow = input.mode === 'shadow' && input.shadow_preview_requested
  const requestCanonical = input.mode === 'prefer'
  const showCanonical = requestCanonical && input.canonical_available
  return {
    show_shadow: showShadow,
    request_canonical: requestCanonical,
    show_canonical: showCanonical,
    // M5-M6 prefer composes canonical plugin nodes with the retained legacy
    // core canvas. Retiring that fallback path is explicitly out of scope.
    show_legacy: !showShadow,
  }
}

export function showLegacyWidgetAlongsideCanonical(
  widgetId: string,
  presentation: VoiceGenerativeUiPresentation,
  canonicalNodeIds: ReadonlySet<string>,
): boolean {
  return !presentation.show_canonical || !canonicalNodeIds.has(widgetId)
}
