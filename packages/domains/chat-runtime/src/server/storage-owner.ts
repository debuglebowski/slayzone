/** Async host facade. This module never opens SQLite or synchronously waits on a worker. */
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { MessageChannel } from 'node:worker_threads'
import type { SlayzoneDb } from '@slayzone/platform'
import {
  openSqliteWorker,
  serializeError,
  type SqliteWorkerHandle
} from '@slayzone/platform/sqlite-worker'
import { attachCheckpointer } from './checkpointer'
import { chatStorageDigest } from './storage-digest'
import type { ChatStorage } from './storage'
import {
  CHAT_STORAGE_OWNER_KIND,
  STORAGE_METHODS,
  type StorageOwnerData,
  type StorageMethod,
  type StorageCall,
  type StorageMaintenanceCall,
  type OwnerControl,
  type HostControl,
  type StorageOwnerTxnRegistry
} from './storage-owner-protocol'

type AsyncMethods<T> = {
  [K in keyof T as T[K] extends (...args: never[]) => unknown ? K : never]: T[K] extends (
    ...args: infer A
  ) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never
}
type SimpleStorage = Pick<ChatStorage, StorageMethod>
export type AsyncChatStorage = Omit<
  AsyncMethods<SimpleStorage>,
  'getRecord' | 'maintenanceCursor' | 'queueMessageIdentity'
> & {
  readonly dir: string
  readonly path: string
  readonly db: SlayzoneDb<StorageOwnerTxnRegistry>
  getRecord<T>(...args: Parameters<ChatStorage['getRecord']>): Promise<T | null>
  maintenanceCursor<T>(key: string): Promise<T | null>
  queueMessageIdentity<T>(
    taskId: string,
    messageId: string
  ): Promise<{ conversationId: string; value: T } | null>
  flush(): Promise<void>
  close(): Promise<void>
  shutdown(): Promise<void>
  terminate(): Promise<void>
  acquireBlobLease(label: string, ttlMs: number): Promise<{ release(): Promise<void> }>
  maintenance: {
    fileStats(): Promise<ReturnType<ChatStorage['maintenance']['fileStats']>>
    tempPath(): Promise<string>
    connectionEpoch(): Promise<number>
    secondaryConnections(): Promise<string[]>
    registerSecondary(label: string): Promise<{ release(): Promise<void> }>
    pauseCheckpointer(): Promise<void>
    resumeCheckpointer(): Promise<void>
    checkpointNow(): Promise<Awaited<ReturnType<ChatStorage['maintenance']['checkpointNow']>>>
    swapIn(path: string): Promise<{ holdMs: number }>
  }
}
export interface OpenStorageOwnerOptions {
  stateDir: string
  hubScope: string
  /** Explicit composition-root entry. The domain never imports the computer app. */
  workerPath: string
  checkpointIntervalMs?: number
  checkpointerRetryMs?: number
  onUnexpectedExit?(error: Error): void
}

const owned = new Map<string, symbol>()
export async function openChatStorageOwner(
  opts: OpenStorageOwnerOptions
): Promise<AsyncChatStorage> {
  if (!opts.hubScope.trim()) throw new Error('Hub storage scope is required')
  await mkdir(opts.stateDir, { recursive: true, mode: 0o700 })
  const stateDir = await realpath(opts.stateDir)
  const dir = join(stateDir, 'computer-runtime', chatStorageDigest(opts.hubScope))
  if (owned.has(dir)) throw new Error('Chat storage already has an owner')
  const token = Symbol(dir)
  owned.set(dir, token)
  const path = join(dir, 'chat.sqlite')
  const { port1, port2 } = new MessageChannel()
  const activeLeases = new Set<Promise<void>>()
  let stopped = false,
    closing: Promise<void> | null = null,
    cleanup: Promise<void> | null = null
  let terminated = false
  let unexpected: Error | null = null
  let checkpointerWanted = false
  let retry: ReturnType<typeof setTimeout> | null = null
  const post = (message: HostControl) => {
    if (!stopped) port1.postMessage(message)
  }
  const scheduleRetry = () => {
    if (retry || stopped || !checkpointerWanted) return
    retry = setTimeout(async () => {
      retry = null
      if (stopped || !checkpointerWanted) return
      await checkpointer.open()
      if (stopped || !checkpointerWanted) return
      if (checkpointer.active) post({ type: 'recovered' })
      else scheduleRetry()
    }, opts.checkpointerRetryMs ?? 1000)
    retry.unref()
  }
  const checkpointer = attachCheckpointer(path, {
    intervalMs: opts.checkpointIntervalMs,
    onFailure: (message) => {
      post({ type: 'failed', message })
      scheduleRetry()
    }
  })
  port1.on('message', (request: OwnerControl) => {
    if (request.type !== 'request') return
    void (async () => {
      try {
        let result: unknown
        if (request.operation === 'open') {
          checkpointerWanted = true
          await checkpointer.open()
          if (!checkpointer.active) throw new Error('Shared checkpointer unavailable')
        } else if (request.operation === 'checkpoint') result = await checkpointer.checkpoint()
        else {
          checkpointerWanted = false
          if (retry) clearTimeout(retry)
          retry = null
          await checkpointer.close(!!request.final)
        }
        post({ type: 'reply', id: request.id, ok: true, result })
      } catch (error) {
        post({ type: 'reply', id: request.id, ok: false, error: serializeError(error) })
      }
    })()
  })
  port1.unref()
  const release = () => {
    if (cleanup) return cleanup
    stopped = true
    checkpointerWanted = false
    if (retry) clearTimeout(retry)
    cleanup = (async () => {
      try {
        await Promise.all([...activeLeases])
        await checkpointer.close(false)
      } finally {
        port1.close()
        port2.close()
        if (owned.get(dir) === token) owned.delete(dir)
      }
    })()
    return cleanup
  }
  let raw: SqliteWorkerHandle<StorageOwnerTxnRegistry>
  try {
    const data: StorageOwnerData = {
      kind: CHAT_STORAGE_OWNER_KIND,
      stateDir,
      hubScope: opts.hubScope,
      checkpointIntervalMs: opts.checkpointIntervalMs,
      control: port2
    }
    raw = await openSqliteWorker<StorageOwnerTxnRegistry>({
      label: 'chat storage owner',
      workerPath: opts.workerPath,
      workerData: data,
      transferList: [port2],
      onUnexpectedExit: (error) => {
        if (!terminated) unexpected = error
        void release().catch((cleanupError) =>
          console.error('[chat-storage] owner cleanup failed:', cleanupError)
        )
        opts.onUnexpectedExit?.(error)
      }
    })
  } catch (error) {
    try {
      await release()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Chat storage startup cleanup failed', {
        cause: error
      })
    }
    throw error
  }
  let issued = 0
  const db = new Proxy(raw as SlayzoneDb<StorageOwnerTxnRegistry>, {
    get(target, key) {
      if (key === 'close') return () => close()
      if (key === 'prepare')
        return (sql: string) => ({
          get: (...args: unknown[]) => {
            if (closing || stopped) return Promise.reject(new Error('Chat storage is closed'))
            issued++
            return target.prepare(sql).get(...args)
          },
          all: (...args: unknown[]) => {
            if (closing || stopped) return Promise.reject(new Error('Chat storage is closed'))
            issued++
            return target.prepare(sql).all(...args)
          },
          run: (...args: unknown[]) => {
            if (closing || stopped) return Promise.reject(new Error('Chat storage is closed'))
            issued++
            return target.prepare(sql).run(...args)
          }
        })
      const value = Reflect.get(target, key, target)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        if (closing || stopped) return Promise.reject(new Error('Chat storage is closed'))
        issued++
        return Reflect.apply(value, target, args)
      }
    }
  })
  const call = <K extends StorageMethod>(method: K, args: Parameters<ChatStorage[K]>) =>
    db.namedTxn('chatStorage.call', { method, args } as StorageCall) as Promise<
      Awaited<ReturnType<ChatStorage[K]>>
    >
  let flushing: { through: number; promise: Promise<void> } | null = null
  const flush = () => {
    if (closing || stopped) return Promise.reject(new Error('Chat storage is closed'))
    const through = issued
    if (flushing && flushing.through >= through) return flushing.promise
    // A flush is not a new mutation: concurrent callers of the same prefix share it.
    const promise = raw.namedTxn('chatStorage.flush', {})
    const current = { through, promise }
    flushing = current
    void promise
      .finally(() => {
        if (flushing === current) flushing = null
      })
      .catch(() => undefined)
    return promise
  }
  const close = () => {
    if (closing) return closing
    if (terminated || unexpected) return release()
    closing = (async () => {
      await Promise.all([...activeLeases])
      let primary: unknown
      try {
        await raw.namedTxn('chatStorage.prepareClose', {})
      } catch (error) {
        primary = error
      }
      try {
        await raw.close()
      } catch (error) {
        primary = primary
          ? new AggregateError([primary, error], 'Chat storage close failed', { cause: primary })
          : error
      }
      try {
        await release()
      } catch (error) {
        if (primary)
          throw new AggregateError([primary, error], 'Chat storage close failed', {
            cause: primary
          })
        throw error
      }
      if (primary) throw primary
    })()
    return closing
  }
  const lease = async (operation: 'blob' | 'secondary', label: string, ttlMs?: number) => {
    // Reserve the lifetime before posting: close may race the creation reply.
    let finish: () => void = () => undefined
    const lifetime = new Promise<void>((resolve) => {
      finish = resolve
    })
    activeLeases.add(lifetime)
    const finished = () => {
      activeLeases.delete(lifetime)
      finish()
    }
    let id: string
    try {
      id = (await db.namedTxn('chatStorage.lease', { operation, label, ttlMs })) as string
    } catch (error) {
      finished()
      throw error
    }
    let releasing: Promise<void> | null = null
    return {
      release(): Promise<void> {
        return (releasing ??= (async () => {
          try {
            // Accepted helper lifetimes must still finish after admission closes.
            // An exited owner needs no SQL release, but its physical helper must end.
            if (!stopped) {
              issued++
              await raw.namedTxn('chatStorage.lease', { operation: 'release', label: id })
            }
          } finally {
            finished()
          }
        })())
      }
    }
  }
  const maintenance = Object.fromEntries(
    [
      'fileStats',
      'tempPath',
      'connectionEpoch',
      'secondaryConnections',
      'pauseCheckpointer',
      'resumeCheckpointer',
      'checkpointNow',
      'swapIn'
    ].map((method) => [
      method,
      (...args: unknown[]) =>
        db.namedTxn('chatStorage.maintenance', { method, args } as StorageMaintenanceCall)
    ])
  )
  return Object.assign(
    Object.fromEntries(
      STORAGE_METHODS.map((method) => [
        method,
        (...args: Parameters<ChatStorage[typeof method]>) => call(method, args)
      ])
    ),
    {
      dir,
      path,
      db,
      flush,
      close,
      async shutdown() {
        if (terminated || unexpected)
          throw new Error('Chat storage is unavailable', { cause: unexpected })
        await close()
      },
      async terminate() {
        terminated = true
        try {
          await raw.terminate()
        } finally {
          await release()
        }
      },
      acquireBlobLease: (label: string, ttlMs: number) => lease('blob', label, ttlMs),
      maintenance: Object.assign(maintenance, {
        registerSecondary: (label: string) => lease('secondary', label)
      })
    }
  ) as unknown as AsyncChatStorage
}
