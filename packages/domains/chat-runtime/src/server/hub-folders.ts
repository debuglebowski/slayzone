import type { SlayzoneDb } from '@slayzone/platform'
import type { ChatComputerRequest } from './migration'
import { z } from 'zod'

const inventorySchema = z.object({
  rows: z
    .array(
      z.object({
        sequence: z.number().int().positive(),
        folderId: z.string().min(1).max(200),
        taskId: z.string().min(1).max(200)
      })
    )
    .max(500),
  nextCursor: z.number().int().nonnegative(),
  hasMore: z.boolean()
})

/** Folder names stay on their store. Durable opaque IDs prevent mirror resurrection. */
export function createChatFolderDeletions(db: SlayzoneDb) {
  async function record(taskId: string, ids: string[]) {
    if (!ids.length) return
    const placeholders = ids.map(() => '?').join(',')
    if (
      await db.get(
        `SELECT 1 FROM artifact_folders WHERE id IN (${placeholders}) AND task_id<>?
      UNION ALL SELECT 1 FROM chat_folder_deletions WHERE folder_id IN (${placeholders}) AND task_id<>? LIMIT 1`,
        [...ids, taskId, ...ids, taskId]
      )
    )
      throw new Error('Deleted folder belongs to another task')
    const descendants = await db.all<{ id: string }>(
      `WITH RECURSIVE gone(id) AS (
      SELECT id FROM artifact_folders WHERE task_id=? AND id IN (${placeholders})
      UNION SELECT f.id FROM artifact_folders f JOIN gone ON f.parent_id=gone.id WHERE f.task_id=?
    ) SELECT id FROM gone`,
      [taskId, ...ids, taskId]
    )
    const all = [...new Set([...ids, ...descendants.map((f) => f.id)])]
    await db.batchTxn([
      ...all.map((id) => ({
        type: 'run' as const,
        sql: 'INSERT INTO chat_folder_deletions(folder_id,task_id) VALUES(?,?) ON CONFLICT(folder_id) DO NOTHING',
        params: [id, taskId]
      })),
      {
        type: 'run',
        sql: `DELETE FROM artifact_folders WHERE task_id=? AND id IN (${placeholders})`,
        params: [taskId, ...ids]
      }
    ])
  }
  return {
    record,
    async deleted(taskId: string, id: string) {
      const row = await db.get<{ task_id: string }>(
        'SELECT task_id FROM chat_folder_deletions WHERE folder_id=?',
        [id]
      )
      if (row && row.task_id !== taskId) throw new Error('Deleted folder belongs to another task')
      return !!row
    },
    async sync(computerId: string, request: ChatComputerRequest) {
      for (;;) {
        const rows = await db.all<{ sequence: number; folder_id: string; task_id: string }>(
          `SELECT d.* FROM chat_folder_deletions d
          JOIN chat_task_computers c ON c.task_id=d.task_id AND c.computer_id=?
          LEFT JOIN chat_folder_deletion_acks a ON a.task_id=d.task_id AND a.computer_id=c.computer_id
          WHERE d.sequence>COALESCE(a.sequence,0) ORDER BY d.sequence LIMIT 500`,
          [computerId]
        )
        if (!rows.length) return
        const tasks = new Set(rows.map((r) => r.task_id))
        for (const taskId of tasks) {
          const part = rows.filter((r) => r.task_id === taskId)
          const result = (await request(computerId, {
            kind: 'folders.delete',
            taskId,
            folderIds: part.map((r) => r.folder_id)
          })) as { ok?: boolean }
          if (result?.ok !== true) throw new Error('Invalid folder deletion acknowledgement')
          await db.run(
            'INSERT INTO chat_folder_deletion_acks(task_id,computer_id,sequence) VALUES(?,?,?) ON CONFLICT(task_id,computer_id) DO UPDATE SET sequence=MAX(sequence,excluded.sequence)',
            [taskId, computerId, part.at(-1)!.sequence]
          )
        }
      }
    },
    async recover(
      computerId: string,
      request: ChatComputerRequest,
      gate?: (computerId: string, taskId: string) => Promise<void>
    ) {
      let after = 0
      for (;;) {
        const parsed = inventorySchema.safeParse(
          await request(computerId, { kind: 'folders.inventory', after })
        )
        if (!parsed.success) throw new Error('Invalid folder deletion inventory')
        const page = parsed.data
        let sequence = after
        for (const row of page.rows) {
          if (row.sequence <= sequence) throw new Error('Invalid folder deletion inventory order')
          sequence = row.sequence
        }
        if (page.nextCursor !== sequence || (page.hasMore && sequence <= after))
          throw new Error('Invalid folder deletion inventory cursor')
        for (const row of page.rows) {
          if (!(await db.get('SELECT 1 FROM tasks WHERE id=?', [row.taskId]))) continue
          await gate?.(computerId, row.taskId)
          await record(row.taskId, [row.folderId])
        }
        if (!page.hasMore) return
        if (page.nextCursor <= after) throw new Error('Folder deletion inventory did not advance')
        after = page.nextCursor
      }
    }
  }
}
