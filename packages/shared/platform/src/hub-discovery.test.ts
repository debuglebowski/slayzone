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
 * Run with: npx tsx packages/shared/platform/src/hub-discovery.test.ts
 */
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { discoverHubs, findHub } from './hub-discovery'

let passed = 0
let failed = 0

function test(name: string, fn: () => Promise<void>): Promise<void> {
  return fn()
    .then(() => {
      console.log(`  ✓ ${name}`)
      passed++
    })
    .catch((e) => {
      console.error(`  ✗ ${name}`)
      console.error(`    ${e instanceof Error ? e.message : e}`)
      failed++
    })
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}
function assertEq(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`)
}

type Closer = () => Promise<void>
const cleanups: Closer[] = []

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
  mode: 'local',
  supervised: false,
  runnersConnected: 2,
  uptimeMs: 90_000,
  commit: 'abc1234',
  builtAt: '2026-07-30T00:00:00.000Z',
  buildId: 'abc1234@2026-07-30T00:00:00.000Z'
}

async function main(): Promise<void> {
  console.log('\nhub discovery\n')

  try {
    await test('finds a hub and maps every /health field', async () => {
      const port = await fakeHub(HUB_A)
      const hubs = await discoverHubs({ range: { start: port, end: port } })
      assertEq(hubs.length, 1, 'one hub found')
      const h = hubs[0]!
      assertEq(h.port, port, 'port is where we found it, not what the body claimed')
      assertEq(h.name, 'alpha', 'name')
      assertEq(h.root, '/tmp/hubs/alpha', 'root')
      assertEq(h.dbPath, HUB_A.dbPath, 'dbPath')
      assertEq(h.pid, 111, 'pid')
      assertEq(h.mode, 'local', 'mode')
      assertEq(h.supervised, false, 'supervised')
      assertEq(h.runnersConnected, 2, 'runnersConnected')
      assertEq(h.uptimeMs, 90_000, 'uptimeMs')
      assertEq(h.buildId, HUB_A.buildId, 'buildId')
    })

    await test('reports the port it PROBED, ignoring a body that claims another', async () => {
      // A hub behind a port-forward reports its own bind port, but the CLI must
      // dial the port it actually reached — else `hub stop`/`--hub` target a port
      // nothing answers on.
      const port = await fakeHub({ ...HUB_A, port: 4444 })
      const hubs = await discoverHubs({ range: { start: port, end: port } })
      assertEq(hubs[0]?.port, port, 'probed port wins over the self-reported one')
    })

    await test('finds several hubs at once and sorts them stably', async () => {
      const p1 = await fakeHub({ ...HUB_A, name: 'zulu' })
      const p2 = await fakeHub({ ...HUB_A, name: 'bravo' })
      const lo = Math.min(p1, p2)
      const hi = Math.max(p1, p2)
      const hubs = await discoverHubs({ range: { start: lo, end: hi } })
      assertEq(hubs.length, 2, 'both found')
      // Port order is deterministic; name order would depend on which fake bound
      // which ephemeral port.
      assert(hubs[0]!.port < hubs[1]!.port, 'ascending by port')
    })

    await test('a dead port yields nothing (no phantom hub)', async () => {
      const port = await deadPort()
      const hubs = await discoverHubs({ range: { start: port, end: port } })
      assertEq(hubs.length, 0, 'no hub on a closed port')
    })

    await test('ignores a non-SlayZone service on a hub port', async () => {
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
      assertEq(hubs.length, 0, 'neither counted as a hub')
    })

    await test('ignores JSON that is missing the hub identity fields', async () => {
      // Shaped like a health endpoint but not a hub's — e.g. some other service's
      // /health, or a hub answering a NON-loopback caller (identity withheld).
      const port = await fakeNonHub((res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, status: 'green' }))
      })
      const hubs = await discoverHubs({ range: { start: port, end: port } })
      assertEq(hubs.length, 0, 'no name/root/pid ⇒ not a usable hub row')
    })

    await test('does not hang on a port that accepts but never answers', async () => {
      const port = await fakeBlackHole()
      const started = Date.now()
      const hubs = await discoverHubs({ range: { start: port, end: port }, timeoutMs: 250 })
      const elapsed = Date.now() - started
      assertEq(hubs.length, 0, 'black hole is not a hub')
      assert(elapsed < 3_000, `gave up quickly (took ${elapsed}ms)`)
    })

    await test('a 503 (hub still starting) is not yet a discoverable hub', async () => {
      const port = await fakeNonHub((res) => {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end('{"ok":false,"reason":"starting"}')
      })
      const hubs = await discoverHubs({ range: { start: port, end: port } })
      assertEq(hubs.length, 0, 'not ready ⇒ not listed')
    })

    await test('extraPorts finds a hub outside the swept range', async () => {
      // The desktop app's sidecar binds an OS-assigned port, outside the block.
      // The CLI reads that port from `settings.server_port` and passes it here —
      // without this, the app's hub is missing from `hub ls`.
      const port = await fakeHub({ ...HUB_A, name: 'app' })
      const swept = await discoverHubs({ range: { start: 1, end: 1 } })
      assertEq(swept.length, 0, 'not in the range')
      const withExtra = await discoverHubs({ range: { start: 1, end: 1 }, extraPorts: [port] })
      assertEq(withExtra.length, 1, 'found via extraPorts')
      assertEq(withExtra[0]?.name, 'app', 'the right hub')
    })

    await test('an extraPort already inside the range is not probed twice', async () => {
      const port = await fakeHub({ ...HUB_A, name: 'dedup' })
      const hubs = await discoverHubs({ range: { start: port, end: port }, extraPorts: [port] })
      assertEq(hubs.length, 1, 'listed once, not twice')
    })

    await test('a dead extraPort is harmless', async () => {
      // Stale `settings.server_port` (the app has since quit) must not error.
      const port = await deadPort()
      const hubs = await discoverHubs({ range: { start: 1, end: 1 }, extraPorts: [port] })
      assertEq(hubs.length, 0, 'no phantom row')
    })

    await test('findHub by name searches extraPorts too', async () => {
      const port = await fakeHub({ ...HUB_A, name: 'app' })
      const found = await findHub('app', { range: { start: 1, end: 1 }, extraPorts: [port] })
      assertEq(found?.name, 'app', 'name lookup covers extraPorts')
    })

    await test('findHub resolves by name', async () => {
      const port = await fakeHub({ ...HUB_A, name: 'staging' })
      const found = await findHub('staging', { range: { start: port, end: port } })
      assertEq(found?.name, 'staging', 'matched by name')
      const missing = await findHub('nope', { range: { start: port, end: port } })
      assertEq(missing, null, 'unknown name → null')
    })

    await test('findHub resolves by port number', async () => {
      const port = await fakeHub({ ...HUB_A, name: 'byport' })
      const found = await findHub(String(port), { range: { start: port, end: port } })
      assertEq(found?.name, 'byport', 'matched by port string')
    })

    await test('findHub by port probes that port even outside the range', async () => {
      // `slay --hub 51999` must work for an explicitly-configured hub that the
      // block scan would never reach.
      const port = await fakeHub({ ...HUB_A, name: 'out-of-block' })
      const found = await findHub(String(port), { range: { start: 1, end: 1 } })
      assertEq(found?.name, 'out-of-block', 'direct port probe, no range dependency')
    })

    await test('a large range completes promptly (concurrency, not serial)', async () => {
      // 200 mostly-dead ports at 300ms each would be a minute serially. The scan
      // must overlap probes or `hub ls` is unusable.
      const port = await fakeHub(HUB_A)
      const started = Date.now()
      const hubs = await discoverHubs({ range: { start: port, end: port + 199 }, timeoutMs: 300 })
      const elapsed = Date.now() - started
      assert(hubs.length >= 1, 'still found the real hub')
      assert(elapsed < 10_000, `200-port sweep took ${elapsed}ms`)
    })
  } finally {
    for (const c of cleanups) await c()
  }

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

void main()
