/**
 * Codex sub-agents (`multi_agent`) → the chat's sub-agent rows.
 *
 * A Codex sub-agent is its own thread on the same app-server connection. The
 * thread that spawns it reports it as a `subAgentActivity` item (0.159.2+:
 * `started` names the child's `agentThreadId`; `completed` / `interrupted` end
 * it) or, on the older wire, as a `collabAgentToolCall` with `tool:
 * 'spawnAgent'` (`receiverThreadIds`). The child's own notifications — its
 * turn, items, token usage — then arrive carrying the child's thread id.
 *
 * This maps both onto the events the Claude sub-agent path already uses: one
 * `sub-agent` event stream per child (its row: `toolUseId` = the spawn's item
 * id), and the child's items as rows nested under it (`parentToolUseId`). A
 * child that spawns its own nests the same way. A child outlives the turn that
 * spawned it (a Stop of the parent's turn does not end it — recorded), so every
 * row is `backgrounded`: its own end, or its process ending, closes it.
 *
 * Child text never streams: the driver's stream bridge is the main thread's
 * (one open block); a child's message lands whole on `item/completed`.
 *
 * @module agents/codex/codex-sub-agents
 */
import {
  CODEX_AGENT_TOOL_PREFIX,
  type AgentEvent,
  type SubAgentEvent
} from '@slayzone/terminal-contracts'
import type { CodexCollabAgentState, CodexThreadItem } from './codex-protocol'

/** The driver's own item → tool event mapping (shared with the main thread). */
export interface CodexToolMapper {
  toolCall(item: CodexThreadItem): AgentEvent | null
  toolResult(item: CodexThreadItem): AgentEvent | null
}

type Phase = SubAgentEvent['phase']

interface Row {
  id: string
  parentId?: string
  description?: string
  startedAt: number
  endedAt?: number
  toolUses: number
  totalTokens?: number
  lastText?: string
  lastError?: string
  ended?: { phase: Exclude<Phase, 'in-flight'>; status: string; summary?: string }
}

interface ChildThread {
  row: Row
  /** The child's running turn (what a Stop interrupts). */
  turnId: string | null
  /** Stopped between its turns: its next turn is interrupted as it starts. */
  stopQueued?: true
}

interface Early {
  method: string
  params: unknown
}

/** Notifications kept for a thread not known yet (its spawn call names it later). */
const EARLY_PER_THREAD = 200
const EARLY_THREADS = 16
/** Longest row label taken from a spawn prompt. */
const DESCRIPTION_MAX = 120

export class CodexSubAgents {
  private readonly threads = new Map<string, ChildThread>()
  private readonly rows = new Map<string, Row>()
  private readonly early = new Map<string, Early[]>()
  /** Tool items whose `tool-call` was emitted (a completed one without it gets one first). */
  private readonly called = new Set<string>()

  constructor(
    private readonly tools: CodexToolMapper,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * A sub-agent lifecycle item (`subAgentActivity`, `collabAgentToolCall`) on a
   * thread this chat follows; `parentRowId`: that thread's own row (absent for
   * the main thread). Null when `item` is no such item.
   */
  onItem(
    phase: 'started' | 'completed',
    item: CodexThreadItem,
    parentRowId?: string
  ): AgentEvent[] | null {
    if (item.type === 'subAgentActivity') return this.onActivity(item, parentRowId)
    if (item.type === 'collabAgentToolCall') return this.onAgentToolCall(phase, item, parentRowId)
    return null
  }

  /** A notification of a thread other than the main one. */
  onThreadNotification(threadId: string, method: string, params: unknown): AgentEvent[] {
    const child = this.threads.get(threadId)
    if (child) return this.onChild(child, method, params)
    this.keepEarly(threadId, method, params)
    return []
  }

  /** The children's running turns: a Stop stops them too. */
  runningTurns(): Array<{ threadId: string; turnId: string }> {
    const out: Array<{ threadId: string; turnId: string }> = []
    for (const [threadId, child] of this.threads) {
      if (child.turnId && !child.row.ended) out.push({ threadId, turnId: child.turnId })
    }
    return out
  }

  /**
   * Stop the child whose row this is: its running turn to interrupt, or
   * `queued` when it runs none yet (before its first turn, between turns) — its
   * next turn is interrupted as it starts ({@link takeQueuedStop}). Null: no
   * such child, or it ended.
   */
  requestStop(rowId: string): { threadId: string; turnId: string } | 'queued' | null {
    for (const [threadId, child] of this.threads) {
      if (child.row.id !== rowId) continue
      if (child.row.ended) return null
      if (child.turnId) return { threadId, turnId: child.turnId }
      child.stopQueued = true
      return 'queued'
    }
    return null
  }

  /** A child's turn started: the turn a queued Stop interrupts now, once. */
  takeQueuedStop(threadId: string): { threadId: string; turnId: string } | null {
    const child = this.threads.get(threadId)
    if (!child?.stopQueued || !child.turnId || child.row.ended) return null
    delete child.stopQueued
    return { threadId, turnId: child.turnId }
  }

  /** End every row still open (a past conversation: its children are gone). */
  endOpen(status: string): AgentEvent[] {
    const out: AgentEvent[] = []
    for (const row of this.rows.values()) out.push(...this.end(row, 'failed', status))
    return out
  }

  // ---- parent side ----

  private onActivity(item: CodexThreadItem, parentRowId?: string): AgentEvent[] {
    const threadId = stringOf(item.agentThreadId)
    if (!threadId) return []
    switch (item.kind) {
      case 'started':
        return this.open(item.id, parentRowId, nicknameOf(item.agentPath), threadId)
      case 'completed':
        return this.endThread(threadId, 'completed', 'completed')
      case 'interrupted':
        return this.endThread(threadId, 'failed', 'interrupted')
      default:
        // `interacted`: the parent wrote to it; nothing ends or starts.
        return []
    }
  }

  private onAgentToolCall(
    phase: 'started' | 'completed',
    item: CodexThreadItem,
    parentRowId?: string
  ): AgentEvent[] {
    const tool = stringOf(item.tool) ?? 'unknown'
    const receivers = Array.isArray(item.receiverThreadIds)
      ? item.receiverThreadIds.filter((t): t is string => typeof t === 'string' && t.length > 0)
      : []
    const out: AgentEvent[] = []
    if (tool === 'spawnAgent') {
      // The spawn is the row (no tool card): it shows while the child starts,
      // and binds to the child's thread once a phase names it.
      const description = promptLabel(item.prompt)
      out.push(...this.open(item.id, parentRowId, description))
      receivers.forEach((threadId, i) => {
        const rowId = i === 0 ? item.id : `${item.id}:${threadId}`
        out.push(...this.open(rowId, parentRowId, description, threadId))
      })
      if (phase === 'completed' && item.status === 'failed' && receivers.length === 0) {
        const row = this.rows.get(item.id)
        if (row) out.push(...this.end(row, 'failed', 'failed'))
      }
    } else {
      if (!this.called.has(item.id)) {
        this.called.add(item.id)
        out.push({
          kind: 'tool-call',
          id: item.id,
          name: `${CODEX_AGENT_TOOL_PREFIX}${tool}`,
          input: {
            agents: receivers.map((t) => this.threads.get(t)?.row.description ?? t),
            ...(typeof item.prompt === 'string' && item.prompt ? { prompt: item.prompt } : {})
          },
          ...(parentRowId ? { parentToolUseId: parentRowId } : {})
        })
      }
      if (phase === 'completed') {
        out.push({
          kind: 'tool-result',
          toolUseId: item.id,
          isError: item.status === 'failed',
          rawContent: this.statesText(item.agentsStates),
          structured: item,
          ...(parentRowId ? { parentToolUseId: parentRowId } : {})
        })
      }
    }
    if (phase === 'completed') out.push(...this.applyStates(item.agentsStates))
    return out
  }

  /** `agentsStates` that say a child ended end its row. */
  private applyStates(states: unknown): AgentEvent[] {
    if (!states || typeof states !== 'object') return []
    const out: AgentEvent[] = []
    for (const [threadId, raw] of Object.entries(states as Record<string, unknown>)) {
      const state = raw as CodexCollabAgentState | undefined
      const child = this.threads.get(threadId)
      if (!child || !state) continue
      if (typeof state.message === 'string' && state.message) child.row.lastText ??= state.message
      const ended = endOfState(state.status)
      if (ended) out.push(...this.end(child.row, ended.phase, ended.status))
    }
    return out
  }

  private statesText(states: unknown): string {
    if (!states || typeof states !== 'object') return ''
    return Object.entries(states as Record<string, CodexCollabAgentState | undefined>)
      .filter(([, s]) => s)
      .map(([threadId, s]) => {
        const name = this.threads.get(threadId)?.row.description ?? threadId
        return `${name}: ${s!.status}${s!.message ? ` — ${s!.message}` : ''}`
      })
      .join('\n')
  }

  /**
   * The row `rowId` exists (emitted once) and, given `threadId`, follows that
   * thread: notifications kept for it before are handled now.
   */
  private open(
    rowId: string,
    parentId: string | undefined,
    description: string | undefined,
    threadId?: string
  ): AgentEvent[] {
    const out: AgentEvent[] = []
    let row = this.rows.get(rowId)
    if (!row) {
      row = {
        id: rowId,
        ...(parentId ? { parentId } : {}),
        ...(description ? { description } : {}),
        startedAt: this.now(),
        toolUses: 0
      }
      this.rows.set(rowId, row)
      out.push(this.rowEvent(row))
    }
    if (!threadId) return out
    const known = this.threads.get(threadId)
    // A thread follows one row; an ended child spawned again starts a new one.
    if (known && (known.row === row || !known.row.ended)) return out
    const child: ChildThread = { row, turnId: null }
    this.threads.set(threadId, child)
    const early = this.early.get(threadId)
    if (early) {
      this.early.delete(threadId)
      for (const e of early) out.push(...this.onChild(child, e.method, e.params))
    }
    return out
  }

  private endThread(threadId: string, phase: 'completed' | 'failed', status: string): AgentEvent[] {
    const child = this.threads.get(threadId)
    return child ? this.end(child.row, phase, status) : []
  }

  private end(row: Row, phase: 'completed' | 'failed', status: string): AgentEvent[] {
    if (row.ended) return []
    const summary = phase === 'failed' ? (row.lastError ?? row.lastText) : row.lastText
    row.ended = { phase, status, ...(summary ? { summary } : {}) }
    row.endedAt = this.now()
    return [this.rowEvent(row)]
  }

  private rowEvent(row: Row): SubAgentEvent {
    return {
      kind: 'sub-agent',
      phase: row.ended?.phase ?? 'in-flight',
      toolUseId: row.id,
      ...(row.parentId ? { parentToolUseId: row.parentId } : {}),
      backgrounded: true,
      ...(row.description ? { description: row.description } : {}),
      ...(row.ended ? { status: row.ended.status } : {}),
      ...(row.ended?.summary ? { summary: row.ended.summary } : {}),
      ...(row.totalTokens !== undefined
        ? {
            usage: {
              totalTokens: row.totalTokens,
              toolUses: row.toolUses,
              durationMs: (row.endedAt ?? this.now()) - row.startedAt
            }
          }
        : {}),
      raw: null
    }
  }

  // ---- child side ----

  private onChild(child: ChildThread, method: string, params: unknown): AgentEvent[] {
    const p = (params ?? {}) as Record<string, unknown>
    const row = child.row
    switch (method) {
      case 'turn/started': {
        const id = stringOf((p.turn as { id?: unknown } | undefined)?.id)
        child.turnId = id ?? null
        return []
      }
      case 'turn/completed': {
        const turn = (p.turn ?? {}) as { status?: unknown; error?: { message?: unknown } | null }
        child.turnId = null
        const message = stringOf(turn.error?.message)
        if (message) row.lastError = message
        if (turn.status === 'completed') return this.end(row, 'completed', 'completed')
        if (turn.status === 'interrupted') return this.end(row, 'failed', 'interrupted')
        if (turn.status === 'failed') return this.end(row, 'failed', 'failed')
        return []
      }
      case 'thread/tokenUsage/updated': {
        const usage = p.tokenUsage as { total?: { totalTokens?: unknown } } | undefined
        const total = usage?.total?.totalTokens
        if (typeof total !== 'number') return []
        row.totalTokens = total
        return [this.rowEvent(row)]
      }
      case 'error': {
        const message = stringOf((p.error as { message?: unknown } | undefined)?.message)
        if (message) row.lastError = message
        return []
      }
      case 'item/started':
      case 'item/completed': {
        const item = p.item as CodexThreadItem | undefined
        if (!item || typeof item.type !== 'string' || typeof item.id !== 'string') return []
        const phase = method === 'item/started' ? 'started' : 'completed'
        return this.onItem(phase, item, row.id) ?? this.childItem(phase, item, row)
      }
      default:
        // Deltas (no streaming for a child), status, MCP startup, hooks: no row.
        return []
    }
  }

  private childItem(phase: 'started' | 'completed', item: CodexThreadItem, row: Row): AgentEvent[] {
    const parentToolUseId = row.id
    if (phase === 'completed' && item.type === 'agentMessage') {
      const text = stringOf(item.text)
      if (!text) return []
      row.lastText = text
      return [{ kind: 'assistant-text', messageId: item.id, text, parentToolUseId }]
    }
    if (phase === 'completed' && item.type === 'reasoning') {
      const text = [
        ...(Array.isArray(item.summary) ? item.summary : []),
        ...(Array.isArray(item.content) ? item.content : [])
      ]
        .filter((t): t is string => typeof t === 'string' && t.length > 0)
        .join('\n\n')
      if (!text) return []
      return [
        {
          kind: 'assistant-thinking',
          messageId: item.id,
          text,
          hasSignature: false,
          parentToolUseId
        }
      ]
    }
    const out: AgentEvent[] = []
    if (!this.called.has(item.id)) {
      const call = this.tools.toolCall(item)
      if (call?.kind === 'tool-call') {
        this.called.add(item.id)
        out.push({ ...call, parentToolUseId })
      }
    }
    if (phase === 'completed' && this.called.has(item.id)) {
      const result = this.tools.toolResult(item)
      if (result?.kind === 'tool-result') {
        out.push({ ...result, parentToolUseId })
        row.toolUses += 1
        if (row.totalTokens !== undefined) out.push(this.rowEvent(row))
      }
    }
    return out
  }

  private keepEarly(threadId: string, method: string, params: unknown): void {
    let list = this.early.get(threadId)
    if (!list) {
      if (this.early.size >= EARLY_THREADS) {
        const oldest = this.early.keys().next().value
        if (oldest !== undefined) this.early.delete(oldest)
      }
      list = []
      this.early.set(threadId, list)
    }
    if (list.length < EARLY_PER_THREAD) list.push({ method, params })
  }
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** `/root/scout/helper` → `helper` (the agent's nickname). */
function nicknameOf(agentPath: unknown): string | undefined {
  const last = stringOf(agentPath)?.split('/').filter(Boolean).at(-1)
  return last && last !== 'root' ? last : undefined
}

/** A spawn prompt's first line, as a row label. */
function promptLabel(prompt: unknown): string | undefined {
  const line = stringOf(prompt)
    ?.split('\n')
    .map((l) => l.trim())
    .find(Boolean)
  if (!line) return undefined
  return line.length > DESCRIPTION_MAX ? `${line.slice(0, DESCRIPTION_MAX - 1)}…` : line
}

/** An `agentsStates` status that means the child ended, and how. */
function endOfState(
  status: CodexCollabAgentState['status'] | undefined
): { phase: 'completed' | 'failed'; status: string } | null {
  switch (status) {
    case 'completed':
      return { phase: 'completed', status: 'completed' }
    case 'errored':
      return { phase: 'failed', status: 'failed' }
    case 'interrupted':
      return { phase: 'failed', status: 'interrupted' }
    case 'shutdown':
      return { phase: 'failed', status: 'shut down' }
    case 'notFound':
      return { phase: 'failed', status: 'not found' }
    default:
      return null
  }
}
