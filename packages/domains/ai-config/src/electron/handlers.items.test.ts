/**
 * AI Config items handler contract tests
 * Run with: ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/domains/ai-config/src/main/handlers.items.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../../shared/test-utils/ipc-harness.js'
import { registerAiConfigHandlers } from './handlers.js'

const h = await createTestHarness()
registerAiConfigHandlers(h.ipcMain as never, h.db)

// Seed a project for project-scoped items
const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(projectId, 'P', '#000')

let libraryItemId: string
let projectItemId: string

describe('ai-config:create-item', () => {
  test('creates library item', () => {
    const item = h.invoke('ai-config:create-item', {
      type: 'skill', scope: 'library', slug: 'My Skill!', content: '# Skill content'
    }) as { id: string; type: string; scope: string; slug: string; name: string; content: string; project_id: null }
    expect(item.type).toBe('skill')
    expect(item.scope).toBe('library')
    expect(item.slug).toBe('my-skill')
    expect(item.name).toBe('my-skill')
    expect(item.content).toBe('# Skill content')
    expect(item.project_id).toBeNull()
    libraryItemId = item.id
  })

  test('creates project-scoped item', () => {
    const item = h.invoke('ai-config:create-item', {
      type: 'skill', scope: 'project', projectId, slug: 'deploy', content: 'run deploy'
    }) as { id: string; project_id: string; scope: string }
    expect(item.scope).toBe('project')
    expect(item.project_id).toBe(projectId)
    projectItemId = item.id
  })

  test('normalizes slug', () => {
    const item = h.invoke('ai-config:create-item', {
      type: 'skill', scope: 'library', slug: '  --Hello World!! --', content: ''
    }) as { slug: string }
    expect(item.slug).toBe('hello-world')
  })

  test('empty slug becomes untitled', () => {
    const item = h.invoke('ai-config:create-item', {
      type: 'skill', scope: 'library', slug: '!!!', content: ''
    }) as { slug: string }
    expect(item.slug).toBe('untitled')
  })

  test('rejects duplicate library slug for same type', () => {
    expect(() => h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'library',
      slug: 'my-skill',
      content: ''
    })).toThrow()
  })

  test('rejects duplicate project slug for same project and type', () => {
    expect(() => h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'project',
      projectId,
      slug: 'deploy',
      content: ''
    })).toThrow()
  })
})

describe('ai-config:get-item', () => {
  test('returns item by id', () => {
    const item = h.invoke('ai-config:get-item', libraryItemId) as { id: string }
    expect(item.id).toBe(libraryItemId)
  })

  test('returns null for nonexistent', () => {
    expect(h.invoke('ai-config:get-item', 'nope')).toBeNull()
  })
})

describe('ai-config:list-items', () => {
  test('filters by scope', () => {
    const items = h.invoke('ai-config:list-items', { scope: 'library' }) as { scope: string }[]
    for (const item of items) expect(item.scope).toBe('library')
  })

  test('filters by scope + type', () => {
    const items = h.invoke('ai-config:list-items', { scope: 'library', type: 'skill' }) as { type: string }[]
    for (const item of items) expect(item.type).toBe('skill')
    expect(items.length).toBeGreaterThan(0)
  })

  test('filters by scope + project', () => {
    const items = h.invoke('ai-config:list-items', { scope: 'project', projectId }) as { project_id: string }[]
    expect(items).toHaveLength(1)
    expect(items[0].project_id).toBe(projectId)
  })
})

describe('ai-config:update-item', () => {
  test('updates content', () => {
    const item = h.invoke('ai-config:update-item', { id: libraryItemId, content: 'updated content' }) as { content: string }
    expect(item.content).toBe('updated content')
  })

  test('updates slug (normalized)', () => {
    const item = h.invoke('ai-config:update-item', { id: libraryItemId, slug: 'New Name!!' }) as { slug: string; name: string }
    expect(item.slug).toBe('new-name')
    expect(item.name).toBe('new-name')
  })

  test('updates scope to library clears project_id', () => {
    const item = h.invoke('ai-config:update-item', { id: projectItemId, scope: 'library' }) as { scope: string; project_id: null }
    expect(item.scope).toBe('library')
    expect(item.project_id).toBeNull()
  })

  test('returns null for nonexistent', () => {
    expect(h.invoke('ai-config:update-item', { id: 'nope', content: 'x' })).toBeNull()
  })

  test('rejects update when slug collides in same scope/type', () => {
    const other = h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'library',
      slug: 'another-skill',
      content: ''
    }) as { id: string }

    expect(() => h.invoke('ai-config:update-item', {
      id: other.id,
      slug: 'new-name'
    })).toThrow()
  })
})

describe('ai-config:delete-item', () => {
  test('deletes existing', () => {
    expect(h.invoke('ai-config:delete-item', libraryItemId)).toBe(true)
    expect(h.invoke('ai-config:get-item', libraryItemId)).toBeNull()
  })

  test('returns false for nonexistent', () => {
    expect(h.invoke('ai-config:delete-item', 'nope')).toBe(false)
  })
})

h.cleanup()
console.log('\nDone')
