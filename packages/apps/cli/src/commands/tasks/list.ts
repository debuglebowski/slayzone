import { apiGet } from '../../api'
import type { TaskJson } from '../task-json'
import { printTasks } from './_shared'

export interface ListOpts {
  project?: string
  status?: string
  done?: boolean
  limit?: string
  json?: boolean
}

export async function listAction(opts: ListOpts): Promise<void> {
  // The REST route (GET /api/tasks) owns status-alias resolution, the done
  // filter, per-project columns lookup, blocked-id union, and tag enrichment —
  // it returns the stable TaskJson contract directly (task-json.ts).
  const params = new URLSearchParams()
  if (opts.project) params.set('project', opts.project)
  if (opts.done) params.set('done', '1')
  else if (opts.status) params.set('status', opts.status)
  if (opts.limit) params.set('limit', opts.limit)

  const qs = params.toString()
  const { data } = await apiGet<{ ok: true; data: TaskJson[] }>(
    `/api/tasks${qs ? `?${qs}` : ''}`
  )

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2))
    return
  }

  const blockedIds = new Set(data.filter((t) => t.is_blocked).map((t) => t.id))
  printTasks(data, blockedIds)
}
