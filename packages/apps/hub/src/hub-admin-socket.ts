/**
 * The hub's local admin channel: a unix socket at `<ROOT>/run/hub-admin.sock` that only
 * the hub's OS user (and root) can open. It carries the break-glass operator commands
 * (`slayzone-hub break-glass open|end|status`, break-glass-command.ts) to the RUNNING hub
 * (break-glass.ts) — no restart, no env change.
 *
 * WHY A UNIX SOCKET, NOT LOOPBACK + A NONCE FILE. The authority is the file system: the
 * socket is 0600 inside a 0700 directory owned by the hub's user, so the kernel refuses
 * everyone else before a byte is read. Nothing secret is generated or written, and
 * nothing a reverse proxy forwards can reach it — a same-box proxy turns every TCP
 * request into a loopback one, the trap rest-auth.ts documents. Loopback + nonce would
 * need a secret in a file (what T-11 forbids on a reachable hub) and would listen where
 * every local process can knock. Whoever can open this socket runs as the hub's user or
 * root, and so already holds the hub's database and auth secret: it grants nothing new.
 *
 * Login-required hubs only (server.ts); the desktop app's hub never starts it.
 *
 * PROTOCOL: one request per connection, one JSON line each way (≤ 8 KiB, 5 s).
 *   → { v: 1, op: 'open', challenge, ttlMs?, by }   ← { ok: true, ref, grantExpiresAt, ttlMs, replaced } | { ok: false, code, error }
 *   → { v: 1, op: 'end', by }                       ← { ok: true, ended: { grant, session } }
 *   → { v: 1, op: 'status' }                        ← { ok: true, status }
 * `by` is the client's own report of its OS identity (break-glass.ts `BreakGlassOperator`).
 *
 * @module hub/hub-admin-socket
 */
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import type { BreakGlass, BreakGlassOperator } from './break-glass.js'

/** Unix socket paths are capped near 104 bytes (macOS) / 108 (Linux). */
const MAX_SOCKET_PATH = 100
const MAX_FRAME_BYTES = 8 * 1024
const SERVER_TIMEOUT_MS = 5_000

export const HUB_ADMIN_SOCKET_PROTOCOL = 1

export type HubAdminRequest =
  | { v: 1; op: 'open'; challenge: string; ttlMs?: number; by: BreakGlassOperator }
  | { v: 1; op: 'end'; by: BreakGlassOperator }
  | { v: 1; op: 'status' }

/**
 * `<root>/run/hub-admin.sock`, or null where it cannot exist: Windows (no unix socket at
 * a path), or a root deep enough to break the path cap — then the hub logs that
 * break-glass is unavailable instead of falling back to a directory another user could
 * have prepared.
 */
export function resolveHubAdminSocketPath(root: string): string | null {
  if (process.platform === 'win32') return null
  const path = join(root, 'run', 'hub-admin.sock')
  return Buffer.byteLength(path) <= MAX_SOCKET_PATH ? path : null
}

const shortString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : null

/** The `by` field, cleaned: strings ≤ 64 chars or null, uid an integer or null. */
export function readOperator(value: unknown): BreakGlassOperator {
  const by = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    osUser: shortString(by.osUser),
    uid: Number.isInteger(by.uid) ? (by.uid as number) : null,
    sudoUser: shortString(by.sudoUser)
  }
}

/** Run one request against the break-glass state. Never throws. */
export async function dispatchHubAdminRequest(
  breakGlass: BreakGlass,
  request: unknown
): Promise<Record<string, unknown>> {
  const req = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>
  if (req.v !== HUB_ADMIN_SOCKET_PROTOCOL) {
    return { ok: false, code: 'protocol', error: `unsupported protocol version ${String(req.v)}` }
  }
  try {
    switch (req.op) {
      case 'open':
        return {
          ...(await breakGlass.grant({
            challenge: req.challenge,
            ...(req.ttlMs === undefined ? {} : { ttlMs: req.ttlMs }),
            by: readOperator(req.by)
          }))
        }
      case 'end':
        return { ok: true, ended: await breakGlass.end('ended', readOperator(req.by)) }
      case 'status':
        return { ok: true, status: breakGlass.status() }
      default:
        return { ok: false, code: 'unknown_op', error: `unknown op ${String(req.op)}` }
    }
  } catch (err) {
    return { ok: false, code: 'failed', error: err instanceof Error ? err.message : String(err) }
  }
}

export interface HubAdminSocket {
  socketPath: string
  close: () => Promise<void>
}

/**
 * Listen on `socketPath`. Refuses (null, logged) when the directory is not this user's
 * own 0700 directory or the path holds something other than a stale socket — it never
 * deletes a file it did not make.
 */
export async function startHubAdminSocket(opts: {
  socketPath: string
  breakGlass: BreakGlass
  log?: (message: string) => void
}): Promise<HubAdminSocket | null> {
  const log =
    opts.log ??
    ((): void => {
      // Opt-in, like the sidecar socket.
    })
  const { socketPath } = opts
  const dir = dirname(socketPath)
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    const info = lstatSync(dir)
    const uid = process.getuid?.()
    if (!info.isDirectory() || (uid !== undefined && info.uid !== uid)) {
      log(`[slayzone] break-glass unavailable: ${dir} is not this user's own directory`)
      return null
    }
    const existing = lstatSync(socketPath, { throwIfNoEntry: false })
    if (existing) {
      if (!existing.isSocket()) {
        log(`[slayzone] break-glass unavailable: ${socketPath} exists and is not a socket`)
        return null
      }
      // A stale socket from a run that crashed.
      unlinkSync(socketPath)
    }
  } catch (err) {
    log(
      `[slayzone] break-glass unavailable: cannot prepare ${socketPath}: ${err instanceof Error ? err.message : String(err)}`
    )
    return null
  }

  const sockets = new Set<Socket>()
  const handle = (socket: Socket): void => {
    sockets.add(socket)
    socket.setTimeout(SERVER_TIMEOUT_MS, () => socket.destroy())
    let buffer = ''
    let answered = false
    socket.on('data', (chunk) => {
      if (answered) return
      buffer += chunk.toString('utf8')
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
        socket.destroy()
        return
      }
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      answered = true
      let request: unknown = null
      try {
        request = JSON.parse(buffer.slice(0, newline))
      } catch {
        request = null
      }
      void dispatchHubAdminRequest(opts.breakGlass, request).then((reply) => {
        socket.end(`${JSON.stringify(reply)}\n`)
      })
    })
    socket.on('error', () => {
      // Peer gone; cleanup on 'close'.
    })
    socket.on('close', () => sockets.delete(socket))
  }

  const server: Server = createServer(handle)
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        server.off('error', reject)
        resolve()
      })
    })
    // Owner only. The 0700 directory already keeps everyone else out; this is the
    // second line if that directory is ever widened.
    chmodSync(socketPath, 0o600)
  } catch (err) {
    log(
      `[slayzone] break-glass unavailable: cannot listen on ${socketPath}: ${err instanceof Error ? err.message : String(err)}`
    )
    server.close()
    return null
  }
  server.on('error', (err) => log(`[slayzone] hub admin socket error: ${String(err)}`))
  log(`[slayzone] break-glass channel listening at ${socketPath}`)

  return {
    socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy()
        sockets.clear()
        server.close(() => {
          try {
            const left = lstatSync(socketPath, { throwIfNoEntry: false })
            if (left?.isSocket()) unlinkSync(socketPath)
          } catch {
            /* already gone */
          }
          resolve()
        })
      })
  }
}

/** Send one request and read the reply (the client half, break-glass-command.ts). */
export function callHubAdminSocket(
  socketPath: string,
  request: HubAdminRequest,
  timeoutMs = 10_000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`no answer from ${socketPath} within ${timeoutMs / 1000}s`))
    }, timeoutMs)
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
    })
    socket.on('end', () => {
      clearTimeout(timer)
      try {
        const reply = JSON.parse(buffer.trim()) as unknown
        if (reply && typeof reply === 'object') resolve(reply as Record<string, unknown>)
        else reject(new Error('malformed reply'))
      } catch {
        reject(new Error('malformed reply'))
      }
    })
    socket.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}
