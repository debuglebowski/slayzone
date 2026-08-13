/**
 * Computer main — wires config + credential store + hub dialer into a running
 * exec node. The transport, enrollment, heartbeats, and reconnect logic live in
 * `@slayzone/computer-transport`; this module owns the hub→computer request DISPATCH TABLE that
 * routes each method to its exec handler (pty.*, git.*, fs.*, proc.*), plus a
 * graceful `computer.shutdown`. Unknown methods answer `-32001 unimplemented`.
 *
 * @module computer/main
 */

import {
  createFileCredentialStore,
  HubDialer,
  hubHostFromUrl,
  type ComputerCredentialStore,
  type ComputerIdentity
} from '@slayzone/computer-transport/client'
import {
  ComputerTransportErrorCodes,
  HubToComputerMethods,
  RpcError,
  computerShutdownParamsSchema
} from '@slayzone/computer-transport/shared'
import type { ComputerConfig } from './config'
import { startHostIdReconciler } from './host-id'
import { type AgentHookServer, createAgentHookServer } from './handlers/agent-hook'
import { createFsHandlers } from './handlers/fs'
import { createGhHandlers } from './handlers/gh'
import { createGitHandlers } from './handlers/git'
import { createProcHandlers } from './handlers/proc'
import { createProjectHandlers } from './handlers/project'
import { createPtyHandlers } from './handlers/pty'
import { createComputerConfigHandlers } from './handlers/computer-config'
import { createProjectPathStore, type ProjectPathStore } from './project-paths'
import type { HandlerContext, HubMethodTable, ComputerDialer, ComputerLog } from './handlers/types'

/** Version advertised at enrollment; wave-1 skeleton is pre-release. */
export const RUNNER_VERSION = '0.0.0'

export interface ComputerRuntimeDeps {
  log?: ComputerLog
  /** Invoked after a graceful `computer.shutdown` stop completes. */
  onShutdown?: (reason: string) => void
  /** Override the credential store (tests). */
  credentialStore?: ComputerCredentialStore
}

export interface ComputerHandle {
  dialer: HubDialer
  stop(): Promise<void>
}

export interface HubRequestHandlerDeps {
  /** Trigger a graceful stop (after the ack flushes). */
  shutdown: (reason: string) => void
  /** Dialer used by streaming handlers (pty.data/exit, proc.data/exit, …). */
  dialer: ComputerDialer
  config: ComputerConfig
  log?: ComputerLog
  /** Computer loopback agent-hook URL — overlaid into every spawned agent's env
   *  (see HandlerContext.agentHookUrl). Absent → env passthrough (tests). */
  agentHookUrl?: string
  /**
   * Where this computer keeps each project on disk. Read lazily: the map comes
   * from a file and the dispatch table is built synchronously, so the handlers
   * register immediately and report "still loading" until it arrives.
   */
  getProjectPaths?: () => ProjectPathStore | null
}

export interface HubRequestDispatch {
  /** Route one hub→computer request to its handler. */
  handle(method: string, params: unknown): Promise<unknown>
  /** Tear down live sessions/processes (computer shutdown). */
  dispose(): void
  /** Late-bind the computer loopback agent-hook URL once its listener has bound
   *  (the port is ephemeral, resolved async after the dispatch is built). The
   *  ctx is shared by reference, so pty spawns issued after this see the URL. */
  setAgentHookUrl(url: string): void
}

/**
 * Build the hub→computer dispatch table. `computer.shutdown` acks then triggers the
 * graceful stop; pty/git/fs/proc methods route to their handler modules;
 * everything else throws `-32001 unimplemented`.
 */
export function createHubRequestHandler(deps: HubRequestHandlerDeps): HubRequestDispatch {
  const log =
    deps.log ??
    (() => {
      // Logging is opt-in — with no sink, handler diagnostics are discarded.
    })
  const ctx: HandlerContext = {
    dialer: deps.dialer,
    config: deps.config,
    log,
    ...(deps.agentHookUrl ? { agentHookUrl: deps.agentHookUrl } : {})
  }

  const pty = createPtyHandlers(ctx, deps.getProjectPaths)
  const proc = createProcHandlers(ctx, deps.getProjectPaths)

  const shutdownHandler = async (params: unknown): Promise<{ ok: true }> => {
    const parsed = computerShutdownParamsSchema.safeParse(params ?? {})
    const reason = parsed.success ? (parsed.data.reason ?? 'hub-requested') : 'hub-requested'
    // Ack first; the dialer flushes the response before the socket drops.
    queueMicrotask(() => deps.shutdown(reason))
    return { ok: true }
  }

  const table: HubMethodTable = {
    [HubToComputerMethods.computerShutdown]: shutdownHandler,
    ...pty.handlers,
    ...proc.handlers,
    ...createGitHandlers(ctx),
    ...createFsHandlers(ctx),
    ...createComputerConfigHandlers(ctx),
    ...createGhHandlers(ctx),
    ...createProjectHandlers(ctx, deps.getProjectPaths ?? (() => null))
  }

  const handle = async (method: string, params: unknown): Promise<unknown> => {
    const entry = table[method]
    if (!entry) {
      throw new RpcError(ComputerTransportErrorCodes.unimplemented, `unimplemented: ${method}`)
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

export function startComputer(config: ComputerConfig, deps: ComputerRuntimeDeps = {}): ComputerHandle {
  const log =
    deps.log ??
    (() => {
      // Logging is opt-in — with no sink, computer lifecycle diagnostics are discarded.
    })
  // Creds always derive from the ROOT anchor (`<ROOT>/computers`, see
  // credential-store slayzoneRootDir) — no override knob. Tests inject a store
  // via deps.credentialStore.
  const credentialStore =
    deps.credentialStore ?? createFileCredentialStore(hubHostFromUrl(config.hubUrl))

  // The dialer THROWS if a pin is set on a `ws://` url (pinning is meaningless
  // without TLS). An EXPLICITLY-configured pin (env/file) on a ws:// url already
  // fails loudly in loadComputerConfig — so any pin reaching here on a ws:// url can
  // only be the join-token-DECODED fingerprint (the auto path). Softly drop it so a
  // ws token stays usable for loopback/dev; the real computer path is wss:// (the hub's
  // /computers listener is https), where the pin is fed through and enforced.
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

  // `startComputer` is synchronous, and resolving the host id is file I/O. Rather
  // than make the whole entrypoint async, the identity object is MUTABLE and the
  // dialer reads `hostId` when it builds an enroll/hello frame — not when the
  // dialer is constructed. Local file reads finish long before a socket does, so
  // in practice the first enroll carries it; if it ever loses that race the field
  // is optional and the computer is simply ungrouped until its next connect.
  //
  // Failure is never fatal: grouping is cosmetic.
  const identity = {
    name: config.name,
    platform: `${process.platform}-${process.arch}`,
    version: RUNNER_VERSION,
    capabilities: config.capabilities
  } as ComputerIdentity
  let hostIdStop: (() => void) | undefined
  void startHostIdReconciler({ log })
    .then((r) => {
      identity.hostId = r.hostId
      hostIdStop = r.stop
    })
    .catch((err: unknown) => {
      log('host id unavailable — this computer will not be grouped onto a machine', {
        error: err instanceof Error ? err.message : String(err)
      })
    })

  let handle: ComputerHandle
  let dispatch: HubRequestDispatch
  const dialer = new HubDialer({
    url: config.hubUrl,
    identity,
    credentialStore,
    ...(config.joinToken ? { joinToken: config.joinToken } : {}),
    ...(pinnedCertSha256 ? { pinnedCertSha256 } : {}),
    onHubRequest: (method, params) => dispatch.handle(method, params),
    log
  })

  // Where this computer keeps its projects. Loaded async (one file read) and
  // late-bound, like the agent-hook URL — the dispatch table is synchronous.
  let projectPaths: ProjectPathStore | null = null
  void createProjectPathStore(hubHostFromUrl(config.hubUrl))
    .then((store) => {
      projectPaths = store
      log('project path map loaded', { file: store.filePath, count: store.list().length })
    })
    .catch((err) => log('project path map failed to load', { error: String(err) }))

  dispatch = createHubRequestHandler({
    shutdown: (reason) => {
      log('computer shutdown requested by hub', { reason })
      void handle.stop().then(() => deps.onShutdown?.(reason))
    },
    dialer,
    config,
    log,
    getProjectPaths: () => projectPaths
  })

  dialer.events.on('connected', ({ computerId, mode }) => log('connected to hub', { computerId, mode }))
  dialer.events.on('disconnected', ({ reason }) => log('disconnected from hub', { reason }))
  dialer.events.on('reconnect-scheduled', ({ attempt, delayMs }) =>
    log('reconnect scheduled', { attempt, delayMs })
  )
  dialer.events.on('error', ({ error, fatal, reason }) => {
    // `needs-re-enrollment` is the one failure an operator can act on: the hub no
    // longer recognizes this computer (its storage was deleted, one of its two DBs was
    // restored without the other, or the computer was revoked). Log it as its own
    // thing rather than burying it in a generic fatal, because the message carries
    // the fix and the process is about to stop.
    if (reason === 'needs-re-enrollment') {
      log('NEEDS RE-ENROLLMENT — this computer will not reconnect until it is enrolled again', {
        error: error.message,
        reason
      })
      return
    }
    log(fatal ? 'fatal error' : 'error', { error: error.message, fatal })
  })

  // Agent-hook loopback relay (hub/computer split): host /api/agent-hook on the
  // computer's own loopback and forward each envelope to the hub over the existing
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
      hostIdStop?.()
      if (agentHookServer) await agentHookServer.close()
      await dialer.stop()
    }
  }
  return handle
}
