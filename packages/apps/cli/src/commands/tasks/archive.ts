import { apiPost } from '../../api'

export async function archiveAction(idPrefix: string): Promise<void> {
  // POST /api/tasks/:id/archive owns id-prefix resolution (404 not-found /
  // 400 ambiguous, same messages), the `archived_at IS NULL` scope, the archive
  // op, and the renderer ping. It returns the archived task, so the prefix goes
  // straight to the hub — no local DB read, which is what let a remote hub work.
  const { data: task } = await apiPost<{ ok: true; data: { id: string; title: string } }>(
    `/api/tasks/${encodeURIComponent(idPrefix)}/archive`,
    {}
  )
  console.log(`Archived: ${task.id.slice(0, 8)}  ${task.title}`)
}
