/**
 * Integration tests for Linear — hits real API.
 * Requires: LINEAR_API_KEY, LINEAR_TEST_TEAM_ID (auto-loaded from .env)
 *
 * Run: npx tsx packages/domains/integrations/src/main/handlers.integration.linear.test.ts
 */
import { createTestHarness, expect } from '../../../../shared/test-utils/ipc-harness.js'
import { registerIntegrationHandlers } from './handlers'
import {
  requireEnv, seedFullMapping, cleanupLinearIssues,
  registerCleanup, startSuiteTimeout, runScopedDiscovery
} from './integration-test-helpers'
import * as linearClient from './linear-client'
import { pushNewTaskToProviders, pushArchiveToProviders, pushUnarchiveToProviders } from './sync'
import type { ProviderStatus } from '../shared'

process.env.SLAYZONE_ALLOW_PLAINTEXT_CREDENTIALS = '1'

const LINEAR_API_KEY = requireEnv('LINEAR_API_KEY')
const LINEAR_TEST_TEAM_ID = requireEnv('LINEAR_TEST_TEAM_ID')

startSuiteTimeout()

let pass = 0
let fail = 0
const createdIssueIds: string[] = []

// Register crash-safe cleanup
registerCleanup(async () => {
  if (createdIssueIds.length > 0) {
    console.log('\n  cleaning up Linear issues...')
    await cleanupLinearIssues(LINEAR_API_KEY, createdIssueIds)
  }
})

function ok(name: string) { pass++; console.log(`  ✓ ${name}`) }
function no(name: string, e: unknown) { fail++; console.log(`  ✗ ${name}`); console.error(`    ${e}`); process.exitCode = 1 }

const h = await createTestHarness()
registerIntegrationHandlers(h.ipcMain as any, h.db)

// ── Auth ──────────────────────────────────────────────────────────────────
console.log('\nLinear: Auth')
try {
  const viewer = await linearClient.getViewer(LINEAR_API_KEY)
  expect(viewer.workspaceId).toBeTruthy()
  expect(viewer.workspaceName).toBeTruthy()
  expect(viewer.accountLabel).toBeTruthy()
  ok('getViewer returns workspace info')
} catch (e) { no('getViewer returns workspace info', e) }

// ── Connect (handler-level) ───────────────────────────────────────────────
console.log('\nLinear: Connect handler')
let handlerConnectionId = ''
try {
  const result = await h.invoke('integrations:connect-linear', { apiKey: LINEAR_API_KEY }) as any
  expect(result.provider).toBe('linear')
  expect(result.enabled).toBe(true)
  expect('credential_ref' in result).toBe(false)
  handlerConnectionId = result.id
  ok('connect-linear creates connection via handler')
} catch (e) { no('connect-linear creates connection via handler', e) }

try {
  let threw = false
  try { await h.invoke('integrations:connect-linear', { apiKey: '  ' }) } catch { threw = true }
  expect(threw).toBe(true)
  ok('connect-linear rejects empty API key')
} catch (e) { no('connect-linear rejects empty API key', e) }

// ── Connection management ────────────────────────────────────────────────
console.log('\nLinear: Connection management')
if (handlerConnectionId) {
  try {
    const connections = await h.invoke('integrations:list-connections', 'linear') as any[]
    expect(connections.length).toBeGreaterThan(0)
    ok('list-connections returns linear connections')
  } catch (e) { no('list-connections returns linear connections', e) }

  try {
    const usage = await h.invoke('integrations:get-connection-usage', handlerConnectionId) as any
    expect(typeof usage.mapped_project_count).toBe('number')
    ok('get-connection-usage returns usage')
  } catch (e) { no('get-connection-usage returns usage', e) }

  try {
    await h.invoke('integrations:update-connection', {
      connectionId: handlerConnectionId, credential: LINEAR_API_KEY
    })
    ok('update-connection updates credential')
  } catch (e) { no('update-connection updates credential', e) }

  // set/get/clear project connection — use a separate connection for clear test
  // because clear-project-connection deletes unused connections
  const connTestProjectId = `proj-conn-test-${Date.now()}`
  h.db.prepare(`INSERT INTO projects (id, name, color, path, created_at, updated_at)
    VALUES (?, 'Conn Test', '#888888', '/tmp/conn-test', datetime('now'), datetime('now'))`)
    .run(connTestProjectId)

  try {
    await h.invoke('integrations:set-project-connection', {
      projectId: connTestProjectId, provider: 'linear', connectionId: handlerConnectionId
    })
    const connId = await h.invoke('integrations:get-project-connection', connTestProjectId, 'linear') as any
    expect(connId).toBeTruthy()
    expect(connId).toBe(handlerConnectionId)
    ok('set/get-project-connection works')
  } catch (e) { no('set/get-project-connection works', e) }

  // Use a disposable connection for clear test so handlerConnectionId survives
  const clearConnResult = await h.invoke('integrations:connect-linear', { apiKey: LINEAR_API_KEY }) as any
  const clearConnId = clearConnResult.id
  const clearProjectId = `proj-clear-conn-${Date.now()}`
  h.db.prepare(`INSERT INTO projects (id, name, color, path, created_at, updated_at)
    VALUES (?, 'Clear Conn', '#888888', '/tmp/clear-conn', datetime('now'), datetime('now'))`)
    .run(clearProjectId)
  await h.invoke('integrations:set-project-connection', {
    projectId: clearProjectId, provider: 'linear', connectionId: clearConnId
  })

  try {
    await h.invoke('integrations:clear-project-connection', {
      projectId: clearProjectId, provider: 'linear'
    })
    const connId = await h.invoke('integrations:get-project-connection', clearProjectId, 'linear') as any
    expect(connId).toBeNull()
    ok('clear-project-connection removes connection')
  } catch (e) { no('clear-project-connection removes connection', e) }
}

// ── Discovery ─────────────────────────────────────────────────────────────
console.log('\nLinear: Discovery')
let teamKey = 'TST'
try {
  const result = await linearClient.listTeams(LINEAR_API_KEY)
  expect(result.teams.length).toBeGreaterThan(0)
  const testTeam = result.teams.find(t => t.id === LINEAR_TEST_TEAM_ID)
  expect(testTeam).toBeTruthy()
  teamKey = testTeam!.key
  ok('listTeams includes test team')
} catch (e) { no('listTeams includes test team', e) }

let workflowStates: Array<{ id: string; name: string; type: string; color: string; position: number }> = []
try {
  workflowStates = await linearClient.listWorkflowStates(LINEAR_API_KEY, LINEAR_TEST_TEAM_ID)
  expect(workflowStates.length).toBeGreaterThan(0)
  const types = new Set(workflowStates.map(s => s.type))
  expect(types.has('started') || types.has('unstarted')).toBe(true)
  ok('listWorkflowStates returns states')
} catch (e) { no('listWorkflowStates returns states', e) }

// Handler-level discovery
if (handlerConnectionId) {
  try {
    const result = await h.invoke('integrations:list-linear-teams', handlerConnectionId) as any
    expect(result.teams.length).toBeGreaterThan(0)
    ok('list-linear-teams handler returns teams')
  } catch (e) { no('list-linear-teams handler returns teams', e) }

  try {
    const projects = await h.invoke('integrations:list-linear-projects', handlerConnectionId, LINEAR_TEST_TEAM_ID) as any[]
    expect(Array.isArray(projects)).toBe(true)
    ok('list-linear-projects handler returns array')
  } catch (e) { no('list-linear-projects handler returns array', e) }

  try {
    const result = await h.invoke('integrations:list-linear-issues', {
      connectionId: handlerConnectionId, teamId: LINEAR_TEST_TEAM_ID, limit: 5
    }) as any
    expect(Array.isArray(result.issues)).toBe(true)
    ok('list-linear-issues handler returns issues')
  } catch (e) { no('list-linear-issues handler returns issues', e) }
}

// ── Issue CRUD ────────────────────────────────────────────────────────────
console.log('\nLinear: Issue CRUD')
let createdIssueId = ''
let createdIdentifier = ''

try {
  const issue = await linearClient.createIssue(LINEAR_API_KEY, {
    teamId: LINEAR_TEST_TEAM_ID,
    title: `[test] integration test ${Date.now()}`,
    description: 'Created by SlayZone integration test',
    priority: 3
  })
  expect(issue).toBeTruthy()
  expect(issue!.title.startsWith('[test]')).toBe(true)
  expect(issue!.team.id).toBe(LINEAR_TEST_TEAM_ID)
  createdIssueId = issue!.id
  createdIdentifier = issue!.identifier
  createdIssueIds.push(createdIssueId)
  ok('createIssue creates issue')
} catch (e) { no('createIssue creates issue', e) }

if (createdIssueId) {
  try {
    const issue = await linearClient.getIssue(LINEAR_API_KEY, createdIssueId)
    expect(issue).toBeTruthy()
    expect(issue!.id).toBe(createdIssueId)
    expect(issue!.identifier).toBe(createdIdentifier)
    ok('getIssue fetches created issue')
  } catch (e) { no('getIssue fetches created issue', e) }

  try {
    const updated = await linearClient.updateIssue(LINEAR_API_KEY, createdIssueId, {
      title: `[test] updated ${Date.now()}`,
      priority: 1
    })
    expect(updated).toBeTruthy()
    expect(updated!.title.startsWith('[test] updated')).toBe(true)
    ok('updateIssue updates title + priority')
  } catch (e) { no('updateIssue updates title + priority', e) }

  try {
    const { issues } = await linearClient.listIssues(LINEAR_API_KEY, {
      teamId: LINEAR_TEST_TEAM_ID, first: 50
    })
    const found = issues.find(i => i.id === createdIssueId)
    expect(found).toBeTruthy()
    ok('listIssues includes created issue')
  } catch (e) { no('listIssues includes created issue', e) }
}

// ── Import flow (handler-level) ───────────────────────────────────────────
// Each major section creates its own seedFullMapping for independence
console.log('\nLinear: Import flow')
if (createdIssueId) {
  const { projectId, connectionId } = seedFullMapping(h.db, 'linear', LINEAR_API_KEY, {
    teamId: LINEAR_TEST_TEAM_ID,
    teamKey,
    syncMode: 'two_way',
    workflowStates: workflowStates.map(s => ({ id: s.id, type: s.type }))
  })

  try {
    const result = await h.invoke('integrations:import-linear-issues', {
      projectId, connectionId, teamId: LINEAR_TEST_TEAM_ID,
      selectedIssueIds: [createdIssueId]
    }) as any
    expect(result.imported).toBeGreaterThan(0)
    expect(result.linked).toBeGreaterThan(0)

    const tasks = h.db.prepare('SELECT * FROM tasks WHERE project_id = ?').all(projectId) as any[]
    expect(tasks.length).toBeGreaterThan(0)

    const links = h.db.prepare(
      "SELECT * FROM external_links WHERE connection_id = ? AND provider = 'linear'"
    ).all(connectionId) as any[]
    expect(links.length).toBeGreaterThan(0)
    expect(links[0].external_id).toBe(createdIssueId)
    ok('import creates local task + external link')
  } catch (e) { no('import creates local task + external link', e) }

  try {
    const result = await h.invoke('integrations:import-linear-issues', {
      projectId, connectionId, teamId: LINEAR_TEST_TEAM_ID,
      selectedIssueIds: [createdIssueId]
    }) as any
    const tasks = h.db.prepare('SELECT * FROM tasks WHERE project_id = ?').all(projectId) as any[]
    expect(tasks.length).toBe(1)
    ok('re-import deduplicates')
  } catch (e) { no('re-import deduplicates', e) }

  // ── Two-way sync ──────────────────────────────────────────────────────
  console.log('\nLinear: Two-way sync')

  // Push: make local newer
  try {
    const task = (h.db.prepare('SELECT * FROM tasks WHERE project_id = ?').get(projectId) as any)
    h.db.prepare("UPDATE tasks SET title = ?, updated_at = '2099-01-01 00:00:00' WHERE id = ?")
      .run(`[test] pushed from local ${Date.now()}`, task.id)

    const result = await h.invoke('integrations:sync-now', { taskId: task.id }) as any
    expect(result.scanned).toBe(1)
    expect(result.pushed).toBe(1)

    const remote = await linearClient.getIssue(LINEAR_API_KEY, createdIssueId)
    expect(remote!.title.startsWith('[test] pushed from local')).toBe(true)
    ok('push: local newer → updates remote')
  } catch (e) { no('push: local newer → updates remote', e) }

  // Pull: update remote, make local old
  try {
    const task = (h.db.prepare('SELECT * FROM tasks WHERE project_id = ?').get(projectId) as any)
    const newTitle = `[test] pulled from remote ${Date.now()}`
    await linearClient.updateIssue(LINEAR_API_KEY, createdIssueId, { title: newTitle })

    h.db.prepare("UPDATE tasks SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").run(task.id)
    h.db.prepare('DELETE FROM external_field_state').run()

    const result = await h.invoke('integrations:sync-now', { taskId: task.id }) as any
    expect(result.scanned).toBe(1)
    expect(result.pulled).toBe(1)

    const updatedTask = h.db.prepare('SELECT title FROM tasks WHERE id = ?').get(task.id) as any
    expect(updatedTask.title).toBe(newTitle)
    ok('pull: remote newer → updates local')
  } catch (e) { no('pull: remote newer → updates local', e) }

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

  // Restore two_way for remaining tests
  h.db.prepare("UPDATE integration_project_mappings SET sync_mode = 'two_way' WHERE project_id = ?")
    .run(projectId)

  // ── Status mapping ────────────────────────────────────────────────────
  console.log('\nLinear: Status mapping')
  try {
    const completedState = workflowStates.find(s => s.type === 'completed')
    if (completedState) {
      await linearClient.updateIssue(LINEAR_API_KEY, createdIssueId, { stateId: completedState.id })
      const task = (h.db.prepare('SELECT * FROM tasks WHERE project_id = ?').get(projectId) as any)
      h.db.prepare("UPDATE tasks SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").run(task.id)
      h.db.prepare('DELETE FROM external_field_state').run()

      const result = await h.invoke('integrations:sync-now', { taskId: task.id }) as any
      expect(result.pulled).toBe(1)

      const updatedTask = h.db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id) as any
      expect(updatedTask.status).toBe('done')
      ok('completed state → done status')
    } else {
      ok('completed state → done status (skipped: no completed state)')
    }
  } catch (e) { no('completed state → done status', e) }

  // ── Archive sync ────────────────────────────────────────────────────
  console.log('\nLinear: Archive sync')

  // Remote completed → local archived
  try {
    const completedState = workflowStates.find(s => s.type === 'completed')
    if (completedState) {
      const task = (h.db.prepare('SELECT * FROM tasks WHERE project_id = ?').get(projectId) as any)
      h.db.prepare('UPDATE tasks SET archived_at = NULL WHERE id = ?').run(task.id)
      await linearClient.updateIssue(LINEAR_API_KEY, createdIssueId, { stateId: completedState.id })
      h.db.prepare("UPDATE tasks SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").run(task.id)
      h.db.prepare('DELETE FROM external_field_state').run()

      await h.invoke('integrations:sync-now', { taskId: task.id })
      const updatedTask = h.db.prepare('SELECT archived_at FROM tasks WHERE id = ?').get(task.id) as any
      expect(updatedTask.archived_at).toBeTruthy()
      ok('remote completed → local archived')
    } else {
      ok('remote completed → local archived (skipped: no completed state)')
    }
  } catch (e) { no('remote completed → local archived', e) }

  // Remote reopened → local unarchived
  try {
    const unstartedState = workflowStates.find(s => s.type === 'unstarted' || s.type === 'started')
    if (unstartedState) {
      const task = (h.db.prepare('SELECT * FROM tasks WHERE project_id = ?').get(projectId) as any)
      await linearClient.updateIssue(LINEAR_API_KEY, createdIssueId, { stateId: unstartedState.id })
      h.db.prepare("UPDATE tasks SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").run(task.id)
      h.db.prepare('DELETE FROM external_field_state').run()

      await h.invoke('integrations:sync-now', { taskId: task.id })
      const updatedTask = h.db.prepare('SELECT archived_at FROM tasks WHERE id = ?').get(task.id) as any
      expect(updatedTask.archived_at).toBeNull()
      ok('remote reopened → local unarchived')
    } else {
      ok('remote reopened → local unarchived (skipped)')
    }
  } catch (e) { no('remote reopened → local unarchived', e) }

  // ── Push archive / unarchive ──────────────────────────────────────────
  console.log('\nLinear: Push archive/unarchive')
  try {
    const task = (h.db.prepare('SELECT * FROM tasks WHERE project_id = ?').get(projectId) as any)
    await pushArchiveToProviders(h.db, task.id)

    const remote = await linearClient.getIssue(LINEAR_API_KEY, createdIssueId)
    expect(remote!.state.type === 'completed' || remote!.state.type === 'canceled').toBe(true)
    ok('pushArchiveToProviders → remote terminal state')
  } catch (e) { no('pushArchiveToProviders → remote terminal state', e) }

  try {
    const task = (h.db.prepare('SELECT * FROM tasks WHERE project_id = ?').get(projectId) as any)
    await pushUnarchiveToProviders(h.db, task.id)

    const remote = await linearClient.getIssue(LINEAR_API_KEY, createdIssueId)
    expect(remote!.state.type !== 'completed' && remote!.state.type !== 'canceled').toBe(true)
    ok('pushUnarchiveToProviders → remote non-terminal state')
  } catch (e) { no('pushUnarchiveToProviders → remote non-terminal state', e) }

  // ── get-task-sync-status ──────────────────────────────────────────────
  console.log('\nLinear: Sync status')
  try {
    const task = (h.db.prepare('SELECT * FROM tasks WHERE project_id = ?').get(projectId) as any)
    const status = await h.invoke('integrations:get-task-sync-status', task.id, 'linear') as any
    expect(status.provider).toBe('linear')
    expect(status.taskId).toBe(task.id)
    expect(['in_sync', 'local_ahead', 'remote_ahead', 'conflict', 'unknown'].includes(status.state)).toBe(true)
    expect(Array.isArray(status.fields)).toBe(true)
    ok('get-task-sync-status returns valid status')
  } catch (e) { no('get-task-sync-status returns valid status', e) }

  // ── Conflict detection ────────────────────────────────────────────────
  console.log('\nLinear: Conflict detection')
  try {
    const task = (h.db.prepare('SELECT * FROM tasks WHERE project_id = ?').get(projectId) as any)

    // First sync to establish baseline
    h.db.prepare("UPDATE tasks SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").run(task.id)
    h.db.prepare('DELETE FROM external_field_state').run()
    await h.invoke('integrations:sync-now', { taskId: task.id })

    // Now change both sides
    h.db.prepare("UPDATE tasks SET title = '[test] local conflict title', updated_at = '2099-01-01 00:00:00' WHERE id = ?")
      .run(task.id)
    await linearClient.updateIssue(LINEAR_API_KEY, createdIssueId, {
      title: `[test] remote conflict title ${Date.now()}`
    })

    const status = await h.invoke('integrations:get-task-sync-status', task.id, 'linear') as any
    expect(status.fields.length).toBeGreaterThan(0)
    const titleField = status.fields.find((f: any) => f.field === 'title')
    expect(titleField).toBeTruthy()
    expect(titleField.state !== 'in_sync').toBe(true)
    ok('conflict detected when both sides change')
  } catch (e) { no('conflict detected when both sides change', e) }

  // ── fetch/apply-status-sync ───────────────────────────────────────────
  console.log('\nLinear: Status sync setup')
  try {
    const statuses = await h.invoke('integrations:fetch-provider-statuses', {
      connectionId,
      provider: 'linear',
      externalTeamId: LINEAR_TEST_TEAM_ID
    }) as ProviderStatus[]
    expect(statuses.length).toBeGreaterThan(0)
    ok('fetch-provider-statuses returns workflow states')

    const freshProjectId = `proj-status-test-${Date.now()}`
    const freshMappingId = `map-status-${Date.now()}`
    h.db.prepare(`INSERT INTO projects (id, name, color, path, created_at, updated_at)
      VALUES (?, 'Status Test', '#888888', '/tmp/status-test', datetime('now'), datetime('now'))`)
      .run(freshProjectId)
    h.db.prepare(`INSERT INTO integration_project_mappings
      (id, project_id, provider, connection_id, external_team_id, external_team_key, sync_mode, status_setup_complete)
      VALUES (?, ?, 'linear', ?, ?, ?, 'two_way', 0)`)
      .run(freshMappingId, freshProjectId, connectionId, LINEAR_TEST_TEAM_ID, teamKey)

    await h.invoke('integrations:apply-status-sync', {
      projectId: freshProjectId,
      provider: 'linear',
      statuses
    })

    const project = h.db.prepare('SELECT columns_config FROM projects WHERE id = ?').get(freshProjectId) as any
    expect(project.columns_config).toBeTruthy()
    const columns = JSON.parse(project.columns_config)
    expect(columns.length).toBeGreaterThan(0)
    ok('apply-status-sync creates columns from workflow states')

    // resync-provider-statuses — should show no diff after fresh apply
    try {
      const preview = await h.invoke('integrations:resync-provider-statuses', {
        projectId: freshProjectId,
        provider: 'linear'
      }) as any
      expect(preview.diff.added.length).toBe(0)
      expect(preview.diff.removed.length).toBe(0)
      ok('resync-provider-statuses shows no diff after fresh apply')
    } catch (e) { no('resync-provider-statuses shows no diff after fresh apply', e) }
  } catch (e) { no('fetch/apply-status-sync', e) }

  // ── Discovery (scoped) ────────────────────────────────────────────────
  console.log('\nLinear: Discovery')
  // Use a fresh mapping so discovery only targets this project
  {
    const disco = seedFullMapping(h.db, 'linear', LINEAR_API_KEY, {
      teamId: LINEAR_TEST_TEAM_ID,
      teamKey,
      syncMode: 'two_way',
      workflowStates: workflowStates.map(s => ({ id: s.id, type: s.type }))
    })

    try {
      const discoveryIssue = await linearClient.createIssue(LINEAR_API_KEY, {
        teamId: LINEAR_TEST_TEAM_ID,
        title: `[test] discovery target ${Date.now()}`
      })
      expect(discoveryIssue).toBeTruthy()
      createdIssueIds.push(discoveryIssue!.id)

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
  console.log('\nLinear: Push create (new task → remote)')
  try {
    const newTaskId = crypto.randomUUID()
    h.db.prepare(`INSERT INTO tasks
      (id, project_id, title, description, status, priority, terminal_mode, provider_config, claude_flags, codex_flags, created_at, updated_at)
      VALUES (?, ?, ?, null, 'todo', 3, 'claude-code', '{}', '', '', datetime('now'), datetime('now'))`)
      .run(newTaskId, projectId, `[test] push-created ${Date.now()}`)

    await pushNewTaskToProviders(h.db, newTaskId, projectId)

    const link = h.db.prepare(
      "SELECT * FROM external_links WHERE task_id = ? AND provider = 'linear'"
    ).get(newTaskId) as any

    expect(link).toBeTruthy()
    expect(link.external_id).toBeTruthy()
    createdIssueIds.push(link.external_id)

    const remote = await linearClient.getIssue(LINEAR_API_KEY, link.external_id)
    expect(remote).toBeTruthy()
    expect(remote!.title.startsWith('[test] push-created')).toBe(true)
    ok('pushNewTaskToProviders creates remote issue')
  } catch (e) { no('pushNewTaskToProviders creates remote issue', e) }

  // ── push-task Linear (manual force push) ──────────────────────────────
  console.log('\nLinear: Manual push/pull')
  try {
    const task = (h.db.prepare('SELECT * FROM tasks WHERE project_id = ? LIMIT 1').get(projectId) as any)
    const link = h.db.prepare("SELECT * FROM external_links WHERE task_id = ? AND provider = 'linear'").get(task.id) as any
    if (task && link) {
      const forcePushTitle = `[test] force pushed ${Date.now()}`
      h.db.prepare("UPDATE tasks SET title = ?, updated_at = datetime('now') WHERE id = ?")
        .run(forcePushTitle, task.id)

      const result = await h.invoke('integrations:push-task', {
        taskId: task.id, provider: 'linear', force: true
      }) as any
      expect(result.pushed).toBe(true)

      const remote = await linearClient.getIssue(LINEAR_API_KEY, link.external_id)
      expect(remote!.title).toBe(forcePushTitle)
      ok('push-task force pushes local → remote')
    } else {
      ok('push-task force pushes local → remote (skipped: no linked task)')
    }
  } catch (e) { no('push-task force pushes local → remote', e) }

  // ── pull-task Linear (manual force pull) ──────────────────────────────
  try {
    const task = (h.db.prepare('SELECT * FROM tasks WHERE project_id = ? LIMIT 1').get(projectId) as any)
    const link = h.db.prepare("SELECT * FROM external_links WHERE task_id = ? AND provider = 'linear'").get(task.id) as any
    if (task && link) {
      const forcePullTitle = `[test] force pulled ${Date.now()}`
      await linearClient.updateIssue(LINEAR_API_KEY, link.external_id, { title: forcePullTitle })

      const result = await h.invoke('integrations:pull-task', {
        taskId: task.id, provider: 'linear', force: true
      }) as any
      expect(result.pulled).toBe(true)

      const updatedTask = h.db.prepare('SELECT title FROM tasks WHERE id = ?').get(task.id) as any
      expect(updatedTask.title).toBe(forcePullTitle)
      ok('pull-task force pulls remote → local')
    } else {
      ok('pull-task force pulls remote → local (skipped: no linked task)')
    }
  } catch (e) { no('pull-task force pulls remote → local', e) }

  // ── push-task guards ──────────────────────────────────────────────────
  try {
    const task = (h.db.prepare('SELECT * FROM tasks WHERE project_id = ? LIMIT 1').get(projectId) as any)
    const link = h.db.prepare("SELECT * FROM external_links WHERE task_id = ? AND provider = 'linear'").get(task.id) as any
    if (task && link) {
      // Sync first to establish baseline
      await h.invoke('integrations:pull-task', { taskId: task.id, provider: 'linear', force: true })

      // In-sync → should return pushed=false
      const result = await h.invoke('integrations:push-task', {
        taskId: task.id, provider: 'linear'
      }) as any
      expect(result.pushed).toBe(false)
      expect(result.message.includes('already in sync')).toBe(true)
      ok('push-task returns false when in sync')
    } else {
      ok('push-task returns false when in sync (skipped)')
    }
  } catch (e) { no('push-task returns false when in sync', e) }

  // push-task guard: remote ahead without force
  try {
    const task = (h.db.prepare('SELECT * FROM tasks WHERE project_id = ? LIMIT 1').get(projectId) as any)
    const link = h.db.prepare("SELECT * FROM external_links WHERE task_id = ? AND provider = 'linear'").get(task.id) as any
    if (task && link) {
      // Establish baseline
      await h.invoke('integrations:push-task', { taskId: task.id, provider: 'linear', force: true })

      // Change remote
      await linearClient.updateIssue(LINEAR_API_KEY, link.external_id, {
        title: `[test] remote changed ${Date.now()}`
      })
      // Change local
      h.db.prepare("UPDATE tasks SET title = '[test] local changed', updated_at = datetime('now') WHERE id = ?").run(task.id)

      const result = await h.invoke('integrations:push-task', {
        taskId: task.id, provider: 'linear'
      }) as any
      expect(result.pushed).toBe(false)
      expect(result.message.includes('Remote changes detected')).toBe(true)
      ok('push-task refuses when remote ahead without force')
    } else {
      ok('push-task refuses when remote ahead without force (skipped)')
    }
  } catch (e) { no('push-task refuses when remote ahead without force', e) }

  // pull-task guard: local ahead without force
  try {
    const task = (h.db.prepare('SELECT * FROM tasks WHERE project_id = ? LIMIT 1').get(projectId) as any)
    if (task) {
      // Establish baseline
      await h.invoke('integrations:pull-task', { taskId: task.id, provider: 'linear', force: true })

      // Change local only
      h.db.prepare("UPDATE tasks SET title = '[test] local only', updated_at = datetime('now') WHERE id = ?").run(task.id)

      const result = await h.invoke('integrations:pull-task', {
        taskId: task.id, provider: 'linear'
      }) as any
      expect(result.pulled).toBe(false)
      expect(result.message.includes('Local changes detected')).toBe(true)
      ok('pull-task refuses when local ahead without force')
    } else {
      ok('pull-task refuses when local ahead without force (skipped)')
    }
  } catch (e) { no('pull-task refuses when local ahead without force', e) }

  // ── push-unlinked-tasks ───────────────────────────────────────────────
  console.log('\nLinear: Push unlinked tasks')
  try {
    // Create unlinked tasks
    const unlinkedIds: string[] = []
    for (let i = 0; i < 3; i++) {
      const id = crypto.randomUUID()
      h.db.prepare(`INSERT INTO tasks
        (id, project_id, title, description, status, priority, terminal_mode, provider_config, claude_flags, codex_flags, created_at, updated_at)
        VALUES (?, ?, ?, null, 'todo', 3, 'claude-code', '{}', '', '', datetime('now'), datetime('now'))`)
        .run(id, projectId, `[test] unlinked ${i} ${Date.now()}`)
      unlinkedIds.push(id)
    }

    const result = await h.invoke('integrations:push-unlinked-tasks', {
      projectId, provider: 'linear'
    }) as any
    expect(result.pushed).toBeGreaterThan(0)

    // Verify each task now has a link
    for (const id of unlinkedIds) {
      const link = h.db.prepare("SELECT * FROM external_links WHERE task_id = ? AND provider = 'linear'").get(id) as any
      expect(link).toBeTruthy()
      createdIssueIds.push(link.external_id)
    }
    ok('push-unlinked-tasks creates remote issues + links')
  } catch (e) { no('push-unlinked-tasks creates remote issues + links', e) }

  // Race guard: calling again should push 0 (all already linked)
  try {
    const result = await h.invoke('integrations:push-unlinked-tasks', {
      projectId, provider: 'linear'
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
      projectId, provider: 'linear'
    }) as any
    expect(result.pushed).toBe(0)

    const link = h.db.prepare("SELECT * FROM external_links WHERE task_id = ? AND provider = 'linear'").get(tempId) as any
    expect(link).toBeUndefined()
    ok('push-unlinked-tasks excludes temporary tasks')
  } catch (e) { no('push-unlinked-tasks excludes temporary tasks', e) }

  // ── Pagination ────────────────────────────────────────────────────────
  console.log('\nLinear: Pagination')
  try {
    const { issues, nextCursor } = await linearClient.listIssues(LINEAR_API_KEY, {
      teamId: LINEAR_TEST_TEAM_ID, first: 2
    })
    expect(issues.length).toBeGreaterThan(0)
    if (nextCursor) {
      const page2 = await linearClient.listIssues(LINEAR_API_KEY, {
        teamId: LINEAR_TEST_TEAM_ID, first: 2, after: nextCursor
      })
      expect(page2.issues.length).toBeGreaterThan(0)
      const page1Ids = new Set(issues.map(i => i.id))
      const overlap = page2.issues.filter(i => page1Ids.has(i.id))
      expect(overlap.length).toBe(0)
      ok('listIssues pagination returns distinct pages')
    } else {
      ok('listIssues pagination returns distinct pages (skipped: only 1 page)')
    }
  } catch (e) { no('listIssues pagination returns distinct pages', e) }

  // ── Error handling ────────────────────────────────────────────────────
  console.log('\nLinear: Error handling')
  try {
    let threw = false
    try { await linearClient.getViewer('lin_invalid_key_xxxxx') } catch { threw = true }
    expect(threw).toBe(true)
    ok('invalid API key throws')
  } catch (e) { no('invalid API key throws', e) }

  try {
    let threw = false
    try { await linearClient.getIssue(LINEAR_API_KEY, 'nonexistent-issue-id-xxxxx') } catch { threw = true }
    expect(threw).toBe(true)
    ok('nonexistent issue throws')
  } catch (e) { no('nonexistent issue throws', e) }

  // ── Batch fetch ───────────────────────────────────────────────────────
  console.log('\nLinear: Batch fetch')
  try {
    const batchIds = createdIssueIds.slice(0, 3)
    if (batchIds.length > 0) {
      const batchResult = await linearClient.getIssuesBatch(LINEAR_API_KEY, batchIds)
      expect(batchResult.size).toBe(batchIds.length)
      for (const id of batchIds) {
        expect(batchResult.has(id)).toBe(true)
      }
      ok('getIssuesBatch returns all requested issues')
    } else {
      ok('getIssuesBatch returns all requested issues (skipped: no issues)')
    }
  } catch (e) { no('getIssuesBatch returns all requested issues', e) }

  try {
    const emptyResult = await linearClient.getIssuesBatch(LINEAR_API_KEY, [])
    expect(emptyResult.size).toBe(0)
    ok('getIssuesBatch with empty array returns empty map')
  } catch (e) { no('getIssuesBatch with empty array returns empty map', e) }
}

// ── Destructive: clear-project-provider + disconnect (run last) ──────────
console.log('\nLinear: Clear/disconnect')
{
  const clearTest = seedFullMapping(h.db, 'linear', LINEAR_API_KEY, {
    teamId: LINEAR_TEST_TEAM_ID, teamKey,
    syncMode: 'two_way',
    workflowStates: workflowStates.map(s => ({ id: s.id, type: s.type }))
  })
  const clearTaskId = crypto.randomUUID()
  h.db.prepare(`INSERT INTO tasks (id, project_id, title, status, priority, terminal_mode, provider_config, claude_flags, codex_flags, created_at, updated_at)
    VALUES (?, ?, 'clear test', 'todo', 3, 'claude-code', '{}', '', '', datetime('now'), datetime('now'))`)
    .run(clearTaskId, clearTest.projectId)
  h.db.prepare(`INSERT INTO external_links (id, provider, connection_id, external_type, external_id, external_key, external_url, task_id, sync_state, created_at, updated_at)
    VALUES (?, 'linear', ?, 'issue', 'ext-clear', 'ENG-999', '', ?, 'active', datetime('now'), datetime('now'))`)
    .run(crypto.randomUUID(), clearTest.connectionId, clearTaskId)

  try {
    await h.invoke('integrations:clear-project-provider', { projectId: clearTest.projectId, provider: 'linear' })
    const links = h.db.prepare("SELECT * FROM external_links WHERE task_id = ? AND provider = 'linear'").all(clearTaskId) as any[]
    expect(links.length).toBe(0)
    const mapping = h.db.prepare("SELECT * FROM integration_project_mappings WHERE id = ?").get(clearTest.mappingId) as any
    expect(mapping).toBeUndefined()
    const task = h.db.prepare("SELECT * FROM tasks WHERE id = ?").get(clearTaskId) as any
    expect(task).toBeTruthy()
    ok('clear-project-provider removes links/mappings, keeps tasks')
  } catch (e) { no('clear-project-provider removes links/mappings, keeps tasks', e) }

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
console.log('\nLinear: Cleanup')
if (createdIssueIds.length > 0) {
  await cleanupLinearIssues(LINEAR_API_KEY, createdIssueIds)
  console.log(`  archived ${createdIssueIds.length} test issues`)
}

h.cleanup()
console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
console.log('\nDone')
