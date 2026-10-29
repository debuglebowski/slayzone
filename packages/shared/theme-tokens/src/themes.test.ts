import { describe, expect, it } from 'vitest'
import { toHex } from './color'
import { getThemeChromeHex } from './chrome-hex'
import { getThemeChrome, getThemeVariant, getUnifiedTheme, unifiedThemes } from './themes'
import type { Theme, UnifiedThemeVariant } from './types'

const HEX = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/

/** Every variant a preset DEFINES (not the light → dark fallback). */
const definedVariants: Array<[string, Theme, UnifiedThemeVariant]> = unifiedThemes.flatMap((t) =>
  (['dark', 'light'] as const).flatMap((v) => {
    const variant = t[v]
    return variant ? [[t.id, v, variant] as [string, Theme, UnifiedThemeVariant]] : []
  })
)

describe('every preset colour converts to RN-safe hex', () => {
  // Fails when a preset gains a colour syntax the converter does not read — the mobile
  // app would otherwise get it at runtime. Extend `parseColor` (with tests) instead.
  it.each(definedVariants)('%s %s', (_id, _variant, variant) => {
    for (const palette of ['chrome', 'terminal', 'editor'] as const) {
      for (const [key, value] of Object.entries(variant[palette])) {
        let hex: string
        try {
          hex = toHex(value)
        } catch (err) {
          throw new Error(`${palette}.${key}: ${err instanceof Error ? err.message : String(err)}`)
        }
        expect(hex, `${palette}.${key} = ${value}`).toMatch(HEX)
      }
    }
  })

  it('covers all 14 presets, each with a dark variant', () => {
    expect(unifiedThemes).toHaveLength(14)
    expect(new Set(unifiedThemes.map((t) => t.id)).size).toBe(14)
    for (const t of unifiedThemes) expect(t.dark, t.id).toBeDefined()
  })

  // The key set itself is ChromeColors' (TypeScript enforces it per preset); this pins
  // that no preset carries extra keys the others lack.
  it('every chrome palette has the same keys', () => {
    const keys = Object.keys(getThemeChrome('slay', 'dark')).sort()
    for (const [id, v, variant] of definedVariants) {
      expect(Object.keys(variant.chrome).sort(), `${id} ${v}`).toEqual(keys)
    }
  })
})

describe('getThemeChromeHex', () => {
  it.each(definedVariants)('%s %s: same keys, hex values, hex input unchanged', (id, v) => {
    const original = getThemeChrome(id, v)
    const hex = getThemeChromeHex(id, v)
    expect(Object.keys(hex)).toEqual(Object.keys(original))
    for (const [key, value] of Object.entries(hex)) {
      expect(value, key).toMatch(HEX)
      const source = original[key as keyof typeof original]
      if (/^#[0-9a-f]{6}$/i.test(source)) expect(value, key).toBe(source.toLowerCase())
    }
  })

  it('the default preset: slay dark background is #282c34, light is converted oklch', () => {
    expect(getThemeChromeHex('slay', 'dark').background).toBe('#282c34')
    expect(getThemeChromeHex('slay', 'dark').border).toBe('#ffffff26')
    expect(getThemeChromeHex('slay', 'light').background).toBe('#ebebeb')
    expect(getThemeChromeHex('slay', 'light').border).toBe('#00000038')
  })

  it('a preset without a light variant answers with its dark one; unknown id → slay', () => {
    const darkOnly = unifiedThemes.find((t) => !t.light)
    expect(darkOnly).toBeDefined()
    if (!darkOnly) return
    expect(getThemeChromeHex(darkOnly.id, 'light')).toEqual(getThemeChromeHex(darkOnly.id, 'dark'))
    expect(getThemeChromeHex('no-such-theme', 'light')).toEqual(getThemeChromeHex('slay', 'light'))
  })

  it('leaves the presets untouched (desktop paints the original strings)', () => {
    getThemeChromeHex('slay', 'light')
    expect(getThemeChrome('slay', 'light').background).toBe('oklch(0.94 0 0)')
    expect(getThemeVariant('slay', 'light')).toBe(getUnifiedTheme('slay').light)
  })
})
