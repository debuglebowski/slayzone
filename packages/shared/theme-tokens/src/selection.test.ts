import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_THEME_ID,
  migrateThemeId,
  resolveAppThemeSelection,
  resolveThemeVariant,
  selectChromeThemeId,
  type StoredAppTheme
} from './selection'
import { unifiedThemes } from './themes'

const unset: StoredAppTheme = { themeId: null, split: null, themeIdDark: null, themeIdLight: null }

describe('migrateThemeId', () => {
  it('maps variant-specific legacy ids to their family, leaves others alone', () => {
    expect(migrateThemeId('catppuccin-latte')).toBe('catppuccin')
    expect(migrateThemeId('slay-light')).toBe('slay')
    expect(migrateThemeId('nord')).toBe('nord')
    expect(migrateThemeId('anything')).toBe('anything')
  })

  it('the default is a preset', () => {
    expect(unifiedThemes.map((t) => t.id)).toContain(DEFAULT_THEME_ID)
  })
})

describe('resolveAppThemeSelection', () => {
  it('nothing stored → the default preset for both variants, split off', () => {
    expect(resolveAppThemeSelection(unset)).toEqual({
      singleThemeId: 'slay',
      split: false,
      themeIdDark: 'slay',
      themeIdLight: 'slay'
    })
  })

  it('one preset: dark and light default to it', () => {
    expect(resolveAppThemeSelection({ ...unset, themeId: 'nord' })).toEqual({
      singleThemeId: 'nord',
      split: false,
      themeIdDark: 'nord',
      themeIdLight: 'nord'
    })
  })

  it('split: only "1" turns it on; ids are migrated', () => {
    const stored = {
      themeId: 'nord',
      split: '1',
      themeIdDark: 'catppuccin-mocha',
      themeIdLight: 'rose-pine-dawn'
    }
    expect(resolveAppThemeSelection(stored)).toEqual({
      singleThemeId: 'nord',
      split: true,
      themeIdDark: 'catppuccin',
      themeIdLight: 'rose-pine'
    })
    expect(resolveAppThemeSelection({ ...stored, split: '0' }).split).toBe(false)
    expect(resolveAppThemeSelection({ ...stored, split: 'true' }).split).toBe(false)
  })

  it('the legacy id is used (migrated) only when app_theme_id is empty', () => {
    expect(
      resolveAppThemeSelection({ ...unset, legacyThemeId: 'solarized-light' }).singleThemeId
    ).toBe('solarized')
    expect(
      resolveAppThemeSelection({ ...unset, themeId: '', legacyThemeId: 'nord' }).singleThemeId
    ).toBe('nord')
    expect(
      resolveAppThemeSelection({ ...unset, themeId: 'dracula', legacyThemeId: 'nord' })
        .singleThemeId
    ).toBe('dracula')
  })
})

describe('selectChromeThemeId', () => {
  const selection = {
    singleThemeId: 'nord',
    split: false,
    themeIdDark: 'dracula',
    themeIdLight: 'solarized'
  }

  it('split off: the one preset in both variants', () => {
    expect(selectChromeThemeId(selection, 'dark')).toBe('nord')
    expect(selectChromeThemeId(selection, 'light')).toBe('nord')
  })

  it('split on: the variant picks', () => {
    expect(selectChromeThemeId({ ...selection, split: true }, 'dark')).toBe('dracula')
    expect(selectChromeThemeId({ ...selection, split: true }, 'light')).toBe('solarized')
  })
})

describe('resolveThemeVariant', () => {
  it('an explicit preference wins without asking the OS', () => {
    const system = vi.fn(() => 'dark' as const)
    expect(resolveThemeVariant('light', system, 'dark')).toBe('light')
    expect(resolveThemeVariant('dark', system, 'light')).toBe('dark')
    expect(system).not.toHaveBeenCalled()
  })

  it('system asks the OS', () => {
    expect(resolveThemeVariant('system', () => 'light', 'dark')).toBe('light')
    expect(resolveThemeVariant('system', () => 'dark', 'light')).toBe('dark')
  })

  it('anything else (not loaded, unknown) → fallback', () => {
    expect(resolveThemeVariant(null, () => 'dark', 'light')).toBe('light')
    expect(resolveThemeVariant(undefined, () => 'light', 'dark')).toBe('dark')
    expect(resolveThemeVariant('auto', () => 'light', 'dark')).toBe('dark')
  })
})
