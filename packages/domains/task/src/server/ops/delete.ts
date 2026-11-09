import type { SlayzoneDb } from '@slayzone/platform'
import { taskEvents } from '../events.js'
import { eraseContent, resumeErasure } from '@slayzone/content-erasure/server'
import type { ErasureReport } from '@slayzone/content-erasure'
import { cleanupTaskImmediate, getRuntimeAdapters, parseTask, type OpDeps } from './shared.js'
// Loads the TxnRegistry augmentation that types this file's `db.namedTxn` calls.
import type {} from '../task-txns.js'

export type DeleteTaskResult =
  | boolean
  | { blocked: true; reason: 'linked_to_provider' }
  | { incomplete: true; erasure: ErasureReport }

export async function deleteTaskOp(
  db: SlayzoneDb,
  id: string,
  deps: OpDeps
): Promise<DeleteTaskResult> {
  const { ipcMain, onMutation } = deps
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
    return { blocked: true, reason: 'linked_to_provider' }
  }

  const adapters = getRuntimeAdapters()
  const options = {
    beforeDelete: (taskIds: string[]) => {
      for (const taskId of taskIds) {
        cleanupTaskImmediate(taskId)
        adapters.removeTaskProcesses(taskId)
      }
    }
  }
  if (!previousTask) {
    const existing = await db.get<{ job_id: string }>(
      'SELECT job_id FROM content_erasure_tasks WHERE task_id=?',
      [id]
    )
    if (!existing) return false
    const report = await resumeErasure(db, adapters.getDataRoot(), existing.job_id, options)
    return report.state === 'complete' ? true : { incomplete: true, erasure: report }
  }
  const report = await eraseContent(
    db,
    adapters.getDataRoot(),
    { kind: 'tasks', ids: [id] },
    options
  )
  if (report.counts.tasks > 0) {
    ipcMain?.emit('db:tasks:delete:done', null, id)
    if (previousTask) {
      taskEvents.emit('task:deleted', { taskId: id, projectId: previousTask.project_id })
    }
    onMutation?.()
  }
  return report.state === 'complete' ? true : { incomplete: true, erasure: report }
}
