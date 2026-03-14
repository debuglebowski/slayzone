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

// ── Connect (handler-level) ───────────────────────────────────────────────
console.log('\nGitHub: Connect handler')
let handlerConnectionId = ''
try {
  const result = await h.invoke('integrations:connect-github', { token: GITHUB_TOKEN }) as any
  expect(result.provider).toBe('github')
  expect(result.enabled).toBe(true)
  expect('credential_ref' in result).toBe(false)
  handlerConnectionId = result.id
  ok('connect-github creates connection')
} catch (e) { no('connect-github creates connection', e) }

try {
  let threw = false
  try { await h.invoke('integrations:connect-github', { token: '  ' }) } catch { threw = true }
  expect(threw).toBe(true)
  ok('connect-github rejects empty token')
} catch (e) { no('connect-github rejects empty token', e) }

// ── Connection management (handler-level) ────────────────────────────────
console.log('\nGitHub: Connection management')
if (handlerConnectionId) {
  try {
    const connections = await h.invoke('integrations:list-connections', 'github') as any[]
    expect(connections.length).toBeGreaterThan(0)
    const found = connections.find((c: any) => c.id === handlerConnectionId)
    expect(found).toBeTruthy()
    ok('list-connections returns github connections')
  } catch (e) { no('list-connections returns github connections', e) }

  try {
    const usage = await h.invoke('integrations:get-connection-usage', handlerConnectionId) as any
    expect(typeof usage.mapped_project_count).toBe('number')
    ok('get-connection-usage returns usage')
  } catch (e) { no('get-connection-usage returns usage', e) }

  try {
    await h.invoke('integrations:update-connection', {
      connectionId: handlerConnectionId, credential: GITHUB_TOKEN
    })
    ok('update-connection updates credential')
  } catch (e) { no('update-connection updates credential', e) }

  // set/get/clear project connection
  const connTestProjectId = `proj-conn-test-${Date.now()}`
  h.db.prepare(`INSERT INTO projects (id, name, color, path, created_at, updated_at)
    VALUES (?, 'Conn Test', '#888888', '/tmp/conn-test', datetime('now'), datetime('now'))`)
    .run(connTestProjectId)

  try {
    await h.invoke('integrations:set-project-connection', {
      projectId: connTestProjectId, provider: 'github', connectionId: handlerConnectionId
    })
    const connId = await h.invoke('integrations:get-project-connection', connTestProjectId, 'github') as any
    expect(connId).toBeTruthy()
    expect(connId).toBe(handlerConnectionId)
    ok('set/get-project-connection works')
  } catch (e) { no('set/get-project-connection works', e) }

  // Use a disposable connection for clear test so handlerConnectionId survives
  const clearConnResult = await h.invoke('integrations:connect-github', { token: GITHUB_TOKEN }) as any
  const clearConnId = clearConnResult.id
  const clearProjectId = `proj-clear-conn-${Date.now()}`
  h.db.prepare(`INSERT INTO projects (id, name, color, path, created_at, updated_at)
    VALUES (?, 'Clear Conn', '#888888', '/tmp/clear-conn', datetime('now'), datetime('now'))`)
    .run(clearProjectId)
  await h.invoke('integrations:set-project-connection', {
    projectId: clearProjectId, provider: 'github', connectionId: clearConnId
  })

  try {
    await h.invoke('integrations:clear-project-connection', {
      projectId: clearProjectId, provider: 'github'
    })
    const connId = await h.invoke('integrations:get-project-connection', clearProjectId, 'github') as any
    expect(connId).toBeNull()
    ok('clear-project-connection removes connection')
  } catch (e) { no('clear-project-connection removes connection', e) }
}

// ── Discovery ─────────────────────────────────────────────────────────────
console.log('\nGitHub: Discovery')
try {
  const repos = await githubClient.listRepositories(GITHUB_TOKEN)
  expect(repos.length).toBeGreaterThan(0)
  const testRepo = repos.find(r => r.fullName === GITHUB_TEST_REPO)
  expect(testRepo).toBeTruthy()
  ok('listRepositories includes test repo')
} catch (e) { no('listRepositories includes test repo', e) }

if (handlerConnectionId) {
  try {
    const repos = await h.invoke('integrations:list-github-repositories', handlerConnectionId) as any[]
    expect(repos.length).toBeGreaterThan(0)
    ok('list-github-repositories handler returns repos')
  } catch (e) { no('list-github-repositories handler returns repos', e) }

  try {
    const projects = await h.invoke('integrations:list-github-projects', handlerConnectionId) as any[]
    expect(Array.isArray(projects)).toBe(true)
    ok('list-github-projects handler returns array')
  } catch (e) { no('list-github-projects handler returns array', e) }

  if (GITHUB_TEST_PROJECT_ID) {
    try {
      const result = await h.invoke('integrations:list-github-issues', {
        connectionId: handlerConnectionId, githubProjectId: GITHUB_TEST_PROJECT_ID, limit: 5
      }) as any
      expect(Array.isArray(result.issues)).toBe(true)
      ok('list-github-issues handler returns project issues')
    } catch (e) { no('list-github-issues handler returns project issues', e) }
  }

  try {
    const result = await h.invoke('integrations:list-github-repository-issues', {
      connectionId: handlerConnectionId, repositoryFullName: GITHUB_TEST_REPO, limit: 5
    }) as any
    expect(Array.isArray(result.issues)).toBe(true)
    ok('list-github-repository-issues handler returns repo issues')
  } catch (e) { no('list-github-repository-issues handler returns repo issues', e) }
}

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

  // ── push-task guards ──────────────────────────────────────────────────
  console.log('\nGitHub: Push/pull guards')
  try {
    const task = (h.db.prepare('SELECT * FROM tasks WHERE project_id = ? LIMIT 1').get(projectId) as any)
    // Force pull to establish baseline + in-sync state
    await h.invoke('integrations:pull-task', { taskId: task.id, provider: 'github', force: true })

    // In-sync → should return pushed=false
    const result = await h.invoke('integrations:push-task', {
      taskId: task.id, provider: 'github'
    }) as any
    expect(result.pushed).toBe(false)
    expect(result.message.includes('already in sync')).toBe(true)
    ok('push-task returns false when in sync')
  } catch (e) { no('push-task returns false when in sync', e) }

  try {
    const task = (h.db.prepare('SELECT * FROM tasks WHERE project_id = ? LIMIT 1').get(projectId) as any)
    // Force push to establish baseline
    h.db.prepare("UPDATE tasks SET title = '[test] baseline', updated_at = datetime('now') WHERE id = ?").run(task.id)
    await h.invoke('integrations:push-task', { taskId: task.id, provider: 'github', force: true })

    // Update remote, then try non-force push → should refuse
    await githubClient.updateIssue(GITHUB_TOKEN, {
      owner: REPO_OWNER, repo: REPO_NAME, number: createdIssueNumber,
      title: `[test] remote changed ${Date.now()}`, body: null, state: 'open'
    })
    h.db.prepare("UPDATE tasks SET title = '[test] local changed', updated_at = datetime('now') WHERE id = ?").run(task.id)

    const result = await h.invoke('integrations:push-task', {
      taskId: task.id, provider: 'github'
    }) as any
    expect(result.pushed).toBe(false)
    expect(result.message.includes('Remote changes detected')).toBe(true)
    ok('push-task refuses when remote ahead without force')
  } catch (e) { no('push-task refuses when remote ahead without force', e) }

  try {
    const task = (h.db.prepare('SELECT * FROM tasks WHERE project_id = ? LIMIT 1').get(projectId) as any)
    // Force pull to establish baseline
    await h.invoke('integrations:pull-task', { taskId: task.id, provider: 'github', force: true })

    // Update local, then try non-force pull → should refuse
    h.db.prepare("UPDATE tasks SET title = '[test] local only', updated_at = datetime('now') WHERE id = ?").run(task.id)

    const result = await h.invoke('integrations:pull-task', {
      taskId: task.id, provider: 'github'
    }) as any
    expect(result.pulled).toBe(false)
    expect(result.message.includes('Local changes detected')).toBe(true)
    ok('pull-task refuses when local ahead without force')
  } catch (e) { no('pull-task refuses when local ahead without force', e) }

  // ── push-unlinked-tasks ───────────────────────────────────────────────
  console.log('\nGitHub: Push unlinked tasks')
  try {
    const unlinkedIds: string[] = []
    for (let i = 0; i < 2; i++) {
      const id = crypto.randomUUID()
      h.db.prepare(`INSERT INTO tasks
        (id, project_id, title, description, status, priority, terminal_mode, provider_config, claude_flags, codex_flags, created_at, updated_at)
        VALUES (?, ?, ?, null, 'todo', 3, 'claude-code', '{}', '', '', datetime('now'), datetime('now'))`)
        .run(id, projectId, `[test] unlinked ${i} ${Date.now()}`)
      unlinkedIds.push(id)
    }

    const result = await h.invoke('integrations:push-unlinked-tasks', {
      projectId, provider: 'github'
    }) as any
    expect(result.pushed).toBeGreaterThan(0)

    for (const id of unlinkedIds) {
      const link = h.db.prepare("SELECT * FROM external_links WHERE task_id = ? AND provider = 'github'").get(id) as any
      expect(link).toBeTruthy()
      const parsed = parseGitHubExternalKey(link.external_key)
      if (parsed) createdIssues.push({ owner: parsed.owner, repo: parsed.repo, number: parsed.number })
    }
    ok('push-unlinked-tasks creates remote issues + links')
  } catch (e) { no('push-unlinked-tasks creates remote issues + links', e) }

  // Race guard: calling again should push 0
  try {
    const result = await h.invoke('integrations:push-unlinked-tasks', {
      projectId, provider: 'github'
    }) as any
    expect(result.pushed).toBe(0)
    ok('push-unlinked-tasks skips already-linked tasks')
  } catch (e) { no('push-unlinked-tasks skips already-linked tasks', e) }

  // Temporary tasks should be excluded
  try {
    const tempId = crypto.randomUUID()
    h.db.prepare(`INSERT INTO tasks
      (id, project_id, title, description, status, priority, terminal_mode, provider_config, claude_flags, codex_flags, is_temporary, created_at, updated_at)
      VALUES (?, ?, ?, null, 'todo', 3, 'claude-code', '{}', '', '', 1, datetime('now'), datetime('now'))`)
      .run(tempId, projectId, `[test] temporary ${Date.now()}`)

    const result = await h.invoke('integrations:push-unlinked-tasks', {
      projectId, provider: 'github'
    }) as any
    expect(result.pushed).toBe(0)

    const link = h.db.prepare("SELECT * FROM external_links WHERE task_id = ? AND provider = 'github'").get(tempId) as any
    expect(link).toBeUndefined()
    ok('push-unlinked-tasks excludes temporary tasks')
  } catch (e) { no('push-unlinked-tasks excludes temporary tasks', e) }

  // ── Pagination ────────────────────────────────────────────────────────
  console.log('\nGitHub: Pagination')
  try {
    const { issues, nextCursor } = await githubClient.listIssues(GITHUB_TOKEN, {
      owner: REPO_OWNER, repo: REPO_NAME, limit: 2
    })
    expect(issues.length).toBeGreaterThan(0)
    // With many test issues created, page 2 should exist
    if (nextCursor) {
      const page2 = await githubClient.listIssues(GITHUB_TOKEN, {
        owner: REPO_OWNER, repo: REPO_NAME, limit: 2, cursor: nextCursor
      })
      expect(page2.issues.length).toBeGreaterThan(0)
      // No overlap between pages
      const page1Ids = new Set(issues.map(i => i.id))
      const overlap = page2.issues.filter(i => page1Ids.has(i.id))
      expect(overlap.length).toBe(0)
      ok('listIssues pagination returns distinct pages')
    } else {
      ok('listIssues pagination returns distinct pages (skipped: only 1 page)')
    }
  } catch (e) { no('listIssues pagination returns distinct pages', e) }

  // ── Error handling ────────────────────────────────────────────────────
  console.log('\nGitHub: Error handling')
  try {
    let threw = false
    try {
      await githubClient.getViewer('ghp_invalid_token_xxxxx')
    } catch { threw = true }
    expect(threw).toBe(true)
    ok('invalid token throws')
  } catch (e) { no('invalid token throws', e) }

  try {
    let threw = false
    try {
      await githubClient.getIssue(GITHUB_TOKEN, {
        owner: REPO_OWNER, repo: REPO_NAME, number: 999999
      })
    } catch { threw = true }
    expect(threw).toBe(true)
    ok('nonexistent issue throws')
  } catch (e) { no('nonexistent issue throws', e) }

  try {
    let threw = false
    try {
      await githubClient.listIssues(GITHUB_TOKEN, {
        owner: 'nonexistent-owner-xyz', repo: 'nonexistent-repo', limit: 10
      })
    } catch { threw = true }
    expect(threw).toBe(true)
    ok('nonexistent repo throws')
  } catch (e) { no('nonexistent repo throws', e) }

  // ── Status mapping ────────────────────────────────────────────────────
  console.log('\nGitHub: Status mapping')
  try {
    const task = (h.db.prepare('SELECT * FROM tasks WHERE project_id = ? LIMIT 1').get(projectId) as any)
    // Close remote → sync → verify local status maps to done
    await githubClient.updateIssue(GITHUB_TOKEN, {
      owner: REPO_OWNER, repo: REPO_NAME, number: createdIssueNumber,
      title: task.title, body: null, state: 'closed'
    })
    h.db.prepare("UPDATE tasks SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").run(task.id)
    h.db.prepare('DELETE FROM external_field_state').run()

    await h.invoke('integrations:sync-now', { taskId: task.id })
    const updatedTask = h.db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id) as any
    expect(updatedTask.status).toBe('done')
    ok('closed remote → done status')

    // Reopen remote → sync → verify local status maps back to open status
    await githubClient.updateIssue(GITHUB_TOKEN, {
      owner: REPO_OWNER, repo: REPO_NAME, number: createdIssueNumber,
      title: task.title, body: null, state: 'open'
    })
    h.db.prepare("UPDATE tasks SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").run(task.id)
    h.db.prepare('DELETE FROM external_field_state').run()

    await h.invoke('integrations:sync-now', { taskId: task.id })
    const reopenedTask = h.db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id) as any
    expect(reopenedTask.status !== 'done').toBe(true)
    ok('reopened remote → non-done status')
  } catch (e) { no('status mapping', e) }

  // ── Batch fetch ───────────────────────────────────────────────────────
  console.log('\nGitHub: Batch fetch')
  try {
    // Collect a few linked issues for batch test
    const links = h.db.prepare(
      "SELECT external_id, external_key FROM external_links WHERE connection_id = ? AND provider = 'github' LIMIT 3"
    ).all(connectionId) as Array<{ external_id: string; external_key: string }>

    if (links.length > 0) {
      const batchInput = links.map(l => {
        const parsed = parseGitHubExternalKey(l.external_key)!
        return { id: l.external_id, owner: parsed.owner, repo: parsed.repo, number: parsed.number }
      })
      const batchResult = await githubClient.getIssuesBatch(GITHUB_TOKEN, batchInput)
      expect(batchResult.size).toBe(links.length)
      ok('getIssuesBatch returns all requested issues')
    } else {
      ok('getIssuesBatch returns all requested issues (skipped: no links)')
    }
  } catch (e) { no('getIssuesBatch returns all requested issues', e) }

  try {
    const emptyResult = await githubClient.getIssuesBatch(GITHUB_TOKEN, [])
    expect(emptyResult.size).toBe(0)
    ok('getIssuesBatch with empty array returns empty map')
  } catch (e) { no('getIssuesBatch with empty array returns empty map', e) }
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

// ── Destructive: clear-project-provider + disconnect (run last) ──────────
console.log('\nGitHub: Clear/disconnect')
{
  // Use a fresh mapping to test clear-project-provider without affecting other tests
  const clearTest = seedFullMapping(h.db, 'github', GITHUB_TOKEN, {
    teamId: REPO_OWNER, teamKey: REPO_OWNER,
    syncMode: 'two_way', repoOwner: REPO_OWNER, repoName: REPO_NAME
  })
  // Create a task + link in this mapping
  const clearTaskId = crypto.randomUUID()
  h.db.prepare(`INSERT INTO tasks (id, project_id, title, status, priority, terminal_mode, provider_config, claude_flags, codex_flags, created_at, updated_at)
    VALUES (?, ?, 'clear test', 'todo', 3, 'claude-code', '{}', '', '', datetime('now'), datetime('now'))`)
    .run(clearTaskId, clearTest.projectId)
  h.db.prepare(`INSERT INTO external_links (id, provider, connection_id, external_type, external_id, external_key, external_url, task_id, sync_state, created_at, updated_at)
    VALUES (?, 'github', ?, 'issue', 'ext-clear', 'owner/repo#999', '', ?, 'active', datetime('now'), datetime('now'))`)
    .run(crypto.randomUUID(), clearTest.connectionId, clearTaskId)

  try {
    await h.invoke('integrations:clear-project-provider', { projectId: clearTest.projectId, provider: 'github' })
    const links = h.db.prepare("SELECT * FROM external_links WHERE task_id = ? AND provider = 'github'").all(clearTaskId) as any[]
    expect(links.length).toBe(0)
    const mapping = h.db.prepare("SELECT * FROM integration_project_mappings WHERE id = ?").get(clearTest.mappingId) as any
    expect(mapping).toBeUndefined()
    // Task should still exist (only link removed)
    const task = h.db.prepare("SELECT * FROM tasks WHERE id = ?").get(clearTaskId) as any
    expect(task).toBeTruthy()
    ok('clear-project-provider removes links/mappings, keeps tasks')
  } catch (e) { no('clear-project-provider removes links/mappings, keeps tasks', e) }

  // Disconnect handler connection (if we created one via connect-github handler)
  if (handlerConnectionId) {
    try {
      await h.invoke('integrations:disconnect', handlerConnectionId)
      const conn = h.db.prepare("SELECT * FROM integration_connections WHERE id = ?").get(handlerConnectionId) as any
      expect(conn).toBeUndefined()
      ok('disconnect removes connection')
    } catch (e) { no('disconnect removes connection', e) }
  }
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
