import type { EventEmitter } from 'node:events'
import type { SlayzoneDb } from '@slayzone/platform'
import {
  pushTaskAfterEdit as defaultPushTaskAfterEdit,
  pushNewTaskToProviders as defaultPushNewTaskToProviders,
  pushArchiveToProviders as defaultPushArchiveToProviders,
  pushUnarchiveToProviders as defaultPushUnarchiveToProviders
} from '@slayzone/integrations/server'

/**
 * Push local task edits out to Linear/GitHub, listening on the bus the task ops
 * actually emit on.
 *
 * WHY THIS MOVED. The ops emit through an INJECTED bus — `ops/update.ts` does
 * `ipcMain?.emit('db:tasks:update:done', …)` where `ipcMain` is whatever the
 * composition root gave them. Since slice 9 the ops run in THIS process, whose bus
 * is a plain `EventEmitter` (composition.ts), while the only listeners stayed on
 * the Electron host's real `ipcMain`. So the events were emitted and nothing was
 * listening: push-on-edit has been silently dead, and with it the
 * `external_links` lookup that decides whether to ping the UI to refetch.
 *
 * NOTE FOR REVIEW: re-attaching these listeners is a BEHAVIOR CHANGE, not a
 * refactor — pushes that have not fired for releases will start firing again.
 * Verify against one real Linear/GitHub connection before release.
 *
 * `fns` is injectable so the wiring can be tested without a provider.
 */
export type IntegrationPushFns = {
  pushTaskAfterEdit: typeof defaultPushTaskAfterEdit
  pushNewTaskToProviders: typeof defaultPushNewTaskToProviders
  pushArchiveToProviders: typeof defaultPushArchiveToProviders
  pushUnarchiveToProviders: typeof defaultPushUnarchiveToProviders
}

export function wireIntegrationPush(opts: {
  db: SlayzoneDb
  /** The SAME bus the task ops were handed — not `ipcMain`. */
  taskBus: EventEmitter
  notifyTasksChanged: () => void
  pushGithubTask: (taskId: string) => Promise<void>
  fns?: Partial<IntegrationPushFns>
}): void {
  const {
    pushTaskAfterEdit = defaultPushTaskAfterEdit,
    pushNewTaskToProviders = defaultPushNewTaskToProviders,
    pushArchiveToProviders = defaultPushArchiveToProviders,
    pushUnarchiveToProviders = defaultPushUnarchiveToProviders
  } = opts.fns ?? {}

  // Signature matches ipcMain's: a leading event arg the ops pass as null.
  opts.taskBus.on('db:tasks:update:done', (_event: unknown, taskId: string) => {
    void pushTaskAfterEdit(opts.db, taskId, { pushGithubTask: opts.pushGithubTask })
  })

  opts.taskBus.on(
    'db:tasks:create:done',
    (_event: unknown, taskId: string, projectId: string) => {
      void pushNewTaskToProviders(opts.db, taskId, projectId).then(async () => {
        // Only ping the UI when a link was actually created — otherwise every
        // task creation would trigger a board refetch for nothing.
        const hasLink = await opts.db
          .prepare('SELECT 1 FROM external_links WHERE task_id = ? LIMIT 1')
          .get(taskId)
        if (hasLink) opts.notifyTasksChanged()
      })
    }
  )

  opts.taskBus.on('db:tasks:archive:done', (_event: unknown, taskId: string) => {
    void pushArchiveToProviders(opts.db, taskId)
  })
  opts.taskBus.on('db:tasks:unarchive:done', (_event: unknown, taskId: string) => {
    void pushUnarchiveToProviders(opts.db, taskId)
  })
}
