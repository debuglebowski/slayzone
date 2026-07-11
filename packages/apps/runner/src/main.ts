/**
 * Runner main — wires config + credential store + hub dialer into a running
 * exec node. Wave-1 skeleton: the transport, enrollment, heartbeats, and
 * reconnect logic are fully live, while every exec command (pty.*, fs.*,
 * git.*) answers `-32001 unimplemented`. `runner.shutdown` performs a
 * graceful stop.
 *
 * @module runner/main
 */

import {
  createFileCredentialStore,
  HubDialer,
  hubHostFromUrl,
  type RunnerCredentialStore
} from '@slayzone/fleet/client'
import { FleetErrorCodes, HubToRunnerMethods, RpcError, runnerShutdownParamsSchema } from '@slayzone/fleet/shared'
import type { RunnerConfig } from './config'

/** Version advertised at enrollment; wave-1 skeleton is pre-release. */
export const RUNNER_VERSION = '0.0.0'

export interface RunnerRuntimeDeps {
  log?: (message: string, meta?: Record<string, unknown>) => void
  /** Invoked after a graceful `runner.shutdown` stop completes. */
  onShutdown?: (reason: string) => void
  /** Override the credential store (tests). */
  credentialStore?: RunnerCredentialStore
}

export interface RunnerHandle {
  dialer: HubDialer
  stop(): Promise<void>
}

/**
 * Hub-request dispatcher for the wave-1 skeleton: `runner.shutdown` triggers
 * `shutdown(reason)` (after acking), everything else is unimplemented.
 */
export function createHubRequestHandler(
  shutdown: (reason: string) => void
): (method: string, params: unknown) => Promise<unknown> {
  return async (method, params) => {
    if (method === HubToRunnerMethods.runnerShutdown) {
      const parsed = runnerShutdownParamsSchema.safeParse(params ?? {})
      const reason = parsed.success ? (parsed.data.reason ?? 'hub-requested') : 'hub-requested'
      // Ack first; the dialer flushes the response before the socket drops.
      queueMicrotask(() => shutdown(reason))
      return { ok: true }
    }
    throw new RpcError(FleetErrorCodes.unimplemented, `unimplemented: ${method}`)
  }
}

export function startRunner(config: RunnerConfig, deps: RunnerRuntimeDeps = {}): RunnerHandle {
  const log = deps.log ?? (() => {})
  const credentialStore =
    deps.credentialStore ??
    createFileCredentialStore(hubHostFromUrl(config.hubUrl), {
      ...(config.credentialsDir ? { baseDir: config.credentialsDir } : {})
    })

  let handle: RunnerHandle
  const dialer = new HubDialer({
    url: config.hubUrl,
    identity: {
      name: config.name,
      platform: `${process.platform}-${process.arch}`,
      version: RUNNER_VERSION,
      capabilities: config.capabilities
    },
    credentialStore,
    ...(config.joinToken ? { joinToken: config.joinToken } : {}),
    ...(config.pinnedCertSha256 ? { pinnedCertSha256: config.pinnedCertSha256 } : {}),
    ...(config.heartbeatIntervalMs ? { heartbeatIntervalMs: config.heartbeatIntervalMs } : {}),
    onHubRequest: createHubRequestHandler((reason) => {
      log('runner shutdown requested by hub', { reason })
      void handle.stop().then(() => deps.onShutdown?.(reason))
    }),
    log
  })

  dialer.events.on('connected', ({ runnerId, mode }) => log('connected to hub', { runnerId, mode }))
  dialer.events.on('disconnected', ({ reason }) => log('disconnected from hub', { reason }))
  dialer.events.on('reconnect-scheduled', ({ attempt, delayMs }) =>
    log('reconnect scheduled', { attempt, delayMs })
  )
  dialer.events.on('error', ({ error, fatal }) => log(fatal ? 'fatal error' : 'error', { error: error.message, fatal }))

  dialer.start()
  handle = {
    dialer,
    stop: () => dialer.stop()
  }
  return handle
}
