import type {
  GenerativeUiCanvasSize,
  GenerativeUiDensity,
  GenerativeUiSurfaceContextV1,
} from 'homerail-protocol'

export function defaultCanvasSize(density: GenerativeUiDensity): GenerativeUiCanvasSize {
  if (density === 'glance') return '1x1'
  if (density === 'summary') return '1x2'
  return '2x2'
}

export function canvasColumnCount(
  context: Pick<GenerativeUiSurfaceContextV1, 'device' | 'viewport'>,
): 1 | 2 | 3 {
  if (context.device === 'phone' || context.viewport === 'compact') return 1
  if (context.device === 'tv') return 2
  return 3
}

export function canvasRowCount(sizes: readonly GenerativeUiCanvasSize[]): 2 | 3 {
  return sizes.includes('3x3') ? 3 : 2
}

export function resolveCanvasSize(
  requested: GenerativeUiCanvasSize | undefined,
  density: GenerativeUiDensity,
  context: Pick<GenerativeUiSurfaceContextV1, 'device' | 'viewport'>,
): GenerativeUiCanvasSize {
  const size = requested ?? defaultCanvasSize(density)
  if (context.device === 'phone' || context.viewport === 'compact') {
    return size === '1x1' ? '1x1' : '1x2'
  }
  if (context.device === 'tv' && size === '3x3') return '2x2'
  return size
}
