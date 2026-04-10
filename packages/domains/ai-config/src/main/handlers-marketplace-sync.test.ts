/**
 * Tests for marketplace install-skill, uninstall, and project linking.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 pnpm exec electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/domains/ai-config/src/main/handlers-marketplace-sync.test.ts
 */
import { createTestHarness, test, expect, describe, type TestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { registerAiConfigHandlers } from './handlers.js'
import * as fs from 'node:fs'
import * as path from 'node:path'

type AiConfigItem = { id: string; slug: string; scope: string; project_id: string | null; content: string; metadata_json: string }
type ListEntry = { id: string; installed: boolean; installed_global_item_id: string | null; installed_project_item_id: string | null; has_update: boolean }

function seedProject(h: TestHarness, providers: string[] = ['claude']) {
  const projectId = crypto.randomUUID()
  const projectPath = h.tmpDir()
  h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(projectId, 'TestProj', '#000', projectPath)
  h.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
    `ai_providers:${projectId}`, JSON.stringify(providers)
  )
  return { projectId, projectPath }
}

// ---------------------------------------------------------------------------
// install to library (global) and project are independent
// ---------------------------------------------------------------------------

const h1 = await createTestHarness()
registerAiConfigHandlers(h1.ipcMain as never, h1.db)
const p1 = seedProject(h1)

const entry1 = h1.db.prepare(`
  SELECT id, slug FROM skill_registry_entries WHERE registry_id = 'builtin-slayzone' LIMIT 1
`).get() as { id: string; slug: string }

describe('library and project installs are independent', () => {
  test('install to library creates global item', () => {
    const item = h1.invoke('ai-config:marketplace:install-skill', {
      entryId: entry1.id, scope: 'global'
    }) as AiConfigItem
    expect(item.scope).toBe('global')
    expect(item.project_id).toBeNull()
  })

  test('install to project creates separate project item', () => {
    const item = h1.invoke('ai-config:marketplace:install-skill', {
      entryId: entry1.id, scope: 'project', projectId: p1.projectId
    }) as AiConfigItem
    expect(item.scope).toBe('project')
    expect(item.project_id).toBe(p1.projectId)
  })

  test('list-entries shows both scopes independently', () => {
    const entries = h1.invoke('ai-config:marketplace:list-entries', { projectId: p1.projectId }) as ListEntry[]
    const entry = entries.find(e => e.id === entry1.id)
    expect(entry).toBeTruthy()
    expect(entry!.installed_global_item_id).toBeTruthy()
    expect(entry!.installed_project_item_id).toBeTruthy()
  })

  test('removing from library does not affect project', () => {
    const entries = h1.invoke('ai-config:marketplace:list-entries', { projectId: p1.projectId }) as ListEntry[]
    const entry = entries.find(e => e.id === entry1.id)!
    h1.invoke('ai-config:delete-item', entry.installed_global_item_id!)

    const after = h1.invoke('ai-config:marketplace:list-entries', { projectId: p1.projectId }) as ListEntry[]
    const updated = after.find(e => e.id === entry1.id)!
    expect(updated.installed_global_item_id).toBeNull()
    expect(updated.installed_project_item_id).toBeTruthy()
  })

  test('removing from project does not affect library', () => {
    // Re-install to library
    h1.invoke('ai-config:marketplace:install-skill', { entryId: entry1.id, scope: 'global' })

    const entries = h1.invoke('ai-config:marketplace:list-entries', { projectId: p1.projectId }) as ListEntry[]
    const entry = entries.find(e => e.id === entry1.id)!
    h1.invoke('ai-config:delete-item', entry.installed_project_item_id!)

    const after = h1.invoke('ai-config:marketplace:list-entries', { projectId: p1.projectId }) as ListEntry[]
    const updated = after.find(e => e.id === entry1.id)!
    expect(updated.installed_global_item_id).toBeTruthy()
    expect(updated.installed_project_item_id).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// idempotent per scope
// ---------------------------------------------------------------------------

const h2 = await createTestHarness()
registerAiConfigHandlers(h2.ipcMain as never, h2.db)
const p2 = seedProject(h2)

const entry2 = h2.db.prepare(`
  SELECT id, slug FROM skill_registry_entries WHERE registry_id = 'builtin-slayzone' LIMIT 1
`).get() as { id: string; slug: string }

describe('install is idempotent per scope', () => {
  test('double global install returns same item', () => {
    const first = h2.invoke('ai-config:marketplace:install-skill', { entryId: entry2.id, scope: 'global' }) as AiConfigItem
    const second = h2.invoke('ai-config:marketplace:install-skill', { entryId: entry2.id, scope: 'global' }) as AiConfigItem
    expect(second.id).toBe(first.id)
  })

  test('double project install returns same item', () => {
    const first = h2.invoke('ai-config:marketplace:install-skill', { entryId: entry2.id, scope: 'project', projectId: p2.projectId }) as AiConfigItem
    const second = h2.invoke('ai-config:marketplace:install-skill', { entryId: entry2.id, scope: 'project', projectId: p2.projectId }) as AiConfigItem
    expect(second.id).toBe(first.id)
  })
})

// ---------------------------------------------------------------------------
// uninstall cascades to project selections
// ---------------------------------------------------------------------------

const h3 = await createTestHarness()
registerAiConfigHandlers(h3.ipcMain as never, h3.db)
const p3 = seedProject(h3)

const entry3 = h3.db.prepare(`
  SELECT id, slug FROM skill_registry_entries WHERE registry_id = 'builtin-slayzone' LIMIT 1
`).get() as { id: string; slug: string }

describe('uninstall via delete-item', () => {
  test('delete-item cascades to project selections', () => {
    const item = h3.invoke('ai-config:marketplace:install-skill', { entryId: entry3.id, scope: 'global' }) as AiConfigItem
    const providers = h3.invoke('ai-config:get-project-providers', p3.projectId) as string[]
    h3.invoke('ai-config:load-global-item', { projectId: p3.projectId, projectPath: p3.projectPath, itemId: item.id, providers })

    const selections = h3.invoke('ai-config:list-project-selections', p3.projectId) as { item_id: string }[]
    expect(selections.length > 0).toBe(true)

    h3.invoke('ai-config:delete-item', item.id)

    const after = h3.invoke('ai-config:list-project-selections', p3.projectId) as { item_id: string }[]
    expect(after.find(s => s.item_id === item.id)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// project install + sync writes files
// ---------------------------------------------------------------------------

const h4 = await createTestHarness()
registerAiConfigHandlers(h4.ipcMain as never, h4.db)
const p4 = seedProject(h4, ['claude', 'cursor'])

const entry4 = h4.db.prepare(`
  SELECT id, slug FROM skill_registry_entries WHERE registry_id = 'builtin-slayzone' LIMIT 1
`).get() as { id: string; slug: string }

describe('project install + sync writes files', () => {
  test('sync-linked-file writes to all enabled providers', () => {
    const item = h4.invoke('ai-config:marketplace:install-skill', {
      entryId: entry4.id, scope: 'project', projectId: p4.projectId
    }) as AiConfigItem

    h4.invoke('ai-config:sync-linked-file', p4.projectId, p4.projectPath, item.id)

    expect(fs.existsSync(path.join(p4.projectPath, '.claude', 'skills', entry4.slug, 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(p4.projectPath, '.cursor', 'skills', entry4.slug, 'SKILL.md'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// list-entries without projectId shows only library state
// ---------------------------------------------------------------------------

const h5 = await createTestHarness()
registerAiConfigHandlers(h5.ipcMain as never, h5.db)
const p5 = seedProject(h5)

const entry5 = h5.db.prepare(`
  SELECT id, slug FROM skill_registry_entries WHERE registry_id = 'builtin-slayzone' LIMIT 1
`).get() as { id: string; slug: string }

describe('list-entries without projectId', () => {
  test('project-only install not visible without projectId', () => {
    h5.invoke('ai-config:marketplace:install-skill', { entryId: entry5.id, scope: 'project', projectId: p5.projectId })

    const entries = h5.invoke('ai-config:marketplace:list-entries') as ListEntry[]
    const entry = entries.find(e => e.id === entry5.id)!
    expect(entry.installed_global_item_id).toBeNull()
    expect(entry.installed_project_item_id).toBeNull()
  })

  test('global install visible without projectId', () => {
    h5.invoke('ai-config:marketplace:install-skill', { entryId: entry5.id, scope: 'global' })

    const entries = h5.invoke('ai-config:marketplace:list-entries') as ListEntry[]
    const entry = entries.find(e => e.id === entry5.id)!
    expect(entry.installed_global_item_id).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// slug conflict — pre-existing item with same slug doesn't crash
// ---------------------------------------------------------------------------

const h6 = await createTestHarness()
registerAiConfigHandlers(h6.ipcMain as never, h6.db)
const p6 = seedProject(h6)

const entry6 = h6.db.prepare(`
  SELECT id, slug FROM skill_registry_entries WHERE registry_id = 'builtin-slayzone' LIMIT 1
`).get() as { id: string; slug: string }

describe('slug conflict returns existing item', () => {
  test('project install with pre-existing slug returns existing item', () => {
    // Create a non-marketplace item with the same slug
    const existingId = crypto.randomUUID()
    h6.db.prepare(`
      INSERT INTO ai_config_items (id, type, scope, project_id, name, slug, content, metadata_json, created_at, updated_at)
      VALUES (?, 'skill', 'project', ?, ?, ?, '# existing', '{}', datetime('now'), datetime('now'))
    `).run(existingId, p6.projectId, entry6.slug, entry6.slug)

    const item = h6.invoke('ai-config:marketplace:install-skill', {
      entryId: entry6.id, scope: 'project', projectId: p6.projectId
    }) as AiConfigItem
    expect(item.id).toBe(existingId)
  })

  test('global install with pre-existing slug returns existing item', () => {
    const existingId = crypto.randomUUID()
    h6.db.prepare(`
      INSERT INTO ai_config_items (id, type, scope, project_id, name, slug, content, metadata_json, created_at, updated_at)
      VALUES (?, 'skill', 'global', NULL, ?, ?, '# existing', '{}', datetime('now'), datetime('now'))
    `).run(existingId, entry6.slug + '-global-test', entry6.slug + '-global-test')

    const entry6b = h6.db.prepare(`
      SELECT id, slug FROM skill_registry_entries WHERE registry_id = 'builtin-slayzone' AND slug = ?
    `).get(entry6.slug + '-global-test') as { id: string; slug: string } | undefined

    // If no matching registry entry with that slug, test the conflict directly
    // by using a registry entry whose slug matches the pre-existing item
    // For this test, we'll rename the existing item to match a known registry entry
    const entry6c = h6.db.prepare(`
      SELECT id, slug FROM skill_registry_entries WHERE registry_id = 'builtin-slayzone' LIMIT 1 OFFSET 1
    `).get() as { id: string; slug: string }

    h6.db.prepare(`UPDATE ai_config_items SET slug = ?, name = ? WHERE id = ?`).run(entry6c.slug, entry6c.slug, existingId)

    const item = h6.invoke('ai-config:marketplace:install-skill', {
      entryId: entry6c.id, scope: 'global'
    }) as AiConfigItem
    expect(item.id).toBe(existingId)
  })
})

h1.cleanup()
h2.cleanup()
h3.cleanup()
h4.cleanup()
h5.cleanup()
h6.cleanup()
console.log('\nDone')
