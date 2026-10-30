import { spawn as realSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type {
  AgentEvent,
  CommandTaskOutput,
  OutgoingUserMessage,
  ResultEvent
} from '@slayzone/terminal-contracts'
import { chatCapabilitiesForMode, userMessageText } from '@slayzone/terminal-contracts'
import {
  TIMELINE_PROJECTION_VERSION,
  TimelineProjection,
  type TimelineOpen,
  type TimelinePagesResult,
  type TimelineProjectionStore
} from './chat-timeline-projection'
import type {
  RewindFilesPreview,
  RewindResult,
  RewindScope,
  StopResult,
  UserContentBlock
} from '@slayzone/terminal-contracts'
import type { ChatSessionStateEntry } from '@slayzone/terminal-contracts'
import type { AgentBackend, ChatSessionDriver, PermissionDecision } from '../agents/types'
import { getBackend } from '../agents/registry'
import { getPtyHostBridge } from '../pty-host'
import { whichBinary as realWhichBinary } from '../shell-env'
import { recordDiagnosticEvent } from '@slayzone/diagnostics/server'
import { TypedEmitter } from '@slayzone/platform/events'
import { childProcessEnv, type EnvOverlay } from '@slayzone/platform'
import { assertHubProcessesEnabled } from '@slayzone/platform/hub-switch-refusal'
import type { ConversationOrigin } from '@slayzone/terminal-contracts'
import {
  conversationInUseMessage,
  isConversationLive,
  registerConversationHolder
} from './live-conversations'
import { ChatEventLog, type BufferedEvent } from '../chat-events-store'
// `chatMode` is an opaque, provider-specific runtime/permission mode id
// (Claude `ChatMode` for claude-chat, Codex runtime mode for codex-chat) —
// typed `string`. `shared/chat-mode-catalog.ts` owns the per-mode vocabulary.
// `chatModel` is an opaque, provider-specific model id (`claude --model`
// alias for claude-chat, Codex model id for codex-chat) — typed as `string`.
// The provider-aware catalog (`shared/chat-model-catalog.ts`) owns validity.
import type { ChatCollaborationMode } from '@slayzone/terminal-contracts'
import { markSessionUserInput, clearSessionUserInputMark } from '../user-input-tracker'
import type { AgentStateRecorder } from './pty-manager'
import { ptyEvents } from './pty-events'
import {
  chatSpawnError,
  childProcessToHandle,
  isChatSpawnError,
  type ChatBackend,
  type ChatProcHandle
} from './chat-proc-handle'
import { ChatProcess } from './chat-process'
import { ChatEventSplitter, isStreamFragment } from './chat-event-splitter'
import { ChatOutbox, type OutboxState } from './chat-outbox'
import { classifyResumeEvent } from './chat-resume-guard'
import { runningDeadline, toolBoundMs } from './chat-watchdog'
import { isCliVersionBelow } from './cli-version'

export { markSessionUserInput }
export type { BufferedEvent } from '../chat-events-store'

/**
 * `not-spawned` — session hydrated from persisted history but the OS subprocess
 * has not been spawned yet. Tab-open hydrates into this state; the first
 * `chat:send` (or queue drain) transitions through `starting → idle`. Skeleton
 * sessions in `not-spawned` are excluded from `listChatSessions` so the registry
 * never advertises them as live.
 */
export type ChatTerminalState = 'not-spawned' | 'starting' | 'running' | 'idle' | 'error' | 'dead'

/** Where a tab's saved events live. Default: nowhere (tests, standalone). */
export interface ChatEventStore {
  load(tabId: string): Promise<BufferedEvent[]>
  /** Insert-only: `'clash'` when a row already exists at that seq. `at`: when it was saved (ms). */
  insert(tabId: string, seq: number, event: AgentEvent, at: number): Promise<'inserted' | 'clash'>
  /** Saved events with `afterSeq < seq < beforeSeq` — history older than the log's cache. */
  readRange(tabId: string, afterSeq: number, beforeSeq: number): Promise<BufferedEvent[]>
}

/** Dependency-injection seam for tests AND for production wiring (event persistence). */
export interface TransportDeps {
  /**
   * LOCAL spawn primitive. Still `ChildProcess`-shaped: it is what the in-process
   * path uses and what ~30 transport tests inject a fake child through. Ignored
   * when `backend` is set (a routed spawn has no local ChildProcess).
   */
  spawn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess
  /**
   * Optional routed spawn seam. When set, ALL spawns go through it and it decides
   * per-spec whether the process runs on the hub or on a computer — the same shape
   * `PtyBackend` has for terminal mode. When unset (tests, and any composition
   * root that never wires it) the local `spawn` above is used directly, so
   * behavior is byte-identical to before this seam existed.
   */
  backend?: ChatBackend
  whichBinary: (name: string) => Promise<string | null>
  /**
   * `seq` is the event's own (saved events), or — for a LIVE event (`live` set:
   * a streaming fragment or a `sending` state, never saved) — the seq of the
   * newest saved event it follows; `live` is the tab's live counter. `at`: when
   * a saved event was saved (ms) — the time its rows show.
   */
  broadcastEvent: (
    tabId: string,
    event: AgentEvent,
    seq: number,
    live?: number,
    at?: number
  ) => void
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
  /**
   * Broadcast state transitions to clients: the default publishes them on the pty
   * event stream (`pty.onStateChange`, see `publishChatStateChange`), so every
   * client sees chat activity exactly as it sees a terminal agent's.
   */
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
   * Called for every SAVED event once it has its seq (side effects: interaction
   * time, CLI command snapshot, mode sync, prompt recorder). Default no-op.
   * Writing the row is `eventStore`'s job, not this hook's.
   */
  persistEvent: (tabId: string, seq: number, event: AgentEvent) => void
  /** The tabs' saved history. chat-handlers wires the SQLite store. */
  eventStore: ChatEventStore
  /**
   * Where a tab's timeline projection persists (paged history: what a client
   * opens from without replaying every event). Unset: no projection — clients
   * open from the full replay, as before.
   */
  timelineStore?: (tabId: string) => TimelineProjectionStore
  /**
   * Non-destructive process-liveness probe (`process.kill(pid, 0)`-style).
   * Injected so the watchdog tests can control the verdict deterministically.
   */
  isProcessAlive: (pid: number) => boolean
  /**
   * Optional watchdog timeout override — tests set tiny values to avoid real waits.
   * `spawnReplyBoundMs` (how long a start may wait for its process, admission
   * queue included) defaults to `startingBoundMs` in an override.
   */
  watchdogTimings?: {
    startingBoundMs: number
    runningStallMs: number
    killGraceMs: number
    spawnReplyBoundMs?: number
  }
  /** Test override: how a link-down message write is retried (default 30 s window, 1 s base). */
  outboxRetry?: { windowMs: number; baseMs: number }
}

/**
 * Default broadcast goes through the host bridge (Electron host: real
 * BrowserWindows; tests + standalone server: inert bridge → no-op).
 */
function electronBroadcast(
  channel: 'chat:event' | 'chat:exit' | 'pty:state-change'
): (...args: unknown[]) => void {
  return (...args: unknown[]) => {
    for (const w of getPtyHostBridge().getAllWindows()) {
      if (w.isDestroyed()) continue
      w.webContents.send(channel, ...args)
    }
  }
}

/**
 * Unified chat event emitter — the source for the tRPC `chat.onEvent` /
 * `chat.onExit` subscriptions. Dual-emitted alongside the legacy
 * `webContents.send('chat:event'|'chat:exit')` broadcasts below; the IPC path
 * stays until the renderer drops `window.api` (slice 5). `live` is set on
 * live-only events (see `TransportDeps.broadcastEvent`).
 */
export type ChatEventMap = {
  event: [tabId: string, agentEvent: AgentEvent, seq: number, live?: number, at?: number]
  exit: [tabId: string, sessionId: string, code: number | null, signal: string | null]
}
export const chatEvents = new TypedEmitter<ChatEventMap>()

/**
 * A chat agent's state change, onto the stream `pty.onStateChange` reads — the same
 * `{ sessionId, newState, oldState }` a terminal agent's carries, keyed
 * `${taskId}:${tabId}`, so every client follows chat agents live with the
 * subscription it already holds (and the owner gate filters them like any session).
 *
 * `not-spawned` is not a client state: a tab hydrated but never started has no
 * process, which in the shared vocabulary is `dead` (`isAliveTerminalState`), and
 * the session registry lists it as no session at all. A transition never LANDS in
 * `not-spawned` (only hydrate sets it); one that leaves it is reported from `dead`.
 */
function publishChatStateChange(
  sessionId: string,
  newState: ChatTerminalState,
  oldState: ChatTerminalState
): void {
  if (newState === 'not-spawned') return
  ptyEvents.emit(
    'state-change',
    sessionId,
    newState,
    oldState === 'not-spawned' ? 'dead' : oldState
  )
}

const noEventStore: ChatEventStore = {
  load: async () => [],
  insert: async () => 'inserted',
  readRange: async () => []
}

const defaultDeps: TransportDeps = {
  spawn: realSpawn,
  whichBinary: realWhichBinary,
  broadcastEvent: (tabId, event, seq, live, at) => {
    chatEvents.emit('event', tabId, event, seq, live, at)
    electronBroadcast('chat:event')(tabId, event, seq, live, at)
  },
  broadcastExit: (tabId, sessionId, code, signal) => {
    chatEvents.emit('exit', tabId, sessionId, code, signal)
    electronBroadcast('chat:exit')(tabId, sessionId, code, signal)
  },
  broadcastStateChange: (sessionId, newState, oldState) => {
    publishChatStateChange(sessionId, newState, oldState)
    electronBroadcast('pty:state-change')(sessionId, newState, oldState)
  },
  persistEvent: () => {
    // No-op default: side effects are wired in main via configureTransport().
  },
  eventStore: noEventStore,
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
 * Composition-root hook to persist how a chat tab's agent last ended
 * (`terminal_tabs.agent_state`). We can't import the task-terminals package from
 * inside the terminal package (would cycle), so the app wires this at boot. Called
 * `running` on successful spawn and `stopped` on natural / user-initiated exit,
 * unless the app is shutting down (see `setChatShuttingDown`). Same recorder type
 * as the pty manager's — one recorder serves both.
 */
let agentStateRecorder: AgentStateRecorder | null = null
export function setAgentStateTabRecorder(fn: AgentStateRecorder | null): void {
  agentStateRecorder = fn
}
/** See the pty-manager twin: readable so a test can assert the composition root
 *  actually installed a recorder in THIS process. */
export function getAgentStateTabRecorder(): AgentStateRecorder | null {
  return agentStateRecorder
}

/**
 * Shutdown gate. When true, the exit handler leaves `agent_state` at `running`
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
  /** Claude: a `ChatEffort`; Codex: any effort its model lists (`ultra`, …). */
  chatEffort?: string | null
  /** Resolved collaboration mode this session was spawned with. `null` = provider default. */
  chatCollaboration?: ChatCollaborationMode | null
  /** Whether Codex Fast Mode was enabled for this session's spawn. */
  chatFastMode?: boolean
}

/**
 * One chat tab. Outlives its agent processes: the saved history (`log`), the
 * outbox and the live state carry across every respawn, so a new process can
 * never re-use a seq or lose a message the old one had not confirmed.
 */
interface ChatTab {
  /** Claude conversation id (`--resume` preserves it across processes). */
  sessionId: string
  tabId: string
  /** Parent task id — used to key `pty:state-change` broadcasts matching the main terminal sessionId format `${taskId}:${tabId}`. */
  taskId: string
  mode: string
  cwd: string
  backend: AgentBackend
  /** Sole owner of this tab's seqs; written insert-only. */
  log: ChatEventLog
  /** Its timeline projection, fed every saved event (null: none, or it failed to open). */
  projection: Promise<TimelineProjection | null>
  splitter: ChatEventSplitter
  outbox: ChatOutbox
  /** The current agent process (generation), or null before the first spawn. */
  proc: ChatProcess | null
  /** Last generation number handed out. */
  gen: number
  /** RAW local child of the current process (tests + the watchdog's probe). */
  rawChild: ChildProcess | null
  /** No live process: never spawned is `false`, exited/killed is `true` (renderer "ended"). */
  ended: boolean
  startedAt: string
  /** Last event flow timestamp (ms). Drives idle-age threshold in agent-status panel. */
  lastOutputTime: number
  terminalState: ChatTerminalState
  /** The current process was spawned with --resume. */
  usedResume: boolean
  /** A fresh-start retry after a failed resume is already scheduled. */
  retryScheduled: boolean
  /** Opts needed to respawn. */
  respawnOpts: CreateChatOpts
  /** Resolved chat permission mode this session was spawned with. */
  chatMode: string | null
  /** Resolved chat model id this session was spawned with. */
  chatModel: string | null
  /** Resolved reasoning effort this session was spawned with. */
  chatEffort: string | null
  /** Resolved collaboration mode this session was spawned with. */
  chatCollaboration: ChatCollaborationMode | null
  /** Whether Codex Fast Mode was enabled for this session's spawn. */
  chatFastMode: boolean
  onPersistSessionId?: (arg: { conversationId: string; origin: ConversationOrigin }) => void
  onInvalidResume?: () => void
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
   * The prompts (`permission-request` ids: permission cards, AskUserQuestion,
   * plan approval) the CLI is parked on. Non-empty drives the idle flip, so tab
   * indicators / kanban / automations see "waiting on user", and gates the queue
   * drainer: draining a queued user_message into stdin mid-tool would interleave
   * with the pending tool_result the SDK still expects. A COUNT, not a flag:
   * with parallel tool calls the first answer must not reopen the gate while
   * another prompt still waits. Emptied by each prompt's answer or withdrawal,
   * and by the turn's end.
   */
  pendingPrompts: Set<string>
  /** The user stopped the current turn: its aborted `result` is an end, not an error. */
  turnInterrupted: boolean
  /** Any assistant progress (live or saved) since the last user message. */
  turnProgress: boolean
  /** Live-event counter (see `TransportDeps.broadcastEvent`). */
  liveSeq: number
  /** A respawn in progress — new starts wait for it. */
  respawning: Promise<void> | null
  /** The untested-CLI notice was shown for this tab. */
  versionNoticed: boolean
  /**
   * The CLI version this tab's next spawn most likely runs: the last `turn-init`
   * of its processes, else the hydrate hint. Gates spawn options an older CLI
   * would refuse (`AgentSpawnOpts.cliVersion`).
   */
  cliVersion: string | null
  /** A CLI of this tab refused a version-gated option: spawn without them. */
  optionalFlagsRefused: boolean
  /**
   * A process of this tab reported `sessionId` as its conversation: it exists
   * now (the CLI keeps it), whether or not its id reached the DB yet.
   */
  sessionConfirmed: boolean
  /** The next (resuming) spawn reads the conversation's past from the CLI (a switch, Codex). */
  pendingHistoryImport: boolean
  /**
   * A fork (plan 3.3) the CLI has not confirmed yet: `sessionId` is the fork's
   * id, and every spawn until the CLI reports it forks again — an unconfirmed
   * fork wrote nothing, so the same id is still free (chat-a check R3b).
   */
  pendingFork: { fromSessionId: string; atMessageUuid: string } | null
  /** Removed (tab closed / reset): nothing may touch it any more. */
  closed: boolean
}

// Liveness watchdog — guarantees a session always reaches a terminal state.
// `starting`: max wait for the subprocess to report ready (mirrors the xterm
// watchdog). `running`: max time with NO forward progress — a sliding window
// reset by every progress event, so a long healthy turn is never false-killed —
// and while a tool call is open, that tool's own timeout (chat-watchdog.ts).
// `kill grace`: wait after a SIGTERM before escalating to SIGKILL.
const WATCHDOG_STARTING_BOUND_MS = 20_000
const WATCHDOG_RUNNING_STALL_MS = 300_000
const WATCHDOG_KILL_GRACE_MS = 2_000
/** A start waits for its process this long: the computer's admission queue + the link. */
const WATCHDOG_SPAWN_REPLY_BOUND_MS = 120_000

function watchdogTimings(): {
  startingBoundMs: number
  runningStallMs: number
  killGraceMs: number
  spawnReplyBoundMs: number
} {
  const t = deps.watchdogTimings
  if (t) return { ...t, spawnReplyBoundMs: t.spawnReplyBoundMs ?? t.startingBoundMs }
  return {
    startingBoundMs: WATCHDOG_STARTING_BOUND_MS,
    runningStallMs: WATCHDOG_RUNNING_STALL_MS,
    killGraceMs: WATCHDOG_KILL_GRACE_MS,
    spawnReplyBoundMs: WATCHDOG_SPAWN_REPLY_BOUND_MS
  }
}

const tabs = new Map<string, ChatTab>()
/** Closing tabs' final writes, awaited before the same tab is hydrated again. */
const closing = new Map<string, Promise<void>>()

function stateKey(tab: ChatTab): string {
  return `${tab.taskId}:${tab.tabId}`
}

function diagnostic(
  tab: ChatTab,
  level: 'info' | 'warn' | 'error',
  event: string,
  message: string,
  payload: Record<string, unknown> = {}
): void {
  try {
    recordDiagnosticEvent({
      level,
      source: 'main',
      event,
      taskId: tab.taskId,
      sessionId: stateKey(tab),
      message,
      payload: { tabId: tab.tabId, mode: tab.mode, ...payload }
    })
  } catch (err) {
    console.error(`[chat-transport] ${event}: recordDiagnosticEvent threw:`, err)
  }
}

// ---- liveness watchdog ----
// Guarantees every session reaches a terminal state. A session stuck in
// `starting` (subprocess never reported ready) or `running` (a turn making no
// forward progress) is force-killed; a subprocess that died without delivering
// an `exit` event is reaped through the canonical exit handler. Self-healing:
// the timer re-arms across kill escalation, so `dead` is reached even when
// every kill's `exit` event is lost — and for a routed process, whose liveness
// the hub cannot probe, the SIGKILL rung ends it as dead instead of re-probing
// forever.

type WatchdogVector = 'stuck-starting' | 'running-stall' | 'fatal-kill'

function clearWatchdog(tab: ChatTab): void {
  if (tab.watchdogTimer !== null) {
    clearTimeout(tab.watchdogTimer)
    tab.watchdogTimer = null
  }
  tab.watchdogKillStage = 'none'
}

/** When the running turn counts as stuck: silence window, or the open tools' own bounds. */
function runningDeadlineOf(tab: ChatTab): number {
  return runningDeadline({
    lastProgressAt: tab.watchdogLastProgress,
    stallMs: watchdogTimings().runningStallMs,
    openTools: tab.proc?.openTools.values() ?? []
  })
}

/** Arm (or re-arm) the watchdog for the session's current non-terminal state. */
function armWatchdog(tab: ChatTab): void {
  if (tab.watchdogTimer !== null) clearTimeout(tab.watchdogTimer)
  const t = watchdogTimings()
  let delay: number
  if (tab.terminalState === 'starting') {
    delay = tab.proc && !tab.proc.spawned ? t.spawnReplyBoundMs : t.startingBoundMs
  } else if (tab.terminalState === 'running') {
    delay = Math.max(0, runningDeadlineOf(tab) - Date.now())
  } else {
    tab.watchdogTimer = null
    return
  }
  tab.watchdogTimer = setTimeout(() => fireWatchdog(tab), delay)
  tab.watchdogTimer.unref?.()
}

/**
 * Arm a short kill-grace tick after a SIGTERM (used by the fatal-error path)
 * so the next fire escalates to SIGKILL regardless of the session's state.
 */
function armWatchdogForKill(tab: ChatTab): void {
  if (tab.watchdogTimer !== null) clearTimeout(tab.watchdogTimer)
  tab.watchdogKillStage = 'sigterm'
  tab.watchdogTimer = setTimeout(() => fireWatchdog(tab), watchdogTimings().killGraceMs)
  tab.watchdogTimer.unref?.()
}

function recordWatchdogFire(
  tab: ChatTab,
  vector: WatchdogVector,
  outcome: 'no-child' | 'missed-exit' | 'alive' | 'unconfirmed-kill',
  killStage: ChatTab['watchdogKillStage']
): void {
  diagnostic(tab, 'warn', 'chat.watchdog_fired', `${vector} → ${outcome}`, {
    vector,
    outcome,
    killStage,
    terminalState: tab.terminalState
  })
}

function fireWatchdog(tab: ChatTab): void {
  tab.watchdogTimer = null
  // Already terminal / replaced — nothing to do.
  if (tab.closed || tab.ended || tab.terminalState === 'dead' || tabs.get(tab.tabId) !== tab) {
    clearWatchdog(tab)
    return
  }
  // When not mid-kill, only `starting`/`running` are watched. A session resting
  // in `idle`/`error` is correct. Mid-kill (`watchdogKillStage !== 'none'`, set
  // by the fatal-error path) proceeds regardless of state.
  if (
    tab.watchdogKillStage === 'none' &&
    tab.terminalState !== 'starting' &&
    tab.terminalState !== 'running'
  ) {
    clearWatchdog(tab)
    return
  }
  const timings = watchdogTimings()
  // `running` recheck: progress (or a tool call opening) may have moved the
  // deadline after the timer was set — re-arm for the remainder instead of
  // false-killing.
  if (tab.terminalState === 'running' && tab.watchdogKillStage === 'none') {
    const remaining = runningDeadlineOf(tab) - Date.now()
    if (remaining > 0) {
      tab.watchdogTimer = setTimeout(() => fireWatchdog(tab), remaining)
      tab.watchdogTimer.unref?.()
      return
    }
  }
  const vector: WatchdogVector =
    tab.terminalState === 'starting'
      ? 'stuck-starting'
      : tab.terminalState === 'running'
        ? 'running-stall'
        : 'fatal-kill'
  const proc = tab.proc
  if (!proc || proc.ended) {
    recordWatchdogFire(tab, vector, 'no-child', tab.watchdogKillStage)
    transitionState(tab, 'dead')
    clearWatchdog(tab)
    return
  }
  // Liveness probe is LOCAL-ONLY. `deps.isProcessAlive` is `process.kill(pid, 0)`
  // on THIS machine, so probing a routed session's pid would interrogate whatever
  // hub-local process happens to share that number — a false "alive" (or a false
  // "dead" that reaps a healthy remote turn). For a routed spawn we cannot observe
  // liveness from here, so skip straight to kill escalation, whose frames the
  // computer answers authoritatively.
  const pid = proc.pid
  const canProbe = proc.probeable && pid > 0
  const alive = canProbe ? deps.isProcessAlive(pid) : true
  if (!alive) {
    // Subprocess is dead but its `exit` event never arrived (missed-exit race)
    // — reap it through the canonical exit handler, no teardown duplication.
    recordWatchdogFire(tab, vector, 'missed-exit', tab.watchdogKillStage)
    clearWatchdog(tab)
    proc.reap(null, 'SIGKILL')
    return
  }
  if (tab.watchdogKillStage === 'sigkill' && !canProbe) {
    // Routed: SIGKILL sent a grace ago and still no exit (computer unreachable,
    // or the frame lost). Nothing more can be learned — end it as dead rather
    // than re-probing forever. Its late output, if any, is dropped at the door.
    recordWatchdogFire(tab, vector, 'unconfirmed-kill', tab.watchdogKillStage)
    clearWatchdog(tab)
    proc.reap(null, 'SIGKILL')
    return
  }
  // Alive past the bound — escalate one kill rung, then re-arm to verify.
  recordWatchdogFire(tab, vector, 'alive', tab.watchdogKillStage)
  if (tab.watchdogKillStage === 'none') {
    if (vector !== 'fatal-kill') {
      // Every failure is visible: say why the agent is being stopped.
      routeHostEvent(tab, {
        kind: 'notice',
        id: randomUUID(),
        level: 'warning',
        code: 'watchdog-killed',
        text:
          vector === 'stuck-starting'
            ? `${tab.backend.displayName} did not start in time and was stopped.`
            : `${tab.backend.displayName} stopped responding and was stopped.`,
        detail: { vector }
      })
    }
    proc.kill('SIGTERM')
    tab.watchdogKillStage = 'sigterm'
  } else if (tab.watchdogKillStage === 'sigterm') {
    proc.kill('SIGKILL')
    tab.watchdogKillStage = 'sigkill'
  }
  // 'sigkill' already sent (local) — keep re-probing; SIGKILL is uninterceptable
  // so the process dies within a window or two and the next fire reaps it.
  tab.watchdogTimer = setTimeout(() => fireWatchdog(tab), timings.killGraceMs)
  tab.watchdogTimer.unref?.()
}

function transitionState(tab: ChatTab, next: ChatTerminalState): void {
  if (tab.terminalState === next) return
  // Leaving a watched state for a resting/terminal one — disarm.
  if (next === 'idle' || next === 'error' || next === 'dead') {
    clearWatchdog(tab)
  }
  const old = tab.terminalState
  tab.terminalState = next
  const stateSessionId = stateKey(tab)
  deps.broadcastStateChange(stateSessionId, next, old)
  deps.onStateChange?.(stateSessionId, next, old)
  // Edge-trigger: any time we land in `idle` (post-result, post-spawn, etc.)
  // give the queue drainer a chance to push the next user-message. Scheduled
  // via setImmediate so the drain's dispatch path doesn't re-enter the event
  // pipeline inside the current event tick.
  if (next === 'idle') kickQueueDrainer(tab)
}

/**
 * Let the queue drainer try the next message (it re-checks the gate itself).
 * On every move into `idle`, and whenever the gate may have opened while idle:
 * the last in-flight message settled (the CLI acks `completed` AFTER the turn's
 * result) or the last pending prompt went. Scheduled via setImmediate so the
 * drain's dispatch path doesn't re-enter the event pipeline in this tick.
 */
function kickQueueDrainer(tab: ChatTab): void {
  if (!queueDrainer || tab.closed || tab.terminalState !== 'idle') return
  const tabId = tab.tabId
  const drain = queueDrainer
  setImmediate(() => drain(tabId))
}

let queueDrainer: ((tabId: string) => void) | null = null

/**
 * Wire a drain callback the transport invokes whenever a session transitions
 * into `idle`. The callback is responsible for popping the head of the
 * persisted chat queue (if any) and dispatching it. Called from
 * chat-queue-handlers at registration time. Single global slot — registering
 * twice replaces.
 */
export function registerChatQueueDrainer(fn: (tabId: string) => void): void {
  queueDrainer = fn
}

/**
 * Read the current terminal state for a tab. Used by the queue drainer to
 * gate "should I pop?" — a send during a running turn would interleave with
 * the in-flight assistant response on the subprocess's stdin.
 */
export function getSessionTerminalState(tabId: string): ChatTerminalState | null {
  const tab = tabs.get(tabId)
  return tab ? tab.terminalState : null
}

/**
 * True if the CLI is parked on a user-blocking permission_request (e.g.
 * AskUserQuestion). Drainer must NOT pop queued user_messages in this state —
 * sending them as user_message blocks would interleave with the pending
 * tool_result the SDK still expects.
 */
export function isSessionAwaitingUserInput(tabId: string): boolean {
  const tab = tabs.get(tabId)
  return tab ? tab.pendingPrompts.size > 0 : false
}

/**
 * May the queue send its next message to this tab now? Idle, not parked on a
 * prompt, and no earlier message still on its way (accepted, being written, or
 * not yet answered) — the state the drainer re-checks after popping.
 */
export function isReadyForQueuedMessage(tabId: string): boolean {
  const tab = tabs.get(tabId)
  if (!tab || tab.closed || tab.ended || tab.respawning) return false
  return (
    tab.terminalState === 'idle' && tab.pendingPrompts.size === 0 && tab.outbox.inFlight() === 0
  )
}

// ---- event pipeline ----
// process → [generation gate] → transport-internal (outbox / watchdog) → resume
// guard → splitter → live broadcast | saved (log + broadcast + state machine).

/** Broadcast a live-only event: shown, never saved. */
function broadcastLive(tab: ChatTab, event: AgentEvent): void {
  tab.liveSeq++
  deps.broadcastEvent(tab.tabId, event, tab.log.lastSeq, tab.liveSeq)
}

/** An event the transport itself produces (user message, marker, notice, error…). */
function routeHostEvent(tab: ChatTab, event: AgentEvent): void {
  const split = tab.splitter.route(event)
  for (const live of split.live) broadcastLive(tab, live)
  for (const saved of split.saved) commitEvent(tab, saved)
}

function commitEvent(tab: ChatTab, event: AgentEvent): void {
  if (tab.closed) return
  const entry = tab.log.append(event)
  const { seq, at } = entry
  // Folded into the projection before any client can ask for rows after it.
  void tab.projection.then((p) => p?.apply(entry))
  tab.lastOutputTime = Date.now()
  deps.broadcastEvent(tab.tabId, event, seq, undefined, at)
  try {
    deps.persistEvent(tab.tabId, seq, event)
  } catch (err) {
    console.error('[chat-transport] persistEvent failed:', err)
  }

  // Feed chat activity into the shared terminal-state channel so tab indicators,
  // kanban cards, and task automations react to chat sessions the same way as PTY.
  // Semantics:
  //   running — mid-turn (processing user msg or tool call)
  //   idle    — turn finished, waiting on user
  //   error   — result came back with isError
  //   dead    — process exited
  if (event.kind === 'permission-request') {
    // Turn parks on user input (a permission card, AskUserQuestion, plan
    // approval) — flip to idle so tab indicators, kanban cards, and automations
    // see the same "waiting on user" state PTY adapters signal via completion
    // stamp / approval modal. The pending set gates the queue drainer so a
    // queued user-message doesn't interleave with the SDK's pending tool_result.
    tab.pendingPrompts.add(event.requestId)
    transitionState(tab, 'idle')
  } else {
    // Only a prompt's own answer (`permission-resolved`) or withdrawal
    // (`permission-cancelled`) takes it out of the set; the turn's end clears
    // it. Progress events don't: with parallel prompts, a tool that ran after
    // the first answer must not reopen the gate while the second still waits.
    if (event.kind === 'permission-resolved' || event.kind === 'permission-cancelled') {
      tab.pendingPrompts.delete(event.requestId)
      if (tab.pendingPrompts.size === 0) kickQueueDrainer(tab)
    } else if (
      event.kind === 'result' ||
      event.kind === 'interrupted' ||
      event.kind === 'process-exit'
    ) {
      tab.pendingPrompts.clear()
    }
    // An answer resumes the parked turn once nothing else waits: back to
    // running, so the tab stops reading "needs you" while the approved tool
    // runs. The TUI's plain "No" (deny + interrupt) ends the turn instead — its
    // `result` settles the state.
    if (
      event.kind === 'permission-resolved' &&
      tab.pendingPrompts.size === 0 &&
      !(event.decision.behavior === 'deny' && event.decision.interrupt)
    ) {
      transitionState(tab, 'running')
      // Watched again from here (the open tool's own bound applies).
      tab.watchdogLastProgress = Date.now()
      armWatchdog(tab)
    }
    // `turn-init` is session metadata (id/model/cwd/tools), NOT a turn-open
    // signal. Claude's SDK emits it mid-first-turn so it *looks* turn-aligned,
    // but Codex's driver emits a synthetic one at handshake — before any turn.
    // Treating it as turn-open left Codex sessions stuck `running` post-spawn/
    // -resume. A turn opens when the outbox WRITES a user message
    // (`markTurnStarted`) — not when one is accepted, which may be before the
    // process even runs; `tool-call` stays as a mid-turn safety net.
    if (event.kind === 'tool-call') {
      transitionState(tab, 'running')
    } else if (event.kind === 'result') {
      // A turn the user stopped ends with the CLI's aborted result: an end, not
      // a failure (the same for the TUI's plain "No", deny + interrupt).
      const stopped = tab.turnInterrupted || isAbortedResult(event)
      transitionState(tab, event.isError && !stopped ? 'error' : 'idle')
    } else if (event.kind === 'process-exit') {
      transitionState(tab, 'dead')
    }
  }

  // Liveness watchdog: while `running`, (re)arm on every forward-progress event.
  if (
    tab.terminalState === 'running' &&
    (event.kind === 'tool-call' || isProgressEventKind(event.kind))
  ) {
    tab.watchdogLastProgress = Date.now()
    armWatchdog(tab)
  }

  if (event.kind === 'turn-init') {
    if (event.cliVersion) tab.cliVersion = event.cliVersion
    checkCliVersion(tab, event.cliVersion)
  }

  // Surface discovered session id for persistence (resume-on-reopen).
  // Provenance gate: the persisted id is only honored on next read when it
  // matches what slay actually spawned. A foreign id (e.g. user manually typed
  // `claude --resume X` in the PTY) is recorded as `foreign-observed` — audit
  // trail only, never the resume target. See conversation-id-robustness plan.
  const extracted = tab.proc?.driver.extractSessionId(event) ?? null
  // A CLI that mints the id (Codex): the first one a fresh or forked spawn
  // reports IS the conversation slay started — there was nothing to match.
  if (
    extracted &&
    tab.backend.mintsConversationId &&
    !tab.usedResume &&
    !tab.sessionConfirmed &&
    extracted !== tab.sessionId
  ) {
    tab.sessionId = extracted
  }
  const forked = Boolean(tab.proc?.fork) && extracted === tab.sessionId
  if (extracted && extracted === tab.sessionId) {
    tab.sessionConfirmed = true
    tab.pendingFork = null
  }
  if (extracted && tab.onPersistSessionId) {
    const origin =
      extracted === tab.sessionId
        ? forked
          ? 'slay-spawned-fork'
          : tab.usedResume
            ? 'slay-spawned-resume'
            : 'slay-spawned-fresh'
        : 'foreign-observed'
    tab.onPersistSessionId({ conversationId: extracted, origin })
  }
}

/** Say so (once per tab) when the agent's CLI is older than the newest tested one. */
function checkCliVersion(tab: ChatTab, version: string | undefined): void {
  const minimum = tab.backend.minTestedCliVersion
  if (!minimum || !version || tab.versionNoticed) return
  if (!isCliVersionBelow(version, minimum)) return
  tab.versionNoticed = true
  routeHostEvent(tab, {
    kind: 'notice',
    id: randomUUID(),
    level: 'warning',
    code: 'cli-version-untested',
    text: `Untested ${tab.backend.displayName} version ${version}: chat is tested with ${minimum} and newer. Some things may not work; update with \`${tab.backend.updateCommand}\`.`,
    detail: { version, minimum }
  })
}

/**
 * The CLI refused a version-gated spawn option (its version was not the one the
 * tab expected — e.g. another computer's older CLI): spawn this tab without
 * them from now on, and say so once.
 */
function noteRefusedOption(tab: ChatTab, stderr: string): void {
  if (tab.optionalFlagsRefused) return
  const flag = tab.backend.refusedOptionalFlag?.(stderr)
  if (!flag) return
  tab.optionalFlagsRefused = true
  routeHostEvent(tab, {
    kind: 'notice',
    id: randomUUID(),
    level: 'warning',
    code: 'cli-option-refused',
    text: `This ${tab.backend.displayName} does not support \`${flag}\`; chat starts it without that option from now on. Retry to start it again, or update with \`${tab.backend.updateCommand}\`.`,
    detail: { flag }
  })
}

/** An event from a process — already through the generation gate. */
function handleProcessEvent(tab: ChatTab, proc: ChatProcess, event: AgentEvent): void {
  if (tab.closed || tab.proc !== proc) return

  // Transport-internal: they move the outbox / watchdog, never the timeline.
  switch (event.kind) {
    case 'command-lifecycle':
      tab.outbox.onLifecycle(proc.gen, event.commandUuid, event.state)
      noteAlive(tab)
      return
    case 'user-replay':
      tab.outbox.onReplay(proc.gen, event.uuid)
      return
    case 'heartbeat':
      noteAlive(tab)
      return
  }

  // Fatal driver-start failure (handshake could not complete). Unlike a resume
  // failure — recoverable, respawns fresh — an `initialize` / `thread/start`
  // failure has nowhere to go. Surface the error, then kill the subprocess so
  // the existing exit path drives the session to its terminal `dead` state
  // (Retry overlay). Without this the session lingers half-alive and silently
  // queues any further input.
  if (
    event.kind === 'error' &&
    typeof event.detail === 'object' &&
    event.detail !== null &&
    (event.detail as { fatal?: unknown }).fatal === true
  ) {
    const detail = event.detail as { phase?: unknown; reason?: unknown }
    if (detail.phase === 'fork' && proc.fork && tab.pendingFork) {
      // The CLI could not branch the conversation (Codex `thread/fork`): the
      // tab goes back to the original once this process ended (`onForkFailure`).
      proc.forkFailed = true
    } else if (detail.phase === 'resume') {
      // The resume failed, but not because the conversation is gone: it stays
      // the tab's (no fresh start, nothing cleared) and Retry resumes it.
      proc.resumeSettled = true
      const reason = typeof detail.reason === 'string' ? detail.reason : event.message
      routeHostEvent(tab, {
        kind: 'notice',
        id: randomUUID(),
        level: 'warning',
        code: 'resume-failed-kept',
        text: `${tab.backend.displayName} could not reopen the conversation (${reason}). It is kept: press Retry to try again.`,
        detail: { reason }
      })
    } else {
      routeHostEvent(tab, event)
    }
    if (!proc.ended) {
      proc.kill('SIGTERM')
      // Backstop: if SIGTERM is ignored, the watchdog escalates to SIGKILL
      // and guarantees the session reaches `dead`.
      armWatchdogForKill(tab)
    } else {
      transitionState(tab, 'dead')
    }
    return
  }

  // Resume guard: only the CLI's real "can't resume" signals are withheld.
  let shown: AgentEvent | null = event
  if (tab.usedResume && !proc.resumeSettled && tab.respawnOpts.autoRetryOnInvalidResume !== false) {
    const verdict = classifyResumeEvent(event, proc)
    if (verdict.verdict === 'failure') {
      onResumeFailure(tab, proc)
      shown = verdict.event
    } else if (verdict.verdict === 'confirm') {
      proc.resumeSettled = true
    }
  }
  if (proc.resumeFailed) {
    // The failed resume's remaining output is part of the failure.
    if (shown?.kind === 'result' || shown?.kind === 'process-exit') return
  }
  if (!shown) return
  if (shown.kind === 'stderr') noteRefusedOption(tab, shown.text)

  // The user took this turn's message back (Stop before any output): whatever the
  // turn still says is gone from the conversation too (rewound), so it never
  // reaches the timeline. Its end settles the state.
  if (proc.discardTurn && DISCARDED_TURN_KINDS.has(shown.kind)) {
    if (shown.kind === 'result' || shown.kind === 'interrupted') {
      proc.discardTurn = false
      proc.openTools.clear()
      tab.outbox.onResult(proc.gen)
      tab.pendingPrompts.clear()
      transitionState(tab, 'idle')
    }
    return
  }

  if (opensAgentTurn(tab, shown)) markAgentTurnStarted(tab)
  trackTools(proc, shown)
  if (isProgressEventKind(shown.kind)) noteProgress(tab)
  if (shown.kind === 'result') tab.outbox.onResult(proc.gen)
  else if (isTurnProgress(shown.kind)) tab.outbox.onProgress(proc.gen)

  const split = tab.splitter.route(shown)
  for (const live of split.live) broadcastLive(tab, live)
  for (const saved of split.saved) commitEvent(tab, saved)
}

/** What a popped turn may still say: its output and its end. */
const DISCARDED_TURN_KINDS: ReadonlySet<AgentEvent['kind']> = new Set<AgentEvent['kind']>([
  'assistant-text',
  'assistant-thinking',
  'tool-call',
  'tool-result',
  'sub-agent',
  'agent-plan',
  'command-output',
  'permission-request',
  'stream-message-start',
  'stream-block-start',
  'stream-block-delta',
  'stream-block-stop',
  'stream-message-stop',
  'result',
  'interrupted'
])

/** Open/close tool calls (the watchdog bounds a silent turn by them). */
function trackTools(proc: ChatProcess, event: AgentEvent): void {
  if (event.kind === 'tool-call') {
    proc.openTools.set(event.id, {
      startedAt: Date.now(),
      boundMs: toolBoundMs(event.name, event.input, process.env)
    })
  } else if (event.kind === 'tool-result') {
    proc.openTools.delete(event.toolUseId)
  } else if (event.kind === 'result' || event.kind === 'interrupted') {
    proc.openTools.clear()
  }
}

/** Assistant progress: the turn produced something (Stop no longer pops its message). */
function noteProgress(tab: ChatTab): void {
  tab.turnProgress = true
  noteAlive(tab)
}

/** Proof of life for the watchdog only (heartbeats, delivery acks). */
function noteAlive(tab: ChatTab): void {
  if (tab.terminalState === 'running') {
    tab.watchdogLastProgress = Date.now()
    if (tab.watchdogKillStage === 'none') armWatchdog(tab)
  }
}

/** Events that prove a written user message reached a turn (old-CLI delivery fallback). */
function isTurnProgress(kind: AgentEvent['kind']): boolean {
  return (
    kind === 'turn-init' ||
    kind === 'assistant-text' ||
    kind === 'assistant-thinking' ||
    kind === 'tool-call' ||
    isStreamFragment(kind)
  )
}

/**
 * The agent started a turn by itself — Claude Code answers a finished
 * background task (`task_notification`) with a new turn no user message opened:
 * its first main-thread output while the tab is between turns. `turn-init` alone
 * is not one (Codex sends it at handshake), nor output while a prompt waits (that
 * turn is parked, not over), nor a background sub-agent's output.
 */
function opensAgentTurn(tab: ChatTab, event: AgentEvent): boolean {
  if (tab.terminalState !== 'idle' && tab.terminalState !== 'error') return false
  if (tab.pendingPrompts.size > 0) return false
  if (event.kind === 'turn-init' || !isTurnProgress(event.kind)) return false
  return !('parentToolUseId' in event) || event.parentToolUseId == null
}

/** A turn the agent opened (`opensAgentTurn`): running until its result. */
function markAgentTurnStarted(tab: ChatTab): void {
  tab.turnInterrupted = false
  transitionState(tab, 'running')
  tab.watchdogLastProgress = Date.now()
  armWatchdog(tab)
}

/** The outbox is writing a user message: the turn starts now. */
function markTurnStarted(tab: ChatTab): void {
  tab.turnProgress = false
  tab.turnInterrupted = false
  markSessionUserInput(stateKey(tab))
  transitionState(tab, 'running')
  tab.watchdogLastProgress = Date.now()
  armWatchdog(tab)
}

function onResumeFailure(tab: ChatTab, proc: ChatProcess): void {
  if (proc.resumeFailed) return
  proc.resumeFailed = true
  proc.resumeSettled = true
  if (tab.onInvalidResume) {
    tab.onInvalidResume()
    tab.onInvalidResume = undefined
  }
  if (tab.retryScheduled) return
  tab.retryScheduled = true
  routeHostEvent(tab, {
    kind: 'notice',
    id: randomUUID(),
    level: 'warning',
    code: 'resume-failed-fresh-start',
    text: `The previous conversation could not be resumed, so ${tab.backend.displayName} started a new one. It does not remember the earlier messages.`
  })
  setImmediate(() => {
    void respawnFresh(tab).catch((err) => {
      console.error('[chat-transport] auto-retry after invalid resume failed:', err)
    })
  })
}

/** Start over without `--resume`, on the same tab (history, outbox kept). */
async function respawnFresh(tab: ChatTab): Promise<void> {
  if (tab.closed) return
  await respawnTab(
    tab,
    {
      ...tab.respawnOpts,
      conversationId: null,
      // Don't loop: a second failure is shown, not retried.
      autoRetryOnInvalidResume: false
    },
    { fresh: true }
  )
}

function handleProcessExit(
  tab: ChatTab,
  proc: ChatProcess,
  code: number | null,
  signal: string | null
): void {
  const current = !tab.closed && tabs.get(tab.tabId) === tab && tab.proc === proc
  // A fork the CLI refused: it ends on its own, before confirming, with an error
  // (an unknown fork point exits 1 at startup — chat-a check R3b).
  if (
    current &&
    proc.fork &&
    tab.pendingFork &&
    !proc.replaced &&
    !proc.stopRequested &&
    code !== 0
  ) {
    proc.forkFailed = true
  }
  // Undelivered messages of a REPLACED process (or a failed resume / fork) go to
  // the next one; any other end fails them, visibly.
  const resend = proc.replaced || proc.resumeFailed || proc.forkFailed
  if (!tab.closed) {
    // A failed resume never had a conversation: even what it confirmed is re-sent.
    tab.outbox.onProcessEnded(proc.gen, {
      resend,
      resendDelivered: proc.resumeFailed || proc.forkFailed
    })
  }
  if (proc.forkFailed) {
    onForkFailure(tab, proc)
    return
  }
  // If this process was already replaced in the tab (respawn, reset, a failed
  // resume), swallow the exit so the UI doesn't revert to "Session ended".
  if (!current || proc.replaced || proc.resumeFailed) return
  clearWatchdog(tab)
  tab.ended = true
  // Record `stopped` UNLESS we're in app shutdown — in which case the row stays
  // `running` so next boot restores. Subprocess crashes / claude-side exits count
  // as stopped because there's nothing to "restore" anymore.
  if (!isShuttingDown) {
    try {
      agentStateRecorder?.(tab.tabId, 'stopped')
    } catch (err) {
      console.error('[chat-transport] agent state (stopped) write failed:', err)
    }
  }
  routeHostEvent(tab, { kind: 'process-exit', code, signal })
  deps.broadcastExit(tab.tabId, tab.sessionId, code, signal)
  clearSessionUserInputMark(stateKey(tab))
}

/**
 * The CLI refused a fork: the tab goes back to the conversation it forked from
 * (a process resumes it at once, as before the fork), and says so. The fork's
 * marker is answered by `fork-failed`, which unfolds it.
 */
function onForkFailure(tab: ChatTab, proc: ChatProcess): void {
  const from = proc.fork!.fromSessionId
  clearWatchdog(tab)
  tab.pendingFork = null
  tab.sessionId = from
  tab.sessionConfirmed = true
  tab.respawnOpts = { ...tab.respawnOpts, conversationId: from }
  routeHostEvent(tab, { kind: 'conversation-branch', reason: 'fork-failed', conversationId: from })
  routeHostEvent(tab, {
    kind: 'notice',
    id: randomUUID(),
    level: 'error',
    code: 'fork-failed',
    text: `${tab.backend.displayName} could not fork from that message, so this chat stays in the original conversation.`
  })
  setImmediate(() => {
    if (tab.closed || tab.proc !== proc) return
    void respawnTab(tab, { ...tab.respawnOpts }).catch((err) => {
      console.error('[chat-transport] resume after a refused fork failed:', err)
    })
  })
}

/** The agent could not be started: visible error, `dead`, waiting messages failed. */
function failStart(tab: ChatTab, err: unknown): void {
  if (tab.closed) return
  const error = err instanceof Error ? err : new Error(String(err))
  const code = isChatSpawnError(error) ? error.code : 'spawn-failed'
  routeHostEvent(tab, {
    kind: 'error',
    message: error.message,
    detail: {
      code,
      ...(isChatSpawnError(error) && error.binary ? { binary: error.binary } : {}),
      ...(tab.respawnOpts.computerId ? { computerId: tab.respawnOpts.computerId } : {})
    }
  })
  tab.ended = true
  transitionState(tab, 'dead')
  if (!isShuttingDown) {
    try {
      agentStateRecorder?.(tab.tabId, 'stopped')
    } catch (err2) {
      console.error('[chat-transport] agent state (stopped) write failed:', err2)
    }
  }
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
  /**
   * Computer this session's agent process should spawn on. `null`/absent = the hub.
   * Mirrors `PtySpawnSpec.computerId` — the routing backend reads it to dispatch,
   * and a non-routing (test/default) setup ignores it entirely.
   */
  computerId?: string | null
  /**
   * Project this session belongs to, so the COMPUTER can resolve its own cwd when
   * `cwd` is empty — the hub cannot, having no path column that could be right
   * about more than one machine. `cwd` still wins when set (a worktree, or a
   * `task.base_dir` the user chose). Mirrors `PtySpawnSpec.projectId`.
   */
  projectId?: string | null
  /** Extra env overrides (PATH enrichment already applied by caller or inherited). */
  env?: EnvOverlay
  /**
   * Agent-start lane on the computer: `foreground` (a user action, default) or
   * `background` (a restore) — restoring many tabs starts their agents a few at
   * a time instead of all at once.
   */
  admission?: 'foreground' | 'background'
  /**
   * Callback when adapter discovers a session_id in the stream. The transport
   * tags it with a provenance `origin` — `slay-spawned-*` when the discovered
   * id matches the one slay sent/minted, `foreign-observed` when it doesn't
   * (e.g. user typed `claude --resume <other>` in the PTY). The caller
   * persists via `recordConversation` in task_conversations.
   */
  onPersistSessionId?: (arg: { conversationId: string; origin: ConversationOrigin }) => void
  /** Called when --resume was attempted but the stored session id is invalid. Clear it. */
  onInvalidResume?: () => void
  /**
   * If true, transport auto-retries a single fresh spawn when --resume is rejected.
   * Default true. The user's message is re-sent to the fresh process.
   */
  autoRetryOnInvalidResume?: boolean
  /**
   * Test override for the tab's saved history. Normally the transport loads it
   * itself (`eventStore`), after any previous instance of the tab finished writing.
   */
  initialBuffer?: BufferedEvent[]
  /** Test override: starting seq (defaults to newest saved seq + 1). */
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
  /** Claude: a `ChatEffort`; Codex: any effort its model lists (`ultra`, …). */
  chatEffort?: string | null
  /** Resolved collaboration mode for the spawn (Codex `turn/start.collaborationMode`). */
  chatCollaboration?: ChatCollaborationMode | null
  /** Whether Codex Fast Mode (`serviceTier: 'fast'`) is enabled for the spawn. */
  chatFastMode?: boolean
  /**
   * The CLI version last seen for this task's project + mode (`chat_cli_snapshots`):
   * the tab's first hint for version-gated spawn options (see `ChatTab.cliVersion`).
   */
  cliVersion?: string | null
}

/** Dedupe for concurrent hydrates of one tab (renderer hydrate racing chat.start). */
const inFlightHydrates = new Map<string, Promise<ChatSessionInfo>>()

/**
 * Hydrate a chat session WITHOUT spawning a subprocess. Loads persisted history
 * into the tab's event log, populates resolved chatMode/Model/Effort, and inserts
 * a `not-spawned` skeleton. The actual OS subprocess is started lazily by
 * `ensureSpawned` on the first `chat:send` (or queue drain).
 *
 * Idempotent: if a live session (or any prior skeleton) already exists for the
 * tab, returns its info. Zombie sessions (identity mismatch on tabId) are torn
 * down and replaced. History is read only after a previous instance of the tab
 * finished writing, so a new log can never re-use one of its seqs.
 */
export async function hydrateSession(opts: CreateChatOpts): Promise<ChatSessionInfo> {
  if (isShuttingDown) {
    throw new ChatTransportError('Cannot hydrate chat session while app is shutting down.')
  }
  const pending = inFlightHydrates.get(opts.tabId)
  if (pending) {
    await pending.catch(() => undefined)
    return hydrateSession(opts)
  }
  const existing = tabs.get(opts.tabId)
  if (existing) {
    // Invariant: a tabId must only ever back ONE (taskId, cwd, mode) tuple. If the
    // caller asks to hydrate the same tabId but a different identity, the prior
    // session is a zombie (e.g. tab was closed without chat:remove). Returning
    // it would stream another task's events into the new panel — exactly the symptom
    // of the cross-task chat leak. Tear it down and re-hydrate.
    if (
      existing.taskId === opts.taskId &&
      existing.cwd === opts.cwd &&
      existing.mode === opts.mode
    ) {
      // Reattach: live session or pre-spawn skeleton — both already carry
      // history + resolved chat state, just return current info.
      return toInfo(existing)
    }
    console.warn(
      `[chat-transport] zombie session for tabId=${opts.tabId} ` +
        `had (taskId=${existing.taskId}, cwd=${existing.cwd}, mode=${existing.mode}); ` +
        `replacing with (taskId=${opts.taskId}, cwd=${opts.cwd}, mode=${opts.mode})`
    )
    void removeSession(opts.tabId)
  }
  const promise = createTab(opts)
  inFlightHydrates.set(opts.tabId, promise)
  try {
    return await promise
  } finally {
    inFlightHydrates.delete(opts.tabId)
  }
}

/**
 * After a restart: a fork the CLI never confirmed (no message was sent in it, so
 * the task still names the original) is still the tab's conversation — the
 * saved `forked` marker says so. The next spawn forks again.
 */
function rearmPendingFork(tab: ChatTab, history: readonly BufferedEvent[]): void {
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i].event
    if (e.kind !== 'conversation-branch') continue
    if (
      e.reason === 'forked' &&
      e.conversationId &&
      e.fromConversationId &&
      e.atMessageUuid &&
      tab.sessionId === e.fromConversationId
    ) {
      tab.pendingFork = { fromSessionId: e.fromConversationId, atMessageUuid: e.atMessageUuid }
      tab.sessionId = e.conversationId
      tab.sessionConfirmed = false
      tab.usedResume = false
      tab.respawnOpts = { ...tab.respawnOpts, conversationId: null }
    }
    return
  }
}

async function createTab(opts: CreateChatOpts): Promise<ChatSessionInfo> {
  const backend = getBackend(opts.mode)
  if (!backend) {
    throw new ChatTransportError(`No agent backend registered for mode "${opts.mode}"`)
  }
  // A previous instance of this tab may still be writing its last events.
  await closing.get(opts.tabId)
  const history = opts.initialBuffer ?? (await deps.eventStore.load(opts.tabId))
  const nextSeq =
    opts.initialNextSeq ?? (history.length > 0 ? history[history.length - 1].seq + 1 : 0)

  // Skeleton sessionId placeholder. When the resume id is set in providerCfg we
  // honor it (so `--resume <id>` fires on first spawn); otherwise a fresh id.
  const sessionId = opts.conversationId || randomUUID()

  const tab = {
    sessionId,
    tabId: opts.tabId,
    taskId: opts.taskId,
    mode: opts.mode,
    cwd: opts.cwd,
    backend,
    splitter: new ChatEventSplitter(),
    proc: null,
    gen: 0,
    rawChild: null,
    ended: false,
    startedAt: new Date().toISOString(),
    lastOutputTime: Date.now(),
    terminalState: 'not-spawned',
    usedResume: Boolean(opts.conversationId),
    retryScheduled: false,
    respawnOpts: opts,
    chatMode: opts.chatMode ?? null,
    chatModel: opts.chatModel ?? null,
    chatEffort: opts.chatEffort ?? null,
    chatCollaboration: opts.chatCollaboration ?? null,
    chatFastMode: opts.chatFastMode ?? false,
    onPersistSessionId: opts.onPersistSessionId,
    onInvalidResume: opts.onInvalidResume,
    watchdogTimer: null,
    watchdogKillStage: 'none',
    watchdogLastProgress: Date.now(),
    pendingPrompts: new Set<string>(),
    turnInterrupted: false,
    turnProgress: false,
    liveSeq: 0,
    respawning: null,
    versionNoticed: false,
    cliVersion: opts.cliVersion ?? null,
    optionalFlagsRefused: false,
    sessionConfirmed: Boolean(opts.conversationId),
    pendingHistoryImport: false,
    pendingFork: null,
    closed: false
  } as Omit<ChatTab, 'log' | 'outbox'> as ChatTab
  rearmPendingFork(tab, history)
  tab.log = new ChatEventLog(
    opts.tabId,
    deps.eventStore,
    { events: history, nextSeq },
    {
      onClash: (seq, event) =>
        diagnostic(
          tab,
          'error',
          'chat.event_seq_clash',
          `seq ${seq} already saved; kept the existing row`,
          {
            seq,
            kind: event.kind
          }
        ),
      onWriteError: (seq, err) =>
        console.error(`[chat-transport] saving event ${seq} of ${opts.tabId} failed:`, err)
    }
  )
  tab.outbox = createOutbox(tab)
  tab.projection = openProjection(opts.tabId, opts.mode, history)
  tabs.set(opts.tabId, tab)

  // Messages the previous run never got confirmed are failed (Retry), not lost.
  tab.outbox.restore(history.map((b) => b.event))

  // Restored history with an unfinished turn → emit synthetic `interrupted` so
  // the renderer reducer rebalances userMessagesSent/resultCount. Otherwise the
  // tab badge and the chat panel's inFlight (true, counting stale persisted
  // user-messages without matching results) drift apart. Emitted at HYDRATE
  // time (was: at spawn time) so the marker shows even before the user
  // triggers a spawn — critical for lazy mode where a buffer with an
  // unfinished turn may sit unspawned indefinitely.
  if (tailIsUnfinishedTurn(history)) routeHostEvent(tab, { kind: 'interrupted' })

  return toInfo(tab)
}

function createOutbox(tab: ChatTab): ChatOutbox {
  const current = (): ChatProcess | null =>
    tab.proc && !tab.proc.ended && !tab.proc.replaced ? tab.proc : null
  return new ChatOutbox({
    current,
    ensureReady: async () => {
      if (tab.closed) throw new ChatTransportError('This chat tab was closed.')
      await ensureSpawned(tab.tabId)
      const proc = current()
      if (!proc || !proc.ready)
        throw new ChatTransportError(`${tab.backend.displayName} is not running.`)
      return proc
    },
    onChange: ({ id, state, error }) => {
      const event: AgentEvent = {
        kind: 'user-message-delivery',
        id,
        state,
        ...(error ? { error } : {})
      }
      // `sending` is transient: shown, never saved.
      if (state === 'sending') broadcastLive(tab, event)
      else routeHostEvent(tab, event)
      if (state === 'answered' || state === 'failed' || state === 'cancelled') {
        kickQueueDrainer(tab)
      }
    },
    onWriting: () => markTurnStarted(tab),
    onAlreadyInConversation: (id) => onAlreadyInConversation(tab, id),
    ...(deps.outboxRetry
      ? { retryWindowMs: deps.outboxRetry.windowMs, retryBaseMs: deps.outboxRetry.baseMs }
      : {}),
    onLifecycleMissing: (gen) =>
      diagnostic(
        tab,
        'info',
        'chat.lifecycle_missing',
        'the CLI sent no command_lifecycle; delivery inferred from turn progress',
        { gen }
      )
  })
}

/**
 * Dedupe map for concurrent `ensureSpawned` callers (e.g. simultaneous
 * `chat:send` + queue drainer racing on the same tab). Keyed by tabId; the
 * stored promise resolves when the spawn is READY (or rejects on error). All
 * concurrent callers await the same promise, preventing double-spawn.
 */
const inFlightSpawns = new Map<string, Promise<ChatSessionInfo>>()

/**
 * Idempotent spawn primitive. Resolves once the tab's process is READY — the OS
 * confirmed it runs AND its protocol driver started — so a message written right
 * after can never meet a driver without its IO (it was dropped: P0 N1). Starts a
 * process when the tab has none (or its last one ended).
 *
 * Throws if the tab has no hydrated session (caller must hydrate first), or if
 * the agent could not be started (the error is also shown in the chat).
 */
export async function ensureSpawned(tabId: string): Promise<ChatSessionInfo> {
  if (isShuttingDown) {
    throw new ChatTransportError('Cannot spawn chat session while app is shutting down.')
  }
  const tab = tabs.get(tabId)
  if (!tab) {
    throw new ChatTransportError(
      `ensureSpawned: no hydrated session for tabId=${tabId} — call hydrateSession first`
    )
  }
  while (tab.respawning) await tab.respawning.catch(() => undefined)
  const proc = tab.proc
  if (proc && !proc.ended && !proc.replaced) {
    await proc.readyPromise
    return toInfo(tab)
  }
  const pending = inFlightSpawns.get(tabId)
  if (pending) return pending
  const promise = (async (): Promise<ChatSessionInfo> => {
    try {
      const started = await startProcess(tab)
      await started.readyPromise
      return toInfo(tab)
    } finally {
      inFlightSpawns.delete(tabId)
    }
  })()
  inFlightSpawns.set(tabId, promise)
  return promise
}

/**
 * Start the next generation for a tab: spawn (routed or local), wire it, and
 * return it as soon as it exists (`readyPromise` says when it can take writes).
 */
async function startProcess(tab: ChatTab): Promise<ChatProcess> {
  if (isShuttingDown) {
    throw new ChatTransportError('Cannot spawn chat session while app is shutting down.')
  }
  // A conversation a process already confirmed is resumed, also when the
  // caller never stored it (a restart of a dead tab): starting over would drop
  // its context (Codex: a new thread; Claude: `--session-id` of a used id).
  if (!tab.respawnOpts.conversationId && tab.sessionConfirmed && !tab.pendingFork) {
    tab.respawnOpts = { ...tab.respawnOpts, conversationId: tab.sessionId }
  }
  const opts = tab.respawnOpts
  const backend = tab.backend
  const resume = Boolean(opts.conversationId)
  tab.usedResume = resume
  const sessionId = tab.sessionId
  const gen = ++tab.gen
  const spawnId = randomUUID()
  const cliVersion = tab.optionalFlagsRefused ? null : (tab.cliVersion ?? opts.cliVersion ?? null)
  // A new process has no prompt pending (the old one's expired with it).
  tab.pendingPrompts.clear()
  const fork = tab.pendingFork
  // One spawn reads a switched-to conversation's past from the CLI (Codex).
  const importHistory = tab.pendingHistoryImport && resume
  tab.pendingHistoryImport = false
  const { args } = backend.buildSpawnArgs({
    sessionId,
    resume,
    cwd: opts.cwd,
    providerFlags: opts.providerFlags,
    ...(cliVersion ? { cliVersion } : {}),
    ...(fork ? { fork } : {})
  })
  // The agent's own env (e.g. Claude's file checkpoints) under the per-spawn overlay.
  const env: EnvOverlay = { ...backend.spawnEnv, ...opts.env }
  // Never two processes on one conversation (plan 3.10): the terminal runs it.
  if (resume && isConversationLive('terminal', tab.taskId, sessionId)) {
    const err = chatSpawnError('conversation-in-use', conversationInUseMessage('terminal'))
    failStart(tab, err)
    throw err
  }

  tab.ended = false
  // Move out of `not-spawned` / `dead`. `onSpawn` promotes to `idle` once the
  // process is confirmed to run.
  transitionState(tab, 'starting')
  armWatchdog(tab)

  let handle: ChatProcHandle
  let rawChild: ChildProcess | null = null
  try {
    if (deps.backend) {
      // Routed (or routing-capable) spawn. Binary resolution is NOT done here:
      // `whichBinary` runs a LOCAL login shell, so a hub-resolved absolute path is
      // meaningless on a computer's filesystem. The spec carries the binary NAME and
      // whoever executes it resolves it against its own PATH. Likewise no
      // `sanitizeSpawnEnv(process.env)` base — that would ship the HUB's
      // environment; the executor merges its own sanitized base under `env`.
      handle = await deps.backend.spawn({
        sessionId: stateKey(tab),
        taskId: tab.taskId,
        computerId: opts.computerId ?? null,
        binaryName: backend.binaryName,
        args,
        // Carried so a chat agent resolves its cwd exactly as a terminal agent
        // does. Without it chat depended on the hub-computed path, which is the
        // one thing the hub cannot know for another machine.
        projectId: opts.projectId ?? null,
        cwd: opts.cwd,
        // `opts.env` values may be undefined (an `EnvOverlay`); the wire
        // contract is `Record<string, string>`, so drop unset keys rather than
        // shipping `undefined` values a zod record would reject.
        env: Object.fromEntries(
          Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined)
        ),
        admission: opts.admission ?? 'foreground'
      })
    } else {
      // In-process path: resolve on this machine's PATH and spawn. Refused first
      // on a hub with processes switched off — `whichBinary` itself already runs a
      // login shell here.
      assertHubProcessesEnabled('hub.process.spawn', {
        op: 'chat.spawn',
        detail: { taskId: tab.taskId, tabId: tab.tabId }
      })
      const binary = await deps.whichBinary(backend.binaryName)
      if (!binary) {
        throw chatSpawnError(
          'cli-not-installed',
          `Binary "${backend.binaryName}" not found on PATH. Install it or fix your shell's PATH.`,
          backend.binaryName
        )
      }
      rawChild = deps.spawn(binary, args, {
        cwd: opts.cwd,
        // Sanitized base (user env survives; SlayZone infra/secret/identity
        // stripped, fail closed on unmanifested SLAYZONE_*) + the per-spawn
        // overlay `opts.env` (the mcpEnv identity for this chat agent) on top.
        env: childProcessEnv(env),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false
      })
      handle = childProcessToHandle(rawChild)
    }
  } catch (err) {
    failStart(tab, err)
    throw err
  }

  tab.rawChild = rawChild
  // Record this tab's agent as running so a crash / unclean quit can restore it
  // on next boot. The exit handler records `stopped` on natural/user exit (NOT on
  // app shutdown — that's the whole point).
  try {
    agentStateRecorder?.(tab.tabId, 'running')
  } catch (err) {
    console.error('[chat-transport] agent state (running) write failed:', err)
  }

  const driver: ChatSessionDriver = backend.createDriver()
  const proc = new ChatProcess({
    gen,
    spawnId,
    handle,
    driver,
    probeable: rawChild !== null,
    ctx: {
      cwd: opts.cwd,
      sessionId,
      resume,
      providerFlags: opts.providerFlags,
      chatModel: tab.chatModel,
      chatEffort: tab.chatEffort,
      chatMode: tab.chatMode,
      chatCollaboration: tab.chatCollaboration,
      chatFastMode: tab.chatFastMode,
      ...(fork ? { fork } : {}),
      ...(importHistory ? { importHistory } : {})
    },
    hooks: {
      onHistory: (p, events) => {
        if (tab.proc !== p || tab.closed) return
        for (const event of events) commitHistory(tab, event)
      },
      onSpawned: (p) => {
        if (tab.proc !== p || tab.closed) return
        // The FIRST event of this process's contribution: lets the renderer
        // invalidate process-children resources (bg shells) of the previous one.
        routeHostEvent(tab, { kind: 'session-spawn', spawnId: p.spawnId })
        if (tab.terminalState === 'starting') transitionState(tab, 'idle')
      },
      onEvent: (p, event) => handleProcessEvent(tab, p, event),
      onExit: (p, code, signal) => handleProcessExit(tab, p, code, signal),
      onStartError: (p, err) => {
        tab.outbox.onProcessEnded(p.gen, { resend: false })
        if (tab.proc === p) failStart(tab, err)
      },
      onStale: (p, event) => {
        if (isStreamFragment(event.kind)) return
        diagnostic(
          tab,
          'info',
          'chat.stale_generation_event',
          `dropped ${event.kind} from a replaced or ended process`,
          {
            gen: p.gen,
            currentGen: tab.proc?.gen ?? null,
            kind: event.kind
          }
        )
      }
    }
  })
  proc.fork = fork
  tab.proc = proc
  // A written message can now go out as soon as the process is ready.
  void proc.readyPromise.then(
    () => {
      if (tab.proc === proc) tab.outbox.pump()
    },
    () => undefined
  )
  return proc
}

/**
 * Replace a tab's process: stop the current one (SIGTERM, wait; SIGKILL after
 * the grace; give up after a second grace — its output is dropped either way),
 * then start the next generation with `nextOpts`. The tab's history, outbox and
 * queue carry over; nothing is re-read from the DB. Messages the old process had
 * not confirmed are re-sent to the new one.
 *
 * No tab yet: hydrates one and starts it.
 */
export async function respawn(tabId: string, nextOpts: CreateChatOpts): Promise<ChatSessionInfo> {
  const tab = tabs.get(tabId)
  if (!tab || tab.closed) {
    await hydrateSession(nextOpts)
    return ensureSpawned(tabId)
  }
  await respawnTab(tab, nextOpts)
  return ensureSpawned(tabId)
}

async function respawnTab(
  tab: ChatTab,
  nextOpts: CreateChatOpts,
  {
    fresh = false,
    between
  }: {
    fresh?: boolean
    /** Runs once the old process is gone, before the next one starts. */
    between?: () => void
  } = {}
): Promise<void> {
  while (tab.respawning) await tab.respawning.catch(() => undefined)
  const run = (async (): Promise<void> => {
    const old = tab.proc
    if (old && !old.ended) {
      // From here on nothing it says counts; its exit is swallowed.
      old.replaced = true
      clearWatchdog(tab)
      const outcome = await old.stop(2000, 2000)
      if (outcome === 'abandoned') {
        diagnostic(
          tab,
          'warn',
          'chat.respawn_abandoned',
          'the replaced process never confirmed its exit',
          {
            gen: old.gen
          }
        )
      }
    }
    if (tab.closed) return
    between?.()
    applyRespawnOpts(tab, nextOpts, fresh)
    tab.proc = null
    await startProcess(tab)
  })()
  const settled = run.then(
    () => undefined,
    () => undefined
  )
  tab.respawning = settled
  try {
    await run
  } finally {
    if (tab.respawning === settled) tab.respawning = null
  }
}

/** Take a respawn's spawn settings; the tab's identity and history stay. */
function applyRespawnOpts(tab: ChatTab, next: CreateChatOpts, fresh: boolean): void {
  // Which conversation the next process runs:
  //   - `fresh` (a failed resume): a new one, new id;
  //   - the caller's stored id, when it has one;
  //   - else the tab's own conversation if a process already confirmed it — its
  //     id may not have reached the DB yet (written as it was seen), and
  //     starting over would drop the context (or re-use the id with
  //     `--session-id`, which the CLI refuses);
  //   - else the tab's id, still unused.
  let conversationId = next.conversationId
  if (fresh) {
    conversationId = null
    tab.sessionId = randomUUID()
    tab.sessionConfirmed = false
    tab.pendingFork = null
  } else if (tab.pendingFork) {
    // An unconfirmed fork is the tab's conversation (the caller's stored id is
    // still the original's): it forks again.
    conversationId = null
  } else if (conversationId) {
    tab.sessionId = conversationId
  } else if (tab.sessionConfirmed) {
    conversationId = tab.sessionId
  }
  tab.respawnOpts = {
    ...next,
    conversationId,
    // Never re-seed history on a respawn: the log is the tab's.
    initialBuffer: undefined,
    initialNextSeq: undefined
  }
  if (next.chatMode !== undefined) tab.chatMode = next.chatMode
  if (next.chatModel !== undefined) tab.chatModel = next.chatModel
  if (next.chatEffort !== undefined) tab.chatEffort = next.chatEffort
  if (next.chatCollaboration !== undefined) tab.chatCollaboration = next.chatCollaboration
  if (next.chatFastMode !== undefined) tab.chatFastMode = next.chatFastMode
  if (next.onPersistSessionId) tab.onPersistSessionId = next.onPersistSessionId
  if (next.onInvalidResume) tab.onInvalidResume = next.onInvalidResume
  if (next.conversationId) tab.retryScheduled = false
}

/**
 * Send a user message: record it, then hand it to the outbox, which writes it
 * once the agent is ready (starting one if needed) and tracks it until the agent
 * confirmed and answered it — or says why it failed. Idempotent by id: a known
 * id is retried if it failed, never sent twice.
 */
export function dispatchUserMessage(
  tabId: string,
  message: OutgoingUserMessage
): { id: string; state: OutboxState } {
  const tab = tabs.get(tabId)
  if (!tab || tab.closed) {
    throw new ChatTransportError(`No chat session for tab ${tabId}`)
  }
  const known = tab.outbox.state(message.id)
  if (known) {
    if (known === 'failed') tab.outbox.retry(message.id)
    return { id: message.id, state: tab.outbox.state(message.id) ?? known }
  }
  routeHostEvent(tab, {
    kind: 'user-message',
    id: message.id,
    text: userMessageText(message.content),
    content: message.content
  })
  const state = tab.outbox.accept(message)
  return { id: message.id, state }
}

/** Legacy text send (queue drain, tests): a message with a fresh id. False: no tab. */
export function sendUserMessage(tabId: string, text: string): boolean {
  const tab = tabs.get(tabId)
  if (!tab || tab.closed) return false
  dispatchUserMessage(tabId, { id: randomUUID(), content: [{ type: 'text', text }] })
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
  const proc = liveProcess(tabId)
  if (!proc || !proc.driver.sendToolResult) return false
  return proc.driver.sendToolResult(args)
}

function liveProcess(tabId: string): ChatProcess | null {
  const tab = tabs.get(tabId)
  if (!tab || tab.closed || tab.ended) return null
  const proc = tab.proc
  return proc && !proc.ended && !proc.replaced && proc.started ? proc : null
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
  const proc = liveProcess(tabId)
  if (!proc) return Promise.reject(new Error('no live session'))
  if (!proc.driver.applyControl) {
    return Promise.reject(new Error('driver has no control channel'))
  }
  // A 0-turn error after an interrupt is the interrupt, not a failed resume.
  if (request.subtype === 'interrupt') proc.interruptIssued = true
  return proc.driver.applyControl(request, timeoutMs)
}

/**
 * The output so far of a command the tab's agent runs as a task (plan 3.9),
 * from its live process: `gone` when there is none (the task died with a
 * replaced or ended process), `unsupported` when the provider reports no task
 * output (Codex — whose control channel would "succeed" with nothing).
 */
export function getCommandTaskOutput(tabId: string, taskId: string): Promise<CommandTaskOutput> {
  const proc = liveProcess(tabId)
  if (!proc) return Promise.resolve({ state: 'gone' })
  if (!proc.driver.commandTaskOutput) return Promise.resolve({ state: 'unsupported' })
  return proc.driver.commandTaskOutput(taskId)
}

/** Kill a running command task of the tab's live process. */
export function stopCommandTask(tabId: string, taskId: string): Promise<void> {
  const proc = liveProcess(tabId)
  if (!proc) return Promise.reject(new ChatTransportError('no live session'))
  if (!proc.driver.stopCommandTask) {
    return Promise.reject(new ChatTransportError('this agent cannot stop a command'))
  }
  return proc.driver.stopCommandTask(taskId)
}

/** Move a running foreground command of the tab's live process to the background. */
export function backgroundCommandTask(tabId: string, toolUseId: string): Promise<boolean> {
  const proc = liveProcess(tabId)
  if (!proc || !proc.driver.backgroundCommandTask) return Promise.resolve(false)
  return proc.driver.backgroundCommandTask(toolUseId)
}

/**
 * Mutate the in-memory `Session.chatMode`. Called after a successful
 * `set_permission_mode` control_request so `getSessionInfo` reflects the new
 * mode without waiting for a turn-init drift sync.
 */
export function updateSessionChatMode(tabId: string, mode: string | null): void {
  const tab = tabs.get(tabId)
  if (!tab) return
  tab.chatMode = mode
}

/**
 * Mutate the in-memory `Session.chatModel`. Called after a successful
 * `set_model` control_request so `getSessionInfo` reflects the new model
 * without waiting for a turn-init drift sync.
 */
export function updateSessionChatModel(tabId: string, model: string | null): void {
  const tab = tabs.get(tabId)
  if (!tab) return
  tab.chatModel = model
}

/**
 * Mutate the in-memory `Session.chatEffort`. Used by the pre-spawn fast path of
 * `chat:setEffort` so a skeleton session reflects the new value before the
 * next spawn picks it up via buildSpawnArgs.
 */
export function updateSessionChatEffort(tabId: string, effort: string | null): void {
  const tab = tabs.get(tabId)
  if (!tab) return
  tab.chatEffort = effort
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
  const tab = tabs.get(tabId)
  if (!tab) return
  tab.chatCollaboration = collaboration
}

/**
 * Mutate the in-memory `Session.chatFastMode`. Used by the pre-spawn fast path
 * of `chat:setFastMode` so a skeleton session reflects the new value before
 * the next spawn picks it up.
 */
export function updateSessionChatFastMode(tabId: string, fastMode: boolean): void {
  const tab = tabs.get(tabId)
  if (!tab) return
  tab.chatFastMode = fastMode
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
  args: { requestId: string; decision: PermissionDecision; optionId?: string }
): boolean {
  const proc = liveProcess(tabId)
  if (!proc || !proc.driver.respondPermission) return false
  return proc.driver.respondPermission(args)
}

/**
 * Persist an `interrupted` marker into the session's event log. Called by
 * `chat:interrupt` before kill+respawn so timeline replay sees a turn boundary
 * even though the original turn never produced a `result`. No-op if the
 * session is gone or already ended.
 */
export function recordInterrupted(tabId: string): void {
  const tab = tabs.get(tabId)
  if (!tab || tab.closed || tab.ended) return
  // Pre-spawn skeletons have no live turn to interrupt — skip emission. The
  // hydrate path already emits its own synthetic `interrupted` for unfinished tails.
  if (!tab.proc) return
  if (tab.proc && !tab.proc.ended) tab.proc.interruptIssued = true
  routeHostEvent(tab, { kind: 'interrupted' })
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
 * "Progress" includes live fragments, which are never in the saved history.
 */
export function popLastUserMessage(tabId: string): { popped: boolean; text: string | null } {
  const tab = tabs.get(tabId)
  if (!tab || tab.closed || tab.ended) return { popped: false, text: null }
  const popped = popTrailingUserMessage(tab)
  return popped ? { popped: true, text: popped.text } : { popped: false, text: null }
}

/** A message Stop took back. */
interface PoppedMessage {
  text: string
  id?: string
  content: UserContentBlock[]
}

function popTrailingUserMessage(tab: ChatTab): PoppedMessage | null {
  if (tab.turnProgress) return null
  let found: PoppedMessage | null = null
  const events = tab.log.events
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i].event
    if (e.kind === 'user-message') {
      // An imported message of the conversation's past is never taken back.
      if (e.history) return null
      found = {
        text: e.text,
        ...(e.id ? { id: e.id } : {}),
        // A row from before `content` existed: its text is the whole message.
        content: e.content ?? [{ type: 'text', text: e.text }]
      }
      break
    }
    if (e.kind === 'user-message-popped') return null
    if (isProgressEventKind(e.kind)) return null
    // Skip non-progress, non-user events (turn-init, error, unknown, compact-boundary, delivery).
  }
  if (found === null) return null
  // Only the message whose turn this is comes back: a follow-up sent while an
  // earlier one still runs is withdrawn by Stop instead (`stopTurn`).
  if (found.id) {
    const oldest = tab.outbox.oldestInFlight()
    if (oldest !== null && oldest !== found.id) return null
  }
  routeHostEvent(tab, {
    kind: 'user-message-popped',
    text: found.text,
    ...(found.id ? { id: found.id } : {})
  })
  if (found.id) tab.outbox.cancel(found.id)
  return found
}

/**
 * Claude Code already had this message — it received it before a restart, and
 * drops a uuid it has seen (chat-a check R2b) — so no turn runs for it. Close the
 * turn the write opened, and say so.
 */
function onAlreadyInConversation(tab: ChatTab, id: string): void {
  if (tab.closed) return
  routeHostEvent(tab, { kind: 'interrupted', reason: 'already-in-conversation' })
  routeHostEvent(tab, {
    kind: 'notice',
    id: randomUUID(),
    level: 'warning',
    code: 'already-in-conversation',
    text: 'Claude Code already had this message from before it restarted, so it did not run it again. A reply it gave then is not shown here.',
    detail: { messageId: id }
  })
  if (tab.outbox.inFlight() === 0) transitionState(tab, 'idle')
}

/** How long Stop waits for the CLI to acknowledge an interrupt before replacing the process. */
const STOP_INTERRUPT_TIMEOUT_MS = 3000
/** How long one of Stop's follow-up requests (withdraw, rewind) may take. */
const STOP_FOLLOW_UP_TIMEOUT_MS = 5000

export interface StopTurnResult extends StopResult {
  /** `interrupt`: the process stayed. `respawn`: it was replaced (the fallback). */
  via: 'interrupt' | 'respawn'
}

/** What Stop gives back: the popped message, or nothing. */
function stopResult(popped: PoppedMessage | null, via: StopTurnResult['via']): StopTurnResult {
  return popped
    ? { popped: true, text: popped.text, id: popped.id ?? null, content: popped.content, via }
    : { popped: false, text: null, id: null, content: null, via }
}

/**
 * Stop the running turn (Stop button / Esc, `chat.interrupt`).
 *
 * With `liveInterrupt` (Claude Code) the process stays: the CLI gets an
 * `interrupt` control request, withdraws its own pending prompts, and ends the
 * turn with an aborted result. Messages it holds queued are withdrawn
 * (`cancel_async_message`) — before the interrupt, and any it still reports
 * after — so Stop also stops what was waiting. Only when the interrupt is
 * refused or not acknowledged is the process replaced (today's path).
 *
 * `restorePrompt`: a turn with no output yet gives its message back (`text`) and
 * the CLI forgets it (`rewind_conversation`), so the timeline, the composer and
 * the conversation agree. Whatever that turn still says is dropped.
 *
 * Without `liveInterrupt` (Codex), or with no live process: the old path —
 * take the message back or mark the turn interrupted, then replace the process.
 */
export async function stopTurn(
  tabId: string,
  opts: {
    restorePrompt: boolean
    /** Spawn settings for the replacement, read only if one is needed. */
    respawnOpts: () => Promise<CreateChatOpts>
    interruptTimeoutMs?: number
  }
): Promise<StopTurnResult> {
  const tab = tabs.get(tabId)
  if (!tab || tab.closed) {
    // Nothing hydrated: there is no turn to stop; start a process, as before.
    await respawn(tabId, await opts.respawnOpts())
    return stopResult(null, 'respawn')
  }
  const caps = chatCapabilitiesForMode(tab.mode)
  const proc = liveProcess(tabId)
  const popped = opts.restorePrompt ? popTrailingUserMessage(tab) : null
  if (!popped) recordInterrupted(tabId)

  if (!proc || !caps.liveInterrupt || !proc.driver.applyControl) {
    await respawn(tabId, await opts.respawnOpts())
    if (popped?.id && caps.rewind) await forgetPopped(tab, popped.id)
    return stopResult(popped, 'respawn')
  }

  proc.interruptIssued = true
  if (popped) proc.discardTurn = true
  else tab.turnInterrupted = true
  // Messages the CLI holds queued would run right after the interrupt.
  for (const id of tab.outbox.heldByCli(proc.gen)) await withdrawQueued(tab, proc, id)

  let ack: unknown
  try {
    ack = await proc.driver.applyControl(
      { subtype: 'interrupt' },
      opts.interruptTimeoutMs ?? STOP_INTERRUPT_TIMEOUT_MS
    )
  } catch (err) {
    diagnostic(
      tab,
      'warn',
      'chat.interrupt_fallback',
      'interrupt not acknowledged; replacing the process',
      {
        error: toErrorMessage(err)
      }
    )
    await respawn(tabId, await opts.respawnOpts())
    if (popped?.id) await forgetPopped(tab, popped.id)
    return stopResult(popped, 'respawn')
  }

  let reinterrupt = false
  for (const id of stillQueued(ack)) {
    if (!(await withdrawQueued(tab, proc, id))) reinterrupt = true
  }
  if (reinterrupt && !proc.ended) {
    // One raced past the withdrawal and started: stop it too (once).
    await proc.driver
      .applyControl({ subtype: 'interrupt' }, STOP_FOLLOW_UP_TIMEOUT_MS)
      .catch(() => undefined)
  }
  if (popped?.id) await forgetPopped(tab, popped.id)
  return stopResult(popped, 'interrupt')
}

/** The ids an `interrupt` ack says the CLI still holds queued (`{still_queued}`). */
function stillQueued(ack: unknown): string[] {
  const queued = controlPayload(ack)?.still_queued
  return Array.isArray(queued) ? queued.filter((id): id is string => typeof id === 'string') : []
}

/** A control response's payload (`applyControl` resolves `{response: payload}`). */
function controlPayload(data: unknown): Record<string, unknown> | null {
  const response = (data as { response?: unknown } | null)?.response
  return response && typeof response === 'object' ? (response as Record<string, unknown>) : null
}

/** Withdraw one message the CLI holds queued. True when it was withdrawn. */
async function withdrawQueued(tab: ChatTab, proc: ChatProcess, id: string): Promise<boolean> {
  try {
    const res = await proc.driver.applyControl?.(
      { subtype: 'cancel_async_message', message_uuid: id },
      STOP_FOLLOW_UP_TIMEOUT_MS
    )
    if (controlPayload(res)?.cancelled !== true) return false
    tab.outbox.cancel(id)
    return true
  } catch (err) {
    diagnostic(tab, 'warn', 'chat.withdraw_failed', 'cancel_async_message failed', {
      error: toErrorMessage(err)
    })
    return false
  }
}

/**
 * The CLI forgets a message Stop gave back (it may have stored it). Its
 * `target_not_found` means it never had it — fine either way; anything else is
 * shown, since Claude may still remember a message the timeline no longer has.
 */
async function forgetPopped(tab: ChatTab, id: string): Promise<void> {
  const proc = liveProcess(tab.tabId)
  let problem: string | null = null
  if (!proc?.driver.applyControl) {
    problem = `${tab.backend.displayName} is not running`
  } else {
    try {
      const res = controlPayload(
        await proc.driver.applyControl(
          { subtype: 'rewind_conversation', target_message_uuid: id },
          STOP_FOLLOW_UP_TIMEOUT_MS
        )
      )
      if (res?.rewound !== true && res?.reason !== 'target_not_found') {
        problem = typeof res?.error === 'string' ? res.error : 'the rewind was refused'
      }
    } catch (err) {
      problem = toErrorMessage(err)
    }
  }
  if (problem === null || tab.closed) return
  routeHostEvent(tab, {
    kind: 'notice',
    id: randomUUID(),
    level: 'warning',
    code: 'stop-rewind-failed',
    text: `The stopped message is back in the message box, but ${tab.backend.displayName} may still remember it.`,
    detail: { messageId: id, error: problem }
  })
}

// ---- switching conversations (plan 3.6 Sessions picker, 3.10 hand-off) ----

/**
 * An event of the conversation's past (imported from the CLI's session file):
 * saved and shown like any other, but it is history — it drives no state, no
 * watchdog, no outbox, and claims no conversation id.
 */
function commitHistory(tab: ChatTab, event: AgentEvent): void {
  if (tab.closed) return
  const entry = tab.log.append(event)
  const { seq, at } = entry
  void tab.projection.then((p) => p?.apply(entry))
  deps.broadcastEvent(tab.tabId, event, seq, undefined, at)
  try {
    deps.persistEvent(tab.tabId, seq, event)
  } catch (err) {
    console.error('[chat-transport] persistEvent failed:', err)
  }
}

/**
 * Switch a tab to another conversation — the one write path for the Sessions
 * picker, the hand-off from the terminal and going back to a fork's original.
 * A live process is stopped first and its exit awaited (two processes never run
 * one conversation); then the `switched` marker, the imported history and any
 * notices go into the tab's log (it still owns every seq), and the tab runs
 * `conversationId` from now on. With `respawnOpts` the next process starts at
 * once (`--resume`); without, the first message starts it.
 */
export async function switchTabConversation(
  tabId: string,
  opts: {
    conversationId: string
    branch: AgentEvent
    history: AgentEvent[]
    notices: AgentEvent[]
    respawnOpts?: CreateChatOpts
    /** The history comes from the agent's CLI on its next start (Codex), not `history`. */
    historyFromAgent?: boolean
  }
): Promise<void> {
  const tab = requireTab(tabId)
  const record = (): void => {
    routeHostEvent(tab, opts.branch)
    for (const event of opts.history) commitHistory(tab, event)
    for (const notice of opts.notices) routeHostEvent(tab, notice)
    tab.pendingHistoryImport = opts.historyFromAgent === true
    tab.pendingFork = null
    tab.sessionId = opts.conversationId
    tab.sessionConfirmed = true
    tab.respawnOpts = { ...tab.respawnOpts, conversationId: opts.conversationId }
  }
  const live = tab.proc && !tab.proc.ended
  if (live || opts.respawnOpts) {
    await respawnTab(
      tab,
      { ...(opts.respawnOpts ?? tab.respawnOpts), conversationId: opts.conversationId },
      {
        between: record
      }
    )
    if (!opts.respawnOpts) await ensureSpawned(tabId)
    return
  }
  record()
}

/** This side of the never-two-processes guard (`live-conversations.ts`). */
registerConversationHolder('chat', {
  isLive: (taskId, conversationId) => {
    for (const tab of tabs.values()) {
      if (
        !tab.closed &&
        tab.taskId === taskId &&
        tab.sessionId === conversationId &&
        tab.proc &&
        !tab.proc.ended
      ) {
        return true
      }
    }
    return false
  },
  release: (taskId, conversationId) => releaseChatConversation(taskId, conversationId)
})

/**
 * The conversation a tab runs, once the CLI has it (a pending fork or a fresh
 * id nobody used yet has none to hand over).
 */
export function confirmedConversation(tabId: string): string | null {
  const tab = tabs.get(tabId)
  if (!tab || tab.closed || !tab.sessionConfirmed || tab.pendingFork) return null
  return tab.sessionId
}

/** How long a release waits for a stopped chat process to exit. */
const RELEASE_EXIT_TIMEOUT_MS = 5000

/**
 * The conversation moves to the terminal: every chat tab of this task running
 * it stops, and its exit is awaited — two processes never run one conversation
 * (plan 3.10). The tab goes (its history stays saved; it reloads on reopen).
 */
export async function releaseChatConversation(
  taskId: string,
  conversationId: string
): Promise<void> {
  const waits: Array<Promise<unknown>> = []
  for (const [tabId, tab] of [...tabs]) {
    if (tab.taskId !== taskId || tab.sessionId !== conversationId) continue
    const proc = tab.proc
    const flushed = removeSession(tabId)
    if (proc && !proc.ended) {
      waits.push(
        Promise.race([
          proc.exited,
          new Promise((r) => setTimeout(r, RELEASE_EXIT_TIMEOUT_MS).unref?.())
        ])
      )
    }
    waits.push(flushed)
  }
  await Promise.all(waits)
}

// ---- edit & resend, rewind, code rewind (plan 3.3) ----

/** How long a rewind request may take (it may restore many files). */
const REWIND_TIMEOUT_MS = 30_000

/**
 * Which messages the conversation still holds, oldest first: the tab's user
 * messages with an id, minus what Stop took back, what a rewind dropped, what a
 * fork left behind, and everything before a switch. A failed message never
 * reached it.
 */
function activeUserMessages(tab: ChatTab): Array<{ id: string; text: string }> {
  const active: Array<{ id: string; text: string }> = []
  // What the conversation held before the last fork (a refused fork restores it).
  let beforeFork: Array<{ id: string; text: string }> | null = null
  for (const { event: e } of tab.log.events) {
    if (e.kind === 'user-message' && e.id) {
      if (tab.outbox.state(e.id) !== 'failed') active.push({ id: e.id, text: e.text })
    } else if (e.kind === 'user-message-popped' && e.id) {
      const at = active.findIndex((m) => m.id === e.id)
      if (at >= 0) active.splice(at, 1)
    } else if (e.kind === 'conversation-branch') {
      const at = e.messageId ? active.findIndex((m) => m.id === e.messageId) : -1
      if (e.reason === 'switched') active.length = 0
      else if (e.reason === 'rewound' && at >= 0) active.length = at
      else if (e.reason === 'forked' && at >= 0) {
        beforeFork = active.slice()
        active.length = at + 1
      } else if (e.reason === 'fork-failed' && beforeFork) {
        active.splice(0, active.length, ...beforeFork)
        beforeFork = null
      }
    }
  }
  return active
}

/**
 * The user message a rewind acts on: `before` — the message itself (it and what
 * follows go); `after` — the next one (this message and its answer stay).
 */
function rewindTarget(tab: ChatTab, messageId: string, scope: RewindScope): string {
  const active = activeUserMessages(tab)
  const at = active.findIndex((m) => m.id === messageId)
  if (at < 0) {
    throw new ChatTransportError('That message is not in the conversation any more.')
  }
  if (scope === 'before') return messageId
  const next = active[at + 1]
  if (!next) throw new ChatTransportError('There is nothing after that message to rewind.')
  return next.id
}

/**
 * Where a fork from `messageId` ends: the last main-chain assistant record of
 * that message's turn (`--resume-session-at`). Null: the turn has no answer.
 */
function forkPoint(
  tab: ChatTab,
  messageId: string,
  opts: { anyAnswer?: boolean } = {}
): string | null {
  const events = tab.log.events
  let start = -1
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i].event
    if (e.kind === 'user-message' && e.id === messageId) {
      start = i
      break
    }
  }
  let at: string | null = null
  for (let i = start + 1; start >= 0 && i < events.length; i++) {
    const e = events[i].event
    if (e.kind === 'user-message' || e.kind === 'conversation-branch') break
    if (
      (e.kind === 'assistant-text' || e.kind === 'assistant-thinking' || e.kind === 'tool-call') &&
      (e.uuid || opts.anyAnswer) &&
      e.parentToolUseId == null
    ) {
      at = e.uuid ?? messageId
    }
  }
  return at
}

/**
 * Fork the conversation from a past message, in this tab (plan 3.3) — the TUI's
 * branch. The new conversation holds everything up to the end of that
 * message's turn: the CLI copies it (`--resume S --resume-session-at A
 * --fork-session --session-id N`) and never writes the original, which stays in
 * Sessions. A running turn is stopped first. What came after the message stays
 * in the timeline, folded behind the saved `forked` marker. The fork is the
 * tab's conversation at once; the task records it (`slay-spawned-fork`) when the
 * CLI reports it. A refused fork brings the tab back (`onForkFailure`).
 */
export async function forkTab(
  tabId: string,
  opts: { messageId: string; respawnOpts: () => Promise<CreateChatOpts> }
): Promise<{ conversationId: string; fromConversationId: string }> {
  const tab = requireTab(tabId)
  if (!activeUserMessages(tab).some((m) => m.id === opts.messageId)) {
    throw new ChatTransportError('That message is not in the conversation any more.')
  }
  if (turnInFlight(tab)) {
    await stopTurn(tabId, { restorePrompt: false, respawnOpts: opts.respawnOpts })
  }
  // A CLI forking at a user message (Codex: through its turn) needs only an answer.
  const at =
    tab.backend.forkAt === 'message'
      ? forkPoint(tab, opts.messageId, { anyAnswer: true }) && opts.messageId
      : forkPoint(tab, opts.messageId)
  if (!at)
    throw new ChatTransportError(
      `${tab.backend.displayName} has not answered that message: there is nothing to fork yet.`
    )
  if (tab.pendingFork || !tab.sessionConfirmed) {
    throw new ChatTransportError('Send a message in this conversation before forking it again.')
  }
  const from = tab.sessionId
  const id = randomUUID()
  const next = await opts.respawnOpts()
  await respawnTab(
    tab,
    { ...next, conversationId: null },
    {
      between: () => {
        tab.pendingFork = { fromSessionId: from, atMessageUuid: at }
        tab.sessionId = id
        tab.sessionConfirmed = false
        routeHostEvent(tab, {
          kind: 'conversation-branch',
          reason: 'forked',
          messageId: opts.messageId,
          conversationId: id,
          fromConversationId: from,
          atMessageUuid: at
        })
      }
    }
  )
  return { conversationId: id, fromConversationId: from }
}

/** A turn is running or parked on a prompt. */
function turnInFlight(tab: ChatTab): boolean {
  return tab.terminalState === 'running' || tab.pendingPrompts.size > 0
}

function requireTab(tabId: string): ChatTab {
  const tab = tabs.get(tabId)
  if (!tab || tab.closed) throw new ChatTransportError(`No chat session for tab ${tabId}`)
  return tab
}

/** The live process with a control channel, starting one if needed. */
async function controllableProcess(tab: ChatTab): Promise<ChatProcess> {
  await ensureSpawned(tab.tabId)
  const proc = liveProcess(tab.tabId)
  if (!proc?.driver.applyControl)
    throw new ChatTransportError(`${tab.backend.displayName} is not running.`)
  return proc
}

function toPreview(payload: Record<string, unknown> | null): RewindFilesPreview {
  const files = Array.isArray(payload?.filesChanged)
    ? payload.filesChanged.filter((f): f is string => typeof f === 'string')
    : []
  return {
    canRewind: payload?.canRewind === true,
    filesChanged: files,
    insertions: typeof payload?.insertions === 'number' ? payload.insertions : 0,
    deletions: typeof payload?.deletions === 'number' ? payload.deletions : 0,
    ...(typeof payload?.error === 'string' ? { error: payload.error } : {})
  }
}

/**
 * What restoring the files would change (`rewind_files` dry run) for a message:
 * `before` = to just before it, `after` = to just after its turn.
 */
export async function previewRewind(
  tabId: string,
  opts: { messageId: string; scope: RewindScope }
): Promise<RewindFilesPreview> {
  const tab = requireTab(tabId)
  const target = rewindTarget(tab, opts.messageId, opts.scope)
  const proc = await controllableProcess(tab)
  return toPreview(
    controlPayload(
      await proc.driver.applyControl!(
        { subtype: 'rewind_files', user_message_id: target, dry_run: true },
        REWIND_TIMEOUT_MS
      )
    )
  )
}

/**
 * Rewind the conversation and/or the files to a message (plan 3.3), live — the
 * process stays. `before` (edit & resend): the message and everything after it
 * go, its text comes back to edit. `after` (rewind to here): the message and its
 * answer stay, everything after goes. Files are restored first (the checkpoint
 * is keyed by the message the conversation is about to forget), then the
 * conversation. A running turn is stopped first. The timeline keeps everything,
 * folded behind the saved `conversation-branch` marker.
 */
export async function rewindTab(
  tabId: string,
  opts: {
    messageId: string
    scope: RewindScope
    conversation: boolean
    files: boolean
    respawnOpts: () => Promise<CreateChatOpts>
  }
): Promise<RewindResult> {
  const tab = requireTab(tabId)
  const target = rewindTarget(tab, opts.messageId, opts.scope)
  if (turnInFlight(tab)) {
    await stopTurn(tabId, { restorePrompt: false, respawnOpts: opts.respawnOpts })
  }
  let proc = await controllableProcess(tab)

  let files: RewindResult['files'] = null
  if (opts.files) {
    const preview = toPreview(
      controlPayload(
        await proc.driver.applyControl!(
          { subtype: 'rewind_files', user_message_id: target, dry_run: true },
          REWIND_TIMEOUT_MS
        )
      )
    )
    if (!preview.canRewind) {
      files = { restored: false, filesChanged: [], error: preview.error ?? 'No file checkpoint.' }
    } else {
      const done = controlPayload(
        await proc.driver.applyControl!(
          { subtype: 'rewind_files', user_message_id: target },
          REWIND_TIMEOUT_MS
        )
      )
      files =
        done?.canRewind === true
          ? { restored: true, filesChanged: preview.filesChanged }
          : {
              restored: false,
              filesChanged: [],
              error: typeof done?.error === 'string' ? done.error : 'The files were not restored.'
            }
    }
  }

  let prefillText: string | null = null
  if (opts.conversation) {
    proc = await controllableProcess(tab)
    const done = controlPayload(
      await proc.driver.applyControl!(
        { subtype: 'rewind_conversation', target_message_uuid: target },
        REWIND_TIMEOUT_MS
      )
    )
    if (done?.rewound !== true) {
      throw new ChatTransportError(
        `${tab.backend.displayName} could not rewind the conversation: ${typeof done?.error === 'string' ? done.error : 'refused'}`
      )
    }
    if (opts.scope === 'before' && typeof done.prefillText === 'string')
      prefillText = done.prefillText
    routeHostEvent(tab, { kind: 'conversation-branch', reason: 'rewound', messageId: target })
  }
  if (files?.restored) {
    const n = files.filesChanged.length
    routeHostEvent(tab, {
      kind: 'notice',
      id: randomUUID(),
      level: 'info',
      code: 'files-rewound',
      text: `Restored ${n} ${n === 1 ? 'file' : 'files'} from Claude Code's checkpoints. Changes made by shell commands are not restored.`,
      detail: { files: files.filesChanged }
    })
  }
  return { prefillText, files }
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
  // A tool call after the last turn end is an unfinished turn — unless it is
  // imported history (its message is marked `history`, or it follows a switch).
  let sawToolCall = false
  for (let i = buffer.length - 1; i >= 0; i--) {
    const e = buffer[i].event
    const k = e.kind
    if (
      k === 'result' ||
      k === 'process-exit' ||
      k === 'interrupted' ||
      k === 'user-message-popped'
    ) {
      return sawToolCall
    }
    if (k === 'conversation-branch') return false
    if (k === 'user-message') return !e.history
    if (k === 'tool-call') sawToolCall = true
  }
  return sawToolCall
}

/** The CLI's end of a turn the user interrupted (Stop, or the TUI's plain "No"). */
function isAbortedResult(event: ResultEvent): boolean {
  return typeof event.terminalReason === 'string' && event.terminalReason.startsWith('aborted')
}

function isProgressEventKind(kind: AgentEvent['kind']): boolean {
  switch (kind) {
    case 'assistant-text':
    case 'assistant-thinking':
    case 'tool-call':
    case 'tool-result':
    case 'result':
    case 'sub-agent':
    case 'command-task':
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
  const tab = tabs.get(tabId)
  if (!tab) return
  if (tab.ended) return
  const proc = tab.proc
  // Pre-spawn skeleton (no process): mark ended so subsequent operations short-
  // circuit, but no process to signal.
  if (!proc || proc.ended) {
    tab.ended = true
    return
  }
  proc.kill('SIGTERM')
  const t = setTimeout(() => {
    if (!proc.ended) proc.kill('SIGKILL')
  }, 2000)
  t.unref?.()
}

/**
 * Remove the session entirely (tab close, reset). Its process stops (nothing it
 * still says counts); the returned promise resolves once the tab's last events
 * are written, and a later hydrate of the same tab waits for that.
 */
export function removeSession(tabId: string): Promise<void> {
  const tab = tabs.get(tabId)
  if (!tab) return closing.get(tabId) ?? Promise.resolve()
  tabs.delete(tabId)
  tab.closed = true
  clearWatchdog(tab)
  tab.outbox.dispose()
  const proc = tab.proc
  if (proc && !proc.ended) {
    proc.replaced = true
    proc.kill('SIGTERM')
    const t = setTimeout(() => {
      if (!proc.ended) proc.kill('SIGKILL')
    }, 2000)
    t.unref?.()
  }
  const flushed = Promise.all([
    tab.log.flush(),
    tab.projection.then((p) => p?.close()).catch(() => undefined)
  ])
    .then(() => undefined)
    .finally(() => {
      if (closing.get(tabId) === flushed) closing.delete(tabId)
    })
  closing.set(tabId, flushed)
  return flushed
}

/** A tab's projection, from its checkpoint or rebuilt from `history` (null: none). */
function openProjection(
  tabId: string,
  mode: string,
  history: readonly BufferedEvent[]
): Promise<TimelineProjection | null> {
  const store = deps.timelineStore?.(tabId)
  if (!store) return Promise.resolve(null)
  return TimelineProjection.open({
    store,
    history,
    agentStartedTurns: chatCapabilitiesForMode(mode).agentStartedTurns
  }).catch((err: unknown) => {
    console.error(`[chat-transport] timeline projection of ${tabId} failed to open:`, err)
    return null
  })
}

/**
 * How a client opens a tab: `paged` — the projection's snapshot (state as of
 * `snapshot.seq`, its tail's rows; older rows load by page), the saved events
 * after it, and what streams right now; `full` — replay every event
 * (`getReplay`): no projection, or the client's reducer is another version.
 */
export type ChatTimelineOpenResult =
  | {
      kind: 'paged'
      snapshot: TimelineOpen
      events: BufferedEvent[]
      live: ChatReplay['live']
    }
  | { kind: 'full' }

export async function openTimeline(
  tabId: string,
  clientVersion: string
): Promise<ChatTimelineOpenResult> {
  const tab = tabs.get(tabId)
  if (!tab || clientVersion !== TIMELINE_PROJECTION_VERSION) return { kind: 'full' }
  const projection = await tab.projection
  if (!projection?.usable) return { kind: 'full' }
  let snapshot: TimelineOpen
  try {
    snapshot = await projection.openSnapshot()
  } catch {
    return { kind: 'full' }
  }
  // Events saved while the snapshot was taken; the live part follows the newest.
  const events = await tab.log.readSince(snapshot.seq)
  return {
    kind: 'paged',
    snapshot,
    events,
    live: { afterSeq: tab.log.lastSeq, liveSeq: tab.liveSeq, events: tab.splitter.snapshot() }
  }
}

/** Rows of sealed pages as of a client's newest event (`expired`: open again). */
export async function timelinePages(
  tabId: string,
  pages: number[],
  asOfSeq: number,
  epoch: number
): Promise<TimelinePagesResult> {
  const projection = await tabs.get(tabId)?.projection
  if (!projection) return { expired: true }
  return projection.pagesAsOf(pages, asOfSeq, epoch)
}

/** Sealed pages that may hold `query` (the client checks the rows it loads). */
export async function searchTimeline(tabId: string, query: string): Promise<number[]> {
  const projection = await tabs.get(tabId)?.projection
  return projection ? projection.searchPages(query) : []
}

/** The CACHED saved events after `afterSeq` (the newest ones; in-process checks). */
export function getEventBufferSince(tabId: string, afterSeq: number): BufferedEvent[] {
  const tab = tabs.get(tabId)
  if (!tab) return []
  return tab.log.since(afterSeq)
}

/** EVERY saved event after `afterSeq`: what left the cache is read back from the store. */
export async function readEventsSince(tabId: string, afterSeq: number): Promise<BufferedEvent[]> {
  const tab = tabs.get(tabId)
  if (!tab) return []
  return tab.log.readSince(afterSeq)
}

/** What a client needs to (re)draw a tab: its saved events, plus what is streaming right now. */
export interface ChatReplay {
  events: BufferedEvent[]
  live: {
    /** The saved seq these live events follow. */
    afterSeq: number
    /** The tab's live counter at this snapshot; later live events are newer. */
    liveSeq: number
    events: AgentEvent[]
  }
}

/**
 * One consistent snapshot: EVERY saved event after `afterSeq` (the history
 * older than the in-memory cache is read back from the store), and the blocks
 * still streaming (live-only, so not in the history) — a reload mid-reply keeps
 * the partial text. The live part is taken in the same tick the saved events
 * end, so it follows exactly the newest of them.
 */
export async function getReplay(tabId: string, afterSeq: number): Promise<ChatReplay> {
  const tab = tabs.get(tabId)
  if (!tab) return { events: [], live: { afterSeq: -1, liveSeq: 0, events: [] } }
  const events = await tab.log.readSince(afterSeq)
  return {
    events,
    live: { afterSeq: tab.log.lastSeq, liveSeq: tab.liveSeq, events: tab.splitter.snapshot() }
  }
}

export function getSessionInfo(tabId: string): ChatSessionInfo | null {
  const tab = tabs.get(tabId)
  return tab ? toInfo(tab) : null
}

function toInfo(tab: ChatTab): ChatSessionInfo {
  return {
    sessionId: tab.sessionId,
    tabId: tab.tabId,
    taskId: tab.taskId,
    mode: tab.mode,
    cwd: tab.cwd,
    pid: tab.proc && !tab.proc.ended ? tab.proc.pid : null,
    startedAt: tab.startedAt,
    ended: tab.ended,
    chatMode: tab.chatMode,
    chatModel: tab.chatModel,
    chatEffort: tab.chatEffort,
    chatCollaboration: tab.chatCollaboration,
    chatFastMode: tab.chatFastMode
  }
}

/** Kill all sessions (app shutdown). */
export function killAll(): void {
  for (const tabId of tabs.keys()) kill(tabId)
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function forceFinalizeForShutdown(tab: ChatTab): void {
  clearWatchdog(tab)
  tab.ended = true
  const proc = tab.proc
  if (proc && !proc.ended) {
    proc.replaced = true
    proc.reap(null, 'SIGKILL')
  }
  transitionState(tab, 'dead')
  clearSessionUserInputMark(stateKey(tab))
}

function shutdownSession(
  tab: ChatTab,
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
    const proc = tab.proc
    const id = tab.tabId
    if (tab.ended || !proc || proc.ended) {
      forceFinalizeForShutdown(tab)
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
    }
    const settle = (timedOut: boolean): void => {
      if (settled) return
      settled = true
      cleanup()
      if (timedOut) forceFinalizeForShutdown(tab)
      resolve({ id, exited: !timedOut, killed, timedOut, errors })
    }
    const recordError = (phase: string, err: unknown): void => {
      errors.push({ id, phase, message: toErrorMessage(err) })
    }
    void proc.exited.then(() => settle(false))
    clearWatchdog(tab)
    try {
      proc.handle.kill('SIGTERM')
    } catch (err) {
      recordError('sigterm', err)
    }
    termTimer = setTimeout(() => {
      killed = true
      try {
        proc.handle.kill('SIGKILL')
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
  const targets = Array.from(tabs.values()).filter((tab) => !tab.ended)
  const results = await Promise.all(targets.map((tab) => shutdownSession(tab, opts)))
  // Everything said before quitting is on disk before the process goes.
  await Promise.all([
    ...Array.from(tabs.values()).map((tab) => tab.log.flush()),
    ...closing.values()
  ])
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
  for (const [tabId, tab] of tabs) {
    if (tab.taskId === taskId && !tab.ended) kill(tabId)
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
  for (const tab of tabs.values()) {
    if (tab.ended) continue
    // Skip lazy hydrate-only skeletons — they advertise no live process.
    if (tab.terminalState === 'not-spawned') continue
    result.push({
      sessionId: stateKey(tab),
      taskId: tab.taskId,
      mode: tab.mode,
      lastOutputTime: tab.lastOutputTime,
      state: tab.terminalState
    })
  }
  return result
}

/** Look up live state by broadcast-format sessionId (`${taskId}:${tabId}`). */
export function getChatSessionState(sessionId: string): ChatTerminalState | null {
  for (const tab of tabs.values()) {
    if (tab.ended) continue
    if (tab.terminalState === 'not-spawned') continue
    if (stateKey(tab) === sessionId) return tab.terminalState
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
  for (const tab of tabs.values()) {
    clearWatchdog(tab)
    tab.outbox.dispose()
    tab.closed = true
  }
  tabs.clear()
  closing.clear()
  inFlightSpawns.clear()
  inFlightHydrates.clear()
  isShuttingDown = false
}

/**
 * Test-only: the OS subprocess for a tab. A real `child_process` emits `spawn`
 * once the kernel reports the pid; tests drive a fake child and need this
 * handle to fire `spawn` themselves (which is what triggers `driver.start`).
 */
export function __getSessionChildForTests(tabId: string): ChildProcess | null {
  return tabs.get(tabId)?.rawChild ?? null
}

/** Test-only: where a message is in the tab's outbox (null: unknown id / no tab). */
export function __getOutboxStateForTests(tabId: string, id: string): OutboxState | null {
  return tabs.get(tabId)?.outbox.state(id) ?? null
}

/** Test-only: the tab's current process generation (0 = never spawned). */
export function __getGenerationForTests(tabId: string): number {
  return tabs.get(tabId)?.gen ?? 0
}
