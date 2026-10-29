/**
 * Multi-hub discovery (plans/hub-lifecycle-and-discovery.md, Phase 4).
 *
 * `slay hub ls` finds every hub on the machine by probing the hub port block for
 * a `/health` answer — no pidfile, no registry file, nothing that can go stale or
 * miss a hub started by docker/systemd/another user. This suite pins the
 * properties that make that trustworthy: it must not invent hubs, must ignore
 * anything that isn't a SlayZone hub, and must not hang on a black-hole port.
 *
 * Pure Node (real ephemeral HTTP servers on loopback, no native deps) → runs
 * under plain `npx tsx`.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/shared/platform/src/hub-discovery.test.ts
 */
import { afterAll, describe, expect, test } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { discoverHubs, findHub } from './hub-discovery'

type Closer = () => Promise<void>
const cleanups: Closer[] = []

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void

/** A hub-shaped /health responder; `delayMs` holds each answer back that long. */
function hubHandler(body: Record<string, unknown>, delayMs = 0): Handler {
  return (req, res) => {
    if (req.url !== '/health') {
      res.writeHead(404)
      res.end()
      return
    }
    const answer = (): void => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, ...body }))
    }
    if (delayMs > 0) setTimeout(answer, delayMs)
    else answer()
  }
}

/** Something that is NOT a hub (wrong shape / wrong service). */
const nonHubHandler =
  (respond: (res: http.ServerResponse) => void): Handler =>
  (_req, res) =>
    respond(res)

const closeServer = (srv: net.Server): Promise<void> => new Promise((r) => srv.close(() => r()))

/** Listen on loopback `port` (0 = OS-assigned): the bound port, or null when it is taken. */
function listenOrTaken(srv: net.Server, port: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      if (err.code === 'EADDRINUSE') resolve(null)
      else reject(err)
    }
    srv.once('error', onError)
    srv.listen(port, '127.0.0.1', () => {
      srv.off('error', onError)
      resolve((srv.address() as AddressInfo).port)
    })
  })
}

/** Serve `handler` on an OS-assigned port; a sweep of exactly that port probes only it. */
async function serve(handler: Handler): Promise<number> {
  const srv = http.createServer(handler)
  const port = await listenOrTaken(srv, 0)
  if (port === null) throw new Error('an OS-assigned port cannot be taken')
  cleanups.push(() => closeServer(srv))
  return port
}

/**
 * Serve each handler on its own port, the ports ADJACENT and ascending in handler
 * order, so a sweep of exactly the returned range probes nothing but these servers.
 *
 * Two separately OS-assigned ports give no such guarantee: test files run
 * concurrently (one vitest run, many forks), and the gap between two ephemeral
 * ports can hold ANOTHER file's hub — a real one or a fake like these — which the
 * sweep would rightly count. A neighbour that is already taken just means starting
 * over from a fresh OS-assigned base port.
 */
async function serveAdjacent(handlers: Handler[]): Promise<{ start: number; end: number }> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const servers = handlers.map((h) => http.createServer(h))
    const base = await listenOrTaken(servers[0]!, 0)
    if (base === null) throw new Error('an OS-assigned port cannot be taken')
    let claimed = base + servers.length - 1 <= 65535
    for (let i = 1; claimed && i < servers.length; i++) {
      claimed = (await listenOrTaken(servers[i]!, base + i)) !== null
    }
    if (claimed) {
      for (const srv of servers) cleanups.push(() => closeServer(srv))
      return { start: base, end: base + servers.length - 1 }
    }
    await Promise.all(servers.filter((s) => s.listening).map(closeServer))
  }
  throw new Error(`no run of ${handlers.length} adjacent free loopback ports in 100 attempts`)
}

const fakeHub = (body: Record<string, unknown>): Promise<number> => serve(hubHandler(body))
const fakeNonHub = (respond: (res: http.ServerResponse) => void): Promise<number> =>
  serve(nonHubHandler(respond))

/**
 * A TCP listener that accepts and then says nothing — the black-hole case. A
 * probe without a timeout hangs here forever, which would hang `slay hub ls`.
 */
async function fakeBlackHole(): Promise<number> {
  const sockets = new Set<net.Socket>()
  const srv = net.createServer((sock) => {
    // Accept, never respond. Held open on purpose — that is the hang we're
    // testing the probe against.
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  cleanups.push(
    () =>
      new Promise((r) => {
        // `close()` stops accepting but WAITS for live sockets, and this server's
        // sockets never end on their own — destroy them or cleanup never resolves.
        for (const s of sockets) s.destroy()
        srv.close(() => r())
      })
  )
  return (srv.address() as AddressInfo).port
}

/** A port nothing listens on (bind, read the port, release). */
async function deadPort(): Promise<number> {
  const srv = net.createServer()
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const port = (srv.address() as AddressInfo).port
  await new Promise<void>((r) => srv.close(() => r()))
  return port
}

const HUB_A = {
  name: 'alpha',
  root: '/tmp/hubs/alpha',
  dbPath: '/tmp/hubs/alpha/storage/slayzone.sqlite',
  pid: 111,
  authRequired: true,
  switches: {
    requireLogin: true,
    enablePassword: true,
    enableSso: false,
    enableProcesses: false,
    enableIntegrations: false
  },
  supervised: false,
  computersConnected: 2,
  uptimeMs: 90_000,
  commit: 'abc1234',
  builtAt: '2026-07-30T00:00:00.000Z',
  buildId: 'abc1234@2026-07-30T00:00:00.000Z'
}

describe('hub discovery', () => {
  afterAll(async () => {
    for (const c of cleanups) await c()
  })

  test('finds a hub and maps every /health field', async () => {
    const port = await fakeHub(HUB_A)
    const hubs = await discoverHubs({ range: { start: port, end: port } })
    expect(hubs.length, 'one hub found').toBe(1)
    const h = hubs[0]!
    expect(h.port, 'port is where we found it, not what the body claimed').toBe(port)
    expect(h.name, 'name').toBe('alpha')
    expect(h.root, 'root').toBe('/tmp/hubs/alpha')
    expect(h.dbPath, 'dbPath').toBe(HUB_A.dbPath)
    expect(h.pid, 'pid').toBe(111)
    expect(h.authRequired, 'authRequired').toBe(true)
    expect(h.switches?.requireLogin, 'switch requireLogin').toBe(true)
    expect(h.switches?.enableProcesses, 'switch enableProcesses').toBe(false)
    expect(h.switches?.enablePassword, 'switch enablePassword').toBe(true)
    expect(h.supervised, 'supervised').toBe(false)
    expect(h.computersConnected, 'computersConnected').toBe(2)
    expect(h.uptimeMs, 'uptimeMs').toBe(90_000)
    expect(h.buildId, 'buildId').toBe(HUB_A.buildId)
  })

  test('an older hub without authRequired/switches reads as login-off, switches unknown', async () => {
    const { authRequired: _a, switches: _s, ...older } = HUB_A
    const port = await fakeHub(older)
    const hubs = await discoverHubs({ range: { start: port, end: port } })
    expect(hubs[0]?.authRequired, 'absent authRequired → false').toBe(false)
    expect(hubs[0]?.switches, 'absent switches → null, not invented defaults').toBe(null)
  })

  test('a hub older than a switch reports that switch at its default', async () => {
    const port = await fakeHub(HUB_A)
    const hubs = await discoverHubs({ range: { start: port, end: port } })
    expect(HUB_A.switches, 'fixture predates the telemetry switch').not.toHaveProperty(
      'enableTelemetry'
    )
    expect(hubs[0]?.switches?.enableTelemetry, 'absent key → default (on)').toBe(true)
    expect(hubs[0]?.switches?.enableProcesses, 'present keys still read').toBe(false)
  })

  test('a hub with telemetry off reports it', async () => {
    const port = await fakeHub({
      ...HUB_A,
      switches: { ...HUB_A.switches, enableTelemetry: false }
    })
    const hubs = await discoverHubs({ range: { start: port, end: port } })
    expect(hubs[0]?.switches?.enableTelemetry).toBe(false)
  })

  test('a malformed switches object reads as unknown', async () => {
    const port = await fakeHub({ ...HUB_A, switches: { requireLogin: 'yes' } })
    const hubs = await discoverHubs({ range: { start: port, end: port } })
    expect(hubs[0]?.switches, 'non-boolean switch → null').toBe(null)
  })

  test('reports the port it PROBED, ignoring a body that claims another', async () => {
    // A hub behind a port-forward reports its own bind port, but the CLI must
    // dial the port it actually reached — else `hub stop`/`--hub` target a port
    // nothing answers on.
    const port = await fakeHub({ ...HUB_A, port: 4444 })
    const hubs = await discoverHubs({ range: { start: port, end: port } })
    expect(hubs[0]?.port, 'probed port wins over the self-reported one').toBe(port)
  })

  test('finds several hubs at once and sorts them stably', async () => {
    // The LOWER port answers last, so the worker pool collects them in reverse
    // port order — only the sort puts them back. The generous probe budget keeps
    // that held-back answer from ever reading as a timeout on a loaded machine.
    const range = await serveAdjacent([
      hubHandler({ ...HUB_A, name: 'zulu' }, 100),
      hubHandler({ ...HUB_A, name: 'bravo' })
    ])
    const hubs = await discoverHubs({ range, timeoutMs: 5_000 })
    expect(
      hubs.map((h) => h.port),
      'both found, ascending by port'
    ).toEqual([range.start, range.end])
    // Port order — not name order, not the order the answers arrived in.
    expect(
      hubs.map((h) => h.name),
      'sorted by port'
    ).toEqual(['zulu', 'bravo'])
  })

  test('a dead port yields nothing (no phantom hub)', async () => {
    const port = await deadPort()
    const hubs = await discoverHubs({ range: { start: port, end: port } })
    expect(hubs.length, 'no hub on a closed port').toBe(0)
  })

  test('ignores a non-SlayZone service on a hub port', async () => {
    const range = await serveAdjacent([
      nonHubHandler((res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html>not a hub</html>')
      }),
      nonHubHandler((res) => {
        res.writeHead(404)
        res.end('{}')
      })
    ])
    const hubs = await discoverHubs({ range })
    expect(hubs.length, 'neither counted as a hub').toBe(0)
  })

  test('ignores JSON that is missing the hub identity fields', async () => {
    // Shaped like a health endpoint but not a hub's — e.g. some other service's
    // /health, or a hub answering a NON-loopback caller (identity withheld).
    const port = await fakeNonHub((res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, status: 'green' }))
    })
    const hubs = await discoverHubs({ range: { start: port, end: port } })
    expect(hubs.length, 'no name/root/pid ⇒ not a usable hub row').toBe(0)
  })

  test('does not hang on a port that accepts but never answers', async () => {
    const port = await fakeBlackHole()
    const started = Date.now()
    const hubs = await discoverHubs({ range: { start: port, end: port }, timeoutMs: 250 })
    const elapsed = Date.now() - started
    expect(hubs.length, 'black hole is not a hub').toBe(0)
    expect(elapsed, `gave up quickly (took ${elapsed}ms)`).toBeLessThan(3_000)
  })

  test('a busy hub that answers late is still discovered (default budget)', async () => {
    // A hub whose event loop is busy (password hashing, a big txn) accepts the
    // connection at once — the kernel does that — but answers /health late. A
    // tight budget dropped it from the sweep, so `--hub <name>` failed with "No hub
    // named …" while the very next sweep (the error's own hint) listed it.
    const handler = hubHandler(HUB_A)
    const port = await serve((req, res) => {
      setTimeout(() => handler(req, res), 800)
    })
    const hubs = await discoverHubs({ range: { start: port, end: port } })
    expect(
      hubs.map((h) => h.name),
      'slow-but-live hub is listed'
    ).toEqual([HUB_A.name])
    const found = await findHub(HUB_A.name as string, { range: { start: port, end: port } })
    expect(found?.port, 'and resolvable by name').toBe(port)
  })

  test('a 503 (hub still starting) is not yet a discoverable hub', async () => {
    const port = await fakeNonHub((res) => {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end('{"ok":false,"reason":"starting"}')
    })
    const hubs = await discoverHubs({ range: { start: port, end: port } })
    expect(hubs.length, 'not ready ⇒ not listed').toBe(0)
  })

  test('extraPorts finds a hub outside the swept range', async () => {
    // The desktop app's sidecar binds an OS-assigned port, outside the block.
    // The CLI reads that port from `settings.server_port` and passes it here —
    // without this, the app's hub is missing from `hub ls`.
    const port = await fakeHub({ ...HUB_A, name: 'app' })
    const swept = await discoverHubs({ range: { start: 1, end: 1 } })
    expect(swept.length, 'not in the range').toBe(0)
    const withExtra = await discoverHubs({ range: { start: 1, end: 1 }, extraPorts: [port] })
    expect(withExtra.length, 'found via extraPorts').toBe(1)
    expect(withExtra[0]?.name, 'the right hub').toBe('app')
  })

  test('an extraPort already inside the range is not probed twice', async () => {
    const port = await fakeHub({ ...HUB_A, name: 'dedup' })
    const hubs = await discoverHubs({ range: { start: port, end: port }, extraPorts: [port] })
    expect(hubs.length, 'listed once, not twice').toBe(1)
  })

  test('a dead extraPort is harmless', async () => {
    // Stale `settings.server_port` (the app has since quit) must not error.
    const port = await deadPort()
    const hubs = await discoverHubs({ range: { start: 1, end: 1 }, extraPorts: [port] })
    expect(hubs.length, 'no phantom row').toBe(0)
  })

  test('findHub by name searches extraPorts too', async () => {
    const port = await fakeHub({ ...HUB_A, name: 'app' })
    const found = await findHub('app', { range: { start: 1, end: 1 }, extraPorts: [port] })
    expect(found?.name, 'name lookup covers extraPorts').toBe('app')
  })

  test('findHub resolves by name', async () => {
    const port = await fakeHub({ ...HUB_A, name: 'staging' })
    const found = await findHub('staging', { range: { start: port, end: port } })
    expect(found?.name, 'matched by name').toBe('staging')
    const missing = await findHub('nope', { range: { start: port, end: port } })
    expect(missing, 'unknown name → null').toBe(null)
  })

  test('findHub resolves by port number', async () => {
    const port = await fakeHub({ ...HUB_A, name: 'byport' })
    const found = await findHub(String(port), { range: { start: port, end: port } })
    expect(found?.name, 'matched by port string').toBe('byport')
  })

  test('findHub by port probes that port even outside the range', async () => {
    // `slay --hub 51999` must work for an explicitly-configured hub that the
    // block scan would never reach.
    const port = await fakeHub({ ...HUB_A, name: 'out-of-block' })
    const found = await findHub(String(port), { range: { start: 1, end: 1 } })
    expect(found?.name, 'direct port probe, no range dependency').toBe('out-of-block')
  })

  test('a large range completes promptly (concurrency, not serial)', async () => {
    // 200 mostly-dead ports probed serially would be far too slow. The scan
    // must overlap probes or `hub ls` is unusable.
    const port = await fakeHub(HUB_A)
    const started = Date.now()
    // Sweep DOWNWARD from the real hub when counting up would run off the end
    // of the port space: `port` is ephemeral, so anything above 65336 made
    // `port + 199` exceed 65535 and node rejected the probe outright ("Port
    // should be >= 0 and < 65536"). Intermittent by construction — it depended
    // on which port the OS handed out — and it never surfaced because this
    // file sat downstream of a `set -e` abort in run-all.sh and had never run.
    const start = port + 199 <= 65535 ? port : port - 199
    // Default budget, not a tight override: under a loaded box the real hub
    // itself can answer later than 300ms. Dead ports refuse at once regardless.
    const hubs = await discoverHubs({ range: { start, end: start + 199 } })
    const elapsed = Date.now() - started
    expect(hubs.length, 'still found the real hub').toBeGreaterThanOrEqual(1)
    expect(elapsed, `200-port sweep took ${elapsed}ms`).toBeLessThan(10_000)
  })
})
