/** Bundled into the computer executable as source; no second executable or SQLite writer. */
import { parentPort } from 'node:worker_threads'
import { TimelineProjection, type TimelineProjectionStore } from './chat-timeline-projection'
import { timelineStoreFromRecords, type TimelineRecordStore } from './chat-timeline-records'
import type {
  ProjectionMethod,
  Reply,
  StoreCall,
  WorkerCall,
  WorkerNotice
} from './chat-timeline-worker-protocol'

const port = parentPort!
const projections = new Map<number, TimelineProjection>()
const chains = new Map<number, Promise<unknown>>()
let nextId = 0
const pending = new Map<number, { resolve(value: unknown): void; reject(err: Error): void }>()
function storeCall(
  projectionId: number,
  raw: boolean,
  method: StoreCall['method'],
  args: unknown[]
): Promise<unknown> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    port.postMessage({ type: 'store', id, projectionId, raw, method, args } satisfies StoreCall)
  })
}
function storeProxy(
  projectionId: number,
  raw: boolean,
  metadata: boolean
): TimelineProjectionStore {
  if (raw) {
    const records: TimelineRecordStore = {
      load: (key) =>
        storeCall(projectionId, true, 'load', [key]) as ReturnType<TimelineRecordStore['load']>,
      pageIds: () =>
        storeCall(projectionId, true, 'pageIds', []) as ReturnType<TimelineRecordStore['pageIds']>,
      ...(metadata
        ? {
            loadSummaries: () =>
              storeCall(projectionId, true, 'loadSummaries', []) as Promise<
                Array<{ page: number; summary: string }>
              >,
            searchPages: (needle: string) =>
              storeCall(projectionId, true, 'searchPages', [needle]) as Promise<number[]>
          }
        : {}),
      save: async (write) => {
        await storeCall(projectionId, true, 'save', [write])
      },
      discard: async () => {
        await storeCall(projectionId, true, 'discard', [])
      }
    }
    return timelineStoreFromRecords(records)
  }
  return Object.fromEntries(
    ['loadCheckpoint', 'loadPages', 'loadSummaries', 'save', 'searchPages', 'discard'].map(
      (method) => [
        method,
        (...args: unknown[]) => storeCall(projectionId, false, method as StoreCall['method'], args)
      ]
    )
  ) as unknown as TimelineProjectionStore
}
async function invoke(msg: WorkerCall): Promise<unknown> {
  if (msg.method === 'begin') {
    const opts = msg.args[0] as {
      lastSeq: number
      agentStartedTurns: boolean
      pageBudgetBytes?: number
      raw: boolean
      metadata: boolean
    }
    const { projection, from } = await TimelineProjection.begin({
      ...opts,
      store: storeProxy(msg.projectionId, opts.raw, opts.metadata),
      onError: (what, err) =>
        port.postMessage({
          type: 'notice',
          projectionId: msg.projectionId,
          what,
          error: err instanceof Error ? err.message : String(err)
        } satisfies WorkerNotice)
    })
    projections.set(msg.projectionId, projection)
    return from
  }
  const projection = projections.get(msg.projectionId)
  if (!projection) throw new Error('Timeline worker projection is closed')
  const method = msg.method as Exclude<ProjectionMethod, 'begin'>
  const fn = projection[method] as (...args: unknown[]) => unknown
  const result = await fn.apply(projection, msg.args)
  if (method === 'close') projections.delete(msg.projectionId)
  return result
}
port.on('message', (msg: WorkerCall | Reply) => {
  if (msg.type === 'result') {
    const call = pending.get(msg.id)
    if (!call) return
    pending.delete(msg.id)
    if (msg.ok) call.resolve(msg.value)
    else call.reject(new Error(msg.error))
    return
  }
  const run = (chains.get(msg.projectionId) ?? Promise.resolve()).then(() => invoke(msg))
  chains.set(
    msg.projectionId,
    run.catch(() => undefined)
  )
  void run
    .then(
      (value) =>
        port.postMessage({
          type: 'result',
          id: msg.id,
          ok: true,
          value,
          usable: projections.get(msg.projectionId)?.usable
        } satisfies Reply),
      (err: unknown) =>
        port.postMessage({
          type: 'result',
          id: msg.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        } satisfies Reply)
    )
    .finally(() => {
      if (msg.method === 'close') chains.delete(msg.projectionId)
    })
})
