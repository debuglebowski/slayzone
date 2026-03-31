/**
 * CLI tags command tests
 * Run with: ELECTRON_RUN_AS_NODE=1 electron --import tsx/esm packages/apps/cli/test/tags.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../shared/test-utils/ipc-harness.js'
import { createSlayDbAdapter, captureAll } from './test-harness.js'
import { resolveProject } from '../src/db-helpers.mjs'
import type Database from 'better-sqlite3'

const h = await createTestHarness()
const db = createSlayDbAdapter(h.db)

const projectId = crypto.randomUUID()
const projectId2 = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(projectId, 'TagsProj', '#000')
h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(projectId2, 'OtherProj', '#111')

// --- helpers that mirror the CLI tag SQL ---
function createTag(name: string, pid: string, color = '#6366f1', textColor = '#ffffff') {
  const id = crypto.randomUUID()
  const nextOrder = (h.db.prepare(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM tags WHERE project_id = ?`
  ).get(pid) as { n: number }).n
  h.db.prepare(
    `INSERT INTO tags (id, project_id, name, color, text_color, sort_order) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, pid, name, color, textColor, nextOrder)
  return { id, name }
}

function listTags(pid: string) {
  return db.query<{ id: string; name: string; color: string; sort_order: number }>(
    `SELECT * FROM tags WHERE project_id = :pid ORDER BY sort_order, name`,
    { ':pid': pid }
  )
}

describe('tags create', () => {
  test('creates with defaults', () => {
    const tag = createTag('bug', projectId)
    const row = h.db.prepare('SELECT * FROM tags WHERE id = ?').get(tag.id) as Record<string, unknown>
    expect(row.color).toBe('#6366f1')
    expect(row.text_color).toBe('#ffffff')
    expect(row.sort_order).toBe(0)
  })

  test('creates with custom color', () => {
    const tag = createTag('feat', projectId, '#ff0000')
    const row = h.db.prepare('SELECT * FROM tags WHERE id = ?').get(tag.id) as Record<string, unknown>
    expect(row.color).toBe('#ff0000')
  })

  test('auto-increments sort_order', () => {
    const tag = createTag('chore', projectId)
    const row = h.db.prepare('SELECT * FROM tags WHERE id = ?').get(tag.id) as Record<string, unknown>
    expect(row.sort_order).toBe(2)
  })

  test('same name in different projects', () => {
    const tag = createTag('bug', projectId2)
    expect(tag.name).toBe('bug')
  })
})

describe('tags list', () => {
  test('lists tags ordered by sort_order', () => {
    const tags = listTags(projectId)
    expect(tags).toHaveLength(3)
    expect(tags[0].name).toBe('bug')
    expect(tags[1].name).toBe('feat')
    expect(tags[2].name).toBe('chore')
  })

  test('empty project returns empty', () => {
    const emptyPid = crypto.randomUUID()
    h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(emptyPid, 'EmptyP', '#222')
    expect(listTags(emptyPid)).toHaveLength(0)
  })
})

describe('tags delete', () => {
  test('deletes by id', () => {
    const tag = createTag('temp', projectId)
    h.db.prepare('DELETE FROM tags WHERE id = ?').run(tag.id)
    const row = h.db.prepare('SELECT * FROM tags WHERE id = ?').get(tag.id)
    expect(row).toBeUndefined()
  })

  test('cascade cleans task_tags', () => {
    const tag = createTag('cascade-test', projectId)
    const taskId = crypto.randomUUID()
    h.db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)').run(taskId, projectId, 'T1', 'inbox', 3, 0)
    h.db.prepare('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)').run(taskId, tag.id)
    h.db.prepare('DELETE FROM tags WHERE id = ?').run(tag.id)
    const ttRow = h.db.prepare('SELECT * FROM task_tags WHERE tag_id = ?').get(tag.id)
    expect(ttRow).toBeUndefined()
  })
})

h.cleanup()
console.log('\nDone')
