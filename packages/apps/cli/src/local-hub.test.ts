/**
 * local-hub — how the CLI finds the desktop app WITHOUT a database.
 *
 * These two predicates are what replaced reading `settings.server_port` out of
 * SQLite, which is what forced the CLI to derive the app's on-disk layout and
 * broke every command from a plain shell when that layout moved. They are pure
 * (env in, value out), so they are pinned here rather than through a live server:
 * `isCoLocatedHub` in particular is only reachable over the network by addressing
 * a non-loopback host, which no offline test can arrange portably.
 *
 * Pure Node.
 */
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { SIDECAR_FIXED_PORT } from '@slayzone/platform/paths'
import { currentOsUser } from '@slayzone/platform/hub-discovery'
import { fixedPortForChannel, isCoLocatedHub, probeLocalHub } from './local-hub'

/** Run `fn` with the given SLAYZONE_* env, restoring whatever was there before. */
async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void | Promise<void>
): Promise<void> {
  const prev: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    await fn()
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

describe('fixedPortForChannel', () => {
  test('dev channel resolves the dev sidecar port', async () => {
    await withEnv({ SLAYZONE_DEV: '1' }, () => {
      expect(fixedPortForChannel()).toBe(SIDECAR_FIXED_PORT.dev)
    })
  })

  test('unset SLAYZONE_DEV resolves the packaged sidecar port', async () => {
    await withEnv({ SLAYZONE_DEV: undefined }, () => {
      expect(fixedPortForChannel()).toBe(SIDECAR_FIXED_PORT.prod)
    })
  })

  // The two channels must never collide, or `slay` and `slay --dev` would target
  // one install and the "app is running with/without --dev" hint could never fire.
  // Widened to `number` so this stays a runtime assertion: compared as literal
  // types, TS proves the inequality at compile time and rejects the check as
  // unintentional — which would silently drop the guard if the constants ever met.
  test('dev and prod fixed ports are distinct', () => {
    const devPort: number = SIDECAR_FIXED_PORT.dev
    const prodPort: number = SIDECAR_FIXED_PORT.prod
    expect(devPort).not.toBe(prodPort)
  })
})

describe('isCoLocatedHub', () => {
  // No hub configured ⇒ the target was found by probing loopback, so it is this
  // machine by construction.
  test('no hub configured is co-located', async () => {
    await withEnv({ SLAYZONE_HUB_ADDRESS: undefined, SLAYZONE_HUB_TOKEN: undefined }, async () => {
      // The stored hub target lives under $HOME, which the runner made a throwaway
      // (caller-env.ts): nothing is stored, so nothing is configured.
      expect(await isCoLocatedHub()).toBe(true)
    })
  })

  for (const addr of ['127.0.0.1:51101', 'localhost:51101', '[::1]:51101']) {
    test(`loopback hub is co-located (${addr})`, async () => {
      await withEnv({ SLAYZONE_HUB_ADDRESS: addr }, async () => {
        expect(await isCoLocatedHub()).toBe(true)
      })
    })
  }

  for (const addr of ['hub.example.com:8443', '10.0.0.5:51101', 'slayzone.internal']) {
    test(`off-box hub is NOT co-located (${addr})`, async () => {
      await withEnv({ SLAYZONE_HUB_ADDRESS: addr }, async () => {
        expect(await isCoLocatedHub()).toBe(false)
      })
    })
  }

  // A wildcard bind names every interface, not this one — treating it as
  // co-located would print a local path for an artifact that may live elsewhere.
  test('wildcard address is NOT co-located', async () => {
    await withEnv({ SLAYZONE_HUB_ADDRESS: '0.0.0.0:51101' }, async () => {
      expect(await isCoLocatedHub()).toBe(false)
    })
  })
})

/** Serve `handler` on an OS-assigned loopback port for the duration of `fn`. */
async function withServer(
  handler: http.RequestListener,
  fn: (port: number) => Promise<void>
): Promise<void> {
  // Close every socket on the way out so a keep-alive probe connection cannot hold
  // `close()` open.
  const srv = http.createServer(handler)
  srv.keepAliveTimeout = 1
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const port = (srv.address() as net.AddressInfo).port
  try {
    await fn(port)
  } finally {
    srv.closeAllConnections()
    await new Promise<void>((r) => srv.close(() => r()))
  }
}

/** A /health responder shaped like a hub serving `root`. */
const hubAt =
  (root: string): http.RequestListener =>
  (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, name: 'h', root, pid: 1 }))
  }

/** A loopback port nothing listens on. */
function deadPort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    })
  })
}

/** Sweep range of exactly one (dead) port, so a test never probes the machine's real hubs. */
async function emptyRange(): Promise<{ start: number; end: number }> {
  const p = await deadPort()
  return { start: p, end: p }
}

// The decision logic behind "which app does a bare `slay` act on", on ports the
// test owns — so it never depends on what the developer's machine has bound on the
// real channel ports (a running prod + dev app hold both).
describe('probeLocalHub', () => {
  const ours = path.resolve('/tmp/slz-probe-ours')

  test('nothing listening ⇒ absent', async () => {
    const port = await deadPort()
    expect(await probeLocalHub({ port, range: await emptyRange() })).toEqual({ kind: 'absent' })
  })

  test('a non-hub squatter is rejected, not dialled ⇒ absent', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not a hub')
      },
      async (port) => {
        expect(await probeLocalHub({ port, range: await emptyRange() })).toEqual({ kind: 'absent' })
      }
    )
  })

  test('our hub ⇒ found', async () => {
    await withServer(hubAt(ours), async (port) => {
      await withEnv({ SLAYZONE_ROOT: ours }, async () => {
        expect(await probeLocalHub({ port, range: await emptyRange() })).toMatchObject({
          kind: 'found',
          port,
          root: ours
        })
      })
    })
  })

  test("another install's hub ⇒ foreign (never acted on)", async () => {
    const theirs = path.resolve('/tmp/slz-probe-theirs')
    await withServer(hubAt(theirs), async (port) => {
      await withEnv({ SLAYZONE_ROOT: ours }, async () => {
        expect(await probeLocalHub({ port, range: await emptyRange() })).toEqual({
          kind: 'foreign',
          port,
          root: theirs,
          expected: ours
        })
      })
    })
  })

  // Several macOS users on one Mac share loopback: the first user's app holds the
  // channel's fixed port, so the second user's app serves on a fallback port in the
  // hub block (sidecar-server-supervisor.ts). A plain shell has no SLAYZONE_ROOT, so
  // "ours" is the app `/health` says runs as this OS user, on this channel.
  describe('plain shell (no SLAYZONE_ROOT) on a Mac shared by several users', () => {
    const me = currentOsUser() ?? 'me'
    const OTHER_ROOT = '/Users/someone-else/.slayzone/stable/hub'
    const MY_ROOT = '/Users/me/.slayzone/stable/hub'
    const MY_DEV_ROOT = '/Users/me/.slayzone/dev/hub'
    /** A supervised app hub running as `user`, on the dev channel or not. */
    const appHub =
      (root: string, user: string, dev = false): http.RequestListener =>
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, name: 'h', root, pid: 1, supervised: true, user, dev }))
      }
    const plainShell = { SLAYZONE_ROOT: undefined, SLAYZONE_DEV: undefined }
    const one = (port: number): { start: number; end: number } => ({ start: port, end: port })

    test("another user's app on the fixed port ⇒ foreign, not this user's app", async () => {
      await withServer(appHub(OTHER_ROOT, 'someone-else'), async (port) => {
        await withEnv(plainShell, async () => {
          expect(await probeLocalHub({ port, range: await emptyRange() })).toEqual({
            kind: 'foreign',
            port,
            root: OTHER_ROOT,
            expected: `the SlayZone app of OS user "${me}"`
          })
        })
      })
    })

    test("another user's app on the fixed port, ours on a fallback port ⇒ ours", async () => {
      await withServer(appHub(OTHER_ROOT, 'someone-else'), async (fixed) => {
        await withServer(appHub(MY_ROOT, me), async (fallback) => {
          await withEnv(plainShell, async () => {
            expect(await probeLocalHub({ port: fixed, range: one(fallback) })).toMatchObject({
              kind: 'found',
              port: fallback,
              root: MY_ROOT
            })
          })
        })
      })
    })

    test('fixed port empty (other user quit), ours still on its fallback port ⇒ ours', async () => {
      const fixed = await deadPort()
      await withServer(appHub(MY_ROOT, me), async (fallback) => {
        await withEnv(plainShell, async () => {
          expect(await probeLocalHub({ port: fixed, range: one(fallback) })).toMatchObject({
            kind: 'found',
            port: fallback,
            root: MY_ROOT
          })
        })
      })
    })

    test('the sweep skips our OTHER channel’s app and non-app hubs', async () => {
      const fixed = await deadPort()
      await withServer(appHub(MY_DEV_ROOT, me, true), async (devApp) => {
        await withServer(hubAt(MY_ROOT), async (standalone) => {
          await withEnv(plainShell, async () => {
            expect(await probeLocalHub({ port: fixed, range: one(devApp) }), 'dev app').toEqual({
              kind: 'absent'
            })
            expect(
              await probeLocalHub({ port: fixed, range: one(standalone) }),
              'not an app hub'
            ).toEqual({ kind: 'absent' })
          })
        })
      })
    })

    test('--dev finds our dev app on a fallback port, and only that', async () => {
      const fixed = await deadPort()
      await withServer(appHub(MY_ROOT, me), async (stable) => {
        await withServer(appHub(MY_DEV_ROOT, me, true), async (dev) => {
          await withEnv({ ...plainShell, SLAYZONE_DEV: '1' }, async () => {
            expect(await probeLocalHub({ port: fixed, range: one(dev) })).toMatchObject({
              kind: 'found',
              port: dev
            })
            expect(await probeLocalHub({ port: fixed, range: one(stable) })).toEqual({
              kind: 'absent'
            })
          })
        })
      })
    })

    test('our own app on the fixed port ⇒ found (the normal single-user case)', async () => {
      await withServer(appHub(MY_ROOT, me), async (port) => {
        await withEnv(plainShell, async () => {
          expect(await probeLocalHub({ port, range: await emptyRange() })).toMatchObject({
            kind: 'found',
            port,
            root: MY_ROOT
          })
        })
      })
    })

    test('a hub too old to report its user is still accepted on the fixed port', async () => {
      await withServer(hubAt(OTHER_ROOT), async (port) => {
        await withEnv(plainShell, async () => {
          expect(await probeLocalHub({ port, range: await emptyRange() })).toMatchObject({
            kind: 'found',
            port
          })
        })
      })
    })
  })
})
