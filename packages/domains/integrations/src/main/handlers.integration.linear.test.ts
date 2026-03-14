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
    h.db.prepare(`INSERT INTO projects (id, name, color, path, created_at, updated_at)
      VALUES (?, 'Status Test', '#888888', '/tmp/status-test', datetime('now'), datetime('now'))`)
      .run(freshProjectId)
    h.db.prepare(`INSERT INTO integration_project_mappings
      (id, project_id, provider, connection_id, external_team_id, external_team_key, sync_mode, status_setup_complete)
      VALUES (?, ?, 'linear', ?, ?, ?, 'two_way', 0)`)
      .run(`map-status-${Date.now()}`, freshProjectId, connectionId, LINEAR_TEST_TEAM_ID, teamKey)

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
