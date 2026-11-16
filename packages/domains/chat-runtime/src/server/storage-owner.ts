import type { OnlineStoreData, HostCall, StoreNotification } from './computer-store-protocol'
/** Async host facade. This module never opens SQLite or synchronously waits on a worker. */
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { MessageChannel } from 'node:worker_threads'
import type { WirePathScope } from '@slayzone/platform/path-scope'
import type { ChatScopeSnapshot } from './scope-authority'
import type { SlayzoneDb } from '@slayzone/platform'
import {
  openSqliteWorker,
  serializeError,
  type SqliteWorkerHandle
} from '@slayzone/platform/sqlite-worker'
import { createStorageCopyBroker } from './storage-copy-broker'
import { attachCheckpointer } from './checkpointer'
import { chatStorageDigest } from './storage-digest'
import type { ChatExportReader, ChatStorage } from './storage'
import {
  CHAT_STORAGE_OWNER_KIND,
  STORAGE_METHODS,
  type ExportReaderOpened,
  type ExportReaderMethod,
  type ExportReaderCall,
  type StorageOwnerData,
  type StorageMethod,
  type StorageCall,
  type StorageMaintenanceCall,
  type OwnerControl,
  type HostControl,
  type MaintenanceResult,
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
export type AsyncChatExportReader = Omit<ChatExportReader, ExportReaderMethod | 'close'> &
  AsyncMethods<Pick<ChatExportReader, ExportReaderMethod | 'close'>>
export type AsyncChatStorage = Omit<
  AsyncMethods<SimpleStorage>,
  'getRecord' | 'maintenanceCursor' | 'queueMessageIdentity'
> & {
  readScope(scope: WirePathScope): Promise<ChatScopeSnapshot>
  readonly dir: string
  readonly path: string
  readonly db: SlayzoneDb<StorageOwnerTxnRegistry>
  /** Physical writer exit, independent from lease-dependent close/cleanup. */
  readonly exited: Promise<void>
  openExportReader(
    ...args: Parameters<ChatStorage['openExportReader']>
  ): Promise<AsyncChatExportReader>
  recordExportBlobFault(id: string, error: unknown): Promise<void>
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
  online?: OnlineStoreData
  onHostRequest?(request: HostCall): Promise<unknown>
  onStoreNotification?(notification: StoreNotification): void
  checkpointIntervalMs?: number
  checkpointerRetryMs?: number
  onUnexpectedExit?(error: Error): void
}

const owned = new Map<string, symbol>()
export async function openChatStorageOwner(
  opts: OpenStorageOwnerOptions
): Promise<AsyncChatStorage> {
  return openStorageOwner(opts)
}

/** Offline caller group: the same canonical writer and worker-local runtime composition. */
export async function openChatMaintenanceOwner(
  opts: OpenStorageOwnerOptions & { computerId: string }
) {
  const storage = await openStorageOwner(opts, { computerId: opts.computerId })
  return {
    exited: storage.exited,
    eraseTask: async (taskId: string, revision: number) => {
      const result = storage.db.namedTxn('chatMaintenance.eraseTask', {
        taskId,
        revision
      }) as Promise<MaintenanceResult>
      // Admit the fence with the command. A concurrent close must drain both;
      // it must not close admission between the command reply and its fence.
      const durable = storage.flush()
      const [value] = await Promise.all([result, durable])
      return value
    },
    close: () => storage.close()
  }
}

async function openStorageOwner(
  opts: OpenStorageOwnerOptions,
  profile?: StorageOwnerData['maintenance']
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
  const copies = createStorageCopyBroker(post)
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
    if (request.type === 'store-notification') {
      opts.onStoreNotification?.(request.notification)
      return
    }
    if (request.type !== 'request') return
    void (async () => {
      try {
        let result: unknown
        if (
          request.operation === 'copy-start' ||
          request.operation === 'copy-delta' ||
          request.operation === 'copy-finish' ||
          request.operation === 'copy-terminate'
        ) {
          result = await copies.request(request)
        } else if (request.operation === 'runtime-host') {
          if (!opts.onHostRequest) throw new Error('Online host operation unavailable')
          result = await opts.onHostRequest(request.call)
        } else if (request.operation === 'open') {
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
        await copies.close()
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
      control: port2,
      maintenance: profile,
      online: opts.online
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
  const pending = new Set<Promise<unknown>>()
  const fences = new Set<Promise<void>>()
  const track = <T>(work: () => Promise<T>): Promise<T> => {
    issued++
    const result = work()
    pending.add(result)
    void result.then(
      () => pending.delete(result),
      () => pending.delete(result)
    )
    return result
  }
  const db = new Proxy(raw as SlayzoneDb<StorageOwnerTxnRegistry>, {
    get(target, key) {
      if (key === 'close') return () => close()
      if (key === 'prepare')
        return (sql: string) => ({
          get: (...args: unknown[]) => {
            if (closing || stopped) return Promise.reject(new Error('Chat storage is closed'))
            return track(() => target.prepare(sql).get(...args))
          },
          all: (...args: unknown[]) => {
            if (closing || stopped) return Promise.reject(new Error('Chat storage is closed'))
            return track(() => target.prepare(sql).all(...args))
          },
          run: (...args: unknown[]) => {
            if (closing || stopped) return Promise.reject(new Error('Chat storage is closed'))
            return track(() => target.prepare(sql).run(...args))
          }
        })
      const value = Reflect.get(target, key, target)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        if (closing || stopped) return Promise.reject(new Error('Chat storage is closed'))
        return track(() => Promise.resolve(Reflect.apply(value, target, args)))
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
    // Named operations may yield between bounded native slices. A fence covers
    // their completed commits, not merely the worker's receipt of their message.
    const promise = Promise.all([...pending]).then(() => raw.namedTxn('chatStorage.flush', {}))
    fences.add(promise)
    const current = { through, promise }
    flushing = current
    void promise
      .finally(() => {
        if (flushing === current) flushing = null
        fences.delete(promise)
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
        // Release a paused fence before waiting for accepted work; waiting in
        // the reverse order would make close wait on its own pause.
        const settled = await Promise.allSettled([...pending, ...fences])
        const failures = settled.flatMap((entry) =>
          entry.status === 'rejected' ? [entry.reason] : []
        )
        if (failures.length)
          throw new AggregateError(failures, 'Accepted storage work failed', { cause: failures[0] })
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
      readScope: (scope: WirePathScope) => db.namedTxn('chatAuthority.scope', scope),
      dir,
      path,
      db,
      exited: raw.exited,
      async openExportReader(
        ...args: Parameters<ChatStorage['openExportReader']>
      ): Promise<AsyncChatExportReader> {
        const { token, ...metadata } = (await db.namedTxn('chatStorage.exportReader', {
          operation: 'open',
          args
        })) as ExportReaderOpened
        let readerClosing: Promise<void> | null = null
        const read = <K extends ExportReaderMethod>(
          method: K,
          args: Parameters<ChatExportReader[K]>
        ) => {
          if (readerClosing) return Promise.reject(new Error('Export reader closed'))
          return db.namedTxn('chatStorage.exportReader', {
            operation: 'read',
            token,
            call: { method, args }
          } as ExportReaderCall) as Promise<ReturnType<ChatExportReader[K]>>
        }
        return {
          ...metadata,
          eventPage: (after) => read('eventPage', [after]),
          recordPage: (after) => read('recordPage', [after]),
          receiptPage: (after) => read('receiptPage', [after]),
          resolve: (event) => read('resolve', [event]),
          close(): Promise<void> {
            return (readerClosing ??= (async () => {
              // These readers belong to the writer, not external helper leases.
              // Its shutdown closes them; never wait for public close to release
              // a lifetime that public close is itself waiting for.
              if (closing || stopped || terminated || unexpected) {
                await raw.exited
                return
              }
              await track(() =>
                raw.namedTxn('chatStorage.exportReader', { operation: 'close', token })
              )
            })())
          }
        }
      },
      recordExportBlobFault: (id: string, error: unknown) =>
        db.namedTxn('chatStorage.exportFault', { id, error: serializeError(error) }),
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
