import { apiGet } from '../../api'
import { printTasks, type TaskRow } from './_shared'

export interface SearchOpts {
  project?: string
  limit?: string
  json?: boolean
}

export async function searchAction(query: string, opts: SearchOpts): Promise<void> {
  // GET /api/tasks/search owns the title/description substring match, project
  // narrowing, and limit — returning the same column set the CLI printed.
  const params = new URLSearchParams({ q: query })
  if (opts.project) params.set('project', opts.project)
  if (opts.limit) params.set('limit', opts.limit)

  const { data } = await apiGet<{ ok: true; data: TaskRow[] }>(
    `/api/tasks/search?${params.toString()}`
  )

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2))
  } else {
    printTasks(data)
  }
}
