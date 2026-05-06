/**
 * AI Config get-project-skills-status handler contract tests
 * Run with: ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/domains/ai-config/src/main/handlers.skills-status.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../../shared/test-utils/ipc-harness.js'
import { registerAiConfigHandlers } from './handlers.js'

const h = await createTestHarness()
registerAiConfigHandlers(h.ipcMain as never, h.db)

// Seed project with a real temp dir (handler does fs ops)
const projectId = crypto.randomUUID()
const projectPath = h.tmpDir()
h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(projectId, 'TestProj', '#000', projectPath)

// Create a library skill and link it to the project
const librarySkill = h.invoke('ai-config:create-item', {
  type: 'skill', scope: 'library', slug: 'status-test',
  content: '---\nname: status-test\ndescription: test skill\n---\nbody'
}) as { id: string; scope: string; project_id: string | null }

// Link via selection
h.invoke('ai-config:set-project-selection', {
  projectId, itemId: librarySkill.id, targetPath: '.claude/skills/status-test/SKILL.md'
})

describe('ai-config:get-project-skills-status', () => {
  test('returns linked library skill with correct item fields', () => {
    const results = h.invoke('ai-config:get-project-skills-status', projectId, projectPath) as Array<{
      item: { id: string; scope: string; project_id: string | null; slug: string }
      providers: Record<string, unknown>
    }>
    expect(results.length).toBeGreaterThan(0)
    const found = results.find(r => r.item.id === librarySkill.id)
    expect(found).toBeTruthy()
    expect(found!.item.scope).toBe('library')
    expect(found!.item.slug).toBe('status-test')
  })

  test('preserves item project_id (null for library items)', () => {
    const results = h.invoke('ai-config:get-project-skills-status', projectId, projectPath) as Array<{
      item: { id: string; project_id: string | null }
    }>
    const found = results.find(r => r.item.id === librarySkill.id)
    expect(found).toBeTruthy()
    // Library items have project_id = null in ai_config_items.
    // Bug: ps.project_id was leaking into the reconstructed item.
    expect(found!.item.project_id).toBeNull()
  })

  test('returns empty for project with no linked skills', () => {
    const emptyProjectId = crypto.randomUUID()
    h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(emptyProjectId, 'Empty', '#000', '/tmp/empty')
    const results = h.invoke('ai-config:get-project-skills-status', emptyProjectId, '/tmp/empty') as unknown[]
    expect(results).toHaveLength(0)
  })

  test('project-scoped skill linked to same project preserves project_id', () => {
    const projSkill = h.invoke('ai-config:create-item', {
      type: 'skill', scope: 'project', projectId, slug: 'local-status',
      content: '---\nname: local-status\ndescription: local test\n---\nbody'
    }) as { id: string; project_id: string }
    h.invoke('ai-config:set-project-selection', {
      projectId, itemId: projSkill.id, targetPath: '.claude/skills/local-status/SKILL.md'
    })
    const results = h.invoke('ai-config:get-project-skills-status', projectId, projectPath) as Array<{
      item: { id: string; project_id: string | null }
    }>
    const found = results.find(r => r.item.id === projSkill.id)
    expect(found).toBeTruthy()
    // Project-scoped item should keep its actual project_id
    expect(found!.item.project_id).toBe(projectId)
  })
})

// --- Context tree discovery ---

import * as fs from 'node:fs'
import * as path from 'node:path'

describe('ai-config:get-context-tree discovers on-disk skills', () => {
  test('discovers unmanaged skill files in .claude/skills/', () => {
    // Create a skill file on disk that is NOT in the DB
    const skillDir = path.join(projectPath, '.claude', 'skills', 'disk-only', 'SKILL.md')
    fs.mkdirSync(path.dirname(skillDir), { recursive: true })
    fs.writeFileSync(skillDir, '---\nname: disk-only\ndescription: on disk\n---\nbody')

    const entries = h.invoke('ai-config:get-context-tree', projectPath, projectId) as Array<{
      relativePath: string; category: string; exists: boolean; linkedItemId: string | null; syncHealth: string
    }>
    const skillEntries = entries.filter(e => e.category === 'skill' && e.exists)
    const diskOnly = skillEntries.find(e => e.relativePath.includes('disk-only'))
    expect(diskOnly).toBeTruthy()
    expect(diskOnly!.linkedItemId).toBeNull()
    expect(diskOnly!.syncHealth).toBe('unmanaged')
  })

  test('linked skills show as linked in context tree', () => {
    // Write the linked skill file to disk (set-project-selection only creates DB record)
    const linkedPath = path.join(projectPath, '.claude', 'skills', 'status-test', 'SKILL.md')
    fs.mkdirSync(path.dirname(linkedPath), { recursive: true })
    fs.writeFileSync(linkedPath, '---\nname: status-test\ndescription: test skill\n---\nbody')

    const entries = h.invoke('ai-config:get-context-tree', projectPath, projectId) as Array<{
      relativePath: string; category: string; linkedItemId: string | null
    }>
    const linked = entries.find(e => e.relativePath.includes('status-test') && e.category === 'skill')
    expect(linked).toBeTruthy()
    expect(linked!.linkedItemId).toBe(librarySkill.id)
  })
})

h.cleanup()
console.log('\nDone')
