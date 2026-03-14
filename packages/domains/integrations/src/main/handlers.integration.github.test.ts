/**
 * Integration tests for GitHub — hits real API.
 * Requires: GITHUB_TOKEN, GITHUB_TEST_REPO (auto-loaded from .env)
 * Optional: GITHUB_TEST_PROJECT_ID (Projects V2 node ID for status sync tests)
 *
 * Run: npx tsx packages/domains/integrations/src/main/handlers.integration.github.test.ts
 */
import { createTestHarness, expect } from '../../../../shared/test-utils/ipc-harness.js'
import { registerIntegrationHandlers } from './handlers'
import {
  requireEnv, seedFullMapping, cleanupGithubIssues,
  registerCleanup, startSuiteTimeout, runScopedDiscovery
} from './integration-test-helpers'
import * as githubClient from './github-client'
import { pushNewTaskToProviders, pushArchiveToProviders, pushUnarchiveToProviders } from './sync'
import { parseGitHubExternalKey } from './sync-helpers'
import type { ProviderStatus } from '../shared'

process.env.SLAYZONE_ALLOW_PLAINTEXT_CREDENTIALS = '1'

const GITHUB_TOKEN = requireEnv('GITHUB_TOKEN')
const GITHUB_TEST_REPO = requireEnv('GITHUB_TEST_REPO')
const GITHUB_TEST_PROJECT_ID = process.env.GITHUB_TEST_PROJECT_ID || ''
const [REPO_OWNER, REPO_NAME] = GITHUB_TEST_REPO.split('/')
if (!REPO_OWNER || !REPO_NAME) {
  console.error('GITHUB_TEST_REPO must be in format owner/repo')
  process.exit(1)
}

startSuiteTimeout()

let pass = 0
let fail = 0
const createdIssues: Array<{ owner: string; repo: string; number: number }> = []

// Register crash-safe cleanup
registerCleanup(async () => {
  if (createdIssues.length > 0) {
    console.log('\n  cleaning up GitHub issues...')
    await cleanupGithubIssues(GITHUB_TOKEN, createdIssues)
  }
})

function ok(name: string) { pass++; console.log(`  ✓ ${name}`) }
function no(name: string, e: unknown) { fail++; console.log(`  ✗ ${name}`); console.error(`    ${e}`); process.exitCode = 1 }

const h = await createTestHarness()
registerIntegrationHandlers(h.ipcMain as any, h.db)

// ── Auth ──────────────────────────────────────────────────────────────────
console.log('\nGitHub: Auth')
try {
  const viewer = await githubClient.getViewer(GITHUB_TOKEN)
  expect(viewer.workspaceId).toBeTruthy()
  expect(viewer.workspaceName).toBeTruthy()
  ok('getViewer returns user info')
} catch (e) { no('getViewer returns user info', e) }

// ── Discovery ─────────────────────────────────────────────────────────────
console.log('\nGitHub: Discovery')
try {
  const repos = await githubClient.listRepositories(GITHUB_TOKEN)
  expect(repos.length).toBeGreaterThan(0)
  const testRepo = repos.find(r => r.fullName === GITHUB_TEST_REPO)
  expect(testRepo).toBeTruthy()
  ok('listRepositories includes test repo')
} catch (e) { no('listRepositories includes test repo', e) }

// ── Issue CRUD ────────────────────────────────────────────────────────────
console.log('\nGitHub: Issue CRUD')
let createdIssueNumber = 0
let createdIssueId = ''

try {
  const issue = await githubClient.createIssue(GITHUB_TOKEN, {
    owner: REPO_OWNER,
    repo: REPO_NAME,
    title: `[test] integration test ${Date.now()}`,
    body: 'Created by SlayZone integration test'
  })
  expect(issue.title.startsWith('[test]')).toBe(true)
  expect(issue.state).toBe('open')
  expect(issue.repository.owner).toBe(REPO_OWNER)
  createdIssueNumber = issue.number
  createdIssueId = issue.id
  createdIssues.push({ owner: REPO_OWNER, repo: REPO_NAME, number: createdIssueNumber })
  ok('createIssue creates issue')
} catch (e) { no('createIssue creates issue', e) }

if (createdIssueNumber) {
  try {
    const issue = await githubClient.getIssue(GITHUB_TOKEN, {
      owner: REPO_OWNER, repo: REPO_NAME, number: createdIssueNumber
    })
    expect(issue).toBeTruthy()
    expect(issue!.number).toBe(createdIssueNumber)
    ok('getIssue fetches created issue')
  } catch (e) { no('getIssue fetches created issue', e) }

  try {
    const updated = await githubClient.updateIssue(GITHUB_TOKEN, {
      owner: REPO_OWNER, repo: REPO_NAME, number: createdIssueNumber,
      title: `[test] updated ${Date.now()}`,
      body: 'Updated body',
      state: 'open'
    })
    expect(updated).toBeTruthy()
    expect(updated!.title.startsWith('[test] updated')).toBe(true)
    ok('updateIssue updates title + body')
  } catch (e) { no('updateIssue updates title + body', e) }

  try {
    const { issues } = await githubClient.listIssues(GITHUB_TOKEN, {
      owner: REPO_OWNER, repo: REPO_NAME, limit: 50
    })
    const found = issues.find(i => i.number === createdIssueNumber)
    expect(found).toBeTruthy()
    ok('listIssues includes created issue')
  } catch (e) { no('listIssues includes created issue', e) }
}

// ── Import flow (handler-level) ───────────────────────────────────────────
console.log('\nGitHub: Import flow')
if (createdIssueNumber) {
  const { projectId, connectionId } = seedFullMapping(h.db, 'github', GITHUB_TOKEN, {
    teamId: REPO_OWNER,
    teamKey: REPO_OWNER,
    syncMode: 'two_way',
    repoOwner: REPO_OWNER,
    repoName: REPO_NAME
  })

  try {
    const result = await h.invoke('integrations:import-github-repository-issues', {
      projectId, connectionId,
      repositoryFullName: GITHUB_TEST_REPO,
      selectedIssueIds: [createdIssueId]
    }) as any
    expect(result.imported).toBeGreaterThan(0)

    const tasks = h.db.prepare('SELECT * FROM tasks WHERE project_id = ?').all(projectId) as any[]
    expect(tasks.length).toBeGreaterThan(0)

    const links = h.db.prepare(
      "SELECT * FROM external_links WHERE connection_id = ? AND provider = 'github'"
    ).all(connectionId) as any[]
    expect(links.length).toBeGreaterThan(0)
    ok('import creates local task + external link')
  } catch (e) { no('import creates local task + external link', e) }

  try {
    const result = await h.invoke('integrations:import-github-repository-issues', {
      projectId, connectionId,
      repositoryFullName: GITHUB_TEST_REPO,
      selectedIssueIds: [createdIssueId]
    }) as any
    const tasks = h.db.prepare('SELECT * FROM tasks WHERE project_id = ?').all(projectId) as any[]
    expect(tasks.length).toBe(1)
    ok('re-import deduplicates')
  } catch (e) { no('re-import deduplicates', e) }

  // ── Two-way sync ──────────────────────────────────────────────────────
  console.log('\nGitHub: Two-way sync')

  // Push: make local newer
  try {
    const task = (h.db.prepare('SELECT * FROM tasks WHERE project_id = ?').get(projectId) as any)
    const pushedTitle = `[test] pushed from local ${Date.now()}`
    h.db.prepare("UPDATE tasks SET title = ?, updated_at = '2099-01-01 00:00:00' WHERE id = ?")
      .run(pushedTitle, task.id)

    const result = await h.invoke('integrations:sync-now', { taskId: task.id }) as any
    expect(result.scanned).toBe(1)
    expect(result.pushed).toBe(1)

    const remote = await githubClient.getIssue(GITHUB_TOKEN, {
      owner: REPO_OWNER, repo: REPO_NAME, number: createdIssueNumber
    })
    expect(remote!.title).toBe(pushedTitle)
    ok('push: local newer → updates remote')
  } catch (e) { no('push: local newer → updates remote', e) }

  // Pull: update remote, make local old
  try {
    const task = (h.db.prepare('SELECT * FROM tasks WHERE project_id = ?').get(projectId) as any)
    const newTitle = `[test] pulled from remote ${Date.now()}`
    await githubClient.updateIssue(GITHUB_TOKEN, {
      owner: REPO_OWNER, repo: REPO_NAME, number: createdIssueNumber,
      title: newTitle, body: null, state: 'open'
    })

    h.db.prepare("UPDATE tasks SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").run(task.id)
    h.db.prepare('DELETE FROM external_field_state').run()

    const result = await h.invoke('integrations:sync-now', { taskId: task.id }) as any
    expect(result.scanned).toBe(1)
    expect(result.pulled).toBe(1)

    const updatedTask = h.db.prepare('SELECT title FROM tasks WHERE id = ?').get(task.id) as any
    expect(updatedTask.title).toBe(newTitle)
    ok('pull: remote newer → updates local')
  } catch (e) { no('pull: remote newer → updates local', e) }

  // Archive sync: close remote → local archived_at set
  try {
    const task = (h.db.prepare('SELECT * FROM tasks WHERE project_id = ?').get(projectId) as any)
    await githubClient.updateIssue(GITHUB_TOKEN, {
      owner: REPO_OWNER, repo: REPO_NAME, number: createdIssueNumber,
      title: task.title, body: null, state: 'closed'
    })

    h.db.prepare("UPDATE tasks SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").run(task.id)
    h.db.prepare('DELETE FROM external_field_state').run()

    await h.invoke('integrations:sync-now', { taskId: task.id })
    const updatedTask = h.db.prepare('SELECT archived_at FROM tasks WHERE id = ?').get(task.id) as any
    expect(updatedTask.archived_at).toBeTruthy()
    ok('close remote → local archived')
  } catch (e) { no('close remote → local archived', e) }

  // Reopen remote → local unarchived
  try {
    const task = (h.db.prepare('SELECT * FROM tasks WHERE project_id = ?').get(projectId) as any)
    await githubClient.updateIssue(GITHUB_TOKEN, {
      owner: REPO_OWNER, repo: REPO_NAME, number: createdIssueNumber,
      title: task.title, body: null, state: 'open'
    })

    h.db.prepare("UPDATE tasks SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").run(task.id)
    h.db.prepare('DELETE FROM external_field_state').run()

    await h.invoke('integrations:sync-now', { taskId: task.id })
    const updatedTask = h.db.prepare('SELECT archived_at FROM tasks WHERE id = ?').get(task.id) as any
    expect(updatedTask.archived_at).toBeNull()
    ok('reopen remote → local unarchived')
  } catch (e) { no('reopen remote → local unarchived', e) }

  // One-way mode: should not push
  try {
    h.db.prepare("UPDATE integration_project_mappings SET sync_mode = 'one_way' WHERE project_id = ?")
      .run(projectId)
    const task = (h.db.prepare('SELECT * FROM tasks WHERE project_id = ?').get(projectId) as any)
    h.db.prepare("UPDATE tasks SET title = '[test] should not push', updated_at = '2099-01-01 00:00:00' WHERE id = ?")
      .run(task.id)

    const result = await h.invoke('integrations:sync-now', { taskId: task.id }) as any
    expect(result.pushed).toBe(0)
    ok('one_way mode does not push')
  } catch (e) { no('one_way mode does not push', e) }

  // Restore two_way
  h.db.prepare("UPDATE integration_project_mappings SET sync_mode = 'two_way' WHERE project_id = ?")
    .run(projectId)

  // ── Push archive / unarchive ──────────────────────────────────────────
  console.log('\nGitHub: Push archive/unarchive')
  try {
    const task = (h.db.prepare('SELECT * FROM tasks WHERE project_id = ?').get(projectId) as any)
    await githubClient.updateIssue(GITHUB_TOKEN, {
      owner: REPO_OWNER, repo: REPO_NAME, number: createdIssueNumber,
      title: task.title, body: null, state: 'open'
    })
    await pushArchiveToProviders(h.db, task.id)

    const remote = await githubClient.getIssue(GITHUB_TOKEN, {
      owner: REPO_OWNER, repo: REPO_NAME, number: createdIssueNumber
    })
    expect(remote!.state).toBe('closed')
    ok('pushArchiveToProviders → remote closed')
  } catch (e) { no('pushArchiveToProviders → remote closed', e) }

  try {
    const task = (h.db.prepare('SELECT * FROM tasks WHERE project_id = ?').get(projectId) as any)
    await pushUnarchiveToProviders(h.db, task.id)

    const remote = await githubClient.getIssue(GITHUB_TOKEN, {
      owner: REPO_OWNER, repo: REPO_NAME, number: createdIssueNumber
    })
    expect(remote!.state).toBe('open')
    ok('pushUnarchiveToProviders → remote open')
  } catch (e) { no('pushUnarchiveToProviders → remote open', e) }

  // ── get-task-sync-status ──────────────────────────────────────────────
  console.log('\nGitHub: Sync status')
  try {
    const task = (h.db.prepare('SELECT * FROM tasks WHERE project_id = ?').get(projectId) as any)
    const status = await h.invoke('integrations:get-task-sync-status', task.id, 'github') as any
    expect(status.provider).toBe('github')
    expect(status.taskId).toBe(task.id)
    expect(['in_sync', 'local_ahead', 'remote_ahead', 'conflict', 'unknown'].includes(status.state)).toBe(true)
    expect(Array.isArray(status.fields)).toBe(true)
    ok('get-task-sync-status returns valid status')
  } catch (e) { no('get-task-sync-status returns valid status', e) }

  // ── push-task (manual force push) ─────────────────────────────────────
  console.log('\nGitHub: Manual push/pull')
  try {
    const task = (h.db.prepare('SELECT * FROM tasks WHERE project_id = ?').get(projectId) as any)
    const forcePushTitle = `[test] force pushed ${Date.now()}`
    h.db.prepare("UPDATE tasks SET title = ?, updated_at = datetime('now') WHERE id = ?")
      .run(forcePushTitle, task.id)

    const result = await h.invoke('integrations:push-task', {
      taskId: task.id, provider: 'github', force: true
    }) as any
    expect(result.pushed).toBe(true)

    const remote = await githubClient.getIssue(GITHUB_TOKEN, {
      owner: REPO_OWNER, repo: REPO_NAME, number: createdIssueNumber
    })
    expect(remote!.title).toBe(forcePushTitle)
    ok('push-task force pushes local → remote')
  } catch (e) { no('push-task force pushes local → remote', e) }

  // ── pull-task (manual force pull) ─────────────────────────────────────
  try {
    const task = (h.db.prepare('SELECT * FROM tasks WHERE project_id = ?').get(projectId) as any)
    const forcePullTitle = `[test] force pulled ${Date.now()}`
    await githubClient.updateIssue(GITHUB_TOKEN, {
      owner: REPO_OWNER, repo: REPO_NAME, number: createdIssueNumber,
      title: forcePullTitle, body: null, state: 'open'
    })

    const result = await h.invoke('integrations:pull-task', {
      taskId: task.id, provider: 'github', force: true
    }) as any
    expect(result.pulled).toBe(true)

    const updatedTask = h.db.prepare('SELECT title FROM tasks WHERE id = ?').get(task.id) as any
    expect(updatedTask.title).toBe(forcePullTitle)
    ok('pull-task force pulls remote → local')
  } catch (e) { no('pull-task force pulls remote → local', e) }

  // ── Conflict detection ────────────────────────────────────────────────
  console.log('\nGitHub: Conflict detection')
  try {
    const task = (h.db.prepare('SELECT * FROM tasks WHERE project_id = ?').get(projectId) as any)

    // Establish baseline via force pull
    await h.invoke('integrations:pull-task', {
      taskId: task.id, provider: 'github', force: true
    })

    // Change both sides
    h.db.prepare("UPDATE tasks SET title = '[test] local conflict', updated_at = datetime('now') WHERE id = ?")
      .run(task.id)
    await githubClient.updateIssue(GITHUB_TOKEN, {
      owner: REPO_OWNER, repo: REPO_NAME, number: createdIssueNumber,
      title: `[test] remote conflict ${Date.now()}`, body: null, state: 'open'
    })

    const status = await h.invoke('integrations:get-task-sync-status', task.id, 'github') as any
    expect(status.fields.length).toBeGreaterThan(0)
    const titleField = status.fields.find((f: any) => f.field === 'title')
    expect(titleField).toBeTruthy()
    expect(titleField.state !== 'in_sync').toBe(true)
    ok('conflict detected when both sides change')
  } catch (e) { no('conflict detected when both sides change', e) }

  // ── Discovery (scoped) ────────────────────────────────────────────────
  console.log('\nGitHub: Discovery')
  {
    const disco = seedFullMapping(h.db, 'github', GITHUB_TOKEN, {
      teamId: REPO_OWNER, teamKey: REPO_OWNER,
      syncMode: 'two_way', repoOwner: REPO_OWNER, repoName: REPO_NAME
    })

    try {
      const discoveryIssue = await githubClient.createIssue(GITHUB_TOKEN, {
        owner: REPO_OWNER, repo: REPO_NAME,
        title: `[test] discovery target ${Date.now()}`
      })
      createdIssues.push({ owner: REPO_OWNER, repo: REPO_NAME, number: discoveryIssue.number })

      h.db.prepare("UPDATE integration_project_mappings SET last_discovery_at = NULL WHERE id = ?")
        .run(disco.mappingId)

      const tasksBefore = h.db.prepare('SELECT * FROM tasks WHERE project_id = ?').all(disco.projectId) as any[]
      await runScopedDiscovery(h.db, disco.mappingId)
      const tasksAfter = h.db.prepare('SELECT * FROM tasks WHERE project_id = ?').all(disco.projectId) as any[]

      expect(tasksAfter.length).toBeGreaterThan(tasksBefore.length)
      ok('runDiscovery auto-imports unlinked issues')
    } catch (e) { no('runDiscovery auto-imports unlinked issues', e) }
  }

  // ── Push create ───────────────────────────────────────────────────────
  console.log('\nGitHub: Push create (new task → remote)')
  try {
    const newTaskId = crypto.randomUUID()
    h.db.prepare(`INSERT INTO tasks
      (id, project_id, title, description, status, priority, terminal_mode, provider_config, claude_flags, codex_flags, created_at, updated_at)
      VALUES (?, ?, ?, null, 'todo', 3, 'claude-code', '{}', '', '', datetime('now'), datetime('now'))`)
      .run(newTaskId, projectId, `[test] push-created ${Date.now()}`)

    await pushNewTaskToProviders(h.db, newTaskId, projectId)

    const link = h.db.prepare(
      "SELECT * FROM external_links WHERE task_id = ? AND provider = 'github'"
    ).get(newTaskId) as any

    expect(link).toBeTruthy()
    expect(link.external_key).toBeTruthy()

    const parsed = parseGitHubExternalKey(link.external_key)
    expect(parsed).toBeTruthy()
    createdIssues.push({ owner: parsed!.owner, repo: parsed!.repo, number: parsed!.number })

    const remote = await githubClient.getIssue(GITHUB_TOKEN, {
      owner: parsed!.owner, repo: parsed!.repo, number: parsed!.number
    })
    expect(remote).toBeTruthy()
    expect(remote!.title.startsWith('[test] push-created')).toBe(true)
    ok('pushNewTaskToProviders creates remote issue')
  } catch (e) { no('pushNewTaskToProviders creates remote issue', e) }
}

// ── Projects V2: Status sync ─────────────────────────────────────────────
if (GITHUB_TEST_PROJECT_ID) {
  console.log('\nGitHub: Projects V2 status sync')

  let statuses: ProviderStatus[] = []
  try {
    const { projectId: statusProjectId, connectionId: statusConnId, mappingId: statusMappingId } = seedFullMapping(
      h.db, 'github', GITHUB_TOKEN, {
        teamId: REPO_OWNER, teamKey: REPO_OWNER,
        syncMode: 'two_way', repoOwner: REPO_OWNER, repoName: REPO_NAME
      }
    )
    h.db.prepare('UPDATE integration_project_mappings SET external_project_id = ? WHERE id = ?')
      .run(GITHUB_TEST_PROJECT_ID, statusMappingId)

    statuses = await h.invoke('integrations:fetch-provider-statuses', {
      connectionId: statusConnId,
      provider: 'github',
      externalTeamId: REPO_OWNER,
      externalProjectId: GITHUB_TEST_PROJECT_ID
    }) as ProviderStatus[]
    expect(statuses.length).toBeGreaterThan(0)
    ok('fetch-provider-statuses returns project statuses')

    try {
      await h.invoke('integrations:apply-status-sync', {
        projectId: statusProjectId,
        provider: 'github',
        statuses
      })

      const project = h.db.prepare('SELECT columns_config FROM projects WHERE id = ?').get(statusProjectId) as any
      expect(project.columns_config).toBeTruthy()
      const columns = JSON.parse(project.columns_config)
      expect(columns.length).toBeGreaterThan(0)

      const mappings = h.db.prepare(
        'SELECT * FROM integration_state_mappings WHERE project_mapping_id = ?'
      ).all(statusMappingId) as any[]
      expect(mappings.length).toBe(statuses.length)
      ok('apply-status-sync creates columns + state mappings')
    } catch (e) { no('apply-status-sync creates columns + state mappings', e) }

    try {
      const preview = await h.invoke('integrations:resync-provider-statuses', {
        projectId: statusProjectId,
        provider: 'github'
      }) as any
      expect(preview.diff.added.length).toBe(0)
      expect(preview.diff.removed.length).toBe(0)
      ok('resync-provider-statuses shows no diff after fresh apply')
    } catch (e) { no('resync-provider-statuses shows no diff after fresh apply', e) }

    try {
      const options = await githubClient.listProjectStatusOptions(GITHUB_TOKEN, GITHUB_TEST_PROJECT_ID)
      expect(options.length).toBeGreaterThan(0)
      expect(options[0].name).toBeTruthy()
      expect(options[0].id).toBeTruthy()
      ok('listProjectStatusOptions returns status field options')
    } catch (e) { no('listProjectStatusOptions returns status field options', e) }

  } catch (e) { no('fetch-provider-statuses returns project statuses', e) }
} else {
  console.log('\nGitHub: Projects V2 status sync (skipped: no GITHUB_TEST_PROJECT_ID)')
}

// ── Cleanup ───────────────────────────────────────────────────────────────
console.log('\nGitHub: Cleanup')
if (createdIssues.length > 0) {
  await cleanupGithubIssues(GITHUB_TOKEN, createdIssues)
  console.log(`  closed ${createdIssues.length} test issues`)
}

h.cleanup()
console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
console.log('\nDone')
