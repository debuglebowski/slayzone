import { describe, expect, it } from 'vitest'
import { toHexColors } from './color'
import { getThemeChromeHex } from './chrome-hex'
import { type HubThemeSettings, resolveNativeTheme } from './native-theme'
import type { StoredAppTheme } from './selection'
import { getThemeChrome, unifiedThemes } from './themes'

/**
 * The mobile app's whole theme decision, as one pure function: the signed-in user's
 * hub settings + the device's light/dark scheme → preset, variant, hex colours.
 */

const nothing: StoredAppTheme = {
  themeId: null,
  split: null,
  themeIdDark: null,
  themeIdLight: null
}
const hub = (
  stored: Partial<StoredAppTheme>,
  preference: string | null = 'system'
): HubThemeSettings => ({
  preference,
  stored: { ...nothing, ...stored }
})

describe('resolveNativeTheme', () => {
  describe('signed out / settings not loaded (hub null): slay in the device scheme', () => {
    it('dark device → slay dark, desktop’s #282c34 background', () => {
      const t = resolveNativeTheme(null, 'dark')
      expect(t.themeId).toBe('slay')
      expect(t.variant).toBe('dark')
      expect(t.colors.background).toBe('#282c34')
      expect(t.colors.foreground).toBe('#ffffff')
      expect(t.colors.border).toBe('#ffffff26')
    })

    it('light device → slay light, its oklch() converted to hex', () => {
      const t = resolveNativeTheme(null, 'light')
      expect(t).toMatchObject({ themeId: 'slay', variant: 'light' })
      expect(t.colors.background).toBe('#ebebeb') // oklch(0.94 0 0)
      expect(t.colors.foreground).toBe('#070707') // oklch(0.13 0 0)
      expect(t.colors.destructive).toBe('#e7000b') // oklch(0.577 0.245 27.325), clamped
      expect(t.colors.border).toBe('#00000038') // oklch(0 0 0 / 22%)
    })

    it("a scheme the OS does not state ('unspecified', null) → dark, desktop’s default", () => {
      expect(resolveNativeTheme(null, 'unspecified').variant).toBe('dark')
      expect(resolveNativeTheme(null, null).variant).toBe('dark')
      expect(resolveNativeTheme(null, undefined).variant).toBe('dark')
    })
  })

  describe('signed in: the stored preset', () => {
    it('nothing stored → slay, like desktop’s first run', () => {
      expect(resolveNativeTheme(hub({}), 'light')).toEqual(resolveNativeTheme(null, 'light'))
      expect(resolveNativeTheme(hub({}), 'dark')).toEqual(resolveNativeTheme(null, 'dark'))
    })

    it('a second preset (catppuccin) in both variants, colours = its own chrome as hex', () => {
      for (const variant of ['dark', 'light'] as const) {
        const t = resolveNativeTheme(hub({ themeId: 'catppuccin' }), variant)
        expect(t).toMatchObject({ themeId: 'catppuccin', variant })
        expect(t.colors).toEqual(toHexColors(getThemeChrome('catppuccin', variant)))
      }
      expect(resolveNativeTheme(hub({ themeId: 'catppuccin' }), 'dark').colors.background).not.toBe(
        resolveNativeTheme(hub({ themeId: 'catppuccin' }), 'light').colors.background
      )
    })

    it('a preset without a light variant paints its dark colours in light', () => {
      const darkOnly = unifiedThemes.filter((t) => !t.light).map((t) => t.id)
      expect(darkOnly).toContain('nord')
      for (const id of darkOnly) {
        const t = resolveNativeTheme(hub({ themeId: id }), 'light')
        expect(t).toMatchObject({ themeId: id, variant: 'light' })
        expect(t.colors).toBe(getThemeChromeHex(id, 'dark'))
      }
    })

    it('split: the dark preset in dark, the light preset in light', () => {
      const split = hub({
        themeId: 'nord',
        split: '1',
        themeIdDark: 'dracula',
        themeIdLight: 'solarized'
      })
      expect(resolveNativeTheme(split, 'dark').themeId).toBe('dracula')
      expect(resolveNativeTheme(split, 'light').themeId).toBe('solarized')
      expect(
        resolveNativeTheme({ ...split, stored: { ...split.stored, split: '0' } }, 'light').themeId
      ).toBe('nord')
    })

    it('legacy ids are migrated; an unknown id paints slay', () => {
      expect(resolveNativeTheme(hub({ themeId: 'catppuccin-latte' }), 'light').themeId).toBe(
        'catppuccin'
      )
      expect(resolveNativeTheme(hub({ legacyThemeId: 'solarized-dark' }), 'dark').themeId).toBe(
        'solarized'
      )
      const unknown = resolveNativeTheme(hub({ themeId: 'gone-theme' }), 'light')
      expect(unknown.themeId).toBe('slay')
      expect(unknown.colors).toBe(getThemeChromeHex('slay', 'light'))
    })
  })

  describe('light/dark: the hub preference over the device scheme', () => {
    it('explicit light / dark wins', () => {
      expect(resolveNativeTheme(hub({ themeId: 'catppuccin' }, 'light'), 'dark').variant).toBe(
        'light'
      )
      expect(resolveNativeTheme(hub({ themeId: 'catppuccin' }, 'dark'), 'light').variant).toBe(
        'dark'
      )
    })

    it('system, no answer (null) or an unknown value → the device', () => {
      for (const preference of ['system', null, 'auto']) {
        expect(resolveNativeTheme(hub({}, preference), 'light').variant).toBe('light')
        expect(resolveNativeTheme(hub({}, preference), 'dark').variant).toBe('dark')
      }
    })
  })

  it('returns the same colours object for the same palette (stable for React Native styles)', () => {
    expect(resolveNativeTheme(null, 'dark').colors).toBe(resolveNativeTheme(hub({}), 'dark').colors)
    expect(getThemeChromeHex('nord', 'light')).toBe(getThemeChromeHex('nord', 'dark'))
  })
})
