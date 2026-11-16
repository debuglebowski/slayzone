/**
 * MCP: update_task tool tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run --config packages/shared/test-utils/vitest.harness.config.ts packages/apps/api/src/http/mcp-tools/update-task.test.ts
 *
 * Note: Wave 5 audit found update-task.ts only passes `{ ipcMain }` to
 * updateTaskOp (no onMutation), then calls deps.notifyRenderer() manually.
 * This means notifyRenderer fires once (not twice like sibling tools).
 */
import { afterAll, describe, expect, test } from 'vitest'
import { createTestHarness } from '../../../../../shared/test-utils/ipc-harness.js'
import { captureMcpServer } from '../../../../../shared/test-utils/mcp-harness.js'
import { spyTaskEvents } from '../../../../../shared/test-utils/event-spy.js'
import {
  ipcMain,
  __ipcEmitCalls,
  __resetIpcEmitCalls
} from '../../../../../shared/test-utils/mock-electron.js'
import { taskEvents, configureTaskRuntimeAdapters } from '@slayzone/task/server'
import { tmpdir } from 'node:os'
import { registerUpdateTaskTool } from './update-task.js'

const h = await createTestHarness()
// archive/cleanup ops resolve the data root via the task runtime adapter.
configureTaskRuntimeAdapters({ getDataRoot: () => tmpdir() })
const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'P', '#000', '/tmp/p')

let notifyCount = 0
/** Session ids the stub reports mid-reply, per task. */
const midReply = new Map<string, string[]>()
const stub = captureMcpServer()
registerUpdateTaskTool(stub.server as never, {
  db: h.slayDb,
  taskBus: ipcMain,
  notifyRenderer: () => {
    notifyCount++
  },
  taskAgents: { midReplySessionIds: async (taskId) => midReply.get(taskId) ?? [] }
})

function seedTask(extra: Record<string, unknown> = {}): string {
  const id = crypto.randomUUID()
  const status = (extra.status as string) ?? 'todo'
  h.db
    .prepare(
      'INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(id, projectId, 'T', status, 3, 0)
  return id
}

describe('mcp update_task', () => {
  test('register: tool registered with description + schema', () => {
    expect(stub.has('update_task')).toBe(true)
    const tool = stub.get('update_task')!
    expect(tool.name).toBe('update_task')
    expect(tool.description.length).toBeGreaterThan(0)
    expect('task_id' in tool.schema).toBe(true)
    expect('parent_id' in tool.schema).toBe(true)
    expect('due_date' in tool.schema).toBe(true)
  })

  test('a terminal status while an agent is mid-reply is refused, nothing written; force completes', async () => {
    const id = seedTask()
    midReply.set(id, [`${id}:${id}`])
    try {
      for (const status of ['done', 'canceled']) {
        const res = (await stub.invoke('update_task', { task_id: id, status, title: 'x' })) as {
          content: { text: string }[]
          isError?: boolean
        }
        expect(res.isError).toBe(true)
        expect(res.content[0].text).toContain('mid-reply')
        expect(res.content[0].text).toContain('force: true')
      }
      expect(h.db.prepare('SELECT status, title FROM tasks WHERE id = ?').get(id)).toEqual({
        status: 'todo',
        title: 'T'
      })
      const forced = (await stub.invoke('update_task', {
        task_id: id,
        status: 'done',
        force: true
      })) as { content: { text: string }[]; isError?: boolean }
      expect(forced.isError === true).toBe(false)
      expect((JSON.parse(forced.content[0].text) as { status: string }).status).toBe('done')
    } finally {
      midReply.delete(id)
    }
  })

  test('a non-terminal status is never blocked by a mid-reply agent', async () => {
    const id = seedTask()
    midReply.set(id, [`${id}:${id}`])
    try {
      const res = (await stub.invoke('update_task', { task_id: id, status: 'in_progress' })) as {
        content: { text: string }[]
        isError?: boolean
      }
      expect(res.isError === true).toBe(false)
    } finally {
      midReply.delete(id)
    }
  })

  test('happy: updates title; emits dual signals; notifyRenderer fires', async () => {
    const id = seedTask()
    __resetIpcEmitCalls()
    const spy = spyTaskEvents(taskEvents, 'task:updated')
    notifyCount = 0
    const res = (await stub.invoke('update_task', { task_id: id, title: 'Renamed' })) as {
      content: { text: string }[]
      isError?: boolean
    }
    spy.stop()
    expect(res.isError === true).toBe(false)
    const parsed = JSON.parse(res.content[0].text) as { id: string; title: string }
    expect(parsed.title).toBe('Renamed')
    const row = h.db.prepare('SELECT title FROM tasks WHERE id = ?').get(id) as { title: string }
    expect(row.title).toBe('Renamed')
    expect(spy.calls.length).toBe(1)
    const updateEmits = __ipcEmitCalls.filter((c) => c[0] === 'db:tasks:update:done')
    expect(updateEmits.length).toBeGreaterThanOrEqual(1)
    expect(notifyCount).toBeGreaterThanOrEqual(1)
  })

  test('camelCase mapping: due_date → dueDate, parent_id → parentId', async () => {
    const id = seedTask()
    const parent = seedTask()
    const res = (await stub.invoke('update_task', {
      task_id: id,
      due_date: '2030-01-01',
      parent_id: parent
    })) as { content: { text: string }[]; isError?: boolean }
    expect(res.isError === true).toBe(false)
    const row = h.db.prepare('SELECT due_date, parent_id FROM tasks WHERE id = ?').get(id) as {
      due_date: string
      parent_id: string
    }
    expect(row.due_date).toBe('2030-01-01')
    expect(row.parent_id).toBe(parent)
  })

  test('status validation: rejects unknown status against project columns', async () => {
    const id = seedTask()
    const res = (await stub.invoke('update_task', { task_id: id, status: 'totally_made_up' })) as {
      content: { text: string }[]
      isError?: boolean
    }
    expect(res.isError).toBe(true)
    expect(res.content[0].text.includes('Allowed statuses')).toBe(true)
  })

  test('error: 404 when task missing (status path probe)', async () => {
    const ghost = crypto.randomUUID()
    const res = (await stub.invoke('update_task', { task_id: ghost, status: 'todo' })) as {
      content: { text: string }[]
      isError?: boolean
    }
    expect(res.isError).toBe(true)
    expect(res.content[0].text.includes('not found')).toBe(true)
  })

  test('error: 404 when task missing (no-status path)', async () => {
    const ghost = crypto.randomUUID()
    const res = (await stub.invoke('update_task', { task_id: ghost, title: 'x' })) as {
      content: { text: string }[]
      isError?: boolean
    }
    expect(res.isError).toBe(true)
    expect(res.content[0].text.includes('not found')).toBe(true)
  })

  test('takes the task id only — no session id argument, no mention of one', () => {
    const tool = stub.get('update_task')!
    expect('session_id' in tool.schema).toBe(false)
    expect(tool.description.includes('SESSION_ID')).toBe(false)
  })

  test('no task_id → isError', async () => {
    const res = (await stub.invoke('update_task', { title: 'x' })) as {
      content: { text: string }[]
      isError?: boolean
    }
    expect(res.isError).toBe(true)
  })
})

afterAll(() => h.cleanup())
