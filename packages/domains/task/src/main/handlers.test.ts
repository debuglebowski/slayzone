/**
 * Task handler contract tests
 * Run with: npx tsx packages/domains/task/src/main/handlers.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../../shared/test-utils/ipc-harness.js'
import { registerTaskHandlers, updateTask } from './handlers.js'
import type { Task, ProviderConfig } from '../shared/types.js'

const h = await createTestHarness()
registerTaskHandlers(h.ipcMain as never, h.db)

// Seed a project
const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(projectId, 'TestProject', '#000', '/tmp/test')

// Helper
function createTask(title: string, extra?: Record<string, unknown>): Task {
  return h.invoke('db:tasks:create', { projectId, title, ...extra }) as Task
}

// --- CRUD ---

describe('db:tasks:create', () => {
  test('creates with defaults', () => {
    const t = createTask('First task')
    expect(t.title).toBe('First task')
    expect(t.status).toBe('inbox')
    expect(t.priority).toBe(3)
    expect(t.terminal_mode).toBe('claude-code')
    expect(t.project_id).toBe(projectId)
    expect(t.archived_at).toBeNull()
    expect(t.description).toBeNull()
  })

  test('creates with custom status and priority', () => {
    const t = createTask('Custom', { status: 'todo', priority: 1 })
    expect(t.status).toBe('todo')
    expect(t.priority).toBe(1)
  })

  test('normalizes unknown create status to the project default', () => {
    const customProjectId = crypto.randomUUID()
    h.db.prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)').run(
      customProjectId,
      'CreateStatusNormalize',
      '#777',
      '/tmp/create-status-normalize',
      JSON.stringify([
        { id: 'queued', label: 'Queued', color: 'gray', position: 0, category: 'unstarted' },
        { id: 'closed', label: 'Closed', color: 'green', position: 1, category: 'completed' },
      ])
    )

    const task = h.invoke('db:tasks:create', {
      projectId: customProjectId,
      title: 'Unknown status create',
      status: 'not_real'
    }) as Task

    expect(task.status).toBe('queued')
  })

  test('builds provider_config from defaults', () => {
    const t = createTask('WithConfig')
    expect(t.provider_config['claude-code']?.flags).toBe('--allow-dangerously-skip-permissions')
    expect(t.provider_config['codex']?.flags).toBe('--full-auto --search')
  })

  test('respects custom flags override', () => {
    const t = createTask('CustomFlags', { claudeFlags: '--verbose' })
    expect(t.provider_config['claude-code']?.flags).toBe('--verbose')
    // Other providers keep defaults
    expect(t.provider_config['codex']?.flags).toBe('--full-auto --search')
  })

  test('creates with parent_id', () => {
    const parent = createTask('Parent')
    const child = createTask('Child', { parentId: parent.id })
    expect(child.parent_id).toBe(parent.id)
  })

  test('uses project-specific default status from columns config', () => {
    const customProjectId = crypto.randomUUID()
    h.db.prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)').run(
      customProjectId,
      'ColumnsProject',
      '#111',
      '/tmp/custom',
      JSON.stringify([
        { id: 'queued', label: 'Queued', color: 'gray', position: 0, category: 'unstarted' },
        { id: 'progressing', label: 'Progressing', color: 'blue', position: 1, category: 'started' },
        { id: 'closed', label: 'Closed', color: 'green', position: 2, category: 'completed' },
      ])
    )
    const task = h.invoke('db:tasks:create', {
      projectId: customProjectId,
      title: 'Project-specific default',
    }) as Task
    expect(task.status).toBe('queued')
  })

  test('falls back to inbox when project columns config is invalid', () => {
    const invalidProjectId = crypto.randomUUID()
    h.db.prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)').run(
      invalidProjectId,
      'InvalidColumns',
      '#222',
      '/tmp/invalid',
      '{"not":"a-valid-columns-array"}'
    )
    const task = h.invoke('db:tasks:create', {
      projectId: invalidProjectId,
      title: 'Fallback default status',
    }) as Task
    expect(task.status).toBe('inbox')
  })
})

describe('db:tasks:get', () => {
  test('returns task by id', () => {
    const created = createTask('GetMe')
    const t = h.invoke('db:tasks:get', created.id) as Task
    expect(t.title).toBe('GetMe')
  })

  test('returns null for nonexistent', () => {
    expect(h.invoke('db:tasks:get', 'nope')).toBeNull()
  })
})

describe('db:tasks:getAll', () => {
  test('returns all tasks', () => {
    const all = h.invoke('db:tasks:getAll') as Task[]
    expect(all.length).toBeGreaterThan(0)
  })
})

describe('db:tasks:getByProject', () => {
  test('filters by project and excludes archived', () => {
    const tasks = h.invoke('db:tasks:getByProject', projectId) as Task[]
    for (const t of tasks) {
      expect(t.project_id).toBe(projectId)
      expect(t.archived_at).toBeNull()
    }
  })
})

describe('db:tasks:getSubTasks', () => {
  test('returns children', () => {
    const parent = createTask('SubParent')
    const c1 = createTask('Child1', { parentId: parent.id })
    const c2 = createTask('Child2', { parentId: parent.id })
    const subs = h.invoke('db:tasks:getSubTasks', parent.id) as Task[]
    expect(subs).toHaveLength(2)
    const ids = subs.map(s => s.id)
    expect(ids).toContain(c1.id)
    expect(ids).toContain(c2.id)
  })
})

// --- Update ---

describe('db:tasks:update', () => {
  test('updates title', () => {
    const t = createTask('Old')
    const updated = h.invoke('db:tasks:update', { id: t.id, title: 'New' }) as Task
    expect(updated.title).toBe('New')
  })

  test('updates status', () => {
    const t = createTask('StatusTest')
    const updated = h.invoke('db:tasks:update', { id: t.id, status: 'in_progress' }) as Task
    expect(updated.status).toBe('in_progress')
  })

  test('normalizes unknown update status to the project default', () => {
    const customProjectId = crypto.randomUUID()
    h.db.prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)').run(
      customProjectId,
      'UpdateStatusNormalize',
      '#888',
      '/tmp/update-status-normalize',
      JSON.stringify([
        { id: 'queued', label: 'Queued', color: 'gray', position: 0, category: 'unstarted' },
        { id: 'closed', label: 'Closed', color: 'green', position: 1, category: 'completed' },
      ])
    )
    const task = h.invoke('db:tasks:create', {
      projectId: customProjectId,
      title: 'Unknown status update'
    }) as Task
    const updated = h.invoke('db:tasks:update', { id: task.id, status: 'ghost' }) as Task

    expect(updated.status).toBe('queued')
  })

  test('updates to custom terminal status id', () => {
    const projectWithTerminal = crypto.randomUUID()
    h.db.prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)').run(
      projectWithTerminal,
      'TerminalColumns',
      '#333',
      '/tmp/terminal',
      JSON.stringify([
        { id: 'queued', label: 'Queued', color: 'gray', position: 0, category: 'unstarted' },
        { id: 'wontfix', label: 'Wontfix', color: 'slate', position: 1, category: 'canceled' },
        { id: 'closed', label: 'Closed', color: 'green', position: 2, category: 'completed' },
      ])
    )
    const t = h.invoke('db:tasks:create', { projectId: projectWithTerminal, title: 'TerminalStatus' }) as Task
    const updated = h.invoke('db:tasks:update', { id: t.id, status: 'wontfix' }) as Task
    expect(updated.status).toBe('wontfix')
  })

  test('normalizes status when moving task to a project with different columns', () => {
    const sourceProjectId = crypto.randomUUID()
    const targetProjectId = crypto.randomUUID()
    h.db.prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)').run(
      sourceProjectId,
      'MoveSource',
      '#444',
      '/tmp/source',
      JSON.stringify([
        { id: 'queued', label: 'Queued', color: 'gray', position: 0, category: 'unstarted' },
        { id: 'doing', label: 'Doing', color: 'blue', position: 1, category: 'started' },
        { id: 'shipped', label: 'Shipped', color: 'green', position: 2, category: 'completed' },
      ])
    )
    h.db.prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)').run(
      targetProjectId,
      'MoveTarget',
      '#555',
      '/tmp/target',
      JSON.stringify([
        { id: 'triage', label: 'Triage', color: 'gray', position: 0, category: 'triage' },
        { id: 'done', label: 'Done', color: 'green', position: 1, category: 'completed' },
      ])
    )

    const task = h.invoke('db:tasks:create', {
      projectId: sourceProjectId,
      title: 'Move me',
      status: 'doing'
    }) as Task
    const updated = h.invoke('db:tasks:update', {
      id: task.id,
      projectId: targetProjectId
    }) as Task

    expect(updated.project_id).toBe(targetProjectId)
    expect(updated.status).toBe('triage')
  })

  test('no-op returns current task', () => {
    const t = createTask('NoOp')
    const same = h.invoke('db:tasks:update', { id: t.id }) as Task
    expect(same.title).toBe('NoOp')
  })

  test('provider_config deep merge - conversationId', () => {
    const t = createTask('DeepMerge')
    // Set flags first
    expect(t.provider_config['claude-code']?.flags).toBe('--allow-dangerously-skip-permissions')

    // Update only conversationId — flags should survive
    const updated = h.invoke('db:tasks:update', {
      id: t.id,
      providerConfig: { 'claude-code': { conversationId: 'abc123' } }
    }) as Task
    expect(updated.provider_config['claude-code']?.conversationId).toBe('abc123')
    expect(updated.provider_config['claude-code']?.flags).toBe('--allow-dangerously-skip-permissions')
  })

  test('provider_config deep merge - partial mode update', () => {
    const t = createTask('PartialMerge')
    // Set codex conversationId
    h.invoke('db:tasks:update', {
      id: t.id,
      providerConfig: { codex: { conversationId: 'codex-1' } }
    })
    // Update claude-code only — codex should survive
    const updated = h.invoke('db:tasks:update', {
      id: t.id,
      providerConfig: { 'claude-code': { conversationId: 'claude-1' } }
    }) as Task
    expect(updated.provider_config['codex']?.conversationId).toBe('codex-1')
    expect(updated.provider_config['claude-code']?.conversationId).toBe('claude-1')
  })

  test('legacy fields update provider_config', () => {
    const t = createTask('LegacyUpdate')
    const updated = h.invoke('db:tasks:update', {
      id: t.id,
      claudeConversationId: 'legacy-id',
      claudeFlags: '--legacy-flag'
    }) as Task
    expect(updated.provider_config['claude-code']?.conversationId).toBe('legacy-id')
    expect(updated.provider_config['claude-code']?.flags).toBe('--legacy-flag')
    // Backfilled legacy columns
    expect(updated.claude_conversation_id).toBe('legacy-id')
    expect(updated.claude_flags).toBe('--legacy-flag')
  })

  test('updates JSON columns', () => {
    const t = createTask('JSONTest')
    const visibility = { terminal: true, browser: false, diff: false, settings: false, editor: true }
    const updated = h.invoke('db:tasks:update', {
      id: t.id,
      panelVisibility: visibility
    }) as Task
    expect(updated.panel_visibility?.terminal).toBe(true)
    expect(updated.panel_visibility?.browser).toBe(false)
  })

  test('updates worktree fields', () => {
    const t = createTask('Worktree')
    const updated = h.invoke('db:tasks:update', {
      id: t.id,
      worktreePath: '/tmp/wt',
      worktreeParentBranch: 'main'
    }) as Task
    expect(updated.worktree_path).toBe('/tmp/wt')
    expect(updated.worktree_parent_branch).toBe('main')
  })
})

// --- Archive ---

describe('db:tasks:archive', () => {
  test('sets archived_at', () => {
    const t = createTask('ToArchive')
    const archived = h.invoke('db:tasks:archive', t.id) as Task
    expect(archived.archived_at).toBeTruthy()
  })

  test('clears worktree_path', () => {
    const t = createTask('WTArchive')
    h.invoke('db:tasks:update', { id: t.id, worktreePath: '/tmp/wt' })
    const archived = h.invoke('db:tasks:archive', t.id) as Task
    expect(archived.worktree_path).toBeNull()
  })

  test('cascades to sub-tasks', () => {
    const parent = createTask('ArchiveParent')
    const child = createTask('ArchiveChild', { parentId: parent.id })
    h.invoke('db:tasks:archive', parent.id)
    const childAfter = h.invoke('db:tasks:get', child.id) as Task
    expect(childAfter.archived_at).toBeTruthy()
  })
})

describe('db:tasks:archiveMany', () => {
  test('archives multiple', () => {
    const t1 = createTask('AM1')
    const t2 = createTask('AM2')
    h.invoke('db:tasks:archiveMany', [t1.id, t2.id])
    expect((h.invoke('db:tasks:get', t1.id) as Task).archived_at).toBeTruthy()
    expect((h.invoke('db:tasks:get', t2.id) as Task).archived_at).toBeTruthy()
  })

  test('no-ops on empty array', () => {
    h.invoke('db:tasks:archiveMany', [])
    // Should not throw
  })
})

describe('db:tasks:unarchive', () => {
  test('clears archived_at', () => {
    const t = createTask('Unarchive')
    h.invoke('db:tasks:archive', t.id)
    const restored = h.invoke('db:tasks:unarchive', t.id) as Task
    expect(restored.archived_at).toBeNull()
  })
})

describe('db:tasks:getArchived', () => {
  test('returns only archived tasks', () => {
    const archived = h.invoke('db:tasks:getArchived') as Task[]
    for (const t of archived) {
      expect(t.archived_at).toBeTruthy()
    }
  })
})

// --- Reorder ---

describe('db:tasks:reorder', () => {
  test('sets order column', () => {
    const t1 = createTask('R1')
    const t2 = createTask('R2')
    const t3 = createTask('R3')
    h.invoke('db:tasks:reorder', [t3.id, t1.id, t2.id])
    expect((h.invoke('db:tasks:get', t3.id) as Task).order).toBe(0)
    expect((h.invoke('db:tasks:get', t1.id) as Task).order).toBe(1)
    expect((h.invoke('db:tasks:get', t2.id) as Task).order).toBe(2)
  })
})

// --- Delete ---

describe('db:tasks:delete', () => {
  test('deletes task', () => {
    const t = createTask('ToDelete')
    expect(h.invoke('db:tasks:delete', t.id)).toBe(true)
    const deleted = h.invoke('db:tasks:get', t.id) as Task
    expect(deleted).toBeTruthy()
    expect((deleted as { deleted_at?: string | null }).deleted_at).toBeTruthy()
    const visible = h.invoke('db:tasks:getAll') as Task[]
    expect(visible.some((task) => task.id === t.id)).toBe(false)
  })

  test('returns false for nonexistent', () => {
    expect(h.invoke('db:tasks:delete', 'nope')).toBe(false)
  })
})

// --- Dependencies ---

describe('db:taskDependencies', () => {
  test('addBlocker + getBlockers', () => {
    const t1 = createTask('Blocked')
    const t2 = createTask('Blocker')
    h.invoke('db:taskDependencies:addBlocker', t1.id, t2.id)
    const blockers = h.invoke('db:taskDependencies:getBlockers', t1.id) as Task[]
    expect(blockers).toHaveLength(1)
    expect(blockers[0].id).toBe(t2.id)
  })

  test('getBlocking', () => {
    const t1 = createTask('A')
    const t2 = createTask('B')
    h.invoke('db:taskDependencies:addBlocker', t2.id, t1.id)
    const blocking = h.invoke('db:taskDependencies:getBlocking', t1.id) as Task[]
    expect(blocking).toHaveLength(1)
    expect(blocking[0].id).toBe(t2.id)
  })

  test('removeBlocker', () => {
    const t1 = createTask('X')
    const t2 = createTask('Y')
    h.invoke('db:taskDependencies:addBlocker', t1.id, t2.id)
    h.invoke('db:taskDependencies:removeBlocker', t1.id, t2.id)
    const blockers = h.invoke('db:taskDependencies:getBlockers', t1.id) as Task[]
    expect(blockers).toHaveLength(0)
  })

  test('setBlockers replaces all', () => {
    const t = createTask('Main')
    const b1 = createTask('B1')
    const b2 = createTask('B2')
    const b3 = createTask('B3')
    h.invoke('db:taskDependencies:addBlocker', t.id, b1.id)
    h.invoke('db:taskDependencies:setBlockers', t.id, [b2.id, b3.id])
    const blockers = h.invoke('db:taskDependencies:getBlockers', t.id) as Task[]
    expect(blockers).toHaveLength(2)
    const ids = blockers.map(b => b.id)
    expect(ids).toContain(b2.id)
    expect(ids).toContain(b3.id)
  })

  test('addBlocker is idempotent (INSERT OR IGNORE)', () => {
    const t1 = createTask('Idem1')
    const t2 = createTask('Idem2')
    h.invoke('db:taskDependencies:addBlocker', t1.id, t2.id)
    h.invoke('db:taskDependencies:addBlocker', t1.id, t2.id) // no-op
    const blockers = h.invoke('db:taskDependencies:getBlockers', t1.id) as Task[]
    expect(blockers).toHaveLength(1)
  })
})

h.cleanup()
console.log('\nDone')
