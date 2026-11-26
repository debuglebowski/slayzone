/**
 * @vitest-environment jsdom
 *
 * The renderer's typed client for THIS device's client host (task 557ebb72).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ElectronClientHost } from '@slayzone/platform/client-host'
import { __resetClientHostForTests, clientHostShortcutBackend, getClientHost } from './client-host'

type Listener = (event: string, payload: unknown) => void
const fakeRaw = () => {
  const listeners = new Set<Listener>()
  const raw: ElectronClientHost & { emit: Listener; subscribes: number } = {
    subscribes: 0,
    invoke: vi.fn(async (method: string, args: unknown[]) => ({ method, args })),
    on: (l) => {
      if (listeners.size === 0) raw.subscribes++
      listeners.add(l)
      return () => listeners.delete(l)
    },
    emit: (e, p) => {
      for (const l of [...listeners]) l(e, p)
    }
  }
  return raw
}

const install = (raw: ElectronClientHost | undefined) => {
  ;(window as unknown as { api?: { clientHost?: ElectronClientHost } }).api = raw
    ? { clientHost: raw }
    : undefined
}

beforeEach(() => __resetClientHostForTests())
afterEach(() => install(undefined))

describe('getClientHost', () => {
  it('calls the shell-installed host', async () => {
    const raw = fakeRaw()
    install(raw)
    expect(await getClientHost().call('zoom.adjust', 'in')).toEqual({
      method: 'zoom.adjust',
      args: ['in']
    })
  })

  it('strips the IPC prefix from a host error', async () => {
    const raw = fakeRaw()
    raw.invoke = async () => {
      throw new Error("Error invoking remote method 'client-host:invoke': Error: nope")
    }
    install(raw)
    await expect(getClientHost().call('update.check')).rejects.toThrow(/^nope$/)
  })

  it('delivers only the named event to a listener', () => {
    const raw = fakeRaw()
    install(raw)
    const got: unknown[] = []
    const off = getClientHost().on('zoom-factor-changed', (f) => got.push(f))
    raw.emit('open-settings', undefined)
    raw.emit('zoom-factor-changed', 1.5)
    off()
    raw.emit('zoom-factor-changed', 2)
    expect(got).toEqual([1.5])
  })

  it('replays the last update-status to a listener that attaches later', () => {
    const raw = fakeRaw()
    install(raw)
    const host = getClientHost()
    const early = vi.fn()
    host.on('open-settings', early)
    raw.emit('update-status', { type: 'downloaded', version: '1.2.3' })
    const late = vi.fn()
    host.on('update-status', late)
    expect(late).toHaveBeenCalledWith({ type: 'downloaded', version: '1.2.3' })
  })

  it('falls back to an in-memory host where the shell installed none', async () => {
    install(undefined)
    const host = getClientHost()
    expect(await host.call('settings.snapshot')).toMatchObject({ theme: 'system' })
    await host.call('labs.set', 'loopMode', true)
    expect(await host.call('settings.snapshot')).toMatchObject({
      labs: { testsPanel: false, loopMode: true }
    })
  })
})

describe('clientHostShortcutBackend', () => {
  it('loads from the snapshot, saves through the host, and mirrors to the hub', async () => {
    install(undefined)
    const host = getClientHost()
    const mirror = vi.fn(async (_json: string) => undefined)
    const b = clientHostShortcutBackend({ host, mirror })
    expect(await b.load()).toEqual({})
    await b.save({ 'go-home': 'mod+k' })
    expect(await b.load()).toEqual({ 'go-home': 'mod+k' })
    expect(mirror).toHaveBeenCalledWith(JSON.stringify({ 'go-home': 'mod+k' }))
  })

  it('a failing mirror never fails the save', async () => {
    install(undefined)
    const b = clientHostShortcutBackend({
      host: getClientHost(),
      mirror: async () => {
        throw new Error('hub down')
      }
    })
    await expect(b.save({ search: null })).resolves.toBeUndefined()
  })

  it('load waits for the one-time adoption to settle first', async () => {
    install(undefined)
    const host = getClientHost()
    let release!: () => void
    const ready = new Promise<void>((r) => {
      release = r
    })
    const b = clientHostShortcutBackend({ host, ready })
    let loaded = false
    const p = b.load().then(() => {
      loaded = true
    })
    await Promise.resolve()
    expect(loaded).toBe(false)
    await host.call('shortcuts.set', { search: 'mod+p' }, { adoptedFromHub: true })
    release()
    await p
    expect(await b.load()).toEqual({ search: 'mod+p' })
  })

  it('reports another window’s change', async () => {
    const raw = fakeRaw()
    install(raw)
    const b = clientHostShortcutBackend({ host: getClientHost() })
    const seen = vi.fn()
    b.onChanged?.(seen)
    raw.emit('settings-changed', { shortcuts: { a: 'mod+a' } })
    expect(seen).toHaveBeenCalledWith({ a: 'mod+a' })
  })
})
