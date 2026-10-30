/**
 * The outbox: one chat tab's user messages on their way to the agent.
 *
 * Every message has a delivery state — queued → sending → delivered → answered,
 * or failed (with the reason, retryable) / cancelled — and nothing counts as
 * delivered until the agent confirmed it:
 *   - Claude confirms natively: a message carrying a `uuid` gets
 *     `command_lifecycle` queued/started/completed, and `--replay-user-messages`
 *     echoes it back. For a CLI that sends neither, the first turn progress after
 *     the write stands in (logged as missing).
 *   - A driver without native acks (Codex today) counts the confirmed write as
 *     delivered and the next result as the answer.
 *
 * Writes are serial per tab (FIFO), and happen in the SAME tick as `accept` when
 * the process is ready — the agent sees messages in the order they were sent
 * (a message whose files are still being read holds the ones behind it). A
 * write the link could not deliver is retried with the same id (the computer
 * writes a repeated id once) until {@link OutboxDeps.retryWindowMs}, then failed.
 *
 * What happens when a process ends with messages in flight:
 *   - `resend` (a failed resume, or a process we replaced): undelivered messages
 *     are queued again and go to the next process with the same id;
 *   - otherwise: undelivered → failed ("stopped before it got the message");
 *     delivered → left as is (no auto-resend; the turn shows as interrupted).
 *
 * The outbox owns states, not events: `onChange` tells the transport, which
 * records them in the tab's history (`user-message-delivery`).
 *
 * @module terminal/server/runtime/chat-outbox
 */
import type {
  AgentEvent,
  OutgoingUserMessage,
  UserMessageDeliveryState
} from '@slayzone/terminal-contracts'
import { isChatWriteError } from './chat-proc-handle'

export type OutboxState = 'queued' | UserMessageDeliveryState

/** The current agent process, as the outbox needs it. */
export interface OutboxProcess {
  readonly gen: number
  /** Started and able to take a write. */
  readonly ready: boolean
  /** The agent acks messages itself (lifecycle / replay), so a write alone is not delivery. */
  readonly confirmsDelivery: boolean
  /**
   * Build what a message with attached files is written as (reads the files).
   * Runs BEFORE the message counts as sending: a failure fails the message with
   * its reason and never starts a turn. Not called for text-only messages.
   */
  prepare?(message: OutgoingUserMessage): Promise<unknown>
  /** Write the message (as `prepared`). Rejects with a `ChatWriteError` when it did not reach the process. */
  send(message: OutgoingUserMessage, prepared?: unknown): Promise<void>
}

export interface OutboxStateChange {
  id: string
  state: UserMessageDeliveryState
  error?: string
}

export interface OutboxDeps {
  /** The tab's current process, ready or not (null: none). */
  current(): OutboxProcess | null
  /** The current process once ready — starting one if needed. Rejects with why it could not. */
  ensureReady(): Promise<OutboxProcess>
  onChange(change: OutboxStateChange): void
  /** A message is being written to the agent: its turn starts now. */
  onWriting(id: string): void
  /** The CLI acks natively but sent no lifecycle event for a written message. */
  onLifecycleMissing?(gen: number): void
  /**
   * The CLI reported a written message `completed` without ever queuing or
   * starting it: it already had that uuid (it got it before a restart) and
   * dropped it — no turn runs for it (Claude Code 2.1.312, chat-a check R2b).
   */
  onAlreadyInConversation?(id: string): void
  /** How long a link-down write keeps being retried before it fails. */
  retryWindowMs?: number
  /** First retry delay; doubles per retry up to 8×. */
  retryBaseMs?: number
}

interface Entry {
  message: OutgoingUserMessage
  state: OutboxState
  /** Process generation it was (last) written to. */
  gen: number | null
  /** The write to `gen` resolved. */
  written: boolean
  /** Where the CLI says the message is (lifecycle of `gen`): received, or its turn started. */
  cli: 'none' | 'queued' | 'started'
  /** First link-down failure of the current attempt (retry window start). */
  linkDownSince: number | null
  retryTimer: ReturnType<typeof setTimeout> | null
}

const DEFAULT_RETRY_WINDOW_MS = 30_000
const RESTART_LOSS = 'Not sent: the app restarted before Claude Code confirmed it.'
const ENDED_BEFORE = 'Not sent: Claude Code stopped before it received the message.'

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class ChatOutbox {
  private readonly entries = new Map<string, Entry>()
  /** FIFO of ids not yet written (queued). */
  private readonly queue: string[] = []
  private writing: string | null = null
  private waitingForReady = false
  /** Generations that sent at least one lifecycle event — their acks are authoritative. */
  private readonly lifecycleGens = new Set<number>()
  private readonly lifecycleMissingReported = new Set<number>()
  private readonly retryWindowMs: number
  private readonly retryBaseMs: number

  constructor(private readonly deps: OutboxDeps) {
    this.retryWindowMs = deps.retryWindowMs ?? DEFAULT_RETRY_WINDOW_MS
    this.retryBaseMs = deps.retryBaseMs ?? 1000
  }

  /** Take a message. Idempotent by id: a known id is never sent twice. */
  accept(msg: OutgoingUserMessage): OutboxState {
    const known = this.entries.get(msg.id)
    if (known) return known.state
    this.entries.set(msg.id, {
      message: msg,
      state: 'queued',
      gen: null,
      written: false,
      cli: 'none',
      linkDownSince: null,
      retryTimer: null
    })
    this.queue.push(msg.id)
    this.pump()
    return 'queued'
  }

  state(id: string): OutboxState | null {
    return this.entries.get(id)?.state ?? null
  }

  message(id: string): OutgoingUserMessage | null {
    return this.entries.get(id)?.message ?? null
  }

  /** Send a failed message again (same id). False when it is not failed. */
  retry(id: string): boolean {
    const entry = this.entries.get(id)
    if (!entry || entry.state !== 'failed') return false
    entry.state = 'queued'
    entry.gen = null
    entry.written = false
    entry.linkDownSince = null
    this.queue.push(id)
    this.pump()
    return true
  }

  /** Withdraw a message (popped by Stop). */
  cancel(id: string): void {
    const entry = this.entries.get(id)
    if (!entry || entry.state === 'answered' || entry.state === 'cancelled') return
    this.clearRetry(entry)
    const i = this.queue.indexOf(id)
    if (i >= 0) this.queue.splice(i, 1)
    this.set(entry, 'cancelled')
  }

  /** Messages the agent has not finished with (queued, sending, delivered). */
  inFlight(): number {
    let n = 0
    for (const e of this.entries.values()) {
      if (e.state === 'queued' || e.state === 'sending' || e.state === 'delivered') n++
    }
    return n
  }

  /** Try to write the next queued message. Called on accept and when a process becomes ready. */
  pump(): void {
    if (this.writing !== null) return
    const id = this.queue[0]
    if (id === undefined) return
    const proc = this.deps.current()
    if (proc?.ready) {
      this.write(proc, id)
      return
    }
    if (this.waitingForReady) return
    this.waitingForReady = true
    this.deps.ensureReady().then(
      () => {
        this.waitingForReady = false
        this.pump()
      },
      (err: unknown) => {
        this.waitingForReady = false
        // The agent could not start: every waiting message fails with why.
        for (const queuedId of this.queue.splice(0)) {
          const entry = this.entries.get(queuedId)
          if (entry) this.set(entry, 'failed', message(err))
        }
      }
    )
  }

  onLifecycle(
    gen: number,
    id: string,
    state: 'queued' | 'started' | 'completed' | 'cancelled'
  ): void {
    this.lifecycleGens.add(gen)
    const entry = this.entries.get(id)
    if (!entry || entry.gen !== gen) return
    if (state === 'queued' || state === 'started') {
      if (entry.cli !== 'started') entry.cli = state
      this.deliver(entry)
    } else if (state === 'completed') {
      const dropped = entry.cli === 'none'
      this.deliver(entry)
      this.set(entry, 'answered')
      if (dropped) this.deps.onAlreadyInConversation?.(id)
    } else if (entry.state !== 'answered') {
      this.set(entry, 'cancelled')
    }
  }

  /** The oldest message the agent has not finished with (queued, sending, delivered), or null. */
  oldestInFlight(): string | null {
    for (const [id, e] of this.entries) {
      if (e.state === 'queued' || e.state === 'sending' || e.state === 'delivered') return id
    }
    return null
  }

  /** Messages of `gen` the CLI holds queued (received, its turn not started yet). */
  heldByCli(gen: number): string[] {
    const ids: string[] = []
    for (const [id, entry] of this.entries) {
      if (entry.gen === gen && entry.cli === 'queued' && entry.state === 'delivered') ids.push(id)
    }
    return ids
  }

  onReplay(gen: number, id: string): void {
    const entry = this.entries.get(id)
    if (entry && entry.gen === gen) this.deliver(entry)
  }

  /** Turn progress from `gen`: stands in for delivery when its CLI sends no lifecycle events. */
  onProgress(gen: number): void {
    if (this.lifecycleGens.has(gen)) return
    const entry = this.oldestWritten(gen, 'sending')
    if (!entry) return
    if (!this.lifecycleMissingReported.has(gen)) {
      this.lifecycleMissingReported.add(gen)
      this.deps.onLifecycleMissing?.(gen)
    }
    this.deliver(entry)
  }

  /** A turn of `gen` finished: answers the oldest delivered message when nothing else will. */
  onResult(gen: number): void {
    if (this.lifecycleGens.has(gen)) return
    const sending = this.oldestWritten(gen, 'sending')
    if (sending) this.deliver(sending)
    const entry = this.oldestWritten(gen, 'delivered')
    if (entry) this.set(entry, 'answered')
  }

  /**
   * `resend`: undelivered messages go to the next process. `resendDelivered`
   * (a failed resume: the conversation they were delivered to never existed):
   * delivered-but-unanswered ones go too.
   */
  onProcessEnded(
    gen: number,
    { resend, resendDelivered = false }: { resend: boolean; resendDelivered?: boolean }
  ): void {
    for (const [id, entry] of this.entries) {
      if (entry.gen !== gen) continue
      if (entry.state === 'sending' || (resendDelivered && entry.state === 'delivered')) {
        this.clearRetry(entry)
        if (this.writing === id) this.writing = null
        if (resend) {
          entry.state = 'queued'
          entry.gen = null
          entry.written = false
          entry.linkDownSince = null
          if (!this.queue.includes(id)) this.queue.unshift(id)
        } else {
          this.set(entry, 'failed', ENDED_BEFORE)
        }
      } else if (entry.state === 'delivered') {
        // Delivered, never answered: the turn was cut short. Not re-sent; the
        // timeline shows it as interrupted and the user decides.
        entry.state = 'cancelled'
      }
    }
    if (resend) this.queue.sort((a, b) => this.order(a) - this.order(b))
  }

  /**
   * Rebuild from a tab's saved history after a restart: a message whose last
   * state was never confirmed did not survive the restart — fail it (Retry).
   */
  restore(events: Iterable<AgentEvent>): void {
    const last = new Map<string, { message: OutgoingUserMessage; state: OutboxState }>()
    for (const event of events) {
      // Imported history was answered long ago, never by this tab's outbox.
      if (event.kind === 'user-message' && event.id && !event.history) {
        last.set(event.id, {
          message: { id: event.id, content: event.content ?? [{ type: 'text', text: event.text }] },
          state: 'queued'
        })
      } else if (event.kind === 'user-message-delivery') {
        const known = last.get(event.id)
        if (known && event.state !== 'sending') known.state = event.state
      }
    }
    for (const [id, { message: msg, state }] of last) {
      if (this.entries.has(id)) continue
      const entry: Entry = {
        message: msg,
        state,
        gen: null,
        written: false,
        cli: 'none',
        linkDownSince: null,
        retryTimer: null
      }
      this.entries.set(id, entry)
      if (state === 'queued') this.set(entry, 'failed', RESTART_LOSS)
      else if (state === 'delivered') entry.state = 'cancelled'
    }
  }

  dispose(): void {
    for (const entry of this.entries.values()) this.clearRetry(entry)
  }

  // ---- internals ----

  private write(proc: OutboxProcess, id: string): void {
    const entry = this.entries.get(id)
    if (!entry || entry.state !== 'queued') {
      this.queue.shift()
      this.pump()
      return
    }
    this.queue.shift()
    this.writing = id
    // Text needs nothing read: it is written in this tick, as it always was.
    if (!proc.prepare || entry.message.content.every((b) => b.type === 'text')) {
      this.send(proc, entry, id, undefined)
      return
    }
    let prepared: Promise<unknown>
    try {
      prepared = proc.prepare(entry.message)
    } catch (err) {
      prepared = Promise.reject(err)
    }
    prepared.then(
      (payload) => {
        // Withdrawn (Stop) while its files were read.
        if (entry.state !== 'queued') return this.finishWrite(id)
        if (!proc.ready || this.deps.current() !== proc) {
          // The process went away meanwhile: the next one sends it, in order.
          if (this.writing === id) this.writing = null
          this.queue.unshift(id)
          this.pump()
          return
        }
        this.send(proc, entry, id, payload)
      },
      (err: unknown) => {
        // Nothing was written and no turn started: the message fails with why.
        if (entry.state === 'queued') this.set(entry, 'failed', message(err))
        this.finishWrite(id)
      }
    )
  }

  private send(proc: OutboxProcess, entry: Entry, id: string, prepared: unknown): void {
    entry.gen = proc.gen
    entry.written = false
    entry.cli = 'none'
    this.set(entry, 'sending')
    this.deps.onWriting(id)
    let sent: Promise<void>
    try {
      sent = proc.send(entry.message, prepared)
    } catch (err) {
      sent = Promise.reject(err)
    }
    sent.then(
      () => {
        if (entry.gen !== proc.gen || entry.state !== 'sending') return this.finishWrite(id)
        entry.written = true
        entry.linkDownSince = null
        if (!proc.confirmsDelivery) this.deliver(entry)
        this.finishWrite(id)
      },
      (err: unknown) => {
        if (entry.gen !== proc.gen || entry.state !== 'sending') return this.finishWrite(id)
        if (isChatWriteError(err) && err.code === 'link-down') {
          const since = entry.linkDownSince ?? Date.now()
          entry.linkDownSince = since
          const elapsed = Date.now() - since
          if (elapsed < this.retryWindowMs) {
            // Back off 1 s, 2 s, 4 s … within the window; the id makes it idempotent.
            const base = this.retryBaseMs
            const delay = Math.min(base * 2 ** Math.floor(Math.log2(elapsed / base + 1)), base * 8)
            entry.retryTimer = setTimeout(() => {
              entry.retryTimer = null
              if (entry.state !== 'sending' || entry.gen !== proc.gen) return
              entry.state = 'queued'
              this.queue.unshift(id)
              this.pump()
            }, delay)
            entry.retryTimer.unref?.()
            this.finishWrite(id, false)
            return
          }
        }
        this.set(entry, 'failed', message(err))
        this.finishWrite(id)
      }
    )
  }

  private finishWrite(id: string, pumpNext = true): void {
    if (this.writing === id) this.writing = null
    if (pumpNext) this.pump()
  }

  private deliver(entry: Entry): void {
    if (entry.state === 'sending' || entry.state === 'queued') this.set(entry, 'delivered')
  }

  private oldestWritten(gen: number, state: OutboxState): Entry | null {
    for (const entry of this.entries.values()) {
      if (entry.gen === gen && entry.state === state && (state !== 'sending' || entry.written)) {
        return entry
      }
    }
    return null
  }

  private order(id: string): number {
    return [...this.entries.keys()].indexOf(id)
  }

  private clearRetry(entry: Entry): void {
    if (entry.retryTimer) clearTimeout(entry.retryTimer)
    entry.retryTimer = null
  }

  private set(entry: Entry, state: UserMessageDeliveryState, error?: string): void {
    if (entry.state === state) return
    entry.state = state
    this.deps.onChange({ id: entry.message.id, state, ...(error ? { error } : {}) })
  }
}
