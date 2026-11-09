import type { SlayzoneDb } from '@slayzone/platform'
import { taskEvents } from '../events.js'
import { eraseContent } from '@slayzone/content-erasure/server'
import type { ErasureReport } from '@slayzone/content-erasure'
import { cleanupTaskImmediate, getRuntimeAdapters, parseTask, type OpDeps } from './shared.js'
// Loads the TxnRegistry augmentation that types this file's `db.namedTxn` calls.
import type {} from '../task-txns.js'

export interface DeleteManyTasksResult {
  deletedIds: string[]
  blockedIds: string[]
  erasure?: ErasureReport
}

export async function deleteManyTasksOp(
  db: SlayzoneDb,
  ids: string[],
  deps: OpDeps
): Promise<DeleteManyTasksResult> {
  const { ipcMain, onMutation } = deps
  if (ids.length === 0) return { deletedIds: [], blockedIds: [] }

  const blockedIds: string[] = []
  const deletable: { id: string; previous: ReturnType<typeof parseTask> }[] = []

  for (const id of ids) {
    const previousRow = await db.get<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', [
      id
    ])
    const previousTask = parseTask(previousRow)
    const linkCount = (
      await db.get<{ count: number }>(
        'SELECT COUNT(*) as count FROM external_links WHERE task_id = ?',
        [id]
      )
    )?.count
    if ((linkCount ?? 0) > 0) {
      blockedIds.push(id)
      continue
    }
    if (previousTask) deletable.push({ id, previous: previousTask })
  }
  if (!deletable.length) return { deletedIds: [], blockedIds }
  const adapters = getRuntimeAdapters()
  const deletedIds = deletable.map((task) => task.id)
  const report = await eraseContent(
    db,
    adapters.getDataRoot(),
    { kind: 'tasks', ids: deletedIds },
    {
      beforeDelete: (taskIds) => {
        for (const taskId of taskIds) {
          cleanupTaskImmediate(taskId)
          adapters.removeTaskProcesses(taskId)
        }
      }
    }
  )

  for (const { id, previous } of deletable) {
    if (!deletedIds.includes(id)) continue
    ipcMain?.emit('db:tasks:delete:done', null, id)
    if (previous) {
      taskEvents.emit('task:deleted', { taskId: id, projectId: previous.project_id })
    }
  }
  if (deletedIds.length > 0) onMutation?.()

  return { deletedIds, blockedIds, ...(report.state === 'incomplete' ? { erasure: report } : {}) }
}
