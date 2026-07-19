import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  APPEARANCE_COLOR_SCHEME_STORAGE_KEY,
  APPEARANCE_STORAGE_KEY,
  ARTIFACT_APPEARANCE_MESSAGE_TYPE,
  applyAppearanceToDocument,
  artifactAppearanceMessage,
  getAppearancePlugin,
  listAppearancePlugins,
  normalizeAppearanceId,
  registerAppearance,
  resolveStoredAppearance,
  subscribeAppearanceRegistry,
} from './appearance-registry'

describe('appearance registry', () => {
  afterEach(() => {
    localStorage.clear()
    applyAppearanceToDocument('cockpit')
  })

  it('ships the cockpit and paper appearances and normalizes unknown ids', () => {
    expect(listAppearancePlugins().map(plugin => plugin.id)).toEqual(
      expect.arrayContaining(['cockpit', 'paper']),
    )
    expect(getAppearancePlugin('paper').colorScheme).toBe('light')
    expect(normalizeAppearanceId('missing')).toBe('cockpit')
  })

  it('migrates both legacy appearance storage formats', () => {
    localStorage.setItem('homerail.skin', 'paper')
    expect(resolveStoredAppearance(localStorage)).toBe('paper')

    localStorage.clear()
    localStorage.setItem('omni_theme', 'light')
    expect(resolveStoredAppearance(localStorage)).toBe('paper')

    localStorage.setItem(APPEARANCE_STORAGE_KEY, 'cockpit')
    expect(resolveStoredAppearance(localStorage)).toBe('cockpit')
  })

  it('applies color scheme, document state, and theme metadata together', () => {
    const themeColor = document.createElement('meta')
    themeColor.name = 'theme-color'
    document.head.appendChild(themeColor)

    applyAppearanceToDocument('paper')

    expect(document.documentElement.dataset.hrAppearance).toBe('paper')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(themeColor.content).toBe(getAppearancePlugin('paper').themeColor)
    expect(localStorage.getItem(APPEARANCE_COLOR_SCHEME_STORAGE_KEY)).toBe('light')

    themeColor.remove()
  })

  it('broadcasts the resolved appearance to marked Artifact frames', () => {
    const frame = document.createElement('iframe')
    frame.dataset.homerailArtifactFrame = ''
    document.body.appendChild(frame)
    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage')

    applyAppearanceToDocument('paper')

    const message = artifactAppearanceMessage()
    expect(message).toMatchObject({
      type: ARTIFACT_APPEARANCE_MESSAGE_TYPE,
      version: 1,
      colorScheme: 'light',
    })
    expect(message.scrollbarTrack).toBeTruthy()
    expect(message.scrollbar).toBeTruthy()
    expect(message.scrollbarHover).toBeTruthy()
    expect(postMessage).toHaveBeenCalledWith(message, '*')

    frame.remove()
  })

  it('supports self-contained plugin tokens and clears them when switching', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeAppearanceRegistry(listener)
    const id = 'test-inline-appearance'

    if (!listAppearancePlugins().some(plugin => plugin.id === id)) {
      registerAppearance({
        id,
        colorScheme: 'light',
        labelKey: 'test.label',
        descriptionKey: 'test.description',
        themeColor: '#faf7f2',
        preview: {
          background: '#faf7f2',
          panel: '#ffffff',
          accent: '#6b4f2b',
          text: '#241b12',
        },
        tokens: {
          '--hr-bg': '#faf7f2',
          '--hr-text-1': '#241b12',
        },
      })
      expect(listener).toHaveBeenCalledOnce()
    }

    applyAppearanceToDocument(id)
    expect(document.documentElement.style.getPropertyValue('--hr-bg')).toBe('#faf7f2')
    expect(document.documentElement.style.getPropertyValue('--hr-text-1')).toBe('#241b12')

    applyAppearanceToDocument('cockpit')
    expect(document.documentElement.style.getPropertyValue('--hr-bg')).toBe('')
    expect(document.documentElement.style.getPropertyValue('--hr-text-1')).toBe('')
    unsubscribe()
  })

  it('rejects token names outside the public appearance contract', () => {
    expect(() => registerAppearance({
      id: 'invalid-token-appearance',
      colorScheme: 'dark',
      labelKey: 'test.label',
      descriptionKey: 'test.description',
      themeColor: '#000000',
      preview: {
        background: '#000000',
        panel: '#111111',
        accent: '#ffffff',
        text: '#ffffff',
      },
      tokens: {
        '--not-a-homerail-token': '#ffffff',
      } as never,
    })).toThrow('invalid token')
  })
})
