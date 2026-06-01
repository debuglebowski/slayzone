import { Worker } from 'node:worker_threads'
import type { WorkerRequest, WorkerResponse } from './worker-protocol'

// Distributive Omit: `Omit<Union, 'id'>` collapses a discriminated union to its
// common keys (losing `sql`/`ops`/etc). This distributes over each member so
// callers can pass any request shape minus the `id` the client assigns.
type WorkerRequestInput = WorkerRequest extends infer T
  ? T extends { id: string }
    ? Omit<T, 'id'>
    : never
  : never

/**
 * Main-thread side of the DB worker RPC. Owns the `Worker`, correlates each
 * request with its response by id, and queues calls issued before the worker
 * finishes its startup sequence (legacy migration → pragmas → backup →
 * migrations → normalizations). The `ready` promise resolves once the worker
 * posts `{ type: 'ready' }`; until then, sent requests buffer and flush in
 * order. Worker crash/exit rejects the ready promise and every pending call so
 * callers never hang.
 *
 * `id` is a per-process monotonic counter — cheaper than a UUID and collision
 * free within a single worker's lifetime.
 */
export class WorkerRpcClient {
  private readonly worker: Worker
  private readonly pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()
  private readonly preReadyQueue: WorkerRequest[] = []
  private isReady = false
  private nextId = 0
  private terminated = false

  readonly ready: Promise<void>

  constructor(workerPath: string, workerData: unknown) {
    this.worker = new Worker(workerPath, { workerData })

    this.ready = new Promise<void>((resolve, reject) => {
      this.worker.on('message', (msg: WorkerResponse) => {
        if ('type' in msg && msg.type === 'ready') {
          this.isReady = true
          for (const req of this.preReadyQueue) this.worker.postMessage(req)
          this.preReadyQueue.length = 0
          resolve()
          return
        }
        if ('type' in msg && msg.type === 'init-error') {
          reject(new Error(`DB worker init failed: ${msg.error}`))
          return
        }
        if ('id' in msg) {
          const entry = this.pending.get(msg.id)
          if (!entry) return
          this.pending.delete(msg.id)
          if (msg.ok) entry.resolve(msg.result)
          else entry.reject(new Error(msg.error))
        }
      })

      this.worker.on('error', (err) => {
        this.failAll(err)
        reject(err)
      })

      this.worker.on('exit', (code) => {
        if (code !== 0 && !this.terminated) {
          this.failAll(new Error(`DB worker exited with code ${code}`))
        }
      })
    })
  }

  private failAll(err: Error): void {
    for (const { reject } of this.pending.values()) reject(err)
    this.pending.clear()
    this.preReadyQueue.length = 0
  }

  send<T>(req: WorkerRequestInput): Promise<T> {
    if (this.terminated) return Promise.reject(new Error('DB worker terminated'))
    const id = String(this.nextId++)
    const full = { ...req, id } as WorkerRequest
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      if (this.isReady) this.worker.postMessage(full)
      else this.preReadyQueue.push(full)
    })
  }

  async close(): Promise<void> {
    this.terminated = true
    this.failAll(new Error('DB worker closing'))
    await this.worker.terminate()
  }
}
