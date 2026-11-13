import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HubDialer,
  type ComputerCredentialStore,
  type HubDialerOptions
} from '@slayzone/computer-transport/client'
import {
  COMPUTER_EXIT_NEEDS_RE_ENROLLMENT,
  ComputerTransportErrorCodes,
  HubToComputerMethods,
  RpcError
} from '@slayzone/computer-transport/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComputerConfig } from './config'
import type { ComputerDialer } from './handlers/types'
import { createHubRequestHandler, startComputer, watchPrimaryHubExitCode } from './main'
import { projectScopedDeps } from './project-scope.fixture'
import { hubHostFromUrl } from '@slayzone/computer-transport/client'

const fakeDialer: ComputerDialer = { notify: () => true }

/** What a v3 hub sends with every request (T-27). */
const ACTOR = { userId: 'u-1', route: 'trpc test' }

/** A temp state dir, so startComputer's request log never lands in a real one. */
function tempState(): string {
  return mkdtempSync(join(tmpdir(), 'computer-main-'))
}

const testConfig: ComputerConfig = {
  hubUrl: 'ws://localhost:0/computers',
  name: 'test-computer',
  allowedRoots: ['/tmp'],
  capabilities: ['pty', 'git', 'fs', 'proc']
}

/** A credential store that never touches disk (keeps startComputer unit-safe). */
function memoryStore(): ComputerCredentialStore {
  return {
    load: async () => null,
    save: async () => {},
    clear: async () => {},
    filePath: '/dev/null'
  }
}

function makeDispatch(shutdown: (reason: string) => void = () => {}) {
  return createHubRequestHandler({ shutdown, dialer: fakeDialer, config: testConfig })
}

describe('createHubRequestHandler dispatch table', () => {
  // Names inside the reserved namespaces that this computer does NOT implement.
  // `fs.readFile` used to sit here and stopped qualifying once the file-editor
  // ops were routed — an unimplemented-method fixture has to be a method that
  // stays unimplemented, or the test quietly starts asserting a zod parse error.
  it.each(['fs.chmod', 'git.clone', 'proc.status', 'bogus.method'])(
    'answers unknown method %s with -32001 unimplemented',
    async (method) => {
      const { handle } = makeDispatch()
      const err = await handle(method, {}, ACTOR).then(
        () => null,
        (e: unknown) => e
      )
      expect(err).toBeInstanceOf(RpcError)
      expect((err as RpcError).code).toBe(ComputerTransportErrorCodes.unimplemented)
      expect((err as RpcError).message).toBe(`unimplemented: ${method}`)
    }
  )

  it('counts in-flight filesystem work when deciding whether an upgrade may restart', async () => {
    let ready!: () => void
    const pathReady = new Promise<void>((resolve) => {
      ready = resolve
    })
    const dispatch = createHubRequestHandler({
      shutdown: () => {},
      dialer: fakeDialer,
      config: testConfig,
      pathReady
    })
    try {
      const request = dispatch.handle(HubToComputerMethods.fsPathExists, { path: '/tmp' }, ACTOR)
      expect(dispatch.isIdle()).toBe(false)
      ready()
      await request
      expect(dispatch.isIdle()).toBe(true)
    } finally {
      dispatch.dispose()
    }
  })

  it('a request naming a path scope it cannot confine fails closed, never runs unscoped', async () => {
    // No chat store here (no computer identity): the scope's roots are unknowable,
    // so the request is refused rather than judged by the machine bound alone.
    const { handle } = makeDispatch()
    const scoped = { ...ACTOR, pathScope: { kind: 'project', projectId: 'p1' } }
    await expect(
      handle(HubToComputerMethods.fsPathExists, { path: '/tmp' }, scoped)
    ).rejects.toThrow()
    // The same request without a scope still runs.
    await expect(
      handle(HubToComputerMethods.fsPathExists, { path: '/tmp' }, ACTOR)
    ).resolves.toBeTruthy()
  })

  it('routes implemented methods (git.isGitRepo does not throw unimplemented)', async () => {
    const { handle } = makeDispatch()
    // /tmp is inside allowedRoots but not a git repo → resolves to
    // { isGitRepo: false } (the key the SHARED result schema declares; this test
    // used to assert the computer's own divergent `isRepo`).
    const result = await handle('git.isGitRepo', { path: '/tmp' }, ACTOR)
    expect(result).toEqual({ isGitRepo: false })
  })

  it('acks computer.shutdown and then triggers the shutdown callback', async () => {
    const shutdown = vi.fn()
    const { handle } = makeDispatch(shutdown)
    const pending = handle('computer.shutdown', { reason: 'maintenance' }, ACTOR)
    expect(shutdown).not.toHaveBeenCalled() // ack built before shutdown fires…
    const result = await pending
    expect(result).toEqual({ ok: true })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(shutdown).toHaveBeenCalledWith('maintenance') // …stop after the ack resolves
  })

  it('defaults the shutdown reason', async () => {
    const shutdown = vi.fn()
    const { handle } = makeDispatch(shutdown)
    await handle('computer.shutdown', undefined, ACTOR)
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(shutdown).toHaveBeenCalledWith('hub-requested')
  })

  it('dispose() is callable with no live sessions', () => {
    const { dispose } = makeDispatch()
    expect(() => dispose()).not.toThrow()
  })

  // A live `fs.watch` is an event-loop handle. The computer's SIGTERM path stops its
  // connections and then relies on the loop draining to exit, so a watch left open by
  // the file editor kept a stopped computer alive indefinitely — orphaned once the
  // desktop app quit (measured: the e2e 45-file-tree-rename shutdown wedge).
  it('dispose() closes live fs watches, so a stopped computer can exit', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'computer-dispose-')))
    const liveWatches = (): number =>
      process.getActiveResourcesInfo().filter((r) => r === 'FSEventWrap').length
    const before = liveWatches()
    const { handle, dispose } = createHubRequestHandler({
      shutdown: () => {},
      dialer: fakeDialer,
      config: { ...testConfig, allowedRoots: [root] }
    })

    await handle(HubToComputerMethods.fsWatchStart, { watchId: 'w1', rootPath: root }, ACTOR)
    expect(liveWatches()).toBeGreaterThan(before)

    dispose()
    // Handle close completes on a later loop turn; a leaked watch never gets there.
    // `<=`, not `===`: a watch another test stopped may still be closing at `before`.
    await vi.waitFor(() => expect(liveWatches()).toBeLessThanOrEqual(before), { timeout: 2_000 })
    rmSync(root, { recursive: true, force: true })
  })

  // Each hub connection hands its ptys the address it dials, so `slay` in a task
  // terminal reaches the hub that spawned it (connectHub derives it from the hub url).
  it('gives every pty it spawns the address of the hub this dispatch serves', async () => {
    const root = realpathSync(tmpdir())
    let out = ''
    const { handle, dispose } = createHubRequestHandler({
      ...projectScopedDeps({ p1: root }),
      shutdown: () => {},
      dialer: {
        notify: (method, params) => {
          if (method === 'pty.data') out += (params as { data: string }).data
          return true
        }
      },
      config: { ...testConfig, allowedRoots: [root] },
      hubAddress: 'slay.example.com'
    })
    await handle(
      HubToComputerMethods.ptySpawn,
      {
        sessionId: 'hub-address-dispatch',
        projectId: 'p1',
        command: 'sh',
        args: ['-c', 'echo ADDR=[$SLAYZONE_HUB_ADDRESS]'],
        cwd: root,
        env: {}
      },
      ACTOR
    )
    await vi.waitFor(() => expect(out).toContain('ADDR=[slay.example.com]'), { timeout: 8_000 })
    dispose()
  })

  // The login-shell PATH probe (~1s on a heavy zshrc) runs alongside enrollment.
  // git/gh/proc requests can need it; a pty starts the user's login shell, which
  // builds its own PATH — so terminals restore without waiting for the probe.
  it('holds non-pty requests until the login-shell PATH is adopted, never pty ones', async () => {
    let adopt!: () => void
    const pathReady = new Promise<void>((resolve) => (adopt = resolve))
    const { handle } = createHubRequestHandler({
      shutdown: () => {},
      dialer: fakeDialer,
      config: testConfig,
      pathReady
    })

    expect(await handle(HubToComputerMethods.ptyList, {}, ACTOR)).toBeDefined()

    // A cheap fs call (one stat): ungated it settles well inside the wait below.
    let settled = false
    const exists = handle(HubToComputerMethods.fsPathExists, { path: '/tmp' }, ACTOR).then(
      () => (settled = true)
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    expect(settled).toBe(false)
    adopt()
    await exists
    expect(settled).toBe(true)
  })
})

describe('startComputer TLS', () => {
  // Loopback port 0 keeps these hermetic: startComputer calls dialer.start() (a real
  // outbound connect attempt), so a routable/public-looking host would do real
  // network I/O. 127.0.0.1:0 fails fast + unref'd → no hang, no external traffic.
  it('starts a dialer for a wss:// and a ws:// hub url alike: there is no pin to feed', async () => {
    // A wss:// hub's front end is verified against the trusted CAs by the dialer's
    // defaults; nothing about TLS is configured here any more.
    for (const hubUrl of ['wss://127.0.0.1:0/computers', 'ws://127.0.0.1:0/computers']) {
      const handle = startComputer(
        { ...testConfig, hubUrl },
        { credentialStore: memoryStore(), stateDir: tempState() }
      )
      try {
        expect(handle.dialer).toBeDefined()
      } finally {
        await handle.stop()
      }
    }
  })
})

describe('startComputer multi-hub', () => {
  // Loopback port 0 keeps this hermetic — startComputer calls dialer.start(), so a
  // routable host would do real network I/O. See the note above.
  it('opens one dialer per configured hub, and only one by default', async () => {
    const single = startComputer(testConfig, {
      credentialStore: memoryStore(),
      stateDir: tempState()
    })
    try {
      expect(single.dialers.length).toBe(1)
      // The named `dialer` stays the primary, because a computer serving exactly
      // one hub is the overwhelming case and every existing caller reads it.
      expect(single.dialer).toBe(single.dialers[0])
    } finally {
      await single.stop()
    }

    const multi = startComputer(
      {
        ...testConfig,
        hubUrls: ['ws://127.0.0.1:0/computers', 'ws://127.0.0.2:0/computers']
      },
      { credentialStore: memoryStore(), stateDir: tempState() }
    )
    try {
      expect(multi.dialers.length).toBe(2)
      // Independent connections, not one dialer reused — each hub has its own
      // credentials, its own project-path map and its own agent-hook relay.
      expect(multi.dialers[0]).not.toBe(multi.dialers[1])
    } finally {
      await multi.stop()
    }
  })

  // The same hub twice would mean two dialers racing over one credential entry.
  it('de-duplicates repeated hub urls', async () => {
    const handle = startComputer(
      {
        ...testConfig,
        hubUrls: ['ws://127.0.0.1:0/computers', 'ws://127.0.0.1:0/computers']
      },
      { credentialStore: memoryStore(), stateDir: tempState() }
    )
    try {
      expect(handle.dialers.length).toBe(1)
    } finally {
      await handle.stop()
    }
  })
})

describe('startComputer direct link (docs/direct-link.md)', () => {
  it('binds the loopback listener, then dials, advertising the bound address', async () => {
    const seen: Array<{ started: boolean; address: string | null }> = []
    let identity: { directAddress?: () => string | null } | undefined
    // The terminal is a project's: its folder here is where it may start (§9 Phase 7c).
    const slayRoot = mkdtempSync(join(tmpdir(), 'direct-seam-root-'))
    writeFileSync(
      join(slayRoot, 'computer.projects.json'),
      JSON.stringify({
        [hubHostFromUrl(testConfig.hubUrl)]: {
          p1: { path: realpathSync(process.cwd()), updatedAt: 0 }
        }
      })
    )
    vi.stubEnv('SLAYZONE_ROOT', slayRoot)
    const handle = startComputer(testConfig, {
      credentialStore: memoryStore(),
      stateDir: tempState(),
      createDialer: (options) => {
        identity = options.identity
        const fake = {
          events: { on: () => undefined },
          computerId: null,
          start: () => seen.push({ started: true, address: identity?.directAddress?.() ?? null }),
          stop: async () => undefined
        }
        return fake as never
      }
    })
    try {
      await vi.waitFor(() => expect(seen.length).toBe(1))
      expect(seen[0]?.address).toMatch(/^127\.0\.0\.1:\d+$/)
      const health = await fetch(`http://${seen[0]?.address}/direct/v1/health`)
      expect(health.status).toBe(200)
    } finally {
      await handle.stop()
    }
  })
})

describe('startComputer direct link: WebRTC addon off the boot path', () => {
  it('dials without loading node-datachannel, advertises WebRTC, and loads it on the first offer', async () => {
    let loads = 0
    let startedWithLoads: number | null = null
    let identity: { directRtc?: () => boolean } | undefined
    let onHubRequest:
      | ((method: string, params: unknown, actor: unknown) => Promise<unknown>)
      | undefined
    const handle = startComputer(testConfig, {
      credentialStore: memoryStore(),
      stateDir: tempState(),
      rtc: {
        available: () => true,
        load: () => {
          loads++
          return null
        }
      },
      createDialer: (options) => {
        identity = options.identity as typeof identity
        onHubRequest = options.onHubRequest as typeof onHubRequest
        return {
          events: { on: () => undefined },
          computerId: null,
          start: () => {
            startedWithLoads = loads
          },
          stop: async () => undefined,
          notify: () => true
        } as never
      }
    })
    try {
      await vi.waitFor(() => expect(startedWithLoads).not.toBeNull())
      expect(startedWithLoads).toBe(0)
      expect(identity?.directRtc?.()).toBe(true)
      // The first offer loads it; here it cannot load, so the offer is refused (the
      // client falls back to the relay).
      await expect(
        onHubRequest?.(
          HubToComputerMethods.directRtcOffer,
          { grantId: 'g', sdp: 'v=0', stunAddresses: [], clientAddress: null },
          ACTOR
        )
      ).rejects.toThrow(/no WebRTC/)
      expect(loads).toBe(1)
    } finally {
      await handle.stop()
    }
  })

  it('stops advertising WebRTC once the addon fails to load', async () => {
    // A binary on disk that still cannot load (corrupt, wrong ABI): the next hello
    // must not invite more offers that cannot be answered.
    let identity: { directRtc?: () => boolean } | undefined
    let onHubRequest:
      | ((method: string, params: unknown, actor: unknown) => Promise<unknown>)
      | undefined
    let started = false
    const handle = startComputer(testConfig, {
      credentialStore: memoryStore(),
      stateDir: tempState(),
      rtc: { available: () => true, load: () => null },
      createDialer: (options) => {
        identity = options.identity as typeof identity
        onHubRequest = options.onHubRequest as typeof onHubRequest
        return {
          events: { on: () => undefined },
          computerId: null,
          start: () => {
            started = true
          },
          stop: async () => undefined,
          notify: () => true
        } as never
      }
    })
    try {
      await vi.waitFor(() => expect(started).toBe(true))
      expect(identity?.directRtc?.()).toBe(true)
      await expect(
        onHubRequest?.(
          HubToComputerMethods.directRtcOffer,
          { grantId: 'g', sdp: 'v=0', stunAddresses: [], clientAddress: null },
          ACTOR
        )
      ).rejects.toThrow(/no WebRTC/)
      expect(identity?.directRtc?.()).toBe(false)
    } finally {
      await handle.stop()
    }
  })
})

describe('startComputer direct link: a hub grant reaches that hub’s terminals', () => {
  it('serves a real session to a client holding the grant the hub registered', async () => {
    const { createHash } = await import('node:crypto')
    const { createTRPCClient, createWSClient, wsLink } = await import('@trpc/client')
    const { wireSuperjson } = await import('@slayzone/trpc-server/wire')
    const WebSocket = (await import('ws')).default
    let onHubRequest:
      | ((method: string, params: unknown, actor: unknown) => Promise<unknown>)
      | undefined
    let identity: { directAddress?: () => string | null } | undefined
    // The terminal is a project's: its folder here is where it may start (§9 Phase 7c).
    const slayRoot = mkdtempSync(join(tmpdir(), 'direct-seam-root-'))
    writeFileSync(
      join(slayRoot, 'computer.projects.json'),
      JSON.stringify({
        [hubHostFromUrl(testConfig.hubUrl)]: {
          p1: { path: realpathSync(process.cwd()), updatedAt: 0 }
        }
      })
    )
    vi.stubEnv('SLAYZONE_ROOT', slayRoot)
    const handle = startComputer(
      { ...testConfig, allowedRoots: [realpathSync(tmpdir()), process.cwd()] },
      {
        credentialStore: memoryStore(),
        stateDir: tempState(),
        createDialer: (options) => {
          identity = options.identity
          onHubRequest = options.onHubRequest as typeof onHubRequest
          return {
            events: { on: () => undefined },
            computerId: 'direct-seam-computer',
            start: () => undefined,
            stop: async () => undefined,
            notify: () => true
          } as never
        }
      }
    )
    try {
      await vi.waitFor(() => expect(identity?.directAddress?.()).toBeTruthy())
      const token = 'k'.repeat(43)
      await onHubRequest?.(
        HubToComputerMethods.directGrant,
        {
          grantId: 'g-1',
          tokenHash: createHash('sha256').update(token).digest('hex'),
          userId: null,
          resource: { kind: 'pty', sessionId: 'seam-1' },
          ttlMs: 60_000
        },
        ACTOR
      )
      await onHubRequest?.(
        HubToComputerMethods.ptySpawn,
        { sessionId: 'seam-1', projectId: 'p1', command: 'cat', cwd: process.cwd(), relay: false },
        ACTOR
      )
      await onHubRequest?.(
        HubToComputerMethods.ptyWrite,
        { sessionId: 'seam-1', data: 'seam\n' },
        ACTOR
      )
      const ws = createWSClient({
        url: `ws://${identity?.directAddress?.()}/direct/v1`,
        WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
        connectionParams: { token }
      })
      try {
        const trpc = createTRPCClient<import('@slayzone/transport/direct').DirectRouter>({
          links: [wsLink({ client: ws, transformer: wireSuperjson })]
        })
        await vi.waitFor(
          async () => {
            const attach = await trpc.pty.attach.query({ sessionId: 'seam-1', afterSeq: -1 })
            expect(attach.exists).toBe(true)
            expect(attach.buffer.chunks.map((c) => c.data).join('')).toContain('seam')
          },
          { timeout: 5_000 }
        )
      } finally {
        ws.close()
      }
    } finally {
      await handle.stop()
      vi.unstubAllEnvs()
      rmSync(slayRoot, { recursive: true, force: true })
    }
  })
})

/**
 * The desktop app's supervised computer joins further hubs while it runs: a restart
 * would kill every agent pty, so `setSecondaryHubs` reconciles the live set instead.
 * Dialers are real but never started (no socket), so lifecycle is driven by emitting
 * their events.
 */
describe('startComputer runtime secondary hubs', () => {
  const PRIMARY = 'ws://127.0.0.1:0/computers'
  const B = 'ws://127.0.0.2:0/computers'
  const C = 'ws://127.0.0.3:0/computers'

  let root: string
  beforeEach(() => {
    // Secondary hubs use the file credential store / project map / computer config
    // under the computer ROOT — keep every one of them in a temp dir.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'computer-secondary-')))
    vi.stubEnv('SLAYZONE_ROOT', root)
    vi.stubEnv('HOME', root)
    vi.stubEnv('USERPROFILE', root)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })

  function harness(config: Partial<ComputerConfig> = {}) {
    const created: { options: HubDialerOptions; dialer: HubDialer }[] = []
    const handle = startComputer(
      { ...testConfig, hubUrl: PRIMARY, joinToken: 'primary-token', ...config },
      {
        credentialStore: memoryStore(),
        stateDir: tempState(),
        refreshJoinTokenFor: async (hubUrl) => `fresh-for-${hubUrl}`,
        createDialer: (options) => {
          const dialer = new HubDialer(options)
          vi.spyOn(dialer, 'start').mockImplementation(() => {})
          vi.spyOn(dialer, 'stop')
          created.push({ options, dialer })
          return dialer
        }
      }
    )
    const of = (url: string) => created.filter((c) => c.options.url === url)
    const fatal = (dialer: HubDialer, reason?: 'needs-re-enrollment') =>
      dialer.events.emit('error', {
        error: new Error('refused'),
        fatal: true,
        ...(reason ? { reason } : {})
      })
    return { handle, created, of, fatal }
  }

  it('connects a hub added at runtime with its own name and join token', async () => {
    const { handle, of } = harness()
    try {
      await handle.setSecondaryHubs!([{ url: B, name: 'Kalle on B', joinToken: 'tok-b' }])
      expect(handle.dialers.length).toBe(2)
      const [b] = of(B)
      expect(b.dialer.start).toHaveBeenCalledTimes(1)
      expect(b.options.joinToken).toBe('tok-b')
      // Its own enrollment name; the primary keeps the configured one.
      expect(b.options.identity.name).toBe('Kalle on B')
      expect(of(PRIMARY)[0].options.identity.name).toBe(testConfig.name)
      expect(b.options.identity.platform).toBe(of(PRIMARY)[0].options.identity.platform)
      // Marked as a desktop's own computer joined there, so that hub never prefers it
      // over a computer its user already had; the primary reports exactly its own.
      expect(b.options.identity.capabilities).toEqual([...testConfig.capabilities, 'desktop'])
      expect(of(PRIMARY)[0].options.identity.capabilities).toEqual(testConfig.capabilities)
      // A spent token is recovered by asking the parent for a fresh one, per hub.
      expect(await b.options.refreshJoinToken!()).toBe(`fresh-for-${B}`)
      // The primary is wired exactly as before: no refresh hook, its own token.
      expect(of(PRIMARY)[0].options.refreshJoinToken).toBeUndefined()
      expect(of(PRIMARY)[0].options.joinToken).toBe('primary-token')
      // A second set with a different name changes nothing on a live connection.
      await handle.setSecondaryHubs!([{ url: B, name: 'renamed' }])
      expect(of(B).length).toBe(1)
      expect(b.dialer.stop).not.toHaveBeenCalled()
    } finally {
      await handle.stop()
    }
    // stop covers the runtime-added hub too.
    expect(of(B)[0].dialer.stop).toHaveBeenCalled()
  })

  // Grouping onto a machine must hold for every hub, whichever resolved first.
  it('gives a secondary identity the host id, before and after it resolves', async () => {
    const { handle, of } = harness()
    try {
      await handle.setSecondaryHubs!([{ url: B, name: 'b' }])
      const primary = of(PRIMARY)[0].options.identity
      await vi.waitFor(() => expect(primary.hostId).toBeDefined(), { timeout: 5_000 })
      expect(of(B)[0].options.identity.hostId).toBe(primary.hostId)
      await handle.setSecondaryHubs!([
        { url: B, name: 'b' },
        { url: C, name: 'c' }
      ])
      expect(of(C)[0].options.identity.hostId).toBe(primary.hostId)
    } finally {
      await handle.stop()
    }
  })

  it('removing a hub disposes only that connection', async () => {
    const { handle, of } = harness()
    try {
      await handle.setSecondaryHubs!([
        { url: B, name: 'b' },
        { url: C, name: 'c' }
      ])
      await handle.setSecondaryHubs!([{ url: C, name: 'c' }])
      expect(of(B)[0].dialer.stop).toHaveBeenCalled()
      expect(of(C)[0].dialer.stop).not.toHaveBeenCalled()
      expect(of(PRIMARY)[0].dialer.stop).not.toHaveBeenCalled()
      expect(handle.dialers).toEqual([of(PRIMARY)[0].dialer, of(C)[0].dialer])
      // Re-adding after removal is a fresh connection.
      await handle.setSecondaryHubs!([
        { url: B, name: 'b' },
        { url: C, name: 'c' }
      ])
      expect(of(B).length).toBe(2)
      expect(handle.dialers.length).toBe(3)
    } finally {
      await handle.stop()
    }
  })

  it('removing a hub revokes the direct-link grants it registered (none outlive it)', async () => {
    const { createHash } = await import('node:crypto')
    const { createTRPCClient, createWSClient, wsLink } = await import('@trpc/client')
    const { wireSuperjson } = await import('@slayzone/trpc-server/wire')
    const WebSocket = (await import('ws')).default
    const { handle, of } = harness()
    try {
      await handle.setSecondaryHubs!([{ url: B, name: 'b' }])
      const b = of(B)[0]!.options
      await vi.waitFor(() => expect(b.identity?.directAddress?.()).toBeTruthy())
      const token = 'r'.repeat(43)
      await b.onHubRequest?.(
        HubToComputerMethods.directGrant,
        {
          grantId: 'g-b',
          tokenHash: createHash('sha256').update(token).digest('hex'),
          userId: null,
          resource: { kind: 'pty', sessionId: 'b-1' },
          ttlMs: 600_000
        },
        ACTOR as never
      )
      const authorize = async (): Promise<unknown> => {
        const ws = createWSClient({
          url: `ws://${b.identity?.directAddress?.()}/direct/v1`,
          WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
          connectionParams: { token },
          retryDelayMs: () => 60_000
        })
        try {
          const trpc = createTRPCClient<import('@slayzone/transport/direct').DirectRouter>({
            links: [wsLink({ client: ws, transformer: wireSuperjson })]
          })
          return await Promise.race([
            trpc.authorize.mutate({ token }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3_000))
          ])
        } finally {
          ws.close()
        }
      }
      await expect(authorize()).resolves.toBeTruthy()
      await handle.setSecondaryHubs!([])
      await expect(authorize()).rejects.toThrow()
    } finally {
      await handle.stop()
    }
  })

  it('reconnects a fatally stopped secondary only when handed a join token', async () => {
    const { handle, of, fatal } = harness()
    try {
      await handle.setSecondaryHubs!([{ url: B, name: 'b' }])
      // A live hub with a token is left alone: the token is only for recovery.
      await handle.setSecondaryHubs!([{ url: B, name: 'b', joinToken: 'unused' }])
      expect(of(B).length).toBe(1)

      fatal(of(B)[0].dialer, 'needs-re-enrollment')
      // No token, nothing to recover with: it stays as it is.
      await handle.setSecondaryHubs!([{ url: B, name: 'b' }])
      expect(of(B).length).toBe(1)

      await handle.setSecondaryHubs!([{ url: B, name: 'b2', joinToken: 'tok-2' }])
      expect(of(B)[0].dialer.stop).toHaveBeenCalled()
      expect(of(B).length).toBe(2)
      expect(of(B)[1].options.joinToken).toBe('tok-2')
      expect(of(B)[1].options.identity.name).toBe('b2')
      expect(of(B)[1].dialer.start).toHaveBeenCalled()
      expect(handle.dialers).toEqual([of(PRIMARY)[0].dialer, of(B)[1].dialer])
    } finally {
      await handle.stop()
    }
  })

  it('never touches the primary hub', async () => {
    const { handle, of, created, fatal } = harness()
    const primary = of(PRIMARY)[0].dialer
    try {
      fatal(primary)
      await handle.setSecondaryHubs!([{ url: PRIMARY, name: 'x', joinToken: 'y' }])
      // Same credential key (host:port) under another url: would race the primary's creds.
      await handle.setSecondaryHubs!([{ url: 'wss://127.0.0.1:0/other', name: 'x' }])
      await handle.setSecondaryHubs!([])
      expect(created.length).toBe(1)
      expect(primary.stop).not.toHaveBeenCalled()
      expect(handle.dialer).toBe(primary)
      expect(handle.dialers).toEqual([primary])
    } finally {
      await handle.stop()
    }
  })

  it('a secondary hub fatal never sets the exit code; the primary one still does', async () => {
    const { handle, of, fatal } = harness()
    const exit = vi.fn()
    watchPrimaryHubExitCode(handle.dialer, exit)
    try {
      await handle.setSecondaryHubs!([{ url: B, name: 'b' }])
      fatal(of(B)[0].dialer, 'needs-re-enrollment')
      fatal(of(B)[0].dialer)
      expect(exit).not.toHaveBeenCalled()
      fatal(of(PRIMARY)[0].dialer, 'needs-re-enrollment')
      expect(exit).toHaveBeenCalledWith(COMPUTER_EXIT_NEEDS_RE_ENROLLMENT)
    } finally {
      await handle.stop()
    }
  })

  // T-27: only the desktop's own loopback hub may widen the jail. A hub joined at
  // runtime is someone else's hub, whatever the primary is allowed.
  it('a secondary hub cannot edit allowed roots; the primary still can', async () => {
    const allowed = join(root, 'allowed')
    const wider = join(root, 'wider')
    mkdirSync(allowed)
    mkdirSync(wider)
    const { handle, of } = harness({ allowedRoots: [allowed], hubMayEditRoots: true })
    try {
      await handle.setSecondaryHubs!([{ url: B, name: 'b' }])
      const viaB = of(B)[0].options.onHubRequest!
      const viaPrimary = of(PRIMARY)[0].options.onHubRequest!
      const err = await Promise.resolve(
        viaB(HubToComputerMethods.computerSetAllowedRoots, { roots: [allowed, wider] }, ACTOR)
      ).then(
        () => null,
        (e: unknown) => e
      )
      expect(err).toBeInstanceOf(RpcError)
      expect((err as RpcError).code).toBe(ComputerTransportErrorCodes.refusedByComputer)

      const ok = (await viaPrimary(
        HubToComputerMethods.computerSetAllowedRoots,
        { roots: [allowed, wider] },
        ACTOR
      )) as { roots: string[] }
      expect(ok.roots).toEqual([allowed, wider])
    } finally {
      await handle.stop()
    }
  })
})
