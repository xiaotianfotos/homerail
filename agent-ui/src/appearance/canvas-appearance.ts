/**
 * Canvas renderers cannot use `var(--hr-*)` as paint values. This bridge reads
 * the same public appearance contract used by DOM components and refreshes it
 * whenever the selected appearance changes.
 */
export interface CanvasAppearancePalette {
  panel: string
  border: string
  borderStrong: string
  text1: string
  text2: string
  onStrong: string
  accent: string
  accentBorder: string
  focusRing: string
  speaking: string
  success: string
  successBorder: string
  warning: string
  warningBorder: string
  danger: string
  dangerBorder: string
  info: string
}

const FALLBACK_CANVAS_PALETTE: CanvasAppearancePalette = {
  panel: '#0a0f17',
  border: 'rgba(148, 178, 214, 0.1)',
  borderStrong: 'rgba(148, 178, 214, 0.2)',
  text1: '#edf4fc',
  text2: '#d6e2f1',
  onStrong: '#ffffff',
  accent: '#4fd8e8',
  accentBorder: 'rgba(79, 216, 232, 0.3)',
  focusRing: 'rgba(79, 216, 232, 0.32)',
  speaking: '#a5b4fc',
  success: '#5ee2ad',
  successBorder: 'rgba(52, 211, 153, 0.32)',
  warning: '#fbc94b',
  warningBorder: 'rgba(251, 191, 36, 0.34)',
  danger: '#fca5a5',
  dangerBorder: 'rgba(248, 113, 113, 0.34)',
  info: '#93c5fd',
}

export function readCanvasAppearancePalette(
  doc: Document | undefined = typeof document === 'undefined' ? undefined : document,
): CanvasAppearancePalette {
  if (!doc?.defaultView) return { ...FALLBACK_CANVAS_PALETTE }
  const styles = doc.defaultView.getComputedStyle(doc.documentElement)
  const token = (name: string, fallback: string): string => styles.getPropertyValue(name).trim() || fallback
  return {
    panel: token('--hr-panel', FALLBACK_CANVAS_PALETTE.panel),
    border: token('--hr-border', FALLBACK_CANVAS_PALETTE.border),
    borderStrong: token('--hr-border-strong', FALLBACK_CANVAS_PALETTE.borderStrong),
    text1: token('--hr-text-1', FALLBACK_CANVAS_PALETTE.text1),
    text2: token('--hr-text-2', FALLBACK_CANVAS_PALETTE.text2),
    onStrong: token('--hr-on-strong', FALLBACK_CANVAS_PALETTE.onStrong),
    accent: token('--hr-accent', FALLBACK_CANVAS_PALETTE.accent),
    accentBorder: token('--hr-accent-border', FALLBACK_CANVAS_PALETTE.accentBorder),
    focusRing: token('--hr-focus-ring', FALLBACK_CANVAS_PALETTE.focusRing),
    speaking: token('--hr-speaking', FALLBACK_CANVAS_PALETTE.speaking),
    success: token('--hr-success', FALLBACK_CANVAS_PALETTE.success),
    successBorder: token('--hr-success-border', FALLBACK_CANVAS_PALETTE.successBorder),
    warning: token('--hr-warning', FALLBACK_CANVAS_PALETTE.warning),
    warningBorder: token('--hr-warning-border', FALLBACK_CANVAS_PALETTE.warningBorder),
    danger: token('--hr-danger', FALLBACK_CANVAS_PALETTE.danger),
    dangerBorder: token('--hr-danger-border', FALLBACK_CANVAS_PALETTE.dangerBorder),
    info: token('--hr-info', FALLBACK_CANVAS_PALETTE.info),
  }
}

export function observeCanvasAppearance(
  listener: (palette: CanvasAppearancePalette) => void,
  doc: Document | undefined = typeof document === 'undefined' ? undefined : document,
): () => void {
  if (!doc || typeof MutationObserver === 'undefined') return () => undefined
  const publish = () => listener(readCanvasAppearancePalette(doc))
  const observer = new MutationObserver(publish)
  observer.observe(doc.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'data-hr-appearance', 'style'],
  })
  return () => observer.disconnect()
}
