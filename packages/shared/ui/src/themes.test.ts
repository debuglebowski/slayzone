import { afterEach, describe, expect, it } from 'vitest'
import * as tokens from '@slayzone/theme-tokens'
import {
  applyChromeColors,
  clearChromeColors,
  getChromeStyleOverrides,
  getThemeChrome,
  getThemeEditorColors,
  getThemeTerminalColors,
  getThemeVariant,
  getUnifiedTheme,
  unifiedThemes
} from './index'

/**
 * The presets moved to `@slayzone/theme-tokens`; desktop still reads them through
 * `@slayzone/ui`. Pins that ui hands out exactly those objects and paints their
 * ORIGINAL colour strings (never the hex the mobile app converts them to).
 */

const variants = unifiedThemes.flatMap((t) =>
  (['dark', 'light'] as const).filter((v) => t[v]).map((v) => [t.id, v] as const)
)

/** `cardForeground` → `--card-foreground`, `chart1` → `--chart-1`. */
const cssVar = (key: string): string =>
  `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/(\d)/, '-$1')}`

describe('@slayzone/ui theme re-exports', () => {
  it('are the theme-tokens functions and data, not copies', () => {
    expect(unifiedThemes).toBe(tokens.unifiedThemes)
    expect(getUnifiedTheme).toBe(tokens.getUnifiedTheme)
    expect(getThemeVariant).toBe(tokens.getThemeVariant)
    expect(getThemeChrome).toBe(tokens.getThemeChrome)
    expect(getThemeTerminalColors).toBe(tokens.getThemeTerminalColors)
    expect(getThemeEditorColors).toBe(tokens.getThemeEditorColors)
  })
})

describe('chrome CSS variables', () => {
  afterEach(() => clearChromeColors())

  it.each(variants)('%s %s: every variable is the preset string as written', (id, v) => {
    const chrome = tokens.getThemeChrome(id, v)
    const style = getChromeStyleOverrides(getThemeChrome(id, v))
    expect(Object.keys(style)).toHaveLength(Object.keys(chrome).length)
    for (const [key, value] of Object.entries(chrome)) {
      expect(style[cssVar(key)], `${key} → ${cssVar(key)}`).toBe(value)
    }
    applyChromeColors(chrome)
    for (const [name, value] of Object.entries(style)) {
      expect(document.documentElement.style.getPropertyValue(name), name).toBe(value)
    }
  })

  it('slay: dark stays hex, light stays oklch()', () => {
    expect(getChromeStyleOverrides(getThemeChrome('slay', 'dark'))['--background']).toBe('#282c34')
    expect(getChromeStyleOverrides(getThemeChrome('slay', 'light'))['--background']).toBe(
      'oklch(0.94 0 0)'
    )
    expect(getChromeStyleOverrides(getThemeChrome('slay', 'light'))['--chart-1']).toBe(
      'oklch(0.646 0.222 41.116)'
    )
  })

  it('clearChromeColors removes every variable', () => {
    applyChromeColors(getThemeChrome('nord', 'dark'))
    clearChromeColors()
    for (const name of Object.keys(getChromeStyleOverrides(getThemeChrome('nord', 'dark')))) {
      expect(document.documentElement.style.getPropertyValue(name), name).toBe('')
    }
  })
})
