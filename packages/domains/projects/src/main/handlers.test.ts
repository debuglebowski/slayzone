/**
 * Projects handler contract tests
 * Run with: npx tsx packages/domains/projects/src/main/handlers.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../../shared/test-utils/ipc-harness.js'
import { registerProjectHandlers } from './handlers.js'
import type { ColumnConfig } from '../shared/types.js'

const h = await createTestHarness()
registerProjectHandlers(h.ipcMain as never, h.db)

describe('db:projects:create', () => {
  test('creates with defaults', () => {
    const p = h.invoke('db:projects:create', { name: 'Alpha', color: '#ff0000' }) as { id: string; name: string; color: string; path: null }
    expect(p.name).toBe('Alpha')
    expect(p.color).toBe('#ff0000')
    expect(p.path).toBeNull()
    expect(p.id).toBeTruthy()
  })

  test('creates with path', () => {
    const p = h.invoke('db:projects:create', { name: 'Beta', color: '#0000ff', path: '/tmp/beta' }) as { path: string }
    expect(p.path).toBe('/tmp/beta')
  })

  test('creates with custom columns config', () => {
    const columns: ColumnConfig[] = [
      { id: 'queue', label: 'Queue', color: 'gray', position: 2, category: 'unstarted' },
      { id: 'doing', label: 'Doing', color: 'blue', position: 3, category: 'started' },
      { id: 'closed', label: 'Closed', color: 'green', position: 9, category: 'completed' },
    ]
    const p = h.invoke('db:projects:create', {
      name: 'Columns Project',
      color: '#aabbcc',
      columnsConfig: columns
    }) as { columns_config: ColumnConfig[] | null }
    expect(p.columns_config).toEqual([
      { id: 'queue', label: 'Queue', color: 'gray', position: 0, category: 'unstarted' },
      { id: 'doing', label: 'Doing', color: 'blue', position: 1, category: 'started' },
      { id: 'closed', label: 'Closed', color: 'green', position: 2, category: 'completed' },
    ])
  })

  test('assigns sort_order at end', () => {
    const all = h.invoke('db:projects:getAll') as { sort_order: number }[]
    const last = all[all.length - 1]
    const p = h.invoke('db:projects:create', { name: 'Zeta', color: '#123456' }) as { sort_order: number }
    expect(p.sort_order).toBe(last.sort_order + 1)
  })
})

describe('db:projects:getAll', () => {
  test('returns projects ordered by sort_order', () => {
    const all = h.invoke('db:projects:getAll') as { name: string; sort_order: number }[]
    for (let i = 1; i < all.length; i++) {
      expect(all[i].sort_order).toBeGreaterThanOrEqual(all[i - 1].sort_order)
    }
  })
})

describe('db:projects:update', () => {
  test('updates name', () => {
    const all = h.invoke('db:projects:getAll') as { id: string }[]
    const p = h.invoke('db:projects:update', { id: all[0].id, name: 'Gamma' }) as { name: string }
    expect(p.name).toBe('Gamma')
  })

  test('updates path', () => {
    const all = h.invoke('db:projects:getAll') as { id: string }[]
    const p = h.invoke('db:projects:update', { id: all[1].id, path: '/tmp/new' }) as { path: string }
    expect(p.path).toBe('/tmp/new')
  })

  test('updates autoCreateWorktreeOnTaskCreate', () => {
    const all = h.invoke('db:projects:getAll') as { id: string }[]
    const p = h.invoke('db:projects:update', { id: all[0].id, autoCreateWorktreeOnTaskCreate: true }) as { auto_create_worktree_on_task_create: number }
    expect(p.auto_create_worktree_on_task_create).toBe(1)
  })

  test('sets autoCreateWorktreeOnTaskCreate to null', () => {
    const all = h.invoke('db:projects:getAll') as { id: string }[]
    const p = h.invoke('db:projects:update', { id: all[0].id, autoCreateWorktreeOnTaskCreate: null }) as { auto_create_worktree_on_task_create: null }
    expect(p.auto_create_worktree_on_task_create).toBeNull()
  })

  test('no-op returns current row', () => {
    const all = h.invoke('db:projects:getAll') as { id: string; name: string }[]
    const gamma = all.find(p => p.name === 'Gamma')!
    const p = h.invoke('db:projects:update', { id: gamma.id }) as { name: string }
    expect(p.name).toBe('Gamma')
  })

  test('updates columns config', () => {
    const all = h.invoke('db:projects:getAll') as { id: string; name: string }[]
    const project = all.find((p) => p.name === 'Columns Project')!
    const taskId = crypto.randomUUID()
    h.db.prepare(`
      INSERT INTO tasks (id, project_id, title, status, priority, "order")
      VALUES (?, ?, 'Needs remap', 'doing', 3, 0)
    `).run(taskId, project.id)

    const p = h.invoke('db:projects:update', {
      id: project.id,
      columnsConfig: [
        { id: 'todo', label: 'Todo', color: 'blue', position: 0, category: 'unstarted' },
        { id: 'done', label: 'Done', color: 'green', position: 1, category: 'completed' },
      ]
    }) as { columns_config: ColumnConfig[] | null }
    expect(p.columns_config).toEqual([
      { id: 'todo', label: 'Todo', color: 'blue', position: 0, category: 'unstarted' },
      { id: 'done', label: 'Done', color: 'green', position: 1, category: 'completed' },
    ])

    const remapped = h.db
      .prepare('SELECT status FROM tasks WHERE id = ?')
      .get(taskId) as { status: string }
    expect(remapped.status).toBe('todo')
  })

  test('clears columns config when set to null', () => {
    const all = h.invoke('db:projects:getAll') as { id: string; name: string }[]
    const project = all.find((p) => p.name === 'Columns Project')!
    const taskId = crypto.randomUUID()
    h.db.prepare(`
      INSERT INTO tasks (id, project_id, title, status, priority, "order")
      VALUES (?, ?, 'Custom status task', 'custom_status', 3, 0)
    `).run(taskId, project.id)

    const p = h.invoke('db:projects:update', { id: project.id, columnsConfig: null }) as {
      columns_config: ColumnConfig[] | null
    }
    expect(p.columns_config).toBeNull()

    const remapped = h.db
      .prepare('SELECT status FROM tasks WHERE id = ?')
      .get(taskId) as { status: string }
    expect(remapped.status).toBe('inbox')
  })

  test('reconciles linear state mappings when columns config changes', () => {
    h.db.exec(`
      CREATE TABLE IF NOT EXISTS integration_project_mappings (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        external_team_id TEXT NOT NULL,
        external_team_key TEXT NOT NULL,
        external_project_id TEXT DEFAULT NULL,
        sync_mode TEXT NOT NULL DEFAULT 'one_way',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS integration_state_mappings (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        project_mapping_id TEXT NOT NULL,
        local_status TEXT NOT NULL,
        state_id TEXT NOT NULL,
        state_type TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(provider, project_mapping_id, local_status)
      );
    `)

    const all = h.invoke('db:projects:getAll') as { id: string; name: string }[]
    const project = all.find((p) => p.name === 'Columns Project')!
    const mappingId = crypto.randomUUID()
    h.db.prepare(`
      INSERT OR REPLACE INTO integration_project_mappings (
        id, project_id, provider, connection_id, external_team_id, external_team_key, external_project_id, sync_mode
      ) VALUES (?, ?, 'linear', 'conn-1', 'team-1', 'ENG', NULL, 'two_way')
    `).run(mappingId, project.id)
    h.db.prepare(`
      INSERT OR REPLACE INTO integration_state_mappings (
        id, provider, project_mapping_id, local_status, state_id, state_type
      ) VALUES
        (?, 'linear', ?, 'todo_old', 'st-unstarted', 'unstarted'),
        (?, 'linear', ?, 'done_old', 'st-completed', 'completed')
    `).run(crypto.randomUUID(), mappingId, crypto.randomUUID(), mappingId)

    h.invoke('db:projects:update', {
      id: project.id,
      columnsConfig: [
        { id: 'queued', label: 'Queued', color: 'gray', position: 0, category: 'unstarted' },
        { id: 'shipped', label: 'Shipped', color: 'green', position: 1, category: 'completed' },
      ]
    })

    const rows = h.db.prepare(`
      SELECT local_status, state_id, state_type
      FROM integration_state_mappings
      WHERE provider = 'linear' AND project_mapping_id = ?
      ORDER BY local_status
    `).all(mappingId) as Array<{ local_status: string; state_id: string; state_type: string }>

    expect(rows).toEqual([
      { local_status: 'queued', state_id: 'st-unstarted', state_type: 'unstarted' },
      { local_status: 'shipped', state_id: 'st-completed', state_type: 'completed' },
    ])
  })
})

describe('db:projects:delete', () => {
  test('deletes existing', () => {
    const p = h.invoke('db:projects:create', { name: 'Temp', color: '#000000' }) as { id: string }
    expect(h.invoke('db:projects:delete', p.id)).toBe(true)
  })

  test('returns false for nonexistent', () => {
    expect(h.invoke('db:projects:delete', 'nope')).toBe(false)
  })
})

describe('db:projects:reorder', () => {
  test('reorders projects by given ID array', () => {
    const before = h.invoke('db:projects:getAll') as { id: string; name: string; sort_order: number }[]
    const reversed = [...before].reverse().map((p) => p.id)
    h.invoke('db:projects:reorder', reversed)
    const after = h.invoke('db:projects:getAll') as { id: string; name: string; sort_order: number }[]
    expect(after.map((p) => p.id)).toEqual(reversed)
    expect(after[0].sort_order).toBe(0)
    expect(after[1].sort_order).toBe(1)
  })

  test('throws on partial list', () => {
    const before = h.invoke('db:projects:getAll') as { id: string }[]
    expect(() => h.invoke('db:projects:reorder', [before[0].id])).toThrow()
  })

  test('no-ops on empty array', () => {
    const before = h.invoke('db:projects:getAll') as { id: string; sort_order: number }[]
    h.invoke('db:projects:reorder', [])
    const after = h.invoke('db:projects:getAll') as { id: string; sort_order: number }[]
    expect(after.map((p) => p.id)).toEqual(before.map((p) => p.id))
  })
})

describe('db:projects:create sort_order edge cases', () => {
  test('first project gets sort_order 0', () => {
    // Delete all projects
    const all = h.invoke('db:projects:getAll') as { id: string }[]
    for (const p of all) {
      h.invoke('db:projects:delete', p.id)
    }
    const p = h.invoke('db:projects:create', { name: 'First', color: '#111111' }) as { sort_order: number }
    expect(p.sort_order).toBe(0)
  })
})

describe('task_automation_config CRUD', () => {
  test('task_automation_config is null by default', () => {
    const p = h.invoke('db:projects:create', { name: 'AutoDefault', color: '#000000' }) as { task_automation_config: null }
    expect(p.task_automation_config).toBeNull()
  })

  test('sets task_automation_config via update', () => {
    const p = h.invoke('db:projects:create', { name: 'AutoSet', color: '#111111' }) as { id: string }
    const updated = h.invoke('db:projects:update', {
      id: p.id,
      taskAutomationConfig: { on_terminal_active: 'in_progress', on_terminal_idle: null }
    }) as { task_automation_config: { on_terminal_active: string | null; on_terminal_idle: string | null } }
    expect(updated.task_automation_config).toEqual({ on_terminal_active: 'in_progress', on_terminal_idle: null })
  })

  test('sets both fields in task_automation_config', () => {
    const p = h.invoke('db:projects:create', { name: 'AutoBoth', color: '#222222' }) as { id: string }
    const updated = h.invoke('db:projects:update', {
      id: p.id,
      taskAutomationConfig: { on_terminal_active: 'in_progress', on_terminal_idle: 'review' }
    }) as { task_automation_config: { on_terminal_active: string; on_terminal_idle: string } }
    expect(updated.task_automation_config.on_terminal_active).toBe('in_progress')
    expect(updated.task_automation_config.on_terminal_idle).toBe('review')
  })

  test('clears task_automation_config when set to null', () => {
    const p = h.invoke('db:projects:create', { name: 'AutoClear', color: '#333333' }) as { id: string }
    h.invoke('db:projects:update', {
      id: p.id,
      taskAutomationConfig: { on_terminal_active: 'todo', on_terminal_idle: null }
    })
    const cleared = h.invoke('db:projects:update', {
      id: p.id,
      taskAutomationConfig: null
    }) as { task_automation_config: null }
    expect(cleared.task_automation_config).toBeNull()
  })

  test('round-trip: set config, getAll, values match', () => {
    const p = h.invoke('db:projects:create', { name: 'AutoRoundTrip', color: '#444444' }) as { id: string }
    h.invoke('db:projects:update', {
      id: p.id,
      taskAutomationConfig: { on_terminal_active: 'doing', on_terminal_idle: 'review' }
    })
    const all = h.invoke('db:projects:getAll') as { id: string; task_automation_config: { on_terminal_active: string; on_terminal_idle: string } | null }[]
    const found = all.find(proj => proj.id === p.id)!
    expect(found.task_automation_config).toEqual({ on_terminal_active: 'doing', on_terminal_idle: 'review' })
  })

  test('no-op update preserves existing task_automation_config', () => {
    const p = h.invoke('db:projects:create', { name: 'AutoPreserve', color: '#555555' }) as { id: string }
    h.invoke('db:projects:update', {
      id: p.id,
      taskAutomationConfig: { on_terminal_active: 'todo', on_terminal_idle: null }
    })
    const noop = h.invoke('db:projects:update', { id: p.id }) as { task_automation_config: { on_terminal_active: string; on_terminal_idle: null } }
    expect(noop.task_automation_config).toEqual({ on_terminal_active: 'todo', on_terminal_idle: null })
  })
})

describe('task_automation_config stale reference cleanup', () => {
  test('clears on_terminal_active when referenced status removed from columns', () => {
    const p = h.invoke('db:projects:create', {
      name: 'StaleActive', color: '#660000',
      columnsConfig: [
        { id: 'doing', label: 'Doing', color: 'blue', position: 0, category: 'started' },
        { id: 'done', label: 'Done', color: 'green', position: 1, category: 'completed' },
      ]
    }) as { id: string }
    h.invoke('db:projects:update', {
      id: p.id,
      taskAutomationConfig: { on_terminal_active: 'doing', on_terminal_idle: null }
    })
    const updated = h.invoke('db:projects:update', {
      id: p.id,
      columnsConfig: [
        { id: 'todo', label: 'Todo', color: 'blue', position: 0, category: 'unstarted' },
        { id: 'done', label: 'Done', color: 'green', position: 1, category: 'completed' },
      ]
    }) as { task_automation_config: { on_terminal_active: string | null; on_terminal_idle: string | null } }
    expect(updated.task_automation_config.on_terminal_active).toBeNull()
  })

  test('clears on_terminal_idle when referenced status removed from columns', () => {
    const p = h.invoke('db:projects:create', {
      name: 'StaleIdle', color: '#770000',
      columnsConfig: [
        { id: 'doing', label: 'Doing', color: 'blue', position: 0, category: 'started' },
        { id: 'review', label: 'Review', color: 'purple', position: 1, category: 'started' },
        { id: 'done', label: 'Done', color: 'green', position: 2, category: 'completed' },
      ]
    }) as { id: string }
    h.invoke('db:projects:update', {
      id: p.id,
      taskAutomationConfig: { on_terminal_active: null, on_terminal_idle: 'review' }
    })
    const updated = h.invoke('db:projects:update', {
      id: p.id,
      columnsConfig: [
        { id: 'doing', label: 'Doing', color: 'blue', position: 0, category: 'started' },
        { id: 'done', label: 'Done', color: 'green', position: 1, category: 'completed' },
      ]
    }) as { task_automation_config: { on_terminal_active: string | null; on_terminal_idle: string | null } }
    expect(updated.task_automation_config.on_terminal_idle).toBeNull()
  })

  test('clears both fields when both reference removed statuses', () => {
    const p = h.invoke('db:projects:create', {
      name: 'StaleBoth', color: '#880000',
      columnsConfig: [
        { id: 'doing', label: 'Doing', color: 'blue', position: 0, category: 'started' },
        { id: 'review', label: 'Review', color: 'purple', position: 1, category: 'started' },
        { id: 'done', label: 'Done', color: 'green', position: 2, category: 'completed' },
      ]
    }) as { id: string }
    h.invoke('db:projects:update', {
      id: p.id,
      taskAutomationConfig: { on_terminal_active: 'doing', on_terminal_idle: 'review' }
    })
    const updated = h.invoke('db:projects:update', {
      id: p.id,
      columnsConfig: [
        { id: 'todo', label: 'Todo', color: 'blue', position: 0, category: 'unstarted' },
        { id: 'done', label: 'Done', color: 'green', position: 1, category: 'completed' },
      ]
    }) as { task_automation_config: { on_terminal_active: string | null; on_terminal_idle: string | null } }
    expect(updated.task_automation_config.on_terminal_active).toBeNull()
    expect(updated.task_automation_config.on_terminal_idle).toBeNull()
  })

  test('keeps valid references when only some statuses removed', () => {
    const p = h.invoke('db:projects:create', {
      name: 'StalePartial', color: '#990000',
      columnsConfig: [
        { id: 'todo', label: 'Todo', color: 'blue', position: 0, category: 'unstarted' },
        { id: 'doing', label: 'Doing', color: 'yellow', position: 1, category: 'started' },
        { id: 'done', label: 'Done', color: 'green', position: 2, category: 'completed' },
      ]
    }) as { id: string }
    h.invoke('db:projects:update', {
      id: p.id,
      taskAutomationConfig: { on_terminal_active: 'todo', on_terminal_idle: 'doing' }
    })
    const updated = h.invoke('db:projects:update', {
      id: p.id,
      columnsConfig: [
        { id: 'todo', label: 'Todo', color: 'blue', position: 0, category: 'unstarted' },
        { id: 'done', label: 'Done', color: 'green', position: 1, category: 'completed' },
      ]
    }) as { task_automation_config: { on_terminal_active: string; on_terminal_idle: string | null } }
    expect(updated.task_automation_config.on_terminal_active).toBe('todo')
    expect(updated.task_automation_config.on_terminal_idle).toBeNull()
  })

  test('no cleanup when automation config is null', () => {
    const p = h.invoke('db:projects:create', {
      name: 'StaleNull', color: '#aa0000',
      columnsConfig: [
        { id: 'todo', label: 'Todo', color: 'blue', position: 0, category: 'unstarted' },
        { id: 'done', label: 'Done', color: 'green', position: 1, category: 'completed' },
      ]
    }) as { id: string }
    // no automation config set — should not error
    const updated = h.invoke('db:projects:update', {
      id: p.id,
      columnsConfig: [
        { id: 'queued', label: 'Queued', color: 'gray', position: 0, category: 'unstarted' },
        { id: 'done', label: 'Done', color: 'green', position: 1, category: 'completed' },
      ]
    }) as { task_automation_config: null }
    expect(updated.task_automation_config).toBeNull()
  })

  test('no cleanup when columns update keeps referenced statuses', () => {
    const p = h.invoke('db:projects:create', {
      name: 'StaleKeep', color: '#bb0000',
      columnsConfig: [
        { id: 'todo', label: 'Todo', color: 'blue', position: 0, category: 'unstarted' },
        { id: 'doing', label: 'Doing', color: 'yellow', position: 1, category: 'started' },
        { id: 'done', label: 'Done', color: 'green', position: 2, category: 'completed' },
      ]
    }) as { id: string }
    h.invoke('db:projects:update', {
      id: p.id,
      taskAutomationConfig: { on_terminal_active: 'doing', on_terminal_idle: 'todo' }
    })
    // Rename 'done' label but keep all IDs
    const updated = h.invoke('db:projects:update', {
      id: p.id,
      columnsConfig: [
        { id: 'todo', label: 'Todo', color: 'blue', position: 0, category: 'unstarted' },
        { id: 'doing', label: 'Doing', color: 'yellow', position: 1, category: 'started' },
        { id: 'done', label: 'Shipped', color: 'green', position: 2, category: 'completed' },
      ]
    }) as { task_automation_config: { on_terminal_active: string; on_terminal_idle: string } }
    expect(updated.task_automation_config.on_terminal_active).toBe('doing')
    expect(updated.task_automation_config.on_terminal_idle).toBe('todo')
  })
})

h.cleanup()
console.log('\nDone')
