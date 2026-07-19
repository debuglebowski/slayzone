/**
 * Runner `/runners` TLS listener bind + graceful degradation (Wave3.5-D2).
 *
 * The runner WS runs on a SEPARATE https listener (TLS-terminated with the hub
 * identity leaf) on its OWN port — never the shared http server that carries
 * `/trpc` + `/health` + `/mcp` + REST. Runner is OPT-IN, so a runner-port conflict
 * must NEVER take down the core app: if the bind fails (EADDRINUSE, EACCES, …),
 * this closes the runner listener, records the failure, and returns `null` — the
 * shared http server keeps serving the renderer/CLI, and the runner path simply
 * stays dark (no listener ⇒ `mintJoinToken` throws a clear "hub url unset" until
 * the next restart) rather than crashing the process.
 *
 * Kept as its own module so the bind + degradation decision is unit-testable
 * without the full `startServer` boot (composeServer → better-auth migrations).
 *
 * @module server/runner-listener
 */
import type { Server as HttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'

export interface RunnerListenerInfo {
  /** `wss://host:port/runners` — fed to `mintJoinToken`. */
  hubUrl: string
  /** Lowercase-hex sha256 of the hub leaf cert (the pin). */
  certFingerprint: string
  /** The actually-bound port (OS-assigned when no valid override). */
  port: number
}

export interface StartRunnerListenerOptions {
  /** The https server (already constructed with the hub identity key/cert). */
  server: HttpsServer
  /** Interface to BIND on (`0.0.0.0` = reachable off-machine). */
  host: string
  /** Host to ADVERTISE in the minted join token's `wss://…` URL. Distinct from
   *  `host`: binding `0.0.0.0` is not a dialable address, so the token must carry
   *  a real host (loopback for the co-located runner; operators override the
   *  public host via SLAYZONE_HUB_PUBLIC_URL for remote runners). Defaults to
   *  `host` when the bind host is already dialable. */
  advertiseHost?: string
  /** The hub leaf fingerprint to advertise + pin. */
  fingerprintSha256Hex: string
  /** `SLAYZONE_HUB_RUNNER_TRANSPORT_PORT` raw value; invalid/empty ⇒ OS-assigned (port 0). */
  runnerPortEnv?: string
  log?: (message: string, meta?: Record<string, unknown>) => void
  /** Invoked once on a bind failure (e.g. to record a diagnostics event). */
  onBindFailure?: (error: Error) => void
}

/** Resolve the requested runner port: a valid `SLAYZONE_HUB_RUNNER_TRANSPORT_PORT`, else 0. */
export function resolveRunnerPort(raw: string | undefined): number {
  const n = raw ? Number(raw) : undefined
  return n !== undefined && Number.isInteger(n) && n >= 0 && n <= 65535 ? n : 0
}

/**
 * Bind the runner https listener. Returns the listener info on success, or `null`
 * on a bind failure (having closed the passed server) — never rejects for a bind
 * error, so a runner-port conflict cannot bubble out of `startServer` and abort
 * the already-live shared http server.
 */
export async function startRunnerListener(
  opts: StartRunnerListenerOptions
): Promise<RunnerListenerInfo | null> {
  const log = opts.log ?? (() => {})
  const port = resolveRunnerPort(opts.runnerPortEnv)
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
    log('runner listener bind failed — runner path stays dark; core server unaffected', {
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
  // Advertise a DIALABLE host in the token — never the `0.0.0.0` wildcard we bind.
  const advertiseHost =
    opts.advertiseHost ?? (host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host)
  return {
    hubUrl: `wss://${advertiseHost}:${actualPort}/runners`,
    certFingerprint: opts.fingerprintSha256Hex,
    port: actualPort
  }
}
