/**
 * MCP: update_task tool tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/apps/app/src/main/mcp-tools/update-task.test.ts
 *
 * Note: Wave 5 audit found update-task.ts only passes `{ ipcMain }` to
 * updateTaskOp (no onMutation), then calls deps.notifyRenderer() manually.
 * This means notifyRenderer fires once (not twice like sibling tools).
 */
import { createTestHarness, test, expect, describe } from '../../../../../shared/test-utils/ipc-harness.js'
import { captureMcpServer } from '../../../../../shared/test-utils/mcp-harness.js'
import { spyTaskEvents } from '../../../../../shared/test-utils/event-spy.js'
import { __ipcEmitCalls, __resetIpcEmitCalls } from '../../../../../shared/test-utils/mock-electron.js'
import { taskEvents } from '@slayzone/task/main'
import { registerUpdateTaskTool } from './update-task.js'

const h = await createTestHarness()
const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(projectId, 'P', '#000', '/tmp/p')

let notifyCount = 0
const stub = captureMcpServer()
registerUpdateTaskTool(stub.server as never, { db: h.db, notifyRenderer: () => { notifyCount++ } })

function seedTask(extra: Record<string, unknown> = {}): string {
  const id = crypto.randomUUID()
  const status = (extra.status as string) ?? 'todo'
  h.db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, projectId, 'T', status, 3, 0)
  return id
}

await describe('mcp update_task', () => {
  test('register: tool registered with description + schema', () => {
    expect(stub.has('update_task')).toBe(true)
    const tool = stub.get('update_task')!
    expect(tool.name).toBe('update_task')
    expect(tool.description.length).toBeGreaterThan(0)
    expect('task_id' in tool.schema).toBe(true)
    expect('parent_id' in tool.schema).toBe(true)
    expect('due_date' in tool.schema).toBe(true)
  })

  test('happy: updates title; emits dual signals; notifyRenderer fires', async () => {
    const id = seedTask()
    __resetIpcEmitCalls()
    const spy = spyTaskEvents(taskEvents, 'task:updated')
    notifyCount = 0
    const res = await stub.invoke('update_task', { task_id: id, title: 'Renamed' }) as { content: { text: string }[]; isError?: boolean }
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
    const res = await stub.invoke('update_task', { task_id: id, due_date: '2030-01-01', parent_id: parent }) as { content: { text: string }[]; isError?: boolean }
    expect(res.isError === true).toBe(false)
    const row = h.db.prepare('SELECT due_date, parent_id FROM tasks WHERE id = ?').get(id) as { due_date: string; parent_id: string }
    expect(row.due_date).toBe('2030-01-01')
    expect(row.parent_id).toBe(parent)
  })

  test('status validation: rejects unknown status against project columns', async () => {
    const id = seedTask()
    const res = await stub.invoke('update_task', { task_id: id, status: 'totally_made_up' }) as { content: { text: string }[]; isError?: boolean }
    expect(res.isError).toBe(true)
    expect(res.content[0].text.includes('Allowed statuses')).toBe(true)
  })

  test('error: 404 when task missing (status path probe)', async () => {
    const ghost = crypto.randomUUID()
    const res = await stub.invoke('update_task', { task_id: ghost, status: 'todo' }) as { content: { text: string }[]; isError?: boolean }
    expect(res.isError).toBe(true)
    expect(res.content[0].text.includes('not found')).toBe(true)
  })

  test('error: 404 when task missing (no-status path)', async () => {
    const ghost = crypto.randomUUID()
    const res = await stub.invoke('update_task', { task_id: ghost, title: 'x' }) as { content: { text: string }[]; isError?: boolean }
    expect(res.isError).toBe(true)
    expect(res.content[0].text.includes('not found')).toBe(true)
  })
})

h.cleanup()
