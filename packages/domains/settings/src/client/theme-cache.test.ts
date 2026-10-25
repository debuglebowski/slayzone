// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readThemeCache, resolveThemeCache, writeThemeCache, type ThemeCache } from './theme-cache'

const base: ThemeCache = {
  preference: 'light',
  effective: 'light',
  singleThemeId: 'catppuccin',
  split: false,
  themeIdDark: 'slay',
  themeIdLight: 'solarized',
  terminalOverrideThemeId: '',
  editorOverrideThemeId: ''
}

function mockOsDark(dark: boolean): void {
  window.matchMedia = vi.fn().mockReturnValue({ matches: dark }) as never
}

describe('theme-cache', () => {
  afterEach(() => window.localStorage.clear())

  it('round-trips what the provider last applied', () => {
    writeThemeCache(base)
    expect(readThemeCache()).toEqual(base)
  })

  it('reads nothing when absent, malformed or from an unknown shape', () => {
    expect(readThemeCache()).toBeNull()
    window.localStorage.setItem('sz:theme-cache:v1', '{oops')
    expect(readThemeCache()).toBeNull()
    window.localStorage.setItem('sz:theme-cache:v1', JSON.stringify({ ...base, preference: 'x' }))
    expect(readThemeCache()).toBeNull()
  })

  it('resolves an explicit preference to the single theme', () => {
    expect(resolveThemeCache(base)).toEqual({ theme: 'light', themeId: 'catppuccin' })
  })

  it('resolves "system" against the OS NOW, and picks the split theme for it', () => {
    const c: ThemeCache = { ...base, preference: 'system', split: true }
    mockOsDark(true)
    expect(resolveThemeCache(c)).toEqual({ theme: 'dark', themeId: 'slay' })
    mockOsDark(false)
    expect(resolveThemeCache(c)).toEqual({ theme: 'light', themeId: 'solarized' })
  })
})
