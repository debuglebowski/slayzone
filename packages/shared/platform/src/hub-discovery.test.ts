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

/**
 * Close every fake hub opened so far. A test that SWEEPS a port range between two
 * fresh ephemeral ports would otherwise also find the hubs earlier tests left
 * listening (they close at the very end), and count them: the OS picks ephemeral
 * ports in no promised order, so on Linux the range between two new ports can span
 * old ones.
 */
async function closeLeftovers(): Promise<void> {
  for (const c of cleanups.splice(0)) await c()
}

/** A hub-shaped /health responder on an OS-assigned port. */
async function fakeHub(body: Record<string, unknown>): Promise<number> {
  const srv = http.createServer((req, res) => {
    if (req.url !== '/health') {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, ...body }))
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  cleanups.push(() => new Promise((r) => srv.close(() => r())))
  return (srv.address() as AddressInfo).port
}

/** Serves something that is NOT a hub (wrong shape / wrong service). */
async function fakeNonHub(handler: (res: http.ServerResponse) => void): Promise<number> {
  const srv = http.createServer((_req, res) => handler(res))
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  cleanups.push(() => new Promise((r) => srv.close(() => r())))
  return (srv.address() as AddressInfo).port
}

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
    await closeLeftovers()
    const p1 = await fakeHub({ ...HUB_A, name: 'zulu' })
    const p2 = await fakeHub({ ...HUB_A, name: 'bravo' })
    const lo = Math.min(p1, p2)
    const hi = Math.max(p1, p2)
    const hubs = await discoverHubs({ range: { start: lo, end: hi } })
    expect(hubs.length, 'both found').toBe(2)
    // Port order is deterministic; name order would depend on which fake bound
    // which ephemeral port.
    expect(hubs[0]!.port, 'ascending by port').toBeLessThan(hubs[1]!.port)
  })

  test('a dead port yields nothing (no phantom hub)', async () => {
    const port = await deadPort()
    const hubs = await discoverHubs({ range: { start: port, end: port } })
    expect(hubs.length, 'no hub on a closed port').toBe(0)
  })

  test('ignores a non-SlayZone service on a hub port', async () => {
    await closeLeftovers()
    const html = await fakeNonHub((res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html>not a hub</html>')
    })
    const json404 = await fakeNonHub((res) => {
      res.writeHead(404)
      res.end('{}')
    })
    const lo = Math.min(html, json404)
    const hi = Math.max(html, json404)
    const hubs = await discoverHubs({ range: { start: lo, end: hi } })
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
    // 200 mostly-dead ports at 300ms each would be a minute serially. The scan
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
    const hubs = await discoverHubs({ range: { start, end: start + 199 }, timeoutMs: 300 })
    const elapsed = Date.now() - started
    expect(hubs.length, 'still found the real hub').toBeGreaterThanOrEqual(1)
    expect(elapsed, `200-port sweep took ${elapsed}ms`).toBeLessThan(10_000)
  })
})
