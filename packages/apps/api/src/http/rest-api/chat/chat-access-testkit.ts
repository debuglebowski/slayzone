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
  clampChatHistoryPageBudget,
  cutChatHistoryPage,
  jsonByteLength,
  type AgentEvent,
  type ChatHistoryPageBudget,
  type ChatSavedSummary,
  type ChatTurnStatus,
  type TerminalState
} from '@slayzone/terminal-contracts'
import {
  TimelineProjection,
  type TimelineProjectionStore
} from '@slayzone/terminal/timeline-projection'
import type { ChatAccess } from '../types'

/** A projection store in memory (what the computer keeps in its chat SQLite). */
function memoryTimelineStore(): TimelineProjectionStore {
  const pages = new Map<number, { rows: string; summary: string; searchText: string }>()
  let checkpoint: { version: string; seq: number; data: string } | null = null
  return {
    loadCheckpoint: async () => checkpoint,
    loadPages: async (wanted) =>
      wanted.flatMap((page) => {
        const p = pages.get(page)
        return p ? [{ page, rows: p.rows }] : []
      }),
    loadSummaries: async () =>
      [...pages.entries()]
        .sort(([a], [b]) => a - b)
        .map(([page, p]) => ({ page, summary: p.summary })),
    save: async (write) => {
      if (write.dropPagesFrom !== null)
        for (const page of [...pages.keys()]) if (page >= write.dropPagesFrom) pages.delete(page)
      for (const p of write.pages)
        pages.set(p.page, { rows: p.rows, summary: p.summary, searchText: p.searchText })
      checkpoint = write.checkpoint
    },
    searchPages: async (needle) =>
      [...pages.entries()].filter(([, p]) => p.searchText.includes(needle)).map(([page]) => page),
    discard: async () => {
      pages.clear()
      checkpoint = null
    }
  }
}

export interface FakeChat {
  chat: ChatAccess
  /** Every recorded op call: [name, ...args]. */
  calls: unknown[][]
  /** What `getTurnStatus` answers (null = no session on the computer). */
  status: ChatTurnStatus | null
  /** The saved history (what the computer's history reads serve, page by page). */
  buffer: Array<{ seq: number; event: AgentEvent; at?: number }>
  /**
   * Serve `openTimeline` from a real timeline projection of `buffer` (true), or
   * answer `full` (false: an unusable projection / another reducer version).
   */
  projection: boolean
  /** Byte budget of one history answer (page reads, timeline pages). */
  pageBytes: number
  /** `timelinePages` answers `expired` this many times next (the projection moved on). */
  expirePages: number
  /** `timelinePages` answers after this long (a slow computer). */
  pagesDelayMs: number
  /**
   * Every history answer the "computer" sent: the op, its JSON size, and how many
   * units (events, timeline pages) it carried — one unit may exceed a page budget.
   */
  historyAnswers: Array<{ op: string; bytes: number; units: number }>
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
    projection: false,
    pageBytes: 4 * 1024 * 1024,
    expirePages: 0,
    pagesDelayMs: 0,
    historyAnswers: [],
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
      fake.projection = false
      fake.pageBytes = 4 * 1024 * 1024
      fake.expirePages = 0
      fake.pagesDelayMs = 0
      fake.historyAnswers = []
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

  const answer = <T>(op: string, value: T, units = 0): T => {
    fake.historyAnswers.push({ op, bytes: jsonByteLength(value), units })
    return value
  }
  const sorted = () => [...fake.buffer].sort((a, b) => a.seq - b.seq)
  /** The buffer sorted, with each event's size: computed once per buffer version (array + length). */
  let index: {
    buffer: FakeChat['buffer']
    length: number
    rows: FakeChat['buffer']
    sizes: number[]
  } | null = null
  const indexed = () => {
    if (index?.buffer !== fake.buffer || index.length !== fake.buffer.length) {
      const rows = sorted()
      index = {
        buffer: fake.buffer,
        length: fake.buffer.length,
        rows,
        sizes: rows.map((e) => jsonByteLength(e.event))
      }
    }
    return index
  }
  /** The projection the computer keeps of `buffer` (rebuilt when the buffer changed). */
  let projected: {
    buffer: FakeChat['buffer']
    key: string
    projection: Promise<TimelineProjection>
  } | null = null
  const projectionOf = () => {
    const history = sorted()
    const key = `${history.length}:${fake.pageBytes}`
    if (projected?.buffer !== fake.buffer || projected.key !== key)
      projected = {
        buffer: fake.buffer,
        key,
        projection: TimelineProjection.open({
          store: memoryTimelineStore(),
          history,
          agentStartedTurns: true,
          pageBudgetBytes: fake.pageBytes
        })
      }
    return projected.projection
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
    // Whole-history reads: recorded, so a test can assert nobody makes them.
    getBufferSince: (_tabId: string, afterSeq: number) =>
      answer(
        'getBufferSince',
        sorted().filter((e) => e.seq > afterSeq)
      ),
    getEventPage: (_tabId: string, afterSeq: number, budget?: ChatHistoryPageBudget) => {
      // Like the store: sizes known up front, only `maxEvents + 1` rows looked at.
      const { rows, sizes } = indexed()
      let from = 0
      for (let hi = rows.length; from < hi; ) {
        const mid = (from + hi) >> 1
        if (rows[mid].seq <= afterSeq) from = mid + 1
        else hi = mid
      }
      const limits = clampChatHistoryPageBudget({ maxBytes: fake.pageBytes, ...budget })
      const window = rows.slice(from, from + limits.maxEvents + 1)
      const cut = cutChatHistoryPage(
        window.map((e, i) => ({ seq: e.seq, bytes: sizes[from + i] })),
        { ...limits, maxBytes: Math.min(limits.maxBytes, fake.pageBytes) }
      )
      const events = cut.through === null ? [] : window.filter((e) => e.seq <= cut.through!)
      return answer('getEventPage', { events, hasMore: cut.more }, events.length)
    },
    openTimeline: async (_tabId: string, version: string) => {
      if (!fake.projection) return answer('openTimeline', { kind: 'full' as const })
      const projection = await projectionOf()
      const snapshot = await projection.openSnapshot()
      if (snapshot.version !== version) return answer('openTimeline', { kind: 'full' as const })
      return answer('openTimeline', {
        kind: 'paged' as const,
        snapshot,
        events: [],
        live: { afterSeq: snapshot.seq, liveSeq: 0, events: [] }
      })
    },
    timelinePages: async (
      _tabId: string,
      pages: number[],
      asOfSeq: number,
      epoch: number,
      startRow?: number
    ) => {
      if (fake.pagesDelayMs) await new Promise((r) => setTimeout(r, fake.pagesDelayMs))
      if (fake.expirePages > 0) {
        fake.expirePages--
        return answer('timelinePages', { expired: true as const })
      }
      const got = await (await projectionOf()).pagesAsOf(pages, asOfSeq, epoch, startRow)
      // Units: rows (one row always fits an answer, alone; a page no longer does).
      return answer(
        'timelinePages',
        got,
        got.expired ? 0 : got.pages.reduce((n, p) => n + p.rows.length, 0)
      )
    },
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
