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
export interface BrowserWc {
  getURL: () => string
  loadURL: (url: string) => Promise<void>
  capturePage: () => Promise<{ isEmpty: () => boolean; toPNG: () => Buffer }>
  mainFrame?: { executeJavaScript: (code: string) => Promise<unknown> } | null
}

/** WCV browser-panel access (registry + focus). Electron host only — the
 *  standalone server has no WebContentsViews. Absent → browser routes 501. */
export interface BrowserAccess {
  getBrowserWebContents: (taskId: string, tabId?: string) => BrowserWc | null
  getResolvedBrowserTabId: (taskId: string, tabId?: string) => string | null
  listBrowserTabs: (taskId: string) => Array<{ tabId: string; active?: boolean }>
  waitForBrowserRegistration: (
    taskId: string,
    opts: { tabId?: string; timeoutMs?: number }
  ) => Promise<BrowserWc>
}

/** Renderer-backed artifact export (pdf/png/html). Needs an offscreen renderer —
 *  Electron host only. Absent → export routes 501. */
export interface ArtifactExportAccess {
  buildPdfHtml: (content: string, mode: string, title: string) => string
  buildMermaidPdfHtml: (content: string, title: string) => string
  buildPngHtml: (content: string, mode: string, title: string) => string | null
  renderToPdf: (html: string, isMermaid: boolean) => Promise<Buffer>
  renderToPng: (html: string) => Promise<Buffer>
}

/**
 * Structural result of verifying a per-task hub bearer (hub/runner split). Kept
 * a local structural mirror of `@slayzone/hub-auth`'s `VerifyTaskTokenResult` so
 * this transport package stays hub-auth-free — importing the hub-auth barrel
 * here would drag better-auth + node:sqlite into the Electron main bundle (the
 * host statically value-imports the transport server barrel). The composition
 * root, which already owns hub-auth, binds the real `verifyTaskToken`.
 */
export type TaskTokenVerifyResult =
  | { ok: true; claims: { taskId: string; runnerId: string; iat: number; exp: number } }
  | { ok: false; reason: 'malformed' | 'bad-signature' | 'expired' }

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
   * Per-task hub-bearer verifier (hub/runner split). Set once the runner init resolves
   * (the composition root binds `@slayzone/hub-auth`'s `verifyTaskToken` closed
   * over the runner secret). When set, the agent-hook route enforces a bearer
   * that a runner-routed pty's hook carries (rejecting invalid/expired/scope-
   * mismatched tokens). Absent (runner off — the default) OR when a hook sends no
   * `Authorization` header (every local loopback hook) → the route is unchanged.
   */
  verifyTaskToken?: (token: string) => TaskTokenVerifyResult
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
}

/** Uniform 501 payload for routes whose capability slot is absent in this host. */
export const NOT_AVAILABLE_STANDALONE = 'not available in standalone server'

/** Fallback bus when the host injects none: completion events drop — correct in
 *  the standalone server, where the electron-side listeners don't exist. */
export const NOOP_TASK_BUS: TaskOpsBus = { emit: () => false }
