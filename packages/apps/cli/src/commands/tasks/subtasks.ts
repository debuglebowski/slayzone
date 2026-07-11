import { apiGet } from '../../api'
import { printTasks, resolveId, type TaskRow } from './_shared'

export interface SubtasksOpts {
  json?: boolean
}

export async function subtasksAction(
  idPrefix: string | undefined,
  opts: SubtasksOpts
): Promise<void> {
  idPrefix = await resolveId(idPrefix)
  // GET /api/tasks/:id/subtasks resolves the parent id prefix and returns direct
  // subtasks (non-archived/deleted, order ASC) in the CLI's column set.
  const { data } = await apiGet<{ ok: true; data: TaskRow[] }>(
    `/api/tasks/${encodeURIComponent(idPrefix)}/subtasks`
  )

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2))
  } else {
    printTasks(data)
  }
}
