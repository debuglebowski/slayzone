/**
 * Computer main — wires config + credential store + hub dialer into a running
 * exec node. The transport, enrollment, heartbeats, and reconnect logic live in
 * `@slayzone/computer-transport`; this module owns the hub→computer request DISPATCH TABLE that
 * routes each method to its exec handler (pty.*, git.*, fs.*, proc.*), plus a
 * graceful `computer.shutdown`. Unknown methods answer `-32001 unimplemented`.
 *
 * T-27: the dispatcher is also where every hub request is checked for its actor
 * (refused without one — a pre-v3 hub), mapped from a jail refusal to
 * `refusedByComputer`, and written as exactly one line to the local request log
 * (`request-log.ts`). `ping` alone is answered inside the dialer and not logged:
 * it is liveness, not work.
 *
 * @module computer/main
 */

import { unwatchFile, watchFile } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  createFileCredentialStore,
  credentialsFilePath,
  HubDialer,
  hubHostFromUrl,
  type ComputerCredentialStore,
  type ComputerIdentity
} from '@slayzone/computer-transport/client'
import {
  ComputerTransportErrorCodes,
  HubToComputerMethods,
  JSON_RPC_INTERNAL_ERROR,
  RpcError,
  computerShutdownParamsSchema,
  requestActorSchema
} from '@slayzone/computer-transport/shared'
import {
  getComputerConfigFilePath,
  loadComputerConfigFile
} from '@slayzone/platform/slayzone-config'
import {
  effectiveHubUrls,
  JailViolationError,
  setProtectedPaths,
  type ComputerConfig
} from './config'
import { createRequestLog, REQUEST_LOG_DIR_NAME, type RequestLog } from './request-log'
import { startHostIdReconciler } from './host-id'
import { type AgentHookServer, createAgentHookServer } from './handlers/agent-hook'
import { createFsHandlers } from './handlers/fs'
import { createGhHandlers } from './handlers/gh'
import { createGitHandlers } from './handlers/git'
import { createProcHandlers } from './handlers/proc'
import { createProjectHandlers } from './handlers/project'
import { createPtyHandlers } from './handlers/pty'
import { createSpawnAdmission, type SpawnAdmission } from './spawn-admission'
import { createComputerConfigHandlers, reloadLocalRoots } from './handlers/computer-config'
import { createProjectPathStore, type ProjectPathStore } from './project-paths'
import type { HandlerContext, HubMethodTable, ComputerDialer, ComputerLog } from './handlers/types'

/** Version advertised at enrollment; wave-1 skeleton is pre-release. */
export const COMPUTER_VERSION = '0.0.0'

export interface ComputerRuntimeDeps {
  log?: ComputerLog
  /** Invoked after a graceful `computer.shutdown` stop completes. */
  onShutdown?: (reason: string) => void
  /** Override the credential store (tests). */
  credentialStore?: ComputerCredentialStore
  /**
   * The computer's own state dir: its `computer.config.json`, credentials and
   * request log. Default: where `computer.config.json` lives (`SLAYZONE_ROOT`, else
   * `~/.slayzone`). Tests pass a temp dir.
   */
  stateDir?: string
  /** See {@link HubRequestHandlerDeps.pathReady}. Shared by every hub's dispatch. */
  pathReady?: Promise<unknown>
}

export interface ComputerHandle {
  /** The primary hub's dialer — `hubUrls[0]`, or the single `hubUrl`. */
  dialer: HubDialer
  /** One per hub this computer serves. Length 1 unless `hubUrls` is configured. */
  dialers: HubDialer[]
  stop(): Promise<void>
}

/** One hub's worth of runtime: its dialer, and how to tear it down. */
interface HubConnection {
  dialer: HubDialer
  dispose: () => Promise<void>
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
  /**
   * The computer-wide agent-start admission queue, shared by every hub this
   * computer serves (see spawn-admission.ts). Absent: a private one (tests).
   */
  admission?: SpawnAdmission
  /** The local request log (T-27). Absent: nothing recorded (tests). */
  requestLog?: RequestLog
  /** Host of the hub this dispatch serves, for the request log. */
  hubHost?: string
  /**
   * Settles once the login-shell PATH is adopted (see login-shell-path.ts). Every
   * request but the pty ones waits for it: git, gh, setup scripts and chat agents
   * look their tools up on PATH, while a pty starts the user's login shell, which
   * builds its own — so terminals restore without waiting on the probe.
   */
  pathReady?: Promise<unknown>
}

export interface HubRequestDispatch {
  /**
   * Route one hub→computer request to its handler. `actor` is the envelope's raw
   * `actor` member; a request without a valid one is refused (pre-v3 hub).
   */
  handle(method: string, params: unknown, actor: unknown): Promise<unknown>
  /** Tear down live sessions/processes/fs watches (computer shutdown). */
  dispose(): void
  /** Late-bind the computer loopback agent-hook URL once its listener has bound
   *  (the port is ephemeral, resolved async after the dispatch is built). The
   *  ctx is shared by reference, so pty spawns issued after this see the URL. */
  setAgentHookUrl(url: string): void
  /** The hub connection dropped: abandon work whose reply can no longer be delivered. */
  hubDisconnected(reason: string): void
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

  const pty = createPtyHandlers(
    ctx,
    deps.getProjectPaths,
    deps.admission ? { admission: deps.admission } : {}
  )
  const proc = createProcHandlers(ctx, deps.getProjectPaths)
  const fs = createFsHandlers(ctx)

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
    ...fs.handlers,
    ...createComputerConfigHandlers(ctx),
    ...createGhHandlers(ctx),
    ...createProjectHandlers(ctx, deps.getProjectPaths ?? (() => null))
  }

  const hub = deps.hubHost ?? 'unknown'
  const ptyMethods = new Set(Object.keys(pty.handlers))

  /** Exactly one log line per request, whatever its outcome. */
  const handle = async (method: string, params: unknown, rawActor: unknown): Promise<unknown> => {
    const parsedActor = requestActorSchema.safeParse(rawActor)
    const actor = parsedActor.success ? parsedActor.data : null
    const record = (result: 'ok' | 'error' | 'refused', code?: number, reason?: string): void =>
      deps.requestLog?.record({
        hub,
        method,
        actor,
        params,
        result,
        ...(code !== undefined ? { code } : {}),
        ...(reason !== undefined ? { reason } : {})
      })

    if (!actor) {
      // A v3 hub always sends one (null userId included); none = an older hub. Refused
      // rather than run unattributed — see COMPUTER_PROTOCOL_VERSION.
      const err = new RpcError(
        ComputerTransportErrorCodes.protocolMismatch,
        "hub sent no actor with this request (a hub older than computer protocol v3) — upgrade the hub to this computer's release"
      )
      record('refused', err.code, err.message)
      throw err
    }
    const entry = table[method]
    if (!entry) {
      const err = new RpcError(
        ComputerTransportErrorCodes.unimplemented,
        `unimplemented: ${method}`
      )
      record('error', err.code)
      throw err
    }
    try {
      if (deps.pathReady && !ptyMethods.has(method)) await deps.pathReady
      const result = await entry(params)
      record('ok')
      return result
    } catch (err) {
      if (err instanceof JailViolationError) {
        log('request refused by the path jail', { method, reason: err.message })
        const refused = new RpcError(ComputerTransportErrorCodes.refusedByComputer, err.message)
        record('refused', refused.code, err.message)
        throw refused
      }
      if (err instanceof RpcError && err.code === ComputerTransportErrorCodes.refusedByComputer) {
        log('request refused by local policy', { method, reason: err.message })
        record('refused', err.code, err.message)
        throw err
      }
      // Code only: a foreign error text (git/gh stderr) can carry a credential.
      record('error', err instanceof RpcError ? err.code : JSON_RPC_INTERNAL_ERROR)
      throw err
    }
  }

  const dispose = (): void => {
    pty.disposeAll()
    proc.disposeAll()
    fs.disposeAll()
  }

  const setAgentHookUrl = (url: string): void => {
    ctx.agentHookUrl = url
  }

  const hubDisconnected = (reason: string): void => {
    pty.dropQueued(`hub disconnected (${reason})`)
  }

  return { handle, dispose, setAgentHookUrl, hubDisconnected }
}

export function startComputer(
  config: ComputerConfig,
  deps: ComputerRuntimeDeps = {}
): ComputerHandle {
  const log =
    deps.log ??
    (() => {
      // Logging is opt-in — with no sink, computer lifecycle diagnostics are discarded.
    })

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
    version: COMPUTER_VERSION,
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

  // The computer's own state (T-27): its config — which holds allowedRoots — its
  // credentials and its request log are refused to every hub frame, and the log
  // is opened before any hub can send work. An unwritable state dir throws here:
  // better not to start than to work unlogged.
  const stateDir = deps.stateDir ?? dirname(getComputerConfigFilePath())
  const configFile = join(stateDir, 'computer.config.json')
  setProtectedPaths([
    configFile,
    // The legacy file computer.config.json falls back to when absent.
    join(stateDir, 'config.json'),
    credentialsFilePath(stateDir),
    join(stateDir, REQUEST_LOG_DIR_NAME)
  ])
  const requestLog = createRequestLog({
    stateDir,
    onError: (err) => log('request log write failed', { error: String(err) })
  })
  log('local request log', { file: requestLog.filePath })

  // Folder limits stay local (T-27): a standalone computer applies the roots its
  // own computer.config.json declares whenever that file changes — what
  // `slay computer roots --add` writes. Polled, not fs.watch: an atomic rename
  // replaces the inode a watcher holds. Not for the desktop's supervised computer,
  // which never reads the file (its loopback hub edits its roots instead).
  const watchLocalRoots = !config.hubMayEditRoots
  if (watchLocalRoots) {
    watchFile(configFile, { interval: 2000, persistent: false }, () => {
      const declared = loadComputerConfigFile(configFile).allowedRoots
      const applied = reloadLocalRoots(config, declared)
      if (!applied) return
      log('allowedRoots reloaded from local config', { applied })
      requestLog.record({
        hub: 'local',
        method: 'local.allowedRoots',
        actor: null,
        params: { roots: applied },
        result: 'ok'
      })
    })
  }

  // ONE admission queue for every hub connection: agent starts contend for this
  // machine, whichever hub asked for them.
  const admission = createSpawnAdmission()

  /**
   * Everything that belongs to ONE hub.
   *
   * All of it is per-hub, including the agent-hook relay: a pty spawned by hub A
   * is dispatched by A's table and must post its hooks back over A's socket, so a
   * shared relay would forward another hub's agent lifecycle to the wrong place.
   * The two persistence layers were already keyed by hub host, so nothing new is
   * stored — this is the runtime catching up with a shape the files always had.
   */
  const connectHub = (hubUrl: string, isPrimary: boolean): HubConnection => {
    // Creds always derive from the ROOT anchor, keyed by hub host. The injected
    // store (tests) applies to the PRIMARY hub only — one store cannot stand in
    // for several hubs' credentials without silently sharing one entry.
    const credentialStore =
      (isPrimary ? deps.credentialStore : undefined) ??
      createFileCredentialStore(hubHostFromUrl(hubUrl))

    let dispatch: HubRequestDispatch
    const dialer = new HubDialer({
      url: hubUrl,
      identity,
      credentialStore,
      ...(config.joinToken && isPrimary ? { joinToken: config.joinToken } : {}),
      onHubRequest: (method, params, actor) => dispatch.handle(method, params, actor),
      log
    })

    // Where this computer keeps THIS hub's projects. Loaded async (one file read)
    // and late-bound, like the agent-hook URL — the dispatch table is synchronous.
    let projectPaths: ProjectPathStore | null = null
    void createProjectPathStore(hubHostFromUrl(hubUrl))
      .then((store) => {
        projectPaths = store
        log('project path map loaded', {
          hubUrl,
          file: store.filePath,
          count: store.list().length
        })
      })
      .catch((err) => log('project path map failed to load', { hubUrl, error: String(err) }))

    dispatch = createHubRequestHandler({
      shutdown: (reason) => {
        log('computer shutdown requested by hub', { hubUrl, reason })
        void handle.stop().then(() => deps.onShutdown?.(reason))
      },
      dialer,
      config,
      log,
      getProjectPaths: () => projectPaths,
      admission,
      requestLog,
      hubHost: hubHostFromUrl(hubUrl),
      ...(deps.pathReady ? { pathReady: deps.pathReady } : {})
    })

    // Every line carries the hub, because with more than one connection "reconnect
    // scheduled" on its own does not say which peer went away.
    dialer.events.on('connected', ({ computerId, mode }) =>
      log('connected to hub', { hubUrl, computerId, mode })
    )
    dialer.events.on('disconnected', ({ reason }) => {
      log('disconnected from hub', { hubUrl, reason })
      dispatch.hubDisconnected(String(reason))
    })
    dialer.events.on('reconnect-scheduled', ({ attempt, delayMs }) =>
      log('reconnect scheduled', { hubUrl, attempt, delayMs })
    )
    dialer.events.on('error', ({ error, fatal, reason }) => {
      // `needs-re-enrollment` is the one failure an operator can act on: that hub no
      // longer recognizes this computer (its storage was deleted, one of its two DBs
      // was restored without the other, or the computer was revoked). Log it as its
      // own thing rather than burying it in a generic fatal, because the message
      // carries the fix.
      if (reason === 'needs-re-enrollment') {
        log('NEEDS RE-ENROLLMENT — this computer will not reconnect until it is enrolled again', {
          hubUrl,
          error: error.message,
          reason
        })
        return
      }
      log(fatal ? 'fatal error' : 'error', { hubUrl, error: error.message, fatal })
    })

    // Agent-hook loopback relay: host /api/agent-hook on this computer's own
    // loopback and forward each envelope to THIS hub over its authed ws channel.
    // Its ephemeral port binds async; feed the URL into the dispatch so ptys
    // spawned after the bind overlay it into the agent env. Best-effort — a bind
    // failure only degrades remote hooks, it does not stop exec.
    let agentHookServer: AgentHookServer | null = null
    void createAgentHookServer({ dialer, config, log })
      .then((srv) => {
        agentHookServer = srv
        dispatch.setAgentHookUrl(srv.url)
      })
      .catch((err) => log('agent-hook relay failed to start', { hubUrl, error: String(err) }))

    dialer.start()

    return {
      dialer,
      dispose: async () => {
        // Kill live ptys/processes and close fs watches before the socket drops, so
        // nothing is orphaned and no handle keeps the stopped process alive.
        dispatch.dispose()
        if (agentHookServer) await agentHookServer.close()
        await dialer.stop()
      }
    }
  }

  const hubUrls = effectiveHubUrls(config)
  const connections = hubUrls.map((url, i) => connectHub(url, i === 0))

  handle = {
    // The primary hub's dialer. Kept as a named field because a computer serving
    // exactly one hub is the overwhelming case and every existing caller reads it;
    // `dialers` is what multi-hub callers iterate.
    dialer: connections[0].dialer,
    dialers: connections.map((c) => c.dialer),
    stop: async () => {
      hostIdStop?.()
      if (watchLocalRoots) unwatchFile(configFile)
      await Promise.all(connections.map((c) => c.dispose()))
    }
  }
  return handle
}
