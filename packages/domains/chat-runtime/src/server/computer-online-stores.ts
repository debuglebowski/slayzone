import { createChatStoreFaults } from './computer-store-faults'
import { createStoreRequests } from './computer-store-requests'
import { handleStoreTesting } from './computer-store-testing'
/** One online native owner. No process controller or provider backend is constructed here. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { serializeError } from '@slayzone/platform/sqlite-worker'
import type { DataImportKinds } from './task-data'
import type { ChatStorage } from './storage'
import type { CompactionWorkerFactory } from './compaction-worker-host'
import { createChatStoreServices } from './computer-chat-stores'
import { createChatStoreJobs } from './computer-chat-store-jobs'
import { createComputerStoreControl } from './computer-store-control'
import { capturedTimelineRecords, type ChatMetadataUpdate } from './local-data'
import {
  STORE_METHODS,
  type StoreCall,
  type StoreModels,
  type StoreNotification,
  type OnlineStoreData,
  type HostCall,
  type TimelineCall
} from './computer-store-protocol'
import type { TurnGit } from './agent-turns'
import type { ConversationHealIo } from './conversation-heal'

export function createOnlineChatStores(
  storage: ChatStorage,
  data: OnlineStoreData & { stateDir: string; hubScope: string },
  host: {
    call(request: HostCall): Promise<unknown>
    notify(message: StoreNotification): void
    copyWorker: CompactionWorkerFactory
  },
  imports?: DataImportKinds
) {
  const publications = new AsyncLocalStorage<{ batch: StoreNotification[]; closed: boolean }>()
  const pending = new Set<Promise<unknown>>()
  const resumeTokens = new Map<string, string>()
  let closed = false
  let durabilityFailure: unknown
  const assertAvailable = () => {
    if (durabilityFailure) throw durabilityFailure
  }
  const publish = (message: StoreNotification) => {
    if (closed || durabilityFailure) return
    if (message.type === 'metadata') {
      const update = message.update,
        current = storage.conversation(update.conversationId)
      if (
        !current ||
        current.state !== 'active' ||
        current.identity.epoch !== update.epoch ||
        !storage.getRecord(update.conversationId, 'settings', `metadata:${update.operationId}`)
      )
        return
      message = { ...message, update: { ...update, storeId: storage.storeId() } }
    }
    if (message.type === 'sessions' || message.type === 'changed') {
      const owner = storage.forTab(message.tabId)
      if (
        !message.owner ||
        owner?.state !== 'active' ||
        owner.identity.id !== message.owner.id ||
        owner.identity.epoch !== message.owner.epoch
      )
        return
    }
    host.notify(message)
  }
  const notify = (message: StoreNotification) => {
    if (message.type === 'sessions' || message.type === 'changed') {
      const owner = storage.forTab(message.tabId)
      if (!owner) return
      message = { ...message, owner: owner.identity }
    }
    const batch = publications.getStore()
    if (batch && !batch.closed) {
      batch.batch.push(message)
      return
    }
    // Background maintenance has no host request to carry its durability boundary.
    const work = Promise.resolve()
      .then(() => storage.flush())
      .then(() => publish(message))
    pending.add(work)
    void work.then(
      () => pending.delete(work),
      (error) => {
        pending.delete(work)
        durabilityFailure = error
        host.notify({ type: 'failure', error: serializeError(error) })
      }
    )
  }
  const turnGit = Object.fromEntries(
    ['canonical', 'snapshot', 'deleteTurnRef', 'diffIsEmpty', 'filterTurns'].map((method) => [
      method,
      (...args: unknown[]) => host.call({ group: 'turnGit', method, args } as HostCall)
    ])
  ) as unknown as TurnGit
  const healIo = Object.fromEntries(
    ['locate', 'listTranscriptIds', 'readTranscriptMeta', 'currentBranch', 'retentionMs'].map(
      (method) => [
        method,
        (...args: unknown[]) => host.call({ group: 'heal', method, args } as HostCall)
      ]
    )
  ) as unknown as ConversationHealIo
  const options = {
    stateDir: data.stateDir,
    hubScope: data.hubScope,
    computerId: data.computerId,
    maintenance: false,
    ...(imports ? { dataImports: imports } : {}),
    ...(data.hostTurnGit ? { turnGit } : {}),
    ...(data.hostHeal ? { healIo } : {}),
    blobBackfill: data.blobBackfill,
    markerBackfill: data.markerBackfill,
    compaction: { ...data.compaction, workerFactory: host.copyWorker },
    onMetadata: (update: ChatMetadataUpdate) => notify({ type: 'metadata', update }),
    log: (line: string) => host.notify({ type: 'log', line })
  }
  const services = createChatStoreServices(storage, options, {
    sessionsChanged: (tabId) => notify({ type: 'sessions', tabId }),
    available: assertAvailable,
    artifactAccess: (taskId, work) => jobs.retention.access(taskId, work),
    failure: (error) => {
      durabilityFailure ??= error
      host.notify({ type: 'failure', error: serializeError(error) })
    }
  })
  const jobs = createChatStoreJobs(services, options, {
    async quiesce(owner) {
      const token = randomUUID()
      resumeTokens.set(token, owner.identity.taskId)
      try {
        const accepted = await host.call({ group: 'quiesce', token, owner })
        if (!accepted) {
          resumeTokens.delete(token)
          return false
        }
        return {
          resume: async () => {
            await host.call({ group: 'restore', token, resume: true })
          },
          release: async () => {
            try {
              await host.call({ group: 'restore', token, resume: false })
            } finally {
              resumeTokens.delete(token)
            }
          }
        }
      } catch (error) {
        resumeTokens.delete(token)
        throw error
      }
    },
    changed: (tabId) => notify({ type: 'changed', tabId })
  })
  const control = createComputerStoreControl(services, jobs)
  const groups: StoreModels = {
    ...services,
    ...jobs,
    control,
    artifactPublication: services.artifacts.publication,
    faults: createChatStoreFaults({ ...services, ...jobs }),
    requests: createStoreRequests({ ...services, ...jobs }),
    testing: {
      handle: (request) =>
        handleStoreTesting(
          { ...services, ...jobs },
          {
            busy: async (tabId) =>
              !!(await host.call({ group: 'test-tab', tabId, action: 'busy' })),
            remove: async (tabId) => {
              await host.call({ group: 'test-tab', tabId, action: 'remove' })
            }
          },
          request
        )
    }
  }
  const allowed = new Map(
    Object.entries(STORE_METHODS).map(([group, methods]) => [group, new Set<string>(methods)])
  )
  const changes = () =>
    storage.compose((db) => db.prepare('SELECT total_changes() n').get() as { n: number }).n
  function tasks(args: unknown[]): string[] {
    const exact = new Set<string>(),
      ids = new Set<string>()
    const visit = (value: unknown, depth: number) => {
      if (!value || depth <= 0) return
      if (Array.isArray(value)) {
        for (const item of value.slice(0, 1000)) visit(item, depth - 1)
        return
      }
      if (typeof value !== 'object') return
      for (const [key, item] of Object.entries(value)) {
        if ((key === 'taskId' || key === 'task_id') && typeof item === 'string') exact.add(item)
        else if (['identity', 'route', 'value', 'args', 'items', 'scope'].includes(key))
          visit(item, depth - 1)
        if ((key === 'tabId' || key === 'id') && typeof item === 'string' && item.length <= 500)
          ids.add(item)
      }
    }
    for (const arg of args) visit(arg, 5)
    if (typeof args[0] === 'string' && args[0].length <= 500) ids.add(args[0])
    if (ids.size)
      storage.compose((db) => {
        const keys = JSON.stringify([...ids])
        for (const row of db
          .prepare(
            'SELECT DISTINCT task_id FROM conversations WHERE id IN (SELECT value FROM json_each(?)) OR tab_id IN (SELECT value FROM json_each(?)) OR task_id IN (SELECT value FROM json_each(?))'
          )
          .all(keys, keys, keys) as Array<{ task_id: string }>)
          exact.add(row.task_id)
        // Queue edits and immutable artifact references name their item, not the tab.
        for (const row of db
          .prepare(
            "SELECT DISTINCT c.task_id FROM records r JOIN conversations c ON c.id=r.conversation_id WHERE r.kind='queue' AND r.id IN (SELECT value FROM json_each(?)) UNION SELECT task_id FROM task_artifacts WHERE id IN (SELECT value FROM json_each(?))"
          )
          .all(keys, keys) as Array<{ task_id: string }>)
          exact.add(row.task_id)
      })
    return [...exact].sort()
  }
  async function execute(
    args: unknown[],
    work: () => unknown | Promise<unknown>,
    resumeToken?: string,
    maintenance = false,
    ownDurability = false
  ): Promise<unknown> {
    const perform = async () => {
      assertAvailable()
      const batch: StoreNotification[] = []
      const capture = { batch, closed: false }
      return publications.run(capture, async () => {
        try {
          const before = changes(),
            epoch = storage.maintenance.connectionEpoch()
          const result = await work()
          // Includes microtask metadata from the native transaction body.
          await Promise.resolve()
          if (!ownDurability) assertAvailable()
          if (
            !ownDurability &&
            (changes() !== before ||
              epoch !== storage.maintenance.connectionEpoch() ||
              batch.length)
          ) {
            try {
              await storage.flush()
            } catch (error) {
              durabilityFailure = error
              host.notify({ type: 'failure', error: serializeError(error) })
              throw error
            }
          }
          if (!ownDurability) assertAvailable()
          for (const message of batch) publish(message)
          return result
        } finally {
          capture.closed = true
        }
      })
    }
    const keys = maintenance || jobs.closing() ? [] : tasks(args)
    const access = async (index: number): Promise<unknown> => {
      if (index >= keys.length) return perform()
      const key = keys[index]
      if (resumeToken && resumeTokens.get(resumeToken) === key) return access(index + 1)
      return jobs.retention.access(key, () => access(index + 1))
    }
    return access(0)
  }
  return {
    services,
    jobs,
    control,
    execute,
    assertAvailable,
    async call(request: StoreCall) {
      if (request.group === 'control' && request.method === 'prepareClose')
        return control.prepareClose()
      if (
        request.group === 'artifactPublication' &&
        (request.method === 'status' || request.method === 'cancel')
      )
        return Reflect.apply(
          groups.artifactPublication[request.method],
          groups.artifactPublication,
          request.args
        )
      assertAvailable()
      if (!allowed.get(request.group)?.has(request.method))
        throw new Error('Unknown online store operation')
      let parent: unknown = groups[request.group]
      const path = request.method.split('.')
      for (const key of path.slice(0, -1)) {
        if (!parent || !Object.hasOwn(parent, key)) throw new Error('Unknown store group')
        parent = (parent as Record<string, unknown>)[key]
      }
      const method = (parent as Record<string, unknown>)[path.at(-1)!]
      if (typeof method !== 'function') throw new Error('Store operation unavailable')
      const maintenance =
        request.group === 'artifactPublication' ||
        ['retention', 'blobBackfill', 'markerBackfill', 'compaction'].includes(request.group) ||
        (request.group === 'control' && ['prepareClose', 'finishErasure'].includes(request.method))
      return execute(
        request.args,
        () => Reflect.apply(method, parent, request.args),
        request.resumeToken,
        maintenance,
        request.group === 'artifactPublication'
      )
    },
    timeline(request: TimelineCall) {
      if (request.operation === 'open')
        return execute(
          [request.tabId],
          () => ({ owner: services.local.owner(request.tabId), storeId: storage.storeId() }),
          request.resumeToken
        )
      if (request.storeId !== storage.storeId()) throw new Error('Timeline store identity changed')
      const records = capturedTimelineRecords(storage, request.owner)
      if (!Object.hasOwn(records, request.method)) throw new Error('Unknown timeline operation')
      return execute(
        [request.owner],
        () => Reflect.apply(records[request.method]!, records, request.args),
        request.resumeToken
      )
    },
    async close() {
      const errors: unknown[] = []
      for (const work of [
        () => jobs.stop(),
        () => services.transfers.close(),
        () => services.artifacts.close(),
        () => Promise.all([...pending])
      ]) {
        try {
          await work()
        } catch (error) {
          errors.push(error)
        }
      }
      closed = true
      if (errors.length)
        throw new AggregateError(errors, 'Online chat store cleanup failed', { cause: errors[0] })
    }
  }
}
export type OnlineChatStores = ReturnType<typeof createOnlineChatStores>
