import type { SlayzoneDb } from '@slayzone/platform'

export async function addBlockerOp(
  db: SlayzoneDb,
  taskId: string,
  blockerTaskId: string
): Promise<void> {
  await db.run(
    'INSERT OR IGNORE INTO task_dependencies (task_id, blocks_task_id) VALUES (?, ?)',
    [blockerTaskId, taskId]
  )
}
