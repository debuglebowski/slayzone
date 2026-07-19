/**
 * integrations router contract tests — exercise the procedures via tRPC
 * `createCaller` against the harness DB, with the integration ops injected on
 * the app-deps singleton (the router resolves ops via `getIntegrationOps`).
 *
 * Ports the coverage of the two now-dead integration IPC-handler tests:
 *   - domains/integrations/src/electron/handlers.db.test.ts  (DB-only channels)
 *   - domains/integrations/src/electron/handlers.api.test.ts (Linear-API channels)
 * The Linear network calls are mocked: the test-utils loader redirects the ops'
 * `./linear-client` import to `mock-linear-client.ts`; we drive return values via
 * the mutable `_mock` object. Credentials use the plaintext fallback.
 *
 * The handler tests' inline `CREATE TABLE IF NOT EXISTS` for the integration
 * tables are now no-ops (real tables ship via migrations), so we drop them and
 * seed real rows. `ensureIntegrationSchema` is still required: the migrated
 * `integration_project_mappings` lacks the `status_setup_complete` column and
 * `integration_connections` lacks `auth_error`/`auth_error_at` — those are added
 * idempotently by `ensureIntegrationSchema`.
 *
 * Top-level `test()` calls run SEQUENTIALLY in file order and SHARE one harness +
 * caller, mirroring the handler tests' sequential shared-state structure. We do
 * NOT call `h.cleanup()` (it closes the DB before deferred async tests run).
 *
 * Run with: electron + experimental-loader (see test-utils/run-all.sh).
 */
import { createTestHarness, test, expect } from '../../../../test-utils/ipc-harness.js'
import { _mock } from '../../../../test-utils/mock-linear-client.js'
import { integrationsRouter } from './integrations.js'
import { setIntegrationOps } from '../app-deps.js'
import {
  createIntegrationOps,
  ensureIntegrationSchema,
  setCredentialCipher
} from '@slayzone/integrations/server'
import type { LinearIssueSummary } from '@slayzone/integrations/shared'
import { execSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

const didThrow = async (fn: () => Promise<unknown>): Promise<boolean> => {
  try {
    await fn()
    return false
  } catch {
    return true
  }
}

const h = await createTestHarness()
// No cipher injected → credentials use the plaintext fallback (allowed precisely
// because no working cipher exists — cipher-availability is the gate now, no env
// flag). Explicit for clarity / isolation from other suites in the runner.
setCredentialCipher(null)

// Seed a readable credential via the plaintext fallback (the same row shape
// `storeCredential` writes when no cipher is injected + plaintext is allowed).
// `storeCredential` is not exported from the server barrel, so we write the row
// directly rather than deep-import it.
const seedCredential = (ref: string, secret: string): void => {
  h.db
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(`integration:credential:${ref}`, `plain:${secret}`)
}
// Adds status_setup_complete + auth_error columns the migrations don't ship.
await ensureIntegrationSchema(h.slayDb)
setIntegrationOps(createIntegrationOps(h.slayDb))
const caller = integrationsRouter.createCaller({ db: h.slayDb } as never)

// ──────────────────────────────────────────────────────────────────────────
// DB-only coverage (ports handlers.db.test.ts)
// ──────────────────────────────────────────────────────────────────────────

// Seed a project + task for link tests
const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'IntP', '#000', '/tmp/int-test')
const taskId = crypto.randomUUID()
h.db
  .prepare(
    "INSERT INTO tasks (id, project_id, title, status, priority, terminal_mode, provider_config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '{}', datetime('now'), datetime('now'))"
  )
  .run(taskId, projectId, 'Int Task', 'todo', 3, 'claude-code')

// Seed a connection directly (bypassing connect-linear which needs the API)
const connId = crypto.randomUUID()
h.db
  .prepare(`
  INSERT INTO integration_connections (id, provider, credential_ref, enabled, created_at, updated_at)
  VALUES (?, 'linear', 'cred-ref-1', 1, datetime('now'), datetime('now'))
`)
  .run(connId)

test('listConnections: returns connections without credential_ref', async () => {
  const conns = (await caller.listConnections()) as Record<string, unknown>[]
  expect(conns.length).toBeGreaterThan(0)
  const conn = conns.find((c) => c.id === connId)!
  expect(conn.provider).toBe('linear')
  // credential_ref must NOT be exposed
  expect('credential_ref' in conn).toBe(false)
})

test('listConnections: filters by provider', async () => {
  const conns = (await caller.listConnections({ provider: 'linear' })) as { provider: string }[]
  for (const c of conns) expect(c.provider).toBe('linear')
})

test('getConnectionUsage: returns mapped projects and linked task counts', async () => {
  const usageConnId = crypto.randomUUID()
  h.db
    .prepare(`
    INSERT INTO integration_connections (id, provider, credential_ref, enabled, created_at, updated_at)
    VALUES (?, 'linear', 'cred-ref-usage', 1, datetime('now'), datetime('now'))
  `)
    .run(usageConnId)

  const mappedProjectId = crypto.randomUUID()
  h.db
    .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
    .run(mappedProjectId, 'Mapped Project', '#0ea5e9', '/tmp/int-mapped')
  const mappedTaskId = crypto.randomUUID()
  h.db
    .prepare(
      "INSERT INTO tasks (id, project_id, title, status, priority, terminal_mode, provider_config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '{}', datetime('now'), datetime('now'))"
    )
    .run(mappedTaskId, mappedProjectId, 'Mapped task', 'todo', 3, 'claude-code')

  const linkedOnlyProjectId = crypto.randomUUID()
  h.db
    .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
    .run(linkedOnlyProjectId, 'Linked Only', '#f59e0b', '/tmp/int-linked-only')
  const linkedOnlyTaskId = crypto.randomUUID()
  h.db
    .prepare(
      "INSERT INTO tasks (id, project_id, title, status, priority, terminal_mode, provider_config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '{}', datetime('now'), datetime('now'))"
    )
    .run(linkedOnlyTaskId, linkedOnlyProjectId, 'Linked task', 'todo', 3, 'claude-code')

  const mappingId = crypto.randomUUID()
  h.db
    .prepare(`
    INSERT INTO integration_project_mappings (id, project_id, provider, connection_id, external_team_id, external_team_key, sync_mode)
    VALUES (?, ?, 'linear', ?, 'team-usage', 'USAGE', 'one_way')
  `)
    .run(mappingId, mappedProjectId, usageConnId)

  const mappedLinkId = crypto.randomUUID()
  h.db
    .prepare(`
    INSERT INTO external_links (id, provider, connection_id, external_type, external_id, external_key, external_url, task_id, sync_state)
    VALUES (?, 'linear', ?, 'issue', 'ext-usage-1', 'USAGE-1', 'https://linear.app/issue/USAGE-1', ?, 'active')
  `)
    .run(mappedLinkId, usageConnId, mappedTaskId)

  const linkedOnlyLinkId = crypto.randomUUID()
  h.db
    .prepare(`
    INSERT INTO external_links (id, provider, connection_id, external_type, external_id, external_key, external_url, task_id, sync_state)
    VALUES (?, 'linear', ?, 'issue', 'ext-usage-2', 'USAGE-2', 'https://linear.app/issue/USAGE-2', ?, 'active')
  `)
    .run(linkedOnlyLinkId, usageConnId, linkedOnlyTaskId)

  const usage = (await caller.getConnectionUsage({ connectionId: usageConnId })) as {
    connection_id: string
    mapped_project_count: number
    linked_task_count: number
    projects: Array<{
      project_id: string
      has_mapping: boolean
      linked_task_count: number
    }>
  }

  expect(usage.connection_id).toBe(usageConnId)
  expect(usage.mapped_project_count).toBe(1)
  expect(usage.linked_task_count).toBe(2)
  expect(
    usage.projects.find((project) => project.project_id === mappedProjectId)?.has_mapping
  ).toBe(true)
  expect(
    usage.projects.find((project) => project.project_id === mappedProjectId)?.linked_task_count
  ).toBe(1)
  expect(
    usage.projects.find((project) => project.project_id === linkedOnlyProjectId)?.has_mapping
  ).toBe(false)
  expect(
    usage.projects.find((project) => project.project_id === linkedOnlyProjectId)?.linked_task_count
  ).toBe(1)
})

test('getProjectMapping: returns null when no mapping', async () => {
  const result = await caller.getProjectMapping({ projectId, provider: 'linear' })
  expect(result).toBeNull()
})

test('getProjectMapping: returns mapping after seeding', async () => {
  const mappingId = crypto.randomUUID()
  h.db
    .prepare(`
    INSERT INTO integration_project_mappings (id, project_id, provider, connection_id, external_team_id, external_team_key, sync_mode)
    VALUES (?, ?, 'linear', ?, 'team-1', 'TEAM', 'one_way')
  `)
    .run(mappingId, projectId, connId)

  const mapping = (await caller.getProjectMapping({ projectId, provider: 'linear' })) as {
    id: string
    project_id: string
    external_team_id: string
  }
  expect(mapping).toBeTruthy()
  expect(mapping.project_id).toBe(projectId)
  expect(mapping.external_team_id).toBe('team-1')
})

test('getLink: returns null when no link', async () => {
  const result = await caller.getLink({ taskId, provider: 'linear' })
  expect(result).toBeNull()
})

test('getLink: returns link after seeding', async () => {
  const linkId = crypto.randomUUID()
  h.db
    .prepare(`
    INSERT INTO external_links (id, provider, connection_id, external_type, external_id, external_key, external_url, task_id, sync_state)
    VALUES (?, 'linear', ?, 'issue', 'ext-1', 'TEAM-123', 'https://linear.app/issue/TEAM-123', ?, 'active')
  `)
    .run(linkId, connId, taskId)

  const link = (await caller.getLink({ taskId, provider: 'linear' })) as {
    external_key: string
    task_id: string
  }
  expect(link).toBeTruthy()
  expect(link.external_key).toBe('TEAM-123')
  expect(link.task_id).toBe(taskId)
})

test('unlinkTask: removes link and field state', async () => {
  const result = await caller.unlinkTask({ taskId, provider: 'linear' })
  expect(result).toBe(true)

  const link = await caller.getLink({ taskId, provider: 'linear' })
  expect(link).toBeNull()
})

test('unlinkTask: returns false for nonexistent link', async () => {
  const result = await caller.unlinkTask({ taskId: 'nope', provider: 'linear' })
  expect(result).toBe(false)
})

test('disconnect: cascades delete (mappings, links, connection)', async () => {
  // Re-seed a link for the cascade test
  const linkId2 = crypto.randomUUID()
  h.db
    .prepare(`
    INSERT INTO external_links (id, provider, connection_id, external_type, external_id, external_key, task_id, sync_state)
    VALUES (?, 'linear', ?, 'issue', 'ext-2', 'TEAM-456', ?, 'active')
  `)
    .run(linkId2, connId, taskId)

  const result = await caller.disconnect({ connectionId: connId })
  expect(result).toBe(true)

  const conns = (await caller.listConnections()) as { id: string }[]
  expect(conns.find((c) => c.id === connId) ?? null).toBeNull()
})

test('clearProjectProvider: removes mapping + links for only the selected provider', async () => {
  const linearConnId = crypto.randomUUID()
  h.db
    .prepare(`
    INSERT INTO integration_connections (id, provider, credential_ref, enabled, created_at, updated_at)
    VALUES (?, 'linear', 'cred-ref-linear-clear', 1, datetime('now'), datetime('now'))
  `)
    .run(linearConnId)

  const clearProjectId = crypto.randomUUID()
  h.db
    .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
    .run(clearProjectId, 'Clear Provider', '#9333ea', '/tmp/int-clear-provider')

  const taskLinear = crypto.randomUUID()
  const taskGithub = crypto.randomUUID()
  h.db
    .prepare(
      "INSERT INTO tasks (id, project_id, title, status, priority, terminal_mode, provider_config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '{}', datetime('now'), datetime('now'))"
    )
    .run(taskLinear, clearProjectId, 'Linear task', 'todo', 3, 'claude-code')
  h.db
    .prepare(
      "INSERT INTO tasks (id, project_id, title, status, priority, terminal_mode, provider_config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '{}', datetime('now'), datetime('now'))"
    )
    .run(taskGithub, clearProjectId, 'GitHub task', 'todo', 3, 'claude-code')

  const githubConnId = crypto.randomUUID()
  h.db
    .prepare(`
    INSERT INTO integration_connections (id, provider, credential_ref, enabled, created_at, updated_at)
    VALUES (?, 'github', 'cred-ref-gh-clear', 1, datetime('now'), datetime('now'))
  `)
    .run(githubConnId)

  h.db
    .prepare(`
    INSERT INTO integration_project_mappings (id, project_id, provider, connection_id, external_team_id, external_team_key, sync_mode)
    VALUES (?, ?, 'linear', ?, 'team-clear', 'CLEAR', 'one_way')
  `)
    .run(crypto.randomUUID(), clearProjectId, linearConnId)
  h.db
    .prepare(`
    INSERT INTO integration_project_mappings (id, project_id, provider, connection_id, external_team_id, external_team_key, sync_mode)
    VALUES (?, ?, 'github', ?, 'org-clear', 'ORG#1', 'one_way')
  `)
    .run(crypto.randomUUID(), clearProjectId, githubConnId)

  h.db
    .prepare(`
    INSERT INTO external_links (id, provider, connection_id, external_type, external_id, external_key, external_url, task_id, sync_state)
    VALUES (?, 'linear', ?, 'issue', 'ext-clear-linear', 'CLEAR-1', 'https://linear.app/issue/CLEAR-1', ?, 'active')
  `)
    .run(crypto.randomUUID(), linearConnId, taskLinear)
  h.db
    .prepare(`
    INSERT INTO external_links (id, provider, connection_id, external_type, external_id, external_key, external_url, task_id, sync_state)
    VALUES (?, 'github', ?, 'issue', 'ext-clear-github', 'ORG#1', 'https://github.com/org/issues/1', ?, 'active')
  `)
    .run(crypto.randomUUID(), githubConnId, taskGithub)

  const result = await caller.clearProjectProvider({
    projectId: clearProjectId,
    provider: 'linear'
  })
  expect(result).toBe(true)

  const linearMapping = await caller.getProjectMapping({
    projectId: clearProjectId,
    provider: 'linear'
  })
  const githubMapping = await caller.getProjectMapping({
    projectId: clearProjectId,
    provider: 'github'
  })
  expect(linearMapping).toBeNull()
  expect(githubMapping).toBeTruthy()

  const linearLink = h.db
    .prepare("SELECT id FROM external_links WHERE provider = 'linear' AND task_id = ?")
    .get(taskLinear)
  const githubLink = h.db
    .prepare("SELECT id FROM external_links WHERE provider = 'github' AND task_id = ?")
    .get(taskGithub)
  expect(linearLink).toBeUndefined()
  expect(githubLink).toBeTruthy()
})

// ──────────────────────────────────────────────────────────────────────────
// Linear-API coverage (ports handlers.api.test.ts)
// ──────────────────────────────────────────────────────────────────────────

const FIXTURES: Record<string, LinearIssueSummary> = {
  normal: {
    id: 'LIN-1',
    identifier: 'ENG-100',
    title: 'Normal task',
    description: '**Bold** and `code`',
    priority: 3,
    updatedAt: '2025-06-01T00:00:00Z',
    archivedAt: null,
    state: { id: 'st-started', name: 'In Progress', type: 'started' },
    assignee: { id: 'u-1', name: 'Alice' },
    team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
    project: { id: 'lp-1', name: 'Alpha' },
    url: 'https://linear.app/test/ENG-100'
  },
  urgent: {
    id: 'LIN-2',
    identifier: 'ENG-101',
    title: 'Urgent bug',
    description: null,
    priority: 1,
    updatedAt: '2025-06-02T00:00:00Z',
    archivedAt: null,
    state: { id: 'st-triage', name: 'Triage', type: 'triage' },
    assignee: null,
    team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
    project: null,
    url: 'https://linear.app/test/ENG-101'
  },
  no_priority: {
    id: 'LIN-3',
    identifier: 'ENG-102',
    title: 'No priority issue',
    description: null,
    priority: 0,
    updatedAt: '2025-06-03T00:00:00Z',
    archivedAt: null,
    state: { id: 'st-backlog', name: 'Backlog', type: 'backlog' },
    assignee: null,
    team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
    project: null,
    url: 'https://linear.app/test/ENG-102'
  },
  canceled: {
    id: 'LIN-4',
    identifier: 'ENG-103',
    title: 'Canceled task',
    description: '```js\nconsole.log("hi")\n```\n\n- [x] done\n- [ ] todo',
    priority: 4,
    updatedAt: '2025-06-04T00:00:00Z',
    archivedAt: null,
    state: { id: 'st-canceled', name: 'Canceled', type: 'canceled' },
    assignee: { id: 'u-2', name: 'Bob' },
    team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
    project: { id: 'lp-1', name: 'Alpha' },
    url: 'https://linear.app/test/ENG-103'
  },
  lowest: {
    id: 'LIN-5',
    identifier: 'ENG-104',
    title: 'Lowest priority',
    description: 'Simple text',
    priority: 5,
    updatedAt: '2025-06-05T00:00:00Z',
    archivedAt: null,
    state: { id: 'st-completed', name: 'Done', type: 'completed' },
    assignee: { id: 'u-1', name: 'Alice' },
    team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
    project: null,
    url: 'https://linear.app/test/ENG-104'
  }
}

const ALL_ISSUES = Object.values(FIXTURES)

// Seed an API-test connection (with a readable plaintext credential) + project.
const apiConnId = 'conn-test-api'
const apiCredRef = 'cred-test-api'
seedCredential(apiCredRef, 'lin_test_key')
h.db
  .prepare(`
  INSERT OR REPLACE INTO integration_connections (id, provider, credential_ref, enabled)
  VALUES (?, 'linear', ?, 1)
`)
  .run(apiConnId, apiCredRef)

const apiProjectId = 'proj-api-test'
h.db
  .prepare(`INSERT OR IGNORE INTO projects (id, name, color, path, created_at, updated_at)
  VALUES (?, 'API Test', '#888888', '/tmp/api-test', datetime('now'), datetime('now'))`)
  .run(apiProjectId)

test('connectLinear: creates new connection', async () => {
  _mock.getViewer = async () => ({
    workspaceId: 'ws-new',
    workspaceName: 'New WS',
    accountLabel: 'new@test.com'
  })
  const result = (await caller.connectLinear({
    apiKey: 'lin_new_key',
    projectId: apiProjectId
  })) as Record<string, unknown>
  expect(result.provider).toBe('linear')
  expect(result.enabled).toBe(true)
  expect('credential_ref' in result).toBe(false)
  h.db.prepare('DELETE FROM integration_connections WHERE id = ?').run(result.id as string)
})

test('connectLinear: re-connect updates existing', async () => {
  await caller.setProjectConnection({
    projectId: apiProjectId,
    provider: 'linear',
    connectionId: apiConnId
  })
  _mock.getViewer = async () => ({
    workspaceId: 'ws-1',
    workspaceName: 'Updated WS',
    accountLabel: 'updated@test.com'
  })
  const result = (await caller.connectLinear({
    apiKey: 'lin_updated_key',
    projectId: apiProjectId
  })) as { id: string }
  expect(result.id).toBe(apiConnId)
  // Restore the credential (connect-linear rotated the credential_ref)
  const conn = h.db
    .prepare('SELECT credential_ref FROM integration_connections WHERE id = ?')
    .get(apiConnId) as { credential_ref: string }
  seedCredential(conn.credential_ref, 'lin_test_key')
})

test('connectLinear: rejects empty API key', async () => {
  const threw = await didThrow(() => caller.connectLinear({ apiKey: '  ' }))
  expect(threw).toBe(true)
})

test('listLinearTeams: returns teams from mock', async () => {
  _mock.listTeams = async () => ({
    teams: [
      { id: 'team-1', key: 'ENG', name: 'Engineering' },
      { id: 'team-2', key: 'DES', name: 'Design' }
    ],
    orgUrlKey: 'my-workspace'
  })
  const result = (await caller.listLinearTeams({ connectionId: apiConnId })) as {
    teams: { key: string }[]
  }
  expect(result.teams.length).toBe(2)
  expect(result.teams[0].key).toBe('ENG')
})

test('listLinearProjects: returns projects for team', async () => {
  _mock.listProjects = async () => [{ id: 'lp-1', name: 'Alpha', teamId: 'team-1' }]
  const projects = (await caller.listLinearProjects({
    connectionId: apiConnId,
    teamId: 'team-1'
  })) as { name: string }[]
  expect(projects.length).toBe(1)
  expect(projects[0].name).toBe('Alpha')
})

test('setProjectMapping: creates mapping and refreshes state mappings', async () => {
  _mock.listWorkflowStates = async () =>
    [
      { id: 'st-triage', type: 'triage' },
      { id: 'st-backlog', type: 'backlog' },
      { id: 'st-unstarted', type: 'unstarted' },
      { id: 'st-started', type: 'started' },
      { id: 'st-completed', type: 'completed' }
    ] as never
  const mapping = (await caller.setProjectMapping({
    projectId: apiProjectId,
    provider: 'linear',
    connectionId: apiConnId,
    externalTeamId: 'team-1',
    externalTeamKey: 'ENG',
    externalProjectId: null,
    syncMode: 'two_way'
  })) as { id: string; project_id: string; sync_mode: string }
  expect(mapping.project_id).toBe(apiProjectId)
  expect(mapping.sync_mode).toBe('two_way')
  const states = h.db
    .prepare('SELECT * FROM integration_state_mappings WHERE project_mapping_id = ?')
    .all(mapping.id) as { local_status: string; state_id: string }[]
  expect(states.length).toBeGreaterThan(0)
  const inbox = states.find((s) => s.local_status === 'inbox')!
  expect(inbox.state_id).toBe('st-triage')
})

test('setProjectMapping: upserts on same project+provider', async () => {
  const mapping2 = (await caller.setProjectMapping({
    projectId: apiProjectId,
    provider: 'linear',
    connectionId: apiConnId,
    externalTeamId: 'team-1',
    externalTeamKey: 'ENG',
    externalProjectId: 'lp-1',
    syncMode: 'one_way'
  })) as { external_project_id: string; sync_mode: string }
  expect(mapping2.external_project_id).toBe('lp-1')
  expect(mapping2.sync_mode).toBe('one_way')
})

// Import/sync behavior requires status setup to be complete. This must run AFTER
// the setProjectMapping tests above (which create the mapping) — a top-level
// statement would run during module-eval, before any deferred `test()` body, so
// it would update zero rows. Sequence it as its own test.
test('(setup) mark status setup complete for apiProject linear mapping', async () => {
  const res = h.db
    .prepare(
      `UPDATE integration_project_mappings SET status_setup_complete = 1 WHERE project_id = ? AND provider = 'linear'`
    )
    .run(apiProjectId)
  expect(res.changes).toBe(1)
})

test('listLinearIssues: annotates linkedTaskId for linked issues', async () => {
  const linkedTaskId = 'task-linked-1'
  h.db
    .prepare(`INSERT OR IGNORE INTO tasks (id, project_id, title, status, priority, terminal_mode, provider_config, claude_flags, codex_flags, created_at, updated_at)
    VALUES (?, ?, 'Linked', 'todo', 3, 'claude-code', '{}', '', '', datetime('now'), datetime('now'))`)
    .run(linkedTaskId, apiProjectId)
  h.db
    .prepare(`INSERT OR IGNORE INTO external_links (id, provider, connection_id, external_type, external_id, external_key, external_url, task_id, sync_state, created_at, updated_at)
    VALUES ('el-1', 'linear', ?, 'issue', 'LIN-1', 'ENG-100', '', ?, 'active', datetime('now'), datetime('now'))`)
    .run(apiConnId, linkedTaskId)

  _mock.listIssues = async () => ({ issues: [{ ...FIXTURES.normal }], nextCursor: null })
  const result = (await caller.listLinearIssues({
    connectionId: apiConnId,
    teamId: 'team-1'
  })) as { issues: { linkedTaskId: string | null }[]; nextCursor: string | null }
  expect(result.issues.length).toBe(1)
  expect(result.issues[0].linkedTaskId).toBe(linkedTaskId)
  expect(result.nextCursor).toBeNull()
})

test('listLinearIssues: returns null linkedTaskId for unlinked issues', async () => {
  _mock.listIssues = async () => ({ issues: [{ ...FIXTURES.urgent }], nextCursor: 'cursor-next' })
  const result = (await caller.listLinearIssues({
    connectionId: apiConnId,
    teamId: 'team-1'
  })) as { issues: { linkedTaskId: string | null }[]; nextCursor: string | null }
  expect(result.issues[0].linkedTaskId).toBeNull()
  expect(result.nextCursor).toBe('cursor-next')
})

test('importLinearIssues: imports all with correct priority + state mapping', async () => {
  // Clean slate
  h.db.prepare('DELETE FROM external_links WHERE connection_id = ?').run(apiConnId)
  h.db.prepare('DELETE FROM tasks WHERE project_id = ?').run(apiProjectId)

  _mock.listIssues = async () => ({ issues: ALL_ISSUES.map((i) => ({ ...i })), nextCursor: null })
  const result = (await caller.importLinearIssues({
    projectId: apiProjectId,
    connectionId: apiConnId,
    teamId: 'team-1'
  })) as { imported: number; linked: number }
  expect(result.imported).toBe(5)
  expect(result.linked).toBe(5)

  const tasks = h.db
    .prepare(
      'SELECT title, priority, status, assignee, description FROM tasks WHERE project_id = ? ORDER BY title'
    )
    .all(apiProjectId) as {
    title: string
    priority: number
    status: string
    assignee: string | null
    description: string | null
  }[]

  // Priority mapping: Linear → Local
  const canceled = tasks.find((t) => t.title === 'Canceled task')!
  expect(canceled.priority).toBe(2) // Linear 4 → local 2
  expect(canceled.status).toBe('canceled') // canceled → canceled
  expect(canceled.assignee).toBe('Bob')
  expect(canceled.description).toBeTruthy()

  const urgent = tasks.find((t) => t.title === 'Urgent bug')!
  expect(urgent.priority).toBe(5) // Linear 1 → local 5
  expect(urgent.status).toBe('inbox') // triage → inbox
  expect(urgent.assignee).toBeNull()
  expect(urgent.description).toBeNull()

  const noPri = tasks.find((t) => t.title === 'No priority issue')!
  expect(noPri.priority).toBe(5) // Linear 0 → local 5

  const normal = tasks.find((t) => t.title === 'Normal task')!
  expect(normal.priority).toBe(3) // Linear 3 → local 3
  expect(normal.status).toBe('in_progress') // started → in_progress

  const lowest = tasks.find((t) => t.title === 'Lowest priority')!
  expect(lowest.priority).toBe(1) // Linear 5 → local 1
  expect(lowest.status).toBe('done') // completed → done
})

test('importLinearIssues: selectedIssueIds filters imports', async () => {
  h.db.prepare('DELETE FROM external_links WHERE connection_id = ?').run(apiConnId)
  h.db.prepare('DELETE FROM tasks WHERE project_id = ?').run(apiProjectId)

  _mock.listIssues = async () => ({ issues: ALL_ISSUES.map((i) => ({ ...i })), nextCursor: null })
  const result = (await caller.importLinearIssues({
    projectId: apiProjectId,
    connectionId: apiConnId,
    teamId: 'team-1',
    selectedIssueIds: ['LIN-1', 'LIN-3']
  })) as { imported: number }
  expect(result.imported).toBe(2)
  const tasks = h.db
    .prepare('SELECT title FROM tasks WHERE project_id = ?')
    .all(apiProjectId) as unknown[]
  expect(tasks.length).toBe(2)
})

test('importLinearIssues: re-import updates existing (dedup)', async () => {
  const updatedNormal: LinearIssueSummary = {
    ...FIXTURES.normal,
    title: 'Updated normal task',
    priority: 2
  }
  _mock.listIssues = async () => ({ issues: [updatedNormal], nextCursor: null })
  const result = (await caller.importLinearIssues({
    projectId: apiProjectId,
    connectionId: apiConnId,
    teamId: 'team-1',
    selectedIssueIds: ['LIN-1']
  })) as { imported: number }
  expect(result.imported).toBe(1)
  const tasks = h.db
    .prepare('SELECT title, priority FROM tasks WHERE project_id = ?')
    .all(apiProjectId) as { title: string; priority: number }[]
  expect(tasks.length).toBe(2) // no new task
  const updated = tasks.find((t) => t.title === 'Updated normal task')!
  expect(updated).toBeTruthy()
  expect(updated.priority).toBe(4) // Linear 2 → local 4
})

test('importLinearIssues: markdown description converted to HTML', async () => {
  h.db.prepare('DELETE FROM external_links WHERE connection_id = ?').run(apiConnId)
  h.db.prepare('DELETE FROM tasks WHERE project_id = ?').run(apiProjectId)

  _mock.listIssues = async () => ({ issues: [{ ...FIXTURES.canceled }], nextCursor: null })
  await caller.importLinearIssues({
    projectId: apiProjectId,
    connectionId: apiConnId,
    teamId: 'team-1'
  })
  const task = h.db
    .prepare('SELECT description FROM tasks WHERE project_id = ?')
    .get(apiProjectId) as { description: string }
  const desc = task.description
  expect(desc.includes('<pre><code>')).toBe(true)
  expect(desc.includes('console.log')).toBe(true)
  expect(desc.includes('data-type="taskList"')).toBe(true)
})

test('importLinearIssues: throws when no team + no mapping', async () => {
  const otherProject = 'proj-no-mapping'
  h.db
    .prepare(`INSERT OR IGNORE INTO projects (id, name, color, path, created_at, updated_at)
    VALUES (?, 'No Mapping', '#888888', '/tmp/no-map', datetime('now'), datetime('now'))`)
    .run(otherProject)
  const threw = await didThrow(() =>
    caller.importLinearIssues({ projectId: otherProject, connectionId: apiConnId })
  )
  expect(threw).toBe(true)
})

// ── sync-now ────────────────────────────────────────────────────────────────
test('syncNow: pulls remote when remote is newer', async () => {
  // Clean slate for sync tests (in-body so it runs in sequence, not at module-eval)
  h.db.prepare('DELETE FROM external_field_state').run()
  h.db.prepare('DELETE FROM external_links WHERE connection_id = ?').run(apiConnId)
  h.db.prepare('DELETE FROM tasks WHERE project_id = ?').run(apiProjectId)

  const syncTaskId = 'task-sync-pull'
  h.db
    .prepare(`INSERT INTO tasks (id, project_id, title, description, status, priority, terminal_mode, provider_config, claude_flags, codex_flags, created_at, updated_at)
    VALUES (?, ?, 'Old title', null, 'todo', 3, 'claude-code', '{}', '', '', datetime('now'), '2025-01-01 00:00:00')`)
    .run(syncTaskId, apiProjectId)
  h.db
    .prepare(`INSERT INTO external_links (id, provider, connection_id, external_type, external_id, external_key, external_url, task_id, sync_state, created_at, updated_at)
    VALUES ('el-sync-1', 'linear', ?, 'issue', 'LIN-1', 'ENG-100', '', ?, 'active', datetime('now'), datetime('now'))`)
    .run(apiConnId, syncTaskId)

  _mock.getIssue = async () => ({
    ...FIXTURES.normal,
    title: 'Pulled from remote',
    updatedAt: '2025-12-01T00:00:00Z'
  })
  const result = (await caller.syncNow({ taskId: syncTaskId })) as {
    scanned: number
    pulled: number
    pushed: number
  }
  expect(result.scanned).toBe(1)
  expect(result.pulled).toBe(1)
  expect(result.pushed).toBe(0)
  const task = h.db.prepare('SELECT title FROM tasks WHERE id = ?').get(syncTaskId) as {
    title: string
  }
  expect(task.title).toBe('Pulled from remote')
})

test('syncNow: pushes local when local newer + two_way', async () => {
  h.db
    .prepare(`UPDATE integration_project_mappings SET sync_mode = 'two_way' WHERE project_id = ?`)
    .run(apiProjectId)
  h.db.prepare('DELETE FROM external_field_state').run()
  h.db.prepare('DELETE FROM external_links WHERE connection_id = ?').run(apiConnId)
  h.db.prepare('DELETE FROM tasks WHERE project_id = ?').run(apiProjectId)

  const pushTaskId = 'task-sync-push'
  h.db
    .prepare(`INSERT INTO tasks (id, project_id, title, description, status, priority, terminal_mode, provider_config, claude_flags, codex_flags, created_at, updated_at)
    VALUES (?, ?, 'Local newer', '<p>local desc</p>', 'in_progress', 4, 'claude-code', '{}', '', '', datetime('now'), '2099-01-01 00:00:00')`)
    .run(pushTaskId, apiProjectId)
  h.db
    .prepare(`INSERT INTO external_links (id, provider, connection_id, external_type, external_id, external_key, external_url, task_id, sync_state, created_at, updated_at)
    VALUES ('el-sync-2', 'linear', ?, 'issue', 'LIN-1', 'ENG-100', '', ?, 'active', datetime('now'), datetime('now'))`)
    .run(apiConnId, pushTaskId)

  _mock.getIssue = async () => ({ ...FIXTURES.normal, updatedAt: '2025-01-01T00:00:00Z' })
  let pushedInput: { title: string; description: string } | null = null
  _mock.updateIssue = (async (_key: string, _id: string, input: unknown) => {
    pushedInput = input as { title: string; description: string }
    return { ...FIXTURES.normal, updatedAt: '2099-01-01T00:00:00Z' }
  }) as never

  const result = (await caller.syncNow({ taskId: pushTaskId })) as {
    scanned: number
    pushed: number
    pulled: number
  }
  expect(result.scanned).toBe(1)
  expect(result.pushed).toBe(1)
  expect(result.pulled).toBe(0)
  expect(pushedInput!.title).toBe('Local newer')
  expect(pushedInput!.description).toBe('local desc')
  const fieldStates = h.db
    .prepare('SELECT * FROM external_field_state WHERE external_link_id = ?')
    .all('el-sync-2') as unknown[]
  expect(fieldStates.length).toBeGreaterThan(0)
})

test('syncNow: does NOT push when one_way', async () => {
  h.db
    .prepare(`UPDATE integration_project_mappings SET sync_mode = 'one_way' WHERE project_id = ?`)
    .run(apiProjectId)
  _mock.getIssue = async () => ({ ...FIXTURES.normal, updatedAt: '2025-01-01T00:00:00Z' })
  _mock.updateIssue = (async () => {
    throw new Error('Should not have been called')
  }) as never
  const result = (await caller.syncNow({ taskId: 'task-sync-push' })) as {
    scanned: number
    pushed: number
    pulled: number
  }
  expect(result.scanned).toBe(1)
  expect(result.pushed).toBe(0)
  expect(result.pulled).toBe(0)
})

test('syncNow: missing remote archives local task (treats issue as deleted upstream)', async () => {
  // CONTRACT DIVERGENCE vs the legacy IPC handler test: the old sync path
  // recorded an error (sync_state='error', last_error='Remote issue not found')
  // when the remote issue was absent. The current ops (sync.ts "Issue gone —
  // archive local task") instead treats a missing remote as an upstream deletion:
  // it archives the local task and counts it as a pull, with NO error. The string
  // "Remote issue not found" no longer exists in the codebase. We assert the
  // current behavior on a fresh, isolated link so prior tests' archival can't
  // confound the scan.
  const missTaskId = 'task-sync-miss'
  h.db
    .prepare(`INSERT INTO tasks (id, project_id, title, description, status, priority, terminal_mode, provider_config, claude_flags, codex_flags, created_at, updated_at)
    VALUES (?, ?, 'Will be archived', null, 'todo', 3, 'claude-code', '{}', '', '', datetime('now'), '2025-01-01 00:00:00')`)
    .run(missTaskId, apiProjectId)
  h.db
    .prepare(`INSERT INTO external_links (id, provider, connection_id, external_type, external_id, external_key, external_url, task_id, sync_state, created_at, updated_at)
    VALUES ('el-sync-miss', 'linear', ?, 'issue', 'LIN-MISS', 'ENG-MISS', '', ?, 'active', datetime('now'), datetime('now'))`)
    .run(apiConnId, missTaskId)

  _mock.getIssue = async () => null
  _mock.getIssuesBatch = (async () => new Map()) as never
  const result = (await caller.syncNow({ taskId: missTaskId })) as {
    scanned: number
    pulled: number
    errors: unknown[]
  }
  expect(result.scanned).toBe(1)
  expect(result.pulled).toBe(1)
  expect(result.errors.length).toBe(0)
  const task = h.db
    .prepare('SELECT archived_at FROM tasks WHERE id = ?')
    .get(missTaskId) as { archived_at: string | null }
  expect(task.archived_at).toBeTruthy()
})

test('syncNow: records error when remote fetch throws (non-auth API error)', async () => {
  // The error-recording path (sync.ts markLinkError → sync_state='error') now
  // fires when the batch fetch itself throws a non-auth error. Use a fresh link.
  const errTaskId = 'task-sync-err'
  h.db
    .prepare(`INSERT INTO tasks (id, project_id, title, description, status, priority, terminal_mode, provider_config, claude_flags, codex_flags, created_at, updated_at)
    VALUES (?, ?, 'Errors on sync', null, 'todo', 3, 'claude-code', '{}', '', '', datetime('now'), '2025-01-01 00:00:00')`)
    .run(errTaskId, apiProjectId)
  h.db
    .prepare(`INSERT INTO external_links (id, provider, connection_id, external_type, external_id, external_key, external_url, task_id, sync_state, created_at, updated_at)
    VALUES ('el-sync-err', 'linear', ?, 'issue', 'LIN-ERR', 'ENG-ERR', '', ?, 'active', datetime('now'), datetime('now'))`)
    .run(apiConnId, errTaskId)

  _mock.getIssuesBatch = (async () => {
    throw new Error('Network timeout')
  }) as never
  _mock.getIssue = async () => {
    throw new Error('Network timeout')
  }
  const result = (await caller.syncNow({ taskId: errTaskId })) as {
    scanned: number
    errors: unknown[]
  }
  expect(result.scanned).toBe(1)
  expect(result.errors.length).toBe(1)
  expect(result.errors[0]).toBeTruthy()
  const link = h.db
    .prepare('SELECT sync_state, last_error FROM external_links WHERE id = ?')
    .get('el-sync-err') as { sync_state: string; last_error: string }
  expect(link.sync_state).toBe('error')
  expect(link.last_error).toBeTruthy()

  // Restore the batch mock so later tests' default empty-map behavior holds.
  _mock.getIssuesBatch = (async () => new Map()) as never
})

// ── auto-create-worktree on import (issue #84) ────────────────────────────
function gitInRepo(repoPath: string, cmd: string): void {
  execSync(cmd, {
    cwd: repoPath,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 't@t'
    }
  })
}

function setupGitProject(targetProjectId: string): string {
  const tmp = h.tmpDir()
  const repo = path.join(tmp, 'repo')
  fs.mkdirSync(repo)
  gitInRepo(repo, 'git init -b main')
  fs.writeFileSync(path.join(repo, 'README.md'), '# Test')
  gitInRepo(repo, 'git add -A')
  gitInRepo(repo, 'git -c commit.gpgsign=false commit -m initial')
  h.db
    .prepare(`INSERT OR REPLACE INTO projects (id, name, color, path, created_at, updated_at)
    VALUES (?, 'WT Test', '#888888', ?, datetime('now'), datetime('now'))`)
    .run(targetProjectId, repo)
  h.db
    .prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('worktree_base_path', ?)`)
    .run(path.join(repo, '.worktrees'))
  return repo
}

test('importLinearIssues: provisions worktree when setting=1 (issue #84)', async () => {
  const wtProjectId = 'proj-wt-on'
  const repo = setupGitProject(wtProjectId)
  h.db
    .prepare(
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('auto_create_worktree_on_task_create', '1')`
    )
    .run()
  await caller.setProjectMapping({
    projectId: wtProjectId,
    provider: 'linear',
    connectionId: apiConnId,
    externalTeamId: 'team-1',
    externalTeamKey: 'ENG',
    externalProjectId: null,
    syncMode: 'one_way'
  })
  // setProjectMapping leaves status_setup_complete=0; import requires it complete.
  h.db
    .prepare(
      `UPDATE integration_project_mappings SET status_setup_complete = 1 WHERE project_id = ? AND provider = 'linear'`
    )
    .run(wtProjectId)

  _mock.listIssues = async () => ({
    issues: [{ ...FIXTURES.normal, id: 'LIN-WT-1' }],
    nextCursor: null
  })
  await caller.importLinearIssues({
    projectId: wtProjectId,
    connectionId: apiConnId,
    teamId: 'team-1'
  })

  const task = h.db
    .prepare('SELECT worktree_path FROM tasks WHERE project_id = ?')
    .get(wtProjectId) as { worktree_path: string | null }
  expect(task).toBeTruthy()
  expect(typeof task.worktree_path === 'string' && task.worktree_path.length > 0).toBe(true)
  expect(task.worktree_path!.startsWith(path.join(repo, '.worktrees'))).toBe(true)
  expect(fs.existsSync(task.worktree_path!)).toBe(true)
})

test('importLinearIssues: skips worktree when setting=0', async () => {
  const wtProjectId = 'proj-wt-off'
  setupGitProject(wtProjectId)
  h.db
    .prepare(
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('auto_create_worktree_on_task_create', '0')`
    )
    .run()
  await caller.setProjectMapping({
    projectId: wtProjectId,
    provider: 'linear',
    connectionId: apiConnId,
    externalTeamId: 'team-1',
    externalTeamKey: 'ENG',
    externalProjectId: null,
    syncMode: 'one_way'
  })
  h.db
    .prepare(
      `UPDATE integration_project_mappings SET status_setup_complete = 1 WHERE project_id = ? AND provider = 'linear'`
    )
    .run(wtProjectId)

  _mock.listIssues = async () => ({
    issues: [{ ...FIXTURES.normal, id: 'LIN-WT-2' }],
    nextCursor: null
  })
  await caller.importLinearIssues({
    projectId: wtProjectId,
    connectionId: apiConnId,
    teamId: 'team-1'
  })

  const task = h.db
    .prepare('SELECT worktree_path FROM tasks WHERE project_id = ?')
    .get(wtProjectId) as { worktree_path: string | null }
  expect(task).toBeTruthy()
  expect(task.worktree_path == null || task.worktree_path === '').toBe(true)
})

test('importLinearIssues: re-import updates existing task without disturbing worktree', async () => {
  const wtProjectId = 'proj-wt-on'
  h.db
    .prepare(
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('auto_create_worktree_on_task_create', '1')`
    )
    .run()
  const before = h.db
    .prepare('SELECT worktree_path FROM tasks WHERE project_id = ?')
    .get(wtProjectId) as { worktree_path: string | null }
  _mock.listIssues = async () => ({
    issues: [{ ...FIXTURES.normal, id: 'LIN-WT-1', title: 'Re-imported' }],
    nextCursor: null
  })
  await caller.importLinearIssues({
    projectId: wtProjectId,
    connectionId: apiConnId,
    teamId: 'team-1'
  })
  const after = h.db
    .prepare('SELECT worktree_path, title FROM tasks WHERE project_id = ?')
    .get(wtProjectId) as { worktree_path: string | null; title: string }
  expect(after.title).toBe('Re-imported')
  expect(after.worktree_path).toBe(before.worktree_path)

  // Reset settings to avoid bleeding into later test runs.
  h.db.prepare(`DELETE FROM settings WHERE key = 'auto_create_worktree_on_task_create'`).run()
  h.db.prepare(`DELETE FROM settings WHERE key = 'worktree_base_path'`).run()
})
