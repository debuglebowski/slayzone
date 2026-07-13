/**
 * Fleet `/fleet` TLS listener bind + graceful degradation (Wave3.5-D2).
 *
 * The fleet WS runs on a SEPARATE https listener (TLS-terminated with the hub
 * identity leaf) on its OWN port — never the shared http server that carries
 * `/trpc` + `/health` + `/mcp` + REST. Fleet is OPT-IN, so a fleet-port conflict
 * must NEVER take down the core app: if the bind fails (EADDRINUSE, EACCES, …),
 * this closes the fleet listener, records the failure, and returns `null` — the
 * shared http server keeps serving the renderer/CLI, and the fleet path simply
 * stays dark (no listener ⇒ `mintJoinToken` throws a clear "hub url unset" until
 * the next restart) rather than crashing the process.
 *
 * Kept as its own module so the bind + degradation decision is unit-testable
 * without the full `startServer` boot (composeServer → better-auth migrations).
 *
 * @module server/fleet-listener
 */
import type { Server as HttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'

export interface FleetListenerInfo {
  /** `wss://host:port/fleet` — fed to `mintJoinToken`. */
  hubUrl: string
  /** Lowercase-hex sha256 of the hub leaf cert (the pin). */
  certFingerprint: string
  /** The actually-bound port (OS-assigned when no valid override). */
  port: number
}

export interface StartFleetListenerOptions {
  /** The https server (already constructed with the hub identity key/cert). */
  server: HttpsServer
  /** Host to bind (matches the shared server's host — 127.0.0.1 by default). */
  host: string
  /** The hub leaf fingerprint to advertise + pin. */
  fingerprintSha256Hex: string
  /** `SLAYZONE_FLEET_PORT` raw value; invalid/empty ⇒ OS-assigned (port 0). */
  fleetPortEnv?: string
  log?: (message: string, meta?: Record<string, unknown>) => void
  /** Invoked once on a bind failure (e.g. to record a diagnostics event). */
  onBindFailure?: (error: Error) => void
}

/** Resolve the requested fleet port: a valid `SLAYZONE_FLEET_PORT`, else 0. */
export function resolveFleetPort(raw: string | undefined): number {
  const n = raw ? Number(raw) : undefined
  return n !== undefined && Number.isInteger(n) && n >= 0 && n <= 65535 ? n : 0
}

/**
 * Bind the fleet https listener. Returns the listener info on success, or `null`
 * on a bind failure (having closed the passed server) — never rejects for a bind
 * error, so a fleet-port conflict cannot bubble out of `startServer` and abort
 * the already-live shared http server.
 */
export async function startFleetListener(
  opts: StartFleetListenerOptions
): Promise<FleetListenerInfo | null> {
  const log = opts.log ?? (() => {})
  const port = resolveFleetPort(opts.fleetPortEnv)
  const { server, host } = opts
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: unknown): void => {
        server.off('error', onError)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
      server.once('error', onError)
      server.listen(port, host, () => {
        server.off('error', onError)
        resolve()
      })
    })
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err))
    log('fleet listener bind failed — fleet path stays dark; core server unaffected', {
      error: error.message,
      requestedPort: port
    })
    opts.onBindFailure?.(error)
    // Release anything the failed listen may have half-opened. Closing a server
    // that never bound is a harmless no-op; ignore any close error.
    try {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    } catch {
      /* ignore */
    }
    return null
  }
  const addr = server.address()
  const actualPort = typeof addr === 'object' && addr ? (addr as AddressInfo).port : port
  return {
    hubUrl: `wss://${host}:${actualPort}/fleet`,
    certFingerprint: opts.fingerprintSha256Hex,
    port: actualPort
  }
}
