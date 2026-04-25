/**
 * MCP: archive_many_task tool tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/apps/app/src/main/mcp-tools/archive-many-task.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../../../shared/test-utils/ipc-harness.js'
import { captureMcpServer } from '../../../../../shared/test-utils/mcp-harness.js'
import { spyTaskEvents } from '../../../../../shared/test-utils/event-spy.js'
import { __ipcEmitCalls, __resetIpcEmitCalls } from '../../../../../shared/test-utils/mock-electron.js'
import { taskEvents } from '@slayzone/task/main'
import { registerArchiveManyTaskTool } from './archive-many-task.js'

const h = await createTestHarness()
const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(projectId, 'P', '#000', '/tmp/p')

let notifyCount = 0
const stub = captureMcpServer()
registerArchiveManyTaskTool(stub.server as never, { db: h.db, notifyRenderer: () => { notifyCount++ } })

function seedTask(): string {
  const id = crypto.randomUUID()
  h.db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, projectId, 'T', 'todo', 3, 0)
  return id
}

await describe('mcp archive_many_task', () => {
  test('register: tool registered', () => {
    expect(stub.has('archive_many_task')).toBe(true)
  })

  test('happy: archives all + returns count + emits per-id signals', async () => {
    const ids = [seedTask(), seedTask(), seedTask()]
    __resetIpcEmitCalls()
    const spy = spyTaskEvents(taskEvents, 'task:archived')
    notifyCount = 0
    const res = await stub.invoke('archive_many_task', { ids }) as { content: { text: string }[]; isError?: boolean }
    spy.stop()
    expect(res.isError === true).toBe(false)
    const parsed = JSON.parse(res.content[0].text) as { archived: number; ids: string[] }
    expect(parsed.archived).toBe(ids.length)
    expect(parsed.ids).toEqual(ids)
    for (const id of ids) {
      const row = h.db.prepare('SELECT archived_at FROM tasks WHERE id = ?').get(id) as { archived_at: string | null }
      expect(row.archived_at !== null).toBe(true)
    }
    expect(spy.calls.length).toBe(ids.length)
    const emits = __ipcEmitCalls.filter((c) => c[0] === 'db:tasks:archive:done')
    expect(emits.length).toBeGreaterThanOrEqual(ids.length)
    expect(notifyCount).toBeGreaterThanOrEqual(1)
  })

  test('happy: empty ids array is a no-op success', async () => {
    __resetIpcEmitCalls()
    const spy = spyTaskEvents(taskEvents, 'task:archived')
    const res = await stub.invoke('archive_many_task', { ids: [] }) as { content: { text: string }[]; isError?: boolean }
    spy.stop()
    expect(res.isError === true).toBe(false)
    const parsed = JSON.parse(res.content[0].text) as { archived: number; ids: string[] }
    expect(parsed.archived).toBe(0)
    expect(spy.calls.length).toBe(0)
  })

  test('cascade: archives sub-tasks of given parents', async () => {
    const parent = seedTask()
    const child = crypto.randomUUID()
    h.db.prepare('INSERT INTO tasks (id, project_id, parent_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(child, projectId, parent, 'C', 'todo', 3, 1)
    await stub.invoke('archive_many_task', { ids: [parent] })
    const row = h.db.prepare('SELECT archived_at FROM tasks WHERE id = ?').get(child) as { archived_at: string | null }
    expect(row.archived_at !== null).toBe(true)
  })
})

h.cleanup()
