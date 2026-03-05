/**
 * Integrations DB-only handler contract tests
 * (Skips Linear API handlers that need network)
 * Run with: ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/domains/integrations/src/main/handlers.db.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../../shared/test-utils/ipc-harness.js'
import { registerIntegrationHandlers } from './handlers.js'

const h = await createTestHarness()
registerIntegrationHandlers(h.ipcMain as never, h.db)

// Seed a project + task for link tests
const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(projectId, 'IntP', '#000', '/tmp/int-test')
const taskId = crypto.randomUUID()
h.db.prepare(
  "INSERT INTO tasks (id, project_id, title, status, priority, terminal_mode, provider_config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '{}', datetime('now'), datetime('now'))"
).run(taskId, projectId, 'Int Task', 'todo', 3, 'claude-code')

// Seed a connection directly (bypassing connect-linear which needs API)
const connId = crypto.randomUUID()
h.db.prepare(`
  INSERT INTO integration_connections (id, provider, credential_ref, enabled, created_at, updated_at)
  VALUES (?, 'linear', 'cred-ref-1', 1, datetime('now'), datetime('now'))
`).run(connId)

describe('integrations:list-connections', () => {
  test('returns connections without credential_ref', () => {
    const conns = h.invoke('integrations:list-connections') as Record<string, unknown>[]
    expect(conns.length).toBeGreaterThan(0)
    const conn = conns.find(c => c.id === connId)!
    expect(conn.provider).toBe('linear')
    // credential_ref should NOT be exposed
    expect('credential_ref' in conn).toBe(false)
  })

  test('filters by provider', () => {
    const conns = h.invoke('integrations:list-connections', 'linear') as { provider: string }[]
    for (const c of conns) expect(c.provider).toBe('linear')
  })
})

describe('integrations:get-connection-usage', () => {
  test('returns mapped projects and linked task counts', () => {
    const usageConnId = crypto.randomUUID()
    h.db.prepare(`
      INSERT INTO integration_connections (id, provider, credential_ref, enabled, created_at, updated_at)
      VALUES (?, 'linear', 'cred-ref-usage', 1, datetime('now'), datetime('now'))
    `).run(usageConnId)

    const mappedProjectId = crypto.randomUUID()
    h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(
      mappedProjectId,
      'Mapped Project',
      '#0ea5e9',
      '/tmp/int-mapped'
    )
    const mappedTaskId = crypto.randomUUID()
    h.db.prepare(
      "INSERT INTO tasks (id, project_id, title, status, priority, terminal_mode, provider_config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '{}', datetime('now'), datetime('now'))"
    ).run(mappedTaskId, mappedProjectId, 'Mapped task', 'todo', 3, 'claude-code')

    const linkedOnlyProjectId = crypto.randomUUID()
    h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(
      linkedOnlyProjectId,
      'Linked Only',
      '#f59e0b',
      '/tmp/int-linked-only'
    )
    const linkedOnlyTaskId = crypto.randomUUID()
    h.db.prepare(
      "INSERT INTO tasks (id, project_id, title, status, priority, terminal_mode, provider_config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '{}', datetime('now'), datetime('now'))"
    ).run(linkedOnlyTaskId, linkedOnlyProjectId, 'Linked task', 'todo', 3, 'claude-code')

    const mappingId = crypto.randomUUID()
    h.db.prepare(`
      INSERT INTO integration_project_mappings (id, project_id, provider, connection_id, external_team_id, external_team_key, sync_mode)
      VALUES (?, ?, 'linear', ?, 'team-usage', 'USAGE', 'one_way')
    `).run(mappingId, mappedProjectId, usageConnId)

    const mappedLinkId = crypto.randomUUID()
    h.db.prepare(`
      INSERT INTO external_links (id, provider, connection_id, external_type, external_id, external_key, external_url, task_id, sync_state)
      VALUES (?, 'linear', ?, 'issue', 'ext-usage-1', 'USAGE-1', 'https://linear.app/issue/USAGE-1', ?, 'active')
    `).run(mappedLinkId, usageConnId, mappedTaskId)

    const linkedOnlyLinkId = crypto.randomUUID()
    h.db.prepare(`
      INSERT INTO external_links (id, provider, connection_id, external_type, external_id, external_key, external_url, task_id, sync_state)
      VALUES (?, 'linear', ?, 'issue', 'ext-usage-2', 'USAGE-2', 'https://linear.app/issue/USAGE-2', ?, 'active')
    `).run(linkedOnlyLinkId, usageConnId, linkedOnlyTaskId)

    const usage = h.invoke('integrations:get-connection-usage', usageConnId) as {
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
    expect(usage.projects.find((project) => project.project_id === mappedProjectId)?.has_mapping).toBe(true)
    expect(usage.projects.find((project) => project.project_id === mappedProjectId)?.linked_task_count).toBe(1)
    expect(usage.projects.find((project) => project.project_id === linkedOnlyProjectId)?.has_mapping).toBe(false)
    expect(usage.projects.find((project) => project.project_id === linkedOnlyProjectId)?.linked_task_count).toBe(1)
  })
})

describe('integrations:get-project-mapping', () => {
  test('returns null when no mapping', () => {
    const result = h.invoke('integrations:get-project-mapping', projectId, 'linear')
    expect(result).toBeNull()
  })

  test('returns mapping after seeding', () => {
    const mappingId = crypto.randomUUID()
    h.db.prepare(`
      INSERT INTO integration_project_mappings (id, project_id, provider, connection_id, external_team_id, external_team_key, sync_mode)
      VALUES (?, ?, 'linear', ?, 'team-1', 'TEAM', 'one_way')
    `).run(mappingId, projectId, connId)

    const mapping = h.invoke('integrations:get-project-mapping', projectId, 'linear') as {
      id: string; project_id: string; external_team_id: string
    }
    expect(mapping).toBeTruthy()
    expect(mapping.project_id).toBe(projectId)
    expect(mapping.external_team_id).toBe('team-1')
  })
})

describe('integrations:get-link', () => {
  test('returns null when no link', () => {
    const result = h.invoke('integrations:get-link', taskId, 'linear')
    expect(result).toBeNull()
  })

  test('returns link after seeding', () => {
    const linkId = crypto.randomUUID()
    h.db.prepare(`
      INSERT INTO external_links (id, provider, connection_id, external_type, external_id, external_key, external_url, task_id, sync_state)
      VALUES (?, 'linear', ?, 'issue', 'ext-1', 'TEAM-123', 'https://linear.app/issue/TEAM-123', ?, 'active')
    `).run(linkId, connId, taskId)

    const link = h.invoke('integrations:get-link', taskId, 'linear') as {
      external_key: string; task_id: string
    }
    expect(link).toBeTruthy()
    expect(link.external_key).toBe('TEAM-123')
    expect(link.task_id).toBe(taskId)
  })
})

describe('integrations:unlink-task', () => {
  test('removes link and field state', () => {
    const result = h.invoke('integrations:unlink-task', taskId, 'linear')
    expect(result).toBe(true)

    const link = h.invoke('integrations:get-link', taskId, 'linear')
    expect(link).toBeNull()
  })

  test('returns false for nonexistent link', () => {
    const result = h.invoke('integrations:unlink-task', 'nope', 'linear')
    expect(result).toBe(false)
  })
})

describe('integrations:disconnect', () => {
  test('cascades delete (mappings, links, connection)', () => {
    // Re-seed a link for cascade test
    const linkId2 = crypto.randomUUID()
    h.db.prepare(`
      INSERT INTO external_links (id, provider, connection_id, external_type, external_id, external_key, task_id, sync_state)
      VALUES (?, 'linear', ?, 'issue', 'ext-2', 'TEAM-456', ?, 'active')
    `).run(linkId2, connId, taskId)

    const result = h.invoke('integrations:disconnect', connId)
    expect(result).toBe(true)

    const conns = h.invoke('integrations:list-connections') as { id: string }[]
    expect(conns.find(c => c.id === connId) ?? null).toBeNull()
  })
})

describe('integrations:clear-project-provider', () => {
  test('removes mapping and provider links for only the selected provider', () => {
    const linearConnId = crypto.randomUUID()
    h.db.prepare(`
      INSERT INTO integration_connections (id, provider, credential_ref, enabled, created_at, updated_at)
      VALUES (?, 'linear', 'cred-ref-linear-clear', 1, datetime('now'), datetime('now'))
    `).run(linearConnId)

    const clearProjectId = crypto.randomUUID()
    h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(
      clearProjectId,
      'Clear Provider',
      '#9333ea',
      '/tmp/int-clear-provider'
    )

    const taskLinear = crypto.randomUUID()
    const taskGithub = crypto.randomUUID()
    h.db.prepare(
      "INSERT INTO tasks (id, project_id, title, status, priority, terminal_mode, provider_config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '{}', datetime('now'), datetime('now'))"
    ).run(taskLinear, clearProjectId, 'Linear task', 'todo', 3, 'claude-code')
    h.db.prepare(
      "INSERT INTO tasks (id, project_id, title, status, priority, terminal_mode, provider_config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '{}', datetime('now'), datetime('now'))"
    ).run(taskGithub, clearProjectId, 'GitHub task', 'todo', 3, 'claude-code')

    const githubConnId = crypto.randomUUID()
    h.db.prepare(`
      INSERT INTO integration_connections (id, provider, credential_ref, enabled, created_at, updated_at)
      VALUES (?, 'github', 'cred-ref-gh-clear', 1, datetime('now'), datetime('now'))
    `).run(githubConnId)

    h.db.prepare(`
      INSERT INTO integration_project_mappings (id, project_id, provider, connection_id, external_team_id, external_team_key, sync_mode)
      VALUES (?, ?, 'linear', ?, 'team-clear', 'CLEAR', 'one_way')
    `).run(crypto.randomUUID(), clearProjectId, linearConnId)
    h.db.prepare(`
      INSERT INTO integration_project_mappings (id, project_id, provider, connection_id, external_team_id, external_team_key, sync_mode)
      VALUES (?, ?, 'github', ?, 'org-clear', 'ORG#1', 'one_way')
    `).run(crypto.randomUUID(), clearProjectId, githubConnId)

    h.db.prepare(`
      INSERT INTO external_links (id, provider, connection_id, external_type, external_id, external_key, external_url, task_id, sync_state)
      VALUES (?, 'linear', ?, 'issue', 'ext-clear-linear', 'CLEAR-1', 'https://linear.app/issue/CLEAR-1', ?, 'active')
    `).run(crypto.randomUUID(), linearConnId, taskLinear)
    h.db.prepare(`
      INSERT INTO external_links (id, provider, connection_id, external_type, external_id, external_key, external_url, task_id, sync_state)
      VALUES (?, 'github', ?, 'issue', 'ext-clear-github', 'ORG#1', 'https://github.com/org/issues/1', ?, 'active')
    `).run(crypto.randomUUID(), githubConnId, taskGithub)

    const result = h.invoke('integrations:clear-project-provider', {
      projectId: clearProjectId,
      provider: 'linear'
    })
    expect(result).toBe(true)

    const linearMapping = h.invoke('integrations:get-project-mapping', clearProjectId, 'linear')
    const githubMapping = h.invoke('integrations:get-project-mapping', clearProjectId, 'github')
    expect(linearMapping).toBeNull()
    expect(githubMapping).toBeTruthy()

    const linearLink = h.db.prepare("SELECT id FROM external_links WHERE provider = 'linear' AND task_id = ?").get(taskLinear)
    const githubLink = h.db.prepare("SELECT id FROM external_links WHERE provider = 'github' AND task_id = ?").get(taskGithub)
    expect(linearLink).toBeUndefined()
    expect(githubLink).toBeTruthy()
  })
})

h.cleanup()
console.log('\nDone')
