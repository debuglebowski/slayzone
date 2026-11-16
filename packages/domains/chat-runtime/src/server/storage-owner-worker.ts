/** Computer bundle worker branch. SQLite is opened only after this branch is selected. */
import { isMainThread, threadId } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import { serveSqliteWorker } from '@slayzone/platform/sqlite-worker-host'
import { deserializeError } from '@slayzone/platform/sqlite-worker'
import { openChatStorage, type ChatStorage } from './storage'
import type { StoreCheckpointer, CheckpointResult } from './checkpointer'
import {
  CHAT_STORAGE_OWNER_KIND,
  STORAGE_METHODS,
  type StorageOwnerData,
  type HostControl,
  type ControlRequest,
  type StorageCall,
  type StorageLeaseCall,
  type StorageMaintenanceCall,
  type StorageOwnerTxns
} from './storage-owner-protocol'

export function serveChatStorageOwner(): void {
  if (isMainThread) throw new Error('Chat storage must be owned by a worker')
  let storage: ChatStorage
  let control: StorageOwnerData['control']
  const leases = new Map<string, { release(): void }>()
  const allowed = new Set<string>(STORAGE_METHODS)
  const txns: StorageOwnerTxns = {
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
        await storage.flush()
        return db
      } catch (error) {
        try {
          await bridge.close()
        } finally {
          control.close()
        }
        throw error
      }
    },
    connectionEpoch: () => storage.maintenance.connectionEpoch(),
    close: async () => {
      try {
        for (const lease of leases.values()) lease.release()
        leases.clear()
        await storage.shutdown()
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
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  port.on('message', (message: HostControl) => {
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
  const request = (operation: ControlRequest['operation'], final?: boolean) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++next
      pending.set(id, { resolve, reject })
      port.postMessage({ type: 'request', id, operation, final } satisfies ControlRequest)
    })
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
    close
  }
}
