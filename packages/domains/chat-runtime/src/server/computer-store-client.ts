/** Data-only async facade over the owner's closed compiled registry. */
import { join } from 'node:path'
import type { AsyncChatStorage } from './storage-owner'
import {
  STORE_METHODS,
  type AsyncStoreModels,
  type StoreCall,
  type TimelineCall
} from './computer-store-protocol'
import type { ConversationIdentity } from '../shared'
import type { TimelineRecordStore } from '@slayzone/terminal/timeline-records'

export function createComputerStoreClient(
  storage: AsyncChatStorage,
  hooks: {
    before?(group: string, method: string, args: unknown[]): void
    resumeToken(group: string, method: string, args: unknown[]): string | undefined
    issued(work: Promise<unknown>, token: string | undefined): void
  }
) {
  const call = (group: string, method: string, args: unknown[]) => {
    hooks.before?.(group, method, args)
    const resumeToken = hooks.resumeToken(group, method, args)
    const work = storage.db.namedTxn('chatRuntime.call', {
      group,
      method,
      args,
      resumeToken
    } as StoreCall)
    hooks.issued(work, resumeToken)
    return work
  }
  const groups: Record<string, Record<string, unknown>> = {}
  for (const [group, methods] of Object.entries(STORE_METHODS)) {
    const target: Record<string, unknown> = (groups[group] = {})
    for (const method of methods) {
      let parent = target
      const path = method.split('.')
      for (const key of path.slice(0, -1)) parent = (parent[key] ??= {}) as Record<string, unknown>
      parent[path.at(-1)!] = (...args: unknown[]) => call(group, method, args)
    }
  }
  const remote = groups as unknown as AsyncStoreModels
  remote.backups.dir = join(storage.dir, 'backups')
  remote.backups.archiveDir = join(storage.dir, 'archives')
  remote.local.data.timelineRecords = (tabId): TimelineRecordStore => {
    const openingToken = hooks.resumeToken('timeline', 'open', [tabId])
    const opening = storage.db.namedTxn('chatRuntime.timeline', {
      operation: 'open',
      tabId,
      resumeToken: openingToken
    }) as Promise<{ owner: ConversationIdentity; storeId: string }>
    hooks.issued(opening, openingToken)
    void opening.catch(() => undefined)
    const invoke = (method: keyof TimelineRecordStore, args: unknown[]) => {
      const resumeToken = hooks.resumeToken('timeline', method, [tabId])
      const work = (async () => {
        const captured = await opening
        return storage.db.namedTxn('chatRuntime.timeline', {
          operation: 'call',
          ...captured,
          method,
          args,
          resumeToken
        } as TimelineCall)
      })()
      hooks.issued(work, resumeToken)
      return work
    }
    return {
      load: (key) => invoke('load', [key]) as ReturnType<TimelineRecordStore['load']>,
      pageIds: () => invoke('pageIds', []) as ReturnType<TimelineRecordStore['pageIds']>,
      loadSummaries: () =>
        invoke('loadSummaries', []) as ReturnType<
          NonNullable<TimelineRecordStore['loadSummaries']>
        >,
      searchPages: (needle) =>
        invoke('searchPages', [needle]) as ReturnType<
          NonNullable<TimelineRecordStore['searchPages']>
        >,
      save: async (write) => {
        await invoke('save', [write])
      },
      discard: async () => {
        await invoke('discard', [])
      }
    }
  }
  return remote
}
