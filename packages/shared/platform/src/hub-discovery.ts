/**
 * Multi-hub discovery — find every SlayZone hub running on this machine.
 *
 * WHY A PORT PROBE. Several hubs can run side by side (one per project/root), and
 * `slay hub ls|stop|logs|--hub` has to address them. The mechanism is a parallel
 * `GET /health` sweep of {@link HUB_PORT_BLOCK} on loopback, keeping whatever
 * answers with a hub-shaped body. Deliberately NOT:
 *   - a pidfile or registry file — both go stale (a dead process leaves a
 *     live-looking file), and a machine-scoped registry would also contradict the
 *     rule that standalone state lives under the hub's own ROOT;
 *   - a process scan (`/proc/<pid>/cwd`, `lsof`, `tasklist`) — one code path per
 *     OS, and blind to containers.
 * A bound TCP port cannot go stale: a dead hub's port stops answering, full stop.
 * The sweep also finds hubs this CLI never started — systemd units, docker
 * port-publishes, another user's hub, the desktop app's own supervised sidecar.
 *
 * KNOWN LIMITS (both explicitly-configured deployments, addressable via
 * `slay hub use <url>` / `--hub <port>`): a hub bound to a single non-loopback
 * interface is not reachable on 127.0.0.1, and a hub on a port outside the block
 * is not swept.
 *
 * Lean leaf (only ./paths + node builtins) so the CLI bundle can import
 * `@slayzone/platform/hub-discovery` WITHOUT the platform barrel (which pulls the
 * better-sqlite3 graph).
 *
 * @module platform/hub-discovery
 */

import http from 'node:http'
import { HUB_PORT_BLOCK } from './paths'

/** Default per-port probe budget. Matches port-claim.ts's liveness check: a
 *  loopback hub answers in single-digit ms, so 300ms is generous. */
const DEFAULT_TIMEOUT_MS = 300

/** Default in-flight probe count. Keeps a 100-port sweep sub-second without
 *  opening a socket per port at once. */
const DEFAULT_CONCURRENCY = 32

/** A live hub found on this machine. Mirrors the loopback fields of `/health`. */
export interface DiscoveredHub {
  /** Operator-facing name (`SLAYZONE_HUB_NAME` / config `hubName` / ROOT name). */
  name: string
  /** The port we actually reached it on — NOT the port the body self-reports.
   *  Behind a port-forward those differ, and every later action (stop, --hub)
   *  must use the one that answers. */
  port: number
  /** The hub process's pid, for signalling without a pidfile. */
  pid: number
  /** SLAYZONE_ROOT anchor — config, storage and logs all derive from it. */
  root: string
  dbPath: string
  /** SLAYZONE_MODE: `local` or `remote`. */
  mode: string
  /** True for the desktop app's sidecar. `slay hub stop` refuses these — the app
   *  owns its own lifecycle. */
  supervised: boolean
  runnersConnected: number
  uptimeMs: number
  commit: string
  builtAt: string
  buildId: string
}

export interface DiscoverOptions {
  /** Port range to sweep. Defaults to {@link HUB_PORT_BLOCK}. */
  range?: { start: number; end: number }
  /**
   * Extra ports to probe alongside the range — for hubs the block sweep cannot
   * find because they bind outside it. The caller supplies these from whatever
   * out-of-band knowledge it has; the desktop app's sidecar, for instance, takes
   * an OS-assigned port and publishes it to `settings.server_port`, which the CLI
   * reads. Duplicates of range ports are ignored.
   */
  extraPorts?: number[]
  /** Per-port probe timeout in ms. Default 300. */
  timeoutMs?: number
  /** Max concurrent probes. Default 32. */
  concurrency?: number
  /** Host to probe. Default 127.0.0.1 — discovery is deliberately local-only. */
  host?: string
}

/**
 * Probe one port for a hub. Resolves null for every non-hub outcome (closed
 * port, timeout, wrong service, hub still starting, identity withheld) — a
 * discovery sweep must never fail as a whole because one port misbehaved.
 */
function probe(host: string, port: number, timeoutMs: number): Promise<DiscoveredHub | null> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: DiscoveredHub | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }

    const req = http.get({ host, port, path: '/health', timeout: timeoutMs }, (res) => {
      // A starting hub answers 503; anything non-200 is not a listable hub.
      if (res.statusCode !== 200) {
        res.resume()
        done(null)
        return
      }
      const chunks: Buffer[] = []
      let bytes = 0
      res.on('data', (c: Buffer) => {
        // Cap the read: a non-SlayZone service on a hub port could stream
        // unbounded data at us.
        bytes += c.length
        if (bytes > 64 * 1024) {
          req.destroy()
          done(null)
          return
        }
        chunks.push(c)
      })
      res.on('end', () => done(parseHub(Buffer.concat(chunks).toString('utf8'), port)))
      res.on('error', () => done(null))
    })
    req.on('error', () => done(null))
    // `timeout` only fires on socket inactivity — a port that accepts and then
    // says nothing lands here, which is why the option is set at all.
    req.on('timeout', () => {
      req.destroy()
      done(null)
    })
  })
}

/**
 * Map a `/health` body to a hub row, or null when it isn't one.
 *
 * Requires the loopback identity fields (name/root/pid): without them there is
 * nothing to display or address, so the row would be useless. That also filters
 * out unrelated services whose `/health` happens to return `{ok:true}`.
 */
function parseHub(body: string, port: number): DiscoveredHub | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const b = parsed as Record<string, unknown>
  if (b.ok !== true) return null
  if (typeof b.name !== 'string' || b.name.length === 0) return null
  if (typeof b.root !== 'string' || b.root.length === 0) return null
  if (typeof b.pid !== 'number') return null
  return {
    name: b.name,
    port,
    pid: b.pid,
    root: b.root,
    dbPath: typeof b.dbPath === 'string' ? b.dbPath : '',
    mode: typeof b.mode === 'string' ? b.mode : 'local',
    supervised: b.supervised === true,
    runnersConnected: typeof b.runnersConnected === 'number' ? b.runnersConnected : 0,
    uptimeMs: typeof b.uptimeMs === 'number' ? b.uptimeMs : 0,
    commit: typeof b.commit === 'string' ? b.commit : 'unknown',
    builtAt: typeof b.builtAt === 'string' ? b.builtAt : 'unknown',
    buildId: typeof b.buildId === 'string' ? b.buildId : 'unknown'
  }
}

/**
 * Every live hub on this machine, ascending by port.
 *
 * Sweeps with a bounded worker pool rather than one probe per port at once: 100
 * simultaneous sockets is needless pressure, and serial probing would take
 * `ports × timeout` (half a minute) instead of well under a second.
 */
export async function discoverHubs(opts: DiscoverOptions = {}): Promise<DiscoveredHub[]> {
  const range = opts.range ?? HUB_PORT_BLOCK
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const host = opts.host ?? '127.0.0.1'
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY)

  const ports: number[] = []
  for (let p = range.start; p <= range.end; p++) ports.push(p)
  for (const extra of opts.extraPorts ?? []) {
    if (extra >= 1 && extra <= 65535 && (extra < range.start || extra > range.end)) {
      ports.push(extra)
    }
  }

  const found: DiscoveredHub[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++
      if (index >= ports.length) return
      const hub = await probe(host, ports[index]!, timeoutMs)
      if (hub) found.push(hub)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ports.length) }, () => worker()))

  // Deterministic order — the worker pool finishes out of order.
  return found.sort((a, b) => a.port - b.port)
}

/**
 * Resolve a hub by name or port, or null when nothing matches.
 *
 * An all-digits argument is probed DIRECTLY as a port rather than looked up in a
 * sweep, so `--hub 51999` reaches a hub outside the block (an explicitly
 * configured deployment the sweep would never see). A name argument needs the
 * sweep — that is the only way to learn which port carries which name.
 */
export async function findHub(
  nameOrPort: string,
  opts: DiscoverOptions = {}
): Promise<DiscoveredHub | null> {
  const trimmed = nameOrPort.trim()
  if (/^\d+$/.test(trimmed)) {
    const port = Number(trimmed)
    if (port < 1 || port > 65535) return null
    return probe(opts.host ?? '127.0.0.1', port, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  }
  const hubs = await discoverHubs(opts)
  return hubs.find((h) => h.name === trimmed) ?? null
}
