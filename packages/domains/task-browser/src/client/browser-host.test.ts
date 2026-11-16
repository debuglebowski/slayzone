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
const { runRelayRequest, hubMayNavigateTo, hubSuppliedUrlAllowed, planHubSuppliedUrl } =
  await import('./useBrowserRelayHost')
const { queueUntrustedLoad, takeUntrustedLoad } = await import('./hub-supplied-loads')

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

  it("strips Electron's IPC error prefix so callers see the host's own message", async () => {
    invoke.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'browser-host:invoke': Error: Browser tab not available (task t) — it may have closed."
      )
    )
    await expect(getBrowserHost()!.call('tabs.getUrl', 't', null)).rejects.toThrow(
      /^Browser tab not available \(task t\)/
    )
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
  // This device's host, answering by method. `pageUrl` is what the tab shows now.
  let pageUrl = 'https://site.test/'
  let png: Uint8Array | null = new Uint8Array([137, 80, 78, 71])
  let evalResult: unknown = 42
  const ran: Array<[string, unknown[]]> = []
  const route = (method: string, args: unknown[]): Promise<unknown> => {
    ran.push([method, args])
    if (method === 'tabs.getUrl') return Promise.resolve(pageUrl)
    if (method === 'tabs.execJs') return Promise.resolve(evalResult)
    if (method === 'tabs.capturePng') return Promise.resolve(png)
    return Promise.resolve(undefined)
  }
  const host = () => getBrowserHost()!
  // A remote hub's panel: every tab is in that hub's (untrusted) partition.
  const panel = {
    taskId: 't',
    liveTabIds: new Set(['x', 'y']),
    isolatedTabIds: new Set(['x', 'y']),
    activeTabId: 'x',
    hubIsLocal: false
  }
  const req = { requestId: 'r', taskId: 't', tabId: 'x', origin: 'elsewhere' as const }
  const sent = (method: string) => ran.filter(([m]) => m === method)
  const reset = () => {
    ran.length = 0
    pageUrl = 'https://site.test/'
    png = new Uint8Array([137, 80, 78, 71])
    evalResult = 42
    invoke.mockImplementation(route)
  }

  describe('an untrusted caller uses isolated tabs only (review 4 part B)', () => {
    // The local hub: 'own' is the user's own browser, 'iso' an isolated tab.
    const mine = {
      taskId: 't',
      liveTabIds: new Set(['own', 'iso']),
      isolatedTabIds: new Set(['iso']),
      activeTabId: 'own',
      hubIsLocal: true
    }
    const elsewhere = { requestId: 'r', taskId: 't', origin: 'elsewhere' as const }
    it("naming the user's own tab is refused for every op, saying why", async () => {
      for (const op of [
        { op: 'execJs', code: 'document.cookie' },
        { op: 'loadUrl', url: 'https://a.test/' },
        { op: 'getUrl' },
        { op: 'capturePng' }
      ]) {
        reset()
        await expect(
          runRelayRequest(host(), { ...elsewhere, tabId: 'own', ...op } as never, mine)
        ).rejects.toThrow(/user's own browser.*isolated tabs/)
        expect(ran.filter(([m]) => m.startsWith('tabs.'))).toEqual([])
      }
    })
    it('naming no tab goes to an isolated tab, never the active own one', async () => {
      reset()
      await runRelayRequest(host(), { ...elsewhere, tabId: null, op: 'getUrl' } as never, mine)
      expect(sent('tabs.getUrl').at(-1)?.[1]).toEqual(['t', 'iso', expect.anything()])
    })
    it('with no isolated tab open, nothing is reached', async () => {
      reset()
      await expect(
        runRelayRequest(host(), { ...elsewhere, tabId: null, op: 'getUrl' } as never, {
          ...mine,
          isolatedTabIds: new Set<string>()
        })
      ).rejects.toThrow(/not open here/)
      expect(ran).toEqual([])
    })
    it("the user's own local agent keeps every tab, as on main", async () => {
      reset()
      await runRelayRequest(
        host(),
        { ...elsewhere, origin: 'hub-machine', tabId: 'own', op: 'getUrl' } as never,
        mine
      )
      expect(sent('tabs.getUrl')).toHaveLength(1)
    })
    it("a hub claiming hub-machine is no local agent unless it is this device's own hub", async () => {
      reset()
      await expect(
        runRelayRequest(
          host(),
          { ...elsewhere, origin: 'hub-machine', tabId: 'own', op: 'getUrl' } as never,
          { ...mine, hubIsLocal: false }
        )
      ).rejects.toThrow(/user's own browser/)
    })
  })

  it('runs each op on the resolved tab', async () => {
    reset()
    await expect(
      runRelayRequest(host(), { ...req, op: 'execJs', code: '6*7' }, panel)
    ).resolves.toBe(42)
    expect(sent('tabs.execJs').at(-1)?.[1].slice(0, 3)).toEqual(['t', 'x', '6*7'])

    await expect(
      runRelayRequest(host(), { ...req, op: 'loadUrl', url: 'https://a.test/' }, panel)
    ).resolves.toBeNull()
    expect(sent('tabs.loadUrl').at(-1)?.[1].slice(0, 3)).toEqual(['t', 'x', 'https://a.test/'])

    await expect(runRelayRequest(host(), { ...req, op: 'getUrl' }, panel)).resolves.toBe(
      'https://site.test/'
    )
    // No tab named → the panel's active tab, resolved HERE, never left to the host.
    await runRelayRequest(host(), { ...req, tabId: null, op: 'execJs', code: '1' }, panel)
    expect(sent('tabs.execJs').at(-1)?.[1].slice(0, 3)).toEqual(['t', 'x', '1'])
  })

  it('sends a capture back as base64 PNG, or null when empty', async () => {
    reset()
    await expect(runRelayRequest(host(), { ...req, op: 'capturePng' }, panel)).resolves.toEqual({
      pngBase64: 'iVBORw=='
    })
    png = null
    await expect(runRelayRequest(host(), { ...req, op: 'capturePng' }, panel)).resolves.toEqual({
      pngBase64: null
    })
  })

  it('a failing op rejects with its error', async () => {
    reset()
    invoke.mockImplementation((m, a) =>
      m === 'tabs.execJs' ? Promise.reject(new Error('tab closed')) : route(m, a)
    )
    await expect(
      runRelayRequest(host(), { ...req, op: 'execJs', code: '1' }, panel)
    ).rejects.toThrow('tab closed')
  })

  describe('refuses what a hub must not make this device do', () => {
    const blocked = [
      'file:///Users/u/.ssh/id_ed25519',
      'slz-file:///Users/u/secret.txt',
      'chrome://settings',
      'devtools://devtools/bundled/inspector.html',
      'chrome-extension://abcdefghijklmnop/popup.html',
      'javascript:alert(document.cookie)',
      'data:text/html,<script>1</script>',
      'about:config',
      'view-source:https://site.test/'
    ]
    for (const url of blocked) {
      it(`navigation to ${url.split(':')[0]}: from a remote hub`, async () => {
        reset()
        await expect(
          runRelayRequest(host(), { ...req, op: 'loadUrl', url }, panel)
        ).rejects.toThrow(/not allowed/)
        expect(sent('tabs.loadUrl')).toEqual([])
      })
    }

    it('file: from a local agent on its own local hub keeps working (as on main)', async () => {
      reset()
      const local = { ...panel, hubIsLocal: true }
      await runRelayRequest(
        host(),
        { ...req, origin: 'hub-machine', op: 'loadUrl', url: 'file:///tmp/fixture.html' },
        local
      )
      expect(sent('tabs.loadUrl')).toHaveLength(1)
    })

    it('a remote hub claiming hub-machine gets nothing for it', async () => {
      reset()
      await expect(
        runRelayRequest(
          host(),
          { ...req, origin: 'hub-machine', op: 'loadUrl', url: 'file:///etc/passwd' },
          panel
        )
      ).rejects.toThrow(/not allowed/)
    })

    it('an agent elsewhere on the local hub cannot navigate to file: either', async () => {
      reset()
      await expect(
        runRelayRequest(
          host(),
          { ...req, op: 'loadUrl', url: 'file:///etc/passwd' },
          { ...panel, hubIsLocal: true }
        )
      ).rejects.toThrow(/not allowed/)
    })

    it('http, https and about:blank stay allowed from anywhere', async () => {
      reset()
      for (const url of ['http://a.test/', 'https://a.test/x?y=1', 'about:blank']) {
        await runRelayRequest(host(), { ...req, op: 'loadUrl', url }, panel)
      }
      expect(sent('tabs.loadUrl')).toHaveLength(3)
    })

    for (const op of ['execJs', 'getUrl', 'capturePng'] as const) {
      it(`${op} on a tab showing a local page is refused from a remote hub`, async () => {
        reset()
        pageUrl = 'file:///Users/u/.ssh/id_ed25519'
        const r = op === 'execJs' ? { ...req, op, code: 'document.body.innerText' } : { ...req, op }
        await expect(runRelayRequest(host(), r, panel)).rejects.toThrow(/this computer/)
        // Only the URL probe ran: nothing read, driven or captured.
        expect(sent('tabs.execJs')).toEqual([])
        expect(sent('tabs.capturePng')).toEqual([])
      })
    }

    it('a task this panel does not serve', async () => {
      reset()
      await expect(
        runRelayRequest(host(), { ...req, taskId: 'other', op: 'getUrl' }, panel)
      ).rejects.toThrow(/not open here/)
      expect(ran).toEqual([])
    })

    it('a tab this panel does not have live', async () => {
      reset()
      await expect(
        runRelayRequest(host(), { ...req, tabId: 'ghost', op: 'getUrl' }, panel)
      ).rejects.toThrow(/not open here/)
      await expect(
        runRelayRequest(
          host(),
          { ...req, tabId: null, op: 'getUrl' },
          { ...panel, activeTabId: null, isolatedTabIds: new Set<string>() }
        )
      ).rejects.toThrow(/not open here/)
      expect(ran).toEqual([])
    })

    const malformed: Array<[string, unknown]> = [
      ['no op', { ...req }],
      ['unknown op', { ...req, op: 'readFile', path: '/etc/passwd' }],
      ['non-string code', { ...req, op: 'execJs', code: { toString: 1 } }],
      ['oversized code', { ...req, op: 'execJs', code: 'x'.repeat(1024 * 1024 + 1) }],
      ['unparseable url', { ...req, op: 'loadUrl', url: 'not a url' }],
      ['oversized url', { ...req, op: 'loadUrl', url: `https://a.test/${'x'.repeat(9000)}` }],
      ['bad taskId', { ...req, taskId: 42, op: 'getUrl' }],
      ['bad tabId', { ...req, tabId: '', op: 'getUrl' }],
      ['bad origin', { ...req, origin: 'trust-me', op: 'getUrl' }]
    ]
    for (const [name, bad] of malformed) {
      it(`malformed: ${name}`, async () => {
        reset()
        await expect(
          runRelayRequest(host(), bad as Parameters<typeof runRelayRequest>[1], panel)
        ).rejects.toThrow(/Malformed|not allowed|not open here/)
        expect(ran.filter(([m]) => m !== 'tabs.getUrl')).toEqual([])
      })
    }

    const privateTargets = [
      'http://127.0.0.1:51100/health',
      'http://localhost:3000/',
      'http://app.localhost/',
      'http://printer.local/',
      'http://192.168.1.1/',
      'http://10.0.0.1/',
      'http://172.16.0.5/',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]:51100/',
      'http://[fd00::1]/',
      'http://0.0.0.0:51100/'
    ]
    for (const url of privateTargets) {
      it(`navigation to ${url} from an untrusted caller (loopback pivot)`, async () => {
        reset()
        await expect(
          runRelayRequest(host(), { ...req, op: 'loadUrl', url }, panel)
        ).rejects.toThrow(/private network|this computer/)
        expect(sent('tabs.loadUrl')).toEqual([])
      })
    }

    it('reads of a tab showing a private host are refused for untrusted callers', async () => {
      reset()
      pageUrl = 'http://127.0.0.1:51100/health'
      await expect(
        runRelayRequest(host(), { ...req, op: 'execJs', code: 'fetch("/api/pty")' }, panel)
      ).rejects.toThrow(/this computer/)
      expect(sent('tabs.execJs')).toEqual([])
    })

    it('a local agent on its own local hub keeps localhost (main parity)', async () => {
      reset()
      const local = { ...panel, hubIsLocal: true }
      const r = { ...req, origin: 'hub-machine' as const }
      await runRelayRequest(host(), { ...r, op: 'loadUrl', url: 'http://localhost:3000/' }, local)
      pageUrl = 'http://localhost:3000/'
      await runRelayRequest(host(), { ...r, op: 'execJs', code: '1' }, local)
      expect(sent('tabs.loadUrl')).toHaveLength(1)
      expect(sent('tabs.execJs')).toHaveLength(1)
    })

    it('tells the host when the caller is untrusted, and the result cap', async () => {
      reset()
      await runRelayRequest(host(), { ...req, op: 'loadUrl', url: 'https://a.test/' }, panel)
      expect(sent('tabs.loadUrl').at(-1)?.[1].at(-1)).toEqual({
        untrusted: true,
        maxResultBytes: 32 * 1024 * 1024
      })
      const local = { ...panel, hubIsLocal: true }
      await runRelayRequest(
        host(),
        { ...req, origin: 'hub-machine', op: 'execJs', code: '1' },
        local
      )
      expect(sent('tabs.execJs').at(-1)?.[1].at(-1)).toEqual({
        untrusted: false,
        maxResultBytes: 32 * 1024 * 1024
      })
    })

    it('a result over the size cap is refused with a clear error', async () => {
      reset()
      evalResult = 'x'.repeat(33 * 1024 * 1024)
      await expect(
        runRelayRequest(host(), { ...req, op: 'execJs', code: 'big' }, panel)
      ).rejects.toThrow(/too large/)
    })
  })
})

describe('hubMayNavigateTo (hub-supplied URLs: new tab, auto-open)', () => {
  it('web pages and about:blank from any hub', () => {
    for (const u of ['http://a.test/', 'https://a.test/', 'about:blank']) {
      expect(hubMayNavigateTo(u, { fileAllowed: false })).toBe(true)
    }
  })
  it('file: only when allowed (own local hub)', () => {
    expect(hubMayNavigateTo('file:///tmp/x.html', { fileAllowed: false })).toBe(false)
    expect(hubMayNavigateTo('file:///tmp/x.html', { fileAllowed: true })).toBe(true)
  })
  it('never script, data, internal or extension pages', () => {
    for (const u of [
      'javascript:alert(1)',
      'data:text/html,x',
      'slz-file:///x',
      'chrome://settings',
      'devtools://devtools',
      'chrome-extension://abc/p.html',
      'not a url'
    ]) {
      expect(hubMayNavigateTo(u, { fileAllowed: true })).toBe(false)
    }
  })
})

describe('hubSuppliedUrlAllowed (open-panel / new-tab / auto-open, with the caller origin)', () => {
  const remote = { hubIsLocal: false, origin: 'elsewhere' as const }
  const localAgent = { hubIsLocal: true, origin: 'hub-machine' as const }
  const elsewhereOnLocal = { hubIsLocal: true, origin: 'elsewhere' as const }
  it('public web pages from anyone', () => {
    expect(hubSuppliedUrlAllowed('https://a.test/', remote)).toBe(true)
  })
  it('file: and private addresses only for a local agent on its own hub', () => {
    for (const u of ['file:///tmp/x.html', 'http://127.0.0.1:51100/', 'http://192.168.0.2/']) {
      expect(hubSuppliedUrlAllowed(u, remote)).toBe(false)
      expect(hubSuppliedUrlAllowed(u, elsewhereOnLocal)).toBe(false)
      expect(hubSuppliedUrlAllowed(u, localAgent)).toBe(true)
    }
  })
  it('a missing origin (older hub) is treated as elsewhere', () => {
    expect(
      hubSuppliedUrlAllowed('file:///tmp/x.html', { hubIsLocal: true, origin: undefined })
    ).toBe(false)
  })
})

describe("planHubSuppliedUrl: an untrusted caller's URL is never loaded on a name check alone (review 4)", () => {
  const remote = { hubIsLocal: false, origin: 'elsewhere' as const }
  const localAgent = { hubIsLocal: true, origin: 'hub-machine' as const }
  const elsewhereOnLocal = { hubIsLocal: true, origin: 'elsewhere' as const }
  it('a name that passes the textual check still loads through the DNS-checked untrusted path', () => {
    // `10.0.0.1.nip.io` resolves to a private address: only the host's resolver sees it.
    for (const ctx of [remote, elsewhereOnLocal]) {
      expect(planHubSuppliedUrl('http://10.0.0.1.nip.io/', ctx)).toEqual({
        url: 'http://10.0.0.1.nip.io/',
        untrusted: true
      })
      expect(planHubSuppliedUrl('https://a.test/', ctx)).toEqual({
        url: 'https://a.test/',
        untrusted: true
      })
    }
  })
  it("the user's own local agent on its own hub loads directly, as before", () => {
    expect(planHubSuppliedUrl('http://10.0.0.1.nip.io/', localAgent)).toEqual({
      url: 'http://10.0.0.1.nip.io/',
      untrusted: false
    })
    expect(planHubSuppliedUrl('file:///tmp/x.html', localAgent)).toEqual({
      url: 'file:///tmp/x.html',
      untrusted: false
    })
  })
  it('what the textual check refuses is not loaded at all', () => {
    expect(planHubSuppliedUrl('file:///tmp/x.html', remote)).toBeNull()
    expect(planHubSuppliedUrl('http://127.0.0.1:51100/', remote)).toBeNull()
    expect(planHubSuppliedUrl('javascript:alert(1)', localAgent)).toBeNull()
    expect(planHubSuppliedUrl(undefined, localAgent)).toBeNull()
  })
})

describe('queued untrusted loads run once, for that tab only', () => {
  it('take returns the queued URL once', () => {
    queueUntrustedLoad('t1', 'tab-a', 'https://a.test/')
    expect(takeUntrustedLoad('t1', 'tab-b')).toBeNull()
    expect(takeUntrustedLoad('t2', 'tab-a')).toBeNull()
    expect(takeUntrustedLoad('t1', 'tab-a')).toBe('https://a.test/')
    expect(takeUntrustedLoad('t1', 'tab-a')).toBeNull()
  })
})
