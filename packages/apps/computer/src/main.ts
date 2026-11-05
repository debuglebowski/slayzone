import { createChatRuntimeHandlers } from './handlers/chat-runtime'
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
  COMPUTER_EXIT_NEEDS_RE_ENROLLMENT,
  ComputerTransportErrorCodes,
  HubToComputerMethods,
  JSON_RPC_INTERNAL_ERROR,
  RpcError,
  computerShutdownParamsSchema,
  requestActorSchema
} from '@slayzone/computer-transport/shared'
import { hubAddrFromUrl } from '@slayzone/platform/hub-addr'
import { DESKTOP_COMPUTER_CAPABILITY } from '@slayzone/platform/computer-identity'
import { getComputerConfigFilePath } from '@slayzone/platform/slayzone-config'
import { effectiveHubUrls, type ComputerConfig } from './config'
import { JailViolationError, setProtectedPaths } from './path-jail'
import { createRequestLog, REQUEST_LOG_DIR_NAME, type RequestLog } from './request-log'
import { startHostIdReconciler } from './host-id'
import { createAgentHookServer } from './handlers/agent-hook'
import { createComputerCliRelay, type ComputerCliRelay } from './cli-relay'
import { createFsHandlers } from './handlers/fs'
import { createSlayHandlers } from './handlers/slay'
import { createGhHandlers } from './handlers/gh'
import { createClaudeSessionHandlers } from './handlers/claude-session'
import { createGitHandlers } from './handlers/git'
import { createGitOpHandlers } from './handlers/git-op'
import { createExecRunHandlers } from './handlers/exec-run'
import { createAgentConfigHandlers } from './handlers/agent-config'
import { createUsageCollectHandlers } from './handlers/usage-collect'
import { createTestScanHandlers } from './handlers/test-scan'
import { createWorkspaceChangesHandlers } from './handlers/workspace-changes'
import { createProcHandlers } from './handlers/proc'
import { createProjectHandlers } from './handlers/project'
import { createPtyHandlers } from './handlers/pty'
import { createSpawnAdmission, type SpawnAdmission } from './spawn-admission'
import { createComputerConfigHandlers, reloadLocalRootsFromFile } from './handlers/computer-config'
import { createProjectPathStore, type ProjectPathStore } from './project-paths'
import type { HandlerContext, HubMethodTable, ComputerDialer, ComputerLog } from './handlers/types'

/** Running package release, advertised on enrollment and reconnect. */
declare const __SLAYZONE_COMPUTER_VERSION__: string | undefined
export const COMPUTER_VERSION =
  typeof __SLAYZONE_COMPUTER_VERSION__ === 'string' ? __SLAYZONE_COMPUTER_VERSION__ : '0.0.0'

export interface ComputerRuntimeDeps {
  log?: ComputerLog
  initiallyPaused?: boolean
  hookDirectory?: (hubUrl: string) => string | undefined
  createDialer?: (options: ConstructorParameters<typeof HubDialer>[0]) => HubDialer
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
  /**
   * Obtain a fresh join token for a hub added with {@link ComputerHandle.setSecondaryHubs}
   * (the dialer's `refreshJoinToken`: a single-use token already spent). The desktop's
   * supervised computer asks its parent app, which can mint one. Absent: a refused
   * token stays fatal for that hub, as for any dialer without the hook.
   */
  refreshJoinTokenFor?: (hubUrl: string) => Promise<string | null>
  /**
   * Called for EVERY hub connection this computer creates — the initial ones and any
   * added later by `setSecondaryHubs` — synchronously, before its dialer starts, so a
   * listener attached here misses none of its events.
   */
  onConnection?: (connection: HubConnectionInfo) => void
}

/** A hub the computer serves IN ADDITION to its primary, added while it runs. */
export interface SecondaryHubSpec {
  /** `ws://` / `wss://` hub computer endpoint. */
  url: string
  /** The name this computer enrolls under on THAT hub. */
  name: string
  /** First contact, or recovery of a fatally stopped connection (see setSecondaryHubs). */
  joinToken?: string
}

export interface HubConnectionInfo {
  hubUrl: string
  /** The hub the computer was started for (`hubUrls[0]` / `hubUrl`). */
  primary: boolean
  dialer: HubDialer
}

export interface ComputerHandle {
  /** The primary hub's dialer — `hubUrls[0]`, or the single `hubUrl`. Never changes. */
  dialer: HubDialer
  /**
   * One per hub this computer serves RIGHT NOW, the primary first. Length 1 unless
   * `hubUrls` is configured or secondary hubs were added. Re-read it: the set changes
   * with {@link setSecondaryHubs}.
   */
  readonly dialers: HubDialer[]
  /**
   * Reconcile the hubs served in addition to the primary — without restarting the
   * process, which would kill every agent pty. `hubs` is the complete desired set:
   *   - a url not served yet is connected, enrolling under its entry's `name`;
   *   - a served url missing from `hubs` is disconnected (its work on this computer
   *     is torn down, as on stop);
   *   - a served url whose dialer gave up (fatal) is reconnected when its entry
   *     carries a `joinToken` — how a parent recovers it with a freshly minted one;
   *   - anything else is left alone (a new `name` does not re-enroll a live hub).
   * The primary hub, and hubs from `hubUrls`, are never touched: an entry naming one
   * (or sharing its credential key) is ignored. Calls apply in order; the promise
   * settles when this one has. Only the full computer has it (not the connector).
   */
  setSecondaryHubs?(hubs: ReadonlyArray<SecondaryHubSpec>): Promise<void>
  activate(): void | Promise<void>
  isIdle(): boolean
  setHookDirectory(hub: string, directory: string): void
  drainForUpgrade(): boolean
  stop(): Promise<void>
}

/** One hub's worth of runtime: its dialer, and how to tear it down. */
interface HubConnection {
  dialer: HubDialer
  /** Added by `setSecondaryHubs` — the only connections it may replace or remove. */
  secondary: boolean
  /** The dialer gave up (a `fatal` error); it will not reconnect on its own. */
  isFatallyStopped: () => boolean
  dispose: () => Promise<void>
  isIdle: () => boolean
  setHookDirectory: (directory: string) => void
}

/**
 * Exit-code policy for the computer process: ONLY the primary hub's dialer decides
 * it. The dialer gives up on fatal auth errors (bad join token, missing creds), so
 * exit non-zero and supervisors notice instead of idling forever. A secondary hub
 * failing is that hub's problem, reported per hub — never a reason to look dead.
 *
 * Exit code 78 (EX_CONFIG, sysexits.h) is reserved for "the hub no longer
 * recognizes this computer". A supervisor cannot fix that by restarting — only an
 * operator re-enrolling can — so it needs to distinguish that from a crash, and an
 * exit code is a far sturdier channel for that than matching a log line.
 */
export function watchPrimaryHubExitCode(
  primary: HubDialer,
  setExitCode: (code: number) => void
): void {
  primary.events.on('error', ({ fatal, reason }) => {
    if (reason === 'needs-re-enrollment') {
      setExitCode(COMPUTER_EXIT_NEEDS_RE_ENROLLMENT)
      return
    }
    if (fatal) setExitCode(1)
  })
}

export interface HubRequestHandlerDeps {
  hookDirectory?: string
  stateDir?: string
  hubScope?: string
  getComputerId?: () => string | null
  cliRelayReady?: Promise<ComputerCliRelay>
  /** Trigger a graceful stop (after the ack flushes). */
  shutdown: (reason: string) => void
  /** Dialer used by streaming handlers (pty.data/exit, proc.data/exit, …). */
  dialer: ComputerDialer
  config: ComputerConfig
  log?: ComputerLog
  /** Computer loopback agent-hook URL — overlaid into every spawned agent's env
   *  (see HandlerContext.agentHookUrl). Absent → env passthrough (tests). */
  agentHookUrl?: string
  /** The authority this hub connection dials — overlaid as `SLAYZONE_HUB_ADDRESS`
   *  into everything spawned for it (see HandlerContext.hubAddress). */
  hubAddress?: string
  /**
   * May this hub edit `allowedRoots`? See HandlerContext.hubMayEditRoots. Absent:
   * the process-wide `config.hubMayEditRoots` — right for a dispatch serving the
   * computer's only (or primary) hub; `startComputer` always passes it explicitly.
   */
  hubMayEditRoots?: boolean
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
  dispose(): Promise<void>
  isIdle(): boolean
  setHookDirectory(directory: string): void
  /** Late-bind the computer loopback agent-hook URL once its listener has bound
   *  (the port is ephemeral, resolved async after the dispatch is built). The
   *  ctx is shared by reference, so pty spawns issued after this see the URL. */
  captureAgentHook(hook: import('@slayzone/terminal-contracts').ResolvedAgentHook): void
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
    hookDirectory: deps.hookDirectory,
    config: deps.config,
    log,
    hubMayEditRoots: deps.hubMayEditRoots ?? deps.config.hubMayEditRoots === true,
    ...(deps.agentHookUrl ? { agentHookUrl: deps.agentHookUrl } : {}),
    ...(deps.hubAddress ? { hubAddress: deps.hubAddress } : {})
  }
  const cliReady = deps.cliRelayReady?.then((relay) => {
    ctx.cliRelay = relay
  })
  void cliReady?.catch(() => log('CLI relay is unavailable'))

  const pty = createPtyHandlers(ctx, deps.getProjectPaths, {
    assertTaskActive: (taskId) => chat.assertTaskActive(taskId),
    ...(deps.admission ? { admission: deps.admission } : {}),
    ...(deps.pathReady ? { pathReady: deps.pathReady } : {})
  })
  // Chat agents (proc.spawn with an admission lane) share the pty agents' start queue.
  const proc = createProcHandlers(
    ctx,
    deps.getProjectPaths,
    deps.admission ? { admission: deps.admission } : {}
  )
  const fs = createFsHandlers(ctx)
  const chat = createChatRuntimeHandlers({
    ctx,
    stateDir: deps.stateDir ?? dirname(getComputerConfigFilePath()),
    hubScope: deps.hubScope ?? deps.hubHost ?? deps.config.hubUrl ?? '',
    computerId: deps.getComputerId ?? (() => null),
    getProjectPaths: deps.getProjectPaths ?? (() => null),
    admission: deps.admission,
    hasTaskWork: pty.hasTaskWork,
    stopTask: pty.stopTask
  })

  const shutdownHandler = async (params: unknown): Promise<{ ok: true }> => {
    const parsed = computerShutdownParamsSchema.safeParse(params ?? {})
    const reason = parsed.success ? (parsed.data.reason ?? 'hub-requested') : 'hub-requested'
    // Ack first; the dialer flushes the response before the socket drops.
    queueMicrotask(() => deps.shutdown(reason))
    return { ok: true }
  }

  /** Handlers' cleanup for a lost hub connection (their state belongs to that hub). */
  const onHubDisconnected: Array<() => void> = []
  const table: HubMethodTable = {
    [HubToComputerMethods.chatRequest]: chat.request,
    [HubToComputerMethods.computerShutdown]: shutdownHandler,
    ...pty.handlers,
    ...proc.handlers,
    ...createGitHandlers(ctx),
    ...createGitOpHandlers(ctx, { onHubDisconnected: (cb) => onHubDisconnected.push(cb) }),
    ...createExecRunHandlers(ctx, deps.getProjectPaths),
    ...createAgentConfigHandlers(ctx),
    ...createUsageCollectHandlers(ctx),
    ...createTestScanHandlers(ctx),
    ...createWorkspaceChangesHandlers(ctx, deps.getProjectPaths ?? (() => null)),
    ...fs.handlers,
    ...createComputerConfigHandlers(ctx),
    ...createGhHandlers(ctx),
    ...createSlayHandlers(ctx),
    ...createClaudeSessionHandlers(ctx, deps.getProjectPaths ?? (() => null)),
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
      if (
        method === HubToComputerMethods.ptySpawn ||
        method === HubToComputerMethods.ptyWarmSpawn ||
        method === HubToComputerMethods.procSpawn ||
        method === HubToComputerMethods.chatRequest ||
        method === HubToComputerMethods.slaySetup
      )
        await cliReady
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

  const dispose = async (): Promise<void> => {
    pty.disposeAll()
    proc.disposeAll()
    fs.disposeAll()
    await chat.close()
  }

  const setAgentHookUrl = (url: string): void => {
    ctx.agentHookUrl = url
  }

  const hubDisconnected = (reason: string): void => {
    pty.dropQueued(`hub disconnected (${reason})`)
    for (const cb of onHubDisconnected) cb()
  }

  let inFlight = 0
  const trackedHandle: HubRequestDispatch['handle'] = async (...args) => {
    inFlight++
    try {
      return await handle(...args)
    } finally {
      inFlight--
    }
  }
  return {
    setHookDirectory: (directory) => {
      ctx.hookDirectory = directory
    },
    handle: trackedHandle,
    dispose,
    setAgentHookUrl,
    hubDisconnected,
    captureAgentHook: chat.captureHook,
    isIdle: () => inFlight === 0 && !pty.hasWork() && !proc.hasWork() && !chat.hasWork()
  }
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
  // A secondary hub enrolls this computer under its OWN name, so it gets its own
  // identity object — the same machine otherwise, host id included. One made before
  // the id resolves is filled in with the primary's; one made after copies it.
  const secondaryIdentities = new Set<ComputerIdentity>()
  let hostIdStop: (() => void) | undefined
  const hostIdReady = startHostIdReconciler({ log })
    .then((r) => {
      identity.hostId = r.hostId
      for (const secondary of secondaryIdentities) secondary.hostId = r.hostId
      hostIdStop = r.stop
    })
    .catch((err: unknown) => {
      log('host id unavailable — this computer will not be grouped onto a machine', {
        error: err instanceof Error ? err.message : String(err)
      })
    })

  let handle: ComputerHandle
  let draining = false
  let activate = (): void => undefined
  // A candidate authenticates before its release is committed. Hold the hub's
  // immediate reconciliation requests until activation instead of failing them.
  const activation = deps.initiallyPaused
    ? new Promise<void>((resolve) => {
        activate = resolve
      })
    : undefined

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
    join(stateDir, 'computer-runtime'),
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
    watchFile(configFile, { interval: 2000, persistent: false }, (current, previous) => {
      // watchFile reports an initial missing file once. Preserve legitimate
      // env-only / legacy-only boots until the device file actually changes.
      if (current.nlink === 0 && previous.nlink === 0) return
      try {
        const applied = reloadLocalRootsFromFile(config, configFile, stateDir)
        if (!applied) return
        log('allowedRoots reloaded from local config', { applied })
        requestLog.record({
          hub: 'local',
          method: 'local.allowedRoots',
          actor: null,
          params: { roots: applied },
          result: 'ok'
        })
      } catch (err) {
        log('allowedRoots reload failed; keeping current folder policy', { error: String(err) })
      }
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
   *
   * `secondary` marks a hub added at runtime by `setSecondaryHubs`: it enrolls under
   * its own name, recovers a spent join token through `refreshJoinTokenFor`, may not
   * edit allowedRoots, and a `computer.shutdown` from it ends only its connection.
   */
  const connectHub = (
    hubUrl: string,
    isPrimary: boolean,
    secondary?: Omit<SecondaryHubSpec, 'url'>
  ): HubConnection => {
    // Creds always derive from the ROOT anchor, keyed by hub host. The injected
    // store (tests) applies to the PRIMARY hub only — one store cannot stand in
    // for several hubs' credentials without silently sharing one entry.
    const credentialStore =
      (isPrimary ? deps.credentialStore : undefined) ??
      createFileCredentialStore(hubHostFromUrl(hubUrl))

    let hubIdentity = identity
    if (secondary) {
      // Marked as a desktop's own computer joined to a hub besides its own: that hub
      // then never prefers it over a computer its user already had there.
      hubIdentity = {
        ...identity,
        name: secondary.name,
        capabilities: [...identity.capabilities, DESKTOP_COMPUTER_CAPABILITY]
      }
      secondaryIdentities.add(hubIdentity)
    }
    const joinToken = secondary ? secondary.joinToken : isPrimary ? config.joinToken : undefined
    const refreshJoinTokenFor = deps.refreshJoinTokenFor

    // How this box reaches the hub — what `slay` in its terminals must dial too.
    const hubAddress = hubAddrFromUrl(hubUrl)
    let dispatch: HubRequestDispatch
    let connection: HubConnection
    const dialer = (deps.createDialer ?? ((options) => new HubDialer(options)))({
      url: hubUrl,
      identity: hubIdentity,
      credentialStore,
      ...(joinToken ? { joinToken } : {}),
      ...(secondary && refreshJoinTokenFor
        ? { refreshJoinToken: () => refreshJoinTokenFor(hubUrl) }
        : {}),
      onHubRequest: async (method, params, actor) => {
        if (activation) await activation
        if (draining)
          throw new Error('computer is restarting for an upgrade; retry after reconnect')
        return dispatch.handle(method, params, actor)
      },
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

    const cliRelayReady = createComputerCliRelay(dialer)
    // Observe startup failures even before the first spawn arrives.
    void cliRelayReady.catch(() => log('CLI relay failed to start', { hubUrl }))
    dispatch = createHubRequestHandler({
      stateDir,
      hubScope: hubHostFromUrl(hubUrl),
      getComputerId: () => dialer.computerId,
      cliRelayReady,
      hookDirectory: deps.hookDirectory?.(hubUrl),
      shutdown: (reason) => {
        if (secondary) {
          // This process belongs to whoever started it with its primary hub (the
          // desktop app); a hub it merely joined must not end it — that would kill
          // every other hub's agents. It can stop being served, though.
          log('hub asked to stop serving it — disconnecting that hub only', { hubUrl, reason })
          void removeConnection(hubUrl, connection)
          return
        }
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
      // Per connection: the process-wide grant is for the primary (loopback) hub of
      // the desktop's own computer. A hub joined at runtime never edits the jail.
      hubMayEditRoots: !secondary && config.hubMayEditRoots === true,
      // Per hub, like the hook relay: a pty THIS hub asked for belongs to it.
      ...(hubAddress ? { hubAddress } : {}),
      ...(deps.pathReady ? { pathReady: deps.pathReady } : {})
    })

    // Every line carries the hub, because with more than one connection "reconnect
    // scheduled" on its own does not say which peer went away.
    dialer.events.on('connected', ({ computerId, mode }) =>
      log('connected to hub', { hubUrl, computerId, mode })
    )
    dialer.events.on('disconnected', ({ reason }) => {
      void cliRelayReady.then(
        (relay) => relay.disconnect(),
        () => {
          // Startup failure was already logged; there is no relay to disconnect.
        }
      )
      log('disconnected from hub', { hubUrl, reason })
      dispatch.hubDisconnected(String(reason))
    })
    dialer.events.on('reconnect-scheduled', ({ attempt, delayMs }) =>
      log('reconnect scheduled', { hubUrl, attempt, delayMs })
    )
    // A fatal error is final for THIS dialer (it never reconnects on its own), which
    // is what lets `setSecondaryHubs` replace it when handed a fresh token.
    let fatallyStopped = false
    dialer.events.on('error', ({ error, fatal, reason }) => {
      if (fatal) fatallyStopped = true
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
    const agentHookReady = createAgentHookServer({ dialer, config, log }, dispatch.captureAgentHook)
      .then((srv) => {
        dispatch.setAgentHookUrl(srv.url)
        return srv
      })
      .catch((err) => {
        log('agent-hook relay failed to start', { hubUrl, error: String(err) })
        return null
      })

    connection = {
      dialer,
      secondary: secondary !== undefined,
      isFatallyStopped: () => fatallyStopped,
      isIdle: () => dispatch.isIdle(),
      setHookDirectory: (directory) => dispatch.setHookDirectory(directory),
      dispose: async () => {
        // Kill live ptys/processes and close fs watches before the socket drops, so
        // nothing is orphaned and no handle keeps the stopped process alive.
        await dispatch.dispose()
        await cliRelayReady.then(
          (relay) => relay.close(),
          () => {
            // Startup failure was already logged; there is no listener to close.
          }
        )
        const agentHookServer = await agentHookReady
        if (agentHookServer) await agentHookServer.close()
        await dialer.stop()
        secondaryIdentities.delete(hubIdentity)
      }
    }
    // Before start: a listener attached here cannot miss the first event.
    deps.onConnection?.({ hubUrl, primary: isPrimary, dialer })
    dialer.start()
    return connection
  }

  /**
   * Every hub served right now, keyed by url, in connect order — the primary first,
   * and it is never removed (so `handle.dialer` stays `dialers[0]`).
   */
  const connections = new Map<string, HubConnection>()
  const hubUrls = effectiveHubUrls(config)
  const primaryUrl = hubUrls[0]
  for (const [i, url] of hubUrls.entries()) connections.set(url, connectHub(url, i === 0))
  const primaryDialer = connections.get(primaryUrl)!.dialer

  // Hub-set changes run one at a time, each after the previous has fully applied:
  // a hub removed and re-added must not have its old connection (same credential
  // entry, same project map) still tearing down while the new one enrolls.
  let stopped = false
  let hubChanges: Promise<void> = Promise.resolve()
  const enqueueHubChange = (change: () => Promise<void>): Promise<void> => {
    const run = hubChanges.then(change)
    hubChanges = run.catch((err: unknown) =>
      log('changing the served hubs failed', { error: String(err) })
    )
    return hubChanges
  }

  /** Drop one secondary connection, if it is still the one in the set. */
  function removeConnection(hubUrl: string, which: HubConnection): Promise<void> {
    return enqueueHubChange(async () => {
      // After stop began, stop disposes every connection itself.
      if (stopped || connections.get(hubUrl) !== which) return
      connections.delete(hubUrl)
      await which.dispose()
    })
  }

  const applySecondaryHubs = async (hubs: ReadonlyArray<SecondaryHubSpec>): Promise<void> => {
    if (stopped) return
    // Credential entries (and project maps) are keyed by hub HOST, not url: two urls
    // for one host:port would race over one entry. So a hub is identified by its
    // host key here — and the configured hubs' keys are never available to a
    // secondary, whatever url names them.
    const configuredKeys = new Set(
      [...connections.entries()].filter(([, c]) => !c.secondary).map(([url]) => hubHostFromUrl(url))
    )
    const wanted = new Map<string, SecondaryHubSpec>()
    const wantedKeys = new Set<string>()
    for (const hub of hubs) {
      let key: string
      try {
        key = hubHostFromUrl(hub.url)
      } catch {
        log('ignoring an additional hub with an invalid url', { hubUrl: hub.url })
        continue
      }
      if (configuredKeys.has(key)) {
        log('ignoring an additional hub that is a hub this computer was started for', {
          hubUrl: hub.url
        })
        continue
      }
      if (wantedKeys.has(key)) {
        log('ignoring a duplicate additional hub (same host as another)', { hubUrl: hub.url })
        continue
      }
      wantedKeys.add(key)
      wanted.set(hub.url, hub)
    }

    const drop: [string, HubConnection][] = []
    for (const [url, connection] of connections) {
      if (!connection.secondary) continue
      const spec = wanted.get(url)
      if (!spec) drop.push([url, connection])
      else if (connection.isFatallyStopped() && spec.joinToken) {
        log('reconnecting a stopped hub with a fresh join token', { hubUrl: url })
        drop.push([url, connection])
      }
    }
    for (const [url] of drop) connections.delete(url)
    await Promise.all(drop.map(([, connection]) => connection.dispose()))
    if (stopped) return

    // No host-key conflict is left here: a secondary served under another url of a
    // wanted host is not itself wanted (keys are unique above), so it was dropped.
    for (const [url, spec] of wanted) {
      if (connections.has(url)) continue
      try {
        connections.set(url, connectHub(url, false, { name: spec.name, joinToken: spec.joinToken }))
        log('serving an additional hub', { hubUrl: url, name: spec.name })
      } catch (err) {
        // A url the dialer refuses (not ws/wss) fails here, before any I/O.
        log('could not connect an additional hub', { hubUrl: url, error: String(err) })
      }
    }
  }

  handle = {
    // The primary hub's dialer. Kept as a named field because a computer serving
    // exactly one hub is the overwhelming case and every existing caller reads it;
    // `dialers` is what multi-hub callers iterate.
    dialer: primaryDialer,
    get dialers() {
      return [...connections.values()].map((c) => c.dialer)
    },
    setSecondaryHubs: (hubs) => {
      // Snapshot now: the caller may reuse its array before the change applies.
      const desired = hubs.map((hub) => ({ ...hub }))
      return enqueueHubChange(() => applySecondaryHubs(desired))
    },
    activate: () => {
      activate()
      draining = false
    },
    setHookDirectory: (hub, directory) => {
      connections.get(hub)?.setHookDirectory(directory)
    },
    isIdle: () => [...connections.values()].every((c) => c.isIdle()),
    drainForUpgrade: () => {
      if (![...connections.values()].every((c) => c.isIdle())) return false
      draining = true
      return true
    },
    stop: async () => {
      // No hub change may start after this, and one in flight finishes first, so
      // no connection is created behind stop's back or left half torn down.
      stopped = true
      await hubChanges
      await hostIdReady
      hostIdStop?.()
      if (watchLocalRoots) unwatchFile(configFile)
      await Promise.all([...connections.values()].map((c) => c.dispose()))
    }
  }
  return handle
}
