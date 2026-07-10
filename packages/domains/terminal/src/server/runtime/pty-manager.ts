import * as pty from 'node-pty'
import { accessSync, constants as fsConstants, existsSync, writeSync } from 'fs'
import { execFile } from 'child_process'
import { randomUUID } from 'node:crypto'
import {
  getPtyHostBridge,
  onPtyHostBus,
  type PtySessionWindow
} from '../pty-host'
import { homedir, platform, userInfo } from 'os'
import type { SlayzoneDb } from '@slayzone/platform'
import { TypedEmitter } from '@slayzone/platform/events'
import {
  containsSubmitEnter,
  DEV_SERVER_URL_PATTERN,
  extractOscTitle,
  SESSION_ID_UNAVAILABLE,
  supportsFreshPreMint
} from '@slayzone/terminal/shared'
import type { TerminalState, PtyInfo, BufferSinceResult } from '@slayzone/terminal/shared'
import { getDiagnosticsConfig, recordDiagnosticEvent } from '@slayzone/diagnostics/server'
import { recordPendingSpawn, prunePendingSpawns, bindSessionToTask } from '@slayzone/task/server'
import { RingBuffer, type BufferChunk } from '../ring-buffer'
import {
  getAdapter,
  type TerminalMode,
  type TerminalAdapter,
  type SpawnConfig,
  type ActivityState,
  type ErrorInfo,
  type ExecutionContext
} from '../adapters'
import { interpolateTemplate } from '../adapters/template-interpolation'
import { parseShellArgs } from '../adapters/flag-parser'
import {
  StateMachine,
  activityToTerminalState,
  shouldRefreshIdleClock,
  shouldFlipToIdle,
  shouldFlipToRunningOnInput,
  shouldHibernate,
  recordWorkingDetection,
  type StateTraceEvent
} from '../state-machine'
import {
  quoteForShell,
  buildExecCommand,
  resolveUserShell,
  getShellStartupArgs,
  wrapShellWithUlimit
} from '../shell-env'
import { shouldShellFallback, buildRecoveryMessage } from '../pty-exit-strategy'
import { computeSyncQueryResponse, type TerminalTheme } from '../sync-query-response'
import { filterBufferData } from '../filter-buffer-data'
import { shouldHonorDetectedError } from '../session-error-gate'
import { resolveSpawnConversation } from '../spawn-conversation'
import { buildMcpEnv } from '../mcp-env'
import { killByTaskId as killChatsByTaskId } from './chat-transport-manager'
import { markSessionUserInput, clearSessionUserInputMark } from '../user-input-tracker'
export { filterBufferData }

/**
 * Transport-agnostic PTY event stream (IPC → tRPC migration, slice 3 / P17).
 * Every `webContents.send('pty:*', ...)` below ALSO fans out through this
 * emitter (dual-emit), so the tRPC `pty` router's subscriptions can mirror the
 * exact IPC event surface while the renderer is still on IPC (renderer cutover
 * is slice 5). The emitter is window-agnostic — it fires regardless of which
 * BrowserWindow currently owns the session — so it carries the GLOBAL event,
 * not a per-window stream. Reuses the shared TypedEmitter (P6).
 */
export type PtyEventMap = {
  data: [sessionId: string, data: string, seq: number]
  'state-change': [sessionId: string, newState: TerminalState, oldState: TerminalState]
  'title-change': [sessionId: string, title: string]
  exit: [sessionId: string, exitCode: number | null, errorCode: string | null]
  prompt: [sessionId: string, prompt: unknown]
  'session-detected': [sessionId: string, conversationId: string]
  'dev-server-detected': [sessionId: string, url: string]
  'respawn-suggested': [taskId: string]
  'ensure-alive': [taskId: string, reqId: number, force: boolean]
  'hibernate-warn': [sessionId: string, graceSecs: number]
  'hibernate-cancelled': [sessionId: string]
  hibernated: [sessionId: string]
  // Per-process CPU/RSS sampler snapshot, keyed by sessionId. Dual-emitted
  // alongside the legacy `pty:stats` webContents.send (host poller).
  stats: [stats: Record<string, { cpu: number; rss: number }>]
  // PTY dimensions need a renderer-side re-fit (e.g. after floating-agent
  // reattach). Dual-emitted alongside the legacy `pty:resize-needed` send.
  'resize-needed': [sessionId: string]
}

export const ptyEvents = new TypedEmitter<PtyEventMap>()

// Database reference (held for future use; legacy from notification feature)
let db: SlayzoneDb | null = null

export function setDatabase(database: SlayzoneDb): void {
  db = database
}

/**
 * Injected by composition root (apps/app) so we can flip the per-tab
 * `was_spawned` flag in `terminal_tabs` without pty-manager importing the
 * task-terminals package directly (would cycle: task-terminals depends on
 * terminal). Called on successful spawn (true) and on exit (false), unless
 * the app is shutting down — in which case we deliberately leave the flag
 * set so the next boot can auto-restart this agent.
 */
type SpawnedSetter = (tabId: string, wasSpawned: boolean) => void
let spawnedSetter: SpawnedSetter | null = null
export function setSpawnedTabRecorder(fn: SpawnedSetter | null): void {
  spawnedSetter = fn
}

/**
 * Injected by composition root to persist a tab's idle-close (hibernation)
 * status to `terminal_tabs.hibernated`, so the "sleeping 💤 / Reopen" affordance
 * survives reload + restart. Set true on hibernate, false on any (re)spawn.
 */
type HibernatedSetter = (tabId: string, hibernated: boolean) => void
let hibernatedSetter: HibernatedSetter | null = null
export function setHibernatedTabRecorder(fn: HibernatedSetter | null): void {
  hibernatedSetter = fn
}

/**
 * Idle-close (hibernation) config, injected by the composition root so
 * pty-manager doesn't import the settings package. Read each sweep tick.
 * Default OFF — feature is opt-in until validated.
 */
type IdleCloseConfig = { enabled: boolean; idleMs: number }
let idleCloseConfigGetter: (() => IdleCloseConfig) | null = null
export function setIdleCloseConfigGetter(fn: (() => IdleCloseConfig) | null): void {
  idleCloseConfigGetter = fn
}

/** Grace window between the hibernate warning and the actual kill. The client
 *  shows a cancellable countdown of the same length; any input/output/touch in
 *  this window aborts. */
const HIBERNATE_GRACE_MS = 10_000

/** Providers whose `--resume` does NOT faithfully restore a prior conversation
 *  must never be hibernated (reopen would start fresh = data loss). Reuses the
 *  shared `SESSION_ID_UNAVAILABLE` set (cursor-agent, opencode — never capture a
 *  session id) plus copilot, whose `--resume={id}` lacks a fresh/resume
 *  distinction (pending real-world validation). */
const HIBERNATE_EXCLUDED_MODES = new Set<string>(['copilot'])
function isResumeEligibleMode(mode: TerminalMode): boolean {
  return !SESSION_ID_UNAVAILABLE.includes(mode) && !HIBERNATE_EXCLUDED_MODES.has(mode)
}

/** A session is the task's main tab iff its row id equals the task id — true for
 *  both id conventions (`${taskId}` and `${taskId}:${taskId}`); panes resolve to
 *  their own tabId. Mirrors `resolveTabRowId`. */
function isMainTabSession(sessionId: string): boolean {
  return resolveTabRowId(sessionId) === taskIdFromSessionId(sessionId)
}

/**
 * App shutdown gate. When true, `finalizeSessionExit` skips clearing
 * `was_spawned` so reboots can restore the warm set. Composition root
 * MUST set this true before invoking `killAllPtys()` during app quit.
 */
let isShuttingDown = false
export function setShuttingDown(v: boolean): void {
  isShuttingDown = v
}

/** Raw decode of the tab row id from a legacy `taskId:tabId` session string. */
function splitTabRowId(sessionId: string): string {
  const colon = sessionId.indexOf(':')
  return colon >= 0 ? sessionId.slice(colon + 1) : sessionId
}

/** Resolve the terminal_tabs row id this PTY session corresponds to. Prefers the
 *  identity map (populated at createPty); falls back to splitting a legacy
 *  `taskId:tabId` sessionId (main session id is `${taskId}`, pane is
 *  `${taskId}:${tabId}`). */
function resolveTabRowId(sessionId: string): string {
  return sessionTabMap.get(sessionId) ?? splitTabRowId(sessionId)
}

export type { BufferChunk }

interface PtySession {
  win: PtySessionWindow
  pty: pty.IPty
  sessionId: string
  taskId: string
  mode: TerminalMode
  adapter: TerminalAdapter
  checkingForSessionError?: boolean
  // Set once a stale `--resume` is detected (provider auto-cleaned the session,
  // issue #90). Suppresses forwarding the CLI's death-throes output (the raw
  // "No conversation found …" line) to the renderer so the friendly "session
  // expired" overlay isn't preceded by a scary red error. Diagnostics buffer
  // still records everything.
  suppressOutput?: boolean
  buffer: RingBuffer
  lastOutputTime: number
  // Timestamp of the last GENUINE user interaction with this terminal, reported
  // by the renderer (real DOM keydown/mouse/wheel/paste/focus — NOT PTY bytes,
  // which carry focus/cursor protocol noise). This is the "user engaged" axis of
  // the idle-close gate. Initialised at spawn so a fresh agent gets a full
  // window; bumped via `touchPty` (the `pty:touch` IPC).
  lastUserInteractionAt: number
  // Captured conversation id for resume-by-id. Set at spawn (existing id),
  // on /status detection, and via the agent hook. Gate for hibernation:
  // never hibernate without one (reopen could not resume).
  conversationId?: string | null
  // Authoritative "agent is blocked waiting for the user" signal from the agent
  // lifecycle hook (claude/codex/antigravity). Set on blocking PreToolUse /
  // PermissionRequest, cleared on resume/done. Needed because "blocked on user"
  // and "turn done" BOTH map to 'idle' for hook-driven agents, so state alone
  // can't distinguish them. NOT sourced from output detectPrompt — that fuzzy
  // signal (e.g. any line ending in '?') gave sticky false positives.
  awaitingUser?: boolean
  // Armed cancellable timer between hibernate-warn and the kill.
  hibernateTimer?: NodeJS.Timeout
  createdAt: number
  state: TerminalState
  // CLI state tracking
  activity: ActivityState
  error: ErrorInfo | null
  // /status monitoring
  inputBuffer: string
  watchingForSessionId: boolean
  statusOutputBuffer: string
  statusWatchTimeout?: NodeJS.Timeout
  sessionIdAutoDetectTimer?: NodeJS.Timeout
  // Dev server URL dedup
  detectedDevUrls: Set<string>
  // Pending partial escape sequence from previous onData chunk
  syncQueryPending: string
  // Last emitted process title (to deduplicate pty:title-change events)
  lastEmittedTitle: string
  // Polls pty.process on interval — decoupled from data flow so idle shells update too
  titlePollInterval?: NodeJS.Timeout
  // Closure-scoped finalizer registered by createPty. Allows external callers
  // (e.g. killPty) to route through the same exit path as natural exits so the
  // renderer reliably receives pty:exit + pty:state-change → 'dead'.
  finalizer?: (exitCode: number) => void
  shutdownWaiters?: Set<(exitCode: number) => void>
  // One-shot trigger label + sample for the next emitted state change.
  // Consumed by emitStateChange so pty.state_change diagnostics include
  // *why* a transition fired (e.g. "detect:✻ Cogitating..." vs "silence-timer").
  pendingTransitionTrigger?: { source: string; preview?: string }
  // Sliding window of recent 'working' detection timestamps. Multi-chunk
  // gate: idle→running on detection path requires ≥2 hits within window
  // to defeat single chrome-redraw bullets.
  workingDetections?: number[]
}

export type { PtyInfo }

const sessions = new Map<string, PtySession>()
// Session-identity seam (plans/agent-sessions.md slice 3): the runtime key is
// becoming an opaque uuid that no longer encodes task/tab. These maps resolve a
// sessionId → its task/tab, populated at createPty. `taskIdFromSessionId` /
// `resolveTabRowId` read them, falling back to a `taskId:tabId` split for legacy
// ids and any session not registered through createPty. A null taskId (pooled
// session) is stored as the sentinel '' so a present-but-taskless entry is
// distinguishable from a missing one on lookup.
const sessionTaskMap = new Map<string, string>()
const sessionTabMap = new Map<string, string>()
const sessionChangeListeners = new Set<() => void>()
const dataListeners = new Map<string, Set<(data: string) => void>>()
const stateChangeListeners = new Map<
  string,
  Set<(newState: TerminalState, oldState: TerminalState) => void>
>()

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function recordPtyCallbackError(
  sessionId: string,
  taskId: string,
  phase: string,
  err: unknown
): void {
  try {
    recordDiagnosticEvent({
      level: 'error',
      source: 'pty',
      event: 'pty.callback_error',
      sessionId,
      taskId,
      message: toErrorMessage(err),
      payload: {
        phase,
        stack: err instanceof Error ? err.stack : null
      }
    })
  } catch {
    // Native node-pty callbacks must never rethrow during Electron shutdown.
  }
}

function guardPtyCallback<T extends unknown[]>(
  sessionId: string,
  taskId: string,
  phase: string,
  cb: (...args: T) => void
): (...args: T) => void {
  return (...args) => {
    try {
      cb(...args)
    } catch (err) {
      recordPtyCallbackError(sessionId, taskId, phase, err)
      try {
        console.error(`[pty-manager] ${phase} callback threw for ${sessionId}:`, err)
      } catch {
        // ignore
      }
    }
  }
}

/** Subscribe to live PTY output. Returns unsubscribe function. */
export function subscribeToPtyData(sessionId: string, cb: (data: string) => void): () => void {
  if (!dataListeners.has(sessionId)) dataListeners.set(sessionId, new Set())
  dataListeners.get(sessionId)!.add(cb)
  return () => {
    dataListeners.get(sessionId)?.delete(cb)
  }
}

/** Register a callback for session create/destroy events. Returns unsubscribe function. */
export function onSessionChange(cb: () => void): () => void {
  sessionChangeListeners.add(cb)
  return () => sessionChangeListeners.delete(cb)
}

/** Subscribe to state changes for a specific session. Returns unsubscribe function. */
export function subscribeToStateChange(
  sessionId: string,
  cb: (newState: TerminalState, oldState: TerminalState) => void
): () => void {
  if (!stateChangeListeners.has(sessionId)) stateChangeListeners.set(sessionId, new Set())
  stateChangeListeners.get(sessionId)!.add(cb)
  return () => {
    stateChangeListeners.get(sessionId)?.delete(cb)
  }
}

type GlobalStateChangeListener = (
  sessionId: string,
  newState: TerminalState,
  oldState: TerminalState
) => void | Promise<void>

const globalStateChangeListeners = new Set<GlobalStateChangeListener>()

/** Subscribe to state changes for ALL sessions. Returns unsubscribe function. */
export function onGlobalStateChange(cb: GlobalStateChangeListener): () => void {
  globalStateChangeListeners.add(cb)
  return () => {
    globalStateChangeListeners.delete(cb)
  }
}

/**
 * Fire global state-change listeners for a session not owned by pty-manager
 * (e.g. chat-transport sessions). Lets task-automation and other main-side
 * subscribers react to chat activity through the same channel as PTY.
 *
 * Awaits async listeners (DB writes now run through the SQLite worker) so
 * callers can observe their effects on resolve — the test hook relies on this.
 */
export async function notifyGlobalStateListeners(
  sessionId: string,
  newState: TerminalState,
  oldState: TerminalState
): Promise<void> {
  await Promise.all(
    [...globalStateChangeListeners].map(async (cb) => {
      try {
        await cb(sessionId, newState, oldState)
      } catch (err) {
        recordPtyCallbackError(
          sessionId,
          taskIdFromSessionId(sessionId),
          'global-state-listener',
          err
        )
      }
    })
  )
}

/**
 * Fires when a PTY input line is submitted (Enter pressed) with non-empty
 * buffered input. Used by agent-turns to mark turn boundaries in xterm-mode
 * tabs (where structured agent events are unavailable).
 *
 * Args: sessionId (`${taskId}` or `${taskId}:${tabId}`), taskId, line (the
 * accumulated stdin since the previous Enter, raw — caller should trim).
 */
const inputSubmitListeners = new Set<(sessionId: string, taskId: string, line: string) => void>()

export function onPtyInputSubmit(
  cb: (sessionId: string, taskId: string, line: string) => void
): () => void {
  inputSubmitListeners.add(cb)
  return () => {
    inputSubmitListeners.delete(cb)
  }
}

function emitInputSubmit(sessionId: string, taskId: string, line: string): void {
  for (const cb of inputSubmitListeners) {
    try {
      cb(sessionId, taskId, line)
    } catch (err) {
      console.error('[pty-manager] inputSubmit listener threw:', err)
    }
  }
}

function notifySessionChange(): void {
  for (const cb of sessionChangeListeners) {
    try {
      cb()
    } catch (err) {
      recordPtyCallbackError('session-change', 'session-change', 'session-change-listener', err)
    }
  }
}
/**
 * Diagnostic tracer for every state-machine decision. Lets us see WHY a
 * pending `running → idle` transition (e.g. from a Stop hook) gets dropped:
 * was it canceled by a subsequent same-target request, by an unregister, or
 * did it fire and the state still didn't reach the renderer? Pure
 * observation — must not influence state.
 *
 * Temporary instrumentation for the "PTY stuck on running after ESC" bug.
 * Strip once the root cause is fixed and the fix has a regression test.
 */
function traceStateMachine(event: StateTraceEvent): void {
  const session = sessions.get(event.sessionId)
  const taskId = session?.taskId
  const payload: Record<string, unknown> = { kind: event.kind }
  if (event.kind === 'request') {
    payload.from = event.fromState
    payload.to = event.toState
    payload.hadPending = event.hadPending
  } else if (event.kind === 'skipped_same') {
    payload.state = event.state
  } else if (event.kind === 'immediate' || event.kind === 'fired') {
    payload.from = event.fromState
    payload.to = event.toState
  } else if (event.kind === 'queued') {
    payload.from = event.fromState
    payload.to = event.toState
    payload.debounceMs = event.debounceMs
  } else if (event.kind === 'canceled') {
    payload.canceledTarget = event.canceledTarget
    payload.reason = event.reason
  }
  recordDiagnosticEvent({
    level: 'info',
    source: 'pty',
    event: `pty.state_machine_${event.kind}`,
    sessionId: event.sessionId,
    taskId,
    message: event.kind,
    payload
  })
}

const stateMachine = new StateMachine((sessionId, newState, oldState) => {
  const session = sessions.get(sessionId)
  if (!session) return
  // Sync session.state for debounced transitions (timer fires after transitionState returns)
  session.state = newState
  // Agent resumed work / left idle → abort any pending hibernate countdown.
  // (The idle clock itself is the user-interaction axis, owned by the client.)
  if (newState !== 'idle') cancelHibernateCountdown(session)
  emitStateChange(session, sessionId, newState, oldState)
}, traceStateMachine)

// Maximum buffer size (5MB) per session
const MAX_BUFFER_SIZE = 750 * 1024

// Idle timeout in milliseconds (60 seconds)
const IDLE_TIMEOUT_MS = 60 * 1000

// Check interval for idle sessions (10 seconds)
const IDLE_CHECK_INTERVAL_MS = 10 * 1000
const STARTUP_TIMEOUT_MS = 10 * 1000
const FAST_EXIT_FALLBACK_WINDOW_MS = 2000
const SESSION_ID_WATCH_TIMEOUT_MS = 5000
// Delay after first PTY output before auto-sending session detection command
const SESSION_ID_AUTO_DETECT_DELAY_MS = 3000

// Exit code used when a PTY is killed programmatically by the app (e.g. task reached
// terminal status). Distinct from -1 (unknown) so diagnostics and renderer logic
// can distinguish intentional host kills from crashes.
export const PTY_EXIT_KILLED_BY_HOST = -2

// Watchdog delay — if SIGKILL doesn't result in onExit firing within this window,
// the finalizer is invoked explicitly so the renderer never observes a zombie session.
const KILL_FINALIZE_WATCHDOG_MS = 500
const DEFAULT_SHUTDOWN_TERM_GRACE_MS = 1500
const DEFAULT_SHUTDOWN_HARD_TIMEOUT_MS = 5000

export interface PtyShutdownOptions {
  termGraceMs?: number
  hardTimeoutMs?: number
}

export interface PtyShutdownResult {
  total: number
  exited: number
  killed: number
  timedOut: number
  errors: Array<{ id: string; phase: string; message: string }>
}

// Reference to main window for sending idle events
let mainWindow: PtySessionWindow | null = null

// Interval reference for idle checker
let idleCheckerInterval: NodeJS.Timeout | null = null

// Host-level callback invoked when a task reaches a terminal status (the single
// invariant entry point `onTaskReachedTerminal`). Lets the app persist the kill
// timestamp into the DB so the revive flow can decide between resuming and
// starting a fresh AI conversation. Mode is resolved by the handler from the
// task's current terminal_mode — not passed in — so it covers PTY and chat
// modes alike and matches what the revive decision reads.
let onHostKillHandler: ((taskId: string) => void) | null = null

export function setOnHostKillHandler(handler: ((taskId: string) => void) | null): void {
  onHostKillHandler = handler
}

/** App-provided self-heal for a stored conversation id whose on-disk transcript
 *  may be gone (a phantom from the old eager commit, or retention pruning).
 *  Invoked just before a resume builds `--resume <id>`; returns the id to actually
 *  resume — repointed to the task's real conversation (recorded history, or a
 *  near-certain orphan transcript) — or the original id when nothing safe is
 *  found (→ the honest "session expired" overlay). Registered from the app
 *  (apps/app) because the decision needs task-DB access, and the package
 *  dependency runs task → terminal (so terminal/main must not import task/main).
 *  No-op when unset. See plans/conv-id-robustness-v2.md. */
export interface ConversationHealRequest {
  taskId: string
  mode: TerminalMode
  cwd: string
  storedId: string
}
export type ConversationHealer = (
  req: ConversationHealRequest
) => Promise<{ id: string | null; healed: boolean }>

let conversationHealer: ConversationHealer | null = null

export function setConversationHealer(handler: ConversationHealer | null): void {
  conversationHealer = handler
}

/** Resolve the authoritative conversation id for a (task, mode) from the
 *  append-only `task_conversations` ledger. `createPty` calls this when the
 *  renderer passed no `existingConversationId`, so MAIN — not a possibly-stale
 *  or boot-time-null renderer hint — is the authority for the fresh-vs-resume
 *  decision. Without it, a missing hint silently mints a fresh session that
 *  durably shadows a conversation main already knew about (the restart-clobber
 *  bug). Registered from the app (apps/app) for the same task → terminal
 *  dependency reason as the healer. No-op when unset. */
export type ConversationResolver = (req: {
  taskId: string
  mode: TerminalMode
}) => Promise<string | null>

let conversationResolver: ConversationResolver | null = null

export function setConversationResolver(handler: ConversationResolver | null): void {
  conversationResolver = handler
}

/** Raw decode of the task id from a legacy `taskId:tabId` session string. */
function splitTaskId(sessionId: string): string {
  return sessionId.split(':')[0] || sessionId
}

/** Resolve the task id owning this PTY session. Prefers the identity map
 *  (populated at createPty); falls back to splitting a legacy `taskId:tabId`
 *  sessionId. A pooled session is registered with the '' sentinel → returns ''
 *  (no owning task), never a bogus uuid-as-taskId. */
function taskIdFromSessionId(sessionId: string): string {
  return sessionTaskMap.get(sessionId) ?? splitTaskId(sessionId)
}

// Theme colors used to respond to OSC 10/11/12 color queries synchronously.
// Set by the renderer via pty:set-theme IPC whenever the theme changes.
let currentTerminalTheme: TerminalTheme = {
  foreground: '#ffffff',
  background: '#000000',
  cursor: '#ffffff'
}

export function setTerminalTheme(theme: TerminalTheme): void {
  currentTerminalTheme = theme
}

// Answer timing-critical terminal queries synchronously. See computeSyncQueryResponse
// in ./sync-query-response for the pure logic. Writes responses via writeSync(fd)
// rather than pty.write() (which is async) so they reach the program in the same
// read loop iteration — an async response would land after the program had moved
// on and show up as garbage bytes in stdin.
function interceptSyncQueries(session: PtySession, data: string): string {
  const input = session.syncQueryPending + data
  const { response, forwarded, pendingPartial } = computeSyncQueryResponse(
    input,
    currentTerminalTheme
  )
  session.syncQueryPending = pendingPartial

  if (response) {
    try {
      writeSync((session.pty as unknown as { fd: number }).fd, response)
    } catch {
      session.pty.write(response)
    }
  }

  return forwarded
}

function stripAnsiForSessionParse(data: string): string {
  return data
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences
    .replace(/\x1b\[[?0-9;:]*[ -/]*[@-~]/g, '') // CSI sequences
    .replace(/\x1b[()][AB012]/g, '') // Character set sequences
}

/** Send a PTY event to every live renderer window (excludes the splash `data:`
 *  window). For events that represent a GLOBAL session fact rather than a
 *  per-window stream — e.g. hibernation, which any window's sidebar must
 *  reflect regardless of who currently owns the session's IPC channel. */
function broadcastPtyEvent(channel: string, ...args: unknown[]): void {
  for (const win of getPtyHostBridge().getAllWindows()) {
    if (win.isDestroyed() || win.webContents.getURL().startsWith('data:')) continue
    try {
      win.webContents.send(channel, ...args)
    } catch {
      // Window torn down mid-send — ignore.
    }
  }
}

// Emit state change via IPC
function emitStateChange(
  session: PtySession,
  sessionId: string,
  newState: TerminalState,
  oldState: TerminalState
): void {
  const trigger = session.pendingTransitionTrigger
  session.pendingTransitionTrigger = undefined
  recordDiagnosticEvent({
    level: 'info',
    source: 'pty',
    event: 'pty.state_change',
    sessionId,
    taskId: taskIdFromSessionId(sessionId),
    message: `${oldState} -> ${newState}`,
    payload: {
      oldState,
      newState,
      triggerSource: trigger?.source,
      triggerPreview: trigger?.preview
    }
  })

  ptyEvents.emit('state-change', sessionId, newState, oldState)
  if (session.win && !session.win.isDestroyed()) {
    try {
      session.win.webContents.send('pty:state-change', sessionId, newState, oldState)
    } catch {
      /* Window destroyed */
    }
  }

  // Notify REST API subscribers
  const listeners = stateChangeListeners.get(sessionId)
  if (listeners) {
    for (const cb of listeners) {
      try {
        cb(newState, oldState)
      } catch (err) {
        recordPtyCallbackError(sessionId, taskIdFromSessionId(sessionId), 'state-listener', err)
      }
    }
  }

  // Notify global subscribers. Listeners may be async (DB writes via the SQLite
  // worker); fire-and-forget here but route both sync throws and async
  // rejections to the error recorder so neither escapes as an unhandled crash.
  for (const cb of globalStateChangeListeners) {
    try {
      void Promise.resolve(cb(sessionId, newState, oldState)).catch((err) => {
        recordPtyCallbackError(
          sessionId,
          taskIdFromSessionId(sessionId),
          'global-state-listener',
          err
        )
      })
    } catch (err) {
      recordPtyCallbackError(
        sessionId,
        taskIdFromSessionId(sessionId),
        'global-state-listener',
        err
      )
    }
  }
}

// Delegate state transitions to the extracted state machine
// (immediate for 'running', 100ms debounce for others)
function transitionState(sessionId: string, newState: TerminalState): void {
  const session = sessions.get(sessionId)
  if (!session) return
  // Keep session.state in sync for code that reads it directly
  stateMachine.setState(sessionId, session.state)
  stateMachine.transition(sessionId, newState)
  // Update session.state from state machine (immediate transitions update synchronously)
  session.state = stateMachine.getState(sessionId) ?? session.state
}

// Check for inactive sessions and transition state (fallback timeout)
function checkInactiveSessions(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return

  const now = Date.now()
  for (const [sessionId, session] of sessions) {
    const timeout = session.adapter.idleTimeoutMs ?? IDLE_TIMEOUT_MS
    if (shouldFlipToIdle(session.state, session.lastOutputTime, now, timeout)) {
      session.activity = 'unknown'
      session.pendingTransitionTrigger = {
        source: 'silence-timer',
        preview: `${Math.round((now - session.lastOutputTime) / 1000)}s since last activity-refresh (timeout ${timeout}ms)`
      }
      transitionState(sessionId, 'idle')
    }

    // Idle-close: arm a cancellable countdown on the main agent tab once it has
    // been idle past the window. The kill itself (→ Start screen) happens after
    // the grace, unless input/output/touch cancels it first.
    if (!session.hibernateTimer && isHibernateEligible(session)) {
      ptyEvents.emit('hibernate-warn', sessionId, HIBERNATE_GRACE_MS / 1000)
      if (!session.win.isDestroyed()) {
        try {
          session.win.webContents.send('pty:hibernate-warn', sessionId, HIBERNATE_GRACE_MS / 1000)
        } catch {
          // Window destroyed, ignore
        }
      }
      session.hibernateTimer = setTimeout(() => hibernateSession(sessionId), HIBERNATE_GRACE_MS)
    }
  }
}

/** Evaluate the full hibernation gate against this session's live signals.
 *  Delegates to the pure `shouldHibernate`; fails safe (default config OFF). */
function isHibernateEligible(session: PtySession): boolean {
  const cfg = idleCloseConfigGetter?.() ?? { enabled: false, idleMs: 30 * 60_000 }
  return shouldHibernate({
    enabled: cfg.enabled,
    isMainTab: isMainTabSession(session.sessionId),
    mode: session.mode,
    resumeEligible: isResumeEligibleMode(session.mode),
    hasConversationId: !!session.conversationId,
    awaitingUser: !!session.awaitingUser,
    state: session.state,
    lastUserInteractionAt: session.lastUserInteractionAt,
    now: Date.now(),
    idleMs: Math.max(5_000, cfg.idleMs)
  })
}

/** Abort a pending hibernate countdown (activity arrived or user cancelled).
 *  Notifies the renderer so it hides the countdown overlay. */
function cancelHibernateCountdown(session: PtySession): void {
  if (!session.hibernateTimer) return
  clearTimeout(session.hibernateTimer)
  session.hibernateTimer = undefined
  ptyEvents.emit('hibernate-cancelled', session.sessionId)
  if (!session.win.isDestroyed()) {
    try {
      session.win.webContents.send('pty:hibernate-cancelled', session.sessionId)
    } catch {
      // Window destroyed, ignore
    }
  }
}

/** Fire the hibernation: re-assert eligibility (state may have changed during
 *  the grace), tell the renderer to swap to the Start screen, then kill via the
 *  normal `killPty` path (clears `was_spawned`, emits `pty:exit`, frees buffer).
 *  Reopen resumes the conversation via the stored id. */
function hibernateSession(sessionId: string): void {
  const session = sessions.get(sessionId)
  if (!session) return
  session.hibernateTimer = undefined
  if (!isHibernateEligible(session)) return
  recordDiagnosticEvent({
    level: 'info',
    source: 'pty',
    event: 'pty.hibernate',
    sessionId,
    taskId: session.taskId,
    message: 'idle agent hibernated (killed → Start screen; resumes on reopen)',
    payload: {
      mode: session.mode,
      idleMs: Date.now() - session.lastUserInteractionAt
    }
  })
  // Broadcast to ALL windows, not just session.win: hibernation is a global
  // fact (the agent is asleep), and a session's owning window gets rerouted by
  // redirectSessionWindow (secondary task window / floating agent panel / agent
  // side-panel claim). A window-targeted send leaves every OTHER window's
  // sidebar dot stale until reconcile heals it; broadcasting flips 💤 at once.
  broadcastPtyEvent('pty:hibernated', sessionId)
  ptyEvents.emit('hibernated', sessionId)
  // Persist the status so 💤 / Reopen survive reload + restart.
  try {
    hibernatedSetter?.(resolveTabRowId(sessionId), true)
  } catch {
    // Best-effort
  }
  killPty(sessionId)
}

/** Mark genuine user interaction with this terminal (the "user engaged" axis of
 *  the idle-close gate). Called by the renderer on real DOM interaction
 *  (keydown/mouse/wheel/paste/focus, throttled) and by the countdown's explicit
 *  "Keep open". Resets the idle window + aborts any pending countdown. */
export function touchPty(sessionId: string): boolean {
  const session = sessions.get(sessionId)
  if (!session) return false
  session.lastUserInteractionAt = Date.now()
  cancelHibernateCountdown(session)
  return true
}

/** Mark engagement on a task's MAIN agent session, given only the bare taskId.
 *  Used by callers that don't know the session-id convention (e.g. the browser
 *  WebContentsView in main, whose input never reaches the renderer DOM). The
 *  main session is registered under `${taskId}:${taskId}` but `session.taskId`
 *  holds the bare id, so we resolve by that field + `isMainTabSession` rather
 *  than reconstructing the key — drift-proof if the convention ever changes.
 *  Returns true if a matching session was touched. */
export function touchTaskMainSession(taskId: string): boolean {
  for (const [sessionId, session] of sessions) {
    if (session.taskId === taskId && isMainTabSession(sessionId)) {
      return touchPty(sessionId)
    }
  }
  return false
}

/**
 * User pressed an interrupt key (Esc / Ctrl+C) in the terminal — optimistically
 * flip a *running* session to idle.
 *
 * Mirrors Superset's `useTerminalInterruptClear`: Ctrl+C kills the foreground
 * agent process while the shell stays alive, and Claude Code's `Stop` hook does
 * NOT fire on user interrupt — so a hook-driven agent (idleTimeoutMs=Infinity,
 * no silence fallback) would otherwise stay stuck on 'running'. We flip the
 * authoritative backend state here so the dot clears and reconcile agrees; if
 * the agent is in fact still working, its next lifecycle hook
 * (UserPromptSubmit/PreToolUse) re-asserts 'running'. No-op unless running, so
 * an Esc that didn't actually interrupt anything costs nothing.
 */
export function interruptPty(sessionId: string): boolean {
  const session = sessions.get(sessionId)
  if (!session) return false
  if (session.state !== 'running') return false
  session.activity = 'unknown'
  session.pendingTransitionTrigger = { source: 'user-interrupt', preview: 'Esc/Ctrl+C' }
  transitionState(sessionId, 'idle')
  return true
}

/** Record a conversation id captured out-of-band (e.g. the agent SessionStart
 *  hook) so the hibernation gate sees a resumable session for hook-driven
 *  providers like claude-code that never run `/status`. */
export function noteSessionConversationId(sessionId: string, conversationId: string | null): void {
  const session = sessions.get(sessionId)
  if (session && conversationId) session.conversationId = conversationId
}

/** Authoritative "agent is blocked waiting for the user" signal from the agent
 *  lifecycle hook. Set true on blocking PreToolUse / PermissionRequest, false on
 *  resume/turn-complete. Blocks hibernation (a paused-mid-interaction agent must
 *  not be killed even though it reports 'idle' like a completed turn). Also
 *  aborts a pending countdown when it flips true. */
export function setSessionAwaitingInput(sessionId: string, awaiting: boolean): void {
  const session = sessions.get(sessionId)
  if (!session) return
  session.awaitingUser = awaiting
  if (awaiting) cancelHibernateCountdown(session)
}

// Start the inactivity checker interval
export function startIdleChecker(win: PtySessionWindow): void {
  mainWindow = win
  if (idleCheckerInterval) {
    clearInterval(idleCheckerInterval)
  }
  idleCheckerInterval = setInterval(checkInactiveSessions, IDLE_CHECK_INTERVAL_MS)
}

// Stop the inactivity checker
export function stopIdleChecker(): void {
  if (idleCheckerInterval) {
    clearInterval(idleCheckerInterval)
    idleCheckerInterval = null
  }
  mainWindow = null
}

// ---------------------------------------------------------------------------
// Execution context: transport wrapping for docker/ssh
// ---------------------------------------------------------------------------

interface TransportSpawn {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

function buildTransportSpawn(
  ctx: ExecutionContext | null | undefined,
  cwd: string,
  env: Record<string, string>,
  adapterEnv: Record<string, string>,
  mcpEnv: Record<string, string>
): TransportSpawn | null {
  if (!ctx || ctx.type === 'host') return null // use default spawn path

  if (ctx.type === 'docker') {
    const workdir = ctx.workdir || cwd
    const containerShell = ctx.shell || '/bin/bash'
    const dockerArgs = ['exec', '-it']

    // Forward adapter + MCP env vars via -e flags
    for (const [k, v] of Object.entries({ ...adapterEnv, ...mcpEnv })) {
      dockerArgs.push('-e', `${k}=${v}`)
    }
    // Rewrite MCP host so CLI can reach the host's MCP server from inside container
    dockerArgs.push('-e', 'SLAYZONE_MCP_HOST=host.docker.internal')
    dockerArgs.push('-w', workdir, '--', ctx.container, containerShell, '-i', '-l')

    return { file: 'docker', args: dockerArgs, cwd: homedir(), env }
  }

  if (ctx.type === 'ssh') {
    const workdir = ctx.workdir || cwd
    const remoteShell = ctx.shell || '/bin/bash'
    const mcpPort = (globalThis as Record<string, unknown>).__mcpPort as number | undefined

    const sshArgs = ['-t']
    // Reverse port forward so remote CLI can reach host MCP server
    if (mcpPort) {
      sshArgs.push('-R', `${mcpPort}:localhost:${mcpPort}`)
    }
    sshArgs.push('--', ctx.target)

    // Build remote command: cd + export env + launch shell
    const parts: string[] = [`cd ${quoteForShell(workdir)}`]
    for (const [k, v] of Object.entries({ ...adapterEnv, ...mcpEnv })) {
      parts.push(`export ${k}=${quoteForShell(v)}`)
    }
    if (mcpPort) {
      parts.push(`export SLAYZONE_MCP_HOST=localhost`)
    }
    parts.push(`${quoteForShell(remoteShell)} -i -l`)
    sshArgs.push(parts.join(' && '))

    return { file: 'ssh', args: sshArgs, cwd: homedir(), env }
  }

  return null
}

export function testExecutionContext(
  context: ExecutionContext
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    if (context.type === 'host') {
      resolve({ success: true })
      return
    }

    const cmd = context.type === 'docker' ? 'docker' : 'ssh'
    const args =
      context.type === 'docker'
        ? ['exec', '--', context.container, 'echo', 'ok']
        : ['-o', 'ConnectTimeout=5', '--', context.target, 'echo', 'ok']

    execFile(cmd, args, { timeout: 10_000 }, (err) => {
      if (err) {
        resolve({ success: false, error: (err as Error).message })
      } else {
        resolve({ success: true })
      }
    })
  })
}

const TITLE_POLL_MS = 500

/** Emit a title change if the title differs from the last emitted one. */
function emitTitle(session: PtySession, title: string): void {
  if (!title || title === session.lastEmittedTitle) return
  session.lastEmittedTitle = title
  ptyEvents.emit('title-change', session.sessionId, title)
  if (!session.win.isDestroyed()) {
    try {
      session.win.webContents.send('pty:title-change', session.sessionId, title)
    } catch {
      /* Window destroyed */
    }
  }
}

/** Start polling pty.process on an interval. Decoupled from data flow so idle shells update too. */
function startTitlePolling(session: PtySession, target: pty.IPty): void {
  stopTitlePolling(session)
  session.titlePollInterval = setInterval(() => {
    const s = sessions.get(session.sessionId)
    if (!s || s.pty !== target) {
      stopTitlePolling(session)
      return
    }
    const raw = s.pty.process
    if (raw) emitTitle(s, raw)
  }, TITLE_POLL_MS)
}

function stopTitlePolling(session: PtySession): void {
  if (session.titlePollInterval) {
    clearInterval(session.titlePollInterval)
    session.titlePollInterval = undefined
  }
}

/** Base shell environment shared by every PTY spawn (cold createPty + warm pool). */
function buildBaseEnv(): Record<string, string> {
  return {
    ...process.env,
    USER: process.env.USER || process.env.USERNAME || userInfo().username,
    HOME: process.env.HOME || homedir(),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    COLORFGBG: getPtyHostBridge().isDarkTheme() ? '15;0' : '0;15',
    TERM_BACKGROUND: getPtyHostBridge().isDarkTheme() ? 'dark' : 'light'
  } as Record<string, string>
}

/**
 * Low-level shell spawn shared by createPty and the warm-process pool. Non-transport
 * spawns get wrapped in `/bin/sh -c 'ulimit -n 65535; exec <shell> <args>'` so child
 * processes inherit a soft fd limit high enough for Bun-compiled CLIs. Transport spawns
 * (docker/ssh) handle their own env on the remote side.
 */
function spawnWrappedShell(
  file: string,
  args: string[],
  spawnOptions: pty.IPtyForkOptions,
  transport: boolean
): pty.IPty {
  if (transport) return pty.spawn(file, args, spawnOptions)
  const wrapped = wrapShellWithUlimit(file, args)
  return pty.spawn(wrapped.file, wrapped.args, spawnOptions)
}

/**
 * Spawn a bare login+interactive shell (no post-spawn command) for the warm-process
 * pool. Reuses the exact shell resolution, startup args, ulimit wrap, and interactive-only
 * fallback that createPty's initial spawn uses, so an adopted warm shell is indistinguishable
 * from a cold spawn. The caller writes `exec <agent>` later, at adopt time.
 */
export function spawnLoginShell(opts: {
  cwd: string
  extraEnv?: Record<string, string>
  cols?: number
  rows?: number
}): { pty: pty.IPty; shell: string; usedArgs: string[]; usedFallback: boolean } {
  const shell = resolveUserShell()
  const args = getShellStartupArgs(shell)
  const spawnOptions: pty.IPtyForkOptions = {
    name: 'xterm-256color',
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    cwd: opts.cwd,
    env: { ...buildBaseEnv(), ...(opts.extraEnv ?? {}) }
  }
  try {
    return {
      pty: spawnWrappedShell(shell, args, spawnOptions, false),
      shell,
      usedArgs: args,
      usedFallback: false
    }
  } catch (err) {
    // Some shells reject the login+interactive combo on certain hosts — retry without -l.
    if (!(args.includes('-i') && args.includes('-l'))) throw err
    const fallbackArgs = args.filter((a) => a !== '-l')
    return {
      pty: spawnWrappedShell(shell, fallbackArgs, spawnOptions, false),
      shell,
      usedArgs: fallbackArgs,
      usedFallback: true
    }
  }
}

export interface CreatePtyOptions {
  win: PtySessionWindow
  sessionId: string
  /**
   * The session's task + tab, passed explicitly so the runtime no longer has to
   * decode them from the `sessionId` string (plans/agent-sessions.md slice 3 —
   * the key becomes an opaque uuid). When omitted, falls back to splitting a
   * legacy `taskId:tabId` sessionId. `taskId` is null for a pooled session with
   * no task yet.
   */
  taskId?: string | null
  tabId?: string | null
  cwd: string
  conversationId?: string | null
  existingConversationId?: string | null
  mode?: TerminalMode
  initialPrompt?: string | null
  providerArgs?: string[]
  executionContext?: ExecutionContext | null
  type?: string
  initialCommand?: string | null
  resumeCommand?: string | null
  defaultFlags?: string | null
  patternWorking?: string | null
  patternError?: string | null
  cols?: number
  rows?: number
  /**
   * Adopt an already-spawned, idle login shell instead of spawning a fresh one
   * (warm-process pool). When present, the initial `pty.spawn()` is skipped and
   * this pty is registered under `sessionId` from the start — the session is never
   * renamed, so the core I/O path is untouched. The post-spawn command (e.g.
   * `export SLAYZONE_TASK_ID=…; exec claude …`) is written into the live shell.
   *
   * `preWarmedAgent` (plans/agent-sessions.md slice 4/B): the adopted pty is
   * ALREADY running the agent (claude booted, MCP up, idle) — NOT a bare shell.
   * Adoption then skips the exec (the agent is live), binds the pre-recorded
   * pooled session (`sessionId` = `agent_sessions.id`) to this task, adopts its
   * `conversationId`, and sends the task's initial prompt to the running agent.
   */
  adoptPty?: {
    pty: pty.IPty
    seedBuffer?: string
    preWarmedAgent?: boolean
    /** Pooled `agent_sessions.id` to bind to this task (preWarmedAgent only). */
    sessionId?: string
    /** The warm agent's already-established conversation id (preWarmedAgent only). */
    conversationId?: string | null
  }
}

// Test-only (PLAYWRIGHT) pty-create capture at the TRUE spawn chokepoint (every
// spawn path — renderer pty.create, server auto-start, warm adopt — funnels here).
// When on, record a serializable opts subset and return a success stub (no spawn).
let ptyCreateCaptureOn = false
const ptyCreateCapturedOpts: Array<Record<string, unknown>> = []
// Kill calls recorded while the capture is on. Lifecycle specs (94-session-
// invalidation) assert reset/restart actually kill the old session — with the
// capture stub there is no real process, so record the killPty() CALL itself.
const ptyKillCapturedSessionIds: string[] = []
export function setPtyCreateCapture(enabled: boolean): void {
  ptyCreateCaptureOn = enabled
  if (enabled) {
    ptyCreateCapturedOpts.length = 0
    ptyKillCapturedSessionIds.length = 0
  }
}
export function takePtyCreateOpts(): Array<Record<string, unknown>> {
  return ptyCreateCapturedOpts
}
export function takePtyKillCalls(): string[] {
  return ptyKillCapturedSessionIds
}

export async function createPty(
  opts: CreatePtyOptions
): Promise<{ success: boolean; error?: string }> {
  if (process.env.PLAYWRIGHT === '1' && ptyCreateCaptureOn) {
    ptyCreateCapturedOpts.push({
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      mode: opts.mode,
      conversationId: opts.conversationId ?? null,
      existingConversationId: opts.existingConversationId ?? null,
      providerArgs: opts.providerArgs ?? null
    })
    return { success: true }
  }
  const {
    win: originalWin,
    sessionId,
    cwd,
    conversationId,
    existingConversationId,
    mode,
    initialPrompt,
    providerArgs,
    executionContext,
    type,
    initialCommand,
    resumeCommand,
    defaultFlags,
    patternWorking,
    patternError
  } = opts
  if (isShuttingDown) {
    return { success: false, error: 'Cannot create PTY while app is shutting down.' }
  }
  // Dynamic window lookup: allows redirectSessionWindow() to reroute events at runtime.
  const getWin = (): PtySessionWindow => sessions.get(sessionId)?.win ?? originalWin
  // Register the session-identity seam: prefer explicit task/tab (opaque-id path);
  // fall back to splitting a legacy `taskId:tabId` sessionId. A null taskId
  // (pooled) is stored as '' so it never decodes to a bogus uuid-as-taskId.
  sessionTaskMap.set(sessionId, opts.taskId !== undefined ? (opts.taskId ?? '') : splitTaskId(sessionId))
  sessionTabMap.set(sessionId, opts.tabId !== undefined ? (opts.tabId ?? '') : splitTabRowId(sessionId))
  const taskId = taskIdFromSessionId(sessionId)
  const createStartedAt = Date.now()
  let spawnAttempt: { shell: string; shellArgs: string[]; hasPostSpawnCommand: boolean } | null =
    null
  recordDiagnosticEvent({
    level: 'info',
    source: 'pty',
    event: 'pty.create',
    sessionId,
    taskId,
    payload: {
      mode: mode ?? null,
      type: type ?? null,
      initialCommand: initialCommand ?? null,
      resumeCommand: resumeCommand ?? null,
      defaultFlags: defaultFlags ?? null,
      patternWorking: patternWorking ?? null,
      patternError: patternError ?? null,
      providerArgs: providerArgs ?? [],
      hasConversationId: Boolean(conversationId),
      hasExistingConversationId: Boolean(existingConversationId)
    }
  })

  // Kill existing if any
  if (sessions.has(sessionId)) {
    recordDiagnosticEvent({
      level: 'warn',
      source: 'pty',
      event: 'pty.replace_existing',
      sessionId,
      taskId
    })
    killPty(sessionId)
  }

  try {
    const terminalMode = mode || 'claude-code'
    const adapter = getAdapter({
      mode: terminalMode,
      type,
      patterns: { working: patternWorking, error: patternError }
    })
    // MAIN is authoritative: when the renderer gave no hint (e.g. the boot board
    // load hadn't hydrated `currentConversationByMode` yet), resolve the id from
    // the ledger BEFORE deciding fresh-vs-resume. A null/stale hint must never
    // cause a destructive fresh-mint over a conversation main already knows.
    // Best-effort — on any failure keep null and fall through to a fresh spawn.
    // Honors the ledger's manual-reset cutoff + provenance gate (a deliberate
    // reset resolves to null here, so a reset is never silently undone).
    let ledgerConversationId: string | null = null
    if (!existingConversationId && conversationResolver) {
      // Resolve the authoritative id from the ledger, RETRYING on null. During
      // early boot the async db worker can momentarily return null for a query
      // that has a real answer — the first-spawn race that re-clobbered the
      // active tab on restart. Minting a fresh session over a real conversation
      // is destructive, so a single null is not taken at face value here; a real
      // id (no rows) costs at most ~300ms of retry on the cold spawn path.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          ledgerConversationId = await conversationResolver({ taskId, mode: terminalMode })
        } catch {
          ledgerConversationId = null
        }
        if (ledgerConversationId) break
        if (attempt < 2) await new Promise((r) => setTimeout(r, 150))
      }
    }
    // Pure fresh-vs-resume decision — see resolveSpawnConversation. The invariant
    // (known id ⇒ resume, never mint over it) lives there + is unit-tested.
    const decision = resolveSpawnConversation({
      existingConversationId,
      ledgerConversationId,
      conversationId,
      supportsFreshPreMint: supportsFreshPreMint(initialCommand)
    })
    // Canary: surface every spawn decision so a fresh-mint-over-a-task (the
    // restart-clobber signature) is visible in diagnostics. `ledgerResolved` +
    // `resolverReady` pinpoint a resolver gap if a clobber ever recurs.
    recordDiagnosticEvent({
      level: decision.shouldMintFresh ? 'warn' : 'info',
      source: 'pty',
      event: 'conv_id.spawn_decision',
      sessionId,
      taskId,
      payload: {
        hasExisting: Boolean(existingConversationId),
        hasConversationId: Boolean(conversationId),
        resolverReady: Boolean(conversationResolver),
        ledgerResolved: ledgerConversationId,
        resuming: Boolean(decision.resolvedExistingId),
        shouldMintFresh: decision.shouldMintFresh
      }
    })
    // Self-heal a stale/phantom stored conversation id before building --resume.
    // No-op for healthy ids; for a missing one it repoints to the task's real
    // conversation (recorded history, or a near-certain orphan). Best-effort — on
    // any failure we keep the original id and let the stale-resume overlay surface.
    let resolvedExistingId = decision.resolvedExistingId
    if (resolvedExistingId && conversationHealer) {
      try {
        const healed = await conversationHealer({
          taskId,
          mode: terminalMode,
          cwd,
          storedId: resolvedExistingId
        })
        if (healed?.id && healed.id !== resolvedExistingId) resolvedExistingId = healed.id
      } catch {
        // keep resolvedExistingId as-is
      }
    }
    const resuming = !!resolvedExistingId
    // Fresh-spawn pre-mint (decision.shouldMintFresh): when the provider's
    // `initialCommand` has the literal `{id}` placeholder (today: claude-code,
    // qwen-code) and nothing is known, slay mints a UUID at spawn time and
    // threads it through the template. That gives the agent's SessionStart hook
    // a sessionId slay already knows — binary match-or-foreign provenance,
    // structurally identical to the resume path. For providers whose
    // `initialCommand` has no `{id}` (codex, antigravity, cursor-agent,
    // opencode), the agent mints internally and slay falls back to the
    // temporal-proximity gate via `pending-spawn` rows (`expectedSessionId=null`).
    const mintedFreshId = decision.shouldMintFresh ? randomUUID() : null
    // A pre-warmed pooled agent already established its conversation id at warm
    // time — adopt it directly (no resolve / heal / mint).
    const effectiveConversationId = opts.adoptPty?.preWarmedAgent
      ? opts.adoptPty.conversationId ?? null
      : resolvedExistingId || conversationId || mintedFreshId

    // Pick template: resume if resuming and resume_command exists, otherwise initial
    const template = resuming && resumeCommand ? resumeCommand : initialCommand || undefined

    // Build spawn config via template interpolation
    const shell = resolveUserShell()
    const shellConfig = { shell, args: getShellStartupArgs(shell) }
    let postSpawnCommand: string | undefined
    // A pre-warmed agent is already running its command — never build/exec it
    // again (that would type the command into the live agent's TUI as input).
    if (template && !opts.adoptPty?.preWarmedAgent) {
      const binary = interpolateTemplate({
        template,
        conversationId: effectiveConversationId || undefined,
        flags:
          providerArgs && providerArgs.length > 0 ? providerArgs : parseShellArgs(defaultFlags),
        initialPrompt: initialPrompt || undefined
      })
      const allArgs = [...binary.args]
      if (binary.initialPrompt) allArgs.push(binary.initialPrompt)
      postSpawnCommand = buildExecCommand(binary.name, allArgs)
    }
    const spawnConfig: SpawnConfig = { ...shellConfig, postSpawnCommand }

    spawnAttempt = {
      shell: spawnConfig.shell,
      shellArgs: spawnConfig.args,
      hasPostSpawnCommand: Boolean(spawnConfig.postSpawnCommand)
    }
    recordDiagnosticEvent({
      level: 'info',
      source: 'pty',
      event: 'pty.spawn_config',
      sessionId,
      taskId,
      payload: {
        launchStrategy: spawnConfig.postSpawnCommand ? 'shell_exec' : 'direct_shell',
        shell: spawnConfig.shell,
        shellArgs: spawnConfig.args,
        hasPostSpawnCommand: Boolean(spawnConfig.postSpawnCommand)
      }
    })

    // A pre-warmed agent already has its env baked in from spawn time (warm pool)
    // and is never re-exported/re-exec'd (see the preWarmedAgent guard above) — its
    // mcpEnv would only feed the export-prefix / spawnOptions.env below, both of
    // which are unreachable for it. Skip the DB round-trip entirely on this path.
    const mcpEnv = opts.adoptPty?.preWarmedAgent ? {} : await buildMcpEnv(db, taskId, terminalMode)

    // Adoption: the warm shell was spawned without the task-scoped MCP env
    // (SLAYZONE_TASK_ID etc.) — env can't be mutated on a live process, so export
    // it into the shell immediately before `exec <agent>`. Reuses the SAME mcpEnv a
    // cold spawn bakes in, so the adopted agent's task identity is byte-for-byte correct.
    if (opts.adoptPty && spawnConfig.postSpawnCommand) {
      const exportPrefix = Object.entries(mcpEnv)
        .map(([k, v]) => `export ${k}=${quoteForShell(v)}`)
        .join('; ')
      if (exportPrefix) {
        spawnConfig.postSpawnCommand = `${exportPrefix}; ${spawnConfig.postSpawnCommand}`
      }
    }

    const baseEnv = buildBaseEnv()

    // Check for docker/ssh transport wrapping
    const transport = buildTransportSpawn(
      executionContext,
      cwd || homedir(),
      baseEnv,
      spawnConfig.env ?? {},
      mcpEnv
    )

    // Validate cwd exists AND is readable before spawn. posix_spawnp fails
    // opaquely on missing dirs; a dir that exists but isn't readable (mode
    // bits, ACL, or macOS TCC denying reads on Desktop/Documents/iCloud/
    // network volumes) lets spawn succeed but then shell init breaks — e.g.
    // `brew shellenv` aborts with "current working directory must be readable
    // to $USER to run brew", which in turn breaks PATH for every CLI launched
    // through the shell (droid, etc.). Fall back to homedir in either case.
    let effectiveCwd = transport ? transport.cwd : cwd || homedir()
    if (!transport && effectiveCwd) {
      const fallback = homedir()
      if (!existsSync(effectiveCwd)) {
        recordDiagnosticEvent({
          level: 'warn',
          source: 'pty',
          event: 'pty.cwd_fallback',
          sessionId,
          taskId,
          message: `cwd not found: ${effectiveCwd}, falling back to ${fallback}`
        })
        effectiveCwd = fallback
      } else {
        try {
          accessSync(effectiveCwd, fsConstants.R_OK)
        } catch {
          recordDiagnosticEvent({
            level: 'warn',
            source: 'pty',
            event: 'pty.cwd_unreadable_fallback',
            sessionId,
            taskId,
            message: `cwd not readable: ${effectiveCwd}, falling back to ${fallback}. Check dir perms or grant SlayZone Full Disk Access in System Settings → Privacy & Security.`
          })
          effectiveCwd = fallback
        }
      }
    }

    const spawnOptions = {
      name: 'xterm-256color',
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: effectiveCwd,
      env: transport
        ? transport.env
        : ({
            ...baseEnv,
            ...spawnConfig.env,
            ...mcpEnv
          } as Record<string, string>)
    }

    const spawnFile = transport ? transport.file : spawnConfig.shell
    const initialArgs = transport ? [...transport.args] : [...spawnConfig.args]

    // When a post-spawn command is present, pass it via -c flag instead of
    // writing to stdin after a delay.  This prevents shell init prompts
    // (e.g. oh-my-zsh update [Y/n]) from consuming/corrupting the command.
    const directExec =
      !transport && !!spawnConfig.postSpawnCommand && platform() !== 'win32' && !opts.adoptPty
    if (directExec) {
      initialArgs.push('-c', spawnConfig.postSpawnCommand!)
    }

    const canRetryInteractiveOnly =
      !transport && initialArgs.includes('-i') && initialArgs.includes('-l')
    let usedArgs = [...initialArgs]
    let usedFallback = false
    let usedShellFallback = false
    // Record slay's spawn intent BEFORE the PTY starts so the agent's
    // SessionStart hook can verify provenance (`task_conversations`,
    // origin='pending-spawn'). `effectiveConversationId` is the id slay is
    // about to ask the agent to resume; `null` means "fresh PTY spawn — agent
    // will mint its own id, accept the first observation as fresh". Awaited
    // so the row is durable before the child process can race ahead. Drops
    // on PTY exit via `prunePendingSpawns` below, and a periodic 10-min TTL
    // sweep belt-and-suspenders.
    if (db && !opts.adoptPty?.preWarmedAgent) {
      try {
        await recordPendingSpawn(db, {
          taskId,
          mode: terminalMode,
          expectedSessionId: effectiveConversationId || null,
          usedResume: resuming
        })
      } catch {
        // Best-effort — a failed pending row falls back to "no pending" in the
        // hook handler, which records as foreign-observed for that one session.
      }
    }
    const spawnStartTs = Date.now()
    let ptyProcess: pty.IPty
    // Non-transport spawns get wrapped in `/bin/sh -c 'ulimit -n 65535; exec
    // <shell> <args>'` so child processes inherit a soft fd limit high enough
    // for Bun-compiled CLIs (e.g. droid). Transport spawns (docker/ssh) handle
    // their own env on the remote side.
    const spawn = (rawFile: string, rawArgs: string[]): pty.IPty =>
      spawnWrappedShell(rawFile, rawArgs, spawnOptions, !!transport)
    if (opts.adoptPty) {
      // Warm-process adoption: reuse the already-spawned, rc-initialized idle shell.
      // Skip the initial spawn entirely; the post-spawn command (export + exec agent)
      // is written into the live shell below. Fallback paths still re-spawn fresh
      // shells via `spawn` if the agent exits, exactly as for a cold spawn.
      ptyProcess = opts.adoptPty.pty
    } else {
      try {
        ptyProcess = spawn(spawnFile, initialArgs)
      } catch (err) {
        // Fallback for shells that reject login flag combinations (host only).
        if (!canRetryInteractiveOnly) throw err
        usedArgs = initialArgs.filter((arg) => arg !== '-l')
        ptyProcess = spawn(spawnFile, usedArgs)
        usedFallback = true
        recordDiagnosticEvent({
          level: 'warn',
          source: 'pty',
          event: 'pty.spawn_fallback',
          sessionId,
          taskId: taskIdFromSessionId(sessionId),
          message: (err as Error).message,
          payload: {
            shell: spawnConfig.shell,
            fromArgs: initialArgs,
            toArgs: usedArgs
          }
        })
      }
    }
    const shellSpawnMs = Date.now() - spawnStartTs

    sessions.set(sessionId, {
      win: originalWin,
      pty: ptyProcess,
      sessionId,
      taskId,
      mode: terminalMode,
      adapter,
      // Only check for session errors if we're trying to resume
      checkingForSessionError: resuming,
      buffer: new RingBuffer(MAX_BUFFER_SIZE),
      lastOutputTime: Date.now(),
      lastUserInteractionAt: Date.now(),
      conversationId: effectiveConversationId ?? null,
      createdAt: Date.now(),
      state: 'starting',
      // CLI state tracking
      activity: 'unknown',
      error: null,
      // /status monitoring
      inputBuffer: '',
      watchingForSessionId: false,
      statusOutputBuffer: '',
      // Dev server URL dedup
      detectedDevUrls: new Set(),
      syncQueryPending: '',
      lastEmittedTitle: ''
    })
    // Adoption: the warm shell was spawned before any tab existed, so it has no
    // real cols/rows to size to — it's stuck at spawnLoginShell's placeholder
    // default. Resize to the tab's actual dimensions now that we know them, so
    // the already-running agent's first paint isn't laid out for the wrong size.
    if (opts.adoptPty) {
      resizePty(sessionId, opts.cols ?? 80, opts.rows ?? 24)
    }
    // Adoption: seed the fresh RingBuffer with whatever the warm shell already
    // emitted (its rc prompt), so getBufferSince / hibernation history stay consistent.
    if (opts.adoptPty?.seedBuffer) {
      sessions.get(sessionId)?.buffer.append(opts.adoptPty.seedBuffer)
    }
    // Pre-warmed pool adoption: bind the pre-recorded pooled session entity to
    // this task+tab (set-once). Its write-once conversation id then becomes the
    // task's resume target via the resolver (which reads agent_sessions by task).
    if (opts.adoptPty?.preWarmedAgent && opts.adoptPty.sessionId && db) {
      try {
        await bindSessionToTask(db, {
          sessionId: opts.adoptPty.sessionId,
          taskId,
          tabId: resolveTabRowId(sessionId)
        })
      } catch {
        // Best-effort — a failed bind leaves the session pooled; the resolver
        // simply won't surface it for this task (no phantom binding).
      }
    }
    // Record this tab as warm — survives across app shutdown so next boot
    // auto-restarts. Cleared in finalizeSessionExit on natural/user exit.
    // Also clear any hibernated flag — a fresh spawn means it's no longer asleep.
    try {
      hibernatedSetter?.(resolveTabRowId(sessionId), false)
    } catch {
      // Best-effort
    }
    try {
      spawnedSetter?.(resolveTabRowId(sessionId), true)
    } catch (err) {
      recordDiagnosticEvent({
        level: 'warn',
        source: 'pty',
        event: 'pty.was_spawned_set_failed',
        sessionId,
        taskId,
        message: (err as Error).message
      })
    }
    notifySessionChange()
    stateMachine.register(sessionId, 'starting')
    // node-pty.spawn is synchronous — pid is live by the time we get here.
    // Flip to 'idle' on next microtask so the brief 'starting' window is
    // observable for early-exit cases but the UI never gets stuck on
    // 'starting' for processes that emit no immediate output. Adapter
    // detection still drives idle→running on first spinner.
    queueMicrotask(() => {
      const live = sessions.get(sessionId)
      if (live && live.state === 'starting') {
        live.pendingTransitionTrigger = { source: 'startup-settle' }
        transitionState(sessionId, 'idle')
      }
    })
    let firstOutputTs: number | null = null
    let commandDispatchedTs: number | null = null
    let startupTimeout: NodeJS.Timeout | undefined
    let earlyExitWatchdog: NodeJS.Timeout | undefined

    const clearStartupTimeout = (): void => {
      if (!startupTimeout) return
      clearTimeout(startupTimeout)
      startupTimeout = undefined
    }

    const clearEarlyExitWatchdog = (): void => {
      if (!earlyExitWatchdog) return
      clearTimeout(earlyExitWatchdog)
      earlyExitWatchdog = undefined
    }

    let finalized = false
    const finalizeSessionExit = (exitCode: number): void => {
      if (finalized) return
      finalized = true
      // Drop the pending-spawn provenance row for this (task, mode). A row that
      // isn't pruned here gets swept by the periodic 10-min TTL anyway, but
      // explicit pruning here keeps the table small and avoids stale rows
      // matching a fast restart on the same task/mode.
      if (db) {
        void prunePendingSpawns(db, { taskId, mode: terminalMode }).catch(() => {
          // Best-effort — failure leaks at most one pending row per spawn,
          // which the periodic sweep collects within 10 min.
        })
      }
      // Clear the warm flag — UNLESS we're in app shutdown, in which case
      // we deliberately preserve was_spawned so the next boot auto-restarts.
      if (!isShuttingDown) {
        try {
          spawnedSetter?.(resolveTabRowId(sessionId), false)
        } catch {
          // Diagnostic logging here would compete with the exit-time race; swallow.
        }
      }
      clearStartupTimeout()
      clearEarlyExitWatchdog()
      // Clear pending timers
      const exitSession = sessions.get(sessionId)
      if (exitSession?.sessionIdAutoDetectTimer) {
        clearTimeout(exitSession.sessionIdAutoDetectTimer)
      }
      if (exitSession) stopTitlePolling(exitSession)
      if (exitSession?.shutdownWaiters) {
        for (const waiter of exitSession.shutdownWaiters) {
          try {
            waiter(exitCode)
          } catch (err) {
            recordPtyCallbackError(sessionId, taskId, 'shutdown-waiter', err)
          }
        }
        exitSession.shutdownWaiters.clear()
      }
      if (exitSession)
        exitSession.pendingTransitionTrigger = {
          source: 'pty-exit',
          preview: `exitCode=${exitCode}`
        }
      transitionState(sessionId, 'dead')
      recordDiagnosticEvent({
        level: 'info',
        source: 'pty',
        event: 'pty.exit',
        sessionId,
        taskId: taskIdFromSessionId(sessionId),
        payload: {
          exitCode
        }
      })
      // Note: the host-kill timestamp (lastPtyKilledAt) is recorded at the
      // invariant entry point `onTaskReachedTerminal`, NOT here — the -2 sentinel
      // rarely survives SIGKILL → onExit, and recording on unrelated PTY exits
      // (mode-switch, tab-close) would pollute the revive hot/cold signal.
      // Delay session cleanup so any trailing onData events (buffered in the PTY fd)
      // can still be processed and forwarded to the renderer before we drop the session.
      setTimeout(() => {
        dataListeners.delete(sessionId)
        sessions.delete(sessionId)
        sessionTaskMap.delete(sessionId)
        sessionTabMap.delete(sessionId)
        stateMachine.unregister(sessionId)
        clearSessionUserInputMark(sessionId)
        notifySessionChange()
      }, 100)
      ptyEvents.emit('title-change', sessionId, '')
      ptyEvents.emit('exit', sessionId, exitCode, exitSession?.error?.code ?? null)
      const exitWin = getWin()
      if (!exitWin.isDestroyed()) {
        try {
          exitWin.webContents.send('pty:title-change', sessionId, '')
        } catch {
          /* Window destroyed */
        }
        try {
          // Carry the structured error code (e.g. SESSION_NOT_FOUND) so the
          // renderer's dead overlay can render an error-specific message.
          exitWin.webContents.send('pty:exit', sessionId, exitCode, exitSession?.error?.code ?? null)
        } catch {
          // Window destroyed, ignore
        }
      }
    }

    // Expose the finalizer on the session so external callers (killPty) can
    // route through the same single exit path as natural exits.
    const registeredSession = sessions.get(sessionId)
    if (registeredSession) registeredSession.finalizer = finalizeSessionExit

    const armStartupTimeout = (target: pty.IPty): void => {
      clearStartupTimeout()
      const effectiveStartupTimeout = adapter.startupTimeoutMs ?? STARTUP_TIMEOUT_MS
      startupTimeout = setTimeout(() => {
        const live = sessions.get(sessionId)
        if (!live || live.pty !== target || firstOutputTs !== null) return
        recordDiagnosticEvent({
          level: 'warn',
          source: 'pty',
          event: 'pty.startup_timeout',
          sessionId,
          taskId: taskIdFromSessionId(sessionId),
          payload: {
            timeoutMs: effectiveStartupTimeout,
            shell: spawnConfig.shell,
            shellArgs: usedArgs,
            launchStrategy: spawnConfig.postSpawnCommand ? 'shell_exec' : 'direct_shell'
          }
        })
        try {
          target.kill('SIGKILL')
        } catch {
          // ignore
        }
        // Safety net: if onExit doesn't fire within 2s after SIGKILL,
        // finalize directly to prevent zombie 'starting' sessions
        setTimeout(() => {
          const stillLive = sessions.get(sessionId)
          if (!stillLive || stillLive.pty !== target) return
          recordDiagnosticEvent({
            level: 'error',
            source: 'pty',
            event: 'pty.startup_timeout_missed_exit',
            sessionId,
            taskId: taskIdFromSessionId(sessionId),
            payload: { timeoutMs: effectiveStartupTimeout }
          })
          finalizeSessionExit(-1)
        }, 2000)
      }, effectiveStartupTimeout)
    }

    const schedulePostSpawnCommand = (target: pty.IPty): void => {
      // Pre-warmed agent: nothing to exec (it's already running). Send the
      // task's initial prompt to the live agent instead, if any.
      if (opts.adoptPty?.preWarmedAgent) {
        commandDispatchedTs = Date.now()
        if (initialPrompt) target.write(`${initialPrompt}\r`)
        return
      }
      if (!spawnConfig.postSpawnCommand) return
      // When using -c (directExec), the command is already in the shell args —
      // no need to write to stdin.
      if (directExec) {
        commandDispatchedTs = Date.now()
        return
      }
      // Adoption: the warm shell is already rc-initialized and idle at its prompt,
      // so write the launch command immediately — no shell-init delay needed.
      if (opts.adoptPty) {
        commandDispatchedTs = Date.now()
        target.write(`${spawnConfig.postSpawnCommand}\r`)
        return
      }
      // Fallback for Windows: delay to let shell initialize
      setTimeout(() => {
        const live = sessions.get(sessionId)
        if (!live || live.pty !== target) return
        commandDispatchedTs = Date.now()
        target.write(`${spawnConfig.postSpawnCommand}\r`)
      }, 250)
    }

    const attachPtyHandlers = (target: pty.IPty): void => {
      // Forward data to renderer
      target.onData(
        guardPtyCallback(sessionId, taskId, 'onData', (data0) => {
          const win = getWin() // Dynamic lookup for redirectSessionWindow()
          if (firstOutputTs === null) {
            firstOutputTs = Date.now()
            clearStartupTimeout()
            recordDiagnosticEvent({
              level: 'info',
              source: 'pty',
              event: 'pty.startup_timing',
              sessionId,
              taskId: taskIdFromSessionId(sessionId),
              payload: {
                shellSpawnMs,
                firstOutputMs: firstOutputTs - createStartedAt,
                firstOutputAfterCommandMs: commandDispatchedTs
                  ? firstOutputTs - commandDispatchedTs
                  : null,
                usedFallback,
                shell: spawnConfig.shell,
                shellArgs: usedArgs
              }
            })

            // Auto-detect session ID from disk for providers that support it.
            // Polls periodically — the CLI may not write the session file until
            // the first API handshake completes, which can take several seconds.
            if (adapter.detectSessionFromDisk && !resuming) {
              let attempts = 0
              const maxAttempts = 10
              const timer = setInterval(async () => {
                attempts++
                const sess = sessions.get(sessionId)
                if (!sess || sess.pty !== target) {
                  clearInterval(timer)
                  return
                }

                try {
                  const detected = await adapter.detectSessionFromDisk!(createStartedAt, cwd)
                  if (!detected) {
                    if (attempts >= maxAttempts) clearInterval(timer)
                    return
                  }
                  clearInterval(timer)
                  const liveSess = sessions.get(sessionId)
                  if (!liveSess || liveSess.pty !== target) return

                  recordDiagnosticEvent({
                    level: 'info',
                    source: 'pty',
                    event: 'pty.conversation_detected',
                    sessionId,
                    taskId: taskIdFromSessionId(sessionId),
                    payload: { conversationId: detected, method: 'disk' }
                  })
                  ptyEvents.emit('session-detected', sessionId, detected)
                  const detectedWin = getWin()
                  if (!detectedWin.isDestroyed()) {
                    try {
                      detectedWin.webContents.send('pty:session-detected', sessionId, detected)
                    } catch {
                      // Window destroyed, ignore
                    }
                  }
                } catch {
                  if (attempts >= maxAttempts) clearInterval(timer)
                }
              }, SESSION_ID_AUTO_DETECT_DELAY_MS)

              const sess = sessions.get(sessionId)
              if (sess) sess.sessionIdAutoDetectTimer = timer as unknown as NodeJS.Timeout
            }
          }
          // Only process if session still exists (prevents data leaking after kill)
          const session = sessions.get(sessionId)
          if (!session || session.pty !== target) {
            recordDiagnosticEvent({
              level: 'warn',
              source: 'pty',
              event: 'pty.data_without_session',
              sessionId,
              taskId: taskIdFromSessionId(sessionId),
              payload: {
                length: data0.length
              }
            })
            return
          }

          // Intercept all terminal queries synchronously before data reaches the renderer.
          // An async renderer round-trip would arrive too late — once readline is active,
          // late response bytes appear as garbage text in the user's prompt.
          const data = interceptSyncQueries(session, data0)

          // NOTE: output does NOT touch the idle-close clock. Hook-driven TUI
          // agents emit cosmetic redraws while idle; counting those as activity
          // would make agents un-hibernatable. The "user engaged" clock is the
          // renderer's real DOM interaction (via `pty:touch`); the "agent
          // blocked/working" axis is the hook-driven state + `awaitingUser`.

          // Append to buffer for history restoration (filter problematic sequences)
          const cleanData = filterBufferData(data)
          const seq = session.buffer.append(cleanData)
          // Notify external data subscribers (REST API follow endpoints)
          const listeners = dataListeners.get(sessionId)
          if (listeners) {
            for (const cb of listeners) {
              try {
                cb(cleanData)
              } catch (err) {
                recordPtyCallbackError(sessionId, taskId, 'data-listener', err)
              }
            }
          }
          // Track current seq for IPC emission
          const currentSeq = seq

          // Use adapter for activity detection
          const detectedActivity = session.adapter.detectActivity(data, session.activity)

          // Idle clock policy lives in `shouldRefreshIdleClock`. TUI adapters
          // (default) refresh only on detected activity so cursor blinks /
          // status redraws don't pin the clock open; output-driven adapters
          // (`transitionOnInput === false`, e.g. plain shell) refresh on every chunk.
          if (shouldRefreshIdleClock(session.adapter, detectedActivity)) {
            session.lastOutputTime = Date.now()
          }

          if (detectedActivity) {
            session.activity = detectedActivity
            // A working agent is, by definition, not blocked awaiting the user.
            if (detectedActivity === 'working') session.awaitingUser = false
            // Clear error state on valid activity (recovery from error)
            if (session.error && detectedActivity !== 'unknown') {
              session.error = null
            }
            // Map activity to TerminalState for backward compatibility
            const newState = activityToTerminalState(detectedActivity)
            if (newState) {
              const preview = stripAnsiForSessionParse(data)
                .slice(0, 200)
                .replace(/\s+/g, ' ')
                .trim()
              if (newState === 'running' && session.state !== 'running') {
                // See `recordWorkingDetection` in state-machine.ts for the why.
                const gate = recordWorkingDetection(session.workingDetections, Date.now())
                session.workingDetections = gate.history
                if (gate.shouldPromote) {
                  session.workingDetections = []
                  session.pendingTransitionTrigger = { source: 'detect-activity:working', preview }
                  transitionState(sessionId, newState)
                }
              } else {
                session.pendingTransitionTrigger = {
                  source: `detect-activity:${detectedActivity}`,
                  preview
                }
                transitionState(sessionId, newState)
              }
            }
          }

          // Use adapter for error detection. SESSION_NOT_FOUND is only honored
          // during the resume startup window (checkingForSessionError); after it
          // closes a match is a mid-session echo of the literal "No conversation
          // found with session ID:" string (e.g. an agent discussing this very
          // bug — which is how task 753 froze itself) and must be ignored.
          const detectedError = session.adapter.detectError(data)
          if (
            detectedError &&
            shouldHonorDetectedError(detectedError.code, session.checkingForSessionError ?? false)
          ) {
            session.error = detectedError
            session.checkingForSessionError = false
            session.pendingTransitionTrigger = {
              source: `detect-error:${detectedError.code}`,
              preview: detectedError.message?.slice(0, 200)
            }
            transitionState(sessionId, 'error')
            recordDiagnosticEvent({
              level: 'error',
              source: 'pty',
              event: 'pty.adapter_error',
              sessionId,
              taskId: taskIdFromSessionId(sessionId),
              message: detectedError.message,
              payload: {
                code: detectedError.code,
                rawLength: data.length
              }
            })
            // The error code is carried to the renderer on `pty:exit` (see
            // finalizeSessionExit) so the dead overlay can show a friendly,
            // error-specific message. No separate IPC — on a stale resume the
            // CLI exits and the overlay rides that exit. From here on, suppress
            // forwarding this session's output so the raw "No conversation
            // found …" line never paints before that overlay.
            if (resuming && detectedError.code === 'SESSION_NOT_FOUND') {
              session.suppressOutput = true
            }
          }

          // Check for prompts (drives the needs-attention UI). NOT used as a
          // hibernation blocker — the fuzzy match (any line ending in '?') gave
          // sticky false positives. Hibernation uses the hook signal instead.
          const prompt = session.adapter.detectPrompt(data)
          if (prompt) ptyEvents.emit('prompt', sessionId, prompt)
          if (prompt && !win.isDestroyed()) {
            try {
              win.webContents.send('pty:prompt', sessionId, prompt)
            } catch {
              // Window destroyed, ignore
            }
          }

          // OSC title handling: AI modes (claude-code, codex, etc.) set meaningful OSC titles.
          // Plain terminals ignore OSC (shell prompts emit noisy paths like "user@host:~/dir").
          // pty.process polling is handled separately by startTitlePolling().
          if (session.mode !== 'terminal') {
            const oscTitle = extractOscTitle(data)
            if (oscTitle) emitTitle(session, oscTitle)
          }

          if (!session.suppressOutput) ptyEvents.emit('data', sessionId, cleanData, currentSeq)
          if (!win.isDestroyed() && !session.suppressOutput) {
            try {
              // cleanData already filtered above (buffer append)
              win.webContents.send('pty:data', sessionId, cleanData, currentSeq)
            } catch {
              // Window destroyed between check and send, ignore
            }
          }

          // Detect dev server URLs (localhost/127.0.0.1/0.0.0.0 with port)
          DEV_SERVER_URL_PATTERN.lastIndex = 0
          const urlMatches = data.match(DEV_SERVER_URL_PATTERN)
          if (urlMatches && !win.isDestroyed()) {
            for (const url of urlMatches) {
              const normalized = url.replace('0.0.0.0', 'localhost')
              if (!session.detectedDevUrls.has(normalized)) {
                session.detectedDevUrls.add(normalized)
                ptyEvents.emit('dev-server-detected', sessionId, normalized)
                try {
                  win.webContents.send('pty:dev-server-detected', sessionId, normalized)
                } catch {
                  // Window destroyed, ignore
                }
              }
            }
          }

          // Parse conversation ID from /status output
          if (session.watchingForSessionId) {
            session.statusOutputBuffer += data
            let detectedConversationId: string | null = null
            if (session.adapter.detectConversationId) {
              detectedConversationId = session.adapter.detectConversationId(
                session.statusOutputBuffer
              )
            } else {
              const normalizedStatusOutput = stripAnsiForSessionParse(session.statusOutputBuffer)
              const labeledSessionMatch = normalizedStatusOutput.match(
                /\bsession(?:\s*id)?:\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/im
              )
              const uuidMatch =
                labeledSessionMatch ??
                normalizedStatusOutput.match(
                  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
                )
              if (uuidMatch) {
                detectedConversationId = uuidMatch[1] ?? uuidMatch[0]
              }
            }

            if (detectedConversationId) {
              // Remember it on the session so the hibernation gate knows this
              // agent can be resumed by id.
              session.conversationId = detectedConversationId
              recordDiagnosticEvent({
                level: 'info',
                source: 'pty',
                event: 'pty.conversation_detected',
                sessionId,
                taskId: taskIdFromSessionId(sessionId),
                payload: {
                  conversationId: detectedConversationId
                }
              })
              ptyEvents.emit('session-detected', sessionId, detectedConversationId)
              if (!win.isDestroyed()) {
                try {
                  win.webContents.send('pty:session-detected', sessionId, detectedConversationId)
                } catch {
                  // Window destroyed, ignore
                }
              }
              session.watchingForSessionId = false
              session.statusOutputBuffer = ''
              if (session.statusWatchTimeout) {
                clearTimeout(session.statusWatchTimeout)
                session.statusWatchTimeout = undefined
              }
            }
          }

          const config = getDiagnosticsConfig()
          recordDiagnosticEvent({
            level: 'debug',
            source: 'pty',
            event: 'pty.data',
            sessionId,
            taskId: taskIdFromSessionId(sessionId),
            payload: config.includePtyOutput
              ? { length: data.length, data }
              : { length: data.length, included: false }
          })
        })
      )

      target.onExit(
        guardPtyCallback(sessionId, taskId, 'onExit', ({ exitCode }) => {
          const win = getWin() // Dynamic lookup for redirectSessionWindow()
          clearStartupTimeout()
          clearEarlyExitWatchdog()

          const session = sessions.get(sessionId)
          if (!session || session.pty !== target) return

          const canAsyncFallback =
            canRetryInteractiveOnly &&
            !usedFallback &&
            firstOutputTs === null &&
            Date.now() - createStartedAt <= FAST_EXIT_FALLBACK_WINDOW_MS
          if (canAsyncFallback) {
            const fallbackArgs = initialArgs.filter((arg) => arg !== '-l')
            try {
              const fallbackPty = spawn(spawnConfig.shell, fallbackArgs)
              usedArgs = fallbackArgs
              usedFallback = true
              ptyProcess = fallbackPty
              session.pty = fallbackPty
              recordDiagnosticEvent({
                level: 'warn',
                source: 'pty',
                event: 'pty.spawn_fallback',
                sessionId,
                taskId: taskIdFromSessionId(sessionId),
                message: `Fast exit (${String(exitCode)}) without output; retrying without -l`,
                payload: {
                  shell: spawnConfig.shell,
                  fromArgs: initialArgs,
                  toArgs: fallbackArgs,
                  reason: 'fast_exit_no_output'
                }
              })
              armStartupTimeout(fallbackPty)
              attachPtyHandlers(fallbackPty)
              schedulePostSpawnCommand(fallbackPty)
              startTitlePolling(session, fallbackPty)
              return
            } catch (fallbackErr) {
              recordDiagnosticEvent({
                level: 'error',
                source: 'pty',
                event: 'pty.spawn_fallback_failed',
                sessionId,
                taskId: taskIdFromSessionId(sessionId),
                message: (fallbackErr as Error).message,
                payload: {
                  shell: spawnConfig.shell,
                  attemptedArgs: fallbackArgs
                }
              })
            }
          }

          // Stale-resume detection. A failed `--resume` (the provider
          // auto-cleaned the session — issue #90) exits NON-ZERO, which would
          // otherwise trip the interactive-shell fallback below and bury the
          // "No conversation found" error in a raw recovery shell. Detect it here
          // (ring-buffer scan via the adapter — authoritative + exit-code
          // agnostic) so `shouldShellFallback` suppresses the fallback and the
          // friendly "session expired" dead overlay surfaces instead. The code
          // rides `pty:exit` (see finalizeSessionExit) to drive that overlay.
          // Gated on `resuming`: only a resume attempt can hit a stale session.
          if (resuming && !session.error) {
            const scanned = session.adapter.detectError(session.buffer.toString())
            if (scanned) session.error = scanned
          }
          const isStaleResume = resuming && session.error?.code === 'SESSION_NOT_FOUND'

          const exitCtx = {
            exitCode,
            terminalMode,
            hasPostSpawnCommand: !!spawnConfig.postSpawnCommand,
            resuming,
            usedShellFallback,
            isStale: isStaleResume
          }

          // #5: Shell fallback — spawn interactive shell when AI provider exits
          // non-zero. Suppressed for a stale session (handled by the overlay).
          if (shouldShellFallback(exitCtx)) {
            const shellOnlyArgs = transport ? [...transport.args] : [...spawnConfig.args]
            const previousArgs = [...usedArgs]
            try {
              const fallbackShellPty = spawn(spawnFile, shellOnlyArgs)
              usedShellFallback = true
              ptyProcess = fallbackShellPty
              session.pty = fallbackShellPty
              usedArgs = shellOnlyArgs
              usedFallback = true

              const infoLine = buildRecoveryMessage(terminalMode, exitCode)
              session.buffer.append(infoLine)
              if (!win.isDestroyed()) {
                try {
                  win.webContents.send(
                    'pty:data',
                    sessionId,
                    infoLine,
                    session.buffer.getCurrentSeq()
                  )
                } catch {
                  // Window destroyed, ignore
                }
              }

              recordDiagnosticEvent({
                level: 'warn',
                source: 'pty',
                event: 'pty.shell_fallback',
                sessionId,
                taskId: taskIdFromSessionId(sessionId),
                message: `${terminalMode} exited with code ${String(exitCode)}; falling back to interactive shell`,
                payload: {
                  exitCode,
                  mode: terminalMode,
                  previousArgs,
                  fallbackArgs: shellOnlyArgs
                }
              })

              armStartupTimeout(fallbackShellPty)
              attachPtyHandlers(fallbackShellPty)
              startTitlePolling(session, fallbackShellPty)
              return
            } catch (fallbackErr) {
              recordDiagnosticEvent({
                level: 'error',
                source: 'pty',
                event: 'pty.shell_fallback_failed',
                sessionId,
                taskId: taskIdFromSessionId(sessionId),
                message: (fallbackErr as Error).message,
                payload: {
                  shell: spawnFile,
                  attemptedArgs: shellOnlyArgs
                }
              })
            }
          }

          finalizeSessionExit(exitCode)
        })
      )
    }

    attachPtyHandlers(ptyProcess)
    armStartupTimeout(ptyProcess)
    schedulePostSpawnCommand(ptyProcess)
    startTitlePolling(sessions.get(sessionId)!, ptyProcess)
    // Recover from rare race where an ultra-fast child can exit before handlers are attached.
    earlyExitWatchdog = setTimeout(() => {
      const session = sessions.get(sessionId)
      if (!session || firstOutputTs !== null) return
      const pid = session.pty.pid
      if (typeof pid !== 'number' || pid <= 0) {
        recordDiagnosticEvent({
          level: 'warn',
          source: 'pty',
          event: 'pty.missed_exit_recovered',
          sessionId,
          taskId: taskIdFromSessionId(sessionId),
          payload: { reason: 'invalid_pid' }
        })
        finalizeSessionExit(-1)
        return
      }
      try {
        process.kill(pid, 0)
      } catch {
        recordDiagnosticEvent({
          level: 'warn',
          source: 'pty',
          event: 'pty.missed_exit_recovered',
          sessionId,
          taskId: taskIdFromSessionId(sessionId),
          payload: { reason: 'pid_not_running', pid }
        })
        finalizeSessionExit(-1)
      }
    }, 300)

    // Stop checking for session errors after 5 seconds.
    if (resuming) {
      setTimeout(() => {
        const session = sessions.get(sessionId)
        if (session) {
          session.checkingForSessionError = false
          // Safety net: a real stale resume exits within the window (the dead
          // overlay rides that exit), so a session still alive here did NOT fail
          // that way. Release output suppression unconditionally — it must never
          // outlive the startup window, or the terminal goes permanently blind
          // (records output but never displays it) until a tab-switch replay.
          session.suppressOutput = false
        }
      }, 5000)
    }

    return { success: true }
  } catch (error) {
    const err = error as Error
    recordDiagnosticEvent({
      level: 'error',
      source: 'pty',
      event: 'pty.create_failed',
      sessionId,
      taskId: taskIdFromSessionId(sessionId),
      message: err.message,
      payload: {
        stack: err.stack ?? null,
        launchStrategy: spawnAttempt?.hasPostSpawnCommand ? 'shell_exec' : 'direct_shell',
        shell: spawnAttempt?.shell ?? null,
        shellArgs: spawnAttempt?.shellArgs ?? null,
        cwd: cwd ?? null
      }
    })
    return {
      success: false,
      error: `${err.message} (shell=${spawnAttempt?.shell ?? '?'}, cwd=${cwd || '?'})`
    }
  }
}

/**
 * Submit a user-typed prompt to the PTY. Routes through the adapter's
 * `encodeSubmit` so per-mode wire-byte encoding (Kitty Shift+Enter for
 * claude-code, plain CR for shells, etc.) lives in one place.
 *
 * Single canonical entry for "fire prompt" — used by REST `/submit`, IPC
 * `pty:submit`, future MCP submit tool. Differs from `writePty`, which is raw.
 */
export function submitPty(sessionId: string, text: string): boolean {
  const session = sessions.get(sessionId)
  if (!session) return false
  return writePty(sessionId, session.adapter.encodeSubmit(text))
}

export function writePty(sessionId: string, data: string): boolean {
  const session = sessions.get(sessionId)
  if (!session) return false

  // NOTE: writePty does NOT touch the idle-close clock. PTY input is a noisy
  // mix of real typing and terminal protocol the renderer writes back (focus/
  // cursor reports). The "user engaged" signal comes from the renderer's real
  // DOM events via `pty:touch`; the "agent blocked" signal comes from hooks.

  // Observation only: ESC bytes in stdin are the user's interrupt key for
  // claude-code (and codex). Log as a precise anchor so we can correlate
  // user keystrokes against subsequent hook arrivals (or their absence).
  // Pure passive — does NOT change state.
  if (data.includes('\x1b')) {
    recordDiagnosticEvent({
      level: 'info',
      source: 'pty',
      event: 'pty.user_esc_input',
      sessionId,
      taskId: session.taskId,
      message: 'esc-byte-written',
      payload: { currentState: session.state, mode: session.mode, bytes: data.length }
    })
  }

  // Buffer input to detect commands
  session.inputBuffer += data

  // On Enter: transition TUI to 'working' if adapter opts in. Submit-Enter
  // detection must include the kitty CSI-u encoding — once Claude Code enables
  // the kitty keyboard protocol, xterm sends Enter as `ESC [ 13 u` and no \r
  // ever reaches this write (a bare CR/LF check missed every typed submit, so
  // markSessionUserInput never ran → needs_attention never fired).
  const hasNewline = containsSubmitEnter(data)
  if (hasNewline) {
    // Notify turn-tracker subscribers BEFORE we reset the buffer below.
    // Snapshot of stdin so far = the just-submitted prompt.
    const submittedLine = session.inputBuffer
    if (submittedLine.trim().length > 0) {
      emitInputSubmit(sessionId, session.taskId, submittedLine)
      markSessionUserInput(sessionId)
      // Counterpart to task.attention_transition: proves the user-input mark
      // was set (and under which key) when a later running→idle checks it.
      recordDiagnosticEvent({
        level: 'info',
        source: 'pty',
        event: 'pty.user_input_marked',
        sessionId,
        taskId: session.taskId,
        message: 'submit-enter',
        payload: { mode: session.mode, bufferedChars: submittedLine.length }
      })
    }
    if (
      shouldFlipToRunningOnInput(session.adapter, session.state, session.inputBuffer.trim().length)
    ) {
      session.activity = 'working'
      session.lastOutputTime = Date.now() // reset idle timer from input submission
      session.pendingTransitionTrigger = {
        source: 'user-input',
        preview: submittedLine.slice(0, 200).replace(/\s+/g, ' ').trim()
      }
      transitionState(sessionId, 'running')
    }
    const cmd = session.adapter.sessionIdCommand ?? '/status'
    if (session.inputBuffer.includes(cmd)) {
      if (session.statusWatchTimeout) {
        clearTimeout(session.statusWatchTimeout)
        session.statusWatchTimeout = undefined
      }
      session.watchingForSessionId = true
      session.statusOutputBuffer = ''

      // Stop watching after timeout
      session.statusWatchTimeout = setTimeout(() => {
        if (session.watchingForSessionId) {
          session.watchingForSessionId = false
          session.statusOutputBuffer = ''
          session.statusWatchTimeout = undefined
        }
      }, SESSION_ID_WATCH_TIMEOUT_MS)
    }
    session.inputBuffer = '' // reset on enter
  }

  session.pty.write(data)
  return true
}

export function resizePty(sessionId: string, cols: number, rows: number): boolean {
  const session = sessions.get(sessionId)
  if (!session) return false
  // Validate bounds to prevent crashes
  const safeCols = Math.max(1, Math.min(cols, 500))
  const safeRows = Math.max(1, Math.min(rows, 500))
  try {
    session.pty.resize(safeCols, safeRows)
  } catch (error) {
    // PTY fd may be invalid if process died — non-fatal
    recordDiagnosticEvent({
      level: 'warn',
      source: 'pty',
      event: 'pty.resize_failed',
      sessionId,
      taskId: taskIdFromSessionId(sessionId),
      message: (error as Error).message
    })
    return false
  }
  return true
}

export function killPty(sessionId: string): boolean {
  // Test-only (PLAYWRIGHT): record the kill CALL while the create capture is on
  // (the stubbed create never registers a session, so record before the lookup).
  if (process.env.PLAYWRIGHT === '1' && ptyCreateCaptureOn) {
    ptyKillCapturedSessionIds.push(sessionId)
  }
  const session = sessions.get(sessionId)
  if (!session) {
    recordDiagnosticEvent({
      level: 'warn',
      source: 'pty',
      event: 'pty.kill_missing',
      sessionId,
      taskId: taskIdFromSessionId(sessionId)
    })
    return false
  }
  recordDiagnosticEvent({
    level: 'info',
    source: 'pty',
    event: 'pty.kill',
    sessionId,
    taskId: session.taskId
  })
  // Clear any pending timeouts to prevent orphaned callbacks
  stopSessionTimers(session)
  // Note: we intentionally do NOT eagerly delete from sessions/dataListeners
  // here. Doing so causes the node-pty onExit handler's guard
  // (`if (!session || session.pty !== target) return`) to fire, which would
  // skip finalizeSessionExit and prevent pty:exit / pty:state-change('dead')
  // from reaching the renderer (GitHub issue #77). Instead, SIGKILL first and
  // let the natural onExit path run through finalizeSessionExit; the 100 ms
  // trailing cleanup inside finalizeSessionExit handles map deletion.
  const finalizer = session.finalizer
  try {
    session.pty.kill('SIGKILL')
  } catch {
    // Process already exited (e.g. Windows). onExit may not fire — finalize
    // explicitly so the renderer is still notified.
    finalizer?.(PTY_EXIT_KILLED_BY_HOST)
    return true
  }
  // Watchdog: if onExit doesn't deliver within KILL_FINALIZE_WATCHDOG_MS,
  // invoke the finalizer directly. `finalized` flag makes double-invocation safe.
  setTimeout(() => {
    if (sessions.get(sessionId) === session) {
      finalizer?.(PTY_EXIT_KILLED_BY_HOST)
    }
  }, KILL_FINALIZE_WATCHDOG_MS)
  return true
}

export function hasPty(sessionId: string): boolean {
  return sessions.has(sessionId)
}

/** Find a live session by taskId + mode. Used by the agent-hook REST handler to
 *  resolve `{ taskId, agentId }` → sessionId so hook events can drive state
 *  transitions. Prefers the main session (`sessionId === taskId`) when multiple
 *  panes share a mode. Returns null if no session matches. */
export function findSessionByTaskIdAndMode(taskId: string, mode: TerminalMode): string | null {
  let fallback: string | null = null
  for (const [sessionId, session] of sessions) {
    if (session.taskId !== taskId || session.mode !== mode) continue
    if (sessionId === taskId) return sessionId
    fallback ??= sessionId
  }
  return fallback
}

/** External entry point for hook-driven state transitions. Tags the
 *  diagnostic trigger as `hook:<event>` so emit logs distinguish hook
 *  signals from regex / silence-timer paths. Also refreshes `lastOutputTime`
 *  — any hook firing is proof the agent is alive, so the silence-timer
 *  fail-safe should re-arm. No-op if session is gone. */
export function transitionStateFromHook(
  sessionId: string,
  newState: TerminalState,
  hookEvent: string
): boolean {
  const session = sessions.get(sessionId)
  if (!session) return false
  session.lastOutputTime = Date.now()
  session.pendingTransitionTrigger = { source: `hook:${hookEvent}` }
  transitionState(sessionId, newState)
  return true
}

/** Refresh the silence-timer clock for a session WITHOUT changing state.
 *  Used by hook events that prove activity but don't carry a state-transition
 *  semantic (e.g. PostToolUse, SubagentStop, PreCompact for claude-code).
 *  No-op if session is gone. Returns whether the refresh landed. */
export function markSessionActiveFromHook(sessionId: string): boolean {
  const session = sessions.get(sessionId)
  if (!session) return false
  session.lastOutputTime = Date.now()
  return true
}

export function getBuffer(sessionId: string): string | null {
  const session = sessions.get(sessionId)
  return session?.buffer.toString() ?? null
}

export function clearBuffer(sessionId: string): { success: boolean; clearedSeq: number | null } {
  const session = sessions.get(sessionId)
  if (!session) return { success: false, clearedSeq: null }

  const clearedSeq = session.buffer.getCurrentSeq()
  session.buffer.clear()
  return { success: true, clearedSeq }
}

export function getBufferSince(sessionId: string, afterSeq: number): BufferSinceResult | null {
  const session = sessions.get(sessionId)
  if (!session) return null
  return {
    chunks: session.buffer.getChunksSince(afterSeq),
    currentSeq: session.buffer.getCurrentSeq()
  }
}

/** Injected by composition root (apps/app) to surface tab id + label per
 *  session without pty-manager touching the `terminal_tabs` table (owned by
 *  the task-terminals package). */
type PtyEnricher = (raw: PtyInfo[]) => PtyInfo[] | Promise<PtyInfo[]>
let ptyEnricher: PtyEnricher | null = null

export function setPtyEnricher(fn: PtyEnricher | null): void {
  ptyEnricher = fn
}

export async function listPtys(): Promise<PtyInfo[]> {
  const raw: PtyInfo[] = []
  for (const [sessionId, session] of sessions) {
    raw.push({
      sessionId,
      taskId: session.taskId,
      // Resolve via the identity seam (correct for opaque ids); the enricher
      // then only needs to attach the label. Was '' + enricher sessionId-split.
      tabId: resolveTabRowId(sessionId),
      label: null,
      lastOutputTime: session.lastOutputTime,
      createdAt: session.createdAt,
      mode: session.mode,
      state: session.state
    })
  }
  return ptyEnricher ? await ptyEnricher(raw) : raw
}

/** Returns a map of sessionId → PID for all alive sessions. Used for stats polling. */
export function getPtyPids(): Map<string, number> {
  const pids = new Map<string, number>()
  for (const [sessionId, session] of sessions) {
    if (session.state !== 'dead') {
      pids.set(sessionId, session.pty.pid)
    }
  }
  return pids
}

export function getState(sessionId: string): TerminalState | null {
  const session = sessions.get(sessionId)
  return session?.state ?? null
}

/** Redirect a PTY session's event output to a different BrowserWindow. */
export function redirectSessionWindow(sessionId: string, newWin: PtySessionWindow): boolean {
  const session = sessions.get(sessionId)
  if (!session) return false
  session.win = newWin
  return true
}

function stopSessionTimers(session: PtySession): void {
  if (session.statusWatchTimeout) {
    clearTimeout(session.statusWatchTimeout)
    session.statusWatchTimeout = undefined
  }
  if (session.sessionIdAutoDetectTimer) {
    clearTimeout(session.sessionIdAutoDetectTimer)
    session.sessionIdAutoDetectTimer = undefined
  }
  if (session.hibernateTimer) {
    clearTimeout(session.hibernateTimer)
    session.hibernateTimer = undefined
  }
  stopTitlePolling(session)
}

function shutdownPtySession(
  session: PtySession,
  opts: Required<PtyShutdownOptions>
): Promise<{
  id: string
  exited: boolean
  killed: boolean
  timedOut: boolean
  errors: PtyShutdownResult['errors']
}> {
  return new Promise((resolve) => {
    const id = session.sessionId
    const errors: PtyShutdownResult['errors'] = []
    let settled = false
    let killed = false
    let termTimer: ReturnType<typeof setTimeout> | null = null
    let hardTimer: ReturnType<typeof setTimeout> | null = null

    const recordError = (phase: string, err: unknown): void => {
      errors.push({ id, phase, message: toErrorMessage(err) })
    }
    const cleanup = (): void => {
      if (termTimer) clearTimeout(termTimer)
      if (hardTimer) clearTimeout(hardTimer)
      session.shutdownWaiters?.delete(onExit)
    }
    const settle = (timedOut: boolean): void => {
      if (settled) return
      settled = true
      cleanup()
      if (timedOut) {
        try {
          session.finalizer?.(-1)
        } catch (err) {
          recordError('finalize', err)
        }
      }
      resolve({ id, exited: !timedOut, killed, timedOut, errors })
    }
    const onExit = (): void => settle(false)

    if (!sessions.has(id) || session.state === 'dead') {
      resolve({ id, exited: true, killed: false, timedOut: false, errors })
      return
    }

    stopSessionTimers(session)
    if (!session.shutdownWaiters) session.shutdownWaiters = new Set()
    session.shutdownWaiters.add(onExit)

    try {
      session.pty.kill('SIGTERM')
    } catch (err) {
      recordError('sigterm', err)
    }

    termTimer = setTimeout(() => {
      killed = true
      try {
        session.pty.kill('SIGKILL')
      } catch (err) {
        recordError('sigkill', err)
      }
    }, opts.termGraceMs)
    termTimer.unref?.()

    hardTimer = setTimeout(() => settle(true), opts.hardTimeoutMs)
    hardTimer.unref?.()
  })
}

export async function shutdownAllPtys(
  options: PtyShutdownOptions = {}
): Promise<PtyShutdownResult> {
  setShuttingDown(true)
  const opts: Required<PtyShutdownOptions> = {
    termGraceMs: options.termGraceMs ?? DEFAULT_SHUTDOWN_TERM_GRACE_MS,
    hardTimeoutMs: options.hardTimeoutMs ?? DEFAULT_SHUTDOWN_HARD_TIMEOUT_MS
  }
  const targets = Array.from(sessions.values())
  const results = await Promise.all(targets.map((session) => shutdownPtySession(session, opts)))
  return {
    total: results.length,
    exited: results.filter((r) => r.exited).length,
    killed: results.filter((r) => r.killed).length,
    timedOut: results.filter((r) => r.timedOut).length,
    errors: results.flatMap((r) => r.errors)
  }
}

export function killAllPtys(): void {
  for (const [taskId] of sessions) {
    killPty(taskId)
  }
}

/** Broadcast a respawn request for a task to the renderer. The renderer decides
 *  whether any mounted TaskDetailPage should act (e.g. main tab PTY no longer
 *  exists and AI mode is configured). Matches the pty:exit IPC dispatch pattern. */
export function broadcastRespawnRequest(taskId: string): void {
  ptyEvents.emit('respawn-suggested', taskId)
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    mainWindow.webContents.send('pty:respawn-suggested', taskId)
  } catch {
    // window destroyed — ignore
  }
  recordDiagnosticEvent({
    level: 'info',
    source: 'pty',
    event: 'pty.respawn_suggested',
    sessionId: taskId,
    taskId
  })
}

/** Pending ensure-alive ack waiters, keyed by per-call reqId. Each REST call
 *  gets its own reqId so the renderer can dedupe stale retries (race between
 *  ack send and retry interval firing) without affecting concurrent calls.
 *  Ack payload: 'ok' | 'already-alive' | 'error'. */
let nextEnsureAliveReqId = 1
const pendingEnsureAliveAcks = new Map<number, (result: 'ok' | 'already-alive' | 'error') => void>()

/** Resolve a pending ensure-alive waiter by reqId. Shared by the legacy
 *  `pty:ensure-alive:ack` IPC and the tRPC `pty.ackEnsureAlive` mutation
 *  (dual-emit) — both feed the same `pendingEnsureAliveAcks` map. */
export function ackEnsureAlive(
  reqId: number,
  result: 'ok' | 'already-alive' | 'error'
): void {
  const resolve = pendingEnsureAliveAcks.get(reqId)
  if (!resolve) return
  pendingEnsureAliveAcks.delete(reqId)
  resolve(result)
}

onPtyHostBus(
  'pty:ensure-alive:ack',
  (_e, reqId: number, result: 'ok' | 'already-alive' | 'error') => ackEnsureAlive(reqId, result)
)

const ENSURE_ALIVE_RETRY_MS = 250

export type EnsureAliveResult = 'ok' | 'already-alive' | 'error' | 'no-window' | 'timeout'

/** Ensure a task's main PTY is alive.
 *  - force=true: kill + respawn regardless of liveness (used by `slay pty respawn`).
 *  - force=false: no-op if alive, else mount + spawn (used by `slay pty start`,
 *    `slay tasks open --start`, and auto-start in write/submit).
 *
 *  Awaits the renderer's ack to confirm a TaskDetailPage actually handled it.
 *  Retries the broadcast on an interval so a freshly-mounted TaskDetailPage
 *  (e.g. just opened via `app:open-task`) still catches the request after its
 *  useEffect attaches the listener. */
export function requestEnsureAlive(
  taskId: string,
  opts: { force: boolean; timeoutMs: number }
): Promise<EnsureAliveResult> {
  // Prefer cached mainWindow (set on ready-to-show), but fall back to any live
  // BrowserWindow. The cached singleton lags startup-order: CLI calls before
  // `ready-to-show` fires would otherwise see 'no-window' even with a window
  // present. Splash window uses a `data:` URL — exclude it.
  const liveWindow =
    mainWindow && !mainWindow.isDestroyed()
      ? mainWindow
      : (getPtyHostBridge().getAllWindows().find(
          (w) => !w.isDestroyed() && !w.webContents.getURL().startsWith('data:')
        ) ?? null)
  if (!liveWindow) return Promise.resolve('no-window')
  // Note: callers should pre-check liveness (the main sessionId convention
  // lives in the renderer, e.g. `${taskId}:${taskId}` — see TaskDetailPage's
  // getMainSessionId). The renderer-side handler will ack 'already-alive' if
  // it observes a live session at receive time.
  recordDiagnosticEvent({
    level: 'info',
    source: 'pty',
    event: opts.force ? 'pty.respawn_forced' : 'pty.ensure_alive',
    sessionId: taskId,
    taskId
  })
  const reqId = nextEnsureAliveReqId++
  return new Promise((resolve) => {
    let resolved = false
    const finish = (r: EnsureAliveResult): void => {
      if (resolved) return
      resolved = true
      clearInterval(retry)
      clearTimeout(timer)
      pendingEnsureAliveAcks.delete(reqId)
      resolve(r)
    }
    pendingEnsureAliveAcks.set(reqId, (result) => finish(result))
    const send = (): void => {
      if (liveWindow.isDestroyed()) {
        finish('timeout')
        return
      }
      // tRPC mirror — re-emitted on every retry (NOT just once) so a renderer
      // that subscribes to `pty.onEnsureAlive` AFTER the first tick (e.g. a
      // TaskDetailPage still mounting from a just-fired `open-task`) still
      // catches the request. The renderer dedupes by reqId, so re-emits are
      // idempotent. Load-bearing under the side-car cutover, where the IPC
      // `webContents.send` below targets a no-op stub window (output + ack now
      // flow exclusively over tRPC: ptyEvents + the pty.ackEnsureAlive mutation).
      ptyEvents.emit('ensure-alive', taskId, reqId, opts.force)
      try {
        liveWindow.webContents.send('pty:ensure-alive', taskId, reqId, opts.force)
      } catch {
        // window destroyed mid-send — let timeout catch it
      }
    }
    send()
    const retry = setInterval(send, ENSURE_ALIVE_RETRY_MS)
    const timer = setTimeout(() => finish('timeout'), opts.timeoutMs)
  })
}

/** Single invariant entry point for "task reached a terminal status". Called from
 *  every status-write path (updateTask via runtimeAdapter, integrations sync/pull,
 *  bulk remap, project automation). Add new side-effects here, not at call sites. */
export function onTaskReachedTerminal(taskId: string): void {
  // Record the kill timestamp (lastPtyKilledAt) here, at the single invariant
  // entry point, so the revive flow (decideReviveMode) can tell a hot bounce
  // from a cold one — covering both PTY and chat modes regardless of how the
  // underlying session is torn down. See plans/conversation-id-robustness.md.
  onHostKillHandler?.(taskId)
  killPtysByTaskId(taskId)
  killChatsByTaskId(taskId)
}

export function killPtysByTaskId(taskId: string): void {
  const toKill = [...sessions.entries()]
    .filter(([, session]) => session.taskId === taskId)
    .map(([sessionId]) => sessionId)
  for (const sessionId of toKill) {
    killPty(sessionId)
  }
}
