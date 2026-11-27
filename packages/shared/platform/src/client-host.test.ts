import { describe, expect, it, vi } from 'vitest'
import {
  CLIENT_HOST_EVENTS,
  CLIENT_HOST_METHODS,
  createStorageClientHost,
  type ClientHostKv
} from './client-host'

const memoryKv = (): ClientHostKv & { data: Map<string, string> } => {
  const data = new Map<string, string>()
  return {
    data,
    get: (k) => data.get(k) ?? null,
    set: (k, v) => void data.set(k, v)
  }
}

const call = (host: ReturnType<typeof createStorageClientHost>, m: string, ...a: unknown[]) =>
  host.invoke(m, a)

describe('createStorageClientHost (web shell / chromium shell, D3)', () => {
  it('starts at the defaults a host without a native client gives', async () => {
    const host = createStorageClientHost({ kv: memoryKv(), systemTheme: () => 'light' })
    expect(await call(host, 'settings.snapshot')).toEqual({
      theme: 'system',
      effectiveTheme: 'light',
      labs: { testsPanel: false, loopMode: false },
      shortcuts: {},
      shortcutsOwnedByDevice: false
    })
  })

  it('persists theme, labs and shortcuts across a new host on the same storage', async () => {
    const kv = memoryKv()
    const a = createStorageClientHost({ kv, systemTheme: () => 'dark' })
    expect(await call(a, 'theme.set', 'light')).toBe('light')
    await call(a, 'labs.set', 'loopMode', true)
    await call(a, 'shortcuts.set', { 'go-home': 'mod+k' }, { adoptedFromHub: true })
    const b = createStorageClientHost({ kv, systemTheme: () => 'dark' })
    expect(await call(b, 'settings.snapshot')).toEqual({
      theme: 'light',
      effectiveTheme: 'light',
      labs: { testsPanel: false, loopMode: true },
      shortcuts: { 'go-home': 'mod+k' },
      shortcutsOwnedByDevice: true
    })
  })

  it('a local edit claims the map for the device; a plain write does not', async () => {
    const host = createStorageClientHost({ kv: memoryKv(), systemTheme: () => 'dark' })
    await call(host, 'shortcuts.set', { search: 'mod+p' })
    expect(await call(host, 'settings.snapshot')).toMatchObject({ shortcutsOwnedByDevice: false })
    await call(host, 'shortcuts.set', { search: 'mod+o' }, { localEdit: true })
    expect(await call(host, 'settings.snapshot')).toMatchObject({ shortcutsOwnedByDevice: true })
  })

  it('a later plain shortcuts.set keeps the adoption marker', async () => {
    const host = createStorageClientHost({ kv: memoryKv(), systemTheme: () => 'dark' })
    await call(host, 'shortcuts.set', {}, { adoptedFromHub: true })
    await call(host, 'shortcuts.set', { search: null })
    expect(await call(host, 'settings.snapshot')).toMatchObject({
      shortcuts: { search: null },
      shortcutsOwnedByDevice: true
    })
  })

  it('works over an async store (the chromium shell Mojo KV)', async () => {
    const data = new Map<string, string>()
    const kv: ClientHostKv = {
      get: async (k) => data.get(k) ?? null,
      set: async (k, v) => void data.set(k, v)
    }
    const host = createStorageClientHost({ kv, systemTheme: () => 'dark' })
    await call(host, 'theme.set', 'dark')
    expect(await call(host, 'settings.snapshot')).toMatchObject({ theme: 'dark' })
  })

  it('emits settings-changed with the new snapshot to every listener after a write', async () => {
    const host = createStorageClientHost({ kv: memoryKv(), systemTheme: () => 'dark' })
    const seen = vi.fn()
    const off = host.on(seen)
    await call(host, 'labs.set', 'testsPanel', true)
    expect(seen).toHaveBeenCalledWith(
      'settings-changed',
      expect.objectContaining({ labs: { testsPanel: true, loopMode: false } })
    )
    off()
    await call(host, 'labs.set', 'testsPanel', false)
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('reads a corrupt stored value as unset', async () => {
    const kv = memoryKv()
    kv.data.set('slayzone:client:shortcuts', '{nope')
    kv.data.set('slayzone:client:theme', 'purple')
    const host = createStorageClientHost({ kv, systemTheme: () => 'dark' })
    expect(await call(host, 'settings.snapshot')).toMatchObject({ theme: 'system', shortcuts: {} })
  })

  it('zoom and updates are inert (the browser owns its zoom; no updater)', async () => {
    const host = createStorageClientHost({ kv: memoryKv(), systemTheme: () => 'dark' })
    expect(await call(host, 'zoom.get')).toBe(1)
    expect(await call(host, 'zoom.adjust', 'in')).toBe(1)
    expect(await call(host, 'update.restart')).toBeUndefined()
    expect(await call(host, 'update.check')).toBeUndefined()
  })

  it('rejects a method outside the contract', async () => {
    const host = createStorageClientHost({ kv: memoryKv(), systemTheme: () => 'dark' })
    await expect(call(host, 'app.quit')).rejects.toThrow(/unknown method/)
  })

  it('declares the 14 client menu events, open-task, update-status and settings-changed', () => {
    expect([...CLIENT_HOST_EVENTS].sort()).toEqual(
      [
        'go-home',
        'toggle-global-agent-panel',
        'toggle-agent-status-panel',
        'open-settings',
        'open-project-settings',
        'new-temporary-task',
        'screenshot-trigger',
        'close-current-focus',
        'close-active-task',
        'sync-session-id',
        'reload-browser',
        'reload-app',
        'zoom-factor-changed',
        'update-status',
        'open-task',
        'settings-changed'
      ].sort()
    )
    expect(CLIENT_HOST_METHODS).toContain('shortcuts.set')
  })
})

// Review 1 F4: web-shell tabs share one localStorage.
describe('several pages on one store (web-shell tabs)', () => {
  it("a stale page's shortcut save merges per key instead of dropping the other's edit", async () => {
    const kv = memoryKv()
    const a = createStorageClientHost({ kv, systemTheme: () => 'dark' })
    const b = createStorageClientHost({ kv, systemTheme: () => 'dark' })
    await call(a, 'settings.snapshot')
    await call(b, 'settings.snapshot')
    // Tab A rebinds X; tab B, still showing the old (empty) map, rebinds Y.
    await call(a, 'shortcuts.set', { x: 'mod+1' }, { localEdit: true })
    await call(b, 'shortcuts.set', { y: 'mod+2' }, { localEdit: true })
    expect(await call(a, 'settings.snapshot')).toMatchObject({
      shortcuts: { x: 'mod+1', y: 'mod+2' }
    })
    // B, now current ({x, y}), removes Y: a key it removed goes, the rest stay.
    await call(b, 'settings.snapshot')
    await call(b, 'shortcuts.set', { x: 'mod+1' }, { localEdit: true })
    expect(await call(a, 'settings.snapshot')).toMatchObject({ shortcuts: { x: 'mod+1' } })
  })

  it("another page's write reaches this page as settings-changed", async () => {
    let fire: (() => void) | null = null
    const kv = memoryKv()
    const a = createStorageClientHost({
      kv,
      systemTheme: () => 'dark',
      watch: (onChange) => {
        fire = onChange
      }
    })
    const seen = vi.fn()
    a.on(seen)
    kv.data.set('slayzone:client:theme', 'light') // tab B wrote it
    fire!()
    await vi.waitFor(() =>
      expect(seen).toHaveBeenCalledWith(
        'settings-changed',
        expect.objectContaining({ theme: 'light' })
      )
    )
  })
})
