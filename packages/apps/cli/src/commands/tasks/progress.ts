import { apiGet, apiPatch } from '../../api'
import { resolveId } from './_shared'

export async function progressAction(idOrValue: string, value: string | undefined): Promise<void> {
  let idPrefix: string | undefined
  if (value === undefined) {
    idPrefix = undefined
    value = idOrValue
  } else {
    idPrefix = idOrValue
  }
  idPrefix = await resolveId(idPrefix)
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n) || String(n) !== String(value).trim() || n < 0 || n > 100) {
    console.error('progress must be integer 0-100')
    process.exit(1)
  }

  // GET /api/tasks/:id resolves the id prefix (404/400 with the same messages)
  // and yields the full uuid + title; PATCH then requires the resolved uuid.
  const { data: task } = await apiGet<{ ok: true; data: { id: string; title: string } }>(
    `/api/tasks/${encodeURIComponent(idPrefix)}`
  )

  await apiPatch(`/api/tasks/${task.id}`, { progress: n })
  console.log(`Progress ${n}%: ${task.id.slice(0, 8)}  ${task.title}`)
}
