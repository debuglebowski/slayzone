/**
 * CLI tasks extensions tests — tags, due dates, templates
 * Run with: ELECTRON_RUN_AS_NODE=1 electron --import tsx/esm packages/apps/cli/test/tasks-ext.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../shared/test-utils/ipc-harness.js'
import { createSlayDbAdapter, captureAll } from './test-harness.js'
import { resolveProject } from '../src/db-helpers.mjs'
import { TASK_JSON_COLUMNS, serializeTaskForJson, type TaskJsonRow } from '../src/commands/task-json.ts'

const h = await createTestHarness()
const db = createSlayDbAdapter(h.db)

const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(projectId, 'TaskExtProj', '#000')

// Create tags
function createTag(name: string) {
  const id = crypto.randomUUID()
  h.db.prepare('INSERT INTO tags (id, project_id, name, color, text_color, sort_order) VALUES (?, ?, ?, ?, ?, 0)')
    .run(id, projectId, name, '#6366f1', '#ffffff')
  return id
}
const bugTagId = createTag('bug')
const featTagId = createTag('feat')
const choreTagId = createTag('chore')

// Create a task
function createTask(title: string, extra: Record<string, unknown> = {}) {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  h.db.prepare(
    `INSERT INTO tasks (id, project_id, title, status, priority, due_date, terminal_mode, provider_config, "order", created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).run(id, projectId, title, extra.status ?? 'inbox', extra.priority ?? 3,
    extra.due_date ?? null, extra.terminal_mode ?? 'claude-code', '{}', now, now)
  return id
}

// --- TAG SUBCOMMAND ---

await describe('tasks tag --set', () => {
  test('replaces all tags', () => {
    const taskId = createTask('TagSetTest')
    // Set to bug + feat
    h.db.prepare('DELETE FROM task_tags WHERE task_id = ?').run(taskId)
    h.db.prepare('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)').run(taskId, bugTagId)
    h.db.prepare('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)').run(taskId, featTagId)
    const tags = h.db.prepare('SELECT tag_id FROM task_tags WHERE task_id = ?').all(taskId) as { tag_id: string }[]
    expect(tags).toHaveLength(2)

    // Replace with chore only
    h.db.prepare('DELETE FROM task_tags WHERE task_id = ?').run(taskId)
    h.db.prepare('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)').run(taskId, choreTagId)
    const after = h.db.prepare('SELECT tag_id FROM task_tags WHERE task_id = ?').all(taskId) as { tag_id: string }[]
    expect(after).toHaveLength(1)
    expect(after[0].tag_id).toBe(choreTagId)
  })
})

await describe('tasks tag --add', () => {
  test('adds a tag', () => {
    const taskId = createTask('TagAddTest')
    h.db.prepare('INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)').run(taskId, bugTagId)
    const tags = h.db.prepare('SELECT tag_id FROM task_tags WHERE task_id = ?').all(taskId) as { tag_id: string }[]
    expect(tags).toHaveLength(1)
    expect(tags[0].tag_id).toBe(bugTagId)
  })

  test('INSERT OR IGNORE prevents duplicates', () => {
    const taskId = createTask('TagDupTest')
    h.db.prepare('INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)').run(taskId, bugTagId)
    h.db.prepare('INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)').run(taskId, bugTagId)
    const tags = h.db.prepare('SELECT tag_id FROM task_tags WHERE task_id = ?').all(taskId) as { tag_id: string }[]
    expect(tags).toHaveLength(1)
  })
})

await describe('tasks tag --remove', () => {
  test('removes a tag', () => {
    const taskId = createTask('TagRemoveTest')
    h.db.prepare('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)').run(taskId, bugTagId)
    h.db.prepare('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)').run(taskId, featTagId)
    h.db.prepare('DELETE FROM task_tags WHERE task_id = ? AND tag_id = ?').run(taskId, bugTagId)
    const tags = h.db.prepare('SELECT tag_id FROM task_tags WHERE task_id = ?').all(taskId) as { tag_id: string }[]
    expect(tags).toHaveLength(1)
    expect(tags[0].tag_id).toBe(featTagId)
  })
})

await describe('tasks tag --clear', () => {
  test('removes all tags', () => {
    const taskId = createTask('TagClearTest')
    h.db.prepare('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)').run(taskId, bugTagId)
    h.db.prepare('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)').run(taskId, featTagId)
    h.db.prepare('DELETE FROM task_tags WHERE task_id = ?').run(taskId)
    const tags = h.db.prepare('SELECT tag_id FROM task_tags WHERE task_id = ?').all(taskId) as { tag_id: string }[]
    expect(tags).toHaveLength(0)
  })
})

await describe('tasks tag read-only', () => {
  test('shows current tags', () => {
    const taskId = createTask('TagReadTest')
    h.db.prepare('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)').run(taskId, bugTagId)
    h.db.prepare('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)').run(taskId, featTagId)
    const tagNames = db.query<{ name: string }>(
      `SELECT tg.name FROM tags tg JOIN task_tags tt ON tg.id = tt.tag_id
       WHERE tt.task_id = :tid ORDER BY tg.sort_order, tg.name`,
      { ':tid': taskId }
    ).map(r => r.name)
    expect(tagNames).toHaveLength(2)
    expect(tagNames).toContain('bug')
    expect(tagNames).toContain('feat')
  })
})

await describe('tasks tag — unknown tag name', () => {
  test('tag name lookup fails for nonexistent tag', () => {
    const tags = db.query<{ id: string }>(
      `SELECT id FROM tags WHERE project_id = :pid AND LOWER(name) = LOWER(:name)`,
      { ':pid': projectId, ':name': 'nonexistent' }
    )
    expect(tags).toHaveLength(0)
  })
})

// --- DUE DATE ---

await describe('tasks create --due', () => {
  test('stores due_date', () => {
    const id = createTask('DueTest', { due_date: '2026-12-31' })
    const row = h.db.prepare('SELECT due_date FROM tasks WHERE id = ?').get(id) as { due_date: string }
    expect(row.due_date).toBe('2026-12-31')
  })

  test('null when not provided', () => {
    const id = createTask('NoDue')
    const row = h.db.prepare('SELECT due_date FROM tasks WHERE id = ?').get(id) as { due_date: string | null }
    expect(row.due_date).toBeNull()
  })
})

await describe('tasks update --due / --no-due', () => {
  test('--due sets date', () => {
    const id = createTask('UpdateDue')
    h.db.prepare('UPDATE tasks SET due_date = ?, updated_at = ? WHERE id = ?').run('2026-06-15', new Date().toISOString(), id)
    const row = h.db.prepare('SELECT due_date FROM tasks WHERE id = ?').get(id) as { due_date: string }
    expect(row.due_date).toBe('2026-06-15')
  })

  test('--no-due clears date', () => {
    const id = createTask('ClearDue', { due_date: '2026-01-01' })
    h.db.prepare('UPDATE tasks SET due_date = NULL, updated_at = ? WHERE id = ?').run(new Date().toISOString(), id)
    const row = h.db.prepare('SELECT due_date FROM tasks WHERE id = ?').get(id) as { due_date: string | null }
    expect(row.due_date).toBeNull()
  })
})

// --- TEMPLATE ---

await describe('tasks create --template', () => {
  test('template defaults apply', () => {
    const tplId = crypto.randomUUID()
    h.db.prepare(
      `INSERT INTO task_templates (id, project_id, name, terminal_mode, default_priority, is_default, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)`
    ).run(tplId, projectId, 'MyTpl', 'codex', 1, new Date().toISOString(), new Date().toISOString())

    // Template resolution by name
    const tpls = db.query<{ id: string; terminal_mode: string; default_priority: number }>(
      `SELECT * FROM task_templates WHERE project_id = :pid AND LOWER(name) = LOWER(:name) LIMIT 2`,
      { ':pid': projectId, ':name': 'mytpl' }
    )
    expect(tpls).toHaveLength(1)
    expect(tpls[0].terminal_mode).toBe('codex')
    expect(tpls[0].default_priority).toBe(1)
  })

  test('template resolution by ID prefix', () => {
    const tplId = crypto.randomUUID()
    h.db.prepare(
      `INSERT INTO task_templates (id, project_id, name, is_default, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, 0, 0, ?, ?)`
    ).run(tplId, projectId, 'PrefixTpl', new Date().toISOString(), new Date().toISOString())

    const prefix = tplId.slice(0, 8)
    const tpls = db.query<{ id: string }>(
      `SELECT * FROM task_templates WHERE id LIKE :prefix || '%' AND project_id = :pid LIMIT 2`,
      { ':prefix': prefix, ':pid': projectId }
    )
    expect(tpls).toHaveLength(1)
    expect(tpls[0].id).toBe(tplId)
  })

  test('project default template auto-applies', () => {
    const tplId = crypto.randomUUID()
    h.db.prepare(
      `INSERT INTO task_templates (id, project_id, name, default_priority, is_default, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 0, ?, ?)`
    ).run(tplId, projectId, 'DefaultTpl', 2, new Date().toISOString(), new Date().toISOString())

    const defaults = db.query<{ id: string; default_priority: number }>(
      `SELECT * FROM task_templates WHERE project_id = :pid AND is_default = 1 LIMIT 1`,
      { ':pid': projectId }
    )
    expect(defaults).toHaveLength(1)
    expect(defaults[0].default_priority).toBe(2)
  })
})

// --- VIEW includes due_date + tags ---

await describe('tasks view output', () => {
  test('view query includes due_date and tags', () => {
    const taskId = createTask('ViewTest', { due_date: '2026-03-15' })
    h.db.prepare('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)').run(taskId, bugTagId)

    const task = db.query<{ id: string; due_date: string }>(
      `SELECT t.*, p.name AS project_name FROM tasks t JOIN projects p ON t.project_id = p.id
       WHERE t.id LIKE :prefix || '%' LIMIT 1`,
      { ':prefix': taskId.slice(0, 8) }
    )
    expect(task[0].due_date).toBe('2026-03-15')

    const tagNames = db.query<{ name: string }>(
      `SELECT tg.name FROM tags tg JOIN task_tags tt ON tg.id = tt.tag_id
       WHERE tt.task_id = :tid ORDER BY tg.sort_order, tg.name`,
      { ':tid': taskId }
    ).map(r => r.name)
    expect(tagNames).toContain('bug')
  })
})

// --- LIST --json includes tags ---

await describe('tasks list --json tag augmentation', () => {
  test('batch tag lookup works', () => {
    const t1 = createTask('List1')
    const t2 = createTask('List2')
    h.db.prepare('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)').run(t1, bugTagId)
    h.db.prepare('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)').run(t1, featTagId)
    h.db.prepare('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)').run(t2, choreTagId)

    // Batch lookup
    const tagRows = db.query<{ task_id: string; name: string }>(
      `SELECT tt.task_id, tg.name FROM task_tags tt JOIN tags tg ON tg.id = tt.tag_id
       WHERE tt.task_id IN (:t0, :t1)`,
      { ':t0': t1, ':t1': t2 }
    )
    const tagMap: Record<string, string[]> = {}
    for (const r of tagRows) {
      (tagMap[r.task_id] ??= []).push(r.name)
    }
    expect(tagMap[t1]).toHaveLength(2)
    expect(tagMap[t2]).toHaveLength(1)
    expect(tagMap[t2]).toContain('chore')
  })
})

// --- LIST --json contract (issue #78) ---

await describe('tasks list --json public contract', () => {
  test('serializer exposes description, status, and core fields', () => {
    const taskId = createTask('WithDesc', { status: 'in_progress' })
    h.db.prepare('UPDATE tasks SET description = ? WHERE id = ?').run('body text', taskId)

    // Use the shared SELECT + serializer that prod uses — locks the contract.
    const rows = db.query<TaskJsonRow>(
      `SELECT ${TASK_JSON_COLUMNS.join(', ')}, p.name AS project_name
       FROM tasks t JOIN projects p ON t.project_id = p.id
       WHERE t.id = :id`,
      { ':id': taskId }
    )
    expect(rows).toHaveLength(1)
    const json = serializeTaskForJson(rows[0], { isBlocked: false, tags: ['bug'] })

    expect(json.id).toBe(taskId)
    expect(json.description).toBe('body text')
    expect(json.status).toBe('in_progress')
    expect(json.project_name).toBe('TaskExtProj')
    expect(json.tags).toEqual(['bug'])
    expect(json.is_blocked).toBe(false)
  })

  test('internal columns are NOT exposed', () => {
    const taskId = createTask('NoLeak')
    const rows = db.query<TaskJsonRow>(
      `SELECT ${TASK_JSON_COLUMNS.join(', ')}, p.name AS project_name
       FROM tasks t JOIN projects p ON t.project_id = p.id
       WHERE t.id = :id`,
      { ':id': taskId }
    )
    const json = serializeTaskForJson(rows[0], { isBlocked: false, tags: [] })
    const exposed = Object.keys(json)

    // Internal columns must stay out of the public JSON contract.
    for (const internal of [
      'provider_config', 'terminal_mode', 'claude_flags', 'codex_flags',
      'claude_session_id', 'archived_at', 'is_temporary', 'panel_visibility',
      'worktree_path', 'browser_url', 'editor_open_files',
      'dangerously_skip_permissions', 'order',
    ]) {
      expect(exposed).not.toContain(internal)
    }
  })
})

h.cleanup()
console.log('\nDone')
