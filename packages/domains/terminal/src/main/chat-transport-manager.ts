import { spawn as realSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import readline from 'node:readline'
import type { AgentEvent } from '../shared/agent-events'
import type { ChatSessionStateEntry } from '../shared/types'
import type {
  AgentBackend,
  ChatDriverContext,
  ChatSessionDriver,
  PermissionDecision
} from './agents/types'
import { getBackend } from './agents/registry'
import { whichBinary as realWhichBinary } from './shell-env'
import { recordDiagnosticEvent } from '@slayzone/diagnostics/main'
import type { BufferedEvent } from './chat-events-store'
// `chatMode` is an opaque, provider-specific runtime/permission mode id
// (Claude `ChatMode` for claude-chat, Codex runtime mode for codex-chat) —
// typed `string`. `shared/chat-mode-catalog.ts` owns the per-mode vocabulary.
// `chatModel` is an opaque, provider-specific model id (`claude --model`
// alias for claude-chat, Codex model id for codex-chat) — typed as `string`.
// The provider-aware catalog (`shared/chat-model-catalog.ts`) owns validity.
import type { ChatEffort } from '../shared/chat-effort'
import type { ChatCollaborationMode } from '../shared/chat-collaboration'
import { markSessionUserInput, clearSessionUserInputMark } from './user-input-tracker'

export { markSessionUserInput }
export type { BufferedEvent } from './chat-events-store'

/**
 * `not-spawned` — session hydrated from persisted history but the OS subprocess
 * has not been spawned yet. Tab-open hydrates into this state; the first
 * `chat:send` (or queue drain) transitions through `starting → idle`. Skeleton
 * sessions in `not-spawned` are excluded from `listChatSessions` so the registry
 * never advertises them as live.
 */
export type ChatTerminalState = 'not-spawned' | 'starting' | 'running' | 'idle' | 'error' | 'dead'

/** Dependency-injection seam for tests AND for production wiring (event persistence). */
export interface TransportDeps {
  spawn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess
  whichBinary: (name: string) => Promise<string | null>
  broadcastEvent: (tabId: string, event: AgentEvent, seq: number) => void
  /**
   * sessionId tags the dying session so the renderer reducer can drop stale
   * exits (e.g. an old session that died while a new one is starting after reset).
   */
  broadcastExit: (
    tabId: string,
    sessionId: string,
    code: number | null,
    signal: string | null
  ) => void
  /** Broadcast state transitions on `pty:state-change` so the existing UI reflects chat activity. */
  broadcastStateChange: (
    sessionId: string,
    newState: ChatTerminalState,
    oldState: ChatTerminalState
  ) => void
  /**
   * Notify main-process global state listeners (e.g. task-automation). Default
   * no-op. chat-handlers wires this to pty-manager's listener set so chat
   * activity drives the same auto-status rules as PTY sessions.
   */
  onStateChange?: (
    sessionId: string,
    newState: ChatTerminalState,
    oldState: ChatTerminalState
  ) => void
  /**
   * Called for every event appended to a session's buffer. Default no-op.
   * chat-handlers wires this to persist events to SQLite so chat history
   * survives full Electron app reload.
   */
  persistEvent: (tabId: string, seq: number, event: AgentEvent) => void
  /**
   * Non-destructive process-liveness probe (`process.kill(pid, 0)`-style).
   * Injected so the watchdog tests can control the verdict deterministically.
   */
  isProcessAlive: (pid: number) => boolean
  /** Optional watchdog timeout override — tests set tiny values to avoid real waits. */
  watchdogTimings?: { startingBoundMs: number; runningStallMs: number; killGraceMs: number }
}

/**
 * Default broadcast uses Electron's BrowserWindow. We require it lazily so that
 * non-electron test runs can import this module without pulling in `electron`.
 */
function electronBroadcast(
  channel: 'chat:event' | 'chat:exit' | 'pty:state-change'
): (...args: unknown[]) => void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BrowserWindow } = require('electron') as typeof import('electron')
    return (...args: unknown[]) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (w.isDestroyed()) continue
        w.webContents.send(channel, ...args)
      }
    }
  } catch {
    // Non-electron context (tests run under tsx). No-op broadcast.
    return () => {
      // no-op
    }
  }
}

const defaultDeps: TransportDeps = {
  spawn: realSpawn,
  whichBinary: realWhichBinary,
  broadcastEvent: (tabId, event, seq) => {
    electronBroadcast('chat:event')(tabId, event, seq)
  },
  broadcastExit: (tabId, sessionId, code, signal) => {
    electronBroadcast('chat:exit')(tabId, sessionId, code, signal)
  },
  broadcastStateChange: (sessionId, newState, oldState) => {
    electronBroadcast('pty:state-change')(sessionId, newState, oldState)
  },
  persistEvent: () => {
    // No-op default: persistence is wired in main via configureTransport().
  },
  isProcessAlive: (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
}

let deps: TransportDeps = defaultDeps

export function setTransportDepsForTests(override: Partial<TransportDeps>): void {
  deps = { ...defaultDeps, ...override }
}

/**
 * Composition-root hook to flip the `was_spawned` flag on a `terminal_tabs`
 * row. We can't import `@slayzone/task-terminals` from inside the terminal
 * package (would cycle), so the app wires this at boot. Called true on
 * successful spawn, false on natural / user-initiated exit unless the app
 * is shutting down (see `setChatShuttingDown`).
 */
type SpawnedSetter = (tabId: string, wasSpawned: boolean) => void
let spawnedSetter: SpawnedSetter | null = null
export function setSpawnedTabRecorder(fn: SpawnedSetter | null): void {
  spawnedSetter = fn
}

/**
 * Shutdown gate. When true, the exit handler does NOT clear `was_spawned`
 * so the next boot can auto-restart this chat session. Composition root
 * MUST set this true during app quit before calling `shutdownChatTransports`.
 */
let isShuttingDown = false
export function setShuttingDown(v: boolean): void {
  isShuttingDown = v
}

export interface ShutdownOptions {
  termGraceMs?: number
  hardTimeoutMs?: number
}

export interface TransportShutdownResult {
  total: number
  exited: number
  killed: number
  timedOut: number
  errors: Array<{ id: string; phase: string; message: string }>
}

const DEFAULT_SHUTDOWN_TERM_GRACE_MS = 1500
const DEFAULT_SHUTDOWN_HARD_TIMEOUT_MS = 5000

/** Production-side dep injection (e.g. wire persistEvent to SQLite at startup). */
export function configureTransport(override: Partial<TransportDeps>): void {
  deps = { ...deps, ...override }
}

export function resetTransportDeps(): void {
  deps = defaultDeps
}

export interface ChatSessionInfo {
  sessionId: string
  tabId: string
  taskId: string
  mode: string
  cwd: string
  pid: number | null
  startedAt: string
  ended: boolean
  /**
   * Resolved permission mode this session was spawned with. In-memory truth
   * — fresher than DB cache because it's set synchronously at spawn time
   * (DB persistence may lag behind). Optional because non-claude adapters
   * don't track a permission mode. Renderer prefers this over `chat:getMode`
   * (DB cache) on mount when a session exists.
   */
  chatMode?: string | null
  /** Resolved chat model id this session was spawned with. */
  chatModel?: string | null
  /** Resolved reasoning effort this session was spawned with. `null` = inherit. */
  chatEffort?: ChatEffort | null
  /** Resolved collaboration mode this session was spawned with. `null` = provider default. */
  chatCollaboration?: ChatCollaborationMode | null
  /** Whether Codex Fast Mode was enabled for this session's spawn. */
  chatFastMode?: boolean
}

interface Session {
  sessionId: string
  /**
   * Opaque identifier for this OS subprocess instance. Distinct from
   * `sessionId` (Claude SDK conversation id, which --resume preserves across
   * kill+respawn). Emitted as the first event of each spawn so the renderer
   * can scope process-children resources (bg shells) to the spawning process.
   */
  spawnId: string
  tabId: string
  /** Parent task id — used to key `pty:state-change` broadcasts matching the main terminal sessionId format `${taskId}:${tabId}`. */
  taskId: string
  mode: string
  cwd: string
  backend: AgentBackend
  /**
   * Per-spawn protocol driver. Null while the session is `not-spawned`;
   * created in `spawnSubprocess` and disposed in the `exit` handler.
   */
  driver: ChatSessionDriver | null
  /**
   * The OS subprocess. Null when the session is hydrated-only (`not-spawned`
   * state) — buffer + metadata exist, but no child has been started. Set by
   * `ensureSpawned`; cleared by `respawnFresh` between kill and spawn.
   */
  child: ChildProcess | null
  buffer: BufferedEvent[]
  nextSeq: number
  ended: boolean
  startedAt: string
  /** Last event flow timestamp (ms). Drives idle-age threshold in agent-status panel. */
  lastOutputTime: number
  terminalState: ChatTerminalState
  /** True if this spawn used --resume (vs fresh --session-id). */
  usedResume: boolean
  /** True once we received any confirmation that the session is healthy. */
  sawHealthyTurn: boolean
  /** True once we've triggered a retry spawn. Prevents retry loops. */
  retryScheduled: boolean
  /** Opts needed to respawn. */
  respawnOpts: CreateChatOpts
  /** Resolved chat permission mode this session was spawned with. */
  chatMode: string | null
  /** Resolved chat model id this session was spawned with. */
  chatModel: string | null
  /** Resolved reasoning effort this session was spawned with. */
  chatEffort: ChatEffort | null
  /** Resolved collaboration mode this session was spawned with. */
  chatCollaboration: ChatCollaborationMode | null
  /** Whether Codex Fast Mode was enabled for this session's spawn. */
  chatFastMode: boolean
  onPersistSessionId?: (id: string) => void
  onInvalidResume?: () => void
  /**
   * Tentative-resume staging buffer. While `usedResume && !sawHealthyTurn`,
   * events are held here instead of being persisted/broadcast/state-transitioned.
   * On the first healthy event we flush in order; on detected resume-failure
   * we drop them. Keeps the failed-spawn's stderr/process-exit/error-result
   * out of `chat_events` and the renderer.
   */
  staged: AgentEvent[]
  /** Re-entry guard: true while flushing `staged` through `commitEvent`. */
  flushingStaged: boolean
  /**
   * Liveness watchdog — a single recurring timer that forces a session stuck
   * in `starting`/`running` to a terminal state. `null` when disarmed.
   */
  watchdogTimer: ReturnType<typeof setTimeout> | null
  /** Kill-escalation ladder position for the watchdog. */
  watchdogKillStage: 'none' | 'sigterm' | 'sigkill'
  /** Timestamp (ms) of the last forward-progress signal while `running`. */
  watchdogLastProgress: number
  /**
   * True while the CLI is parked on an inbound `permission-request` (e.g.
   * AskUserQuestion). Drives the idle flip so tab indicators / kanban /
   * automations see "waiting on user", but also gates the queue drainer:
   * draining a queued user_message into stdin mid-tool would interleave with
   * the pending tool_result the SDK still expects. Cleared on the first
   * non-permission event after the user answers.
   */
  awaitingUserInput: boolean
}

const MAX_BUFFER_EVENTS = 2000
const STDERR_FLUSH_INTERVAL_MS = 100

// Liveness watchdog — guarantees a session always reaches a terminal state.
// `starting`: max wait for the subprocess to report ready (mirrors the xterm
// watchdog). `running`: max time with NO forward progress — a sliding window
// reset by every progress event, so a long healthy turn is never false-killed.
// `kill grace`: wait after a SIGTERM before escalating to SIGKILL.
const WATCHDOG_STARTING_BOUND_MS = 20_000
const WATCHDOG_RUNNING_STALL_MS = 300_000
const WATCHDOG_KILL_GRACE_MS = 2_000

function watchdogTimings(): {
  startingBoundMs: number
  runningStallMs: number
  killGraceMs: number
} {
  return (
    deps.watchdogTimings ?? {
      startingBoundMs: WATCHDOG_STARTING_BOUND_MS,
      runningStallMs: WATCHDOG_RUNNING_STALL_MS,
      killGraceMs: WATCHDOG_KILL_GRACE_MS
    }
  )
}

const sessions = new Map<string, Session>()

function appendToBuffer(session: Session, event: AgentEvent): number {
  const seq = session.nextSeq++
  session.buffer.push({ seq, event })
  if (session.buffer.length > MAX_BUFFER_EVENTS) {
    session.buffer.splice(0, session.buffer.length - MAX_BUFFER_EVENTS)
  }
  session.lastOutputTime = Date.now()
  // Mirror to persistence layer (no-op if unconfigured).
  try {
    deps.persistEvent(session.tabId, seq, event)
  } catch (err) {
    console.error('[chat-transport] persistEvent failed:', err)
  }
  return seq
}

// ---- liveness watchdog ----
// Guarantees every session reaches a terminal state. A session stuck in
// `starting` (subprocess never reported ready) or `running` (a turn making no
// forward progress) is force-killed; a subprocess that died without delivering
// an `exit` event is reaped through the canonical exit handler. Self-healing:
// the timer re-arms across kill escalation, so `dead` is reached even when
// every kill's `exit` event is lost.

type WatchdogVector = 'stuck-starting' | 'running-stall' | 'fatal-kill'

function clearWatchdog(session: Session): void {
  if (session.watchdogTimer !== null) {
    clearTimeout(session.watchdogTimer)
    session.watchdogTimer = null
  }
  session.watchdogKillStage = 'none'
}

/** Arm (or re-arm) the watchdog for the session's current non-terminal state. */
function armWatchdog(session: Session): void {
  if (session.watchdogTimer !== null) clearTimeout(session.watchdogTimer)
  const t = watchdogTimings()
  let delay: number
  if (session.terminalState === 'starting') delay = t.startingBoundMs
  else if (session.terminalState === 'running') delay = t.runningStallMs
  else {
    session.watchdogTimer = null
    return
  }
  session.watchdogTimer = setTimeout(() => fireWatchdog(session), delay)
  session.watchdogTimer.unref?.()
}

/**
 * Arm a short kill-grace tick after a SIGTERM (used by the fatal-error path)
 * so the next fire escalates to SIGKILL regardless of the session's state.
 */
function armWatchdogForKill(session: Session): void {
  if (session.watchdogTimer !== null) clearTimeout(session.watchdogTimer)
  session.watchdogKillStage = 'sigterm'
  session.watchdogTimer = setTimeout(() => fireWatchdog(session), watchdogTimings().killGraceMs)
  session.watchdogTimer.unref?.()
}

function recordWatchdogFire(
  session: Session,
  vector: WatchdogVector,
  outcome: 'no-child' | 'missed-exit' | 'alive',
  killStage: Session['watchdogKillStage']
): void {
  try {
    recordDiagnosticEvent({
      level: 'warn',
      source: 'main',
      event: 'chat.watchdog_fired',
      taskId: session.taskId,
      sessionId: `${session.taskId}:${session.tabId}`,
      message: `${vector} → ${outcome}`,
      payload: {
        vector,
        outcome,
        killStage,
        terminalState: session.terminalState,
        tabId: session.tabId,
        mode: session.mode
      }
    })
  } catch (err) {
    console.error('[chat-transport] watchdog: recordDiagnosticEvent threw:', err)
  }
}

function fireWatchdog(session: Session): void {
  session.watchdogTimer = null
  // Already terminal / replaced — nothing to do.
  if (
    session.ended ||
    session.terminalState === 'dead' ||
    sessions.get(session.tabId) !== session
  ) {
    clearWatchdog(session)
    return
  }
  // When not mid-kill, only `starting`/`running` are watched. A session resting
  // in `idle`/`error` is correct. Mid-kill (`watchdogKillStage !== 'none'`, set
  // by the fatal-error path) proceeds regardless of state.
  if (
    session.watchdogKillStage === 'none' &&
    session.terminalState !== 'starting' &&
    session.terminalState !== 'running'
  ) {
    clearWatchdog(session)
    return
  }
  const timings = watchdogTimings()
  // `running` sliding-window recheck: a progress event may have landed after
  // the timer was set — re-arm for the remainder instead of false-killing.
  if (session.terminalState === 'running' && session.watchdogKillStage === 'none') {
    const sinceProgress = Date.now() - session.watchdogLastProgress
    if (sinceProgress < timings.runningStallMs) {
      session.watchdogTimer = setTimeout(
        () => fireWatchdog(session),
        timings.runningStallMs - sinceProgress
      )
      session.watchdogTimer.unref?.()
      return
    }
  }
  const vector: WatchdogVector =
    session.terminalState === 'starting'
      ? 'stuck-starting'
      : session.terminalState === 'running'
        ? 'running-stall'
        : 'fatal-kill'
  const child = session.child
  if (!child) {
    recordWatchdogFire(session, vector, 'no-child', session.watchdogKillStage)
    transitionState(session, 'dead')
    clearWatchdog(session)
    return
  }
  const pid = child.pid
  const alive = typeof pid === 'number' ? deps.isProcessAlive(pid) : false
  if (!alive) {
    // Subprocess is dead but its `exit` event never arrived (missed-exit race)
    // — reap it through the canonical exit handler, no teardown duplication.
    recordWatchdogFire(session, vector, 'missed-exit', session.watchdogKillStage)
    clearWatchdog(session)
    try {
      child.emit('exit', null, 'SIGKILL')
    } catch (err) {
      console.error('[chat-transport] watchdog: synthesized exit threw:', err)
    }
    return
  }
  // Alive past the bound — escalate one kill rung, then re-arm to verify.
  recordWatchdogFire(session, vector, 'alive', session.watchdogKillStage)
  try {
    if (session.watchdogKillStage === 'none') {
      child.kill('SIGTERM')
      session.watchdogKillStage = 'sigterm'
    } else if (session.watchdogKillStage === 'sigterm') {
      child.kill('SIGKILL')
      session.watchdogKillStage = 'sigkill'
    }
    // 'sigkill' already sent — keep re-probing; SIGKILL is uninterceptable so
    // the process dies within a window or two and the next fire reaps it.
  } catch (err) {
    console.error('[chat-transport] watchdog: kill threw:', err)
  }
  session.watchdogTimer = setTimeout(() => fireWatchdog(session), timings.killGraceMs)
  session.watchdogTimer.unref?.()
}

function transitionState(session: Session, next: ChatTerminalState): void {
  if (session.terminalState === next) return
  // Leaving a watched state for a resting/terminal one — disarm.
  if (next === 'idle' || next === 'error' || next === 'dead') {
    clearWatchdog(session)
  }
  const old = session.terminalState
  session.terminalState = next
  const stateSessionId = `${session.taskId}:${session.tabId}`
  deps.broadcastStateChange(stateSessionId, next, old)
  deps.onStateChange?.(stateSessionId, next, old)
  // Edge-trigger: any time we land in `idle` (post-result, post-spawn, etc.)
  // give the queue drainer a chance to push the next user-message. Scheduled
  // via setImmediate so the drain's sendUserMessage path doesn't re-enter
  // handleEvent inside the current event tick.
  if (next === 'idle' && queueDrainer) {
    const tabId = session.tabId
    const drain = queueDrainer
    setImmediate(() => drain(tabId))
  }
}

let queueDrainer: ((tabId: string) => void) | null = null

/**
 * Wire a drain callback the transport invokes whenever a session transitions
 * into `idle`. The callback is responsible for popping the head of the
 * persisted chat queue (if any) and calling `sendUserMessage` to dispatch it.
 * Called from chat-queue-handlers at registration time. Single global slot —
 * registering twice replaces.
 */
export function registerChatQueueDrainer(fn: (tabId: string) => void): void {
  queueDrainer = fn
}

/**
 * Read the current terminal state for a tab. Used by the queue drainer to
 * gate "should I pop?" — sendUserMessage during a running turn would
 * interleave with the in-flight assistant response on the subprocess's stdin.
 */
export function getSessionTerminalState(tabId: string): ChatTerminalState | null {
  const s = sessions.get(tabId)
  return s ? s.terminalState : null
}

/**
 * True if the CLI is parked on a user-blocking permission_request (e.g.
 * AskUserQuestion). Drainer must NOT pop queued user_messages in this state —
 * sending them as user_message blocks would interleave with the pending
 * tool_result the SDK still expects.
 */
export function isSessionAwaitingUserInput(tabId: string): boolean {
  const s = sessions.get(tabId)
  return s ? s.awaitingUserInput : false
}

function commitEvent(session: Session, event: AgentEvent): void {
  const seq = appendToBuffer(session, event)
  deps.broadcastEvent(session.tabId, event, seq)

  // Feed chat activity into the shared terminal-state channel so tab indicators,
  // kanban cards, and task automations react to chat sessions the same way as PTY.
  // Semantics:
  //   running — mid-turn (processing user msg or tool call)
  //   idle    — turn finished, waiting on user
  //   error   — result came back with isError
  //   dead    — process exited
  if (event.kind === 'permission-request') {
    // Turn parks on user input (AskUserQuestion etc.) — flip to idle so tab
    // indicators, kanban cards, and automations see the same "waiting on user"
    // state PTY adapters signal via completion stamp / approval modal.
    // Auto-denied prompts (ExitPlanMode) are intercepted upstream and never
    // reach commit. `awaitingUserInput` gates the queue drainer so a queued
    // user-message doesn't interleave with the SDK's pending tool_result.
    session.awaitingUserInput = true
    transitionState(session, 'idle')
  } else {
    // Clear the gate only on events that prove the SDK consumed the
    // control_response and resumed forward progress. stderr / rate-limit /
    // control-response / unknown can fire mid-park and must NOT release the
    // gate, or a `chat:queue:push` would race the SDK's pending tool_result.
    if (
      event.kind === 'assistant-text' ||
      event.kind === 'assistant-thinking' ||
      event.kind === 'tool-call' ||
      event.kind === 'tool-result' ||
      event.kind === 'turn-init' ||
      event.kind === 'user-message' ||
      event.kind === 'result' ||
      event.kind === 'interrupted' ||
      event.kind === 'process-exit'
    ) {
      session.awaitingUserInput = false
    }
    // `turn-init` is session metadata (id/model/cwd/tools), NOT a turn-open
    // signal. Claude's SDK emits it mid-first-turn so it *looks* turn-aligned,
    // but Codex's driver emits a synthetic one at handshake — before any turn.
    // Treating it as turn-open left Codex sessions stuck `running` post-spawn/
    // -resume. A real turn always opens with the transport-synthesized
    // `user-message` (every dispatch path routes through `sendUserMessage`);
    // `tool-call` stays as a mid-turn safety net.
    if (event.kind === 'user-message' || event.kind === 'tool-call') {
      transitionState(session, 'running')
    } else if (event.kind === 'result') {
      transitionState(session, event.isError ? 'error' : 'idle')
    } else if (event.kind === 'process-exit') {
      transitionState(session, 'dead')
    }
  }

  // Liveness watchdog: while `running`, (re)arm on the turn-opening events and
  // on every forward-progress event. The reset makes the stall bound a sliding
  // window so a long healthy turn is never false-killed; a turn that goes
  // fully silent past the bound is force-killed.
  if (session.terminalState === 'running') {
    const opensTurn = event.kind === 'user-message' || event.kind === 'tool-call'
    if (opensTurn || isProgressEventKind(event.kind)) {
      session.watchdogLastProgress = Date.now()
      armWatchdog(session)
    }
  }

  // Mark session as healthy once we see any real content.
  if (
    event.kind === 'assistant-text' ||
    event.kind === 'tool-call' ||
    (event.kind === 'result' && !event.isError)
  ) {
    session.sawHealthyTurn = true
  }

  // Surface discovered session id for persistence (resume-on-reopen).
  const extracted = session.driver?.extractSessionId(event) ?? null
  if (extracted && session.onPersistSessionId) {
    session.onPersistSessionId(extracted)
  }
}

function handleEvent(session: Session, event: AgentEvent): void {
  // Fatal driver-start failure (handshake could not complete). Unlike a resume
  // failure — recoverable, respawns fresh — an `initialize` / `thread/start`
  // failure has nowhere to go. Surface the error, then kill the subprocess so
  // the existing exit path drives the session to its terminal `dead` state
  // (Retry overlay). Without this the session lingers half-alive and silently
  // queues any further input. Handled before the resume-tentative window so a
  // fatal failure is never staged away as reconnect noise.
  if (
    event.kind === 'error' &&
    typeof event.detail === 'object' &&
    event.detail !== null &&
    (event.detail as { fatal?: unknown }).fatal === true
  ) {
    commitEvent(session, event)
    if (!session.ended && session.child) {
      try {
        session.child.kill('SIGTERM')
      } catch {
        /* already gone — the watchdog + exit handler still drive `dead` */
      }
      // Backstop: if SIGTERM is ignored, the watchdog escalates to SIGKILL
      // and guarantees the session reaches `dead`.
      armWatchdogForKill(session)
    } else if (!session.ended) {
      transitionState(session, 'dead')
    }
    return
  }

  // Tentative-resume window: spawn was started with --resume <id> but we
  // haven't yet seen any signal the conversation actually loaded. Stage
  // events instead of persisting/broadcasting them. On the first healthy
  // event we flush staged in order; on a detected resume-failure we drop
  // them entirely and trigger a fresh respawn. This keeps the failed
  // spawn's stderr ("No conversation found with session ID: …"),
  // process-exit, and error-result events out of `chat_events` and away
  // from the renderer — the user sees a brief reconnect, not a red error.
  if (session.usedResume && !session.sawHealthyTurn && !session.flushingStaged) {
    if (detectResumeFailure(event)) {
      session.staged = []
      if (session.onInvalidResume) {
        session.onInvalidResume()
        session.onInvalidResume = undefined
      }
      const autoRetry = session.respawnOpts.autoRetryOnInvalidResume !== false
      if (autoRetry && !session.retryScheduled) {
        session.retryScheduled = true
        setImmediate(() => {
          void respawnFresh(session)
        })
      }
      return
    }
    const isHealthy =
      event.kind === 'assistant-text' ||
      event.kind === 'tool-call' ||
      (event.kind === 'result' && !event.isError)
    if (!isHealthy) {
      session.staged.push(event)
      return
    }
    // Healthy event proves the resume worked. Flush staged through the normal
    // commit path, then commit this event. `flushingStaged` blocks re-entry
    // so commitEvent setting `sawHealthyTurn` mid-flush doesn't recurse.
    session.flushingStaged = true
    try {
      for (const staged of session.staged) commitEvent(session, staged)
      session.staged = []
    } finally {
      session.flushingStaged = false
    }
    commitEvent(session, event)
    return
  }

  commitEvent(session, event)
}

async function respawnFresh(session: Session): Promise<void> {
  // Kill current (if not already gone) and wait for exit, then spawn fresh.
  try {
    if (!session.ended && session.child) {
      const child = session.child
      child.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 2000)
        child.once('exit', () => {
          clearTimeout(t)
          resolve()
        })
      })
    }
  } catch {
    /* ignore */
  }
  // Snapshot before delete: respawn carries forward in-memory buffer + seq so
  // restored history (and the user's last message that triggered the failed
  // resume) survives the fresh spawn. nextSeq stays monotonic so newly-emitted
  // events keep collision-free PRIMARY KEY (tab_id, seq) in chat_events.
  const carriedBuffer = [...session.buffer]
  const carriedNextSeq = session.nextSeq
  // Remove before re-hydrate so hydrateSession treats tabId as fresh.
  clearWatchdog(session)
  sessions.delete(session.tabId)
  const nextOpts: CreateChatOpts = {
    ...session.respawnOpts,
    conversationId: null,
    // Don't loop: disable retry on the second attempt.
    autoRetryOnInvalidResume: false,
    initialBuffer: carriedBuffer,
    initialNextSeq: carriedNextSeq
  }
  try {
    hydrateSession(nextOpts)
    await ensureSpawned(nextOpts.tabId)
  } catch (e) {
    console.error('[chat-transport] auto-retry after invalid resume failed:', e)
  }
}

function detectResumeFailure(event: AgentEvent): string | null {
  if (event.kind === 'stderr' && /no conversation found/i.test(event.text)) {
    return event.text
  }
  if (event.kind === 'result' && event.isError) {
    const txt = event.text ?? ''
    if (/no conversation found/i.test(txt)) return txt
    if (event.subtype === 'error_during_execution' && event.numTurns === 0) return 'resume failed'
  }
  return null
}

export interface CreateChatOpts {
  tabId: string
  /** Task id — required so `pty:state-change` broadcasts use `${taskId}:${tabId}` keys. */
  taskId: string
  mode: string
  cwd: string
  /** If set, --resume <id>; otherwise fresh --session-id <newUuid>. */
  conversationId: string | null
  /** Shell-parsed flags (e.g. ['--allow-dangerously-skip-permissions']). */
  providerFlags: string[]
  /** Extra env overrides (PATH enrichment already applied by caller or inherited). */
  env?: NodeJS.ProcessEnv
  /** Callback when adapter discovers a session_id in the stream. Persist via setProviderConversationId. */
  onPersistSessionId?: (id: string) => void
  /** Called when --resume was attempted but the stored session id is invalid. Clear it. */
  onInvalidResume?: () => void
  /**
   * If true, transport auto-retries a single fresh spawn when --resume is rejected.
   * Default true. Renderer sees one brief exit, then a fresh turn-init for the same tab.
   */
  autoRetryOnInvalidResume?: boolean
  /**
   * Persisted history for this tab (loaded from chat_events SQLite table by chat-handlers).
   * When supplied, the new in-memory session.buffer is seeded with these events so
   * `getEventBufferSince(tabId, -1)` replays the full restored history immediately —
   * no waiting for the agent process to re-emit anything.
   */
  initialBuffer?: BufferedEvent[]
  /**
   * Starting seq for the new in-memory session. Should be MAX(seq)+1 over persisted
   * rows for this tab so newly-appended events don't collide with restored ones.
   */
  initialNextSeq?: number
  /**
   * Resolved chat permission/runtime mode this spawn corresponds to. Stored
   * on the Session and surfaced via ChatSessionInfo. When null, the provider
   * doesn't use a mode concept.
   */
  chatMode?: string | null
  /** Resolved chat model id for the spawn (provider-specific). */
  chatModel?: string | null
  /** Resolved reasoning effort for the spawn (claude --effort). */
  chatEffort?: ChatEffort | null
  /** Resolved collaboration mode for the spawn (Codex `turn/start.collaborationMode`). */
  chatCollaboration?: ChatCollaborationMode | null
  /** Whether Codex Fast Mode (`serviceTier: 'fast'`) is enabled for the spawn. */
  chatFastMode?: boolean
}

/**
 * Hydrate a chat session WITHOUT spawning a subprocess. Loads persisted buffer
 * into memory, populates resolved chatMode/Model/Effort, and inserts a
 * `not-spawned` skeleton into the sessions map. The actual OS subprocess is
 * started lazily by `ensureSpawned` on the first `chat:send` (or queue drain).
 *
 * Idempotent: if a live session (or any prior skeleton) already exists for the
 * tab, returns its info. Zombie sessions (identity mismatch on tabId) are torn
 * down and replaced.
 */
export function hydrateSession(opts: CreateChatOpts): ChatSessionInfo {
  if (isShuttingDown) {
    throw new ChatTransportError('Cannot hydrate chat session while app is shutting down.')
  }
  // Refuse duplicate sessions for one tab.
  const existing = sessions.get(opts.tabId)
  if (existing) {
    // Invariant: a tabId must only ever back ONE (taskId, cwd, mode) tuple. If the
    // caller asks to hydrate the same tabId but a different identity, the prior
    // session is a zombie (e.g. tab was closed without chat:remove). Returning
    // it would stream another task's events into the new panel — exactly the symptom
    // of the cross-task chat leak. Tear it down and re-hydrate.
    if (
      existing.taskId !== opts.taskId ||
      existing.cwd !== opts.cwd ||
      existing.mode !== opts.mode
    ) {
      console.warn(
        `[chat-transport] zombie session for tabId=${opts.tabId} ` +
          `had (taskId=${existing.taskId}, cwd=${existing.cwd}, mode=${existing.mode}); ` +
          `replacing with (taskId=${opts.taskId}, cwd=${opts.cwd}, mode=${opts.mode})`
      )
      try {
        existing.child?.kill('SIGTERM')
      } catch {
        /* already dead or never spawned */
      }
      sessions.delete(opts.tabId)
      // Fall through to fresh hydrate below.
    } else {
      // Reattach: live session or pre-spawn skeleton — both already carry
      // buffer + resolved chat state, just return current info.
      return toInfo(existing)
    }
  }

  const backend = getBackend(opts.mode)
  if (!backend) {
    throw new ChatTransportError(`No agent backend registered for mode "${opts.mode}"`)
  }

  // Seed buffer/seq from persisted history when chat-handlers passed it in.
  // Cap seeded buffer at MAX_BUFFER_EVENTS to mirror the in-memory invariant.
  const seededBuffer: BufferedEvent[] = opts.initialBuffer
    ? opts.initialBuffer.slice(-MAX_BUFFER_EVENTS)
    : []
  const seededNextSeq =
    opts.initialNextSeq ??
    (seededBuffer.length > 0 ? seededBuffer[seededBuffer.length - 1].seq + 1 : 0)

  // Skeleton sessionId placeholder. When the resume id is set in providerCfg we
  // honor it (so `--resume <id>` fires on first spawn); otherwise leave as-is —
  // ensureSpawned generates a fresh UUID at spawn time. Storing it now would
  // burn a Claude SDK conversation id even if the user never sends.
  const sessionId = opts.conversationId || randomUUID()

  const session: Session = {
    sessionId,
    spawnId: randomUUID(),
    tabId: opts.tabId,
    taskId: opts.taskId,
    mode: opts.mode,
    cwd: opts.cwd,
    backend,
    driver: null,
    child: null,
    buffer: seededBuffer,
    nextSeq: seededNextSeq,
    ended: false,
    startedAt: new Date().toISOString(),
    lastOutputTime: Date.now(),
    terminalState: 'not-spawned',
    usedResume: Boolean(opts.conversationId),
    sawHealthyTurn: false,
    retryScheduled: false,
    respawnOpts: opts,
    chatMode: opts.chatMode ?? null,
    chatModel: opts.chatModel ?? null,
    chatEffort: opts.chatEffort ?? null,
    chatCollaboration: opts.chatCollaboration ?? null,
    chatFastMode: opts.chatFastMode ?? false,
    onPersistSessionId: opts.onPersistSessionId,
    onInvalidResume: opts.onInvalidResume,
    staged: [],
    flushingStaged: false,
    awaitingUserInput: false,
    watchdogTimer: null,
    watchdogKillStage: 'none',
    watchdogLastProgress: Date.now()
  }
  sessions.set(opts.tabId, session)

  // Restored history with an unfinished turn → emit synthetic `interrupted` so
  // the renderer reducer rebalances userMessagesSent/resultCount. Otherwise the
  // tab badge and the chat panel's inFlight (true, counting stale persisted
  // user-messages without matching results) drift apart. Emitted at HYDRATE
  // time (was: at spawn time) so the marker shows even before the user
  // triggers a spawn — critical for lazy mode where a buffer with an
  // unfinished turn may sit unspawned indefinitely.
  if (tailIsUnfinishedTurn(seededBuffer)) {
    // Synthetic restore-time signal — describes the SEEDED buffer, not the
    // current spawn. Commit directly so it's broadcast immediately. Renderer
    // reducer relies on this to balance counters.
    commitEvent(session, { kind: 'interrupted' })
  }

  return toInfo(session)
}

/**
 * Dedupe map for concurrent `ensureSpawned` callers (e.g. simultaneous
 * `chat:send` + queue drainer racing on the same tab). Keyed by tabId; the
 * stored promise resolves when the spawn finishes (or rejects on error). All
 * concurrent callers await the same promise, preventing double-spawn.
 */
const inFlightSpawns = new Map<string, Promise<ChatSessionInfo>>()

/**
 * Idempotent spawn primitive. If the session already has a live child, returns
 * its info unchanged. Otherwise starts the OS subprocess, wires stdio/exit
 * handlers, and transitions `not-spawned → starting → idle` on the kernel's
 * `'spawn'` event.
 *
 * Throws if the tab has no hydrated session (caller must hydrate first), or if
 * adapter / binary resolution fails.
 *
 * Concurrent calls for the same tab dedupe via `inFlightSpawns` — first call
 * does the work, others await its promise.
 */
export async function ensureSpawned(tabId: string): Promise<ChatSessionInfo> {
  if (isShuttingDown) {
    throw new ChatTransportError('Cannot spawn chat session while app is shutting down.')
  }
  const session = sessions.get(tabId)
  if (!session) {
    throw new ChatTransportError(
      `ensureSpawned: no hydrated session for tabId=${tabId} — call hydrateSession first`
    )
  }
  // Already live — fast path.
  if (session.child && !session.ended) return toInfo(session)
  // Concurrent caller still in flight — share its promise.
  const pending = inFlightSpawns.get(tabId)
  if (pending) return pending

  const promise = (async (): Promise<ChatSessionInfo> => {
    try {
      await spawnSubprocess(session)
      return toInfo(session)
    } finally {
      inFlightSpawns.delete(tabId)
    }
  })()
  inFlightSpawns.set(tabId, promise)
  return promise
}

/**
 * Internal: spawn the OS subprocess for an existing Session and wire up
 * stdout/stderr/exit/error handlers. Called by `ensureSpawned` on first
 * activation and by `respawnFresh` after the tentative-resume retry.
 *
 * Assumes the Session is already in the `sessions` map. Mutates `session.child`,
 * `session.sessionId` (when not using --resume), `session.spawnId`, and
 * transitions `terminalState`.
 */
async function spawnSubprocess(session: Session): Promise<void> {
  const opts = session.respawnOpts
  const backend = session.backend

  const binary = await deps.whichBinary(backend.binaryName)
  if (!binary) {
    throw new ChatTransportError(
      `Binary "${backend.binaryName}" not found on PATH. Install it or fix your shell's PATH.`
    )
  }

  // sessionId carried from hydrate (preserves resume id when set). Fresh
  // spawn-id per OS process so the renderer can scope bg shells to this run.
  const sessionId = session.sessionId
  session.spawnId = randomUUID()
  const { args } = backend.buildSpawnArgs({
    sessionId,
    resume: Boolean(opts.conversationId),
    cwd: opts.cwd,
    providerFlags: opts.providerFlags
  })

  const child = deps.spawn(binary, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false
  })

  session.child = child
  session.ended = false
  session.usedResume = Boolean(opts.conversationId)
  session.sawHealthyTurn = false
  // Mark this tab as warm so a crash / unclean quit can restore it on next
  // boot. Cleared in the exit handler below on natural/user exit (NOT on
  // app shutdown — that's the whole point).
  try {
    spawnedSetter?.(session.tabId, true)
  } catch (err) {
    console.error('[chat-transport] markTabSpawned(true) failed:', err)
  }
  // Move out of the lazy `not-spawned` state. `child.on('spawn')` below
  // promotes to `idle` once the kernel reports the pid.
  transitionState(session, 'starting')
  // Watchdog: if the `spawn` event never arrives, force the session to `dead`.
  armWatchdog(session)

  // Mint a fresh per-spawn protocol driver and build its IO context. The
  // driver owns ALL provider-protocol logic (handshake, line parsing,
  // request correlation); the transport only moves bytes in and AgentEvents
  // out. `driver.start(ctx)` runs once on the `'spawn'` event below.
  const driver = backend.createDriver()
  session.driver = driver
  const driverCtx: ChatDriverContext = {
    write: (line) => {
      try {
        session.child?.stdin?.write(line + '\n')
      } catch {
        /* best-effort; a dead pipe surfaces via process exit */
      }
    },
    emit: (event) => handleEvent(session, event),
    cwd: opts.cwd,
    sessionId,
    resume: Boolean(opts.conversationId),
    providerFlags: opts.providerFlags,
    chatModel: session.chatModel,
    chatEffort: session.chatEffort,
    chatMode: session.chatMode,
    chatCollaboration: session.chatCollaboration,
    chatFastMode: session.chatFastMode
  }

  // --- spawn: subprocess confirmed alive ---
  // Tie state machine to actual OS process lifecycle. `'spawn'` fires after the
  // kernel has the pid; before any agent event arrives. Without this, sessions
  // that haven't received a user message stay stuck at `'starting'` forever
  // because handleEvent only transitions on user-message/turn-init/tool-call/
  // result/process-exit. The subprocess being alive is the canonical "ready"
  // signal — independent of what events the agent chooses to emit.
  //
  // Also emits a synthetic `session-spawn` event as the FIRST event of this
  // subprocess's contribution so the renderer reducer can invalidate stale
  // process-children resources (bg shells) from any prior subprocess on the
  // same tab. Persisted alongside other events so replay rebuilds the same
  // scoping deterministically.
  child.on('spawn', () => {
    handleEvent(session, { kind: 'session-spawn', spawnId: session.spawnId })
    if (session.terminalState === 'starting') {
      transitionState(session, 'idle')
    }
    // Hand the driver its IO context. For a stream provider this just stores
    // `ctx`; for a JSON-RPC provider it kicks off the `initialize` handshake.
    // `'spawn'` always precedes the first stdout `'line'`, so `handleLine`
    // never runs before `start`.
    void Promise.resolve(driver.start(driverCtx)).catch((err) => {
      handleEvent(session, {
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
        detail: { phase: 'driver-start' }
      })
    })
  })

  // --- stdout: readline buffers partial lines; driver owns parsing ---
  const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity })
  rl.on('line', (line) => {
    try {
      driver.handleLine(line)
    } catch (err) {
      console.error('[chat-transport] driver.handleLine threw:', err)
    }
  })

  // --- stderr: debounced buffer, emit as kind:'stderr' ---
  let stderrBuf = ''
  let stderrTimer: NodeJS.Timeout | null = null
  const flushStderr = (): void => {
    stderrTimer = null
    if (!stderrBuf) return
    const text = stderrBuf
    stderrBuf = ''
    handleEvent(session, { kind: 'stderr', text })
  }
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString()
    if (!stderrTimer) stderrTimer = setTimeout(flushStderr, STDERR_FLUSH_INTERVAL_MS)
  })

  // --- exit ---
  child.on('exit', (code, signal) => {
    // Idempotent: the watchdog can synthesize an `exit` to reap a missed-exit
    // race, and a late real `exit` may follow — process the teardown once.
    if (session.ended) return
    clearWatchdog(session)
    if (stderrTimer) {
      clearTimeout(stderrTimer)
      flushStderr()
    }
    session.ended = true
    // Clear the warm flag UNLESS we're in app shutdown — in which case
    // preserve so next boot restores. Subprocess crashes / claude-side
    // exits drop the flag because there's nothing to "restore" anymore.
    if (!isShuttingDown) {
      try {
        spawnedSetter?.(session.tabId, false)
      } catch (err) {
        console.error('[chat-transport] markTabSpawned(false) failed:', err)
      }
    }
    // Tear down the driver — rejects its in-flight control/request promises
    // so callers don't hang.
    try {
      session.driver?.dispose()
    } catch (err) {
      console.error('[chat-transport] driver.dispose threw:', err)
    }
    // If this session was already replaced in the tab (e.g. reset: kill+create raced and the
    // new session is already live), swallow the exit so the UI doesn't revert to "Session ended".
    if (sessions.get(opts.tabId) !== session) {
      return
    }
    handleEvent(session, { kind: 'process-exit', code, signal })
    deps.broadcastExit(opts.tabId, session.sessionId, code, signal)
    clearSessionUserInputMark(`${session.taskId}:${session.tabId}`)
    // Leave session in map so reattach can read buffer; consumer deletes on tab close.
  })

  child.on('error', (err) => {
    transitionState(session, 'error')
    handleEvent(session, {
      kind: 'error',
      message: err.message,
      detail: { name: err.name }
    })
  })
}

export function sendUserMessage(tabId: string, text: string): boolean {
  const session = sessions.get(tabId)
  if (!session || session.ended || !session.child || !session.driver) return false
  session.driver.sendUserMessage(text)
  // Record into the session buffer so tab reloads / replay reconstruct user messages.
  handleEvent(session, { kind: 'user-message', text })
  markSessionUserInput(`${session.taskId}:${session.tabId}`)
  return true
}

/**
 * Resolve a pending `tool_use_id` by writing a `tool_result` content block on
 * stdin. Used by inline-answer flows like AskUserQuestion so the SDK's turn
 * machinery sees a normal completion instead of an orphaned tool_use that
 * skews stop_reason / usage accounting. Returns false when the session is
 * gone or the driver lacks a structured-input channel — caller falls back
 * to `sendUserMessage`.
 */
export function sendToolResult(
  tabId: string,
  args: { toolUseId: string; content: string; isError?: boolean }
): boolean {
  const session = sessions.get(tabId)
  if (!session || session.ended || !session.child || !session.driver) return false
  if (!session.driver.sendToolResult) return false
  return session.driver.sendToolResult(args)
}

/**
 * Send a control request to the driver and resolve when the provider
 * acknowledges. Rejects on driver lacking a control channel, on timeout, on
 * provider error, or on session exit before a response arrives. Used to flip
 * permission mode / model / interrupt without restarting the subprocess.
 */
export function sendControlRequest(
  tabId: string,
  request: Record<string, unknown>,
  timeoutMs = 30_000
): Promise<unknown> {
  const session = sessions.get(tabId)
  if (!session || session.ended || !session.child || !session.driver) {
    return Promise.reject(new Error('no live session'))
  }
  if (!session.driver.applyControl) {
    return Promise.reject(new Error('driver has no control channel'))
  }
  return session.driver.applyControl(request, timeoutMs)
}

/**
 * Mutate the in-memory `Session.chatMode`. Called after a successful
 * `set_permission_mode` control_request so `getSessionInfo` reflects the new
 * mode without waiting for a turn-init drift sync.
 */
export function updateSessionChatMode(tabId: string, mode: string | null): void {
  const session = sessions.get(tabId)
  if (!session) return
  session.chatMode = mode
}

/**
 * Mutate the in-memory `Session.chatModel`. Called after a successful
 * `set_model` control_request so `getSessionInfo` reflects the new model
 * without waiting for a turn-init drift sync.
 */
export function updateSessionChatModel(tabId: string, model: string | null): void {
  const session = sessions.get(tabId)
  if (!session) return
  session.chatModel = model
}

/**
 * Mutate the in-memory `Session.chatEffort`. Used by the pre-spawn fast path of
 * `chat:setEffort` so a skeleton session reflects the new value before the
 * next spawn picks it up via buildSpawnArgs.
 */
export function updateSessionChatEffort(tabId: string, effort: ChatEffort | null): void {
  const session = sessions.get(tabId)
  if (!session) return
  session.chatEffort = effort
}

/**
 * Mutate the in-memory `Session.chatCollaboration`. Used by the pre-spawn fast
 * path of `chat:setCollaboration` so a skeleton session reflects the new value
 * before the next spawn picks it up.
 */
export function updateSessionChatCollaboration(
  tabId: string,
  collaboration: ChatCollaborationMode | null
): void {
  const session = sessions.get(tabId)
  if (!session) return
  session.chatCollaboration = collaboration
}

/**
 * Mutate the in-memory `Session.chatFastMode`. Used by the pre-spawn fast path
 * of `chat:setFastMode` so a skeleton session reflects the new value before
 * the next spawn picks it up.
 */
export function updateSessionChatFastMode(tabId: string, fastMode: boolean): void {
  const session = sessions.get(tabId)
  if (!session) return
  session.chatFastMode = fastMode
}

/**
 * Reply to an inbound `control_request` (e.g. `subtype:'can_use_tool'` from
 * `--permission-prompt-tool stdio`). The renderer has surfaced the prompt
 * to the user and gathered their decision; the driver translates it to the
 * provider's approval reply. Returns false when session/driver can't carry
 * the reply — caller handles fallback.
 */
export function respondToPermissionRequest(
  tabId: string,
  args: { requestId: string; decision: PermissionDecision }
): boolean {
  const session = sessions.get(tabId)
  if (!session || session.ended || !session.child || !session.driver) return false
  if (!session.driver.respondPermission) return false
  return session.driver.respondPermission(args)
}

/**
 * Persist an `interrupted` marker into the session's event log. Called by
 * `chat:interrupt` before kill+respawn so timeline replay sees a turn boundary
 * even though the original turn never produced a `result`. No-op if the
 * session is gone or already ended.
 */
export function recordInterrupted(tabId: string): void {
  const session = sessions.get(tabId)
  if (!session || session.ended) return
  // Pre-spawn skeletons (terminalState='not-spawned') have no live turn to
  // interrupt — skip emission. The hydrate path already emits its own
  // synthetic `interrupted` for unfinished tails.
  if (!session.child) return
  handleEvent(session, { kind: 'interrupted' })
}

/**
 * Cancel the trailing `user-message` if no assistant progress arrived since.
 * Emits a synthetic `user-message-popped` event into the buffer so the renderer
 * (and any future replay) removes the user-text item from the timeline. Returns
 * the popped text so the caller can restore it to the chat input field —
 * Claude CLI parity for "pressing Esc on a turn that produced nothing".
 *
 * Authoritative: caller relies on this verdict over the renderer's local view
 * to handle late-arriving events between renderer's check and this call.
 */
export function popLastUserMessage(tabId: string): { popped: boolean; text: string | null } {
  const session = sessions.get(tabId)
  if (!session || session.ended) return { popped: false, text: null }

  let userText: string | null = null
  for (let i = session.buffer.length - 1; i >= 0; i--) {
    const e = session.buffer[i].event
    if (e.kind === 'user-message') {
      userText = e.text
      break
    }
    if (e.kind === 'user-message-popped') return { popped: false, text: null }
    if (isProgressEventKind(e.kind)) return { popped: false, text: null }
    // Skip non-progress, non-user events (turn-init, error, unknown, compact-boundary).
  }
  if (userText === null) return { popped: false, text: null }
  handleEvent(session, { kind: 'user-message-popped', text: userText })
  return { popped: true, text: userText }
}

/**
 * Scan a seeded buffer's tail to detect an unfinished turn — the last
 * stateful event is a turn-starter (user-message/tool-call) with
 * no subsequent terminal marker (result/process-exit/interrupted/
 * user-message-popped). Used by hydrateSession to keep the renderer's
 * userMessagesSent/resultCount balance honest after a restore: without a
 * synthetic interrupted, inFlight would stay true forever even though the
 * fresh subprocess (post --resume) sits idle waiting for input.
 *
 * `turn-init` is deliberately NOT a turn-starter here: Codex emits a synthetic
 * one at handshake, so a buffer whose tail is `turn-init` (session spawned,
 * no message ever sent) is idle, not mid-turn. A real unfinished turn still
 * tails with `user-message`/`tool-call`, which always precede `turn-init`.
 */
function tailIsUnfinishedTurn(buffer: BufferedEvent[]): boolean {
  for (let i = buffer.length - 1; i >= 0; i--) {
    const k = buffer[i].event.kind
    if (
      k === 'result' ||
      k === 'process-exit' ||
      k === 'interrupted' ||
      k === 'user-message-popped'
    ) {
      return false
    }
    if (k === 'user-message' || k === 'tool-call') {
      return true
    }
  }
  return false
}

function isProgressEventKind(kind: AgentEvent['kind']): boolean {
  switch (kind) {
    case 'assistant-text':
    case 'assistant-thinking':
    case 'tool-call':
    case 'tool-result':
    case 'result':
    case 'sub-agent':
    case 'interrupted':
    case 'stderr':
    case 'api-retry':
    case 'rate-limit':
    case 'stream-message-start':
    case 'stream-block-start':
    case 'stream-block-delta':
    case 'stream-block-stop':
    case 'stream-message-stop':
    case 'agent-plan':
      return true
    default:
      return false
  }
}

export function kill(tabId: string): void {
  const session = sessions.get(tabId)
  if (!session) return
  if (session.ended) return
  // Pre-spawn skeleton (child=null): mark ended so subsequent operations short-
  // circuit, but no process to signal.
  if (!session.child) {
    session.ended = true
    return
  }
  const child = session.child
  try {
    child.kill('SIGTERM')
  } catch {
    // process may already be gone
  }
  setTimeout(() => {
    if (!session.ended) {
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore
      }
    }
  }, 2000)
}

/**
 * Remove the session entirely (for tab close). Kills first if still live.
 */
export function removeSession(tabId: string): void {
  const session = sessions.get(tabId)
  if (!session) return
  clearWatchdog(session)
  if (!session.ended && session.child) kill(tabId)
  sessions.delete(tabId)
}

export function getEventBufferSince(tabId: string, afterSeq: number): BufferedEvent[] {
  const session = sessions.get(tabId)
  if (!session) return []
  return session.buffer.filter((b) => b.seq > afterSeq)
}

export function getSessionInfo(tabId: string): ChatSessionInfo | null {
  const session = sessions.get(tabId)
  return session ? toInfo(session) : null
}

function toInfo(session: Session): ChatSessionInfo {
  return {
    sessionId: session.sessionId,
    tabId: session.tabId,
    taskId: session.taskId,
    mode: session.mode,
    cwd: session.cwd,
    pid: session.child?.pid ?? null,
    startedAt: session.startedAt,
    ended: session.ended,
    chatMode: session.chatMode,
    chatModel: session.chatModel,
    chatEffort: session.chatEffort,
    chatCollaboration: session.chatCollaboration,
    chatFastMode: session.chatFastMode
  }
}

/** Kill all sessions (app shutdown). */
export function killAll(): void {
  for (const tabId of sessions.keys()) kill(tabId)
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function forceFinalizeForShutdown(session: Session): void {
  clearWatchdog(session)
  session.ended = true
  session.child = null
  try {
    session.driver?.dispose()
  } catch (err) {
    console.error('[chat-transport] shutdown driver.dispose threw:', err)
  }
  session.driver = null
  transitionState(session, 'dead')
  clearSessionUserInputMark(`${session.taskId}:${session.tabId}`)
}

function shutdownSession(
  session: Session,
  opts: Required<ShutdownOptions>
): Promise<{
  id: string
  exited: boolean
  killed: boolean
  timedOut: boolean
  errors: TransportShutdownResult['errors']
}> {
  return new Promise((resolve) => {
    const errors: TransportShutdownResult['errors'] = []
    const child = session.child
    const id = session.tabId
    if (session.ended || !child) {
      forceFinalizeForShutdown(session)
      resolve({ id, exited: true, killed: false, timedOut: false, errors })
      return
    }

    let settled = false
    let killed = false
    let termTimer: ReturnType<typeof setTimeout> | null = null
    let hardTimer: ReturnType<typeof setTimeout> | null = null

    const cleanup = (): void => {
      if (termTimer) clearTimeout(termTimer)
      if (hardTimer) clearTimeout(hardTimer)
      child.off('exit', onExit)
    }
    const settle = (timedOut: boolean): void => {
      if (settled) return
      settled = true
      cleanup()
      if (timedOut) forceFinalizeForShutdown(session)
      resolve({ id, exited: !timedOut, killed, timedOut, errors })
    }
    const recordError = (phase: string, err: unknown): void => {
      errors.push({ id, phase, message: toErrorMessage(err) })
    }
    const onExit = (): void => settle(false)

    child.once('exit', onExit)
    clearWatchdog(session)
    try {
      child.kill('SIGTERM')
    } catch (err) {
      recordError('sigterm', err)
    }
    termTimer = setTimeout(() => {
      killed = true
      try {
        child.kill('SIGKILL')
      } catch (err) {
        recordError('sigkill', err)
      }
    }, opts.termGraceMs)
    termTimer.unref?.()
    hardTimer = setTimeout(() => settle(true), opts.hardTimeoutMs)
    hardTimer.unref?.()
  })
}

export async function shutdownAll(options: ShutdownOptions = {}): Promise<TransportShutdownResult> {
  setShuttingDown(true)
  const opts: Required<ShutdownOptions> = {
    termGraceMs: options.termGraceMs ?? DEFAULT_SHUTDOWN_TERM_GRACE_MS,
    hardTimeoutMs: options.hardTimeoutMs ?? DEFAULT_SHUTDOWN_HARD_TIMEOUT_MS
  }
  const targets = Array.from(sessions.values()).filter((session) => !session.ended)
  const results = await Promise.all(targets.map((session) => shutdownSession(session, opts)))
  return {
    total: results.length,
    exited: results.filter((r) => r.exited).length,
    killed: results.filter((r) => r.killed).length,
    timedOut: results.filter((r) => r.timedOut).length,
    errors: results.flatMap((r) => r.errors)
  }
}

/** Kill every live chat session bound to a given taskId. Mirrors
 *  `killPtysByTaskId` for chat transports — invoked when a task reaches a
 *  terminal status (e.g. `done`) so the agent panel can't keep showing it. */
export function killByTaskId(taskId: string): void {
  for (const [tabId, session] of sessions) {
    if (session.taskId === taskId && !session.ended) kill(tabId)
  }
}

// ChatSessionStateEntry is exported from `../shared/types` so renderer + api types can reference it.

/**
 * Snapshot of all live (non-ended) chat sessions, keyed by the broadcast-format
 * sessionId. Used by the session registry so renderer reload can rehydrate
 * chat-tab state — pty-manager's listPtys is blind to chat sessions.
 */
export function listChatSessions(): ChatSessionStateEntry[] {
  const result: ChatSessionStateEntry[] = []
  for (const session of sessions.values()) {
    if (session.ended) continue
    // Skip lazy hydrate-only skeletons — they advertise no live process.
    if (session.terminalState === 'not-spawned') continue
    result.push({
      sessionId: `${session.taskId}:${session.tabId}`,
      taskId: session.taskId,
      mode: session.mode,
      lastOutputTime: session.lastOutputTime,
      state: session.terminalState
    })
  }
  return result
}

/** Look up live state by broadcast-format sessionId (`${taskId}:${tabId}`). */
export function getChatSessionState(sessionId: string): ChatTerminalState | null {
  for (const session of sessions.values()) {
    if (session.ended) continue
    if (session.terminalState === 'not-spawned') continue
    if (`${session.taskId}:${session.tabId}` === sessionId) return session.terminalState
  }
  return null
}

export class ChatTransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChatTransportError'
  }
}

/** For tests: inspect + clear state. */
export function __resetForTests(): void {
  for (const session of sessions.values()) clearWatchdog(session)
  sessions.clear()
  inFlightSpawns.clear()
  isShuttingDown = false
}

/**
 * Test-only: the OS subprocess for a tab. A real `child_process` emits `spawn`
 * once the kernel reports the pid; tests drive a fake child and need this
 * handle to fire `spawn` themselves (which is what triggers `driver.start`).
 */
export function __getSessionChildForTests(tabId: string): ChildProcess | null {
  return sessions.get(tabId)?.child ?? null
}
