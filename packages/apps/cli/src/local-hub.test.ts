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
import { fixedPortForChannel, isCoLocatedHub, probeFixedPort } from './local-hub'

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
  test('no env hub configured answers without throwing', async () => {
    await withEnv({ SLAYZONE_HUB_ADDRESS: undefined, SLAYZONE_HUB_TOKEN: undefined }, async () => {
      // NOTE: this reads the real hub-target file if the developer running the suite
      // has one. Assert only the shape that holds either way — a boolean, no throw.
      expect(typeof (await isCoLocatedHub())).toBe('boolean')
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

// The decision logic behind "which app does a bare `slay` act on", on ports the
// test owns — so it never depends on what the developer's machine has bound on the
// real channel ports (a running prod + dev app hold both).
describe('probeFixedPort', () => {
  const ours = path.resolve('/tmp/slz-probe-ours')

  test('nothing listening ⇒ absent', async () => {
    const free = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const port = (s.address() as net.AddressInfo).port
        s.close(() => resolve(port))
      })
    })
    expect(await probeFixedPort(free)).toEqual({ kind: 'absent' })
  })

  test('a non-hub squatter is rejected, not dialled ⇒ absent', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not a hub')
      },
      async (port) => {
        expect(await probeFixedPort(port)).toEqual({ kind: 'absent' })
      }
    )
  })

  test('our hub ⇒ found', async () => {
    await withServer(hubAt(ours), async (port) => {
      await withEnv({ SLAYZONE_ROOT: ours }, async () => {
        expect(await probeFixedPort(port)).toMatchObject({ kind: 'found', port, root: ours })
      })
    })
  })

  test("another install's hub ⇒ foreign (never acted on)", async () => {
    const theirs = path.resolve('/tmp/slz-probe-theirs')
    await withServer(hubAt(theirs), async (port) => {
      await withEnv({ SLAYZONE_ROOT: ours }, async () => {
        expect(await probeFixedPort(port)).toEqual({
          kind: 'foreign',
          port,
          root: theirs,
          expected: ours
        })
      })
    })
  })
})
