/**
 * Projects handler contract tests
 * Run with: npx tsx packages/domains/projects/src/main/handlers.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../../shared/test-utils/ipc-harness.js'
import { registerProjectHandlers } from './handlers.js'

const h = await createTestHarness()
registerProjectHandlers(h.ipcMain as never, h.db)

describe('db:projects:create', () => {
  test('creates with defaults', () => {
    const p = h.invoke('db:projects:create', { name: 'Alpha', color: '#ff0000' }) as {
      id: string
      name: string
      color: string
      path: null
      task_storage: string
    }
    expect(p.name).toBe('Alpha')
    expect(p.color).toBe('#ff0000')
    expect(p.path).toBeNull()
    expect(p.task_storage).toBe('database')
    expect(p.id).toBeTruthy()
  })

  test('creates with path', () => {
    const p = h.invoke('db:projects:create', { name: 'Beta', color: '#00f', path: '/tmp/beta' }) as { path: string }
    expect(p.path).toBe('/tmp/beta')
  })

  test('creates with repository task storage', () => {
    const p = h.invoke('db:projects:create', {
      name: 'Repo',
      color: '#0f0',
      path: '/tmp/repo',
      taskStorage: 'repository'
    }) as { task_storage: string }
    expect(p.task_storage).toBe('repository')
  })
})

describe('db:projects:getAll', () => {
  test('returns projects ordered by name', () => {
    const all = h.invoke('db:projects:getAll') as { name: string }[]
    expect(all[0].name).toBe('Alpha')
    expect(all[1].name).toBe('Beta')
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

  test('updates task storage mode', () => {
    const all = h.invoke('db:projects:getAll') as { id: string }[]
    const p = h.invoke('db:projects:update', { id: all[0].id, taskStorage: 'repository' }) as {
      task_storage: string
    }
    expect(p.task_storage).toBe('repository')
  })
})

describe('db:projects:delete', () => {
  test('deletes existing', () => {
    const p = h.invoke('db:projects:create', { name: 'Temp', color: '#000' }) as { id: string }
    expect(h.invoke('db:projects:delete', p.id)).toBe(true)
  })

  test('returns false for nonexistent', () => {
    expect(h.invoke('db:projects:delete', 'nope')).toBe(false)
  })
})

h.cleanup()
console.log('\nDone')
