/**
 * The client host over Electron IPC (task 557ebb72): this device's renderers reach
 * Electron main directly for theme, labs, shortcuts, zoom and updates, and hear its
 * native-menu events — no hub in between.
 */
import { beforeEach, expect, test, vi } from 'vitest'
import { TypedEmitter } from '@slayzone/platform/events'
import type { ClientEventMap } from '@slayzone/platform/client-host'
import { registerClientHostIpc, type ClientHostImpl } from './client-host-ipc'

type Sender = {
  id: number
  isDestroyed: () => boolean
  send: ReturnType<typeof vi.fn>
  once: (e: 'destroyed', cb: () => void) => void
  destroy: () => void
}

const sender = (id: number): Sender => {
  let destroyed = false
  const onDestroyed: Array<() => void> = []
  return {
    id,
    isDestroyed: () => destroyed,
    send: vi.fn(),
    once: (_e, cb) => void onDestroyed.push(cb),
    destroy: () => {
      destroyed = true
      for (const cb of onDestroyed) cb()
    }
  }
}

let onHandlers: Record<string, (e: { sender: Sender }, ...a: unknown[]) => void>
let invokeHandlers: Record<string, (e: { sender: Sender }, ...a: unknown[]) => unknown>
let events: TypedEmitter<ClientEventMap>
let impl: ClientHostImpl
let app1: Sender
let app2: Sender
let webView: Sender

beforeEach(() => {
  app1 = sender(1)
  app2 = sender(2)
  webView = sender(99)
  onHandlers = {}
  invokeHandlers = {}
  events = new TypedEmitter<ClientEventMap>()
  impl = {
    'settings.snapshot': vi.fn(() => ({
      theme: 'dark' as const,
      effectiveTheme: 'dark' as const,
      labs: { testsPanel: false, loopMode: false },
      shortcuts: {},
      shortcutsOwnedByDevice: false
    })),
    'theme.set': vi.fn(() => 'light' as const),
    'labs.set': vi.fn(),
    'shortcuts.set': vi.fn(),
    'zoom.get': vi.fn(() => 1),
    'zoom.adjust': vi.fn(() => 1.1),
    'update.restart': vi.fn(),
    'update.check': vi.fn()
  }
  registerClientHostIpc({
    ipc: {
      on: (ch, h) => void (onHandlers[ch] = h as never),
      handle: (ch, h) => void (invokeHandlers[ch] = h as never)
    },
    impl,
    events,
    isAllowedSender: (wc) => wc.id !== 99,
    isPlaywright: true
  })
})

const invoke = (s: Sender, method: unknown, args: unknown) =>
  Promise.resolve().then(() => invokeHandlers['client-host:invoke']!({ sender: s }, method, args))
const subscribe = (s: Sender) => onHandlers['client-host:subscribe']!({ sender: s })

test('an app renderer calls an allowlisted method', async () => {
  expect(await invoke(app1, 'theme.set', ['light'])).toBe('light')
  expect(impl['theme.set']).toHaveBeenCalledWith('light')
})

test('a web view (not an app renderer) is refused', async () => {
  await expect(invoke(webView, 'theme.set', ['light'])).rejects.toThrow(/not an app renderer/)
  expect(impl['theme.set']).not.toHaveBeenCalled()
})

test('unknown methods and malformed inputs are refused', async () => {
  await expect(invoke(app1, 'app.quit', [])).rejects.toThrow(/unknown method/)
  await expect(invoke(app1, 'theme.set', ['purple'])).rejects.toThrow()
  await expect(invoke(app1, 'labs.set', ['nope', true])).rejects.toThrow()
  await expect(invoke(app1, 'shortcuts.set', [{ a: 3 }])).rejects.toThrow()
  await expect(invoke(app1, 'zoom.adjust', ['sideways'])).rejects.toThrow()
  expect(impl['theme.set']).not.toHaveBeenCalled()
  expect(impl['shortcuts.set']).not.toHaveBeenCalled()
})

test('shortcuts.set passes the map and the adoption flag', async () => {
  await invoke(app1, 'shortcuts.set', [
    { 'go-home': 'mod+k', search: null },
    { adoptedFromHub: true }
  ])
  expect(impl['shortcuts.set']).toHaveBeenCalledWith(
    { 'go-home': 'mod+k', search: null },
    { adoptedFromHub: true }
  )
})

test('shortcuts.set accepts the local-edit flag', async () => {
  await invoke(app1, 'shortcuts.set', [{ search: 'mod+p' }, { localEdit: true }])
  expect(impl['shortcuts.set']).toHaveBeenCalledWith({ search: 'mod+p' }, { localEdit: true })
  await expect(invoke(app1, 'shortcuts.set', [{}, { localEdit: 'yes' }])).rejects.toThrow()
})

test('events reach every subscribed app renderer, never a web view', () => {
  subscribe(app1)
  subscribe(app2)
  subscribe(webView)
  events.emit('open-settings')
  events.emit('zoom-factor-changed', 1.25)
  expect(app1.send).toHaveBeenCalledWith('client-host:event', 'open-settings', undefined)
  expect(app2.send).toHaveBeenCalledWith('client-host:event', 'zoom-factor-changed', 1.25)
  expect(webView.send).not.toHaveBeenCalled()
})

test('a destroyed renderer is dropped', () => {
  subscribe(app1)
  app1.destroy()
  events.emit('go-home')
  expect(app1.send).not.toHaveBeenCalled()
})

test('the last update-status is replayed to a renderer that subscribes later', () => {
  events.emit('update-status', { type: 'downloaded', version: '9.9.9' })
  subscribe(app2)
  expect(app2.send).toHaveBeenCalledWith('client-host:event', 'update-status', {
    type: 'downloaded',
    version: '9.9.9'
  })
})

test('test-emit (Playwright only) fires a client event', async () => {
  subscribe(app1)
  await invokeHandlers['client-host:test-emit']!({ sender: app1 }, 'close-active-task')
  expect(app1.send).toHaveBeenCalledWith('client-host:event', 'close-active-task', undefined)
  await expect(
    Promise.resolve().then(() =>
      invokeHandlers['client-host:test-emit']!({ sender: app1 }, 'settings-changed')
    )
  ).rejects.toThrow()
})

test('test-emit is not registered outside Playwright', () => {
  const handlers: string[] = []
  registerClientHostIpc({
    ipc: { on: (ch) => void handlers.push(ch), handle: (ch) => void handlers.push(ch) },
    impl,
    events: new TypedEmitter<ClientEventMap>(),
    isAllowedSender: () => true,
    isPlaywright: false
  })
  expect(handlers).not.toContain('client-host:test-emit')
})

// Review 1 F2: only a downloaded update is sticky — an error or "latest version" toast
// must not reappear in a window opened later.
test('error / not-available / checking are not replayed; downloaded survives them', () => {
  events.emit('update-status', { type: 'error', message: 'offline' })
  subscribe(app1)
  // (later live events still reach app1; only the replay at subscribe is checked)
  expect(app1.send).not.toHaveBeenCalled()
  events.emit('update-status', { type: 'not-available' })
  subscribe(app2)
  expect(app2.send).not.toHaveBeenCalled()

  events.emit('update-status', { type: 'downloaded', version: '2.0.0' })
  events.emit('update-status', { type: 'error', message: 'offline' })
  const late = sender(3)
  subscribe(late)
  expect(late.send).toHaveBeenCalledWith('client-host:event', 'update-status', {
    type: 'downloaded',
    version: '2.0.0'
  })
})

test('a new download clears the sticky downloaded status', () => {
  events.emit('update-status', { type: 'downloaded', version: '2.0.0' })
  events.emit('update-status', { type: 'downloading', percent: 1 })
  subscribe(app1)
  expect(app1.send).not.toHaveBeenCalled()
})

// Review 1 F3: a reload keeps the same webContents; its new preload subscribes again
// and must get the downloaded status again (the restart button).
test('a re-subscribe from the same renderer (reload) replays again, without double delivery', () => {
  events.emit('update-status', { type: 'downloaded', version: '2.0.0' })
  subscribe(app1)
  subscribe(app1)
  const replays = app1.send.mock.calls.filter((c) => c[1] === 'update-status')
  expect(replays).toHaveLength(2)
  app1.send.mockClear()
  events.emit('go-home')
  expect(app1.send).toHaveBeenCalledTimes(1)
})
