import { apiDelete } from '../../api'

type DeleteTaskOutput = boolean | { blocked: true; reason: 'linked_to_provider' }

export async function deleteAction(idPrefix: string): Promise<void> {
  // DELETE /api/tasks/:id owns id-prefix resolution (404 not-found / 400
  // ambiguous, same messages), the soft-delete, and the renderer ping. It returns
  // the resolved task alongside the boolean|{blocked} result, so the prefix goes
  // straight to the hub — no local DB read, which is what let a remote hub work.
  const { data, task } = await apiDelete<{
    ok: true
    data: DeleteTaskOutput
    task: { id: string; title: string }
  }>(`/api/tasks/${encodeURIComponent(idPrefix)}`)

  if (typeof data === 'object' && data.blocked) {
    console.error(`Cannot delete: linked to external provider. Unlink first.`)
    process.exit(1)
  }

  console.log(`Deleted: ${task.id.slice(0, 8)}  ${task.title}`)
}
