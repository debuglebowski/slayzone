/**
 * One agent process of a chat tab: a GENERATION.
 *
 * A tab outlives its processes (model change, Stop, a failed resume all start a
 * new one); each process gets the next generation number, and everything it
 * says is gated on it: once a process has ended or been replaced, its events
 * are dropped at the door — they can never reach the tab's history or the
 * screen (audit #3; Codex's late `result` after exit). The transport checks
 * that the generation is still the tab's current one on top of that.
 *
 * Owns, per process: the handle, the protocol driver, stdout line framing,
 * debounced + capped stderr, the start/ready/exit promises, the stop ladder
 * (SIGTERM → SIGKILL → abandon), and the bookkeeping the watchdog and the
 * resume guard need.
 *
 * @module terminal/server/runtime/chat-process
 */
import type { AgentEvent, AgentExecution, OutgoingUserMessage } from '@slayzone/terminal-contracts'
import { userMessageText } from '@slayzone/terminal-contracts'
import type { ChatDriverContext, ChatSessionDriver, PreparedUserTurn } from '../agents/types'
import { randomUUID } from 'node:crypto'
import { createLineSplitter, type ChatProcHandle } from './chat-proc-handle'
import type { OpenToolBound } from './chat-watchdog'
import type { OutboxProcess } from './chat-outbox'
import { ChatOutputSpool } from './chat-output-spool'

const NO_ATTACHMENTS = "This agent can't take attached files. Send the message without them."

const STDERR_FLUSH_INTERVAL_MS = 100
/** Largest stderr event; the rest of a burst is summarized. */
const STDERR_MAX_CHUNK = 64 * 1024
/** stderr a single process may add to the history in total. */
const STDERR_MAX_TOTAL = 1024 * 1024

export interface ChatProcessHooks {
  /** The OS confirmed the process runs (before its driver starts). */
  onSpawned(proc: ChatProcess): void | Promise<void>
  /** An event from the driver or the stderr buffer — current generation only. */
  onEvent(proc: ChatProcess, event: AgentEvent): void
  /** The process ended (or was given up on: `unconfirmed`). Fires once. */
  onExit(proc: ChatProcess, code: number | null, signal: string | null, unconfirmed: boolean): void
  /** It could not be started at all. */
  onStartError(proc: ChatProcess, err: Error): void
  /** An event arrived after this process ended or was replaced (dropped). */
  onStale?(proc: ChatProcess, event: AgentEvent): void
  /** The driver read a switched-to conversation's past (`ChatDriverContext.addHistory`). */
  onHistory?(proc: ChatProcess, events: AgentEvent[]): void
  /** The host asked it to stop (first `kill`): from now on it only ends. */
  onStopRequested?(proc: ChatProcess): void
}

export interface ChatProcessOptions {
  gen: number
  spawnId: string
  handle: ChatProcHandle
  driver: ChatSessionDriver
  /** Driver context minus the IO members this class supplies. */
  ctx: Omit<ChatDriverContext, 'write' | 'emit' | 'addHistory'>
  hooks: ChatProcessHooks
  /** In-process child: its pid can be probed for liveness. */
  probeable: boolean
}

export type StopOutcome = 'exited' | 'killed' | 'abandoned'

export class ChatProcess implements OutboxProcess {
  /** Execution identity is per process, distinct from its conversation id. */
  execution: AgentExecution | null = null
  expectedMessageId: string | null = null
  lastEndedExecution: string | null = null
  readonly gen: number
  readonly spawnId: string
  readonly handle: ChatProcHandle
  readonly driver: ChatSessionDriver
  readonly probeable: boolean
  /** The OS confirmed the process runs. */
  spawned = false
  /** `driver.start` settled. */
  started = false
  /** Exited, abandoned, or failed to start: nothing it says counts any more. */
  ended = false
  /** Being replaced by a newer generation: nothing it says counts any more. */
  replaced = false
  /** Draining an old generation: retain its final output without driving a new turn. */
  retiring = false
  /**
   * The user interrupted a turn of this process (its 0-turn error is not a failed
   * resume). For the process's lifetime: the resume guard reads it, never reset.
   */
  interruptIssued = false
  /**
   * An interrupt went to the current turn: it is being stopped, nothing is added
   * to it ("Send now" is refused). Per turn, unlike `interruptIssued`: cleared
   * when the next turn starts.
   */
  stoppingTurn = false
  /**
   * `stopTurn` calls in progress on this process. Set before the stop's first
   * await, so "Send now" is refused from the moment a Stop is asked for — not
   * only once the interrupt is issued (`stoppingTurn`).
   */
  stopsPending = 0
  /**
   * Decided interrupts issued to this process so far (`stopTurn`, `recordInterrupted`,
   * an explicit control interrupt; never a durable control's provisional ACK, which is
   * rolled back unless decided). A turn start that runs after output preceding it
   * keeps the stop of an interrupt decided since.
   */
  interruptSeq = 0
  /**
   * The current turn's message was taken back (Stop before any output): the rest
   * of the turn is dropped at the door, up to and including its end.
   */
  discardTurn = false
  /**
   * Stop cut the running turn; it has not ended yet. What the CLI still streams
   * before it reads the interrupt is not drawn (the panel shows the turn stopped,
   * as the TUI does); its saved events still land. Cleared by the turn's result.
   */
  stoppedTurn = false
  /**
   * A message Stop took back after it was written but before the CLI started
   * its turn: the interrupt found nothing to stop, so when the CLI picks the
   * message up anyway it is withdrawn (still queued) or interrupted (started).
   */
  lateTurnOf: string | null = null
  /** A resume of this process was confirmed (or failed) — the guard is done with it. */
  resumeSettled = false
  resumeFailed = false
  /** Started as a fork (`--fork-session`) of that conversation, ending at that record. */
  fork: { fromSessionId: string; atMessageUuid: string } | null = null
  /** The host asked it to stop (kill, stop, watchdog): its exit is not the CLI refusing. */
  stopRequested = false
  /** The watchdog killed it as stuck and its exit restarts the agent. */
  watchdogRestart = false
  /** The watchdog initiated this process's teardown, regardless of restart budget. */
  watchdogKilled = false
  /** The CLI refused the fork (it exits at startup): the tab went back to the original. */
  forkFailed = false
  /** Open tool calls (id → bound), for the watchdog. */
  readonly openTools = new Map<string, OpenToolBound>()

  /** Resolves when started (spawned + driver started); rejects when it never will be. */
  readonly readyPromise: Promise<void>
  readonly exited: Promise<{ code: number | null; signal: string | null }>
  /** Physical process stop is independent of storage/pipe drain. */
  readonly physicalExit: Promise<void>
  private physicalEnded = false
  private readonly physicalExitListeners = new Set<() => void>()
  private resolvePhysical!: () => void

  private readonly hooks: ChatProcessHooks
  private resolveReady!: () => void
  private rejectReady!: (err: Error) => void
  private resolveExited!: (e: { code: number | null; signal: string | null }) => void
  private rejectExited!: (error: unknown) => void
  private handlingLine = false
  /** Terminal stdio EOF seals ingress synchronously; retained pre-EOF records still drain. */
  private inputEnded = false
  /** `driver.start` was called: lines can be handed to it. */
  private driverHasContext = false
  private readonly output: ChatOutputSpool
  /** `interruptSeq` at receipt of the spooled record being handled (`interruptsAtReceipt`). */
  private receivedInterrupts: number | null = null
  /** `afterAcceptedOutput` callbacks, by their marker in the output order. */
  private readonly afterOutput = new Map<string, () => void>()
  private readonly boundaries = new Map<
    string,
    { enter(): void; release(): void; resume(): void; gate: Promise<void> }
  >()
  private outputFailure: Error | null = null
  private stderrBuf = ''
  private stderrTimer: ReturnType<typeof setTimeout> | null = null
  private stderrEmitted = 0
  private stderrDropped = 0
  private readonly outputHolds = new Set<Promise<unknown>>()

  constructor(opts: ChatProcessOptions) {
    this.gen = opts.gen
    this.spawnId = opts.spawnId
    this.handle = opts.handle
    this.driver = opts.driver
    this.probeable = opts.probeable
    this.hooks = opts.hooks
    this.output = new ChatOutputSpool({
      flow: (paused) => this.handle.setOutputPaused?.(paused),
      available: () => this.driverHasContext && !this.waitingForStorage,
      consume: (record) => {
        const [kind, value, interrupts] = JSON.parse(record) as
          | ['line', string, number]
          | ['event', AgentEvent, number]
          | ['history', AgentEvent[]]
          | ['boundary', string]
          | ['after', string]
        if (kind === 'line') this.whileReceivedAt(interrupts, () => this.handleLine(value))
        else if (kind === 'event') this.whileReceivedAt(interrupts, () => this.deliverEvent(value))
        else if (kind === 'history') this.hooks.onHistory?.(this, value)
        else if (kind === 'after') this.runAfterOutput(value)
        else {
          const boundary = this.boundaries.get(value)
          if (boundary) {
            this.holdOutputUntil(boundary.gate)
            boundary.enter()
          }
        }
      },
      failure: (error) => {
        this.outputFailure ??= error
        this.deliverEvent({
          kind: 'error',
          message: 'Chat output buffering failed',
          detail: { cause: error.message }
        })
        this.kill('SIGKILL')
      }
    })
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    // Observed: a start failure is reported through the hooks; an unawaited
    // `readyPromise` must not become an unhandled rejection.
    this.readyPromise.catch(() => undefined)
    this.exited = new Promise((resolve, reject) => {
      this.resolveExited = resolve
      this.rejectExited = reject
    })
    this.exited.catch(() => undefined)
    this.physicalExit = new Promise((resolve) => {
      this.resolvePhysical = resolve
    })
    this.handle.onPhysicalExit?.(() => this.markPhysicalExit())

    const ctx: ChatDriverContext = {
      ...opts.ctx,
      write: (line) => {
        // Fire-and-forget by contract; a failure surfaces as the process ending.
        this.handle.write(line + '\n').catch(() => undefined)
      },
      send: (line, writeOpts) => {
        const p = this.handle.write(line + '\n', writeOpts)
        // Observed here too, so a caller that drops it never leaves an
        // unhandled rejection; callers that care await it.
        p.catch(() => undefined)
        return p
      },
      emit: (event) => this.emit(event),
      waitForOutput: () => this.output.acceptInput(),
      afterReceivedOutput: (fn) => this.afterAcceptedOutput(fn),
      addHistory: (events) => {
        if (this.ended || this.replaced) return
        if (!this.handlingLine && (this.waitingForStorage || this.output.busy))
          this.output.push(JSON.stringify(['history', events]))
        else this.hooks.onHistory?.(this, events)
      }
    }

    let spawnScheduled = false
    this.handle.onSpawn(() => {
      // Once per process, however often the signal repeats.
      if (this.ended || this.spawned || spawnScheduled) return
      spawnScheduled = true
      queueMicrotask(() => {
        if (this.ended) return
        this.spawned = true
        let committed: void | Promise<void>
        try {
          committed = this.hooks.onSpawned(this)
        } catch (error) {
          committed = Promise.reject(error)
        }
        // Synchronously: the driver has its IO context before any stdout line.
        let starting: void | Promise<void>
        try {
          starting = this.driver.start(ctx)
        } catch (err) {
          starting = Promise.reject(err)
        }
        this.driverHasContext = true
        this.output.pump()
        Promise.all([starting, committed]).then(
          () => {
            if (this.ended) return
            this.started = true
            this.resolveReady()
          },
          (err: unknown) => {
            const error = err instanceof Error ? err : new Error(String(err))
            this.emit({ kind: 'error', message: error.message, detail: { phase: 'driver-start' } })
            this.rejectReady(error)
          }
        )
      })
    })

    // Framing stays hub-side; the driver owns parsing. A line that arrives
    // before the driver has its context waits for it (never dropped).
    const lines = createLineSplitter((line) => {
      if (this.ended || this.replaced || this.inputEnded) return
      if (this.driverHasContext && this.driver.handleControlLine?.(line)) return
      if (!this.driverHasContext || this.waitingForStorage || this.output.busy) {
        this.output.push(JSON.stringify(['line', line, this.interruptSeq]))
      } else this.handleLine(line)
    })
    this.handle.onStdout(lines)
    // Routed output the computer no longer held: drop the torn line (never merge
    // its halves into one corrupt line) and say what happened.
    let toldUnconfirmed = false
    this.handle.onWritesUnconfirmed?.(() => {
      if (toldUnconfirmed) return
      toldUnconfirmed = true
      this.emit({
        kind: 'notice',
        id: randomUUID(),
        level: 'warning',
        code: 'computer-outdated',
        text: 'This agent’s computer runs an older SlayZone that does not confirm messages, so one lost on the way is not noticed. The hub’s Computers tab in Settings names the computer and how to update it.'
      })
    })
    this.handle.onGap?.(() => {
      lines.gap()
      this.emit({
        kind: 'notice',
        id: randomUUID(),
        level: 'warning',
        code: 'output-gap',
        text: 'Part of the agent’s output was lost on the way from its computer; the reply above may be incomplete.'
      })
    })
    this.handle.onStderr((chunk) => {
      if (!this.inputEnded) this.bufferStderr(chunk)
    })
    this.handle.onExit(({ code, signal }) => {
      this.inputEnded = true
      this.markPhysicalExit()
      void this.flushOutput().then(
        () => this.finish(code, signal, false),
        () => this.finish(code, signal, false)
      )
    })
    this.handle.onError((err) => {
      if (!this.spawned && this.stopRequested) {
        // Stopped before it started (a restart replacing a start still queued on
        // its computer): the start's cancellation IS the stop we asked for — it
        // ends as a stopped process, never as "The agent couldn't start".
        this.finish(null, null, false)
        return
      }
      if (!this.spawned) {
        for (const boundary of this.boundaries.values()) boundary.release()
        this.ended = true
        this.clearStderrTimer()
        this.rejectReady(err)
        this.markPhysicalExit()
        this.hooks.onStartError(this, err)
        void this.output.close().then(
          () => this.resolveExited({ code: null, signal: null }),
          (cleanup) =>
            this.rejectExited(
              new AggregateError([err, cleanup], 'Chat startup cleanup failed', { cause: err })
            )
        )
        return
      }
      this.emit({ kind: 'error', message: err.message, detail: { name: err.name } })
    })
  }

  get pid(): number {
    return this.handle.pid
  }

  /** Event consumption waits for storage; raw/control input continues via bounded spill. */
  get waitingForStorage(): boolean {
    return this.outputHolds.size > 0
  }

  get outputBufferStats() {
    return this.output.stats
  }

  /** A causal cut in accepted stdout. Later records spill while the durable
   * control operation waits for admission; protocol ACKs keep their own lane. */
  outputBoundary(capture?: () => void) {
    const id = randomUUID()
    let enter!: () => void,
      reject!: (error: Error) => void,
      resume!: () => void,
      entered = false
    const ready = new Promise<void>((yes, no) => {
      enter = () => {
        entered = true
        capture?.()
        yes()
      }
      reject = no
    })
    const gate = new Promise<void>((r) => {
      resume = r
    })
    void ready.catch(() => undefined)
    const release = () => {
      this.boundaries.delete(id)
      resume()
      if (!entered) reject(new Error('Chat control output boundary was cancelled'))
    }
    this.boundaries.set(id, { enter, release, resume, gate })
    this.output.push(JSON.stringify(['boundary', id]))
    return { ready, release, resume }
  }

  /**
   * Run `fn` once every output record accepted before this call has been handled
   * (at once when none waits). A write registers after the output that preceded
   * it, as it did when output was handled the moment it arrived.
   */
  afterAcceptedOutput(fn: () => void): void {
    if (this.ended || this.replaced) return
    if (this.handlingLine || !(this.waitingForStorage || this.output.busy)) {
      fn()
      return
    }
    const id = randomUUID()
    this.afterOutput.set(id, fn)
    this.output.push(JSON.stringify(['after', id]))
  }

  private runAfterOutput(id: string): void {
    const fn = this.afterOutput.get(id)
    this.afterOutput.delete(id)
    if (!fn || this.ended || this.replaced) return
    // Handled in line order: what it emits is delivered in place, like a line's.
    this.handlingLine = true
    try {
      fn()
    } catch (err) {
      console.error('[chat-process] after-output callback threw:', err)
    } finally {
      this.handlingLine = false
    }
  }

  holdOutputUntil(work: Promise<unknown>): void {
    if (this.outputHolds.has(work)) return
    this.outputHolds.add(work)
    const release = () => {
      this.outputHolds.delete(work)
      if (!this.outputHolds.size) this.output.pump()
    }
    void work.then(release, release)
  }

  async flushOutput(): Promise<void> {
    for (;;) {
      await Promise.allSettled([...this.outputHolds])
      if (this.ended) {
        await this.output.close()
        if (this.outputFailure) throw this.outputFailure
      } else await this.output.drain()
      if (!this.outputHolds.size && !this.output.busy) return
    }
  }

  /** Retry only physical close after a previously failed exit. The original
   * exit rejection remains observable; a lost output/write prefix never heals. */
  async settleExit(retryClose = false): Promise<void> {
    try {
      await this.exited
    } catch (original) {
      if (!retryClose || !this.ended || !this.physicalEnded || this.outputFailure) throw original
      try {
        await this.output.close()
      } catch (cleanup) {
        throw new AggregateError([original, cleanup], 'Chat physical cleanup retry failed', {
          cause: original
        })
      }
    }
  }

  /** Started and able to take a write. */
  get ready(): boolean {
    return this.spawned && this.started && !this.ended && !this.replaced
  }

  // OutboxProcess
  get confirmsDelivery(): boolean {
    return this.driver.confirmsDelivery === true
  }

  /** Reads a message's attached files (the driver builds the line). Agents without it take text only. */
  prepare(message: OutgoingUserMessage): Promise<unknown> {
    if (this.driver.prepareUserTurn) return this.driver.prepareUserTurn(message)
    return Promise.reject(new Error(NO_ATTACHMENTS))
  }

  send(message: OutgoingUserMessage, prepared?: unknown): Promise<void> {
    if (!this.ready) return Promise.reject(new Error('the agent process is not running'))
    if (this.driver.sendUserTurn) {
      return this.driver.sendUserTurn(message, prepared as PreparedUserTurn | undefined)
    }
    // A text-only driver (Codex): attached files would silently vanish — refuse.
    if (message.content.some((b) => b.type !== 'text'))
      return Promise.reject(new Error(NO_ATTACHMENTS))
    return Promise.resolve(this.driver.sendUserMessage(userMessageText(message.content)))
  }

  kill(signal: string): void {
    if (!this.stopRequested) {
      this.stopRequested = true
      try {
        this.hooks.onStopRequested?.(this)
      } catch {
        /* an observer never prevents the stop */
      }
    }
    try {
      this.handle.kill(signal)
    } catch {
      /* already gone — the exit (or the watchdog) settles it */
    }
  }

  /**
   * SIGTERM, wait; SIGKILL, wait; then give up on it (`abandoned`: its exit was
   * never confirmed — a routed process whose computer is unreachable). Either
   * way it is ended afterwards and nothing it still sends is accepted.
   */
  async stop(termGraceMs = 2000, killGraceMs = 2000): Promise<StopOutcome> {
    if (this.ended) return this.physicalEnded ? 'exited' : 'abandoned'
    this.kill('SIGTERM')
    if (await this.waitExit(termGraceMs)) return 'exited'
    this.kill('SIGKILL')
    if (await this.waitExit(killGraceMs)) return 'killed'
    this.finish(null, 'SIGKILL', true)
    return 'abandoned'
  }

  /** End it without an OS exit (a missed or unconfirmable exit). Idempotent. */
  reap(code: number | null, signal: string | null): void {
    this.finish(code, signal, true)
  }

  private waitExit(ms: number): Promise<boolean> {
    if (this.physicalEnded) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms)
      timer.unref?.()
      void this.physicalExit.then(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  /**
   * `interruptSeq` when the record being handled was received (the current one for
   * output handled the moment it arrives). A turn start it causes keeps the stop of
   * an interrupt decided after it arrived.
   */
  get interruptsAtReceipt(): number {
    return this.receivedInterrupts ?? this.interruptSeq
  }

  private whileReceivedAt(interrupts: number | undefined, handle: () => void): void {
    const outer = this.receivedInterrupts
    this.receivedInterrupts = interrupts ?? null
    try {
      handle()
    } finally {
      this.receivedInterrupts = outer
    }
  }

  private handleLine(line: string): void {
    if (this.ended || this.replaced) return
    this.handlingLine = true
    try {
      this.driver.handleLine(line)
    } catch (err) {
      console.error('[chat-process] driver.handleLine threw:', err)
    } finally {
      this.handlingLine = false
    }
  }

  private emit(event: AgentEvent): void {
    if (
      !this.ended &&
      !this.replaced &&
      !this.handlingLine &&
      (this.waitingForStorage || this.output.busy)
    ) {
      this.output.push(JSON.stringify(['event', event, this.interruptSeq]))
      return
    }
    this.deliverEvent(event)
  }

  private deliverEvent(event: AgentEvent): void {
    if (this.ended || this.replaced) {
      this.hooks.onStale?.(this, event)
      return
    }
    this.hooks.onEvent(this, event)
  }

  private finish(code: number | null, signal: string | null, unconfirmed: boolean): void {
    if (this.ended) return
    for (const boundary of this.boundaries.values()) boundary.release()
    // An ended process registers no more writes.
    this.afterOutput.clear()
    if (!unconfirmed) this.markPhysicalExit()
    // Last words first, while it still counts.
    this.clearStderrTimer()
    this.flushStderr(true)
    this.ended = true
    this.replaced ||= this.retiring
    if (!this.spawned) this.rejectReady(new Error(`exited before it started (code ${code})`))
    else if (!this.started) this.rejectReady(new Error('exited before its driver started'))
    // Ended BEFORE dispose: whatever the driver emits while tearing down (Codex
    // rejects its in-flight requests into a late error/result) is dropped.
    try {
      this.driver.dispose()
    } catch (err) {
      console.error('[chat-process] driver.dispose threw:', err)
    }
    void this.output.close().then(
      () => {
        if (this.outputFailure) this.rejectExited(this.outputFailure)
        else this.resolveExited({ code, signal })
        this.hooks.onExit(this, code, signal, unconfirmed || !!this.outputFailure)
      },
      (error) => {
        this.rejectExited(error)
        this.hooks.onExit(this, code, signal, true)
      }
    )
  }

  get physicallyExited(): boolean {
    return this.physicalEnded
  }

  onPhysicalExit(listener: () => void): () => void {
    if (this.physicalEnded) {
      listener()
      return () => {
        /* Already observed. */
      }
    }
    this.physicalExitListeners.add(listener)
    return () => {
      this.physicalExitListeners.delete(listener)
    }
  }

  private markPhysicalExit(): void {
    if (this.physicalEnded) return
    this.physicalEnded = true
    // Physical exit cannot wait for a control cut to drain. Keep its marker for
    // a committing decision to capture the prefix, but unblock the output gate.
    for (const boundary of this.boundaries.values()) boundary.resume()
    this.resolvePhysical()
    for (const listener of [...this.physicalExitListeners]) listener()
    this.physicalExitListeners.clear()
  }

  private bufferStderr(chunk: string): void {
    if (this.ended || this.replaced) return
    this.stderrBuf += chunk
    if (this.stderrBuf.length > STDERR_MAX_CHUNK * 4) this.flushStderr(false)
    if (!this.stderrTimer) {
      this.stderrTimer = setTimeout(() => {
        this.stderrTimer = null
        this.flushStderr(false)
      }, STDERR_FLUSH_INTERVAL_MS)
    }
  }

  private flushStderr(final: boolean): void {
    let text = this.stderrBuf
    this.stderrBuf = ''
    if (text) {
      const room = STDERR_MAX_TOTAL - this.stderrEmitted
      if (room <= 0) {
        this.stderrDropped += text.length
        text = ''
      } else {
        const limit = Math.min(STDERR_MAX_CHUNK, room)
        if (text.length > limit) {
          this.stderrDropped += text.length - limit
          text = text.slice(0, limit)
        }
      }
      if (text) {
        this.stderrEmitted += text.length
        this.emit({ kind: 'stderr', text })
      }
    }
    if (this.stderrDropped > 0 && (final || this.stderrEmitted < STDERR_MAX_TOTAL)) {
      this.emit({
        kind: 'stderr',
        text: `[stderr truncated: ${this.stderrDropped} characters dropped]\n`
      })
      this.stderrDropped = 0
    }
  }

  private clearStderrTimer(): void {
    if (this.stderrTimer) clearTimeout(this.stderrTimer)
    this.stderrTimer = null
  }
}
