import { TypedEmitter } from '@slayzone/platform/events'

export type SettingsEventMap = {
  /** Effective theme after an OS dark/light toggle or an explicit setTheme. */
  'theme:changed': [effective: 'dark' | 'light']
}

/**
 * Domain event bus for settings/theme changes. `wireNativeThemeBridge`
 * (settings/main) emits `theme:changed` on every nativeTheme 'updated'; the tRPC
 * `settings.onThemeChanged` subscription wraps it in an observable so each
 * renderer connection refetches. The legacy `theme:changed` IPC broadcast
 * (registerThemeHandlers) still runs in parallel (dual-emit) until the renderer
 * drops IPC (slice 5).
 */
export const settingsEvents = new TypedEmitter<SettingsEventMap>()
