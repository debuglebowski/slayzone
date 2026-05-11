/**
 * Run with: ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/domains/task/src/server/attention.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../../shared/test-utils/ipc-harness.js'
import { handleAttentionTransition } from './attention.js'
import { parseTask, updateTask } from './ops/shared.js'

const h = await createTestHarness()

const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'AttnProject', '#abc', '/tmp/attn')

function seedTask(): string {
  const id = crypto.randomUUID()
  h.db.prepare(
    'INSERT INTO tasks (id, project_id, title, status, priority, terminal_mode, provider_config) VALUES (?, ?, ?, ?, 3, ?, ?)'
  ).run(id, projectId, `attn-${id.slice(0, 6)}`, 'todo', 'claude-code', '{}')
  return id
}

function readFlag(id: string): number {
  const row = h.db.prepare('SELECT needs_attention FROM tasks WHERE id = ?').get(id) as
    | { needs_attention: number }
    | undefined
  return row?.needs_attention ?? -1
}

describe('needs_attention', () => {
  test('column exists in schema', () => {
    const cols = h.db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]
    expect(cols.some((c) => c.name === 'needs_attention')).toBe(true)
  })

  test('defaults to 0 on insert', () => {
    const id = seedTask()
    expect(readFlag(id)).toBe(0)
  })

  test('parseTask round-trips the flag from DB', () => {
    const id = seedTask()
    h.db.prepare('UPDATE tasks SET needs_attention = 1 WHERE id = ?').run(id)
    const row = h.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown>
    const parsed = parseTask(row)
    expect(parsed?.needs_attention).toBe(true)
  })

  test('updateTask writes true then false', () => {
    const id = seedTask()
    updateTask(h.db, { id, needsAttention: true })
    expect(readFlag(id)).toBe(1)
    updateTask(h.db, { id, needsAttention: false })
    expect(readFlag(id)).toBe(0)
  })

  test('handleAttentionTransition sets flag on running -> idle WITH user input', () => {
    const id = seedTask()
    const set = handleAttentionTransition(h.db, id, 'idle', 'running', true)
    expect(set).toBe(true)
    expect(readFlag(id)).toBe(1)
  })

  test('handleAttentionTransition sets flag on running -> error WITH user input', () => {
    const id = seedTask()
    const set = handleAttentionTransition(h.db, id, 'error', 'running', true)
    expect(set).toBe(true)
    expect(readFlag(id)).toBe(1)
  })

  test('handleAttentionTransition does NOT set on running -> idle WITHOUT user input', () => {
    const id = seedTask()
    const set = handleAttentionTransition(h.db, id, 'idle', 'running', false)
    expect(set).toBe(false)
    expect(readFlag(id)).toBe(0)
  })

  test('handleAttentionTransition does NOT set on running -> error WITHOUT user input', () => {
    const id = seedTask()
    const set = handleAttentionTransition(h.db, id, 'error', 'running', false)
    expect(set).toBe(false)
    expect(readFlag(id)).toBe(0)
  })

  test('handleAttentionTransition does NOT set on starting -> idle', () => {
    const id = seedTask()
    const set = handleAttentionTransition(h.db, id, 'idle', 'starting', true)
    expect(set).toBe(false)
    expect(readFlag(id)).toBe(0)
  })

  test('handleAttentionTransition does NOT set on running -> dead', () => {
    const id = seedTask()
    const set = handleAttentionTransition(h.db, id, 'dead', 'running', true)
    expect(set).toBe(false)
    expect(readFlag(id)).toBe(0)
  })

  test('handleAttentionTransition is no-op when flag already set', () => {
    const id = seedTask()
    h.db.prepare('UPDATE tasks SET needs_attention = 1 WHERE id = ?').run(id)
    const set = handleAttentionTransition(h.db, id, 'idle', 'running', true)
    expect(set).toBe(false)
  })

  test('handleAttentionTransition strips tab suffix from sessionId', () => {
    const id = seedTask()
    const set = handleAttentionTransition(h.db, `${id}:tab1`, 'idle', 'running', true)
    expect(set).toBe(true)
    expect(readFlag(id)).toBe(1)
  })

  test('handleAttentionTransition no-op for unknown task', () => {
    const set = handleAttentionTransition(h.db, 'no-such-task', 'idle', 'running', true)
    expect(set).toBe(false)
  })

  test('handleAttentionTransition clears flag on idle -> running', () => {
    const id = seedTask()
    h.db.prepare('UPDATE tasks SET needs_attention = 1 WHERE id = ?').run(id)
    const changed = handleAttentionTransition(h.db, id, 'running', 'idle', false)
    expect(changed).toBe(true)
    expect(readFlag(id)).toBe(0)
  })

  test('handleAttentionTransition clears flag on error -> running', () => {
    const id = seedTask()
    h.db.prepare('UPDATE tasks SET needs_attention = 1 WHERE id = ?').run(id)
    const changed = handleAttentionTransition(h.db, id, 'running', 'error', true)
    expect(changed).toBe(true)
    expect(readFlag(id)).toBe(0)
  })

  test('handleAttentionTransition no-op on -> running when flag clear', () => {
    const id = seedTask()
    const changed = handleAttentionTransition(h.db, id, 'running', 'idle', true)
    expect(changed).toBe(false)
    expect(readFlag(id)).toBe(0)
  })
})

h.cleanup()
