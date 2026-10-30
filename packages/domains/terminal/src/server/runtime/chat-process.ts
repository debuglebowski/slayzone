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
import type { AgentEvent, OutgoingUserMessage } from '@slayzone/terminal-contracts'
import { userMessageText } from '@slayzone/terminal-contracts'
import type { ChatDriverContext, ChatSessionDriver } from '../agents/types'
import { createLineSplitter, type ChatProcHandle } from './chat-proc-handle'
import type { OpenToolBound } from './chat-watchdog'
import type { OutboxProcess } from './chat-outbox'

const STDERR_FLUSH_INTERVAL_MS = 100
/** Largest stderr event; the rest of a burst is summarized. */
const STDERR_MAX_CHUNK = 64 * 1024
/** stderr a single process may add to the history in total. */
const STDERR_MAX_TOTAL = 1024 * 1024

export interface ChatProcessHooks {
  /** The OS confirmed the process runs (before its driver starts). */
  onSpawned(proc: ChatProcess): void
  /** An event from the driver or the stderr buffer — current generation only. */
  onEvent(proc: ChatProcess, event: AgentEvent): void
  /** The process ended (or was given up on: `unconfirmed`). Fires once. */
  onExit(proc: ChatProcess, code: number | null, signal: string | null, unconfirmed: boolean): void
  /** It could not be started at all. */
  onStartError(proc: ChatProcess, err: Error): void
  /** An event arrived after this process ended or was replaced (dropped). */
  onStale?(proc: ChatProcess, event: AgentEvent): void
}

export interface ChatProcessOptions {
  gen: number
  spawnId: string
  handle: ChatProcHandle
  driver: ChatSessionDriver
  /** Driver context minus the IO members this class supplies. */
  ctx: Omit<ChatDriverContext, 'write' | 'emit'>
  hooks: ChatProcessHooks
  /** In-process child: its pid can be probed for liveness. */
  probeable: boolean
}

export type StopOutcome = 'exited' | 'killed' | 'abandoned'

export class ChatProcess implements OutboxProcess {
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
  /** The user interrupted a turn of this process (its 0-turn error is not a failed resume). */
  interruptIssued = false
  /**
   * The current turn's message was taken back (Stop before any output): the rest
   * of the turn is dropped at the door, up to and including its end.
   */
  discardTurn = false
  /** A resume of this process was confirmed (or failed) — the guard is done with it. */
  resumeSettled = false
  resumeFailed = false
  /** Started as a fork (`--fork-session`) of that conversation, ending at that record. */
  fork: { fromSessionId: string; atMessageUuid: string } | null = null
  /** The host asked it to stop (kill, stop, watchdog): its exit is not the CLI refusing. */
  stopRequested = false
  /** The CLI refused the fork (it exits at startup): the tab went back to the original. */
  forkFailed = false
  /** Open tool calls (id → bound), for the watchdog. */
  readonly openTools = new Map<string, OpenToolBound>()

  /** Resolves when started (spawned + driver started); rejects when it never will be. */
  readonly readyPromise: Promise<void>
  readonly exited: Promise<{ code: number | null; signal: string | null }>

  private readonly hooks: ChatProcessHooks
  private resolveReady!: () => void
  private rejectReady!: (err: Error) => void
  private resolveExited!: (e: { code: number | null; signal: string | null }) => void
  /** `driver.start` was called: lines can be handed to it. */
  private driverHasContext = false
  private readonly earlyLines: string[] = []
  private stderrBuf = ''
  private stderrTimer: ReturnType<typeof setTimeout> | null = null
  private stderrEmitted = 0
  private stderrDropped = 0

  constructor(opts: ChatProcessOptions) {
    this.gen = opts.gen
    this.spawnId = opts.spawnId
    this.handle = opts.handle
    this.driver = opts.driver
    this.probeable = opts.probeable
    this.hooks = opts.hooks
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    // Observed: a start failure is reported through the hooks; an unawaited
    // `readyPromise` must not become an unhandled rejection.
    this.readyPromise.catch(() => undefined)
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve
    })

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
      emit: (event) => this.emit(event)
    }

    this.handle.onSpawn(() => {
      // Once per process, however often the signal repeats.
      if (this.ended || this.spawned) return
      this.spawned = true
      this.hooks.onSpawned(this)
      // Synchronously: the driver has its IO context before any stdout line.
      let starting: void | Promise<void>
      try {
        starting = this.driver.start(ctx)
      } catch (err) {
        starting = Promise.reject(err)
      }
      this.driverHasContext = true
      for (const line of this.earlyLines.splice(0)) this.handleLine(line)
      Promise.resolve(starting).then(
        () => {
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

    // Framing stays hub-side; the driver owns parsing. A line that arrives
    // before the driver has its context waits for it (never dropped).
    this.handle.onStdout(
      createLineSplitter((line) => {
        if (!this.driverHasContext) this.earlyLines.push(line)
        else this.handleLine(line)
      })
    )
    this.handle.onStderr((chunk) => this.bufferStderr(chunk))
    this.handle.onExit(({ code, signal }) => this.finish(code, signal, false))
    this.handle.onError((err) => {
      if (!this.spawned) {
        this.ended = true
        this.clearStderrTimer()
        this.rejectReady(err)
        this.resolveExited({ code: null, signal: null })
        this.hooks.onStartError(this, err)
        return
      }
      this.emit({ kind: 'error', message: err.message, detail: { name: err.name } })
    })
  }

  get pid(): number {
    return this.handle.pid
  }

  /** Started and able to take a write. */
  get ready(): boolean {
    return this.spawned && this.started && !this.ended && !this.replaced
  }

  // OutboxProcess
  get confirmsDelivery(): boolean {
    return this.driver.confirmsDelivery === true
  }

  send(message: OutgoingUserMessage): Promise<void> {
    if (!this.ready) return Promise.reject(new Error('the agent process is not running'))
    if (this.driver.sendUserTurn) return this.driver.sendUserTurn(message)
    return Promise.resolve(this.driver.sendUserMessage(userMessageText(message.content)))
  }

  kill(signal: string): void {
    this.stopRequested = true
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
    if (this.ended) return 'exited'
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
    if (this.ended) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms)
      timer.unref?.()
      void this.exited.then(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  private handleLine(line: string): void {
    if (this.ended || this.replaced) return
    try {
      this.driver.handleLine(line)
    } catch (err) {
      console.error('[chat-process] driver.handleLine threw:', err)
    }
  }

  private emit(event: AgentEvent): void {
    if (this.ended || this.replaced) {
      this.hooks.onStale?.(this, event)
      return
    }
    this.hooks.onEvent(this, event)
  }

  private finish(code: number | null, signal: string | null, unconfirmed: boolean): void {
    if (this.ended) return
    // Last words first, while it still counts.
    this.clearStderrTimer()
    this.flushStderr(true)
    this.ended = true
    if (!this.spawned) this.rejectReady(new Error(`exited before it started (code ${code})`))
    else if (!this.started) this.rejectReady(new Error('exited before its driver started'))
    // Ended BEFORE dispose: whatever the driver emits while tearing down (Codex
    // rejects its in-flight requests into a late error/result) is dropped.
    try {
      this.driver.dispose()
    } catch (err) {
      console.error('[chat-process] driver.dispose threw:', err)
    }
    this.resolveExited({ code, signal })
    this.hooks.onExit(this, code, signal, unconfirmed)
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
