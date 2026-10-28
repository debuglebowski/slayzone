/**
 * api's wiring of the settings router's host deps: a `settings.set` reaches the
 * notify bus (`notify.onSettingsChanged`, the cross-window sync), and the theme
 * procedures resolve the host's `AppDeps`.
 *
 * Run with: vitest, packages/shared/test-utils/vitest.harness.config.ts (see run-all.sh).
 */
import './settings-host-wiring'
import { expect, test } from 'vitest'
import { TypedEmitter } from '@slayzone/platform/events'
import { settingsRouter } from '@slayzone/settings/server'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness.js'
import { setAppDeps, setNotifyEvents, type AppDeps, type NotifyEventMap } from './app-deps'

const h = await createTestHarness()
const caller = settingsRouter.createCaller({ db: h.slayDb, dataRoot: '' })

test('settings.set tells every window which key changed, over the notify bus', async () => {
  const ev = new TypedEmitter<NotifyEventMap>()
  setNotifyEvents(ev)
  const seen: unknown[] = []
  ev.on('settings-changed', (change) => seen.push(change))
  await caller.set({ key: 'panel_config', value: '{"webPanels":[]}' })
  expect(seen).toEqual([{ keys: ['panel_config'] }])
})

test('theme procedures resolve the AppDeps the host set', async () => {
  const set: string[] = []
  setAppDeps({
    themeGetEffective: () => 'light',
    themeGetSource: () => 'system',
    themeSet: async (pref: 'light' | 'dark' | 'system') => {
      set.push(pref)
      return 'dark'
    }
  } as unknown as AppDeps)
  expect(await caller.getEffectiveTheme()).toBe('light')
  expect(await caller.getThemeSource()).toBe('system')
  expect(await caller.setTheme('dark')).toBe('dark')
  expect(set).toEqual(['dark'])
})
