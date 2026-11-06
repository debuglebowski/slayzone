/**
 * A scriptable stand-in for the hub's chat runtime (`RestApiDeps.chat`), for tests
 * of the `/api/chat/*` + `/api/agent/*` routes and of `slay chat` / `slay agent`
 * against them. Test-only: nothing in production imports it.
 *
 * Tasks listed in `ptyTasks` resolve as terminal agents (`kind: 'pty'`); every other
 * task as claude-chat on its main tab.
 */
import { TypedEmitter } from '@slayzone/platform/events'
import {
  chatSavedSummary,
  type AgentEvent,
  type ChatSavedSummary,
  type ChatTurnStatus,
  type TerminalState
} from '@slayzone/terminal-contracts'
import type { ChatAccess } from '../types'

export interface FakeChat {
  chat: ChatAccess
  /** Every recorded op call: [name, ...args]. */
  calls: unknown[][]
  /** What `getTurnStatus` answers (null = no session on the computer). */
  status: ChatTurnStatus | null
  /** The saved history `getBufferSince` returns. */
  buffer: Array<{ seq: number; event: AgentEvent; at?: number }>
  queue: Array<{ id: string; send: string; position: number; createdAt: string }>
  /** The live session's permission mode (`getInfo().chatMode`); undefined = not reported. */
  chatMode: string | undefined
  /** The account opted into Claude's auto mode (`getAutoEligibility`). */
  autoOptedIn: boolean
  /**
   * A chat event saved on the computer, as the hub sees it: its summary always, the
   * full event only while a hub client watches the tab (`watchEvents`).
   */
  emit(tabId: string, event: AgentEvent, seq?: number): void
  /** Hub watchers per tab ('*' = unfiltered). */
  watchers: Map<string, number>
  /** Fire a state change on the shared bus. */
  state(sessionId: string, state: TerminalState): void
  reset(): void
}

export function createFakeChat(opts: { ptyTasks?: readonly string[] } = {}): FakeChat {
  const ptyTasks = new Set(opts.ptyTasks ?? [])
  const events = new TypedEmitter<{
    event: [string, AgentEvent, number, number?, number?]
    saved: [string, ChatSavedSummary]
    exit: [string, string, number | null, string | null]
    'threads-changed': [string]
    'pinned-messages-changed': [string]
    'replay-required': [string, string]
  }>()
  const queueEvents = new TypedEmitter<{
    'queue-changed': [string]
    'queue-drained': [string, string]
  }>()
  const stateListeners = new Set<(sessionId: string, state: TerminalState) => void>()

  const fake: FakeChat = {
    chat: undefined as unknown as ChatAccess,
    calls: [],
    status: null,
    buffer: [],
    queue: [],
    chatMode: undefined,
    autoOptedIn: false,
    // As the hub does for a saved event: its summary always (`saved`), the full event
    // to clients that watch it (docs/direct-link.md).
    emit: (tabId, event, seq = 1_000) => {
      fake.buffer.push({ seq, event, at: Date.now() })
      events.emit('saved', tabId, chatSavedSummary(event, seq))
      if (fake.watchers.has(tabId) || fake.watchers.has('*'))
        events.emit('event', tabId, event, seq, undefined, Date.now())
    },
    watchers: new Map(),
    state: (sessionId, state) => {
      for (const cb of stateListeners) cb(sessionId, state)
    },
    reset() {
      fake.calls = []
      fake.status = { state: 'idle', turnOpen: false, pendingRequestIds: [], outboxInFlight: 0 }
      fake.buffer = []
      fake.queue = []
      fake.chatMode = undefined
      fake.autoOptedIn = false
      fake.watchers.clear()
    }
  }
  fake.reset()

  const record =
    (name: string, result: unknown = undefined) =>
    (...args: unknown[]) => {
      fake.calls.push([name, ...args])
      return Promise.resolve(result)
    }

  const ops = {
    getInfo: (tabId: string) =>
      fake.status
        ? {
            tabId,
            taskId: tabId,
            mode: 'claude-chat',
            cwd: '/live',
            sessionId: 'conv',
            pid: 1,
            ...(fake.chatMode !== undefined ? { chatMode: fake.chatMode } : {})
          }
        : null,
    getTurnStatus: () => fake.status,
    getBufferSince: () => fake.buffer,
    getAutoEligibility: () => ({ eligible: fake.autoOptedIn, optedIn: fake.autoOptedIn }),
    respondPermission: record('respondPermission', true),
    interrupt: record('interrupt', {}),
    abortAndPop: record('abortAndPop', { popped: true, text: 'undo me', id: 'm', content: [] }),
    restart: record('restart', { pid: 2 }),
    kill: record('kill'),
    reset: record('reset', {}),
    start: record('start', {}),
    setMode: record('setMode', {}),
    setModel: record('setModel', {}),
    setEffort: record('setEffort', {}),
    fork: record('fork', { conversationId: 'forked', fromConversationId: 'conv' }),
    rewind: record('rewind', { ok: true }),
    rewindPreview: record('rewindPreview', { files: [] }),
    continueInTerminal: record('continueInTerminal', { conversationId: 'conv' }),
    getMode: () => 'auto-accept',
    getModel: () => 'opus',
    getEffort: () => 'high'
  }
  const queueOps = {
    list: () => fake.queue,
    push: (tabId: string, send: string, original: string, o: { id: string }) => {
      fake.calls.push(['push', tabId, send, original, o])
      return { id: o.id, tabId, send, original, position: 0, createdAt: 'now' }
    },
    steer: record('steer', { ok: true }),
    remove: record('remove', true),
    clear: record('clear', 0)
  }

  const watchEvents = (tabIds: readonly string[] | 'all') => {
    const ids = tabIds === 'all' ? ['*'] : [...tabIds]
    for (const id of ids) fake.watchers.set(id, (fake.watchers.get(id) ?? 0) + 1)
    return () => {
      for (const id of ids) {
        const n = (fake.watchers.get(id) ?? 1) - 1
        if (n <= 0) fake.watchers.delete(id)
        else fake.watchers.set(id, n)
      }
    }
  }

  fake.chat = {
    deps: () =>
      ({ ops, queueOps, events, queueEvents, watchEvents }) as unknown as ReturnType<
        ChatAccess['deps']
      >,
    onStateChange: (cb) => {
      stateListeners.add(cb)
      return () => stateListeners.delete(cb)
    },
    launch: async (taskId) =>
      ({
        taskId,
        tabId: taskId,
        sessionId: `${taskId}:${taskId}`,
        mode: ptyTasks.has(taskId) ? 'claude-code' : 'claude-chat',
        kind: ptyTasks.has(taskId) ? 'pty' : 'chat',
        props: {} as never,
        providerFlagsOverride: null,
        resolveCwd: async () => '/repo'
      }) as Awaited<ReturnType<ChatAccess['launch']>>,
    startMain: async (taskId) => {
      fake.calls.push(['startMain', taskId])
      return {
        sessionId: `${taskId}:${taskId}`,
        tabId: taskId,
        mode: 'claude-chat',
        kind: 'chat',
        cwd: '/repo',
        state: 'starting',
        started: true
      }
    }
  }
  return fake
}
