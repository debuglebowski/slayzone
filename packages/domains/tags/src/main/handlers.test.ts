/**
 * Tags handler contract tests
 * Run with: npx tsx packages/domains/tags/src/main/handlers.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../../shared/test-utils/ipc-harness.js'
import { registerTagHandlers } from './handlers.js'
import type { Tag } from '@slayzone/tags/shared'

const h = await createTestHarness()
registerTagHandlers(h.ipcMain as never, h.db)

// Seed projects + task for tests
const projectId = crypto.randomUUID()
const projectId2 = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(projectId, 'P1', '#000')
h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(projectId2, 'P2', '#111')
const taskId = crypto.randomUUID()
h.db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)').run(taskId, projectId, 'T1', 'inbox', 3, 0)

describe('db:tags:create', () => {
  test('creates tag with defaults', () => {
    const tag = h.invoke('db:tags:create', { name: 'bug', projectId }) as Tag
    expect(tag.name).toBe('bug')
    expect(tag.color).toBe('#6b7280')
    expect(tag.project_id).toBe(projectId)
    expect(tag.sort_order).toBe(0)
    expect(tag.id).toBeTruthy()
  })

  test('creates tag with custom color', () => {
    const tag = h.invoke('db:tags:create', { name: 'feat', color: '#ff0000', projectId }) as Tag
    expect(tag.color).toBe('#ff0000')
    expect(tag.sort_order).toBe(1)
  })

  test('same name in different projects allowed', () => {
    const tag = h.invoke('db:tags:create', { name: 'bug', projectId: projectId2 }) as Tag
    expect(tag.name).toBe('bug')
    expect(tag.project_id).toBe(projectId2)
  })

  test('auto-increments sort_order per project', () => {
    const tag = h.invoke('db:tags:create', { name: 'chore', projectId }) as Tag
    expect(tag.sort_order).toBe(2)
  })
})

describe('db:tags:getAll', () => {
  test('returns tags ordered by sort_order', () => {
    const tags = h.invoke('db:tags:getAll') as Tag[]
    const p1Tags = tags.filter((t) => t.project_id === projectId)
    expect(p1Tags[0].name).toBe('bug')
    expect(p1Tags[1].name).toBe('feat')
    expect(p1Tags[2].name).toBe('chore')
  })
})

describe('db:tags:update', () => {
  test('updates name', () => {
    const tags = h.invoke('db:tags:getAll') as Tag[]
    const p1Tags = tags.filter((t) => t.project_id === projectId)
    const tag = h.invoke('db:tags:update', { id: p1Tags[0].id, name: 'bugfix' }) as Tag
    expect(tag.name).toBe('bugfix')
  })

  test('updates color only', () => {
    const tags = h.invoke('db:tags:getAll') as Tag[]
    const p1Tags = tags.filter((t) => t.project_id === projectId)
    const tag = h.invoke('db:tags:update', { id: p1Tags[0].id, color: '#00ff00' }) as Tag
    expect(tag.color).toBe('#00ff00')
    expect(tag.name).toBe('bugfix')
  })
})

describe('db:tags:reorder', () => {
  test('reorders tags by id array', () => {
    const tags = h.invoke('db:tags:getAll') as Tag[]
    const p1Tags = tags.filter((t) => t.project_id === projectId)
    // Reverse order
    const reversed = [...p1Tags].reverse().map((t) => t.id)
    h.invoke('db:tags:reorder', reversed)
    const after = h.invoke('db:tags:getAll') as Tag[]
    const p1After = after.filter((t) => t.project_id === projectId)
    expect(p1After[0].name).toBe('chore')
    expect(p1After[1].name).toBe('feat')
    expect(p1After[2].name).toBe('bugfix')
  })
})

describe('db:tags:delete', () => {
  test('deletes existing tag', () => {
    const tag = h.invoke('db:tags:create', { name: 'temp', projectId }) as Tag
    expect(h.invoke('db:tags:delete', tag.id)).toBe(true)
  })

  test('returns false for nonexistent', () => {
    expect(h.invoke('db:tags:delete', 'nonexistent')).toBe(false)
  })
})

describe('db:taskTags:setForTask', () => {
  test('sets tags for task (replace semantics)', () => {
    const tags = h.invoke('db:tags:getAll') as Tag[]
    const p1Tags = tags.filter((t) => t.project_id === projectId)
    h.invoke('db:taskTags:setForTask', taskId, [p1Tags[0].id, p1Tags[1].id])
    const result = h.invoke('db:taskTags:getForTask', taskId) as Tag[]
    expect(result).toHaveLength(2)
  })

  test('replaces existing tags', () => {
    const tags = h.invoke('db:tags:getAll') as Tag[]
    const p1Tags = tags.filter((t) => t.project_id === projectId)
    h.invoke('db:taskTags:setForTask', taskId, [p1Tags[0].id])
    const result = h.invoke('db:taskTags:getForTask', taskId) as Tag[]
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe(p1Tags[0].id)
  })

  test('clears all tags with empty array', () => {
    h.invoke('db:taskTags:setForTask', taskId, [])
    const result = h.invoke('db:taskTags:getForTask', taskId) as Tag[]
    expect(result).toHaveLength(0)
  })
})

h.cleanup()
console.log('\nDone')
