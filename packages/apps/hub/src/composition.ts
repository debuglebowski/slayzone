import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  openPath as nativeOpenPath,
  openExternal as nativeOpenExternal,
  pathExists as nativePathExists,
  showItemInFolder as nativeShowItemInFolder
} from './shell-native'
import type { SlayzoneDb } from '@slayzone/platform'
import { checkCliInstalled } from '@slayzone/platform'
import { TypedEmitter } from '@slayzone/platform/events'
import {
  assertHubIntegrationsEnabled,
  assertHubLocalExecEnabled
} from '@slayzone/platform/hub-switch-refusal'
import {
  setTaskDeps,
  setIntegrationOps,
  setProcessesDeps,
  setNotifyEvents,
  setAutomationsEvents,
  setTelemetryEvents,
  setMenuEvents,
  setAgentLifecycleEvents,
  setTaskTriggerBus,
  setAppDeps,
  setBackupOps,
  setPtyDeps,
  setChatDeps,
  setAuthEvents,
  setComputersDeps,
  setWorkspaceDeps,
  requestGithubSignInStart,
  hubGithubSignInConvexUrl,
  evictAgentTree,
  type AppDeps,
  type NotifyEventMap,
  type AutomationsEventMap,
  type TelemetryEventMap,
  type MenuEventMap,
  type AgentLifecycleEventMap,
  type AuthEventMap,
  type RestApiDeps,
  type FloatingAgentState
} from '@slayzone/transport/server'
import { createHostBridge, type HostBridge } from './host-bridge.js'
import { getDesktopBridgeCapUrl, getDesktopBridgeToken } from './desktop-bridge-address.js'
import { getServerBuildInfo } from './build-info.js'
import {
  taskOps,
  configureTaskRuntimeAdapters,
  defaultWorktreeExecAdapters,
  startArtifactWatcher,
  purgeStaleAndOrphanedTasks,
  handleAttentionTransition,
  registerConversationHealer,
  registerConversationResolver
} from '@slayzone/task/server'
import type { TasksChange } from '@slayzone/task/shared'
import { handleTerminalStateChange, relocateProjectIcons } from '@slayzone/projects/server'
import {
  createPtyOps,
  createDbPtySpawnLookups,
  setPtyBackend,
  setPtySpawnLookups,
  setRemoteMcpEnvProvider,
  ptyEvents,
  createChatOps,
  createChatQueueOps,
  chatEvents,
  chatQueueEvents,
  listPtys,
  hasPty,
  getBuffer,
  writePty,
  submitPty,
  killPty,
  killPtysByTaskId,
  requestEnsureAlive,
  subscribeToPtyData,
  subscribeToStateChange,
  onSessionChange,
  getState,
  findSessionByTaskIdAndMode,
  transitionStateFromHook,
  markSessionActiveFromHook,
  noteSessionConversationId,
  setSessionAwaitingInput,
  configurePtyHost,
  onTaskReachedTerminal,
  runtimeOnTaskReachedTerminal,
  setOnTaskReachedTerminalHandler,
  broadcastRespawnRequest,
  initWarmProcessManager,
  reapOrphanWarms,
  reserveWarmTaskId,
  onGlobalStateChange,
  hasSessionUserInput,
  configureTransport,
  createDbChatDataOps,
  backfillChatModes,
  setIdleCloseConfigGetter,
  setPtyEnricher,
  type PtySessionWindow
} from '@slayzone/terminal/server'
import { SettingsService } from '@slayzone/settings/server'
import {
  AGENT_STARTUP_SETTING,
  parseAgentStartupMode,
  warmPoolEnabled
} from '@slayzone/terminal/shared'
import {
  createIntegrationOps,
  ensureIntegrationSchema,
  setCredentialCipher
} from '@slayzone/integrations/server'
import { initAiConfigOps } from '@slayzone/ai-config/server'
import { AutomationEngine } from '@slayzone/automations/server'
import { recordDiagnosticEvent, bindDiagnosticsDbs } from '@slayzone/diagnostics/server'
import {
  processEvents,
  initProcessManager,
  createProcess,
  spawnProcess,
  updateProcess,
  stopProcess,
  killProcess,
  restartProcess,
  killTaskProcesses,
  listForTask,
  listAllProcesses,
  subscribeToProcessLogs,
  setProjectCwdResolver
} from '@slayzone/processes/server'
import { createLocalWorkspaceFs } from '@slayzone/file-editor/server'
import { runGhLocally, setGhExecutor } from '@slayzone/worktrees/server'
import { missingRootsForProjects } from './local-computer-roots'
import { seedProjectPaths } from './seed-computer-project-paths'
import { recordComputerProjectPaths } from '@slayzone/computers/server'
// Computer transport: computer gateway + hub-auth + computer resolution, wired
// unconditionally at boot (a hub always accepts computers).
import {
  ghExecResultSchema,
  HubToComputerMethods,
  projectListResultSchema
} from '@slayzone/computer-transport/shared'
import {
  createHubComputerGateway,
  createRoutingChatBackend,
  createRoutingPtyBackend,
  createRemoteFsAdapters,
  createRemoteWorktreeAdapters,
  type HubComputerGateway
} from '@slayzone/computer-transport/server'
import {
  createHubAuth,
  type EntraClientCredential,
  type EntraSsoConfig,
  type HubAuth
} from '@slayzone/hub-auth/server'
import { hubUrlFromAddr } from '@slayzone/platform/hub-addr'
import type { HubSsoBootConfig } from './boot-rules.js'
import { resolveAllowedWebOrigins } from './ws-origin.js'

import { createHubUsersCapability, createJoinTokenAccountLookup } from './hub-users.js'
import { type BreakGlass, createBreakGlass } from './break-glass.js'
import { verifyRestBearer } from './rest-auth.js'
import { webLogin, webSessionCookieSecure } from './web-sessions.js'
import { attachAgentHookRelayConsumer } from './agent-hook-relay-consumer.js'
import { DEFAULT_LOCAL_COMPUTER_NAME } from '@slayzone/computers/server'
import { createComputerAuthAdapters } from './computer-auth.js'
import { createComputerPlacement } from './computer-placement.js'
import { createRemoteMcpEnvProvider } from './remote-mcp-env-provider.js'
import { wireTabFlagRecorders } from './tab-flag-recorders.js'
import { wireHostKillStamp } from './host-kill.js'
import { startIntegrationPollers } from './integrations-pollers.js'
import { wireIntegrationPush } from './integrations-push.js'
import { buildBackupOps } from './backup.js'
import { startSessionRetention } from './session-retention.js'
import { startSsoRecheck } from './sso-recheck.js'
import { createTrpcConnectionRegistry, type TrpcConnectionRegistry } from './trpc-connections.js'
import { createUserAccessRevoker, type UserAccessRevoker } from './user-access.js'
import { getDatabasePathFromEnv } from './db.js'
import { resolveAuthDbPath } from './auth-db.js'
import { createPtyEnricher } from '@slayzone/task-terminals/server'

/**
 * Composition root for the standalone server: populates every transport
 * registry the tRPC routers + REST routes resolve their implementations from.
 *
 * Pure-Node capabilities are wired for real (task ops, integrations, feedback,
 * processes, automation engine). Electron-shell capabilities (clipboard,
 * dialogs, windows, WCV browser, floating agent panel, …) get explicit
 * fail-loud stubs — the renderer never talks to this process until the flip
 * (slice 7), and post-flip those procedures move to the Electron-hosted shell
 * router. pty/chat registries are NOT populated yet (terminal runtime is still
 * electron-coupled — inversion slice); their procedures throw the registry's
 * own "not initialized" error and the pty REST routes 501.
 *
 * Dark-mode discipline: NOTHING here starts a background job. The automation
 * engine is constructed but never `start()`ed (no cron tick, no catchup, no
 * event listeners) — double-firing against the Electron host's live engine on
 * the same database would duplicate runs. Standalone mode may flip these on
 * via `opts.standalone`.
 */

const NOT_AVAILABLE = 'not available in standalone server'

function unavailable(name: string): never {
  throw new Error(`${name} ${NOT_AVAILABLE}`)
}

/**
 * A throwing stand-in for an electron-only function dep. `never[]` params are
 * what makes the constraint accept ANY function shape: parameters are
 * contravariant, and every parameter type is a supertype of `never`.
 */
function stub<T extends (...args: never[]) => unknown>(name: string): T {
  return ((..._args: unknown[]) => unavailable(name)) as unknown as T
}

/**
 * A silently-doing-nothing stand-in, the counterpart to `stub`. Reaching a
 * `stub` is a bug (fail loud); reaching a `noop` is normal — shared code calls
 * these on every host, and off-Electron there is simply nothing to act on (no
 * window chrome, no native menu, no WebContentsView z-order to maintain).
 */
const noop = (): void => {
  // Deliberately empty — see above.
}

export type ServerComposition = {
  notifyRenderer: (change?: TasksChange) => void
  automationEngine: AutomationEngine
  restDeps: RestApiDeps
  /** Late-bound by the server once listen() resolves the actual port. */
  setBoundPort: (port: number) => void
  /** Hub computer gateway (computer-WS multiplexer), or `null` until its async init
   *  resolves (see `computersReady`). A later unit mounts it onto the server's WS
   *  upgrade path. */
  readonly computerGateway: HubComputerGateway | null
  /** Hub-auth (better-auth) instance backing computer enroll/verify, or `null`
   *  until the async init resolves (same as `computerGateway`). */
  readonly hubAuth: HubAuth | null
  /** Resolves once the async computer init (createHubAuth + gateway) has finished.
   *  A later unit awaits this before reading the two fields above / mounting the
   *  gateway. */
  computersReady: Promise<void>
  /** Feed the computer listener's bound WS URL back into the computers registry
   *  (`mintJoinToken` embeds it in a join token). The server host resolves it only
   *  after it binds its port, which happens AFTER composeServer returns — so it's a
   *  late-bound setter, not a constructor arg. */
  setComputerListenerInfo: (info: { hubUrl: string }) => void
  /** Authenticated `/trpc` sockets by account (T-12): server.ts tracks them, revoking
   *  an account closes them. */
  trpcConnections: TrpcConnectionRegistry
  /** Ends what an account holds outside hub-auth (T-12, user-access.ts). */
  userAccess: UserAccessRevoker
  /** Emergency admin access while sign-in is down (break-glass.ts). */
  breakGlass: BreakGlass
}

export function composeServer(opts: {
  db: SlayzoneDb
  dataRoot: string
  /** Standalone (non-supervised) boot: hydrate the process registry and ensure
   *  aux schemas. Supervised (dark, Electron-owned DB): skip — the host did. */
  standalone: boolean
  /** `SLAYZONE_HUB_REQUIRE_LOGIN`: every client must sign in. Decides whether the
   *  REST routes that self-guard (join-token, hub users) demand a bearer, so they
   *  can never disagree with the outer gate about whether this hub authenticates. */
  requireLogin: boolean
  /**
   * `SLAYZONE_HUB_PUBLIC_ADDRESS` (`host[:port]`): where browsers and Entra reach
   * this hub. Becomes hub-auth's base URL. Unset = the loopback constant (below).
   */
  publicAddress?: string
  /** Entra sign-in, when on (`assertSsoCredential` in boot-rules.ts). */
  sso?: HubSsoBootConfig<EntraClientCredential> | null
  /** `SLAYZONE_HUB_ENABLE_PASSWORD` (T-10). Absent = on, the desktop app's hub. */
  enablePassword?: boolean
  /**
   * Flood limits on (T-26): better-auth's rate limiter (hub-auth `rate-limit.ts`) and the
   * unauthenticated `/computers` caps (computer-transport `hub-gateway.ts`). Required, so
   * no caller can forget to decide; `server.ts` passes `boot.reachable`.
   */
  floodLimits: boolean
  /** Separate diagnostics events DB, and the payload-blob dir beside it
   *  (`diagnosticsBlobDirBeside`). When present, `recordDiagnosticEvent` in THIS
   *  process persists (and pre-bind buffered events flush) — without it the
   *  sidecar's diagnostics silently buffer + drop. */
  diagnostics?: { db: SlayzoneDb; blobDir: string }
}): ServerComposition {
  const { db, dataRoot } = opts
  const supervised = !opts.standalone

  // --- Computer transport (always on) -------------------------------------------
  // A hub always accepts computers: the gateway + hub-auth are built and the computer
  // listener binds at startup unconditionally, so a computer can connect (and join
  // tokens can mint) with no mode to flip. Co-located exec still runs IN-PROCESS —
  // a task only routes over the transport when it is explicitly bound to a computer
  // (`resolveTaskComputerId` → null ⇒ local.spawn), so always-on costs the common
  // laptop case nothing at runtime.
  //
  // Single HMAC secret backing hub-auth signing: better-auth's session/cookie
  // signer + the computer enroll/api-key credentials (createHubAuth). (The former
  // per-task agent-hook bearer is gone — a computer-routed hook posts to the
  // computer's own loopback relay, so no per-task token is minted or verified.)
  //
  // SECURITY SEAM (hub-auth-secret hardening): a STANDALONE boot resolves this in
  // bin.ts (applyStandaloneHubConfig → env SLAYZONE_HUB_AUTH_SECRET > config.json
  // computerTransportSecret > generated+persisted 256-bit secret) and sets the env BEFORE
  // composeServer runs. So in standalone the env is ALWAYS present and NEVER the
  // shared dev constant — a per-install unique secret means minted per-task
  // tokens can't be forged across installs (the npm-published bug). We assert
  // that invariant here rather than silently applying the constant. SUPERVISED
  // (Electron host) keeps the historical env-or-dev-constant default untouched:
  // the host controls the env, config.json is never consulted, and a dev/test
  // boot without the env still works exactly as before.
  const DEV_HUB_AUTH_SECRET = 'slayzone-dev-computer-secret'
  if (opts.standalone && !process.env.SLAYZONE_HUB_AUTH_SECRET) {
    // bin.ts must have seeded this; a standalone boot that reached composeServer
    // without it means the resolve step was skipped — fail loud instead of
    // signing tokens with a shared, forgeable constant.
    throw new Error(
      '[slayzone-hub] standalone boot reached composeServer without SLAYZONE_HUB_AUTH_SECRET — ' +
        'applyStandaloneHubConfig() must run first (bin.ts)'
    )
  }
  const hubAuthSecret = process.env.SLAYZONE_HUB_AUTH_SECRET ?? DEV_HUB_AUTH_SECRET
  // Populated by the async computer init (createHubAuth is async — migrations); a
  // later unit reads these after `computersReady` to mount the gateway in server.ts.
  let computerGatewayRef: HubComputerGateway | null = null
  let hubAuthRef: HubAuth | null = null
  // Who a join token is for (T-20), read through the late-bound ref above.
  const joinTokenAccounts = createJoinTokenAccountLookup(() => hubAuthRef)
  let computersReady: Promise<void> = Promise.resolve()
  // Computer listener info the computers router bakes into a join token — bound late
  // by the server host (setComputerListenerInfo) once it knows its own computer URL.
  // Null until then, so `mintJoinToken` fails cleanly if called before the listener
  // is up.
  let computerHubUrl: string | null = null

  // Make this process's diagnostics queryable (pty + agent-pool run here). Bind
  // FIRST so every subsequent recordDiagnosticEvent persists and any buffered
  // pre-bind events flush. No-op if the host didn't pass a diagnostics DB.
  if (opts.diagnostics) {
    bindDiagnosticsDbs({
      settingsDb: db,
      diagnosticsDb: opts.diagnostics.db,
      blobDir: opts.diagnostics.blobDir,
      // The desktop records into this SAME machine-local diagnostics file from
      // its own config copy (the client store), and the Settings UI writes here,
      // over tRPC — so the desktop has to be told, or it keeps recording after
      // the user turns diagnostics off. `bridge` is declared below; this closure
      // only runs on a save, long after composeServer returns.
      //
      // Supervised only, by construction: a standalone hub has no desktop, and a
      // REMOTE hub has no bridge to the client that connects to it — so a remote
      // client's local diagnostics config stays whatever that client set.
      onConfigChanged: (next) => {
        void bridge?.appDeps.diagnosticsConfigChanged(next)
      }
    })
  }

  // Late-bound bound port (set once listen() resolves). Declared up front so the
  // host bridge can report it as the renderer-facing tRPC port (the renderer is
  // connected to THIS side-car, not the host).
  let boundPort = 0

  // --- Desktop capability bridge (supervised only) ---------------------------
  // When supervised by the Electron desktop app, Electron-only capabilities
  // (browser-WCV, clipboard, dialogs, backup, task-windows, floating-agent,
  // native menus, …) can't run in this plain-node process — they forward to the
  // desktop over the bridge, and desktop-originated events (native menus,
  // power-resume) stream back. Truly standalone (no desktop): bridge stays null
  // and the fail-loud stubs apply.
  const desktopCapUrl = getDesktopBridgeCapUrl()
  const bridge: HostBridge | null =
    supervised && desktopCapUrl
      ? createHostBridge(desktopCapUrl, {
          getTrpcPort: () => boundPort,
          token: getDesktopBridgeToken()
        })
      : null

  // --- Cross-domain event buses (this process's own instances) --------------
  const notifyEvents = new TypedEmitter<NotifyEventMap>()
  const automationsEvents = new TypedEmitter<AutomationsEventMap>()
  const telemetryEvents = new TypedEmitter<TelemetryEventMap>()
  // Native menu/app-shortcut events originate in the Electron host; when bridged
  // they arrive on `bridge.menuEvents`, which ALSO carries this process's own
  // emits (the MCP REST task-open route). Standalone: a local inert emitter.
  const menuEvents = bridge ? bridge.menuEvents : new TypedEmitter<MenuEventMap>()
  // Agent-lifecycle (hook-driven turn/state) — the agent-hook REST route lands
  // on THIS process now (pty runs here), so the side-car owns this bus.
  const agentLifecycleEvents = new TypedEmitter<AgentLifecycleEventMap>()

  // Task-row refresh signal. A `TasksChange` names exactly the rows a writer
  // touched, so the renderer patches those instead of reloading the board.
  const notifyTasksChanged = (change?: TasksChange): void => {
    notifyEvents.emit('tasks-changed', change)
  }
  // The generic "something changed" ping (REST/MCP/CLI writes, automations,
  // integrations): refresh tasks AND settings — the caller may have touched
  // either. A caller that names its task rows (`TasksChange`) is a pure
  // task-row write, so it skips the settings refresh: re-reading every
  // settings consumer for a task status flip was the bulk of idle traffic.
  const notifyRenderer = (change?: TasksChange): void => {
    notifyTasksChanged(change)
    if (!change) notifyEvents.emit('settings-changed')
  }

  // Fire-and-forget a best-effort boot task so a rejection can't become an
  // unhandledRejection that kills the whole hub. These are cleanup/optimization
  // steps (startup purge, process-registry hydration) — never load-bearing for
  // serving requests — so a failure (a transiently-locked DB, disk error, or a
  // schema not yet present on a supervised boot the host hasn't finished
  // migrating) must degrade to a logged skip, not a crash. Replaces bare
  // `void asyncThatQueriesTheDb(db)`, which had no catch.
  const bootBestEffort = (label: string, run: () => Promise<unknown>): void => {
    void run().catch((err) => {
      console.warn(
        `[hub] boot step "${label}" skipped: ${err instanceof Error ? err.message : String(err)}`
      )
    })
  }

  // Auth-callback bus — process-local (the sidecar socket server emits, the
  // `app.auth.onCallback` sub consumes; both in THIS process). Set before any
  // WS connection is accepted so the subscription's getAuthEvents() never throws.
  const authEvents = new TypedEmitter<AuthEventMap>()

  setNotifyEvents(notifyEvents)
  setAutomationsEvents(automationsEvents)
  setTelemetryEvents(telemetryEvents)
  setMenuEvents(menuEvents)
  setAgentLifecycleEvents(agentLifecycleEvents)
  setAuthEvents(authEvents)

  // --- Task ops --------------------------------------------------------------
  // Completion-event bus the task ops emit `db:tasks:*:done` on — handed to every
  // caller of the ops (tRPC via setTaskDeps, REST, MCP). Listeners: integration push
  // and the automation engine's tag trigger, both wired below.
  const taskBus = new EventEmitter()
  // Base task runtime adapters (no worktrees override → the task server's local
  // git/fs default stays bound). Extracted so the computer-routing path can re-supply a
  // COMPLETE object (configureTaskRuntimeAdapters shallow-merges over DEFAULTS,
  // not over the prior call — a partial second call would drop these fields).
  const baseTaskAdapters = {
    getDataRoot: () => dataRoot,
    killTaskProcesses,
    killPtysByTaskId,
    recordDiagnosticEvent,
    // PTY lifecycle now lives in THIS process (slice 9), so the task-status
    // hooks must run here: status→terminal kills the task's PTYs (→ pty:exit
    // streams to the renderer), status→in_progress suggests a respawn.
    onReachedTerminal: onTaskReachedTerminal,
    requestPtyRespawn: broadcastRespawnRequest
  }
  configureTaskRuntimeAdapters(baseTaskAdapters)
  // Wire the cross-domain "task reached terminal status" seam to the REAL
  // teardown (kill PTYs + chat transports). PTYs/chats live in THIS process now,
  // so both the task-ops adapter (onReachedTerminal, above) and server-pure
  // callers (integrations sync/pull) must tear them down here — the Electron
  // host's handler only sees its own (empty) session maps post-cutover.
  setOnTaskReachedTerminalHandler(runtimeOnTaskReachedTerminal)
  // The warm pool runs here (initWarmProcessManager below), so this is the one host
  // where a task created to be opened at once can take a warm agent's id.
  // Task ops write task data only — never settings — so they signal tasks-changed
  // alone (`notifyTasksChanged`, not `notifyRenderer`).
  setTaskDeps({
    ops: taskOps,
    onMutation: notifyTasksChanged,
    reserveWarmTaskId,
    bus: taskBus
  })

  // Conversation self-heal + authoritative resolver. `createPty` runs in THIS
  // process post-slice-9, so the healer/resolver seams it calls must be wired
  // here — pre-fix they were registered only in the Electron host, leaving the
  // sidecar's copy null: a stale/phantom conversation id then looped `--resume`
  // ("No conversation found") forever with no self-heal. Same orphaned-listener
  // class as the state-change consumers wired just below.
  registerConversationHealer(db, notifyTasksChanged)
  registerConversationResolver(db)

  // Terminal state-change consumers: task auto-move + the needs_attention flag.
  // Both listened in the Electron host pre-cutover and regressed dead at slice 9
  // — the host's onGlobalStateChange registers on ITS bundled pty-manager copy,
  // whose session map is empty post-inversion. Transitions fire in THIS process
  // (the pty runtime lives here), so the consumers must listen here too.
  onGlobalStateChange(async (sessionId, newState, oldState) => {
    await handleTerminalStateChange(
      db,
      sessionId,
      newState,
      oldState,
      notifyTasksChanged,
      onTaskReachedTerminal
    )

    // Attention flag: PTY finished a turn (running → idle|error). Gated on
    // hasSessionUserInput so a spawn/banner settle never flags the task; the
    // renderer clears the flag when the user navigates into the task.
    try {
      const hasUserInput = hasSessionUserInput(sessionId)
      const changed = await handleAttentionTransition(
        db,
        sessionId,
        newState,
        oldState,
        hasUserInput
      )
      // Every attention decision is recorded: the set path failed silently for
      // months (no observable trace between "turn ended" and "flag in DB"), so
      // gate inputs + outcome must be visible in Diagnostics. Low frequency —
      // fires only on state transitions, a few per turn.
      recordDiagnosticEvent({
        level: 'info',
        source: 'task',
        event: 'task.attention_transition',
        sessionId,
        taskId: sessionId.split(':')[0],
        message: `${oldState} -> ${newState}`,
        payload: { hasUserInput, changed }
      })
      // `needs_attention` lives on this task's row only.
      if (changed) notifyTasksChanged({ taskIds: [sessionId.split(':')[0]] })
    } catch (err) {
      recordDiagnosticEvent({
        level: 'error',
        source: 'task',
        event: 'task.attention_transition_failed',
        sessionId,
        taskId: sessionId.split(':')[0],
        message: (err as Error).message
      })
    }
  })

  // Startup purge (stale soft-deleted + orphaned temp tasks) + artifact file
  // watcher. Both ran from the now-deleted registerTaskHandlers IPC bootstrap and
  // so regressed dead at the Slice 9 cutover; restored here in the data-authority
  // boot. The watcher feeds `artifactWatcherEvents` → the tRPC
  // `artifacts.onContentChanged` subscription. Purge is fire-and-forget.
  // E2E baseline: skip the onboarding wizard. Seeded HERE, deterministically, as
  // part of the boot sequence that ends with this process listening — the host
  // cannot write it (no DB handle) and doing it from there after the sidecar came
  // up was a fire-and-forget race that could leave the first spec staring at the
  // onboarding screen.
  if (process.env.PLAYWRIGHT === '1') {
    bootBestEffort('e2e-onboarding-seed', () =>
      db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('onboarding_completed', 'true')")
    )
  }
  // T-23: session content older than SLAYZONE_HUB_SESSION_RETENTION_DAYS goes, shortly
  // after boot and then daily (session-retention.ts). Off by default — the desktop app's
  // hub creates no timer. Started before the purge below so that, when on, its
  // secure_delete zeroes what the purge frees too.
  startSessionRetention({ db })
  bootBestEffort('startup-purge', () => purgeStaleAndOrphanedTasks(db))
  // Repoint migrated icon rows (absolute legacy paths) at the copies the desktop
  // app placed in this root. No-op on a standalone hub / once already repointed.
  bootBestEffort('project-icons-relocate', async () => {
    const moved = await relocateProjectIcons(db, join(dataRoot, 'project-icons'))
    if (moved > 0) console.log(`[project-icons] repointed ${moved} icon path(s) into ${dataRoot}`)
  })
  // Seed v1 versions for artifacts that predate version history. Idempotent, and
  // a domain txn (`artifact-txns.ts`), so `domainTxnRegistry` dispatches it here
  // unchanged. Ran on the Electron host before — which is why a STANDALONE hub
  // never seeded at all, leaving pre-history artifacts permanently version-less.
  // One-shot: backfill `chatMode` for tasks predating the chat-mode UI, so
  // upgraded users keep their `--allow-dangerously-skip-permissions` behavior
  // instead of suddenly hitting denials. Was host-only; standalone never ran it.
  bootBestEffort('chat-mode-backfill', async () => {
    const stats = await backfillChatModes(db)
    if (stats.updated > 0) {
      console.log(
        `[chat-handlers] backfillChatModes: ${stats.updated}/${stats.scanned} tasks tagged 'bypass'`
      )
    }
  })
  bootBestEffort('artifact-version-seed', async () => {
    const report = await db.namedTxn('artifacts:seed-initial-versions', {
      dataDir: dataRoot,
      artifactsDir: join(dataRoot, 'artifacts')
    })
    if (report.seeded > 0 || report.skippedMissing > 0) {
      console.log(
        `[artifact-versions] seeded=${report.seeded} skippedMissing=${report.skippedMissing}`
      )
    }
  })
  startArtifactWatcher(join(dataRoot, 'artifacts'))

  // --- PTY + chat runtime --------------------------------------------------
  // Configure the pty-host bridge with a STUB window. node-pty spawns in THIS
  // process and its output fans out via `ptyEvents` (tRPC subscriptions), but
  // `ptyCreate`/`requestEnsureAlive` still require a non-null target window
  // (the guard pre-dates the tRPC fan-out; the window is otherwise only used by
  // legacy `webContents.send` redirect, a harmless no-op here). Without this the
  // windowless side-car returns "No window found" and terminals never spawn.
  // Theme: dark default (no nativeTheme off-Electron); ack flows via the tRPC
  // `pty.ackEnsureAlive` mutation, so the command bus stays inert.
  const stubPtyWindow: PtySessionWindow = {
    isDestroyed: () => false,
    webContents: { send: noop, getURL: () => '' }
  }
  configurePtyHost({
    getAllWindows: () => [stubPtyWindow],
    getFocusedWindow: () => stubPtyWindow,
    isDarkTheme: () => true,
    bus: { on: () => undefined }
  })
  // Computer resolution for exec routing: a task's explicit binding, else the
  // connected default computer (sole connected, else the one named
  // DEFAULT_LOCAL_COMPUTER_NAME; several unnamed → refuse to guess). On a hub with
  // login only the work owner's computers count, and every request is gated on that
  // again on its way out (T-19, ./computer-placement.ts).
  //
  // Deliberately simple: the reconnect grace + last-known-computer cache that used to
  // live here existed only to keep the no-fallback invariant from failing spawns
  // during a computer reconnect. With the fallback restored they are dead weight, and
  // a cache that can name a dead computer is worse than none. When enforcement lands
  // (plan phases A→D) this is replaced by a single `listUsableComputers()` authority
  // on the gateway, not by re-adding these.
  let execGateway: HubComputerGateway | null = null
  const placement = createComputerPlacement({
    db,
    requireLogin: opts.requireLogin,
    // `listUsableComputers`, NOT `listComputers`: usable = authenticated + heard from
    // inside the heartbeat window. An open-but-silent socket would otherwise be
    // picked and every dispatch to it would hang until the watchdog reaped it.
    usable: () => execGateway?.listUsableComputers() ?? []
  })
  const resolveExecComputer = placement.forSpec
  /** `rows` whose project this computer's owner owns — every row without login. */
  const ownProjects = async <T extends { id: string }>(
    computerId: string,
    rows: readonly T[]
  ): Promise<T[]> => {
    if (!opts.requireLogin) return [...rows]
    const out: T[] = []
    for (const row of rows) if (await placement.servesProject(computerId, row.id)) out.push(row)
    return out
  }
  /** Effective computer for a task: explicit binding, else connected default. */
  const resolveComputerForTask = placement.forTask
  /** Same, for a project — its default binding, else the connected default. */
  const resolveComputerForProject = placement.forProject

  // Inject computer-aware spawn lookups BEFORE createPtyOps (which captures the
  // lookups at construction). Only `resolveComputerId` is overridden; the mode-row /
  // project-id reads keep their db defaults.
  const dbLookups = createDbPtySpawnLookups(db)
  setPtySpawnLookups({
    ...dbLookups,
    resolveComputerId: (taskId) => resolveComputerForTask(taskId)
  })
  setPtyDeps({ ops: createPtyOps(db), events: ptyEvents })

  // `terminal_tabs.agent_state` recorder — wired HERE for the same reason as the
  // idle-close getter below: the pty/chat runtimes live in THIS process, so the
  // Electron host's copy of the recorder fires for sessions it does not own
  // (i.e. never). Without this, no live agent is ever flagged, so
  // `listAutoRestoreTasks` is always empty and a restart lands every task on the
  // Start gate. See ./tab-flag-recorders.ts.
  wireTabFlagRecorders(db)
  // Host-kill stamp: `onHostKillHandler` fires in whichever process owns the pty
  // sessions, which is this one. The Electron host used to register it against its
  // own (empty) session registry, so the stamp was never written in local mode.
  wireHostKillStamp(db)
  // Pty enricher: decorates PtyInfo with task/tab context for the renderer's
  // session views. Registered on the host before, against a pty runtime it no
  // longer owns — the enricher is consulted where the sessions are, i.e. here.
  setPtyEnricher(createPtyEnricher(db))

  // Idle-close (hibernation) config. Wired HERE because the pty runtime lives in
  // this process (slice 9) — `isHibernateEligible` reads this getter, and with it
  // unset it fails safe to `{ enabled: false }`. It was only ever wired in the
  // Electron host, so when pty moved to the sidecar the entire feature went
  // silently dead: the sweep ran, found no config, and never hibernated anything
  // no matter what the user had set. Same orphaning as the warm pool below.
  //
  // Reads through the SHARED `SettingsService` instance (one per db handle) rather
  // than a private cache: the settings router mutates that same instance, and
  // `set()` is write-through for warmed keys, so a UI toggle is visible to this
  // SYNC getter with no event and no restart. That is exactly the reader the
  // service's own comment was designed for.
  const settingsService = SettingsService.forDatabase(db)
  const IDLE_CLOSE_KEYS = [
    'terminal_auto_close_idle',
    'terminal_idle_close_value',
    'terminal_idle_close_unit'
  ]
  void settingsService.warmCache(IDLE_CLOSE_KEYS).then(
    () => {
      setIdleCloseConfigGetter(() => {
        const value = Number(settingsService.getCached('terminal_idle_close_value')) || 30
        const unit = settingsService.getCached('terminal_idle_close_unit') || 'minutes'
        const unitMs = unit === 'seconds' ? 1_000 : unit === 'hours' ? 3_600_000 : 60_000
        return {
          // Raw `=== '1'` (NOT isLabEnabled, which defaults ON in dev) keeps it
          // strictly opt-in.
          enabled: settingsService.getCached('terminal_auto_close_idle') === '1',
          idleMs: value * unitMs
        }
      })
    },
    () => {
      // Warm failed (transient DB error at boot) — leave the getter unset so the
      // sweep keeps failing safe rather than reading half a config.
    }
  )
  // Warm-process pool (plans/agent-sessions.md): pre-warm one agent per active
  // project so opening a task adopts instantly. PTY runs in THIS process
  // (slice 9), so the manager MUST be initialized here — the renderer's warm
  // tab-count reports (`pty.warmSetProjectTabCounts`) land in this process, not
  // the Electron host. It was only ever wired in the host, so it went dead when
  // pty moved to the sidecar; this restores it. `isEnabled` reads a cached
  // `terminal_agent_startup` (sync; refreshed on settings change): the pool runs in
  // the `auto` and `instant` startup modes, not `manual` (`warmPoolEnabled`).
  let prewarmEnabled = false
  const refreshPrewarm = async (): Promise<void> => {
    try {
      const row = await db.get<{ value?: string }>('SELECT value FROM settings WHERE key = ?', [
        AGENT_STARTUP_SETTING
      ])
      prewarmEnabled = warmPoolEnabled(parseAgentStartupMode(row?.value))
    } catch {
      /* keep last-known value */
    }
  }
  void refreshPrewarm()
  // Every `settings.set` signals its key now: re-read only for this setting (or an
  // unscoped ping, which may have written anything).
  notifyEvents.on('settings-changed', (change) => {
    if (!change || change.keys.includes(AGENT_STARTUP_SETTING)) void refreshPrewarm()
  })
  initWarmProcessManager({
    db,
    isEnabled: () => prewarmEnabled,
    // `settings.set` writes the row but emits no settings-changed, so the cache
    // above would otherwise stay stale until the next boot — i.e. changing the
    // startup mode in Settings did nothing until restart.
    refreshEnabled: refreshPrewarm,
    getProjectRoot: async (projectId) => {
      const row = await db.get<{ path?: string }>('SELECT path FROM projects WHERE id = ?', [
        projectId
      ])
      return row?.path ?? null
    },
    // Warm on the computer this project's tasks will actually resolve to. Reads the
    // project's default binding through the SAME resolver a spawn uses, so a warm
    // agent is never booted on a machine no task will land on.
    resolveComputerId: (projectId) => resolveComputerForProject(projectId)
  })
  setChatDeps({
    // Override ONLY the computer resolution over the db defaults, so a chat spawn
    // resolves the same computer the exec backend will route it to. If chat resolved
    // just the explicit binding while the backend applied the connected default,
    // an unbound task would build a hub-shaped agent env (loopback agent-hook URL)
    // and then run that agent on the computer, where the URL points nowhere.
    ops: createChatOps(db, {
      dataOps: {
        ...createDbChatDataOps(db),
        resolveComputerId: (taskId) => resolveComputerForTask(taskId)
      }
    }),
    queueOps: createChatQueueOps(db),
    events: chatEvents,
    queueEvents: chatQueueEvents
  })

  // --- AI config / context manager --------------------------------------------
  // Build the ai-config + marketplace ops singletons that back the tRPC
  // aiConfigRouter (getAiConfigOps/getMarketplaceOps). Their initializer used to
  // live in the ai-config IPC handler registrar, deleted at the Slice 9 cutover
  // (commit 9c809e8d) WITHOUT moving init here — so every aiConfig.* proc threw
  // "aiConfigOps not initialized" (context manager fully broken). Restore it in
  // the data-authority boot, alongside the other ops.
  initAiConfigOps(db)

  // --- Integrations + feedback ------------------------------------------------
  // Unconditional now. It was standalone-only because the Electron host ran it in
  // supervised mode — the host no longer opens this database, so if the hub skipped
  // it the integrations tables would simply never be created.
  ensureIntegrationSchema(db)
  // Backup lives with the database now. `supervised` gates restore: on a hub a
  // client merely connects to, a whole-DB overwrite plus an app relaunch is not
  // something one client should be able to do to everyone.
  const backupOps = buildBackupOps({
    db,
    dataRoot,
    dbPath: getDatabasePathFromEnv(),
    supervised: !opts.standalone,
    closeDb: () => db.close(),
    appRelaunch: () => bridge?.appDeps.appRelaunch(),
    shellOpenPath: (p) => void (bridge ? bridge.appDeps.shellOpenPath(p) : nativeOpenPath(p))
  })
  setBackupOps(backupOps)
  // Arm the auto-backup timer at boot. v0.35.0 did (`startAutoBackup(db)` in the host's
  // boot); the hub refactor dropped the call, so the timer only started when someone
  // touched the setting — a user with the switch ON silently stopped getting backups.
  bootBestEffort('auto-backup-start', () => backupOps.startAuto())
  const integrationHandles = createIntegrationOps(db)
  setIntegrationOps(integrationHandles)
  // Push local task edits out to Linear/GitHub. Listens on `taskBus` — the SAME
  // bus the task ops emit through (`ipcMain?.emit(...)` with an injected bus).
  // The Electron host held the only listeners, on its real `ipcMain`, which the
  // ops stopped using when they moved here: push-on-edit has been silently dead.
  wireIntegrationPush({
    db,
    taskBus,
    notifyTasksChanged: notifyRenderer,
    pushGithubTask: integrationHandles.pushGithubTask
  })
  // Pull-sync. v0.35.0's host started both pollers at boot; the slice-9 move to the hub
  // took push-on-edit and dropped these, so Linear/GitHub/Jira stopped pulling.
  startIntegrationPollers({ db, notifyTasksChanged: notifyRenderer })
  // Credential encryption needs Electron safeStorage, absent in this
  // ELECTRON_RUN_AS_NODE process. Supervised: forward encrypt/decrypt to the
  // host's safeStorage over the capability bridge (base64 on the wire).
  // Standalone (no host): leave the cipher unset — the plaintext fallback
  // applies, gated purely on cipher availability (no env flag; see
  // integrations/server/credentials.ts allowPlaintextFallback).
  if (bridge) {
    const hostCipher = bridge.appDeps.credentialCipher
    setCredentialCipher({
      isEncryptionAvailable: () => hostCipher.isEncryptionAvailable(),
      encryptString: async (secret) =>
        Buffer.from(await hostCipher.encryptStringToB64(secret), 'base64'),
      decryptString: (encrypted) => hostCipher.decryptStringFromB64(encrypted.toString('base64'))
    })
  }

  // --- Processes ---------------------------------------------------------------
  // This process owns the process-manager runtime: the renderer drives process
  // ops here (supervised) and standalone owns its own. The Electron host no
  // longer inits it in local mode (would double-spawn auto-restart processes).
  bootBestEffort('process-manager-init', () => initProcessManager(db))
  // Project-scoped processes re-resolve their cwd from the project's CURRENT
  // path at every spawn/restart (see doSpawn) instead of trusting whatever
  // was snapshotted into the row at creation — a renamed/moved project
  // folder used to leave every process created before the move permanently
  // pointed at a stale, possibly-deleted directory.
  setProjectCwdResolver(async (projectId) => {
    const row = await db.get<{ path?: string }>('SELECT path FROM projects WHERE id = ?', [
      projectId
    ])
    return row?.path ?? null
  })
  setProcessesDeps({
    create: createProcess,
    spawn: spawnProcess,
    update: updateProcess,
    stop: stopProcess,
    kill: killProcess,
    restart: restartProcess,
    listForTask,
    listAll: listAllProcesses,
    killTask: killTaskProcesses,
    events: processEvents
  })

  // --- Automation engine (constructed, never started — see header) -------------
  const notifyAutomationsChanged = (): void => {
    automationsEvents.emit('changed')
    notifyRenderer()
  }
  const automationEngine = new AutomationEngine(db, notifyAutomationsChanged)
  // Single-owner engine (slice 9): this is the one process that sees EVERY task
  // mutation — the renderer's tRPC mutations AND the CLI/MCP REST data routes
  // both run here, and `taskEvents` is process-local. So start the engine here
  // (cron + task-event + tag triggers). The Electron host's engine is NOT started
  // in local mode — two engines on the shared DB would double-fire. Electron-only
  // `powerMonitor 'resume'` is forwarded over the bridge → runCatchup().
  automationEngine.start(taskBus)
  // Expose the engine's bus so the tRPC `tags.setForTask` path can fire the
  // tag-change trigger (`db:taskTags:setForTask:done`) — closes the slice-7 gap.
  setTaskTriggerBus(taskBus)
  bridge?.powerResume.on('resume', () => void automationEngine.runCatchup())

  // --- App-level deps: forwarded to the host when bridged (supervised), else
  // fail-loud stubs (truly standalone — no Electron host to forward to).
  if (bridge) {
    setAppDeps(bridge.appDeps)
  } else {
    const silentEmitter = new EventEmitter()
    setAppDeps({
      // No desktop to relaunch when standalone — restore is refused here anyway
      // (see buildBackupOps `supervised`), so this should never be reached.
      appRelaunch: stub('appRelaunch'),
      // Never reached: the only caller is gated on `bridge`, which is null here.
      diagnosticsConfigChanged: stub('diagnosticsConfigChanged'),
      // Task/tab browser registry — there are no WebContentsViews here, so every
      // member fails loud rather than pretending an empty registry (which would make
      // `hasTab` answer "no tab" and turn a missing capability into a 404).
      browserTabs: {
        getResolvedTabId: stub('browserTabs.getResolvedTabId'),
        listTabs: stub('browserTabs.listTabs'),
        hasTab: stub('browserTabs.hasTab'),
        waitForRegistration: stub('browserTabs.waitForRegistration'),
        execJs: stub('browserTabs.execJs'),
        loadUrl: stub('browserTabs.loadUrl'),
        getUrl: stub('browserTabs.getUrl'),
        capturePageToFile: stub('browserTabs.capturePageToFile')
      },

      clipboardWriteFilePaths: stub('clipboardWriteFilePaths'),
      clipboardReadFilePaths: stub('clipboardReadFilePaths'),
      clipboardHasFiles: stub('clipboardHasFiles'),

      screenshotCaptureView: stub('screenshotCaptureView'),

      usageFetch: stub('usageFetch'),
      usageTest: stub('usageTest'),

      // Implemented natively (node fs) — the Task Detail loader calls this uncaught
      // to validate a project path, so a throwing stub would fail the whole load.
      filesPathExists: nativePathExists,
      filesSaveTempImage: stub('filesSaveTempImage'),

      // Open URLs in the OS default browser (per-OS exec). The chromium-fork sidecar
      // has no Electron `shell.openExternal`; the renderer's GitHub-OAuth flow opens
      // the authorize URL through this. The desktop-handoff options are Electron-only
      // (WCV nav policy) and irrelevant headless — ignore them.
      shellOpenExternal: (url: string) => nativeOpenExternal(url),
      // Implemented natively (per-OS exec) so the Git/Editor panels' reveal + open
      // actions work on the standalone/fork sidecar without an Electron host.
      shellOpenPath: nativeOpenPath,
      shellShowItemInFolder: nativeShowItemInFolder,

      appGetVersion: () => '0.0.0-server',
      // Real directory (node os.homedir) — it is only a dialog default, and the
      // dialog itself is the stub that fails loud.
      appGetDownloadsDir: async () => join(homedir(), 'Downloads'),
      appGetTrpcPort: async () => boundPort,
      // Graceful read-path defaults (flag getters / cosmetics) — a throwing stub
      // here would break harmless renderer reads post-flip for no gain.
      appIsTestsPanelEnabled: () => false,
      // No desktop client to hold the flag when standalone.
      appSetLabFlag: stub('appSetLabFlag'),
      appIsLoopModeEnabled: () => false,
      appGetZoomFactor: () => 1,
      appGetProtocolClientStatus: () => ({
        scheme: 'slayzone',
        attempted: false,
        registered: false,
        // Closest existing reason: protocol registration is an Electron concern.
        reason: 'dev-skipped' as const
      }),
      appGetRendererZoomFactor: () => null,
      // Real fs probe (pure Node, no Electron) — the stub hardcoded
      // `installed: false`, so the "Install the slay CLI" dialog auto-opened for
      // every fork user even when the CLI was already installed.
      appCheckCliInstalled: () => checkCliInstalled(),
      appInstallCli: stub('appInstallCli'),
      appAdjustZoom: stub('appAdjustZoom'),
      appRestartForUpdate: stub('appRestartForUpdate'),
      appCheckForUpdates: stub('appCheckForUpdates'),
      // Read-path: a renderer served BY this server is asking about the server
      // itself — report self status instead of a supervisor snapshot. It IS the
      // running build, so runningBuildId is its own; there's no supervisor here to
      // compare against disk → never stale.
      appGetSidecarStatus: () => ({
        health: 'ready' as const,
        port: boundPort || null,
        pid: process.pid,
        restarts: 0,
        totalRespawns: 0,
        dbPath: null,
        uptimeMs: Math.round(process.uptime() * 1000),
        runningBuildId: getServerBuildInfo().buildId,
        diskBuildId: null,
        stale: false
      }),
      appRevealSidecarLog: stub('appRevealSidecarLog'),

      appWindowGetContentBounds: () => null,
      appWindowGetDisplayScaleFactor: () => null,
      // Window-cosmetic setters no-op off-window in the Electron host too.
      appWindowSetTrafficLightPosition: noop,
      appWindowSetWindowButtonVisibility: noop,
      appFocusRenderer: noop,
      // No window to raise on a headless host.
      appRaiseMainWindow: noop,
      // No OS nativeTheme off-Electron. Default the preference to "system" so the
      // renderer resolves dark/light from `prefers-color-scheme` (ThemeContext);
      // an explicit light/dark still applies for the session. (Cross-restart
      // persistence of an explicit choice in the fork is a follow-up.)
      themeGetEffective: () => 'dark',
      themeGetSource: () => 'system',
      themeSet: async (pref) => (pref === 'light' ? 'light' : 'dark'),
      // No Electron safeStorage on a headless host — report unavailable so the
      // credential store uses its plaintext fallback (gated on availability). The encrypt/
      // decrypt stubs are never reached because the cipher stays unset standalone.
      credentialCipher: {
        isEncryptionAvailable: async () => false,
        encryptStringToB64: stub('credentialCipher.encryptStringToB64'),
        decryptStringFromB64: stub('credentialCipher.decryptStringFromB64')
      },
      // No native menu on a headless host.
      appRebuildMenuForShortcuts: noop,

      // Chromium-fork GitHub OAuth start. Unlike the Electron host (which blocks
      // waiting for the deep-link and returns the code inline), the fork CANNOT
      // receive the callback here — slayzone:// routes to the C++ shell → the
      // sidecar socket (sidecar-socket.ts) → the `app.auth.onCallback` sub. So we
      // only START the flow: fetch the GitHub authorize URL + PKCE verifier, open
      // the browser, and return `pending`. The renderer stashes the verifier and
      // completes the code when the sub delivers it. Reuses the shared
      // requestGithubSignInStart — same PKCE handshake as the Electron host.
      authGithubSystemSignIn: async (input: { convexUrl: string; redirectTo: string }) => {
        // Backstop for the router's check: no Convex POST, no browser open.
        assertHubIntegrationsEnabled({ op: 'sign_in', detail: { provider: 'github' } })
        // The browser opens on THIS machine (xdg-open): not on a hub that runs nothing
        // itself (T-06). Checked before the Convex POST, not swallowed by the catch.
        assertHubLocalExecEnabled({ op: 'shell.open_external', detail: { provider: 'github' } })
        try {
          if (!input?.convexUrl) return { ok: false as const, error: 'Convex URL is required' }
          if (input.redirectTo !== 'slayzone://auth/callback') {
            return { ok: false as const, error: `Unsupported redirect URI: ${input.redirectTo}` }
          }
          const start = await requestGithubSignInStart(
            // T-99 backstop: only this hub's own Convex, never a client-named host.
            hubGithubSignInConvexUrl(input.convexUrl),
            input.redirectTo,
            'chromium-sidecar'
          )
          const openErr = await nativeOpenExternal(start.redirect)
          if (openErr) {
            return {
              ok: false as const,
              verifier: start.verifier,
              error: `Failed to open browser for GitHub sign-in: ${openErr}`
            }
          }
          return { ok: true as const, verifier: start.verifier, pending: true as const }
        } catch (error) {
          return {
            ok: false as const,
            error: error instanceof Error ? error.message : 'GitHub sign-in failed'
          }
        }
      },
      dialogShowOpenDialog: stub('dialogShowOpenDialog'),
      dialogShowSaveDialog: stub('dialogShowSaveDialog'),

      // Artifact export needs an offscreen BrowserWindow — there is no Electron host
      // to forward to here, so these fail loud rather than silently producing nothing.
      artifactBuildExportHtml: stub('artifactBuildExportHtml'),
      artifactRenderPdfToFile: stub('artifactRenderPdfToFile'),
      artifactRenderPngToFile: stub('artifactRenderPngToFile'),
      // No OS window owns this process — nothing to close.
      windowClose: noop,

      browser: {
        createView: stub('browser.createView'),
        destroyView: stub('browser.destroyView'),
        destroyAllForTask: stub('browser.destroyAllForTask'),
        setBounds: stub('browser.setBounds'),
        setVisible: stub('browser.setVisible'),
        setLocked: stub('browser.setLocked'),
        hideAll: stub('browser.hideAll'),
        showAll: stub('browser.showAll'),
        setHandoffPolicy: stub('browser.setHandoffPolicy'),
        navigate: stub('browser.navigate'),
        goBack: stub('browser.goBack'),
        goForward: stub('browser.goForward'),
        reload: stub('browser.reload'),
        stop: stub('browser.stop'),
        executeJs: stub('browser.executeJs'),
        insertCss: stub('browser.insertCss'),
        setForcedTheme: stub('browser.setForcedTheme'),
        removeCss: stub('browser.removeCss'),
        setZoom: stub('browser.setZoom'),
        focus: stub('browser.focus'),
        findInPage: stub('browser.findInPage'),
        stopFindInPage: stub('browser.stopFindInPage'),
        setKeyboardPassthrough: stub('browser.setKeyboardPassthrough'),
        sendInputEvent: stub('browser.sendInputEvent'),
        openDevTools: stub('browser.openDevTools'),
        closeDevTools: stub('browser.closeDevTools'),
        isDevToolsOpen: stub('browser.isDevToolsOpen'),
        getUrl: stub('browser.getUrl'),
        getBounds: stub('browser.getBounds'),
        getZoomFactor: stub('browser.getZoomFactor'),
        getActualNativeBounds: stub('browser.getActualNativeBounds'),
        getViewVisible: stub('browser.getViewVisible'),
        getViewsForTask: () => [],
        getAllViewIds: () => [],
        listViews: () => [],
        getNativeChildViewCount: () => 0,
        isAllHidden: () => true,
        isFocused: () => false,
        isViewNativelyVisible: () => false,
        getPartition: stub('browser.getPartition'),
        getWebContentsId: stub('browser.getWebContentsId'),
        activateExtension: stub('browser.activateExtension'),
        getExtensions: () => [],
        loadExtension: stub('browser.loadExtension'),
        removeExtension: stub('browser.removeExtension'),
        discoverBrowserExtensions: () => [],
        importExtension: stub('browser.importExtension'),
        reparentToCurrentWindow: stub('browser.reparentToCurrentWindow'),
        // Event-shaped nav-state replay for late onEvent subscribers — none exist
        // in a WCV-less host.
        getAllStateSnapshots: () => [],
        getStateSnapshot: () => null,
        events: silentEmitter as AppDeps['browser']['events']
      },

      floatingAgent: {
        setEnabled: stub('floatingAgent.setEnabled'),
        setSessionId: stub('floatingAgent.setSessionId'),
        setPanelOpen: stub('floatingAgent.setPanelOpen'),
        toggleCollapse: stub('floatingAgent.toggleCollapse'),
        resetSize: stub('floatingAgent.resetSize'),
        detach: stub('floatingAgent.detach'),
        reattach: stub('floatingAgent.reattach'),
        getState: (): FloatingAgentState => ({
          kind: 'disabled',
          sessionId: null,
          mode: null,
          hasCustomSize: false
        }),
        getSession: () => null,
        getConfig: () => null,
        events: silentEmitter as AppDeps['floatingAgent']['events']
      },

      webview: {
        // Browser-tab bookkeeping exists to drive native z-order; there are no
        // native child views here, so registration has nothing to track.
        registerBrowserTab: noop,
        unregisterBrowserTab: noop,
        setActiveBrowserTab: noop,
        closeDevTools: stub('webview.closeDevTools'),
        isDevToolsOpened: () => false,
        disableDeviceEmulation: stub('webview.disableDeviceEmulation'),
        registerShortcuts: stub('webview.registerShortcuts'),
        setKeyboardPassthrough: stub('webview.setKeyboardPassthrough'),
        setDesktopHandoffPolicy: stub('webview.setDesktopHandoffPolicy'),
        openDevToolsBottom: stub('webview.openDevToolsBottom'),
        openDevToolsDetached: stub('webview.openDevToolsDetached'),
        enableDeviceEmulation: stub('webview.enableDeviceEmulation'),
        events: silentEmitter as AppDeps['webview']['events']
      },

      taskWindows: {
        open: stub('taskWindows.open'),
        close: stub('taskWindows.close'),
        list: () => [],
        setPrimaryActive: noop,
        getPrimaryActive: () => null,
        claimPanel: stub('taskWindows.claimPanel'),
        releasePanel: stub('taskWindows.releasePanel'),
        releaseAllForTask: stub('taskWindows.releaseAllForTask'),
        getOwnership: () => [],
        getWindowId: () => null,
        claimAndCloseOther: stub('taskWindows.claimAndCloseOther'),
        claimSession: stub('taskWindows.claimSession'),
        events: silentEmitter as AppDeps['taskWindows']['events']
      }
    })
  }

  // PTY state-machine bridge — shared by the agent-hook HTTP route (restDeps
  // below) AND the computer-relay `event` consumer (wired in the async gateway
  // block), so a local loopback hook and a computer-relayed hook drive the exact
  // same state machine through the exact same authority (processAgentHook).
  const terminalStateBridge = {
    findSession: findSessionByTaskIdAndMode,
    transition: transitionStateFromHook,
    markActive: markSessionActiveFromHook,
    noteConversationId: noteSessionConversationId,
    noteAwaitingInput: setSessionAwaitingInput
  }

  // Drop the session's agent-tree (subagent-liveness tracker) so a killed PTY
  // can't leave a stale subagent id behind forever — without this, a session
  // killed mid-turn (rather than exited cleanly; SIGKILL doesn't let claude
  // fire its own `SessionEnd` hook) permanently sticks resolveState on
  // 'background': spinner never clears though nothing is running.
  //
  // Two listeners, not because `exit` needs an id-reuse guard (it doesn't —
  // see below) but because `exit` is unreliable for the replace/respawn case
  // specifically:
  //  - `exit` fires unconditionally and is ALWAYS safe to act on: both the
  //    natural onExit path (`session.pty !== target` guard) and the kill
  //    watchdog (`sessions.get(sessionId) === session` guard) in pty-manager.ts
  //    only ever invoke the finalizer for the CURRENTLY-registered generation
  //    at that session id — so `exit` can never fire for a generation that has
  //    already been replaced. (Do NOT re-add a `!hasPty` check here: the id is
  //    deliberately still present when `exit` fires — `sessions.delete` is
  //    deferred ~100ms past the emit to let trailing onData drain — so such a
  //    guard is always-false and makes eviction unreachable for every plain
  //    kill, which is the common case this fix targets.)
  //  - The flip side is that `exit` NEVER fires for the OUTGOING generation of
  //    a replace: `createPty`'s replace-existing-session branch calls
  //    `killPty` and immediately spawns the new session on the same id
  //    (without awaiting the old process's actual death), so by the time the
  //    old process's onExit/watchdog would otherwise run, the identity guards
  //    above see the new session and skip the old finalizer entirely — the old
  //    tree would never be evicted through this path. `replacing` fires
  //    SYNCHRONOUSLY at the moment of replacement, strictly before the new
  //    session exists, to cover exactly that gap.
  ptyEvents.on('replacing', (sessionId) => evictAgentTree(sessionId))
  ptyEvents.on('exit', (sessionId) => evictAgentTree(sessionId))

  // T-12: disabling an account (or an Entra refusal) also ends its web sessions, its
  // open /trpc sockets and its computers — see user-access.ts.
  const trpcConnections = createTrpcConnectionRegistry()
  const userAccess = createUserAccessRevoker({
    db,
    getGateway: () => computerGatewayRef,
    connections: trpcConnections
  })
  // Break-glass (break-glass.ts): off unless login is required; closing its account
  // revokes everything the account holds, like disabling any other (T-12).
  const breakGlass = createBreakGlass({
    getAuth: () => hubAuthRef,
    requireLogin: opts.requireLogin,
    revokeUser: (userId) => userAccess.revokeUser(userId)
  })

  // --- REST deps (capability slots; absent → 501) ------------------------------
  const restDeps: RestApiDeps = {
    db,
    notifyRenderer,
    automationEngine,
    agentLifecycle: agentLifecycleEvents,
    menu: menuEvents,
    taskBus,
    // NOTE: no per-task hub-bearer verifier. A computer-routed pty's hook posts to
    // the COMPUTER's own loopback relay (which forwards to the hub over the authed
    // ws channel via the gateway `event` consumer wired below) — the hook never
    // carries a bearer, so there is nothing to verify on the agent-hook route.
    //
    // SECURITY DECISION (intentional — do NOT re-add per-task scoping): the old
    // path minted a per-task bearer and rejected a hook whose token taskId != the
    // payload taskId. That guarded a threat this trust model does not have. The
    // standing trust boundary is TWO layers: (1) the computer→hub ws channel is
    // AUTHENTICATED at enroll (hub-auth api-key), so only an enrolled computer can
    // relay hooks at all; (2) `processAgentHook` only mutates a session that
    // `bridge.findSession(taskId, mode)` actually resolves, so a hook cannot
    // fabricate state for a non-existent session. An enrolled computer already
    // executes the agents and spawns the PTYs for its tasks — a per-hook bearer
    // guarded a side door on a house whose front door it already holds. Re-adding
    // it would also force per-agent bearers back into subprocess env, undoing the
    // byte-identical-local-vs-remote agent env the benign-forwarder redesign won.
    // FUTURE TRIGGER: if computers ever become UNTRUSTED / multi-tenant, restore
    // scoping as a CHANNEL-level claim (computer X may only drive tasks assigned to
    // X), NOT a per-agent bearer.
    // Computer listener info for the loopback `POST /api/computers/join-token` route —
    // the MAIN process's boot-time auto-enroll mints through it (no tRPC client in
    // main). Closed over the SAME late-bound refs the computers registry reads
    // (setComputerListenerInfo feeds them once the /computers listener binds).
    computers: {
      getHubUrl: () => computerHubUrl,
      // Same late-bound ref the tRPC `computers.list` reads, so the REST twin
      // (`GET /api/computers`, what `slay computer ls` calls) can never report a
      // different connection status than the app's Computers tab.
      getGateway: () => computerGatewayRef,
      // Who a join token is for (T-20): the same lookup as `computers.mintJoinToken`.
      findAccount: joinTokenAccounts
    },
    // Operator account management for the `/api/hub/users` routes
    // (`slay hub users add|ls|disable|enable|role`) — the ONLY way to create an
    // account now that public signup is closed (hub-auth auth.ts `disableSignUp`).
    //
    // Closed over the SAME late-bound `hubAuthRef` that `get hubAuth()` below reads,
    // for the same reason the `computers` slot above is getter-shaped: hub-auth is
    // built inside the async `computersReady` IIFE, long after this literal is
    // constructed. `ready` is therefore a function, never a captured value — and it
    // stays false permanently if `createHubAuth` threw (that failure is swallowed
    // into a diagnostic), which the route surfaces as a 503 naming
    // `computer.init_failed`. Disabling also revokes the account's web sessions,
    // sockets and computers (see user-access.ts).
    hubUsers: createHubUsersCapability(() => hubAuthRef, userAccess),
    // Bearer authority for routes that self-guard rather than sitting behind the
    // outer gate — `POST /api/computers/join-token` (so `slay computer mint` can
    // target a hub on another machine) and `/api/hub/users` (so `slay hub users …`
    // keeps working once loopback alone is no longer sufficient).
    //
    // Deliberately the SAME two pieces the outer gate uses — the login switch and
    // `verifyRestBearer` — so a route-level decision can never disagree with the
    // gate about whether this hub authenticates at all, or about which sessions
    // count. Getter-shaped for the usual reason: hub-auth is built inside the
    // async `computersReady` IIFE, long after this literal exists.
    //
    // Keyed on the switch, not on `supervised` and not on a deployment mode: an
    // earlier version derived this from the mode and `hubAuthRef !== null`, which
    // drifted from the outer gate and let a loopback peer (any peer, behind a reverse
    // proxy) mint join tokens and administer accounts with no bearer. False when
    // login is off (the desktop app's hub), which keeps both routes loopback-only
    // there exactly as before.
    restAuth: {
      required: () => opts.requireLogin && hubAuthRef !== null,
      verifyBearer: (headers, cookies) =>
        verifyRestBearer(hubAuthRef, db, headers, cookies, breakGlass)
    },
    // Scoped browser login. Absent only when hub-auth failed to init — a hub with
    // login off has no meaningful login to offer, but the slot itself does not
    // depend on the switch: nothing stops an operator from opening the web UI
    // against such a hub's loopback listener, and doing so should behave the same
    // as any other hub's login.
    webLogin: {
      login: (email, password) =>
        webLogin(hubAuthRef, db, email, password, {
          secure: webSessionCookieSecure(opts.publicAddress)
        })
    },
    // Raise the host window for the CLI/agent `tasks/open` foreground path. The
    // route itself runs HERE (emits the `open-task` menu event on the side-car's
    // bus → renderer); only the window raise is bridged to the Electron host.
    windowActions: bridge
      ? { raiseMainWindow: () => void bridge.appDeps.appRaiseMainWindow() }
      : undefined,
    // Artifact export runs HERE — the `task_artifacts` row it needs is in THIS
    // process's DB. Only the offscreen render crosses to the Electron host, via
    // the same three AppDeps slots the tRPC download path already uses. That is
    // the inversion: previously the whole handler was reverse-proxied to the
    // desktop, which then needed its own connection to the shared DB purely to
    // answer a request this process had just forwarded to it.
    //
    // Absent when standalone (no host to render on) → the routes 501, unchanged.
    artifactExport: bridge
      ? {
          buildExportHtml: (content, mode, title) =>
            bridge.appDeps.artifactBuildExportHtml(content, mode, title),
          renderPdfToFile: (content, mode, title, destPath) =>
            bridge.appDeps.artifactRenderPdfToFile(content, mode, title, destPath),
          renderPngToFile: (content, mode, title, destPath) =>
            bridge.appDeps.artifactRenderPngToFile(content, mode, title, destPath)
        }
      : undefined,
    // Browser routes also run HERE now: they read and write `tasks.browser_tabs`,
    // which is in THIS process's DB, and reach the host only for operations on the
    // live WebContents. That pairing is why they used to be proxied wholesale —
    // the old BrowserAccess handed back a handle, so the handler had to run where
    // the handle was, which is not where the row is.
    //
    // Absent when standalone (no WebContentsViews) → the routes 501, unchanged.
    browser: bridge
      ? {
          // Every member is async — the registry lives on the host, so each one is
          // a bridge round-trip. `BrowserAccess` was made async wholesale rather
          // than cached here on purpose: a snapshot of "which tabs exist" goes
          // stale the moment a user closes one, and these routes exist to drive a
          // live browser.
          getResolvedBrowserTabId: (taskId, tabId) =>
            bridge.appDeps.browserTabs.getResolvedTabId(taskId, tabId),
          listBrowserTabs: (taskId) => bridge.appDeps.browserTabs.listTabs(taskId),
          hasBrowserTab: (taskId, tabId) => bridge.appDeps.browserTabs.hasTab(taskId, tabId),
          waitForBrowserRegistration: (taskId, opts) =>
            bridge.appDeps.browserTabs.waitForRegistration(taskId, opts),
          execJs: (taskId, tabId, code) => bridge.appDeps.browserTabs.execJs(taskId, tabId, code),
          loadUrl: (taskId, tabId, url) => bridge.appDeps.browserTabs.loadUrl(taskId, tabId, url),
          getUrl: (taskId, tabId) => bridge.appDeps.browserTabs.getUrl(taskId, tabId),
          capturePageToFile: (taskId, tabId, destPath) =>
            bridge.appDeps.browserTabs.capturePageToFile(taskId, tabId, destPath)
        }
      : undefined,
    pty: {
      listPtys,
      hasPty,
      getBuffer,
      writePty,
      submitPty,
      killPty,
      requestEnsureAlive,
      subscribeToPtyData,
      subscribeToStateChange,
      onSessionChange,
      getState
    },
    terminalStateBridge,
    processes: {
      listAll: listAllProcesses,
      kill: killProcess,
      subscribeToLogs: subscribeToProcessLogs
    }
  }

  // Open the host event stream + prime the browser snapshot cache. Done last so
  // the local emitters (set via setAppDeps above) exist before frames arrive.
  bridge?.connect()

  // --- Computer gateway + hub-auth (async; dark until a computer enrolls) ----------
  // Built off the main path because `createHubAuth` runs better-auth migrations
  // (async). Ordering is safe: the ledger DB stays local (Model A — never
  // proxied); `setPtySpawnLookups` already ran synchronously above; and the
  // routing backends are read per-spawn via getPtyBackend()/getProcessBackend(),
  // so injecting them once the gateway resolves takes effect for later spawns
  // without a mid-session straddle. With no computer registered every spawn's
  // resolved computerId is null → the routing backends fall through to local, so
  // behavior matches computer-OFF until a computer actually enrolls.
  // Populate the computers registry synchronously (the router may be called before
  // the async gateway init below resolves). The getters read the late-bound refs,
  // so `list` sees the gateway once it exists and `mintJoinToken` sees the
  // URL once the server host feeds it via setComputerListenerInfo.
  setComputersDeps({
    getGateway: () => computerGatewayRef,
    getHubUrl: () => computerHubUrl,
    // Who a join token is for (T-20), over the late-bound hub-auth ref; consulted
    // only on a hub with login. The REST twin reads the same function.
    findAccount: joinTokenAccounts,
    // Live status for the Settings list, from the events the gateway ALREADY
    // emits. Their only consumer until now was exec-proxies disposing pty
    // sessions, so every signal about a computer going away was computed and
    // discarded — the list had no polling and refreshed only on a click.
    //
    // The gateway ref is late-bound, so resolve it when someone subscribes; a
    // subscription opened before init returns an inert unsubscribe rather than
    // capturing null forever.
    subscribeComputerStatus: (listener) => {
      const gateway = computerGatewayRef
      if (!gateway) return () => undefined
      const up = (p: { computer: { computerId: string } }): void =>
        listener({ computerId: p.computer.computerId, connected: true })
      const down = (p: { computerId: string }): void =>
        listener({ computerId: p.computerId, connected: false })
      gateway.events.on('computer-connected', up)
      gateway.events.on('computer-disconnected', down)
      // The watchdog's own event — this is what covers a socket that is open but
      // silent, which no client-side timer could observe.
      gateway.events.on('computer-lost', down)
      return () => {
        gateway.events.off('computer-connected', up)
        gateway.events.off('computer-disconnected', down)
        gateway.events.off('computer-lost', down)
      }
    }
  })

  // Remote-MCP-env provider. Wired synchronously here — it depends only on
  // boundPort (read LAZILY inside the closure), which does not need the async
  // gateway — so a computer-routed pty spawned before `computersReady` resolves still
  // gets a valid hub base URL (used by the `slay` CLI's hub REST access). A task
  // not bound to a computer keeps today's loopback env (the provider short-circuits
  // on a null computerId). See `createRemoteMcpEnvProvider` for hubBaseUrl derivation.
  setRemoteMcpEnvProvider(createRemoteMcpEnvProvider({ getBoundPort: () => boundPort }))

  computersReady = (async () => {
    const sso: EntraSsoConfig | undefined = opts.sso ?? undefined
    const hubAuth = await createHubAuth({
      dbPath: resolveAuthDbPath(dataRoot),
      // better-auth baseURL. A hub other machines reach is addressed by its public
      // address (`https://` unless the host is loopback, rule A1): it is where Entra
      // redirects back to (`<baseURL>/api/auth/callback/microsoft`, registered on the
      // app) and the origin browsers send. Without one — the desktop app's hub and
      // every loopback-only hub — a fixed loopback constant, as before: computers
      // authenticate by api-key/bearer, never by cookies or redirects, so nothing
      // there reads it.
      baseURL: opts.publicAddress
        ? hubUrlFromAddr(opts.publicAddress, 'http')
        : 'http://127.0.0.1:8788',
      // The same browser origins the /trpc origin guard accepts (the public origin plus
      // SLAYZONE_HUB_ALLOWED_WEB_ORIGINS), for better-auth's callback-URL and CSRF
      // checks. Empty on the desktop app's hub (its parent clears both variables).
      trustedOrigins: resolveAllowedWebOrigins(),
      secret: hubAuthSecret,
      ...(sso ? { sso } : {}),
      // Off: no password sign-in or account with a password (hub-auth password.ts).
      ...(opts.enablePassword === false ? { enablePassword: false } : {}),
      rateLimit: opts.floodLimits
    })
    hubAuthRef = hubAuth
    // T-12: with Entra sign-in, every signed-in account is re-checked with Entra hourly
    // (sso-recheck.ts). No-op without SSO — the desktop app's hub creates no timer.
    startSsoRecheck({ auth: hubAuth, sso, db, revoker: userAccess })
    // Identity-based local-computer dedup (Wave3.5-D5): tell the auth adapters
    // which enroll name is the co-located auto-spawned computer so it collapses to
    // ONE deterministic-id row instead of orphaning one per boot. MUST match the
    // name the supervised computer enrolls under — both derive the SHARED
    // DEFAULT_LOCAL_COMPUTER_NAME const (the supervised computer defaults to it when
    // SLAYZONE_SUPERVISED=1), so they can't silently diverge. Remote computers (any
    // other name) keep the fresh-uuid path.
    const localComputerName = DEFAULT_LOCAL_COMPUTER_NAME
    // Assigned further down, once the workspace-fs adapters exist. The
    // `computer-connected` listener below only calls it on a later event, so the
    // forward reference is never read before it is set.
    let widenLocalComputerRoots: (computerId: string, computerName: string) => Promise<void> =
      async () => undefined
    let seedLocalProjectPaths: (computerId: string, computerName: string) => Promise<void> =
      async () => undefined
    let mirrorComputerProjectPaths: (computerId: string) => Promise<void> = async () => undefined
    const computerGateway = createHubComputerGateway({
      ...createComputerAuthAdapters({ db, auth: hubAuth, localComputerName }),
      // Off: no caps on unauthenticated sockets (a hub nobody else can reach).
      ...(opts.floodLimits ? {} : { floodLimits: false as const })
    })
    computerGatewayRef = computerGateway

    // Agent-hook relay consumer (hub/computer split): a computer-routed pty posts its
    // lifecycle hook to the computer's OWN loopback relay, which forwards the raw
    // envelope here over the authed ws channel as a generic `event`
    // (name: 'agent-hook'). Feed it through the SAME `processAgentHook` authority
    // the local loopback HTTP route uses. Extracted + unit-tested in
    // agent-hook-relay-consumer.ts.
    attachAgentHookRelayConsumer(computerGateway, restDeps, terminalStateBridge)

    // Route ALL OS-level exec (pty / chat agents / processes) to a computer. There
    // is no in-process fallback: an unresolved computer raises
    // NoComputerAvailableError so "which machine ran this?" is never an invisible
    // property of DB state.
    //
    // Bind the gateway into the shared `resolveExecComputer` declared above, so the
    // spawn-time lookups and these exec backends resolve IDENTICALLY. Any spec
    // arriving with a null computerId still gets the connected default here.
    execGateway = computerGateway
    setPtyBackend(
      createRoutingPtyBackend({
        gateway: computerGateway,
        resolveComputerId: (spec) => resolveExecComputer(spec.computerId),
        gate: placement.gate
      })
    )
    // Warm agents are the COMPUTER's processes, so they outlive a hub or sidecar
    // restart — unlike the old hub-local pool, whose children died with it. An
    // unclaimed pre-booted agent is a billable LLM process with no owner, so
    // reconcile against the computer's own list on every (re)connect and reap
    // whatever this hub is no longer tracking.
    computerGateway.events.on('computer-connected', ({ computer }) => {
      void reapOrphanWarms(computer.computerId)
      // A nameless descriptor (`hello` reconnect before the roster fills) can
      // never match the local computer's name, so it is correctly skipped.
      void widenLocalComputerRoots(computer.computerId, computer.name ?? '')
      void seedLocalProjectPaths(computer.computerId, computer.name ?? '')
      void mirrorComputerProjectPaths(computer.computerId)
    })
    // Background processes are HUB-OWNED (docs/exec-boundary.md): project-level dev
    // servers, not agents. `doSpawn` is synchronous and also driven by restart
    // timers, so it cannot resolve a computer — its spec always carries
    // `computerId: null`. Routing them therefore is NOT wired: enforcement would
    // block every `pnpm dev`, and running them on the hub is the intended
    // behavior, not a fallback.
    //
    // The routing backend stays available for when they become async and routable
    // (a separate change); until then the in-process default stands.
    // Chat agents route the same way terminal agents do (the computerId is baked
    // into the spec by chat-handlers' resolveComputerId). Before this, chat was the
    // one agent kind the hub always ran in its OWN process, so a chat session
    // could never reach a remote workspace.
    configureTransport({
      backend: createRoutingChatBackend({
        gateway: computerGateway,
        resolveComputerId: (spec) => resolveExecComputer(spec.computerId),
        gate: placement.gate
      })
    })
    // Re-configure with a COMPLETE object (shallow-merge over defaults): re-supply
    // every base field so nothing is dropped, plus the routing worktree adapter.
    configureTaskRuntimeAdapters({
      ...baseTaskAdapters,
      worktrees: createRemoteWorktreeAdapters({
        gateway: computerGateway,
        // Route each task's worktree/git/fs work to the SAME computer its agents
        // spawn on — the seam now carries the taskId, so this is the same
        // resolution the pty/chat backends use (explicit binding, else the
        // connected default computer). Without it a task whose agent runs on a
        // computer had its worktree created on the hub, leaving the agent with a cwd
        // that does not exist on its own machine.
        resolveComputerId: (taskId) => resolveComputerForTask(taskId),
        gate: placement.gate,
        local: defaultWorktreeExecAdapters
      })
    })
    // `gh` authenticates as whoever owns the machine it runs on. Run on the hub,
    // the PR panel spoke as the HUB while the agent pushed as the COMPUTER — two
    // identities for one repository, and only one of them held credentials for it.
    // Route the single `spawnGh` chokepoint; the eleven typed gh functions and
    // their parsing stay here untouched.
    setGhExecutor(async (args, opts) => {
      // The caller's own computer on a hub with login (T-19): `gh` speaks as the
      // machine's account, which must never be someone else's.
      const computerId = await placement.forCaller()
      // No computer = this hub's own disk is the only one, so its own `gh` is the
      // only meaningful identity. Falls through to the local executor — which refuses
      // on a hub with processes switched off (T-06): there, no computer = no `gh`.
      if (computerId == null || !opts.cwd) return runGhLocally(args, opts)
      const res = await computerGateway.request(computerId, HubToComputerMethods.ghExec, {
        args,
        cwd: opts.cwd,
        ...(opts.timeout ? { timeoutMs: opts.timeout } : {}),
        ...(opts.stdin === undefined ? {} : { stdin: opts.stdin })
      })
      return ghExecResultSchema.parse(res)
    })

    // Workspace filesystem — the directory picker, the project-path probe, and
    // (later) the editor panel. Same resolution as the exec backends above, which
    // is the entire point: the picker must browse the filesystem the agent will
    // actually get. Serving these from the hub is what made a task on a remote
    // computer report "No repository path configured" for a path that existed.
    const localWorkspaceFs = createLocalWorkspaceFs()
    // The hub's own maintenance on connect (below): the computer is named by the
    // gateway event, not by a caller, and what it is handed is cut to its owner's
    // projects (T-19).
    const workspaceFs = createRemoteFsAdapters({
      gateway: computerGateway,
      local: localWorkspaceFs
    })
    // What users reach (`workspace.*`, `fileEditor.*`, repo discovery): gated as the
    // caller's own request on a hub with login (T-19).
    const userWorkspaceFs = createRemoteFsAdapters({
      gateway: computerGateway,
      local: localWorkspaceFs,
      gate: placement.gate
    })
    // The supervised local computer defaults its jail to `[homedir()]`, but the
    // desktop app that used to do this work had no jail at all — so routing the
    // filesystem would have silently broken every project outside $HOME. Widen
    // to cover what already works. See ./local-computer-roots.ts for why the unit
    // is the project's PARENT (the default worktree layout is a sibling dir) and
    // why only the LOCAL computer is touched.
    widenLocalComputerRoots = async (computerId: string, computerName: string): Promise<void> => {
      if (computerName !== localComputerName) return
      try {
        const { roots } = await workspaceFs.listRoots(computerId)
        // On the owner's behalf only: a project of anyone else's never widens this
        // computer's jail (T-19). Every project without login.
        const rows = await ownProjects(
          computerId,
          await db.all<{ id: string; path: string | null }>(
            'SELECT id, path FROM projects WHERE path IS NOT NULL'
          )
        )
        const additions = missingRootsForProjects([...new Set(rows.map((r) => r.path))], roots)
        if (additions.length === 0) return
        const applied = await workspaceFs.setAllowedRoots(computerId, [...roots, ...additions])
        recordDiagnosticEvent({
          level: 'info',
          source: 'server',
          event: 'computer.roots_widened',
          message: `local computer jail widened for ${additions.length} project location(s)`,
          payload: { computerId, additions, applied: applied.roots, rejected: applied.rejected }
        })
      } catch (err) {
        // Best-effort: a computer that refuses this is still usable for everything
        // inside its existing jail, and the user can widen it by hand.
        recordDiagnosticEvent({
          level: 'warn',
          source: 'server',
          event: 'computer.roots_widen_failed',
          message: err instanceof Error ? err.message : String(err),
          payload: { computerId }
        })
      }
    }
    // Hand the legacy hub-side `projects.path` values to the local computer once,
    // so deleting that column does not blank every project an existing install
    // has. Local computer only: a remote computer's disk is a different machine, and
    // seeding it with the hub's paths would record mappings wrong by
    // construction — the exact assumption this change removes.
    seedLocalProjectPaths = async (computerId: string, computerName: string): Promise<void> => {
      if (computerName !== localComputerName) return
      try {
        // The owner's projects only, like the roots above: another user's project id
        // and path never reach this computer (T-19).
        const rows = await ownProjects(
          computerId,
          await db.all<{ id: string; path: string | null }>(
            'SELECT id, path FROM projects WHERE path IS NOT NULL'
          )
        )
        if (rows.length === 0) return
        const outcome = await seedProjectPaths(rows, {
          resolve: (projectId) => workspaceFs.resolveProjectPath(computerId, projectId),
          exists: (path) => workspaceFs.pathExists(computerId, path),
          adopt: (projectId, path) => workspaceFs.setProjectPath(computerId, projectId, path)
        })
        if (outcome.adopted.length === 0) return
        recordDiagnosticEvent({
          level: 'info',
          source: 'server',
          event: 'computer.project_paths_seeded',
          message: `local computer adopted ${outcome.adopted.length} project path(s)`,
          payload: { computerId, ...outcome }
        })
      } catch (err) {
        recordDiagnosticEvent({
          level: 'warn',
          source: 'server',
          event: 'computer.project_paths_seed_failed',
          message: err instanceof Error ? err.message : String(err),
          payload: { computerId }
        })
      }
    }
    // Pull the computer's own project→path map into the hub's mirror. The computer
    // authors it; this only records. The mirror serves the one direction a computer
    // cannot answer alone — `resolve-by-path`, i.e. `slay` asking which project
    // its working directory belongs to.
    //
    // Runs AFTER the seed above, on every connect, so a re-pointed checkout or a
    // project the computer has since dropped is reflected rather than remembered.
    mirrorComputerProjectPaths = async (computerId: string): Promise<void> => {
      try {
        const listed = await computerGateway.request(
          computerId,
          HubToComputerMethods.projectList,
          {}
        )
        const parsed = projectListResultSchema.safeParse(listed)
        if (!parsed.success) return
        // A computer places only its owner's projects (T-19): a report naming anyone
        // else's would make paths on it resolve to their project (access.ts `path`).
        await recordComputerProjectPaths(
          db,
          computerId,
          (
            await ownProjects(
              computerId,
              parsed.data.projects.map((p) => ({ id: p.projectId, path: p.path }))
            )
          ).map((p) => ({ projectId: p.id, path: p.path }))
        )
      } catch (err) {
        // A computer too old to answer `project.list`, or one that dropped
        // mid-request. The mirror simply keeps whatever it last knew, and
        // `resolve-by-path` still has the legacy column to fall back on.
        recordDiagnosticEvent({
          level: 'warn',
          source: 'server',
          event: 'computer.project_mirror_failed',
          message: err instanceof Error ? err.message : String(err),
          payload: { computerId }
        })
      }
    }
    setWorkspaceDeps({
      fs: userWorkspaceFs,
      // An explicit computer (the caller's own, with login), else the task's, else the
      // project's, else the caller's default — see ./computer-placement.ts.
      resolveComputer: (target) => placement.forTarget(target),
      // No computer at all = this hub's own disk, which for a supervised hub IS the
      // desktop's. Otherwise only the co-spawned local computer shares a machine
      // with the user; every remote one is somewhere they cannot see.
      isLocalComputer: (computerId) => {
        if (computerId == null) return true
        const computer = computerGateway.listComputers().find((r) => r.computerId === computerId)
        return computer?.name === localComputerName
      }
    })
  })().catch((err) => {
    recordDiagnosticEvent({
      level: 'error',
      source: 'task',
      event: 'computer.init_failed',
      message: err instanceof Error ? err.message : String(err)
    })
  })

  return {
    notifyRenderer,
    automationEngine,
    restDeps,
    setBoundPort: (port: number) => {
      boundPort = port
    },
    get computerGateway(): HubComputerGateway | null {
      return computerGatewayRef
    },
    get hubAuth(): HubAuth | null {
      return hubAuthRef
    },
    computersReady,
    setComputerListenerInfo: (info) => {
      computerHubUrl = info.hubUrl
    },
    trpcConnections,
    userAccess,
    breakGlass
  }
}
