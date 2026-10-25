import type { EventEmitter } from 'node:events'
import type { SlayzoneDb } from '@slayzone/platform'
import { hubIntegrationsEnabled } from '@slayzone/platform/hub-switch-refusal'
import {
  pushTaskAfterEdit as defaultPushTaskAfterEdit,
  pushNewTaskToProviders as defaultPushNewTaskToProviders,
  pushArchiveToProviders as defaultPushArchiveToProviders,
  pushUnarchiveToProviders as defaultPushUnarchiveToProviders,
  syncedTaskFieldsChanged
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
 * WHAT IS PUSHED, AND WHEN:
 *   - a new task → created on every two-way-synced provider, unless it is
 *     temporary (a scratch terminal): it is pushed once it is made permanent;
 *   - an edit → the task is re-synced only when a synced field changed
 *     (`syncedTaskFieldsChanged`); most edits are UI state saved on the task row;
 *   - archive / unarchive → the linked issue is closed / reopened.
 *
 * `fns` is injectable so the wiring can be tested without a provider.
 */
export type IntegrationPushFns = {
  pushTaskAfterEdit: typeof defaultPushTaskAfterEdit
  pushNewTaskToProviders: typeof defaultPushNewTaskToProviders
  pushArchiveToProviders: typeof defaultPushArchiveToProviders
  pushUnarchiveToProviders: typeof defaultPushUnarchiveToProviders
}

/** The part of a task row the update ops report that decides what to push. */
type UpdatedTask = {
  project_id: string
  is_temporary?: boolean | number | null
  title?: unknown
  description?: unknown
  status?: unknown
  priority?: unknown
}

export function wireIntegrationPush(opts: {
  db: SlayzoneDb
  /** The SAME bus the task ops were handed — not `ipcMain`. */
  taskBus: EventEmitter
  notifyTasksChanged: () => void
  pushGithubTask: (taskId: string) => Promise<void>
  fns?: Partial<IntegrationPushFns>
}): void {
  // `SLAYZONE_HUB_ENABLE_INTEGRATIONS=0`: no background push at all. Not a refusal
  // of anyone's request, so nothing to audit — the listeners simply never exist.
  if (!hubIntegrationsEnabled()) return
  const {
    pushTaskAfterEdit = defaultPushTaskAfterEdit,
    pushNewTaskToProviders = defaultPushNewTaskToProviders,
    pushArchiveToProviders = defaultPushArchiveToProviders,
    pushUnarchiveToProviders = defaultPushUnarchiveToProviders
  } = opts.fns ?? {}

  const pushNew = (taskId: string, projectId: string): void => {
    void pushNewTaskToProviders(opts.db, taskId, projectId).then(async () => {
      // Only ping the UI when a link was actually created — otherwise every
      // task creation would trigger a board refetch for nothing.
      const hasLink = await opts.db
        .prepare('SELECT 1 FROM external_links WHERE task_id = ? LIMIT 1')
        .get(taskId)
      if (hasLink) opts.notifyTasksChanged()
    })
  }

  // Signature matches ipcMain's: a leading event arg the ops pass as null. The update
  // ops report the row before and after; an emitter that does not is re-synced as
  // before (fail open — a missed push is the bug this module exists to prevent).
  opts.taskBus.on(
    'db:tasks:update:done',
    (_event: unknown, taskId: string, info?: { previous?: UpdatedTask; next?: UpdatedTask }) => {
      const { previous, next } = info ?? {}
      if (previous && next) {
        if (previous.is_temporary && !next.is_temporary) {
          pushNew(taskId, next.project_id)
          return
        }
        if (!syncedTaskFieldsChanged(previous, next)) return
      }
      void pushTaskAfterEdit(opts.db, taskId, { pushGithubTask: opts.pushGithubTask })
    }
  )

  opts.taskBus.on('db:tasks:create:done', (_event: unknown, taskId: string, projectId: string) => {
    void (async () => {
      const row = await opts.db.get<{ is_temporary: number }>(
        'SELECT is_temporary FROM tasks WHERE id = ?',
        [taskId]
      )
      if (row?.is_temporary) return
      pushNew(taskId, projectId)
    })()
  })

  opts.taskBus.on('db:tasks:archive:done', (_event: unknown, taskId: string) => {
    void pushArchiveToProviders(opts.db, taskId)
  })
  opts.taskBus.on('db:tasks:unarchive:done', (_event: unknown, taskId: string) => {
    void pushUnarchiveToProviders(opts.db, taskId)
  })
}
