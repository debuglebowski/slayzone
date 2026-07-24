/**
 * Runner main — wires config + credential store + hub dialer into a running
 * exec node. The transport, enrollment, heartbeats, and reconnect logic live in
 * `@slayzone/runner-transport`; this module owns the hub→runner request DISPATCH TABLE that
 * routes each method to its exec handler (pty.*, git.*, fs.*, proc.*), plus a
 * graceful `runner.shutdown`. Unknown methods answer `-32001 unimplemented`.
 *
 * @module runner/main
 */

import {
  createFileCredentialStore,
  HubDialer,
  hubHostFromUrl,
  type RunnerCredentialStore
} from '@slayzone/runner-transport/client'
import { RunnerTransportErrorCodes, HubToRunnerMethods, RpcError, runnerShutdownParamsSchema } from '@slayzone/runner-transport/shared'
import type { RunnerConfig } from './config'
import { type AgentHookServer, createAgentHookServer } from './handlers/agent-hook'
import { createFsHandlers } from './handlers/fs'
import { createGitHandlers } from './handlers/git'
import { createProcHandlers } from './handlers/proc'
import { createPtyHandlers } from './handlers/pty'
import type { HandlerContext, HubMethodTable, RunnerDialer, RunnerLog } from './handlers/types'

/** Version advertised at enrollment; wave-1 skeleton is pre-release. */
export const RUNNER_VERSION = '0.0.0'

export interface RunnerRuntimeDeps {
  log?: RunnerLog
  /** Invoked after a graceful `runner.shutdown` stop completes. */
  onShutdown?: (reason: string) => void
  /** Override the credential store (tests). */
  credentialStore?: RunnerCredentialStore
}

export interface RunnerHandle {
  dialer: HubDialer
  stop(): Promise<void>
}

export interface HubRequestHandlerDeps {
  /** Trigger a graceful stop (after the ack flushes). */
  shutdown: (reason: string) => void
  /** Dialer used by streaming handlers (pty.data/exit, proc.data/exit, …). */
  dialer: RunnerDialer
  config: RunnerConfig
  log?: RunnerLog
  /** Runner loopback agent-hook URL — overlaid into every spawned agent's env
   *  (see HandlerContext.agentHookUrl). Absent → env passthrough (tests). */
  agentHookUrl?: string
}

export interface HubRequestDispatch {
  /** Route one hub→runner request to its handler. */
  handle(method: string, params: unknown): Promise<unknown>
  /** Tear down live sessions/processes (runner shutdown). */
  dispose(): void
  /** Late-bind the runner loopback agent-hook URL once its listener has bound
   *  (the port is ephemeral, resolved async after the dispatch is built). The
   *  ctx is shared by reference, so pty spawns issued after this see the URL. */
  setAgentHookUrl(url: string): void
}

/**
 * Build the hub→runner dispatch table. `runner.shutdown` acks then triggers the
 * graceful stop; pty/git/fs/proc methods route to their handler modules;
 * everything else throws `-32001 unimplemented`.
 */
export function createHubRequestHandler(deps: HubRequestHandlerDeps): HubRequestDispatch {
  const log = deps.log ?? (() => {})
  const ctx: HandlerContext = {
    dialer: deps.dialer,
    config: deps.config,
    log,
    ...(deps.agentHookUrl ? { agentHookUrl: deps.agentHookUrl } : {})
  }

  const pty = createPtyHandlers(ctx)
  const proc = createProcHandlers(ctx)

  const shutdownHandler = async (params: unknown): Promise<{ ok: true }> => {
    const parsed = runnerShutdownParamsSchema.safeParse(params ?? {})
    const reason = parsed.success ? (parsed.data.reason ?? 'hub-requested') : 'hub-requested'
    // Ack first; the dialer flushes the response before the socket drops.
    queueMicrotask(() => deps.shutdown(reason))
    return { ok: true }
  }

  const table: HubMethodTable = {
    [HubToRunnerMethods.runnerShutdown]: shutdownHandler,
    ...pty.handlers,
    ...proc.handlers,
    ...createGitHandlers(ctx),
    ...createFsHandlers(ctx)
  }

  const handle = async (method: string, params: unknown): Promise<unknown> => {
    const entry = table[method]
    if (!entry) {
      throw new RpcError(RunnerTransportErrorCodes.unimplemented, `unimplemented: ${method}`)
    }
    return entry(params)
  }

  const dispose = (): void => {
    pty.disposeAll()
    proc.disposeAll()
  }

  const setAgentHookUrl = (url: string): void => {
    ctx.agentHookUrl = url
  }

  return { handle, dispose, setAgentHookUrl }
}

export function startRunner(config: RunnerConfig, deps: RunnerRuntimeDeps = {}): RunnerHandle {
  const log = deps.log ?? (() => {})
  // Creds always derive from the ROOT anchor (`<ROOT>/runners`, see
  // credential-store slayzoneRootDir) — no override knob. Tests inject a store
  // via deps.credentialStore.
  const credentialStore =
    deps.credentialStore ?? createFileCredentialStore(hubHostFromUrl(config.hubUrl))

  // The dialer THROWS if a pin is set on a `ws://` url (pinning is meaningless
  // without TLS). An EXPLICITLY-configured pin (env/file) on a ws:// url already
  // fails loudly in loadRunnerConfig — so any pin reaching here on a ws:// url can
  // only be the join-token-DECODED fingerprint (the auto path). Softly drop it so a
  // ws token stays usable for loopback/dev; the real runner path is wss:// (the hub's
  // /runners listener is https), where the pin is fed through and enforced.
  const isSecureUrl = (() => {
    try {
      return new URL(config.hubUrl).protocol === 'wss:'
    } catch {
      return false
    }
  })()
  const pinnedCertSha256 =
    config.pinnedCertSha256 && isSecureUrl ? config.pinnedCertSha256 : undefined
  if (config.pinnedCertSha256 && !isSecureUrl) {
    log('ignoring token-decoded cert fingerprint on a non-wss hub url (pinning requires wss://)', {
      hubUrl: config.hubUrl
    })
  }

  let handle: RunnerHandle
  let dispatch: HubRequestDispatch
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
    ...(pinnedCertSha256 ? { pinnedCertSha256 } : {}),
    onHubRequest: (method, params) => dispatch.handle(method, params),
    log
  })

  dispatch = createHubRequestHandler({
    shutdown: (reason) => {
      log('runner shutdown requested by hub', { reason })
      void handle.stop().then(() => deps.onShutdown?.(reason))
    },
    dialer,
    config,
    log
  })

  dialer.events.on('connected', ({ runnerId, mode }) => log('connected to hub', { runnerId, mode }))
  dialer.events.on('disconnected', ({ reason }) => log('disconnected from hub', { reason }))
  dialer.events.on('reconnect-scheduled', ({ attempt, delayMs }) =>
    log('reconnect scheduled', { attempt, delayMs })
  )
  dialer.events.on('error', ({ error, fatal }) => log(fatal ? 'fatal error' : 'error', { error: error.message, fatal }))

  // Agent-hook loopback relay (hub/runner split): host /api/agent-hook on the
  // runner's own loopback and forward each envelope to the hub over the existing
  // authed ws channel. Its ephemeral port binds async; feed the URL into the
  // dispatch (shared ctx) so ptys spawned after the bind overlay it into the
  // agent env. Best-effort — a bind failure only means remote hooks fall back to
  // whatever URL the hub baked in (degraded, not fatal to exec).
  let agentHookServer: AgentHookServer | null = null
  void createAgentHookServer({ dialer, config, log })
    .then((srv) => {
      agentHookServer = srv
      dispatch.setAgentHookUrl(srv.url)
    })
    .catch((err) => log('agent-hook relay failed to start', { error: String(err) }))

  dialer.start()
  handle = {
    dialer,
    stop: async () => {
      // Kill live ptys/processes before the socket drops so nothing is orphaned.
      dispatch.dispose()
      if (agentHookServer) await agentHookServer.close()
      await dialer.stop()
    }
  }
  return handle
}
