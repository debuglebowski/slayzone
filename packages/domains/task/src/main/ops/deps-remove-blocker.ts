import type { SlayzoneDb } from '@slayzone/platform'

export async function removeBlockerOp(
  db: SlayzoneDb,
  taskId: string,
  blockerTaskId: string
): Promise<void> {
  await db.run('DELETE FROM task_dependencies WHERE task_id = ? AND blocks_task_id = ?', [
    blockerTaskId,
    taskId
  ])
}
