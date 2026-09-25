import { describe, expect, it } from 'vitest'
import {
  buildEmulatedMediaParams,
  buildForcedHtmlThemeCss,
  buildForcedHtmlThemeScript,
  FORCED_HTML_THEME_STYLE_ID,
  HTML_THEME_CYCLE,
  injectForcedHtmlTheme,
  nextHtmlTheme
} from './forced-html-theme'

describe('buildEmulatedMediaParams', () => {
  it('builds the CDP feature override', () => {
    expect(buildEmulatedMediaParams('dark')).toEqual({
      features: [{ name: 'prefers-color-scheme', value: 'dark' }]
    })
    expect(buildEmulatedMediaParams('light')).toEqual({
      features: [{ name: 'prefers-color-scheme', value: 'light' }]
    })
  })

  it('builds the reset call for null', () => {
    expect(buildEmulatedMediaParams(null)).toEqual({ features: [] })
  })
})

describe('buildForcedHtmlThemeCss', () => {
  it('sets color-scheme', () => {
    expect(buildForcedHtmlThemeCss('dark')).toContain('color-scheme:dark')
    expect(buildForcedHtmlThemeCss('light')).toContain('color-scheme:light')
  })

  // The bug this module replaced. Forcing a theme by inverting the page turns
  // a dark-authored page light; keep it impossible to reintroduce here.
  it('never inverts', () => {
    for (const theme of ['dark', 'light'] as const) {
      const css = buildForcedHtmlThemeCss(theme)
      expect(css).not.toContain('invert')
      expect(css).not.toContain('hue-rotate')
      expect(css).not.toContain('filter')
    }
  })
})

describe('nextHtmlTheme', () => {
  it('cycles system -> dark -> light -> system', () => {
    expect(nextHtmlTheme('system')).toBe('dark')
    expect(nextHtmlTheme('dark')).toBe('light')
    expect(nextHtmlTheme('light')).toBe('system')
  })

  it('covers every mode in the cycle', () => {
    expect([...HTML_THEME_CYCLE].sort()).toEqual(['dark', 'light', 'system'])
  })
})

describe('buildForcedHtmlThemeScript', () => {
  const run = (src: string) => new Function(src)

  it('is syntactically valid standalone JS', () => {
    expect(() => run(buildForcedHtmlThemeScript('dark'))).not.toThrow()
    expect(() => run(buildForcedHtmlThemeScript(null))).not.toThrow()
  })

  it('never inverts', () => {
    expect(buildForcedHtmlThemeScript('dark')).not.toContain('invert')
    expect(buildForcedHtmlThemeScript('dark')).not.toContain('hue-rotate')
  })

  it('removes any previously injected style before adding its own', () => {
    // Re-running on every navigation must replace, not stack.
    const src = buildForcedHtmlThemeScript('dark')
    expect(src).toContain(FORCED_HTML_THEME_STYLE_ID)
    expect(src).toContain('removeChild')
  })

  it('does not throw when there is no document', () => {
    // Runs inside a try/catch so an early injection cannot break the page.
    expect(() => run(buildForcedHtmlThemeScript('dark')).call(undefined)).not.toThrow()
  })
})

describe('injectForcedHtmlTheme', () => {
  it('stamps data-theme on a bare <html> tag', () => {
    const out = injectForcedHtmlTheme('<html><head></head><body>x</body></html>', 'dark')
    expect(out).toContain('<html data-theme="dark">')
  })

  it('preserves existing attributes on <html>', () => {
    const out = injectForcedHtmlTheme('<html lang="en" class="a"><head></head></html>', 'dark')
    expect(out).toContain('lang="en"')
    expect(out).toContain('class="a"')
    expect(out).toContain('data-theme="dark"')
  })

  it('replaces an existing data-theme rather than duplicating it', () => {
    const out = injectForcedHtmlTheme('<html data-theme="light"><head></head></html>', 'dark')
    expect(out).toContain('data-theme="dark"')
    expect(out).not.toContain('data-theme="light"')
    expect(out.match(/data-theme=/g)).toHaveLength(1)
  })

  it('keeps a DOCTYPE prefix intact', () => {
    const out = injectForcedHtmlTheme('<!DOCTYPE html>\n<html><head></head></html>', 'dark')
    expect(out.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(out).toContain('data-theme="dark"')
  })

  it('inserts the style before </head>', () => {
    const out = injectForcedHtmlTheme(
      '<html><head><title>t</title></head><body></body></html>',
      'dark'
    )
    expect(out.indexOf(FORCED_HTML_THEME_STYLE_ID)).toBeLessThan(out.indexOf('</head>'))
  })

  it('matches a closing head tag case-insensitively', () => {
    const out = injectForcedHtmlTheme('<html><head></HEAD><body></body></html>', 'dark')
    expect(out.indexOf(FORCED_HTML_THEME_STYLE_ID)).toBeLessThan(out.indexOf('</HEAD>'))
  })

  it('prepends when there is no head', () => {
    const out = injectForcedHtmlTheme('<html><body>x</body></html>', 'dark')
    expect(out).toContain(FORCED_HTML_THEME_STYLE_ID)
    expect(out).toContain('data-theme="dark"')
  })

  it('falls back to a script when there is no <html> tag to stamp', () => {
    const out = injectForcedHtmlTheme('<body>fragment</body>', 'dark')
    expect(out).toContain('<script>')
    expect(out).toContain(FORCED_HTML_THEME_STYLE_ID)
  })

  it('is idempotent', () => {
    const once = injectForcedHtmlTheme('<html lang="en"><head></head><body></body></html>', 'dark')
    const twice = injectForcedHtmlTheme(once, 'dark')
    expect(twice.match(/data-theme=/g)).toHaveLength(1)
  })

  it('never injects an inversion', () => {
    const out = injectForcedHtmlTheme('<html><head></head><body></body></html>', 'dark')
    expect(out).not.toContain('invert')
    expect(out).not.toContain('hue-rotate')
  })
})
