import type { IncomingMessage } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import type { SlayzoneDb } from '@slayzone/platform'
import type { TypedEmitter } from '@slayzone/platform/events'
import type {
  AgentId,
  BufferSinceResult,
  TerminalState,
  PtyInfo
} from '@slayzone/terminal-contracts'
import type { TasksChange } from '@slayzone/task-contracts'
import type { AgentLifecycleEventMap, UnattachedSession } from '@slayzone/terminal/server'
import type { MenuEventMap } from '../../app-deps'
import type { PrincipalRole } from '@slayzone/trpc-server'
import type { FindJoinTokenAccount, TakeoverCandidate } from '@slayzone/computers/server'
import type { Scope } from '@slayzone/transport/scopes'

/**
 * A resolved REST-side principal — the twin of `ConnectionPrincipal`
 * (`apps/hub/src/hub-trpc-context.ts`) for the `/api/*` surface. Kept as a
 * structural duplicate rather than an import: this package has no dependency
 * on the hub app (only the hub app depends on transport), so the shape is
 * mirrored rather than shared. `scopes` drives the SAME `isPathAllowed`-style
 * decision on this side (see `rest-auth.ts`'s `restAuthAction`). `role` comes from
 * the account row, as on the tRPC side.
 */
export interface RestPrincipal {
  userId: string
  role: PrincipalRole
  orgId?: string | null
  scopes: readonly Scope[]
}

/** One account as `/api/hub/users` returns it (hub-auth `HubUserRow`, mirrored). */
export interface HubUserListRow {
  id: string
  email: string
  name: string
  role: PrincipalRole
  /** ISO-8601 when disabled, else null. */
  disabledAt: string | null
  createdAt: string
}

/**
 * Pluggable bridge to the PTY state machine. The Electron host wires the live
 * `@slayzone/terminal/electron` impl; tests override with stubs to avoid pulling
 * node-pty / Electron native modules into the test computer. Absent (standalone
 * server until pty lands there): agent-hook still persists conversation ids +
 * diagnostics but skips state transitions.
 */
export interface TerminalStateBridge {
  /** The live PTY a hook is about: `tabId` (from the hook context) picks that
   *  tab's session; without it, the task's main tab session of `mode`. */
  findSession: (taskId: string, mode: AgentId, tabId?: string) => string | null
  transition: (sessionId: string, state: TerminalState, hookEvent: string) => boolean
  /** Refresh the silence-timer clock without changing state. Called for hook
   *  events that prove activity but don't transition (PostToolUse, etc.). */
  markActive: (sessionId: string) => boolean
  /** Mirror a captured CLI conversation id onto the live PTY session so the
   *  idle-close (hibernation) gate sees a resumable session for hook-driven
   *  providers (claude-code) that never run `/status`. Optional so test stubs
   *  can omit it. */
  noteConversationId?: (sessionId: string, conversationId: string | null) => void
  /** Set the authoritative "blocked waiting for the user" flag so the idle-close
   *  gate never hibernates an agent paused mid-interaction (which reports the
   *  same 'idle' state as a completed turn). Optional for test stubs. */
  noteAwaitingInput?: (sessionId: string, awaiting: boolean) => void
  /** Publish how many claude background jobs (Bash run_in_background / Monitor)
   *  are still running — sidebar indicator + idle-close guard. Optional for test
   *  stubs. */
  noteBackgroundJobs?: (sessionId: string, count: number) => void
  /** Which of `jobs` still have a live process (claude fires no hook when one
   *  exits). `null` = can't tell → treat all as finished; reject = transient →
   *  ask again. Absent → background jobs are not tracked at all (an indicator
   *  nothing could ever clear is worse than none). */
  probeBackgroundJobs?: (
    sessionId: string,
    jobs: ReadonlyArray<{ id: string; kind: 'shell' | 'monitor'; command: string | null }>
  ) => Promise<string[] | null>
}

/** Structural completion-event bus the task ops emit on (Electron host passes
 *  `ipcMain`; the standalone server passes its own EventEmitter-backed bus). */
export interface TaskOpsBus {
  emit: (channel: string, ...args: unknown[]) => boolean
}

/** PTY runtime access — the module-singleton fns of `@slayzone/terminal/electron`
 *  today (terminal/server after the pty inversion slice). Absent → pty routes 501. */
export interface PtyAccess {
  listPtys: () => Promise<PtyInfo[]> | PtyInfo[]
  /** Registered, including an exited session's ~100ms output-drain window. Only
   *  for following output; to decide on writing or respawning use `hasLivePty`. */
  hasPty: (sessionId: string) => boolean
  /** Registered and its process has not exited. */
  hasLivePty: (sessionId: string) => boolean
  /** The scrollback; read from the session's computer when it owns it. */
  getBuffer: (sessionId: string) => Promise<string | null>
  /** Replay after `afterSeq` (-1 = all), with the seq it reached. */
  getBufferSince: (sessionId: string, afterSeq: number) => Promise<BufferSinceResult | null>
  writePty: (sessionId: string, data: string) => boolean | Promise<boolean>
  submitPty: (sessionId: string, data: string) => boolean | Promise<boolean>
  killPty: (sessionId: string) => boolean
  requestEnsureAlive: (
    taskId: string,
    opts: { force: boolean; timeoutMs: number }
  ) => Promise<'ok' | 'already-alive' | 'no-window' | 'timeout' | 'error'>
  subscribeToPtyData: (sessionId: string, cb: (chunk: string, seq: number) => void) => () => void
  subscribeToStateChange: (sessionId: string, cb: (state: TerminalState) => void) => () => void
  onSessionChange: (cb: () => void) => () => void
  getState: (sessionId: string) => TerminalState | null
  /** Sessions a computer still runs from a previous hub run that are not attached
   *  (terminal unattached-sessions), with the reason. */
  listUnattached: () => Promise<UnattachedSession[]> | UnattachedSession[]
  attachUnattached: (
    computerId: string,
    sessionId: string
  ) => Promise<{ ok: true } | { ok: false; reason: string; detail?: string }>
  killUnattached: (
    computerId: string,
    sessionId: string
  ) => Promise<{ ok: true } | { ok: false; reason: string }>
}

/** A task's agents as the CLI completion guard sees them (PTYs + chats, every
 *  computer). */
export interface TaskAgentsAccess {
  /** Session ids of the task's agents that are mid-reply (`isMidReplyState`). */
  midReplySessionIds: (taskId: string) => Promise<string[]>
}

/**
 * Chat runtime access for the `/api/chat/*` and `/api/agent/*` routes — the hub's
 * chat relay (`getChatDeps()`: ops, queue, events), the shared state bus chat
 * states flow through, and the task's main-agent resolution. Absent → chat
 * routes 501.
 */
export interface ChatAccess {
  deps: () => import('@slayzone/terminal/server').ChatDeps
  /** A session's state changes (`${taskId}:${tabId}`); chat and pty share this bus. */
  onStateChange: (cb: (sessionId: string, state: TerminalState) => void) => () => void
  /** What `startMainAgent` resolves for the task (main tab, mode, folder). */
  launch: (taskId: string) => Promise<import('@slayzone/task/server').MainAgentLaunch>
  /** Start the task's main agent unless one is live (`task.startMainAgent`). */
  startMain: (taskId: string) => Promise<import('@slayzone/task/server').StartMainAgentResult>
}

/** Process-manager access. Mirrors the host's live process registry (module
 *  singleton in the Electron main today). Absent → processes routes 501. */
export interface ProcessesAccess {
  // Minimal structural surface (no index signature — the host's concrete
  // ProcessInfo must stay assignable). Runtime objects carry the full shape;
  // list routes spread the extra fields through untyped.
  listAll: () => Array<{
    id: string
    label: string
    status: string
    logBuffer: string[]
  }>
  /** Delete the row; its run's tree is terminated. */
  remove: (processId: string) => boolean | Promise<boolean>
  /** Stop the run (whole tree, awaited), keep the row. */
  stop: (processId: string) => boolean | Promise<boolean>
  /** Start a row that is not running, with its stored command/cwd. */
  start: (processId: string) => Promise<ProcessStartResult>
  /** Stop (whole tree, awaited) and start again under the same id. */
  restart: (processId: string) => Promise<ProcessStartResult>
  subscribeToLogs: (processId: string, cb: (line: string) => void) => () => void
}

/** Outcome of a process start/restart. Structural copy of the process manager's
 *  `StartProcessResult` (this package does not import the domain's server). */
export type ProcessStartResult =
  | { ok: true; pid: number | null; status: string }
  | {
      ok: false
      reason:
        | 'not-found'
        | 'already-running'
        | 'shutting-down'
        | 'no-computer'
        | 'old-run-survives'
        | 'old-run-unreachable'
    }

type BrowserOrigin = 'hub-machine' | 'elsewhere'

/**
 * Who asks for a browser op: where they run, as THIS hub sees it (see the relay's
 * `BrowserRequestOrigin`), and which user they are. Every op — queries included —
 * reaches only that user's own desktop clients: a task shared with another user never
 * lets one drive (or even see) the other's panel.
 */
export interface BrowserCaller {
  /** The client honours `hub-machine` only from its own local hub; it is how a local
   *  agent keeps file:// navigation and nothing more. */
  origin: BrowserOrigin
  /** The authenticated user; null on a login-off hub (one implicit user). */
  principal: string | null
}

/**
 * The browser panel's live tabs, as the REST browser routes (`slay browser`) reach
 * them. The web views live on a CLIENT; the hub relays each operation to the client
 * that owns the task's tabs (`@slayzone/task-browser` `BrowserRelay`). Absent →
 * browser routes 501.
 *
 * Keyed by `(taskId, tabId)`: an identifier survives the relay, a handle does not.
 * Results come back as values — a screenshot is its PNG bytes, never a path on some
 * machine's disk: the requester (a CLI) may run on another machine than the hub and
 * the client.
 */
export interface BrowserAccess {
  callerOf: (req: IncomingMessage) => BrowserCaller
  /** This hub is a desktop app's own local hub: the only hub whose `hub-machine`
   *  callers a desktop lets load local files (the client decides; this only reports). */
  isDesktopLocalHub: boolean
  /** A desktop app that can host the browser panel is connected for the caller
   *  (any task). False → the routes say a desktop app is needed. */
  hasCapableClient: (caller: BrowserCaller) => boolean
  getResolvedBrowserTabId: (
    caller: BrowserCaller,
    taskId: string,
    tabId?: string
  ) => Promise<string | null>
  listBrowserTabs: (
    caller: BrowserCaller,
    taskId: string
  ) => Promise<Array<{ tabId: string; active?: boolean; isolated?: boolean }>>
  /** True when a live tab the caller may use is registered — the "is the panel open?"
   *  probe. An untrusted caller (see `isTrustedLocal`) may use isolated tabs only. */
  hasBrowserTab: (caller: BrowserCaller, taskId: string, tabId?: string) => Promise<boolean>
  /** A live tab of the caller's user that is NOT isolated: the user's own browser
   *  (their logins, local pages). Only a trusted local caller may use one. */
  isUsersOwnTab: (caller: BrowserCaller, taskId: string, tabId: string) => Promise<boolean>
  /** Resolves once a tab registers; rejects on timeout. */
  waitForBrowserRegistration: (
    caller: BrowserCaller,
    taskId: string,
    opts: { tabId?: string; timeoutMs?: number }
  ) => Promise<void>
  execJs: (
    caller: BrowserCaller,
    taskId: string,
    tabId: string | null,
    code: string
  ) => Promise<unknown>
  loadUrl: (
    caller: BrowserCaller,
    taskId: string,
    tabId: string | null,
    url: string
  ) => Promise<void>
  getUrl: (caller: BrowserCaller, taskId: string, tabId: string | null) => Promise<string | null>
  /** PNG bytes of the visible page; null when the captured image was empty. */
  capturePng: (
    caller: BrowserCaller,
    taskId: string,
    tabId: string | null
  ) => Promise<Uint8Array | null>
}

/**
 * The agent-session ledger as the hook route reaches it (robustness plan §9, P0):
 * on the computer that runs the reporting agent. Absent = no ledger (a host without
 * computers): hooks still drive state, nothing is recorded.
 */
export interface AgentHookSessionLedger {
  /**
   * The computer running the agent that reported: the relaying computer, else the
   * computer of the task's live terminal of that mode/tab, else the task's; null =
   * none known (nothing is recorded).
   */
  computerFor(
    hook: { taskId: string; mode: string; tabId?: string },
    reporterComputerId?: string | null
  ): Promise<string | null>
  /** A SessionStart's session id, with its provenance (see the ledger's `recordHookConversation`). */
  recordHookConversation(
    computerId: string,
    args: {
      taskId: string
      mode: string
      sessionId: string
      source?: string
      spawnToken?: string
      ctxTabId?: string
    }
  ): Promise<{
    origin: import('@slayzone/task-contracts').ConversationOrigin
    tabId: string
  } | null>
  /** A warm (pooled) agent's conversation, on its pooled session row (write-once). */
  confirmSessionConversation(
    computerId: string,
    args: { sessionId: string; observedConversationId: string }
  ): Promise<unknown>
  /** The conversation took its first turn: it can be resumed. */
  markSessionFirstTurn(computerId: string, conversationId: string): Promise<boolean>
}

export interface RestApiDeps {
  /** The agent-session ledger on the reporting agent's computer (hook route). */
  agentSessionLedger?: AgentHookSessionLedger
  captureAgentPrompt?: (
    hook: import('@slayzone/terminal-contracts').ResolvedAgentHook,
    computerId?: string | null
  ) => Promise<void>

  db: SlayzoneDb
  /** Cross-cutting "data changed" ping (tasks + settings refetch). A caller that
   *  touched only known task rows passes them (`TasksChange`): the renderer then
   *  patches those rows, and no settings refetch is signalled. */
  notifyRenderer: (change?: TasksChange) => void
  automationEngine?: { executeManual(id: string): Promise<unknown> }
  /** Legacy test-only broadcast spy. Production hosts should not set this. */
  legacyBroadcast?: (channel: string, ...args: unknown[]) => void
  /** Hook-driven agent lifecycle events. */
  agentLifecycle?: TypedEmitter<AgentLifecycleEventMap>
  /** Menu / app-shortcut bus — the SAME host-owned emitter injected via
   *  `setMenuEvents` (threaded here directly so route handlers never race the
   *  registry's async init). */
  menu?: TypedEmitter<MenuEventMap>
  taskBus?: TaskOpsBus
  pty?: PtyAccess
  chat?: ChatAccess
  /** Completion guard for the CLI's done/update routes. Absent → this host runs
   *  no agents, so none can be mid-reply. */
  taskAgents?: TaskAgentsAccess
  terminalStateBridge?: TerminalStateBridge
  processes?: ProcessesAccess
  browser?: BrowserAccess
  /**
   * Computer listener info accessors (hub/computer split, Wave3.5-D3). Set ONLY under
   * the composition root wires it, closed over the same late-bound refs the
   * `computersRouter`'s `ComputersDeps` reads). Powers `POST /api/computers/join-token`
   * — the loopback channel the Electron MAIN process hits at boot to mint a token
   * for its auto-enrolling local computer (main has no tRPC client to the sidecar).
   * Absent (computer off — the default) → the route 503s and nothing mints, so the
   * default boot is byte-identical.
   */
  computers?: {
    /** `ws(s)://host:port/computers` URL the join token embeds. Null until bound. */
    getHubUrl: () => string | null
    /**
     * The live computer gateway, for `GET /api/computers` connection status. Null until
     * the async computer init resolves, and permanently null if it failed — that route
     * degrades to store rows with `connected: false` rather than erroring, so this
     * stays optional and nothing depends on it being present.
     */
    getGateway?: () => {
      listComputers: () => Array<{ computerId: string }>
      listUsableComputers: () => Array<{ computerId: string }>
      /** Drop a live connection (`PATCH /api/hub/computers` revoking it). */
      disconnect?: (computerId: string, reason: string) => void
    } | null
    /** Who a join token is for, by account id or email (T-20) — the same lookup
     *  `computers.mintJoinToken` uses (`ComputersDeps.findAccount`). */
    findAccount?: FindJoinTokenAccount
    /** Listener addresses of the caller's live direct-link grants
     *  (`GET /api/computers/direct-addresses`). Absent: this hub issues none. */
    directAddresses?: (userId: string | null) => string[]
    /** Chats a computer holds that the hub assigns to another (`ComputersDeps.takeoverCandidates`),
     *  for `GET /api/hub/computers/takeovers`. Absent: none. */
    takeoverCandidates?: () => readonly TakeoverCandidate[]
    /** The desktop app's own computer on its own hub, never replaced (`ComputersDeps.localComputerId`). */
    localComputerId?: string | null
  }
  /**
   * Operator account management, powering the `/api/hub/users` routes behind
   * `slay hub users add|ls|disable|enable|role`. Wired ONLY by the hub composition
   * root. Accounts are disabled, never deleted.
   *
   * A METHOD OBJECT, not the `HubAuth` instance: this package has no
   * `@slayzone/hub-auth` dependency and must not gain one, so better-auth stays
   * behind this seam (`@slayzone/hub-auth`'s users.ts holds the real logic).
   *
   * GETTER-SHAPED for `ready`, because hub-auth is created ASYNCHRONOUSLY (its
   * better-auth migrations run off the main boot path) long after `restDeps` is
   * built synchronously — same reason as the `computers` slot above. `ready()` false
   * means either init has not finished or it FAILED permanently; the routes 503
   * either way. Absent slot (the Electron host) → 503 as well, so a host without
   * hub-auth degrades instead of throwing.
   */
  hubUsers?: {
    /** False until hub-auth has loaded; stays false forever if its init threw. */
    ready: () => boolean
    create: (input: { email: string; name?: string; role?: PrincipalRole }) => Promise<
      | {
          ok: true
          user: { id: string; email: string; name: string; role: PrincipalRole; password: string }
        }
      /** `sso-managed`: an admin account asked for on the Entra setup (IdP-role mode
       *  off). `idp-managed`: any role asked for with the IdP-role mode on. */
      | { ok: false; reason: 'exists' | 'sso-managed' | 'idp-managed' }
    >
    list: () => Promise<HubUserListRow[]>
    /** Keeps every row; revokes the account's better-auth AND web sessions. */
    disable: (
      email: string
    ) => Promise<'ok' | 'not-found' | 'protected' | 'last-user' | 'last-admin'>
    enable: (email: string) => Promise<'ok' | 'not-found' | 'protected' | 'erasure-in-progress'>
    /** `sso-managed`: the Entra setup's app role (IdP-role mode off). `idp-managed`:
     *  the IdP-role mode — 409 ROLES_MANAGED_BY_IDP. */
    setRole: (
      email: string,
      role: PrincipalRole
    ) => Promise<'ok' | 'not-found' | 'protected' | 'last-admin' | 'sso-managed' | 'idp-managed'>
  }
  /**
   * The hub's bearer-auth authority, for routes that accept an OFF-BOX caller who
   * proves a session. Wired ONLY by the hub composition root, from the same
   * late-bound hub-auth ref + `verifyRestBearer` the outer gate
   * (`apps/hub/src/rest-auth.ts`) uses — one authority, reached two ways.
   *
   * A METHOD OBJECT for the same reason as `hubUsers`: this package has no
   * `@slayzone/hub-auth` dependency and must not gain one (`lint:server-boundary`).
   *
   * `required()` mirrors the gate's own derived flag (`!supervised`), so it is
   * FALSE on every supervised hub. An absent slot (the Electron host) reads as
   * "no bearer authority", which collapses the consuming route to
   * loopback-only — i.e. exactly today's behavior.
   *
   * `verifyBearer` returns a {@link RestPrincipal}, not a boolean — a scoped web
   * session and a full better-auth session resolve to DIFFERENT `scopes`, and
   * `restAuthAction` needs that to decide whether a non-`full` caller may reach
   * `/api/*` at all (see its docstring). Checks, in order: a `szw_`-prefixed
   * bearer or cookie against the scoped `web_sessions` table (→ its own
   * `scopes`), else a normal bearer against `verifySession` (→ `['full']`).
   * Never a cookie for the LATTER path — see `restAuthAction`'s CSRF note.
   */
  restAuth?: {
    /** Whether THIS hub enforces bearer auth on its HTTP surface. */
    required: () => boolean
    /** Verify `Authorization: Bearer …` (and, for a scoped web session only, the
     *  session cookie) against the hub's credentials. Null on anything but a
     *  clean hit — absent/blank/invalid/expired/revoked. */
    verifyBearer: (
      headers: IncomingHttpHeaders,
      cookies: Record<string, string>
    ) => Promise<RestPrincipal | null>
  }
  /**
   * Scoped browser login: `POST /api/auth/web-login` calls better-auth's
   * `signInEmail` server-side, discards the resulting FULL session, and mints a
   * scoped `web_sessions` row instead — the browser never holds `full` for even
   * one request. See `apps/hub/src/web-sessions.ts` for the credential itself.
   *
   * Absent slot (the Electron host, or hub-auth init failed) → the route 503s;
   * a supervised hub has no meaningful login to offer since it enforces no
   * auth in the first place.
   */
  webLogin?: {
    /**
     * `setCookie` — the whole `Set-Cookie` value — travels back with the result
     * rather than being built here: this package has no dependency on the hub app
     * (only the hub app depends on transport), and the cookie's name, lifetime and
     * flags (`Secure` only on an https hub) are the hub's (`webSessionCookie`).
     */
    login: (
      email: string,
      password: string
    ) => Promise<{ ok: true; setCookie: string } | { ok: false; error: string }>
  }
}

/** Uniform 501 payload for routes whose capability slot is absent in this host. */
export const NOT_AVAILABLE_STANDALONE = 'not available in standalone server'

/** Fallback bus when the host injects none: completion events drop — correct in
 *  the standalone server, where the electron-side listeners don't exist. */
export const NOOP_TASK_BUS: TaskOpsBus = { emit: () => false }
