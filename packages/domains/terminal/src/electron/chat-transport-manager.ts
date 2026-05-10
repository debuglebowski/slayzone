import { spawn as realSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import readline from 'node:readline'
import type { AgentEvent } from '../shared/agent-events'
import type { ChatSessionStateEntry } from '../shared/types'
import type { AgentAdapter } from '../server/agents/types'
import { getAdapter } from '../server/agents/registry'
import { whichBinary as realWhichBinary } from '../server/shell-env'
import type { BufferedEvent } from '../server/chat-events-store'
import type { ChatMode } from '../shared/chat-mode'
import type { ChatModel } from '../shared/chat-model'
import type { ChatEffort } from '../shared/chat-effort'
import { markSessionUserInput, clearSessionUserInputMark } from './user-input-tracker'

export { markSessionUserInput }
export type { BufferedEvent } from '../server/chat-events-store'

export type ChatTerminalState = 'starting' | 'running' | 'idle' | 'error' | 'dead'

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
  broadcastStateChange: (sessionId: string, newState: ChatTerminalState, oldState: ChatTerminalState) => void
  /**
   * Notify main-process global state listeners (e.g. task-automation). Default
   * no-op. chat-handlers wires this to pty-manager's listener set so chat
   * activity drives the same auto-status rules as PTY sessions.
   */
  onStateChange?: (sessionId: string, newState: ChatTerminalState, oldState: ChatTerminalState) => void
  /**
   * Called for every event appended to a session's buffer. Default no-op.
   * chat-handlers wires this to persist events to SQLite so chat history
   * survives full Electron app reload.
   */
  persistEvent: (tabId: string, seq: number, event: AgentEvent) => void
}

import { EventEmitter } from 'node:events'

/** Unified chat event emitter — replaces window.webContents.send broadcasts. */
export const chatEvents = new EventEmitter() as EventEmitter & {
  on(event: 'event', listener: (tabId: string, agentEvent: AgentEvent, seq: number) => void): EventEmitter
  on(event: 'exit', listener: (tabId: string, sessionId: string, code: number | null, signal: NodeJS.Signals | null) => void): EventEmitter
  on(event: 'state-change', listener: (sessionId: string, newState: ChatTerminalState, oldState: ChatTerminalState) => void): EventEmitter
  off(event: string, listener: (...args: unknown[]) => void): EventEmitter
}

const defaultDeps: TransportDeps = {
  spawn: realSpawn,
  whichBinary: realWhichBinary,
  broadcastEvent: (tabId, event, seq) => {
    chatEvents.emit('event', tabId, event, seq)
  },
  broadcastExit: (tabId, sessionId, code, signal) => {
    chatEvents.emit('exit', tabId, sessionId, code, signal)
  },
  broadcastStateChange: (sessionId, newState, oldState) => {
    chatEvents.emit('state-change', sessionId, newState, oldState)
  },
  persistEvent: () => {
    // No-op default: persistence is wired in main via configureTransport().
  },
}

let deps: TransportDeps = defaultDeps

export function setTransportDepsForTests(override: Partial<TransportDeps>): void {
  deps = { ...defaultDeps, ...override }
}

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
  chatMode?: ChatMode | null
  /** Resolved chat model alias this session was spawned with. */
  chatModel?: ChatModel | null
  /** Resolved reasoning effort this session was spawned with. `null` = inherit. */
  chatEffort?: ChatEffort | null
}

interface PendingControl {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
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
  adapter: AgentAdapter
  child: ChildProcess
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
  chatMode: ChatMode | null
  /** Resolved chat model alias this session was spawned with. */
  chatModel: ChatModel | null
  /** Resolved reasoning effort this session was spawned with. */
  chatEffort: ChatEffort | null
  /**
   * In-flight `control_request` promises, keyed by request_id. Transport
   * resolves on matching `control_response` from the adapter. Cleared on
   * session end / process exit (any pending promises reject).
   */
  pendingControl: Map<string, PendingControl>
  /** Monotonic counter for generating unique request_ids per session. */
  controlReqCounter: number
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
}

const MAX_BUFFER_EVENTS = 2000
const STDERR_FLUSH_INTERVAL_MS = 100

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

function transitionState(session: Session, next: ChatTerminalState): void {
  if (session.terminalState === next) return
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
  if (event.kind === 'user-message' || event.kind === 'turn-init' || event.kind === 'tool-call') {
    transitionState(session, 'running')
  } else if (event.kind === 'result') {
    transitionState(session, event.isError ? 'error' : 'idle')
  } else if (event.kind === 'process-exit') {
    transitionState(session, 'dead')
  }

  // Mark session as healthy once we see any real content.
  if (
    event.kind === 'assistant-text' ||
    event.kind === 'tool-call' ||
    event.kind === 'result' && !event.isError
  ) {
    session.sawHealthyTurn = true
  }

  // Surface discovered session id for persistence (resume-on-reopen).
  const extracted = session.adapter.extractSessionId(event)
  if (extracted && session.onPersistSessionId) {
    session.onPersistSessionId(extracted)
  }
}

function handleEvent(session: Session, event: AgentEvent): void {
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
    if (!session.ended) {
      session.child.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 2000)
        session.child.once('exit', () => {
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
  // Remove before recreate so createChat treats tabId as fresh.
  sessions.delete(session.tabId)
  const nextOpts: CreateChatOpts = {
    ...session.respawnOpts,
    conversationId: null,
    // Don't loop: disable retry on the second attempt.
    autoRetryOnInvalidResume: false,
    initialBuffer: carriedBuffer,
    initialNextSeq: carriedNextSeq,
  }
  try {
    await createChat(nextOpts)
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
   * Resolved chat permission mode this spawn corresponds to. Stored on the
   * Session and surfaced via ChatSessionInfo. When null, adapter doesn't
   * use a permission-mode concept (non-claude agents).
   */
  chatMode?: ChatMode | null
  /** Resolved chat model alias for the spawn (claude --model). */
  chatModel?: ChatModel | null
  /** Resolved reasoning effort for the spawn (claude --effort). */
  chatEffort?: ChatEffort | null
}

export async function createChat(opts: CreateChatOpts): Promise<ChatSessionInfo> {
  // Refuse duplicate sessions for one tab.
  const existing = sessions.get(opts.tabId)
  if (existing && !existing.ended) {
    // Invariant: a tabId must only ever back ONE (taskId, cwd, mode) tuple. If the
    // caller asks to create a chat with the same tabId but a different identity, the
    // prior session is a zombie (e.g. tab was closed without chat:remove). Returning
    // it would stream another task's events into the new panel — exactly the symptom
    // of the cross-task chat leak. Tear it down and spawn fresh.
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
        existing.child.kill('SIGTERM')
      } catch {
        /* already dead */
      }
      sessions.delete(opts.tabId)
      // Fall through to fresh spawn below.
    } else {
      return toInfo(existing)
    }
  }

  const adapter = getAdapter(opts.mode)
  if (!adapter) {
    throw new ChatTransportError(`No agent adapter registered for mode "${opts.mode}"`)
  }

  const binary = await deps.whichBinary(adapter.binaryName)
  if (!binary) {
    throw new ChatTransportError(
      `Binary "${adapter.binaryName}" not found on PATH. Install it or fix your shell's PATH.`
    )
  }

  const sessionId = opts.conversationId || randomUUID()
  const { args } = adapter.buildSpawnArgs({
    sessionId,
    resume: Boolean(opts.conversationId),
    cwd: opts.cwd,
    providerFlags: opts.providerFlags,
  })

  const child = deps.spawn(binary, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  })

  // Seed buffer/seq from persisted history when chat-handlers passed it in.
  // Cap seeded buffer at MAX_BUFFER_EVENTS to mirror the in-memory invariant.
  const seededBuffer: BufferedEvent[] = opts.initialBuffer
    ? opts.initialBuffer.slice(-MAX_BUFFER_EVENTS)
    : []
  const seededNextSeq =
    opts.initialNextSeq ??
    (seededBuffer.length > 0 ? seededBuffer[seededBuffer.length - 1].seq + 1 : 0)

  const session: Session = {
    sessionId,
    spawnId: randomUUID(),
    tabId: opts.tabId,
    taskId: opts.taskId,
    mode: opts.mode,
    cwd: opts.cwd,
    adapter,
    child,
    buffer: seededBuffer,
    nextSeq: seededNextSeq,
    ended: false,
    startedAt: new Date().toISOString(),
    lastOutputTime: Date.now(),
    terminalState: 'starting',
    usedResume: Boolean(opts.conversationId),
    sawHealthyTurn: false,
    retryScheduled: false,
    respawnOpts: opts,
    chatMode: opts.chatMode ?? null,
    chatModel: opts.chatModel ?? null,
    chatEffort: opts.chatEffort ?? null,
    pendingControl: new Map(),
    controlReqCounter: 0,
    onPersistSessionId: opts.onPersistSessionId,
    onInvalidResume: opts.onInvalidResume,
    staged: [],
    flushingStaged: false,
  }
  sessions.set(opts.tabId, session)

  // Restored history with an unfinished turn → emit synthetic `interrupted` so
  // the renderer reducer rebalances userMessagesSent/resultCount. Otherwise the
  // tab badge (idle, freshly spawned) and the chat panel's inFlight (true,
  // counting stale persisted user-messages without matching results) drift
  // apart. `interrupted` is not a state-transition trigger in handleEvent, so
  // emitting it here keeps `terminalState='starting'` until the spawn handler
  // moves it to idle.
  if (tailIsUnfinishedTurn(seededBuffer)) {
    // Synthetic restore-time signal — describes the SEEDED buffer, not the
    // current spawn. Commit directly so it's broadcast immediately even when
    // the spawn used --resume (and would otherwise stage in the tentative
    // window). Renderer reducer relies on this to balance counters.
    commitEvent(session, { kind: 'interrupted' })
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
  })

  // --- stdout: readline buffers partial lines for us ---
  const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity })
  rl.on('line', (line) => {
    const ev = adapter.parseLine(line)
    if (!ev) return
    // Control responses route to the pending sender promise — they're transport
    // plumbing, not chat timeline events. Skip broadcast/persist/buffer.
    if (ev.kind === 'control-response') {
      const pending = session.pendingControl.get(ev.requestId)
      if (pending) {
        clearTimeout(pending.timer)
        session.pendingControl.delete(ev.requestId)
        if (ev.isError) pending.reject(new Error(ev.error ?? 'control_request failed'))
        else pending.resolve(ev.data)
      }
      return
    }
    // Plan-mode `ExitPlanMode` arrives via stdio permission-prompt because we
    // pass `--permission-prompt-tool stdio` (claude-code-adapter.ts). The
    // renderer's footer flow ("Approve & exit plan") is keyed off the SDK's
    // `result.permissionDenials` — but the SDK only emits that AFTER receiving
    // a control_response. Without an answer here the SDK blocks indefinitely
    // and the chat sticks in `inFlight` with a "ExitPlanMode…" indicator.
    // Auto-deny so the SDK delivers tool_result + result-with-denial; the
    // existing renderer footer handles user approval (mode flip + re-send).
    if (
      ev.kind === 'permission-request' &&
      ev.toolName === 'ExitPlanMode' &&
      session.adapter.serializeControlResponse
    ) {
      const line = session.adapter.serializeControlResponse({
        requestId: ev.requestId,
        response: { behavior: 'deny', message: 'Plan mode requires explicit approval' },
      })
      if (line != null) {
        try {
          session.child.stdin?.write(line + '\n')
        } catch {
          /* best-effort; SDK timeout will surface via process exit */
        }
      }
      return
    }
    if (ev.kind === 'unknown' && ev.reason === 'unknown-type') {
      // Surface unknown top-level types once, tagged for log filtering.
      const raw = ev.raw as { type?: string } | null
      const t = raw?.type ?? '<no-type>'
      console.warn(`[chat-parser] unknown event type=${t}`)
    }
    handleEvent(session, ev)
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
    if (stderrTimer) {
      clearTimeout(stderrTimer)
      flushStderr()
    }
    session.ended = true
    // Reject any in-flight control_request promises so callers don't hang.
    for (const [id, pending] of session.pendingControl) {
      clearTimeout(pending.timer)
      pending.reject(new Error('session ended before control_response'))
      session.pendingControl.delete(id)
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
      detail: { name: err.name },
    })
  })

  return toInfo(session)
}

export function sendUserMessage(tabId: string, text: string): boolean {
  const session = sessions.get(tabId)
  if (!session || session.ended) return false
  const line = session.adapter.serializeUserMessage(text, session.sessionId)
  session.child.stdin?.write(line + '\n')
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
 * gone or the adapter lacks a structured-input channel — caller falls back
 * to `sendUserMessage`.
 */
export function sendToolResult(
  tabId: string,
  args: { toolUseId: string; content: string; isError?: boolean }
): boolean {
  const session = sessions.get(tabId)
  if (!session || session.ended) return false
  if (!session.adapter.serializeToolResult) return false
  const line = session.adapter.serializeToolResult({
    toolUseId: args.toolUseId,
    content: args.content,
    isError: args.isError,
    sessionId: session.sessionId,
  })
  if (line == null) return false
  session.child.stdin?.write(line + '\n')
  return true
}

/**
 * Send a `control_request` over stdin and resolve when the matching
 * `control_response` arrives (correlated by `request_id`). Rejects on adapter
 * lacking a control channel, on timeout, on response `subtype:'error'`, or on
 * session exit before a response arrives. Used to flip permission mode /
 * model / interrupt without restarting the subprocess.
 */
export function sendControlRequest(
  tabId: string,
  request: Record<string, unknown>,
  timeoutMs = 30_000
): Promise<unknown> {
  const session = sessions.get(tabId)
  if (!session || session.ended) {
    return Promise.reject(new Error('no live session'))
  }
  if (!session.adapter.serializeControlRequest) {
    return Promise.reject(new Error('adapter has no control channel'))
  }
  session.controlReqCounter++
  const requestId = `req_${session.controlReqCounter}_${Date.now().toString(36)}`
  const line = session.adapter.serializeControlRequest({ requestId, request })
  if (line == null) {
    return Promise.reject(new Error('adapter refused to serialize control_request'))
  }
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pendingControl.delete(requestId)
      reject(new Error(`control_request timeout after ${timeoutMs}ms`))
    }, timeoutMs)
    session.pendingControl.set(requestId, { resolve, reject, timer })
    try {
      session.child.stdin?.write(line + '\n')
    } catch (err) {
      clearTimeout(timer)
      session.pendingControl.delete(requestId)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

/**
 * Mutate the in-memory `Session.chatMode`. Called after a successful
 * `set_permission_mode` control_request so `getSessionInfo` reflects the new
 * mode without waiting for a turn-init drift sync.
 */
export function updateSessionChatMode(tabId: string, mode: ChatMode | null): void {
  const session = sessions.get(tabId)
  if (!session) return
  session.chatMode = mode
}

/**
 * Mutate the in-memory `Session.chatModel`. Called after a successful
 * `set_model` control_request so `getSessionInfo` reflects the new model
 * without waiting for a turn-init drift sync.
 */
export function updateSessionChatModel(tabId: string, model: ChatModel | null): void {
  const session = sessions.get(tabId)
  if (!session) return
  session.chatModel = model
}

/**
 * Reply to an inbound `control_request` (e.g. `subtype:'can_use_tool'` from
 * `--permission-prompt-tool stdio`). The renderer has surfaced the prompt
 * to the user and gathered their decision; this writes the success/error
 * `control_response` on stdin so the CLI unblocks the tool. Returns false
 * when session/adapter can't carry the reply — caller handles fallback.
 */
export function respondToPermissionRequest(
  tabId: string,
  args: {
    requestId: string
    decision:
      | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
      | { behavior: 'deny'; message: string; interrupt?: boolean }
  }
): boolean {
  const session = sessions.get(tabId)
  if (!session || session.ended) return false
  if (!session.adapter.serializeControlResponse) return false
  const line = session.adapter.serializeControlResponse({
    requestId: args.requestId,
    response: args.decision as unknown as Record<string, unknown>,
  })
  if (line == null) return false
  try {
    session.child.stdin?.write(line + '\n')
    return true
  } catch {
    return false
  }
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
 * stateful event is a turn-starter (user-message/turn-init/tool-call) with
 * no subsequent terminal marker (result/process-exit/interrupted/
 * user-message-popped). Used by createChat to keep the renderer's
 * userMessagesSent/resultCount balance honest after a restore: without a
 * synthetic interrupted, inFlight would stay true forever even though the
 * fresh subprocess (post --resume) sits idle waiting for input.
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
    if (k === 'user-message' || k === 'turn-init' || k === 'tool-call') {
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
      return true
    default:
      return false
  }
}

export function kill(tabId: string): void {
  const session = sessions.get(tabId)
  if (!session) return
  if (session.ended) return
  try {
    session.child.kill('SIGTERM')
  } catch {
    // process may already be gone
  }
  setTimeout(() => {
    if (!session.ended) {
      try {
        session.child.kill('SIGKILL')
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
  if (!session.ended) kill(tabId)
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
    pid: session.child.pid ?? null,
    startedAt: session.startedAt,
    ended: session.ended,
    chatMode: session.chatMode,
    chatModel: session.chatModel,
    chatEffort: session.chatEffort,
  }
}

/** Kill all sessions (app shutdown). */
export function killAll(): void {
  for (const tabId of sessions.keys()) kill(tabId)
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
    result.push({
      sessionId: `${session.taskId}:${session.tabId}`,
      taskId: session.taskId,
      mode: session.mode,
      lastOutputTime: session.lastOutputTime,
      state: session.terminalState,
    })
  }
  return result
}

/** Look up live state by broadcast-format sessionId (`${taskId}:${tabId}`). */
export function getChatSessionState(sessionId: string): ChatTerminalState | null {
  for (const session of sessions.values()) {
    if (session.ended) continue
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
  sessions.clear()
}
