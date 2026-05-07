import { nativeTheme } from 'electron'
import type { Database } from 'better-sqlite3'
import { settingsEvents } from '../server/events'

export function getEffectiveTheme(): 'dark' | 'light' {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

export function getThemeSource(): 'system' | 'light' | 'dark' {
  return nativeTheme.themeSource as 'system' | 'light' | 'dark'
}

export function setTheme(db: Database, theme: 'light' | 'dark' | 'system'): 'dark' | 'light' {
  nativeTheme.themeSource = theme
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('theme', theme)
  return getEffectiveTheme()
}

let bridgeInstalled = false

/**
 * Wire nativeTheme OS-level events into settingsEvents. The renderer
 * subscribes via tRPC `settings.onThemeChanged`. Idempotent.
 */
export function wireNativeThemeBridge(): void {
  if (bridgeInstalled) return
  bridgeInstalled = true
  nativeTheme.on('updated', () => {
    settingsEvents.emit('theme:changed', getEffectiveTheme())
  })
}
