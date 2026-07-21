import { describe, expect, it, vi } from 'vitest'
import {
  installGamepadMonitorDebugApi,
  type HomeRailDebugHost,
} from './gamepad-monitor-debug'

describe('gamepad monitor debug API', () => {
  it('opens, closes, and queries the monitor through the console command', () => {
    const host: HomeRailDebugHost = {}
    let visible = false
    const command = vi.fn((next?: boolean) => {
      if (typeof next === 'boolean') visible = next
      return visible
    })

    const uninstall = installGamepadMonitorDebugApi(host, command)

    expect(host.HomeRailDebug?.gamepadMonitor?.()).toBe(false)
    expect(host.HomeRailDebug?.gamepadMonitor?.(true)).toBe(true)
    expect(host.HomeRailDebug?.gamepadMonitor?.(false)).toBe(false)

    uninstall()
    expect(host.HomeRailDebug).toBeUndefined()
  })

  it('preserves other debug commands and does not remove replacements', () => {
    const replacement = () => true
    const host: HomeRailDebugHost = { HomeRailDebug: { keep: 'value' } }
    const uninstall = installGamepadMonitorDebugApi(host, () => false)

    host.HomeRailDebug!.gamepadMonitor = replacement
    uninstall()

    expect(host.HomeRailDebug).toEqual({ keep: 'value', gamepadMonitor: replacement })
  })
})
