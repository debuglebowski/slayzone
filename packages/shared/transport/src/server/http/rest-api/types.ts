import type { IncomingHttpHeaders } from 'node:http'
import type { SlayzoneDb } from '@slayzone/platform'
import type { TypedEmitter } from '@slayzone/platform/events'
import type { TerminalMode, TerminalState, PtyInfo } from '@slayzone/terminal/shared'
import type { AgentLifecycleEventMap, MenuEventMap } from '../../app-deps'

/**
 * Pluggable bridge to the PTY state machine. The Electron host wires the live
 * `@slayzone/terminal/electron` impl; tests override with stubs to avoid pulling
 * node-pty / Electron native modules into the test runner. Absent (standalone
 * server until pty lands there): agent-hook still persists conversation ids +
 * diagnostics but skips state transitions.
 */
export interface TerminalStateBridge {
  findSession: (taskId: string, mode: TerminalMode) => string | null
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
  hasPty: (sessionId: string) => boolean
  getBuffer: (sessionId: string) => string | null
  writePty: (sessionId: string, data: string) => boolean
  submitPty: (sessionId: string, data: string) => boolean
  killPty: (sessionId: string) => boolean
  requestEnsureAlive: (
    taskId: string,
    opts: { force: boolean; timeoutMs: number }
  ) => Promise<'ok' | 'already-alive' | 'no-window' | 'timeout' | 'error'>
  subscribeToPtyData: (sessionId: string, cb: (chunk: string) => void) => () => void
  subscribeToStateChange: (sessionId: string, cb: (state: TerminalState) => void) => () => void
  onSessionChange: (cb: () => void) => () => void
  getState: (sessionId: string) => TerminalState | null
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
  kill: (processId: string) => boolean | Promise<boolean>
  subscribeToLogs: (processId: string, cb: (line: string) => void) => () => void
}

/** The minimal WebContents surface the browser routes drive. Structural (NOT
 *  Electron's type — this package must stay electron-free); the Electron host's
 *  real WebContents conforms. */
/**
 * WCV browser-panel access. Electron host only — the standalone server has no
 * WebContentsViews. Absent → browser routes 501.
 *
 * OPS, NOT A HANDLE. This used to hand back a `BrowserWc` (a live `WebContents`
 * in disguise), which forced the whole route to run wherever that object lived —
 * i.e. on the desktop, which then needed its own connection to the shared DB to
 * read the `tasks.browser_tabs` row the same route updates. A `WebContents`
 * cannot cross a wire, but each of these operations can, so the route now runs on
 * the hub (where the row is) and only the operation is bridged.
 *
 * Keyed by `(taskId, tabId)` for the same reason: an identifier survives the
 * crossing, a handle does not. `capturePageToFile` writes to a path rather than
 * returning a buffer so a full-page PNG never travels over the bridge.
 */
export interface BrowserAccess {
  getResolvedBrowserTabId: (taskId: string, tabId?: string) => Promise<string | null>
  listBrowserTabs: (taskId: string) => Promise<Array<{ tabId: string; active?: boolean }>>
  /** True when a live tab is registered — the "is the panel open?" probe. */
  hasBrowserTab: (taskId: string, tabId?: string) => Promise<boolean>
  /** Resolves once a tab registers; rejects on timeout. */
  waitForBrowserRegistration: (
    taskId: string,
    opts: { tabId?: string; timeoutMs?: number }
  ) => Promise<void>
  execJs: (taskId: string, tabId: string | null, code: string) => Promise<unknown>
  loadUrl: (taskId: string, tabId: string | null, url: string) => Promise<void>
  getUrl: (taskId: string, tabId: string | null) => Promise<string | null>
  /** False when the captured image was empty. */
  capturePageToFile: (
    taskId: string,
    tabId: string | null,
    destPath: string
  ) => Promise<boolean>
}

/**
 * Renderer-backed artifact export (pdf/png/html). Needs an offscreen renderer —
 * Electron host only. Absent → export routes 501.
 *
 * Mirrors the `artifact*` AppDeps slots exactly, because that is now how it is
 * wired: the ROUTE runs on the hub (where the `task_artifacts` row lives) and
 * these three methods cross the capability bridge to the desktop. The previous
 * five-primitive shape forced the opposite — the whole handler ran on the
 * desktop, which therefore needed a live connection to the shared DB purely to
 * answer a request the hub had just forwarded to it.
 *
 * Two properties are load-bearing and neither survives a "just expose the
 * primitives" refactor:
 *  - the `*ToFile` methods write straight to destPath, so multi-MB buffers never
 *    cross the bridge;
 *  - HTML building stays on the desktop side of the bridge, because
 *    `buildMermaidPdfHtml` resolves mermaid via `require.resolve` and silently
 *    downgrades to plain-code rendering on a miss — from the side-car bundle it
 *    would miss every time and quietly degrade every mermaid export.
 */
export interface ArtifactExportAccess {
  buildExportHtml: (content: string, mode: string, title: string) => Promise<string>
  renderPdfToFile: (
    content: string,
    mode: string,
    title: string,
    destPath: string
  ) => Promise<void>
  /** False when the mode has no PNG representation (buildPngHtml declined). */
  renderPngToFile: (
    content: string,
    mode: string,
    title: string,
    destPath: string
  ) => Promise<boolean>
}

export interface RestApiDeps {
  db: SlayzoneDb
  /** Cross-cutting "data changed" ping (tasks + settings refetch). */
  notifyRenderer: () => void
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
  terminalStateBridge?: TerminalStateBridge
  processes?: ProcessesAccess
  browser?: BrowserAccess
  /** Raise/show+focus the main window (open-task foreground path). */
  windowActions?: { raiseMainWindow: () => void }
  artifactExport?: ArtifactExportAccess
  /**
   * Runner listener info accessors (hub/runner split, Wave3.5-D3). Set ONLY under
   * the composition root wires it, closed over the same late-bound refs the
   * `runnersRouter`'s `RunnersDeps` reads). Powers `POST /api/runners/join-token`
   * — the loopback channel the Electron MAIN process hits at boot to mint a token
   * for its auto-enrolling local runner (main has no tRPC client to the sidecar).
   * Absent (runner off — the default) → the route 503s and nothing mints, so the
   * default boot is byte-identical.
   */
  runners?: {
    /** `wss://host:port/runners` URL the join token embeds. Null until bound. */
    getHubUrl: () => string | null
    /** Hub TLS leaf sha256 (lowercase hex) the token pins. Null until loaded. */
    getCertFingerprint: () => string | null
  }
  /**
   * Operator account management, powering the loopback-only `/api/hub/users` routes
   * behind `slay hub users add|ls|rm`. Wired ONLY by the hub composition root.
   *
   * A METHOD OBJECT, not the `HubAuth` instance: this package has no
   * `@slayzone/hub-auth` dependency and must not gain one, so better-auth stays
   * behind this seam (`@slayzone/hub-auth`'s users.ts holds the real logic).
   *
   * GETTER-SHAPED for `ready`, because hub-auth is created ASYNCHRONOUSLY (its
   * better-auth migrations run off the main boot path) long after `restDeps` is
   * built synchronously — same reason as the `runners` slot above. `ready()` false
   * means either init has not finished or it FAILED permanently; the routes 503
   * either way. Absent slot (the Electron host) → 503 as well, so a host without
   * hub-auth degrades instead of throwing.
   */
  hubUsers?: {
    /** False until hub-auth has loaded; stays false forever if its init threw. */
    ready: () => boolean
    create: (input: {
      email: string
      name?: string
    }) => Promise<
      | { ok: true; user: { id: string; email: string; name: string; password: string } }
      | { ok: false; reason: 'exists' }
    >
    list: () => Promise<Array<{ id: string; email: string; name: string; createdAt: string }>>
    remove: (email: string) => Promise<'ok' | 'not-found' | 'protected' | 'last-user'>
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
   * `required()` mirrors the gate's own derived flag (`isRemoteMode() && hubAuth
   * != null`), so it is FALSE on every local / supervised / e2e hub. An absent slot
   * (the Electron host) reads as "no bearer authority", which collapses the
   * consuming route to loopback-only — i.e. exactly today's behavior.
   */
  restAuth?: {
    /** Whether THIS hub enforces bearer auth on its HTTP surface. */
    required: () => boolean
    /** Verify an `Authorization: Bearer …` header against the hub's sessions. */
    verifyBearer: (headers: IncomingHttpHeaders) => Promise<boolean>
  }
}

/** Uniform 501 payload for routes whose capability slot is absent in this host. */
export const NOT_AVAILABLE_STANDALONE = 'not available in standalone server'

/** Fallback bus when the host injects none: completion events drop — correct in
 *  the standalone server, where the electron-side listeners don't exist. */
export const NOOP_TASK_BUS: TaskOpsBus = { emit: () => false }
