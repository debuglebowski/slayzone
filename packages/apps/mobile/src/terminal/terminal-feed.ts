/**
 * Getting one pty session's output onto a terminal without a gap or a duplicate —
 * what desktop's terminal does at mount (`terminal-session-init.ts`), for a client
 * that only watches:
 *
 * 1. Subscribe to the live data (`pty.onData` for this session) FIRST; chunks that
 *    arrive while step 2 is in flight are queued.
 * 2. Attach (`pty.attach`, after seq -1): reset the terminal, size it to the session
 *    (`size` — the phone never resizes the agent's terminal), write the `prelude`
 *    (state an evicted head of the buffer left behind), then every buffered chunk.
 * 3. Replay the queue and go live, dropping every chunk at or below the last seq
 *    written. Seqs are per session, from 0, one per chunk, so a jump means chunks
 *    were missed: fill them from the buffer (`pty.getBufferSince`).
 *
 * After a reconnect (the subscription started again) the feed catches up from the
 * last seq it wrote instead of starting over. A process that replaced the session
 * (restart, reset) numbers from 0 again: a 0 after later seqs, or a buffer younger
 * than what was written, starts over from step 2.
 *
 * Plain class: the React side (`useTerminalFeed`) feeds it subscription events and
 * gives it a sink (the terminal view); tests give it fakes.
 */
import type { TerminalState } from '@slayzone/terminal-contracts'

export interface FeedBuffer {
  chunks: Array<{ seq: number; data: string }>
  currentSeq: number
  prelude?: string
}

/** `pty.attach`'s answer. */
export interface AttachResult {
  exists: boolean
  state: TerminalState | null
  buffer: FeedBuffer | null
  size?: { cols: number; rows: number } | null
}

/** The hub calls the feed makes (`pty.attach`, `pty.getBufferSince`). */
export interface FeedClient {
  attach(sessionId: string, afterSeq: number): Promise<AttachResult>
  bufferSince(sessionId: string, afterSeq: number): Promise<FeedBuffer | null>
}

/** Where the output goes: the terminal. */
export interface FeedSink {
  /** Clear everything (a fresh attach). */
  reset(): void
  write(data: string): void
  /** The session's size (never sent back to the hub). */
  resize(cols: number, rows: number): void
}

export interface FeedStatus {
  phase: 'attaching' | 'ready' | 'error'
  /** A process runs at the session id (`pty.attach` `exists`). */
  exists: boolean
  error: string | null
}

export class TerminalFeed {
  private lastSeq = -1
  private attached = false
  private syncing: Promise<void> | null = null
  private queue: Array<{ seq: number; data: string }> = []
  /** Bumped by every attach and by dispose: an older answer is ignored. */
  private generation = 0
  private exists = false

  constructor(
    private readonly sessionId: string,
    private readonly client: FeedClient,
    private readonly sink: FeedSink,
    private readonly onStatus: (status: FeedStatus) => void = () => undefined
  ) {}

  /**
   * The subscription is (again) delivering: attach the first time, catch up after
   * that. A call while one is in flight joins it.
   */
  start(): Promise<void> {
    if (this.syncing) return this.syncing
    return this.attached ? this.catchUp() : this.attach()
  }

  /** Start over from the full buffer (the terminal itself was recreated). */
  restart(): Promise<void> {
    return this.attach()
  }

  /** A live chunk (`pty.onData`). */
  data(seq: number, data: string): void {
    if (this.syncing || !this.attached) {
      this.queue.push({ seq, data })
      return
    }
    if (!this.deliver(seq, data)) this.queue.push({ seq, data })
  }

  /** The session's size changed (`pty.onResize`). */
  resize(cols: number, rows: number): void {
    this.sink.resize(cols, rows)
  }

  /** Stop: answers still in flight are dropped. */
  dispose(): void {
    this.generation++
    this.queue = []
  }

  /**
   * Write a live chunk, or start the sync it needs. False = a sync started and the
   * chunk waits for it (the caller queues it, in order).
   */
  private deliver(seq: number, data: string): boolean {
    if (seq <= this.lastSeq) {
      // A new process at this id numbers from 0 again: start over.
      if (seq === 0 && this.lastSeq > 0) {
        void this.attach()
        return false
      }
      return true // already written
    }
    if (seq > this.lastSeq + 1) {
      void this.catchUp()
      return false
    }
    this.sink.write(data)
    this.lastSeq = seq
    return true
  }

  private flushQueue(): void {
    while (this.queue.length > 0 && !this.syncing) {
      const next = this.queue.shift()!
      if (!this.deliver(next.seq, next.data)) {
        this.queue.unshift(next)
        return
      }
    }
  }

  private attach(): Promise<void> {
    const generation = ++this.generation
    this.onStatus({ phase: 'attaching', exists: this.exists, error: null })
    const run = (async () => {
      try {
        const result = await this.client.attach(this.sessionId, -1)
        if (generation !== this.generation) return
        this.sink.reset()
        if (result.size) this.sink.resize(result.size.cols, result.size.rows)
        this.lastSeq = -1
        const buffer = result.buffer
        if (buffer) {
          if (buffer.prelude) this.sink.write(buffer.prelude)
          for (const chunk of buffer.chunks) this.sink.write(chunk.data)
          this.lastSeq = buffer.currentSeq
        }
        this.attached = true
        this.exists = result.exists
        this.onStatus({ phase: 'ready', exists: result.exists, error: null })
      } catch (error) {
        if (generation !== this.generation) return
        this.onStatus({ phase: 'error', exists: this.exists, error: messageOf(error) })
      }
    })()
    return this.track(run, generation)
  }

  private catchUp(): Promise<void> {
    if (this.syncing) return this.syncing
    const generation = this.generation
    const run = (async () => {
      let startOver = false
      try {
        const buffer = await this.client.bufferSince(this.sessionId, this.lastSeq)
        if (generation !== this.generation || !buffer) return
        if (buffer.currentSeq < this.lastSeq) {
          // A younger buffer than the one written from: another process.
          startOver = true
          return
        }
        for (const chunk of buffer.chunks) {
          if (chunk.seq <= this.lastSeq) continue
          this.sink.write(chunk.data)
          this.lastSeq = chunk.seq
        }
        // Chunks evicted before they could be read are gone: go on from here.
        this.lastSeq = Math.max(this.lastSeq, buffer.currentSeq)
      } catch (error) {
        if (generation !== this.generation) return
        this.onStatus({ phase: 'error', exists: this.exists, error: messageOf(error) })
      } finally {
        if (startOver && generation === this.generation) {
          // Hand over to a fresh attach; it flushes the queue when it is done.
          this.syncing = null
          await this.attach()
        }
      }
    })()
    return this.track(run, generation)
  }

  /** Mark a sync in flight; when it ends (and is still current), replay the queue. */
  private track(run: Promise<void>, generation: number): Promise<void> {
    const tracked = run.finally(() => {
      if (this.syncing !== tracked) return
      this.syncing = null
      if (generation === this.generation) this.flushQueue()
    })
    this.syncing = tracked
    return tracked
  }
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
