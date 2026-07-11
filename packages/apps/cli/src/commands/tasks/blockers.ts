import { apiGet, apiPost, apiDelete } from '../../api'
import { printTasks, resolveId, type TaskRow } from './_shared'

export interface BlockersOpts {
  add?: string[]
  remove?: string[]
  set?: string[]
  clear?: boolean
  json?: boolean
}

export async function blockersAction(
  taskId: string | undefined,
  opts: BlockersOpts
): Promise<void> {
  taskId = await resolveId(taskId)
  const path = `/api/tasks/${encodeURIComponent(taskId)}/blockers`

  // The REST routes own id-prefix resolution (of both the task and each blocker
  // ref), self-block rejection, the mutation, the renderer ping, and returning
  // the resulting blocker list. Exactly one of add/set/remove/clear is a write.
  let blockers: TaskRow[]
  if (opts.set) {
    ;({ data: blockers } = await apiPost<{ ok: true; data: TaskRow[] }>(path, { set: opts.set }))
  } else if (opts.add) {
    ;({ data: blockers } = await apiPost<{ ok: true; data: TaskRow[] }>(path, { add: opts.add }))
  } else if (opts.remove) {
    ;({ data: blockers } = await apiDelete<{ ok: true; data: TaskRow[] }>(path, {
      remove: opts.remove
    }))
  } else if (opts.clear) {
    ;({ data: blockers } = await apiDelete<{ ok: true; data: TaskRow[] }>(path, { clear: true }))
  } else {
    ;({ data: blockers } = await apiGet<{ ok: true; data: TaskRow[] }>(path))
  }

  if (opts.json) {
    console.log(JSON.stringify(blockers, null, 2))
  } else if (blockers.length > 0) {
    printTasks(blockers)
  } else {
    console.log('No blockers.')
  }
}
