/**
 * Terminal tabs handler contract tests
 * Run with: ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm packages/domains/task-terminals/src/main/handlers.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../../shared/test-utils/ipc-harness.js'
import { registerTerminalTabsHandlers } from './handlers.js'

const h = await createTestHarness()
registerTerminalTabsHandlers(h.ipcMain as never, h.db)

// Seed a project + task
const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(projectId, 'P', '#000')
const taskId = crypto.randomUUID()
h.db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)').run(taskId, projectId, 'T1', 'inbox', 3, 0)

describe('tabs:ensureMain', () => {
  test('creates main tab if none exists', () => {
    const tab = h.invoke('tabs:ensureMain', taskId, 'claude-code') as { id: string; isMain: boolean; mode: string; position: number }
    expect(tab.isMain).toBe(true)
    expect(tab.mode).toBe('claude-code')
    expect(tab.position).toBe(0)
    expect(tab.id).toBe(taskId)
  })

  test('returns existing main tab (idempotent)', () => {
    const tab = h.invoke('tabs:ensureMain', taskId, 'claude-code') as { id: string; isMain: boolean }
    expect(tab.id).toBe(taskId)
    expect(tab.isMain).toBe(true)
  })

  test('updates mode if changed', () => {
    const tab = h.invoke('tabs:ensureMain', taskId, 'codex') as { mode: string }
    expect(tab.mode).toBe('codex')
  })
})

describe('tabs:list', () => {
  test('returns tabs ordered by position', () => {
    const tabs = h.invoke('tabs:list', taskId) as { position: number }[]
    expect(tabs).toHaveLength(1)
    expect(tabs[0].position).toBe(0)
  })
})

describe('tabs:create', () => {
  test('creates non-main tab with auto position', () => {
    const tab = h.invoke('tabs:create', { taskId, mode: 'terminal' }) as { isMain: boolean; position: number; label: string; mode: string }
    expect(tab.isMain).toBe(false)
    expect(tab.position).toBe(1)
    expect(tab.label).toBeNull()
    expect(tab.mode).toBe('terminal')
  })

  test('creates with custom label', () => {
    const tab = h.invoke('tabs:create', { taskId, label: 'Build', mode: 'terminal' }) as { label: string; position: number }
    expect(tab.label).toBe('Build')
    expect(tab.position).toBe(2)
  })

  test('defaults mode to terminal', () => {
    const tab = h.invoke('tabs:create', { taskId }) as { mode: string }
    expect(tab.mode).toBe('terminal')
  })
})

describe('tabs:update', () => {
  test('updates label', () => {
    const tabs = h.invoke('tabs:list', taskId) as { id: string }[]
    const nonMain = tabs.find((t: { id: string }) => t.id !== taskId)!
    const updated = h.invoke('tabs:update', { id: nonMain.id, label: 'Renamed' }) as { label: string }
    expect(updated.label).toBe('Renamed')
  })

  test('clears label back to null', () => {
    const tabs = h.invoke('tabs:list', taskId) as { id: string; label: string | null }[]
    const nonMain = tabs.find((t: { id: string }) => t.id !== taskId)!
    // Set a label first
    h.invoke('tabs:update', { id: nonMain.id, label: 'Custom' })
    // Clear it
    const updated = h.invoke('tabs:update', { id: nonMain.id, label: null }) as { label: string | null }
    expect(updated.label).toBeNull()
  })

  test('updates mode', () => {
    const tabs = h.invoke('tabs:list', taskId) as { id: string }[]
    const nonMain = tabs.find((t: { id: string }) => t.id !== taskId)!
    const updated = h.invoke('tabs:update', { id: nonMain.id, mode: 'codex' }) as { mode: string }
    expect(updated.mode).toBe('codex')
  })

  test('returns null for nonexistent', () => {
    const result = h.invoke('tabs:update', { id: 'nope' })
    expect(result).toBeNull()
  })
})

describe('tabs:delete', () => {
  test('deletes non-main tab', () => {
    const tabs = h.invoke('tabs:list', taskId) as { id: string }[]
    const nonMain = tabs.find((t: { id: string }) => t.id !== taskId)!
    expect(h.invoke('tabs:delete', nonMain.id)).toBe(true)
  })

  test('rejects deleting main tab', () => {
    expect(h.invoke('tabs:delete', taskId)).toBe(false)
  })

  test('returns false for nonexistent', () => {
    expect(h.invoke('tabs:delete', 'nope')).toBe(false)
  })
})

h.cleanup()
console.log('\nDone')
