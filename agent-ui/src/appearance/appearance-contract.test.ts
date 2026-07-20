import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APPEARANCE_TOKEN_NAMES } from './appearance-registry'

const sourceRoot = resolve(import.meta.dirname, '..')

function source(relativePath: string): string {
  return readFileSync(resolve(sourceRoot, relativePath), 'utf8')
}

describe('appearance contract', () => {
  it('defines every public semantic token for both built-in appearances', () => {
    const css = source('styles/hr-theme.css')
    for (const tokenName of APPEARANCE_TOKEN_NAMES) {
      const declarations = css.match(new RegExp(`${tokenName.replaceAll('-', '\\-')}\\s*:`, 'g')) ?? []
      expect(declarations.length, tokenName).toBeGreaterThanOrEqual(2)
    }
  })

  it('keeps the paper appearance on subdued surfaces instead of pure white', () => {
    const css = source('styles/hr-theme.css')
    const paper = css.slice(css.indexOf(":root[data-hr-appearance='paper']"), css.indexOf('::selection'))

    expect(paper).toContain('--hr-bg: #e9edef')
    expect(paper).toContain('--hr-panel: #f7f8f7')
    expect(paper).not.toMatch(/--hr-(?:bg-raised|surface-1|panel):\s*#fff(?:fff)?\b/i)
  })

  it('themes native select popup menus with semantic colors on Windows and other host UIs', () => {
    const css = source('styles/hr-theme.css')

    expect(css).toMatch(/select,\s*option,\s*optgroup\s*\{[^}]*color-scheme:\s*inherit/s)
    expect(css).toMatch(
      /select option,\s*select optgroup\s*\{[^}]*background-color:\s*var\(--hr-bg-raised\);[^}]*color:\s*var\(--hr-text-1\)/s,
    )
    expect(css).toMatch(
      /@media\s*\(forced-colors:\s*active\)[^{]*\{[\s\S]*background-color:\s*Canvas;[\s\S]*color:\s*CanvasText/,
    )
  })

  it('prepaints the stored appearance before the application entry module', () => {
    const html = readFileSync(resolve(sourceRoot, '../index.html'), 'utf8')
    expect(html.indexOf('homerail.appearance')).toBeGreaterThan(-1)
    expect(html.indexOf('homerail.appearance')).toBeLessThan(html.indexOf('/src/main.ts'))
    expect(html).toContain('data-hr-appearance="cockpit"')
  })

  it('keeps critical cross-appearance surfaces off legacy dark-only colors', () => {
    const criticalFiles = [
      'components/agent/onboarding/OnboardingWizard.vue',
      'components/agent/onboarding/OnboardingStepForm.vue',
      'components/generative-ui/GenerativeUiNodeHost.vue',
      'components/generative-ui/GenerativeUiCanonicalSurface.vue',
      'components/generative-ui/GenerativeUiFallbackRenderer.vue',
      'components/generative-ui/GenerativeUiShadowPreview.vue',
    ]
    const legacyDarkOnly = /rgba\(255,\s*255,\s*255,\s*0\.|rgba\((?:7|8|9|10),\s*(?:13|18|19|20|23|26|28|31),/

    for (const file of criticalFiles) {
      expect(source(file), file).not.toMatch(legacyDarkOnly)
    }
  })
})
