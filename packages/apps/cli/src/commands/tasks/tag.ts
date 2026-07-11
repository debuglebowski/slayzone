import { apiGet, apiPost, apiDelete } from '../../api'
import { resolveId } from './_shared'

export interface TagOpts {
  set?: string[]
  add?: string
  remove?: string
  clear?: boolean
  json?: boolean
}

export async function tagAction(taskId: string | undefined, opts: TagOpts): Promise<void> {
  taskId = await resolveId(taskId)
  const path = `/api/tasks/${encodeURIComponent(taskId)}/tags`

  // The REST routes own task id-prefix resolution, tag-name resolution within
  // the task's project (404 on miss), the mutation, the renderer ping, and
  // returning the resulting tag-name list. The read-only case pulls current
  // tags from the task detail (GET /api/tasks/:id includes `tags`).
  let tagNames: string[]
  if (opts.set) {
    ;({ data: tagNames } = await apiPost<{ ok: true; data: string[] }>(path, { set: opts.set }))
  } else if (opts.add) {
    ;({ data: tagNames } = await apiPost<{ ok: true; data: string[] }>(path, { add: opts.add }))
  } else if (opts.remove) {
    ;({ data: tagNames } = await apiDelete<{ ok: true; data: string[] }>(path, {
      remove: opts.remove
    }))
  } else if (opts.clear) {
    ;({ data: tagNames } = await apiDelete<{ ok: true; data: string[] }>(path, { clear: true }))
  } else {
    const { data } = await apiGet<{ ok: true; data: { tags: string[] } }>(
      `/api/tasks/${encodeURIComponent(taskId)}`
    )
    tagNames = data.tags
  }

  if (opts.json) {
    console.log(JSON.stringify(tagNames))
  } else if (tagNames.length > 0) {
    console.log(tagNames.join(', '))
  } else {
    console.log('No tags.')
  }
}
