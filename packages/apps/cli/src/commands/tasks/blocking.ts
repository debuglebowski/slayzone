import { apiGet } from '../../api'
import { printTasks, resolveId, type TaskRow } from './_shared'

export interface BlockingOpts {
  json?: boolean
}

export async function blockingAction(
  taskId: string | undefined,
  opts: BlockingOpts
): Promise<void> {
  taskId = await resolveId(taskId)
  // GET /api/tasks/:id/blocking resolves the id prefix and returns the tasks
  // this one blocks (reverse of blockers) in the CLI's column set.
  const { data: blocking } = await apiGet<{ ok: true; data: TaskRow[] }>(
    `/api/tasks/${encodeURIComponent(taskId)}/blocking`
  )

  if (opts.json) {
    console.log(JSON.stringify(blocking, null, 2))
  } else if (blocking.length > 0) {
    printTasks(blocking)
  } else {
    console.log('Not blocking any tasks.')
  }
}
