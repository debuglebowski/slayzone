/**
 * Tags handler contract tests
 * Run with: npx tsx packages/domains/tags/src/main/handlers.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../../shared/test-utils/ipc-harness.js'
import { registerTagHandlers } from './handlers.js'

const h = await createTestHarness()
registerTagHandlers(h.ipcMain as never, h.db)

// Seed a project + task for task-tag tests
const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(projectId, 'P', '#000')
const taskId = crypto.randomUUID()
h.db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)').run(taskId, projectId, 'T1', 'inbox', 3, 0)

describe('db:tags:create', () => {
  test('creates tag with defaults', () => {
    const tag = h.invoke('db:tags:create', { name: 'bug' }) as { id: string; name: string; color: string }
    expect(tag.name).toBe('bug')
    expect(tag.color).toBe('#6b7280')
    expect(tag.id).toBeTruthy()
  })

  test('creates tag with custom color', () => {
    const tag = h.invoke('db:tags:create', { name: 'feat', color: '#ff0000' }) as { color: string }
    expect(tag.color).toBe('#ff0000')
  })
})

describe('db:tags:getAll', () => {
  test('returns tags ordered by name', () => {
    const tags = h.invoke('db:tags:getAll') as { name: string }[]
    expect(tags[0].name).toBe('bug')
    expect(tags[1].name).toBe('feat')
  })
})

describe('db:tags:update', () => {
  test('updates name', () => {
    const tags = h.invoke('db:tags:getAll') as { id: string }[]
    const tag = h.invoke('db:tags:update', { id: tags[0].id, name: 'bugfix' }) as { name: string }
    expect(tag.name).toBe('bugfix')
  })

  test('updates color only', () => {
    const tags = h.invoke('db:tags:getAll') as { id: string; name: string }[]
    const tag = h.invoke('db:tags:update', { id: tags[0].id, color: '#00ff00' }) as { color: string; name: string }
    expect(tag.color).toBe('#00ff00')
    expect(tag.name).toBe('bugfix')
  })
})

describe('db:tags:delete', () => {
  test('deletes existing tag', () => {
    const tag = h.invoke('db:tags:create', { name: 'temp' }) as { id: string }
    expect(h.invoke('db:tags:delete', tag.id)).toBe(true)
  })

  test('returns false for nonexistent', () => {
    expect(h.invoke('db:tags:delete', 'nonexistent')).toBe(false)
  })
})

describe('db:taskTags:setForTask', () => {
  test('sets tags for task (replace semantics)', () => {
    const tags = h.invoke('db:tags:getAll') as { id: string }[]
    h.invoke('db:taskTags:setForTask', taskId, [tags[0].id, tags[1].id])
    const result = h.invoke('db:taskTags:getForTask', taskId) as { id: string }[]
    expect(result).toHaveLength(2)
  })

  test('replaces existing tags', () => {
    const tags = h.invoke('db:tags:getAll') as { id: string }[]
    h.invoke('db:taskTags:setForTask', taskId, [tags[0].id])
    const result = h.invoke('db:taskTags:getForTask', taskId) as { id: string }[]
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe(tags[0].id)
  })

  test('clears all tags with empty array', () => {
    h.invoke('db:taskTags:setForTask', taskId, [])
    const result = h.invoke('db:taskTags:getForTask', taskId) as unknown[]
    expect(result).toHaveLength(0)
  })

})

h.cleanup()
console.log('\nDone')
