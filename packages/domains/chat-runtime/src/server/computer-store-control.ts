/** Compiled native groups; transactions never cross an await or a thread boundary. */
import { relative, isAbsolute, join, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChatStoreServices } from './computer-chat-stores'
import type { ChatStoreJobs } from './computer-chat-store-jobs'
import type { ChatBootstrap } from './local-data'
import type { ConversationIdentity } from '../shared'
import type { TransportDeps } from '@slayzone/terminal/runtime'
import {
  prepareStoredTaskErasure,
  finishStoredTaskErasure,
  markStoredTaskErasureCompacted
} from './erase-stored-task'

export function createComputerStoreControl(s: ChatStoreServices, jobs: ChatStoreJobs) {
  const storage = s.storage
  function projectState(projectId: string) {
    return storage.transaction(() => {
      const records = storage
        .findRecords('settings', undefined, { id: 'bootstrap' })
        .filter((r) => (r.value as ChatBootstrap).projectId === projectId)
      const taskIds = [
        ...new Set([
          ...s.taskPaths.store.projectTaskIds(projectId),
          ...records.map((r) => (r.value as ChatBootstrap).identity.taskId)
        ])
      ]
      const sessions = storage.compose((db) =>
        taskIds.flatMap((id) =>
          db
            .prepare(
              'SELECT cwd, conversation_id FROM agent_sessions WHERE task_id=? AND cwd IS NOT NULL AND conversation_id IS NOT NULL'
            )
            .all(id)
        )
      ) as Array<{ cwd: string; conversation_id: string }>
      return {
        records: records.map((record) => ({
          ...record,
          owner: storage.conversation(record.conversationId)
        })),
        taskIds,
        sessions
      }
    })
  }
  return {
    uploadOwner(route: { id: string; epoch: number }) {
      const owner = storage.conversation(route.id)
      if (
        !owner ||
        owner.identity.epoch !== route.epoch ||
        (owner.state !== 'active' && owner.state !== 'prepared')
      )
        throw new Error('Upload conversation ownership is unavailable or deleted')
      const lifecycle = storage.taskLifecycle(owner.identity.taskId)
      if (
        lifecycle.state === 'deleted' ||
        (lifecycle.state !== 'active' && owner.state !== 'prepared')
      )
        throw new Error('Upload task is paused or deleted')
      return {
        taskId: owner.identity.taskId,
        revision: lifecycle.revision,
        storeId: storage.storeId(),
        connectionEpoch: storage.maintenance.connectionEpoch()
      }
    },
    async prepareClose() {
      await jobs.stop()
    },
    diagnosticsConfig: () => s.diagnosticsConfig(),
    configureDiagnostics: (value: { enabled: boolean; verbose: boolean }) =>
      s.configureDiagnostics(value),
    retentionDays: () => jobs.retention.days,
    taskActive(taskId: string) {
      return storage.transaction(() => {
        if (storage.taskLifecycle(taskId).state !== 'active')
          throw new Error('Task chat is paused or deleted')
        if (storage.listForTask(taskId).some((c) => c.state === 'frozen' || c.state === 'prepared'))
          throw new Error('Task chat migration is pending')
      })
    },
    spawnOwner(tabId: string) {
      return storage.transaction(() => {
        const owner = storage.forTab(tabId)
        if (
          !owner ||
          owner.state !== 'active' ||
          storage.taskLifecycle(owner.identity.taskId).state !== 'active' ||
          storage.getRecord(owner.identity.id, 'settings', 'tab-transition-pending')
        )
          throw new Error(
            'Chat provider transition or lifecycle change prevents starting this writer'
          )
        return owner
      })
    },
    diagnostic(tabId: string, event: Parameters<NonNullable<TransportDeps['diagnostic']>>[1]) {
      return storage.transaction(() => {
        const config = s.diagnosticsConfig(),
          owner = storage.forTab(tabId)
        if (
          !config.enabled ||
          (event.level === 'debug' && !config.verbose) ||
          !owner ||
          owner.state !== 'active' ||
          storage.taskLifecycle(owner.identity.taskId).state !== 'active'
        )
          return false
        storage.putRecord(owner.identity.id, owner.identity.epoch, {
          kind: 'settings',
          id: `diagnostic:${randomUUID()}`,
          value: event,
          at: event.tsMs ?? Date.now()
        })
        return true
      })
    },
    agentState(tabId: string, state: string) {
      if (storage.forTab(tabId)?.state === 'active')
        s.local.metadata(tabId, 'agent-state', { state })
    },
    applyLifecycle(taskId: string, state: 'active' | 'paused' | 'deleted', revision: number) {
      const applied = storage.applyTaskLifecycle(taskId, state, revision)
      if (applied.state === 'deleted') {
        s.artifacts.cleanupDeletedTasks(taskId)
        s.transfers.removeTask(taskId)
        s.attachments.collectGarbage()
        s.artifacts.collectGarbage()
        storage.checkpoint()
      }
      return applied
    },
    deleteConversation(identity: ConversationIdentity) {
      const parents = storage
        .findRecords('thread', identity.taskId)
        .filter((r) => r.id === identity.tabId)
        .map((r) => storage.conversation(r.conversationId)?.identity.tabId)
        .filter((id): id is string => !!id)
      storage.applyTombstone(identity)
      s.transfers.removeConversation(identity.id)
      s.attachments.collectGarbage()
      storage.checkpoint()
      return parents
    },
    prepareErasure(taskId: string, revision: number) {
      jobs.compaction.abort('Content was erased during compaction; start again')
      storage.compose((db) => prepareStoredTaskErasure(db, taskId, storage.dir))
      const applied = storage.applyTaskLifecycle(taskId, 'deleted', revision)
      if (applied.state !== 'deleted' || applied.revision < revision)
        throw new Error('Stale computer erasure request')
      return applied
    },
    async finishErasure(taskId: string) {
      s.transfers.removeTask(taskId)
      s.artifacts.cleanupDeletedTasks(taskId)
      await s.artifacts.retryErasures(taskId)
      s.artifacts.collectGarbage()
      const { compact } = await storage.compose((db) =>
        finishStoredTaskErasure(db, storage.dir, taskId)
      )
      if (compact) {
        await jobs.compaction.rebuildForErasure()
        storage.compose((db) => markStoredTaskErasureCompacted(db, taskId))
      }
      await s.backups.eraseTask(taskId)
      storage.deleteTaskFaults(taskId)
    },
    projectState,
    projectTaskIds: (projectId: string) => s.taskPaths.store.projectTaskIds(projectId),
    relocateProject(projectId: string, source: string, target: string) {
      const remap = (path: string) => {
        const suffix = relative(source, path)
        return suffix === '' ||
          (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
          ? join(target, suffix)
          : path
      }
      storage.transaction(() => {
        const state = projectState(projectId)
        if (state.records.some((r) => r.owner?.state !== 'active'))
          throw new Error('Wait for chat transfers to finish before relocating the project.')
        for (const record of state.records)
          storage.putRecord(record.conversationId, record.owner!.identity.epoch, {
            kind: 'settings',
            id: 'bootstrap',
            value: {
              ...(record.value as ChatBootstrap),
              cwd: remap((record.value as ChatBootstrap).cwd)
            },
            at: Date.now()
          })
        storage.compose((db) => {
          for (const taskId of state.taskIds) {
            for (const row of db
              .prepare('SELECT id,cwd FROM agent_sessions WHERE task_id=? AND cwd IS NOT NULL')
              .all(taskId) as Array<{ id: string; cwd: string }>)
              db.prepare('UPDATE agent_sessions SET cwd=? WHERE id=?').run(remap(row.cwd), row.id)
            for (const row of db
              .prepare('SELECT id,worktree_path FROM agent_turns WHERE task_id=?')
              .all(taskId) as Array<{ id: string; worktree_path: string }>)
              db.prepare('UPDATE agent_turns SET worktree_path=? WHERE id=?').run(
                remap(row.worktree_path),
                row.id
              )
          }
        })
        s.taskPaths.store.relocateProject(projectId, source, target)
      })
    }
  }
}
export type ComputerStoreControl = ReturnType<typeof createComputerStoreControl>
