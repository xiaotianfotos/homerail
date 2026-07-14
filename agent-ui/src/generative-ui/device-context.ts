import type { GenerativeUiSurfaceContextV1 } from 'homerail-protocol'

export interface GenerativeUiDeviceSignals {
  width: number
  height: number
  userAgent?: string
  maxTouchPoints?: number
  activeRunId?: string | null
}

export function resolveGenerativeUiDeviceContext(
  signals: GenerativeUiDeviceSignals,
): GenerativeUiSurfaceContextV1 {
  const width = Number.isFinite(signals.width) ? Math.max(0, signals.width) : 0
  const height = Number.isFinite(signals.height) ? Math.max(0, signals.height) : 0
  const userAgent = signals.userAgent ?? ''
  const tv = /android tv|smart-tv|smarttv|googletv|aft\w*\b|homerail-tv/i.test(userAgent)
  if (tv) {
    return {
      device: 'tv',
      input: 'gamepad',
      viewport: width >= 1280 ? 'wide' : 'regular',
      attention: 'focused',
      ...(signals.activeRunId ? { active_run_id: signals.activeRunId } : {}),
    }
  }
  const phone = Math.min(width, height) <= 640 || /iphone|android.+mobile/i.test(userAgent)
  if (phone) {
    return {
      device: 'phone',
      input: 'touch',
      viewport: height >= width ? 'compact' : 'regular',
      attention: 'focused',
      ...(signals.activeRunId ? { active_run_id: signals.activeRunId } : {}),
    }
  }
  return {
    device: 'desktop',
    input: (signals.maxTouchPoints ?? 0) > 0 ? 'touch' : 'mouse',
    viewport: width >= 1280 ? 'wide' : width >= 760 ? 'regular' : 'compact',
    attention: 'focused',
    ...(signals.activeRunId ? { active_run_id: signals.activeRunId } : {}),
  }
}
