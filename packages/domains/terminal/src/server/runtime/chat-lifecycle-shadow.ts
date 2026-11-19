/**
 * The session's lifecycle model: the source of its published status
 * (`authority`), checked against the runtime's own state. Compares at a microtask boundary after synchronous lifecycle,
 * outbox and prompt updates settle. Failures disable the observer, never chat.
 * Reports are capped per process and contain counts/flags, not event payloads,
 * message/turn/prompt ids, commands, paths, or provider error text.
 */
import type { AgentEvent, ChatTurnState } from '@slayzone/terminal-contracts'
import {
  createChatLifecycle,
  reduceChatLifecycle,
  chatLifecycleSnapshot,
  lifecycleEvent,
  type ChatLifecycle,
  type ChatLifecycleSignal,
  type ChatLifecycleSnapshot
} from '../../shared/chat-lifecycle'

export interface LifecycleObservation {
  generation: number
  conversationId: string | null
  state: ChatTurnState
  reportedState: ChatTurnState | 'background'
  turnOpen: boolean
  mainTurnOpen: boolean
  pendingRequestIds: readonly string[]
  outboxInFlight: number
  backgroundHelpers: number
  backgroundJobs: number
  readyForMessage: boolean
  seq: number
  live: number
}

function summary(view: LifecycleObservation | ChatLifecycleSnapshot) {
  return {
    state: view.state,
    reportedState: view.reportedState,
    turnOpen: view.turnOpen,
    mainTurnOpen: view.mainTurnOpen,
    prompts: view.pendingRequestIds.length,
    outbox: view.outboxInFlight,
    helpers: view.backgroundHelpers,
    jobs: view.backgroundJobs,
    ready: view.readyForMessage
  }
}

export type LifecycleShadowReport =
  | {
      kind: 'mismatch'
      generation: number
      revision: number
      seq: number
      live: number
      fields: string[]
      signal: string
      expected: ReturnType<typeof summary>
      actual: ReturnType<typeof summary>
    }
  | { kind: 'disabled'; generation: number; reason: 'reducer' | 'observation' }

interface Options {
  autonomous: boolean
  observe(): LifecycleObservation
  report(record: LifecycleShadowReport): void
  reportLimit?: number
  /** Test seam: a broken candidate must never break production execution. */
  reduce?: typeof reduceChatLifecycle
}

/** Compare control/item boundaries even when the candidate correctly ignores
 * them: the old runtime might still change. Steady token deltas are excluded. */
function runtimeMayChange(signal: ChatLifecycleSignal): boolean {
  if (signal.type !== 'event') return false
  switch (signal.event.kind) {
    case 'tool-call':
    case 'tool-result':
    case 'result':
    case 'interrupted':
    case 'permission-request':
    case 'permission-resolved':
    case 'permission-cancelled':
    case 'process-exit':
    case 'session-spawn':
    case 'turn-init':
    case 'user-message-popped':
    case 'sub-agent':
    case 'command-task':
    case 'assistant-text':
    case 'assistant-thinking':
    case 'stream-message-start':
    case 'stream-block-start':
      return true
    default:
      return false
  }
}

/** Test seam: sees every report before the session's own sink (`chat-lifecycle-strict-testkit.ts`). */
const reportObservers = new Set<(record: LifecycleShadowReport) => void>()
export function __observeLifecycleReports(
  observe: (record: LifecycleShadowReport) => void
): () => void {
  reportObservers.add(observe)
  return () => reportObservers.delete(observe)
}

export class ChatLifecycleShadow {
  private state: ChatLifecycle
  private revision = 0
  private queued = false
  private closed = false
  private disabled = false
  private checks = 0
  private mismatches = 0
  private reported = 0
  private suppressed = 0
  private reportsInGeneration = 0
  private readonly seen = new Set<string>()
  private signal = 'initialize'
  private readonly limit: number

  constructor(
    private readonly tabId: string,
    private readonly options: Options
  ) {
    this.state = createChatLifecycle(tabId)
    const budget = options.reportLimit ?? 8
    this.limit = Number.isFinite(budget) ? Math.max(0, Math.min(32, Math.floor(budget))) : 8
  }

  private emit(record: LifecycleShadowReport): void {
    for (const observe of reportObservers) {
      try {
        observe(record)
      } catch {
        /* an observer never affects chat */
      }
    }
    try {
      this.options.report(record)
    } catch {
      /* Diagnostic failure has no chat effects. */
    }
  }

  private disable(reason: 'reducer' | 'observation'): void {
    if (this.disabled) return
    this.disabled = true
    this.queued = false
    this.emit({ kind: 'disabled', generation: this.state.generation, reason })
  }

  private apply(generation: number, signal: ChatLifecycleSignal): boolean {
    const before = this.state
    try {
      this.state = (this.options.reduce ?? reduceChatLifecycle)(before, {
        tabId: this.tabId,
        generation,
        revision: ++this.revision,
        signal
      })
    } catch {
      this.disable('reducer')
      return false
    }
    if (before.generation !== this.state.generation) {
      this.seen.clear()
      this.reportsInGeneration = 0
    }
    return before.value !== this.state.value || before.generation !== this.state.generation
  }

  feed(generation: number, signal: ChatLifecycleSignal): void {
    if (this.disabled || this.closed) return
    try {
      const changed = this.apply(generation, signal)
      if (this.disabled || generation !== this.state.generation) return
      if (!changed && !runtimeMayChange(signal)) return
      this.signal = signal.type === 'event' ? signal.event.kind : signal.type
      if (this.queued) return
      this.queued = true
      queueMicrotask(() => this.compare())
    } catch {
      this.disable('reducer')
    }
  }

  event(generation: number, event: AgentEvent): void {
    if (this.disabled || this.closed) return
    try {
      this.feed(generation, lifecycleEvent(event, { autonomous: this.options.autonomous }))
    } catch {
      this.disable('reducer')
    }
  }

  private compare(): void {
    if (!this.queued || this.closed || this.disabled) return
    this.queued = false
    let actual: LifecycleObservation
    let expected: ChatLifecycleSnapshot
    try {
      actual = this.options.observe()
      // Delivery has one authority: the existing outbox. It is not guessed
      // from a result, replay counter, or a copied terminal-state transition.
      if (actual.outboxInFlight !== this.state.value.inFlight) {
        this.apply(actual.generation, { type: 'outbox', inFlight: actual.outboxInFlight })
      }
      if (this.disabled) return
      expected = chatLifecycleSnapshot(this.state)
    } catch {
      this.disable('observation')
      return
    }
    this.checks++
    const fields: string[] = []
    if (actual.generation !== expected.generation) fields.push('generation')
    if (
      actual.conversationId &&
      expected.conversationId &&
      actual.conversationId !== expected.conversationId
    )
      fields.push('conversation')
    for (const key of [
      'state',
      'reportedState',
      'turnOpen',
      'mainTurnOpen',
      'outboxInFlight',
      'backgroundHelpers',
      'backgroundJobs',
      'readyForMessage'
    ] as const) {
      if (actual[key] !== expected[key]) fields.push(key)
    }
    if (
      [...actual.pendingRequestIds].sort().join('\0') !==
      [...expected.pendingRequestIds].sort().join('\0')
    )
      fields.push('pendingRequests')
    if (!fields.length) return
    this.mismatches++
    const record: LifecycleShadowReport = {
      kind: 'mismatch',
      generation: expected.generation,
      revision: expected.revision,
      seq: actual.seq,
      live: actual.live,
      signal: this.signal,
      fields,
      expected: summary(expected),
      actual: summary(actual)
    }
    // The signature is content-free as well, and the Set is capped by limit.
    const signature = JSON.stringify({ fields, expected: record.expected, actual: record.actual })
    if (this.reportsInGeneration >= this.limit || this.seen.has(signature)) {
      this.suppressed++
      return
    }
    this.seen.add(signature)
    this.reportsInGeneration++
    this.reported++
    this.emit(record)
  }

  close(): void {
    this.closed = true
    this.queued = false
    this.seen.clear()
  }

  /**
   * The model's current status (the session's); null once it failed or closed —
   * the runtime's own status applies again.
   */
  authority(): ChatLifecycleSnapshot | null {
    if (this.disabled || this.closed) return null
    try {
      return chatLifecycleSnapshot(this.state)
    } catch {
      this.disable('reducer')
      return null
    }
  }

  read() {
    return {
      snapshot: chatLifecycleSnapshot(this.state),
      checks: this.checks,
      mismatches: this.mismatches,
      reported: this.reported,
      suppressed: this.suppressed,
      disabled: this.disabled
    }
  }
}
