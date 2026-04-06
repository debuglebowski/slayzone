/**
 * Task automation integration tests
 * Tests handleTerminalStateChange: auto-moves tasks based on terminal state + project config
 * Run with: tsx --loader ./packages/shared/test-utils/loader.ts packages/domains/projects/src/main/task-automation.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../../shared/test-utils/ipc-harness.js'
import { handleTerminalStateChange } from './task-automation.js'

const h = await createTestHarness()

// Seed helper: create project with automation config + custom columns
function seedProject(config: { on_terminal_active: string | null; on_terminal_idle: string | null } | null): string {
  const id = crypto.randomUUID()
  const columns = JSON.stringify([
    { id: 'todo', label: 'Todo', color: 'blue', position: 0, category: 'unstarted' },
    { id: 'in_progress', label: 'In Progress', color: 'yellow', position: 1, category: 'started' },
    { id: 'review', label: 'Review', color: 'purple', position: 2, category: 'started' },
    { id: 'done', label: 'Done', color: 'green', position: 3, category: 'completed' },
  ])
  h.db.prepare(
    "INSERT INTO projects (id, name, color, path, columns_config, task_automation_config) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, `Proj-${id.slice(0, 6)}`, '#ff0000', '/tmp/test', columns, config ? JSON.stringify(config) : null)
  return id
}

// Seed helper: create task
function seedTask(projectId: string, status = 'todo'): string {
  const id = crypto.randomUUID()
  h.db.prepare(
    'INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, 3, 0)'
  ).run(id, projectId, `Task-${id.slice(0, 6)}`, status)
  return id
}

function getStatus(taskId: string): string {
  const row = h.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }
  return row.status
}

let notifyCalls = 0
function resetNotify(): void { notifyCalls = 0 }
function notifyTasksChanged(): void { notifyCalls++ }

// --- State change triggers ---

await describe('task automation: state change triggers', () => {
  test('running triggers on_terminal_active status change', () => {
    resetNotify()
    const projId = seedProject({ on_terminal_active: 'in_progress', on_terminal_idle: null })
    const taskId = seedTask(projId, 'todo')
    handleTerminalStateChange(h.db, `${taskId}:0`, 'running', 'attention', notifyTasksChanged)
    expect(getStatus(taskId)).toBe('in_progress')
    expect(notifyCalls).toBe(1)
  })

  test('running->attention triggers on_terminal_idle status change', () => {
    resetNotify()
    const projId = seedProject({ on_terminal_active: null, on_terminal_idle: 'review' })
    const taskId = seedTask(projId, 'in_progress')
    handleTerminalStateChange(h.db, `${taskId}:0`, 'attention', 'running', notifyTasksChanged)
    expect(getStatus(taskId)).toBe('review')
    expect(notifyCalls).toBe(1)
  })

  test('both configs work in sequence (active then idle)', () => {
    resetNotify()
    const projId = seedProject({ on_terminal_active: 'in_progress', on_terminal_idle: 'review' })
    const taskId = seedTask(projId, 'todo')
    handleTerminalStateChange(h.db, `${taskId}:0`, 'running', 'attention', notifyTasksChanged)
    expect(getStatus(taskId)).toBe('in_progress')
    handleTerminalStateChange(h.db, `${taskId}:0`, 'attention', 'running', notifyTasksChanged)
    expect(getStatus(taskId)).toBe('review')
    expect(notifyCalls).toBe(2)
  })
})

// --- Non-triggering transitions ---

await describe('task automation: non-triggering state changes', () => {
  test('starting->attention does NOT trigger on_terminal_idle', () => {
    resetNotify()
    const projId = seedProject({ on_terminal_active: 'in_progress', on_terminal_idle: 'review' })
    const taskId = seedTask(projId, 'todo')
    handleTerminalStateChange(h.db, `${taskId}:0`, 'attention', 'starting', notifyTasksChanged)
    expect(getStatus(taskId)).toBe('todo')
    expect(notifyCalls).toBe(0)
  })

  test('running->error does NOT trigger anything', () => {
    resetNotify()
    const projId = seedProject({ on_terminal_active: 'in_progress', on_terminal_idle: 'review' })
    const taskId = seedTask(projId, 'in_progress')
    handleTerminalStateChange(h.db, `${taskId}:0`, 'error', 'running', notifyTasksChanged)
    expect(getStatus(taskId)).toBe('in_progress')
    expect(notifyCalls).toBe(0)
  })

  test('running->dead does NOT trigger anything', () => {
    resetNotify()
    const projId = seedProject({ on_terminal_active: 'in_progress', on_terminal_idle: 'review' })
    const taskId = seedTask(projId, 'in_progress')
    handleTerminalStateChange(h.db, `${taskId}:0`, 'dead', 'running', notifyTasksChanged)
    expect(getStatus(taskId)).toBe('in_progress')
    expect(notifyCalls).toBe(0)
  })

  test('attention->running DOES trigger on_terminal_active', () => {
    resetNotify()
    const projId = seedProject({ on_terminal_active: 'in_progress', on_terminal_idle: null })
    const taskId = seedTask(projId, 'todo')
    handleTerminalStateChange(h.db, `${taskId}:0`, 'running', 'attention', notifyTasksChanged)
    expect(getStatus(taskId)).toBe('in_progress')
  })

  test('starting->running triggers on_terminal_active', () => {
    resetNotify()
    const projId = seedProject({ on_terminal_active: 'in_progress', on_terminal_idle: null })
    const taskId = seedTask(projId, 'todo')
    handleTerminalStateChange(h.db, `${taskId}:0`, 'running', 'starting', notifyTasksChanged)
    expect(getStatus(taskId)).toBe('in_progress')
  })

  test('error->attention does NOT trigger on_terminal_idle', () => {
    resetNotify()
    const projId = seedProject({ on_terminal_active: null, on_terminal_idle: 'review' })
    const taskId = seedTask(projId, 'in_progress')
    handleTerminalStateChange(h.db, `${taskId}:0`, 'attention', 'error', notifyTasksChanged)
    expect(getStatus(taskId)).toBe('in_progress')
    expect(notifyCalls).toBe(0)
  })

  test('attention->dead does NOT trigger anything', () => {
    resetNotify()
    const projId = seedProject({ on_terminal_active: 'in_progress', on_terminal_idle: 'review' })
    const taskId = seedTask(projId, 'todo')
    handleTerminalStateChange(h.db, `${taskId}:0`, 'dead', 'attention', notifyTasksChanged)
    expect(getStatus(taskId)).toBe('todo')
    expect(notifyCalls).toBe(0)
  })
})

// --- No-op cases ---

await describe('task automation: no-op cases', () => {
  test('task already in target status is no-op', () => {
    resetNotify()
    const projId = seedProject({ on_terminal_active: 'in_progress', on_terminal_idle: null })
    const taskId = seedTask(projId, 'in_progress')
    handleTerminalStateChange(h.db, `${taskId}:0`, 'running', 'attention', notifyTasksChanged)
    expect(getStatus(taskId)).toBe('in_progress')
    expect(notifyCalls).toBe(0)
  })

  test('project with no automation config does nothing', () => {
    resetNotify()
    const projId = seedProject(null)
    const taskId = seedTask(projId, 'todo')
    handleTerminalStateChange(h.db, `${taskId}:0`, 'running', 'attention', notifyTasksChanged)
    expect(getStatus(taskId)).toBe('todo')
    expect(notifyCalls).toBe(0)
  })

  test('config field is null for relevant trigger does nothing', () => {
    resetNotify()
    const projId = seedProject({ on_terminal_active: null, on_terminal_idle: 'review' })
    const taskId = seedTask(projId, 'todo')
    // running trigger checks on_terminal_active which is null
    handleTerminalStateChange(h.db, `${taskId}:0`, 'running', 'attention', notifyTasksChanged)
    expect(getStatus(taskId)).toBe('todo')
    expect(notifyCalls).toBe(0)
  })

  test('task not found does not throw', () => {
    resetNotify()
    const projId = seedProject({ on_terminal_active: 'in_progress', on_terminal_idle: null })
    // Use a nonexistent task ID
    handleTerminalStateChange(h.db, 'nonexistent-task:0', 'running', 'attention', notifyTasksChanged)
    expect(notifyCalls).toBe(0)
  })

  test('project not found does not throw', () => {
    resetNotify()
    // Temporarily disable FK checks to insert task with nonexistent project
    h.db.pragma('foreign_keys = OFF')
    const taskId = crypto.randomUUID()
    h.db.prepare(
      'INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, 3, 0)'
    ).run(taskId, 'nonexistent-project', 'Orphan', 'todo')
    h.db.pragma('foreign_keys = ON')
    handleTerminalStateChange(h.db, `${taskId}:0`, 'running', 'attention', notifyTasksChanged)
    expect(getStatus(taskId)).toBe('todo')
    expect(notifyCalls).toBe(0)
  })
})

// --- SessionId parsing ---

await describe('task automation: sessionId parsing', () => {
  test('extracts taskId from taskId:suffix format', () => {
    resetNotify()
    const projId = seedProject({ on_terminal_active: 'in_progress', on_terminal_idle: null })
    const taskId = seedTask(projId, 'todo')
    handleTerminalStateChange(h.db, `${taskId}:0`, 'running', 'attention', notifyTasksChanged)
    expect(getStatus(taskId)).toBe('in_progress')
  })

  test('handles bare taskId (no colon)', () => {
    resetNotify()
    const projId = seedProject({ on_terminal_active: 'in_progress', on_terminal_idle: null })
    const taskId = seedTask(projId, 'todo')
    handleTerminalStateChange(h.db, taskId, 'running', 'attention', notifyTasksChanged)
    expect(getStatus(taskId)).toBe('in_progress')
  })

  test('handles sessionId with multiple colons', () => {
    resetNotify()
    const projId = seedProject({ on_terminal_active: 'in_progress', on_terminal_idle: null })
    const taskId = seedTask(projId, 'todo')
    handleTerminalStateChange(h.db, `${taskId}:sub:extra`, 'running', 'attention', notifyTasksChanged)
    expect(getStatus(taskId)).toBe('in_progress')
  })
})

// --- Edge cases ---

await describe('task automation: edge cases', () => {
  test('malformed JSON in config does not throw', () => {
    resetNotify()
    const projId = crypto.randomUUID()
    h.db.prepare(
      "INSERT INTO projects (id, name, color, path, task_automation_config) VALUES (?, ?, ?, ?, ?)"
    ).run(projId, 'BadJSON', '#ff0000', '/tmp/bad', '{not valid json')
    const taskId = seedTask(projId, 'todo')
    handleTerminalStateChange(h.db, `${taskId}:0`, 'running', 'attention', notifyTasksChanged)
    expect(getStatus(taskId)).toBe('todo')
    expect(notifyCalls).toBe(0)
  })

  test('second terminal for same task already at target status is no-op', () => {
    resetNotify()
    const projId = seedProject({ on_terminal_active: 'in_progress', on_terminal_idle: null })
    const taskId = seedTask(projId, 'todo')
    // First terminal triggers change
    handleTerminalStateChange(h.db, `${taskId}:0`, 'running', 'attention', notifyTasksChanged)
    expect(getStatus(taskId)).toBe('in_progress')
    expect(notifyCalls).toBe(1)
    // Second terminal — task already at target
    handleTerminalStateChange(h.db, `${taskId}:1`, 'running', 'attention', notifyTasksChanged)
    expect(getStatus(taskId)).toBe('in_progress')
    expect(notifyCalls).toBe(1) // no additional notification
  })
})

h.cleanup()
console.log('\nDone')
