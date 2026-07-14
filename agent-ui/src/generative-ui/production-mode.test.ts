import { describe, expect, it } from 'vitest'
import {
  resolveVoiceGenerativeUiPresentation,
  showLegacyWidgetAlongsideCanonical,
} from './production-mode'

describe('Voice Generative UI production presentation', () => {
  it('uses canonical prefer only after an authoritative projection is available', () => {
    expect(resolveVoiceGenerativeUiPresentation({
      mode: 'prefer',
      canonical_available: false,
      shadow_preview_requested: false,
    })).toEqual({
      show_shadow: false,
      request_canonical: true,
      show_canonical: false,
      show_legacy: true,
    })
    expect(resolveVoiceGenerativeUiPresentation({
      mode: 'prefer',
      canonical_available: true,
      shadow_preview_requested: false,
    })).toEqual({
      show_shadow: false,
      request_canonical: true,
      show_canonical: true,
      show_legacy: true,
    })
  })

  it('keeps legacy core UI while hiding only a duplicate bridge for a canonical plugin node', () => {
    const presentation = resolveVoiceGenerativeUiPresentation({
      mode: 'prefer',
      canonical_available: true,
      shadow_preview_requested: false,
    })
    const canonical = new Set(['plugin-card'])
    expect(showLegacyWidgetAlongsideCanonical('task-draft', presentation, canonical)).toBe(true)
    expect(showLegacyWidgetAlongsideCanonical('manager-progress', presentation, canonical)).toBe(true)
    expect(showLegacyWidgetAlongsideCanonical('plugin-card', presentation, canonical)).toBe(false)
  })

  it('keeps shadow opt-in/read-only and off on the exact legacy path', () => {
    expect(resolveVoiceGenerativeUiPresentation({
      mode: 'shadow',
      canonical_available: true,
      shadow_preview_requested: false,
    }).show_legacy).toBe(true)
    expect(resolveVoiceGenerativeUiPresentation({
      mode: 'shadow',
      canonical_available: false,
      shadow_preview_requested: true,
    })).toMatchObject({ show_shadow: true, show_canonical: false, show_legacy: false })
    expect(resolveVoiceGenerativeUiPresentation({
      mode: 'off',
      canonical_available: true,
      shadow_preview_requested: true,
    })).toEqual({
      show_shadow: false,
      request_canonical: false,
      show_canonical: false,
      show_legacy: true,
    })
  })
})
