import { settingsShim } from './settings'

// cap-shell-2 — read theme/source from settings KV; onChange is no-op (mid-session
// theme swap deferred to cap-shell-7 which wires a settings change observer over
// SettingsHost). getEffective derives a system-dark fallback when key unset.

type ThemeEffective = 'dark' | 'light'
type ThemeSource = 'light' | 'dark' | 'system'

function systemPrefersDark(): boolean {
  if (typeof matchMedia === 'undefined') return true
  return matchMedia('(prefers-color-scheme: dark)').matches
}

export const themeShim = {
  getEffective: async (): Promise<ThemeEffective> => {
    const stored = await settingsShim.get<ThemeSource>('theme')
    if (stored === 'light') return 'light'
    if (stored === 'dark') return 'dark'
    return systemPrefersDark() ? 'dark' : 'light'
  },
  getSource: async (): Promise<ThemeSource> => {
    const stored = await settingsShim.get<ThemeSource>('theme')
    return stored ?? 'system'
  },
  set: async (source: ThemeSource): Promise<ThemeEffective> => {
    await settingsShim.set('theme', source)
    if (source === 'light') return 'light'
    if (source === 'dark') return 'dark'
    return systemPrefersDark() ? 'dark' : 'light'
  },
  onChange: (_cb: (theme: ThemeEffective) => void): (() => void) => {
    // TODO(cap-shell-7): wire to a SettingsHost change broadcaster.
    return () => undefined
  },
}
