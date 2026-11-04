// @vitest-environment jsdom
// The client half of the browser panel: the typed host client (per-listener state
// replay) and how a relayed `slay browser` request runs on this device's host.
import { afterEach, describe, expect, it, vi } from 'vitest'

type Listener = (event: string, payload: unknown) => void
const listeners = new Set<Listener>()
const invoke = vi.fn<(method: string, args: unknown[]) => Promise<unknown>>()
const raw = {
  invoke,
  on: (l: Listener) => {
    listeners.add(l)
    return () => listeners.delete(l)
  }
}
let rawHost: typeof raw | null = raw
vi.mock('@slayzone/transport/client', () => ({
  electronBootstrap: { browserHost: () => rawHost },
  useSubscription: () => undefined
}))
vi.mock('./trpc', () => ({ useTRPC: () => ({}), useTRPCClient: () => ({}) }))

const { getBrowserHost } = await import('./browser-host')
const { runRelayRequest } = await import('./useBrowserRelayHost')

const emit = (event: string, payload: unknown): void => {
  for (const l of listeners) l(event, payload)
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

afterEach(() => {
  listeners.clear()
  invoke.mockReset()
  rawHost = raw
})

describe('getBrowserHost', () => {
  it('is null where the device hosts no web views', () => {
    rawHost = null
    expect(getBrowserHost()).toBeNull()
  })

  it('call forwards the method and positional args', async () => {
    invoke.mockResolvedValue('bv-1')
    const host = getBrowserHost()!
    await expect(
      host.call('view.create', {
        taskId: 't',
        tabId: 'x',
        url: 'about:blank',
        bounds: { x: 0, y: 0, width: 1, height: 1 }
      })
    ).resolves.toBe('bv-1')
    expect(invoke).toHaveBeenCalledWith('view.create', [
      { taskId: 't', tabId: 'x', url: 'about:blank', bounds: { x: 0, y: 0, width: 1, height: 1 } }
    ])
  })

  it('a new `event` listener first gets every live view state, then live events', async () => {
    invoke.mockResolvedValue([{ viewId: 'bv-1', type: 'state-snapshot', domReady: true }])
    const got: unknown[] = []
    getBrowserHost()!.on('event', (e) => got.push(e))
    expect(invoke).toHaveBeenCalledWith('view.stateSnapshots', [])
    await flush()
    emit('event', { viewId: 'bv-1', type: 'did-navigate' })
    emit('shortcut', { viewId: 'bv-1', key: 'k' })
    expect(got).toEqual([
      { viewId: 'bv-1', type: 'state-snapshot', domReady: true },
      { viewId: 'bv-1', type: 'did-navigate' }
    ])
  })

  it('other events replay nothing, and an unsubscribed listener gets no late replay', async () => {
    let resolveSnapshots: (v: unknown) => void = () => {}
    invoke.mockReturnValue(new Promise((r) => (resolveSnapshots = r)))
    const got: unknown[] = []
    const off = getBrowserHost()!.on('event', (e) => got.push(e))
    off()
    resolveSnapshots([{ viewId: 'bv-1', type: 'state-snapshot' }])
    await flush()
    expect(got).toEqual([])

    invoke.mockClear()
    getBrowserHost()!.on('focused', () => {})
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('runRelayRequest', () => {
  const host = () => getBrowserHost()!
  const req = { requestId: 'r', taskId: 't', tabId: 'x' }

  it('runs each op against the tab registry', async () => {
    invoke.mockResolvedValueOnce(42)
    await expect(runRelayRequest(host(), { ...req, op: 'execJs', code: '6*7' })).resolves.toBe(42)
    expect(invoke).toHaveBeenLastCalledWith('tabs.execJs', ['t', 'x', '6*7'])

    invoke.mockResolvedValueOnce(undefined)
    await expect(
      runRelayRequest(host(), { ...req, op: 'loadUrl', url: 'https://a/' })
    ).resolves.toBeNull()
    expect(invoke).toHaveBeenLastCalledWith('tabs.loadUrl', ['t', 'x', 'https://a/'])

    invoke.mockResolvedValueOnce('https://a/')
    await expect(runRelayRequest(host(), { ...req, op: 'getUrl' })).resolves.toBe('https://a/')
  })

  it('sends a capture back as base64 PNG, or null when empty', async () => {
    invoke.mockResolvedValueOnce(new Uint8Array([137, 80, 78, 71]))
    await expect(runRelayRequest(host(), { ...req, op: 'capturePng' })).resolves.toEqual({
      pngBase64: 'iVBORw=='
    })
    invoke.mockResolvedValueOnce(null)
    await expect(runRelayRequest(host(), { ...req, op: 'capturePng' })).resolves.toEqual({
      pngBase64: null
    })
  })

  it('a failing op rejects with its error', async () => {
    invoke.mockRejectedValueOnce(new Error('tab closed'))
    await expect(runRelayRequest(host(), { ...req, op: 'getUrl' })).rejects.toThrow('tab closed')
  })
})
