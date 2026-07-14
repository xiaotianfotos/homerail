import { describe, expect, it } from 'vitest'
import { resolveGenerativeUiDeviceContext } from './device-context'

describe('resolveGenerativeUiDeviceContext', () => {
  it('maps portrait and landscape phones to finite host viewports', () => {
    expect(resolveGenerativeUiDeviceContext({ width: 390, height: 844, maxTouchPoints: 5 }))
      .toMatchObject({ device: 'phone', input: 'touch', viewport: 'compact' })
    expect(resolveGenerativeUiDeviceContext({ width: 844, height: 390, maxTouchPoints: 5 }))
      .toMatchObject({ device: 'phone', input: 'touch', viewport: 'regular' })
  })

  it('maps desktop and TV without exposing pixel layout to renderers', () => {
    expect(resolveGenerativeUiDeviceContext({ width: 1600, height: 900, maxTouchPoints: 0 }))
      .toMatchObject({ device: 'desktop', input: 'mouse', viewport: 'wide' })
    expect(resolveGenerativeUiDeviceContext({
      width: 1920,
      height: 1080,
      userAgent: 'Mozilla/5.0 (Linux; Android TV)',
      activeRunId: 'run-1',
    })).toEqual({
      device: 'tv',
      input: 'gamepad',
      viewport: 'wide',
      attention: 'focused',
      active_run_id: 'run-1',
    })
  })
})
