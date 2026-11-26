/**
 * `slay browser`'s open-panel / new-tab events reach only the CALLER's own clients:
 * on a hub where a task is shared, another user's agent never opens tabs in your panel
 * (review 4: relay selection crossed principals). An event with no principal (a host
 * emit, not a user's request) still reaches everyone.
 */
import { expect, test } from 'vitest'
import { TypedEmitter } from '@slayzone/platform/events'
import { setMenuEvents, type HubMenuEventMap } from './menu-events'
import { menuRouter } from './menu-router'

const ev = new TypedEmitter<HubMenuEventMap>()
setMenuEvents(ev)

async function listen(
  userId: string | null,
  sub: 'onBrowserEnsurePanelOpen' | 'onBrowserCreateTab'
): Promise<{ got: unknown[]; stop: () => void }> {
  const caller = menuRouter.createCaller({
    principal: userId === null ? null : { userId }
  } as never)
  const got: unknown[] = []
  const obs = await caller[sub]()
  const s = obs.subscribe({ next: (p: unknown) => got.push(p) })
  return { got, stop: () => s.unsubscribe() }
}

test('open-panel reaches only the requesting user', async () => {
  const alice = await listen('alice', 'onBrowserEnsurePanelOpen')
  const bob = await listen('bob', 'onBrowserEnsurePanelOpen')
  ev.emit('browser-ensure-panel-open', { taskId: 't1', principal: 'bob' })
  expect(alice.got).toEqual([])
  expect(bob.got).toHaveLength(1)
  alice.stop()
  bob.stop()
})

test('new-tab reaches only the requesting user', async () => {
  const alice = await listen('alice', 'onBrowserCreateTab')
  const bob = await listen('bob', 'onBrowserCreateTab')
  ev.emit('browser-create-tab', { taskId: 't1', tabId: 'x', principal: 'alice' })
  expect(alice.got).toHaveLength(1)
  expect(bob.got).toEqual([])
  alice.stop()
  bob.stop()
})

test('login-off hub: the null principal reaches its own (null) clients', async () => {
  const anon = await listen(null, 'onBrowserCreateTab')
  ev.emit('browser-create-tab', { taskId: 't1', tabId: 'x', principal: null })
  expect(anon.got).toHaveLength(1)
  anon.stop()
})

test('an event with no principal (not a user request) reaches everyone', async () => {
  const alice = await listen('alice', 'onBrowserEnsurePanelOpen')
  const bob = await listen('bob', 'onBrowserEnsurePanelOpen')
  ev.emit('browser-ensure-panel-open', { taskId: 't1' })
  expect(alice.got).toHaveLength(1)
  expect(bob.got).toHaveLength(1)
  alice.stop()
  bob.stop()
})

// The 14 native-menu / accelerator / updater / zoom events are this device's own
// (task 557ebb72): the renderer hears them from its client host, never from a hub. A
// hub — any hub the renderer is signed in to, hostile or not — must not be able to
// push one: `screenshot-trigger` captured the active browser view into that hub's
// task, `reload-app` reloaded the app. The paths stay (older desktops subscribe) but
// never fire.
const CLIENT_LOCAL = [
  ['onGoHome', 'go-home'],
  ['onToggleGlobalAgentPanel', 'toggle-global-agent-panel'],
  ['onToggleAgentStatusPanel', 'toggle-agent-status-panel'],
  ['onOpenSettings', 'open-settings'],
  ['onOpenProjectSettings', 'open-project-settings'],
  ['onNewTemporaryTask', 'new-temporary-task'],
  ['onScreenshotTrigger', 'screenshot-trigger'],
  ['onCloseCurrentFocus', 'close-current-focus'],
  ['onCloseActiveTask', 'close-active-task'],
  ['onSyncSessionId', 'sync-session-id'],
  ['onReloadBrowser', 'reload-browser'],
  ['onReloadApp', 'reload-app'],
  ['onZoomFactorChanged', 'zoom-factor-changed'],
  ['onUpdateStatus', 'update-status']
] as const

test('a hub never streams a client-local menu event', async () => {
  const caller = menuRouter.createCaller({ principal: null } as never)
  const got: string[] = []
  const subs: Array<{ unsubscribe: () => void }> = []
  for (const [proc, event] of CLIENT_LOCAL) {
    const obs = await (caller as unknown as Record<string, () => Promise<unknown>>)[proc]()
    subs.push(
      (obs as { subscribe: (o: { next: () => void }) => { unsubscribe: () => void } }).subscribe({
        next: () => got.push(event)
      })
    )
    ;(ev as unknown as { emit: (e: string, ...a: unknown[]) => void }).emit(event, 1)
  }
  for (const s of subs) s.unsubscribe()
  expect(got).toEqual([])
})
