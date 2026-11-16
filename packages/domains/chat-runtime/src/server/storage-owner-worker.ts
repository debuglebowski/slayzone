/** Computer bundle worker branch. SQLite is opened only after this branch is selected. */
import { isMainThread, threadId } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import { serveSqliteWorker } from '@slayzone/platform/sqlite-worker-host'
import { deserializeError } from '@slayzone/platform/sqlite-worker'
import {
  openChatStorage,
  EventBlobUnavailableError,
  type ChatExportReader,
  type ChatStorage
} from './storage'
import { assembleComputerChatRuntime } from './computer-runtime'
import type { CompactionWorkerFactory, WorkerHandle } from './compaction-worker-host'
import type { StoreCheckpointer, CheckpointResult } from './checkpointer'
import {
  CHAT_STORAGE_OWNER_KIND,
  STORAGE_METHODS,
  EXPORT_READER_METHODS,
  type StorageOwnerData,
  type HostControl,
  type CopyControl,
  type StorageCall,
  type StorageLeaseCall,
  type StorageMaintenanceCall,
  type StorageOwnerTxns
} from './storage-owner-protocol'

export function serveChatStorageOwner(): void {
  if (isMainThread) throw new Error('Chat storage must be owned by a worker')
  let storage: ChatStorage
  let runtime: ReturnType<typeof assembleComputerChatRuntime> | undefined
  let control: StorageOwnerData['control']
  const leases = new Map<string, { release(): void }>()
  const readers = new Map<string, ChatExportReader>()
  const allowed = new Set<string>(STORAGE_METHODS)
  const txns: StorageOwnerTxns = {
    'chatMaintenance.eraseTask': async (_db, { taskId, revision }) => {
      if (!runtime) throw new Error('Chat maintenance profile is not open')
      return runtime.eraseTask(taskId, revision)
    },
    'chatStorage.exportReader': (_db, request) => {
      if (request.operation === 'open') {
        const reader = storage.openExportReader(...request.args)
        const token = randomUUID()
        readers.set(token, reader)
        const { identity, migrationId, eventCount, recordCount, receiptCount } = reader
        return { token, identity, migrationId, eventCount, recordCount, receiptCount }
      }
      const reader = readers.get(request.token)
      if (request.operation === 'close') {
        reader?.close()
        readers.delete(request.token)
        return
      }
      if (!reader) throw new Error('Export reader closed')
      if (!(EXPORT_READER_METHODS as readonly string[]).includes(request.call.method))
        throw new Error('Unknown export reader operation')
      // Match the native reader: its caller records an export failure once.
      const fn = reader[request.call.method] as (...args: unknown[]) => unknown
      return fn(...request.call.args)
    },
    'chatStorage.exportFault': (_db, { id, error }) => {
      if (error.name !== 'EventBlobUnavailableError' || typeof error.props?.sha256 !== 'string')
        return
      const restored = new EventBlobUnavailableError(error.props.sha256, 'unavailable', {
        cause: deserializeError(error)
      })
      restored.message = error.message
      storage.recordExportBlobFault(id, restored)
    },
    'chatStorage.call': (_db, call: StorageCall) => {
      if (!allowed.has(call.method)) throw new Error('Unknown chat storage operation')
      const fn = storage[call.method] as (...args: unknown[]) => unknown
      return fn(...call.args)
    },
    'chatStorage.flush': () => storage.flush(),
    'chatStorage.prepareClose': () => storage.maintenance.releasePauseForClose(),
    'chatStorage.lease': (_db, call: StorageLeaseCall) => {
      if (call.operation === 'release') {
        leases.get(call.label)?.release()
        leases.delete(call.label)
        return
      }
      const token = randomUUID()
      leases.set(
        token,
        call.operation === 'secondary'
          ? storage.maintenance.registerSecondary(call.label)
          : storage.acquireBlobLease(call.label, call.ttlMs!)
      )
      return token
    },
    'chatStorage.maintenance': (_db, call: StorageMaintenanceCall) => {
      if (!Object.hasOwn(storage.maintenance, call.method))
        throw new Error('Unknown maintenance operation')
      const fn = storage.maintenance[call.method] as (...args: unknown[]) => unknown
      return fn(...call.args)
    }
  }
  serveSqliteWorker<StorageOwnerData>({
    label: 'chat storage owner',
    txns,
    open: async (data) => {
      if (data.kind !== CHAT_STORAGE_OWNER_KIND) throw new Error('Unknown chat storage worker kind')
      control = data.control
      const bridge = createCheckpointerBridge(control)
      try {
        storage = openChatStorage({
          ...data,
          ownerWorker: { createCheckpointer: (_path, hooks) => bridge.bind(hooks) }
        })
        const db = storage.compose((db) => db)
        db.function('chat_storage_owner_thread', () => threadId)
        if (data.maintenance) {
          runtime = assembleComputerChatRuntime(storage, {
            stateDir: data.stateDir,
            hubScope: data.hubScope,
            computerId: data.maintenance.computerId,
            maintenance: true,
            compaction: { workerFactory: bridge.copyWorker }
          })
          // The offline caller verified every old host/process group stopped.
          // Clear only its abandoned ephemeral leases, before admitting work.
          storage.transaction(() =>
            db.exec('DELETE FROM blob_leases; DELETE FROM artifact_blob_leases;')
          )
        }
        await storage.flush()
        return db
      } catch (error) {
        const errors: unknown[] = [error]
        try {
          await (runtime ? runtime.close() : storage?.shutdown())
        } catch (cleanupError) {
          errors.push(cleanupError)
        }
        try {
          await bridge.close()
        } catch (cleanupError) {
          errors.push(cleanupError)
        } finally {
          control.close()
        }
        if (errors.length > 1)
          throw new AggregateError(errors, 'Chat runtime startup cleanup failed', { cause: error })
        throw error
      }
    },
    connectionEpoch: () => storage.maintenance.connectionEpoch(),
    close: async () => {
      try {
        const errors: unknown[] = []
        const attempt = async (work: () => unknown) => {
          try {
            await work()
          } catch (error) {
            errors.push(error)
          }
        }
        for (const reader of readers.values()) await attempt(() => reader.close())
        readers.clear()
        for (const lease of leases.values()) await attempt(() => lease.release())
        leases.clear()
        await attempt(() => (runtime ? runtime.close() : storage.shutdown()))
        if (errors.length === 1) throw errors[0]
        if (errors.length)
          throw new AggregateError(errors, 'Storage owner cleanup failed', { cause: errors[0] })
      } finally {
        control.close()
      }
    }
  })
}

function createCheckpointerBridge(port: StorageOwnerData['control']) {
  let next = 0,
    active = false
  let opening: Promise<void> | null = null
  let hooks: { onFailure(message: string): void; onRecovered(): void }
  const copies = new Map<string, { spec: Parameters<CompactionWorkerFactory>[0]; exited(): void }>()
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  port.on('message', (message: HostControl) => {
    if (message.type === 'copy-progress') {
      copies.get(message.token)?.spec.progress(message.bytes)
      return
    }
    if (message.type === 'copy-exit') {
      const copy = copies.get(message.token)
      if (copy) {
        copies.delete(message.token)
        copy.spec.registration?.release()
        copy.spec.exit()
        copy.exited()
      }
      return
    }
    if (message.type === 'failed') {
      active = false
      hooks.onFailure(message.message)
      return
    }
    if (message.type === 'recovered') {
      active = true
      hooks.onRecovered()
      return
    }
    const call = pending.get(message.id)
    if (!call) return
    pending.delete(message.id)
    if (message.ok) call.resolve(message.result)
    else call.reject(deserializeError(message.error))
  })
  const send = (
    body: CopyControl | { operation: 'open' | 'close' | 'checkpoint'; final?: boolean }
  ) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++next
      pending.set(id, { resolve, reject })
      port.postMessage({ type: 'request', id, ...body })
    })
  const request = (operation: 'open' | 'close' | 'checkpoint', final?: boolean) =>
    send({ operation, final })
  const copyWorker: CompactionWorkerFactory = (spec) => {
    const token = randomUUID()
    let exited: () => void = () => undefined
    const physicalExit = new Promise<void>((resolve) => {
      exited = resolve
    })
    copies.set(token, { spec, exited })
    const { registration: _registration, exit: _exit, progress: _progress, ...input } = spec
    let state: 'building' | 'idle' | 'copying' | 'finishing' = 'building'
    const ready = send({ operation: 'copy-start', token, spec: input }).then((value) => {
      state = 'idle'
      return value as Awaited<WorkerHandle['ready']>
    })
    return {
      ready,
      async copy(tables, keys) {
        state = 'copying'
        await send({ operation: 'copy-delta', token, tables, keys })
        state = 'idle'
      },
      async finish(check) {
        state = 'finishing'
        const result = await send({ operation: 'copy-finish', token, check })
        await physicalExit
        return result as string
      },
      busyNative: () => state === 'finishing',
      async terminate() {
        await send({ operation: 'copy-terminate', token })
        await physicalExit
      }
    }
  }
  const open = () => {
    if (active) return opening ?? Promise.resolve()
    active = true
    opening = request('open')
      .then(
        () => {
          hooks.onRecovered()
        },
        (error) => {
          active = false
          hooks.onFailure(error instanceof Error ? error.message : String(error))
        }
      )
      .finally(() => {
        opening = null
      })
    return opening
  }
  const close = async (final = false) => {
    await opening
    active = false
    // Main may have a retry pending even when the old registration already failed.
    await request('close', final)
  }
  const api: StoreCheckpointer = {
    get active() {
      return active
    },
    open,
    flush: async () => {
      throw new Error('Use the owner FULL fence, never the checkpointer for acknowledgements')
    },
    checkpoint: async () => {
      await opening
      return (await request('checkpoint')) as CheckpointResult
    },
    close,
    closeSync: () => {
      if (active) throw new Error('Await the owner shutdown before closing SQLite')
    }
  }
  return {
    bind(value: typeof hooks) {
      hooks = value
      return api
    },
    close,
    copyWorker
  }
}
