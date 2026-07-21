export interface HomeRailDebugApi {
  gamepadMonitor?: (visible?: boolean) => boolean
  [key: string]: unknown
}

export interface HomeRailDebugHost {
  HomeRailDebug?: HomeRailDebugApi
}

export type GamepadMonitorCommand = (visible?: boolean) => boolean

/**
 * Installs the console-only gamepad monitor command without replacing other
 * HomeRail debug tools. The returned cleanup only removes this installation.
 */
export function installGamepadMonitorDebugApi(
  target: object,
  command: GamepadMonitorCommand,
): () => void {
  const host = target as HomeRailDebugHost
  const existing = host.HomeRailDebug
  const debugApi = existing && typeof existing === 'object' ? existing : {}
  debugApi.gamepadMonitor = command
  host.HomeRailDebug = debugApi

  return () => {
    if (host.HomeRailDebug?.gamepadMonitor !== command) return
    delete host.HomeRailDebug.gamepadMonitor
    if (Object.keys(host.HomeRailDebug).length === 0) delete host.HomeRailDebug
  }
}
