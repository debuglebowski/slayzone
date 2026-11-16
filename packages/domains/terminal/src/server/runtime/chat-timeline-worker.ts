import type { Worker } from 'node:worker_threads'
import type {
  BeginTimelineProjection,
  TimelineProjectionHandle,
  TimelineProjectionStore
} from './chat-timeline-projection'
import type {
  ProjectionMethod,
  Reply,
  StoreCall,
  WorkerCall,
  WorkerNotice
} from './chat-timeline-worker-protocol'

/** One lazy worker per runtime, shared by its tabs; old handles fail if a worker dies. */
export function createTimelineWorkerPool(createWorker: () => Worker): {
  begin: BeginTimelineProjection
  close(): Promise<void>
} {
  let channel: TimelineWorkerChannel | undefined
  let closed = false
  const handles = new Set<TimelineProjectionHandle>()
  return {
    async begin(opts) {
      if (closed) throw new Error('Timeline worker pool is closed')
      if (!channel || channel.dead) channel = new TimelineWorkerChannel(createWorker())
      const current = channel
      const id = current.add(opts.store, opts.onError)
      try {
        const from = await current.call<number>(id, 'begin', [
          {
            lastSeq: opts.lastSeq,
            agentStartedTurns: opts.agentStartedTurns,
            pageBudgetBytes: opts.pageBudgetBytes,
            raw: !!opts.store.records,
            metadata: !!opts.store.records?.loadSummaries && !!opts.store.records?.searchPages
          }
        ])
        let ended = false
        let closing: Promise<void> | undefined
        const projection: TimelineProjectionHandle = {
          get usable() {
            return !ended && current.usable(id)
          },
          feed: (entries) => current.call(id, 'feed', [entries]),
          finish: () => current.call(id, 'finish', []),
          // A failed derived projection never stops saving or delivering chat events.
          apply: (entry) => current.call<void>(id, 'apply', [entry]).catch(() => undefined),
          openSnapshot: () => current.call(id, 'openSnapshot', []),
          pagesAsOf: (pages, seq, epoch) => current.call(id, 'pagesAsOf', [pages, seq, epoch]),
          searchPages: (query) => current.call(id, 'searchPages', [query]),
          flush: () => current.call(id, 'flush', []),
          close() {
            if (closing) return closing
            ended = true
            closing = (current.dead ? Promise.resolve() : current.call<void>(id, 'close', []))
              .catch((err) => {
                // Derived state is recoverable. A worker crash must not abort the
                // transport's later flush of authoritative events and queued work.
                if (!current.dead) throw err
              })
              .finally(() => {
                current.remove(id)
                handles.delete(projection)
              })
            return closing
          }
        }
        handles.add(projection)
        return { projection, from }
      } catch (err) {
        current.remove(id)
        throw err
      }
    },
    async close() {
      if (closed) return
      closed = true
      try {
        await Promise.allSettled([...handles].map((handle) => handle.close()))
      } finally {
        await channel?.terminate()
      }
    }
  }
}

class TimelineWorkerChannel {
  private nextId = 0
  private nextProjection = 0
  private stores = new Map<
    number,
    {
      store: TimelineProjectionStore
      usable: boolean
      onError?: (what: string, err: unknown) => void
    }
  >()
  private pending = new Map<
    number,
    { resolve(value: unknown): void; reject(err: Error): void; projectionId: number }
  >()
  dead: Error | null = null
  constructor(private readonly worker: Worker) {
    worker.on('message', (msg: Reply | StoreCall | WorkerNotice) => {
      if (msg.type === 'notice') {
        const binding = this.stores.get(msg.projectionId)
        if (binding) {
          if (binding.onError) binding.onError(msg.what, new Error(msg.error))
          else console.error(`[chat-timeline] ${msg.what}:`, msg.error)
        }
        return
      }
      if (msg.type === 'store') {
        void this.storeCall(msg)
        return
      }
      const call = this.pending.get(msg.id)
      if (!call) return
      this.pending.delete(msg.id)
      if (this.pending.size === 0) worker.unref()
      if (msg.usable === false) {
        const binding = this.stores.get(call.projectionId)
        if (binding) binding.usable = false
      }
      if (msg.ok) call.resolve(msg.value)
      else call.reject(new Error(`Timeline worker: ${msg.error}`))
    })
    worker.on('error', (err) => this.fail(err))
    worker.on('messageerror', (err) => this.fail(err))
    worker.on('exit', (code) => this.fail(new Error(`Timeline worker exited (code ${code})`)))
    worker.unref()
  }
  add(store: TimelineProjectionStore, onError?: (what: string, err: unknown) => void): number {
    const id = this.nextProjection++
    this.stores.set(id, { store, usable: true, onError })
    return id
  }
  remove(id: number): void {
    this.stores.delete(id)
  }
  usable(id: number): boolean {
    return !this.dead && !!this.stores.get(id)?.usable
  }
  private fail(err: Error, expected = false): void {
    if (this.dead) return
    this.dead = err
    if (!expected && this.stores.size > 0)
      console.error('[chat-timeline] worker failed; event replay remains available:', err)
    for (const call of this.pending.values()) call.reject(err)
    this.pending.clear()
    this.stores.clear()
    this.worker.unref()
    void this.worker.terminate()
  }
  call<T>(projectionId: number, method: ProjectionMethod, args: unknown[]): Promise<T> {
    if (this.dead) return Promise.reject(this.dead)
    const binding = this.stores.get(projectionId)
    if (!binding) return Promise.reject(new Error('Timeline worker projection is closed'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.worker.ref()
      this.pending.set(id, {
        projectionId,
        resolve: (value) => resolve(value as T),
        reject: (err) => {
          binding.usable = false
          reject(err)
        }
      })
      try {
        this.worker.postMessage({
          type: 'call',
          id,
          projectionId,
          method,
          args
        } satisfies WorkerCall)
      } catch (err) {
        this.fail(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }
  private async storeCall(msg: StoreCall): Promise<void> {
    const binding = this.stores.get(msg.projectionId)
    if (!binding || this.dead) return
    try {
      const target = msg.raw ? binding.store.records! : binding.store
      const fn = (target as unknown as Record<string, (...args: unknown[]) => unknown>)[msg.method]
      const value = await fn.apply(target, msg.args)
      if (!this.dead)
        this.worker.postMessage({ type: 'result', id: msg.id, ok: true, value } satisfies Reply)
    } catch (err) {
      if (!this.dead)
        this.worker.postMessage({
          type: 'result',
          id: msg.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        } satisfies Reply)
    }
  }
  async terminate(): Promise<void> {
    this.fail(new Error('Timeline worker is closed'), true)
    await this.worker.terminate()
  }
}
