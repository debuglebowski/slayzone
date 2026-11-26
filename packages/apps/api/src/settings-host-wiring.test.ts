/**
 * api's wiring of the settings router's host deps: a `settings.set` reaches the
 * notify bus (`notify.onSettingsChanged`, the cross-window sync). The theme
 * procedures resolve nothing on the host any more: the mode is client-local.
 *
 * Run with: vitest, packages/shared/test-utils/vitest.harness.config.ts (see run-all.sh).
 */
import './settings-host-wiring'
import { expect, test } from 'vitest'
import { TypedEmitter } from '@slayzone/platform/events'
import { settingsRouter } from '@slayzone/settings-core/server'
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

test('theme procedures never reach the host AppDeps (the mode is client-local)', async () => {
  const touched: string[] = []
  setAppDeps(
    new Proxy({} as AppDeps, {
      get: (_t, prop) => {
        touched.push(String(prop))
        return () => 'light'
      }
    })
  )
  expect(await caller.getEffectiveTheme()).toBe('dark')
  expect(await caller.getThemeSource()).toBe('system')
  expect(await caller.setTheme('dark')).toBe('dark')
  expect(touched).toEqual([])
})
