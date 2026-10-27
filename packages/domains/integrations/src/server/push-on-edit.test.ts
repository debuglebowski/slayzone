/**
 * Push-on-edit (`pushGithubTask`, fired by the hub when a linked task's synced
 * field changes) honours the project mapping's sync mode: a ONE-WAY mapping
 * (GitHub → SlayZone) never writes to GitHub; only TWO-WAY pushes. Same rule as
 * Linear's `runProviderSync` and the create/archive/unarchive pushes. The manual
 * "Push ↑" bulk action is an explicit user request and is not covered here.
 *
 * Driven through the ops' GitHub test mocks — no network.
 */
import { afterAll, describe, expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { createIntegrationOps, ensureIntegrationSchema } from './handlers-store.js'
import { setCredentialCipher } from './credentials.js'

const h = await createTestHarness()
await ensureIntegrationSchema(h.slayDb)
setCredentialCipher(null)
const ops = createIntegrationOps(h.slayDb)

type SyncMode = 'one_way' | 'two_way'

/** One repo + issue per mode: an issue linked to one project is skipped by the next import. */
const repoOf = (mode: SyncMode): string => `acme/push-${mode}`
const issueOf = (mode: SyncMode) => ({
  id: `gh-issue-${mode}`,
  number: 1,
  title: 'Remote title',
  body: 'Body',
  updatedAt: '2026-03-04T10:00:00Z',
  state: 'open' as const,
  assignee: null,
  labels: [],
  repository: { owner: 'acme', name: `push-${mode}`, fullName: repoOf(mode) },
  url: `https://github.com/${repoOf(mode)}/issues/1`
})

/** A project with one imported, linked task, its GitHub mapping in `syncMode`. */
async function seedLinkedTask(syncMode: SyncMode): Promise<string> {
  const projectId = crypto.randomUUID()
  h.db
    .prepare(
      `INSERT INTO projects (id, name, color, path, created_at, updated_at)
       VALUES (?, ?, '#888888', '/tmp/push-on-edit', datetime('now'), datetime('now'))`
    )
    .run(projectId, `Push ${syncMode}`)
  const connection = await ops.testSeedGithubConnection({ projectId })
  h.db
    .prepare(
      `INSERT INTO integration_project_mappings
       (id, project_id, provider, connection_id, external_team_id, external_team_key,
        sync_mode, status_setup_complete, external_repo_owner, external_repo_name)
       VALUES (?, ?, 'github', ?, '', '', ?, 1, 'acme', ?)`
    )
    .run(crypto.randomUUID(), projectId, connection.id, syncMode, `push-${syncMode}`)
  ops.testSetGithubRepositoryIssues({
    repositoryFullName: repoOf(syncMode),
    issues: [issueOf(syncMode)]
  })
  await ops.importGithubRepositoryIssues({
    projectId,
    connectionId: connection.id,
    repositoryFullName: repoOf(syncMode),
    limit: 50
  })
  const task = h.db
    .prepare('SELECT id FROM tasks WHERE project_id = ? AND title = ?')
    .get(projectId, 'Remote title') as { id: string } | undefined
  if (!task) throw new Error('import created no task')
  // A local edit of a synced field.
  h.db
    .prepare("UPDATE tasks SET title = 'Local title', updated_at = datetime('now') WHERE id = ?")
    .run(task.id)
  return task.id
}

async function remoteTitleAfterPush(syncMode: SyncMode): Promise<string> {
  const taskId = await seedLinkedTask(syncMode)
  await ops.pushGithubTask(taskId)
  const issues = await ops.listGithubRepositoryIssues({
    connectionId: (
      h.db
        .prepare(
          "SELECT connection_id FROM external_links WHERE task_id = ? AND provider = 'github'"
        )
        .get(taskId) as { connection_id: string }
    ).connection_id,
    repositoryFullName: repoOf(syncMode),
    limit: 50
  })
  return issues.issues.find((i: { number: number }) => i.number === 1)?.title ?? ''
}

describe('push-on-edit honours sync mode', () => {
  test('one-way mapping: a local edit is NOT pushed to GitHub', async () => {
    expect(await remoteTitleAfterPush('one_way')).toBe('Remote title')
  })

  test('two-way mapping: a local edit is pushed to GitHub', async () => {
    expect(await remoteTitleAfterPush('two_way')).toBe('Local title')
  })
})

afterAll(() => h.cleanup())
