import { apiGet } from '../../api'
import { resolveId } from './_shared'

interface TaskDetail extends Record<string, unknown> {
  id: string
  title: string
  status: string
  priority: number
  project_name: string
  created_at: string
  description?: string | null
  due_date?: string | null
  is_blocked?: number | boolean
  blocked_comment?: string | null
  tags: string[]
  blockers: { id: string; title: string }[]
  blocking: { id: string; title: string }[]
}

export async function viewAction(idPrefix: string | undefined): Promise<void> {
  idPrefix = await resolveId(idPrefix)
  // GET /api/tasks/:id resolves the id prefix and returns the full task row plus
  // project_name, tag names, and dependency blockers/blocking (view.ts parity).
  const { data: t } = await apiGet<{ ok: true; data: TaskDetail }>(
    `/api/tasks/${encodeURIComponent(idPrefix)}`
  )

  console.log(`ID:       ${t.id}`)
  console.log(`Title:    ${t.title}`)
  console.log(`Status:   ${t.status}`)
  console.log(`Priority: ${t.priority}`)
  console.log(`Project:  ${t.project_name}`)
  if (t.due_date) console.log(`Due:      ${t.due_date}`)
  if (t.tags.length > 0) console.log(`Tags:     ${t.tags.join(', ')}`)
  if (t.is_blocked) {
    const comment = t.blocked_comment
    console.log(`Blocked:  yes${comment ? ` (${comment})` : ''}`)
  }
  if (t.blockers.length > 0)
    console.log(`Blockers: ${t.blockers.map((b) => `${b.id.slice(0, 8)} (${b.title})`).join(', ')}`)
  if (t.blocking.length > 0)
    console.log(`Blocking: ${t.blocking.map((b) => `${b.id.slice(0, 8)} (${b.title})`).join(', ')}`)
  console.log(`Created:  ${t.created_at}`)
  if (t.description) console.log(`\n${t.description}`)
}
