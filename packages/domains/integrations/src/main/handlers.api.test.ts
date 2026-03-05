/**
 * Contract tests for integration handlers that call the Linear API.
 * The loader redirects ./linear-client to mock-linear-client.ts.
 *
 * All handlers are async so tests run sequentially in one async function.
 */
import { createTestHarness, expect } from '../../../../shared/test-utils/ipc-harness.js'
import { registerIntegrationHandlers } from './handlers'
import { _mock } from '../../../../shared/test-utils/mock-linear-client.js'
import { storeCredential } from './credentials'
import type { LinearIssueSummary } from '../shared'

process.env.SLAYZONE_ALLOW_PLAINTEXT_CREDENTIALS = '1'

// ── Fixtures ──────────────────────────────────────────────────────────────
const FIXTURES: Record<string, LinearIssueSummary> = {
  normal: {
    id: 'LIN-1', identifier: 'ENG-100', title: 'Normal task',
    description: '**Bold** and `code`',
    priority: 3, updatedAt: '2025-06-01T00:00:00Z',
    state: { id: 'st-started', name: 'In Progress', type: 'started' },
    assignee: { id: 'u-1', name: 'Alice' },
    team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
    project: { id: 'lp-1', name: 'Alpha' },
    url: 'https://linear.app/test/ENG-100'
  },
  urgent: {
    id: 'LIN-2', identifier: 'ENG-101', title: 'Urgent bug',
    description: null,
    priority: 1, updatedAt: '2025-06-02T00:00:00Z',
    state: { id: 'st-triage', name: 'Triage', type: 'triage' },
    assignee: null,
    team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
    project: null,
    url: 'https://linear.app/test/ENG-101'
  },
  no_priority: {
    id: 'LIN-3', identifier: 'ENG-102', title: 'No priority issue',
    description: null,
    priority: 0, updatedAt: '2025-06-03T00:00:00Z',
    state: { id: 'st-backlog', name: 'Backlog', type: 'backlog' },
    assignee: null,
    team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
    project: null,
    url: 'https://linear.app/test/ENG-102'
  },
  canceled: {
    id: 'LIN-4', identifier: 'ENG-103', title: 'Canceled task',
    description: '```js\nconsole.log("hi")\n```\n\n- [x] done\n- [ ] todo',
    priority: 4, updatedAt: '2025-06-04T00:00:00Z',
    state: { id: 'st-canceled', name: 'Canceled', type: 'canceled' },
    assignee: { id: 'u-2', name: 'Bob' },
    team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
    project: { id: 'lp-1', name: 'Alpha' },
    url: 'https://linear.app/test/ENG-103'
  },
  lowest: {
    id: 'LIN-5', identifier: 'ENG-104', title: 'Lowest priority',
    description: 'Simple text',
    priority: 5, updatedAt: '2025-06-05T00:00:00Z',
    state: { id: 'st-completed', name: 'Done', type: 'completed' },
    assignee: { id: 'u-1', name: 'Alice' },
    team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
    project: null,
    url: 'https://linear.app/test/ENG-104'
  }
}

const ALL_ISSUES = Object.values(FIXTURES)

// ── Helpers ───────────────────────────────────────────────────────────────
function seedConnection(db: import('better-sqlite3').Database): string {
  const id = 'conn-test-api'
  const ref = 'cred-test-api'
  storeCredential(db, ref, 'lin_test_key')
  db.prepare(`
    INSERT OR REPLACE INTO integration_connections
      (id, provider, credential_ref, enabled)
    VALUES (?, 'linear', ?, 1)
  `).run(id, ref)
  return id
}

function seedProject(db: import('better-sqlite3').Database): string {
  const id = 'proj-api-test'
  db.prepare(`INSERT OR IGNORE INTO projects (id, name, color, path, created_at, updated_at)
    VALUES (?, 'API Test', '#888888', '/tmp/api-test', datetime('now'), datetime('now'))`).run(id)
  return id
}

let pass = 0
let fail = 0
function ok(name: string) { pass++; console.log(`  \u2713 ${name}`) }
function no(name: string, e: unknown) { fail++; console.log(`  \u2717 ${name}`); console.error(`    ${e}`); process.exitCode = 1 }

// ── Run ───────────────────────────────────────────────────────────────────
const h = await createTestHarness()
registerIntegrationHandlers(h.ipcMain as any, h.db)

const connId = seedConnection(h.db)
const projectId = seedProject(h.db)

// ── connect-linear ────────────────────────────────────────────────────────
console.log('\nintegrations:connect-linear')
try {
  _mock.getViewer = async () => ({
    workspaceId: 'ws-new', workspaceName: 'New WS', accountLabel: 'new@test.com'
  })
  const result = await h.invoke('integrations:connect-linear', { apiKey: 'lin_new_key', projectId }) as any
  expect(result.provider).toBe('linear')
  expect(result.enabled).toBe(true)
  expect('credential_ref' in result).toBe(false)
  h.db.prepare('DELETE FROM integration_connections WHERE id = ?').run(result.id)
  ok('creates new connection')
} catch (e) { no('creates new connection', e) }

try {
  await h.invoke('integrations:set-project-connection', { projectId, provider: 'linear', connectionId: connId })
  _mock.getViewer = async () => ({
    workspaceId: 'ws-1', workspaceName: 'Updated WS', accountLabel: 'updated@test.com'
  })
  const result = await h.invoke('integrations:connect-linear', {
    apiKey: 'lin_updated_key', projectId
  }) as any
  expect(result.id).toBe(connId)
  // Restore credential
  const conn = h.db.prepare('SELECT credential_ref FROM integration_connections WHERE id = ?').get(connId) as any
  storeCredential(h.db, conn.credential_ref, 'lin_test_key')
  ok('re-connect updates existing')
} catch (e) { no('re-connect updates existing', e) }

try {
  let threw = false
  try { await h.invoke('integrations:connect-linear', { apiKey: '  ' }) } catch { threw = true }
  expect(threw).toBe(true)
  ok('rejects empty API key')
} catch (e) { no('rejects empty API key', e) }

// ── list-linear-teams ─────────────────────────────────────────────────────
console.log('\nintegrations:list-linear-teams')
try {
  _mock.listTeams = async () => [
    { id: 'team-1', key: 'ENG', name: 'Engineering' },
    { id: 'team-2', key: 'DES', name: 'Design' }
  ]
  const teams = await h.invoke('integrations:list-linear-teams', connId) as any[]
  expect(teams.length).toBe(2)
  expect(teams[0].key).toBe('ENG')
  ok('returns teams from mock')
} catch (e) { no('returns teams from mock', e) }

// ── list-linear-projects ──────────────────────────────────────────────────
console.log('\nintegrations:list-linear-projects')
try {
  _mock.listProjects = async () => [{ id: 'lp-1', name: 'Alpha', teamId: 'team-1' }]
  const projects = await h.invoke('integrations:list-linear-projects', connId, 'team-1') as any[]
  expect(projects.length).toBe(1)
  expect(projects[0].name).toBe('Alpha')
  ok('returns projects for team')
} catch (e) { no('returns projects for team', e) }

// ── set-project-mapping ───────────────────────────────────────────────────
console.log('\nintegrations:set-project-mapping')
try {
  _mock.listWorkflowStates = async () => [
    { id: 'st-triage', type: 'triage' },
    { id: 'st-backlog', type: 'backlog' },
    { id: 'st-unstarted', type: 'unstarted' },
    { id: 'st-started', type: 'started' },
    { id: 'st-completed', type: 'completed' }
  ]
  const mapping = await h.invoke('integrations:set-project-mapping', {
    projectId, provider: 'linear', connectionId: connId,
    externalTeamId: 'team-1', externalTeamKey: 'ENG',
    externalProjectId: null, syncMode: 'two_way'
  }) as any
  expect(mapping.project_id).toBe(projectId)
  expect(mapping.sync_mode).toBe('two_way')
  const states = h.db.prepare(
    'SELECT * FROM integration_state_mappings WHERE project_mapping_id = ?'
  ).all(mapping.id) as any[]
  expect(states.length).toBeGreaterThan(0)
  const inbox = states.find((s: any) => s.local_status === 'inbox')
  expect(inbox.state_id).toBe('st-triage')
  ok('creates mapping and refreshes state mappings')
} catch (e) { no('creates mapping and refreshes state mappings', e) }

try {
  const mapping2 = await h.invoke('integrations:set-project-mapping', {
    projectId, provider: 'linear', connectionId: connId,
    externalTeamId: 'team-1', externalTeamKey: 'ENG',
    externalProjectId: 'lp-1', syncMode: 'one_way'
  }) as any
  expect(mapping2.external_project_id).toBe('lp-1')
  expect(mapping2.sync_mode).toBe('one_way')
  ok('upserts on same project+provider')
} catch (e) { no('upserts on same project+provider', e) }

// ── list-linear-issues ────────────────────────────────────────────────────
console.log('\nintegrations:list-linear-issues')
try {
  const taskId = 'task-linked-1'
  h.db.prepare(`INSERT OR IGNORE INTO tasks (id, project_id, title, status, priority, terminal_mode, provider_config, claude_flags, codex_flags, created_at, updated_at)
    VALUES (?, ?, 'Linked', 'todo', 3, 'claude-code', '{}', '', '', datetime('now'), datetime('now'))`).run(taskId, projectId)
  h.db.prepare(`INSERT OR IGNORE INTO external_links (id, provider, connection_id, external_type, external_id, external_key, external_url, task_id, sync_state, created_at, updated_at)
    VALUES ('el-1', 'linear', ?, 'issue', 'LIN-1', 'ENG-100', '', ?, 'active', datetime('now'), datetime('now'))`).run(connId, taskId)

  _mock.listIssues = async () => ({ issues: [{ ...FIXTURES.normal }], nextCursor: null })
  const result = await h.invoke('integrations:list-linear-issues', {
    connectionId: connId, teamId: 'team-1'
  }) as any
  expect(result.issues.length).toBe(1)
  expect(result.issues[0].linkedTaskId).toBe(taskId)
  expect(result.nextCursor).toBeNull()
  ok('annotates linkedTaskId for linked issues')
} catch (e) { no('annotates linkedTaskId for linked issues', e) }

try {
  _mock.listIssues = async () => ({ issues: [{ ...FIXTURES.urgent }], nextCursor: 'cursor-next' })
  const result = await h.invoke('integrations:list-linear-issues', {
    connectionId: connId, teamId: 'team-1'
  }) as any
  expect(result.issues[0].linkedTaskId).toBeNull()
  expect(result.nextCursor).toBe('cursor-next')
  ok('returns null linkedTaskId for unlinked issues')
} catch (e) { no('returns null linkedTaskId for unlinked issues', e) }

// ── import-linear-issues ──────────────────────────────────────────────────
console.log('\nintegrations:import-linear-issues')

// Clean slate
h.db.prepare('DELETE FROM external_links WHERE connection_id = ?').run(connId)
h.db.prepare('DELETE FROM tasks WHERE project_id = ?').run(projectId)

try {
  _mock.listIssues = async () => ({ issues: ALL_ISSUES.map(i => ({ ...i })), nextCursor: null })
  const result = await h.invoke('integrations:import-linear-issues', {
    projectId, connectionId: connId, teamId: 'team-1'
  }) as any
  expect(result.imported).toBe(5)
  expect(result.linked).toBe(5)

  const tasks = h.db.prepare(
    'SELECT title, priority, status, assignee, description FROM tasks WHERE project_id = ? ORDER BY title'
  ).all(projectId) as any[]

  // Priority mapping: Linear → Local
  const canceled = tasks.find((t: any) => t.title === 'Canceled task')
  expect(canceled.priority).toBe(2)   // Linear 4 → local 2
  expect(canceled.status).toBe('done') // canceled → done
  expect(canceled.assignee).toBe('Bob')
  expect(canceled.description).toBeTruthy()

  const urgent = tasks.find((t: any) => t.title === 'Urgent bug')
  expect(urgent.priority).toBe(5)     // Linear 1 → local 5
  expect(urgent.status).toBe('todo')  // triage → todo
  expect(urgent.assignee).toBeNull()
  expect(urgent.description).toBeNull()

  const noPri = tasks.find((t: any) => t.title === 'No priority issue')
  expect(noPri.priority).toBe(5)      // Linear 0 → local 5

  const normal = tasks.find((t: any) => t.title === 'Normal task')
  expect(normal.priority).toBe(3)     // Linear 3 → local 3
  expect(normal.status).toBe('in_progress') // started → in_progress

  const lowest = tasks.find((t: any) => t.title === 'Lowest priority')
  expect(lowest.priority).toBe(1)     // Linear 5 → local 1
  expect(lowest.status).toBe('done')  // completed → done
  ok('imports all issues with correct priority + state mapping')
} catch (e) { no('imports all issues with correct priority + state mapping', e) }

try {
  h.db.prepare('DELETE FROM external_links WHERE connection_id = ?').run(connId)
  h.db.prepare('DELETE FROM tasks WHERE project_id = ?').run(projectId)

  _mock.listIssues = async () => ({ issues: ALL_ISSUES.map(i => ({ ...i })), nextCursor: null })
  const result = await h.invoke('integrations:import-linear-issues', {
    projectId, connectionId: connId, teamId: 'team-1',
    selectedIssueIds: ['LIN-1', 'LIN-3']
  }) as any
  expect(result.imported).toBe(2)
  const tasks = h.db.prepare('SELECT title FROM tasks WHERE project_id = ?').all(projectId) as any[]
  expect(tasks.length).toBe(2)
  ok('selectedIssueIds filters imports')
} catch (e) { no('selectedIssueIds filters imports', e) }

try {
  // Re-import LIN-1 with updated data
  const updatedNormal: LinearIssueSummary = { ...FIXTURES.normal, title: 'Updated normal task', priority: 2 }
  _mock.listIssues = async () => ({ issues: [updatedNormal], nextCursor: null })
  const result = await h.invoke('integrations:import-linear-issues', {
    projectId, connectionId: connId, teamId: 'team-1', selectedIssueIds: ['LIN-1']
  }) as any
  expect(result.imported).toBe(1)
  const tasks = h.db.prepare('SELECT title, priority FROM tasks WHERE project_id = ?').all(projectId) as any[]
  expect(tasks.length).toBe(2) // no new task
  const updated = tasks.find((t: any) => t.title === 'Updated normal task')
  expect(updated).toBeTruthy()
  expect(updated.priority).toBe(4) // Linear 2 → local 4
  ok('re-import updates existing (dedup)')
} catch (e) { no('re-import updates existing (dedup)', e) }

try {
  h.db.prepare('DELETE FROM external_links WHERE connection_id = ?').run(connId)
  h.db.prepare('DELETE FROM tasks WHERE project_id = ?').run(projectId)

  _mock.listIssues = async () => ({ issues: [{ ...FIXTURES.canceled }], nextCursor: null })
  await h.invoke('integrations:import-linear-issues', { projectId, connectionId: connId, teamId: 'team-1' })
  const task = h.db.prepare('SELECT description FROM tasks WHERE project_id = ?').get(projectId) as any
  const desc = task.description as string
  expect(desc.includes('<pre><code>')).toBe(true)
  expect(desc.includes('console.log')).toBe(true)
  expect(desc.includes('data-type="taskList"')).toBe(true)
  ok('markdown description converted to HTML')
} catch (e) { no('markdown description converted to HTML', e) }

try {
  const otherProject = 'proj-no-mapping'
  h.db.prepare(`INSERT OR IGNORE INTO projects (id, name, color, path, created_at, updated_at)
    VALUES (?, 'No Mapping', '#888888', '/tmp/no-map', datetime('now'), datetime('now'))`).run(otherProject)
  let threw = false
  try { await h.invoke('integrations:import-linear-issues', { projectId: otherProject, connectionId: connId }) } catch { threw = true }
  expect(threw).toBe(true)
  ok('throws when no team + no mapping')
} catch (e) { no('throws when no team + no mapping', e) }

// ── sync-now ──────────────────────────────────────────────────────────────
console.log('\nintegrations:sync-now')

// Clean slate for sync tests
h.db.prepare('DELETE FROM external_field_state').run()
h.db.prepare('DELETE FROM external_links WHERE connection_id = ?').run(connId)
h.db.prepare('DELETE FROM tasks WHERE project_id = ?').run(projectId)

try {
  const taskId = 'task-sync-pull'
  h.db.prepare(`INSERT INTO tasks (id, project_id, title, description, status, priority, terminal_mode, provider_config, claude_flags, codex_flags, created_at, updated_at)
    VALUES (?, ?, 'Old title', null, 'todo', 3, 'claude-code', '{}', '', '', datetime('now'), '2025-01-01 00:00:00')`).run(taskId, projectId)
  h.db.prepare(`INSERT INTO external_links (id, provider, connection_id, external_type, external_id, external_key, external_url, task_id, sync_state, created_at, updated_at)
    VALUES ('el-sync-1', 'linear', ?, 'issue', 'LIN-1', 'ENG-100', '', ?, 'active', datetime('now'), datetime('now'))`).run(connId, taskId)

  _mock.getIssue = async () => ({ ...FIXTURES.normal, title: 'Pulled from remote', updatedAt: '2025-12-01T00:00:00Z' })
  const result = await h.invoke('integrations:sync-now', { taskId }) as any
  expect(result.scanned).toBe(1)
  expect(result.pulled).toBe(1)
  expect(result.pushed).toBe(0)
  const task = h.db.prepare('SELECT title FROM tasks WHERE id = ?').get(taskId) as any
  expect(task.title).toBe('Pulled from remote')
  ok('pulls remote when remote is newer')
} catch (e) { no('pulls remote when remote is newer', e) }

try {
  h.db.prepare(`UPDATE integration_project_mappings SET sync_mode = 'two_way' WHERE project_id = ?`).run(projectId)
  h.db.prepare('DELETE FROM external_field_state').run()
  h.db.prepare('DELETE FROM external_links WHERE connection_id = ?').run(connId)
  h.db.prepare('DELETE FROM tasks WHERE project_id = ?').run(projectId)

  const taskId = 'task-sync-push'
  h.db.prepare(`INSERT INTO tasks (id, project_id, title, description, status, priority, terminal_mode, provider_config, claude_flags, codex_flags, created_at, updated_at)
    VALUES (?, ?, 'Local newer', '<p>local desc</p>', 'in_progress', 4, 'claude-code', '{}', '', '', datetime('now'), '2099-01-01 00:00:00')`).run(taskId, projectId)
  h.db.prepare(`INSERT INTO external_links (id, provider, connection_id, external_type, external_id, external_key, external_url, task_id, sync_state, created_at, updated_at)
    VALUES ('el-sync-2', 'linear', ?, 'issue', 'LIN-1', 'ENG-100', '', ?, 'active', datetime('now'), datetime('now'))`).run(connId, taskId)

  _mock.getIssue = async () => ({ ...FIXTURES.normal, updatedAt: '2025-01-01T00:00:00Z' })
  let pushedInput: any = null
  _mock.updateIssue = async (_key, _id, input) => {
    pushedInput = input
    return { ...FIXTURES.normal, updatedAt: '2099-01-01T00:00:00Z' }
  }

  const result = await h.invoke('integrations:sync-now', { taskId }) as any
  expect(result.scanned).toBe(1)
  expect(result.pushed).toBe(1)
  expect(result.pulled).toBe(0)
  expect(pushedInput.title).toBe('Local newer')
  expect(pushedInput.description).toBe('local desc')
  const fieldStates = h.db.prepare('SELECT * FROM external_field_state WHERE external_link_id = ?').all('el-sync-2') as any[]
  expect(fieldStates.length).toBeGreaterThan(0)
  ok('pushes local when local newer + two_way')
} catch (e) { no('pushes local when local newer + two_way', e) }

try {
  h.db.prepare(`UPDATE integration_project_mappings SET sync_mode = 'one_way' WHERE project_id = ?`).run(projectId)
  _mock.getIssue = async () => ({ ...FIXTURES.normal, updatedAt: '2025-01-01T00:00:00Z' })
  _mock.updateIssue = async () => { throw new Error('Should not have been called') }
  const result = await h.invoke('integrations:sync-now', { taskId: 'task-sync-push' }) as any
  expect(result.scanned).toBe(1)
  expect(result.pushed).toBe(0)
  expect(result.pulled).toBe(0)
  ok('does NOT push when one_way')
} catch (e) { no('does NOT push when one_way', e) }

try {
  _mock.getIssue = async () => null
  const result = await h.invoke('integrations:sync-now', { taskId: 'task-sync-push' }) as any
  expect(result.scanned).toBe(1)
  expect(result.errors.length).toBe(1)
  const link = h.db.prepare('SELECT sync_state, last_error FROM external_links WHERE id = ?').get('el-sync-2') as any
  expect(link.sync_state).toBe('error')
  expect(link.last_error).toBe('Remote issue not found')
  ok('records error when remote missing')
} catch (e) { no('records error when remote missing', e) }

try {
  _mock.getIssue = async () => { throw new Error('Network timeout') }
  const result = await h.invoke('integrations:sync-now', { taskId: 'task-sync-push' }) as any
  expect(result.errors.length).toBe(1)
  expect(result.errors[0]).toBeTruthy()
  ok('records error when API throws')
} catch (e) { no('records error when API throws', e) }

h.cleanup()
console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
console.log('\nDone')
