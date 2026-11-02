import type { WorkspaceChangesStore } from '@slayzone/terminal/runtime'
import type { WorkspaceChangesRecord, WorkspaceChangesEvent } from '@slayzone/terminal-contracts'
import type { ChatStorage } from './storage'
import type { createLocalChatData } from './local-data'

type Record = Omit<WorkspaceChangesRecord, 'status'> & {
  status: 'pending' | WorkspaceChangesRecord['status']
  needsRecoveryEvent?: boolean
}
export function createLocalWorkspaceStore(
  store: ChatStorage,
  local: ReturnType<typeof createLocalChatData>
): WorkspaceChangesStore {
  const read = (tabId: string, id: string): Record | null => {
    const o = store.forTab(tabId)
    return o ? store.getRecord(o.identity.id, 'workspace', id) : null
  }
  return {
    remove: async (tabId, id) => local.remove(tabId, 'workspace', id),
    begin: async (record) => {
      if (!read(record.tabId, record.id)) local.set(record.tabId, 'workspace', record.id, record)
    },
    save: async (record) => {
      if (!read(record.tabId, record.id)) throw new Error('Workspace capture no longer exists')
      local.set(record.tabId, 'workspace', record.id, record)
    },
    get: async (tabId, id) => {
      const r = read(tabId, id)
      if (!r) return null
      const { needsRecoveryEvent, ...record } = r
      return {
        ...record,
        files: r.files.map(({ diff, ...file }) => ({ ...file, diff: null, hasDiff: diff !== null }))
      }
    },
    getFileDiff: async (tabId, id, path) =>
      read(tabId, id)?.files.find((f) => f.path === path)?.diff ?? null,
    recover: async (tabId) =>
      store.transaction(() => {
        const o = store.forTab(tabId)
        if (!o) return []
        const events: WorkspaceChangesEvent[] = []
        for (const row of store.records(o.identity.id)) {
          if (row.kind !== 'workspace') continue
          const r = row.value as Record
          if (r.status !== 'pending' && !r.needsRecoveryEvent) continue
          const reason = 'Computer restarted before workspace capture completed.'
          local.set(tabId, 'workspace', r.id, {
            ...r,
            status: 'unavailable',
            reason,
            needsRecoveryEvent: true
          })
          events.push({
            kind: 'workspace-changes',
            tabId,
            captureId: r.id,
            messageId: r.messageId,
            status: 'unavailable',
            fileCount: 0,
            reason
          })
        }
        return events
      })
  }
}
