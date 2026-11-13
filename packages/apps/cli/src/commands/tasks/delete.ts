import { apiDelete } from '../../api'

type DeleteTaskOutput =
  | boolean
  | { blocked: true; reason: 'linked_to_provider' }
  | {
      incomplete: true
      erasure: { id: string; computers: Array<{ name: string; deleted: boolean }> }
    }

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

  if (typeof data === 'object' && 'blocked' in data) {
    console.error(`Cannot delete: linked to external provider. Unlink first.`)
    process.exit(1)
  }
  if (typeof data === 'object' && 'incomplete' in data) {
    console.error(`Deletion is incomplete. Cleanup operation: ${data.erasure.id}`)
    for (const computer of data.erasure.computers.filter((c) => !c.deleted))
      console.error(`Data on ${computer.name} has not been deleted yet.`)
    process.exitCode = 2
    return
  }
  if (data !== true) {
    console.error('Task was not deleted.')
    process.exitCode = 1
    return
  }

  console.log(`Deleted: ${task.id.slice(0, 8)}  ${task.title}`)
}
