import { randomUUID } from 'node:crypto'
import { openDb } from '../../db'
import { resolveId } from './_shared'

export interface ResetConversationOpts {
  mode?: string
}

/**
 * Append a `manual-reset` sentinel row to `task_conversations` for the given
 * task (and optionally one specific mode). The next read of
 * `getCurrentConversationId` will return NULL because the cutoff hides every
 * earlier row, including the broken `legacy-migration` binding — slay's next
 * spawn for this task starts fresh.
 *
 * The bug class (eager-persist clobber) is closed structurally for new writes
 * after migration v145; this CLI exists to recover from the small set of
 * historic bad bindings the backfill carried forward.
 */
export async function resetConversationAction(
  idPrefix: string | undefined,
  opts: ResetConversationOpts
): Promise<void> {
  idPrefix = resolveId(idPrefix)
  const db = openDb()

  const tasks = db.query<{ id: string; title: string }>(
    `SELECT id, title FROM tasks WHERE id LIKE :prefix || '%' LIMIT 2`,
    { ':prefix': idPrefix }
  )
  if (tasks.length === 0) {
    console.error(`Task not found: ${idPrefix}`)
    process.exit(1)
  }
  if (tasks.length > 1) {
    console.error(
      `Ambiguous id prefix "${idPrefix}". Matches: ${tasks
        .map((t) => t.id.slice(0, 8))
        .join(', ')}`
    )
    process.exit(1)
  }
  const task = tasks[0]

  // If no --mode is given, reset every mode that currently has a row for this
  // task. Reset = append a `manual-reset` sentinel; the row's NULL
  // conversation_id is intentional. Append-only: we never DELETE.
  const modes = opts.mode
    ? [opts.mode]
    : db
        .query<{ mode: string }>(
          `SELECT DISTINCT mode FROM task_conversations WHERE task_id = :id`,
          { ':id': task.id }
        )
        .map((r) => r.mode)

  if (modes.length === 0) {
    console.log(
      `No conversation rows for ${task.id.slice(0, 8)} — nothing to reset.`
    )
    db.close()
    return
  }

  const createdAt = Date.now()
  for (const mode of modes) {
    db.run(
      `INSERT INTO task_conversations (id, task_id, mode, conversation_id, origin, pending_meta, created_at)
       VALUES (:id, :task, :mode, NULL, 'manual-reset', NULL, :ts)`,
      {
        ':id': randomUUID(),
        ':task': task.id,
        ':mode': mode,
        ':ts': createdAt
      }
    )
    console.log(
      `Reset: ${task.id.slice(0, 8)}  mode=${mode}  (next spawn starts fresh)`
    )
  }

  db.close()
}
