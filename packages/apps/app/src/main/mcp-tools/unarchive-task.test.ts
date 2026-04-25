/**
 * MCP: unarchive_task tool tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/apps/app/src/main/mcp-tools/unarchive-task.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../../../shared/test-utils/ipc-harness.js'
import { captureMcpServer } from '../../../../../shared/test-utils/mcp-harness.js'
import { spyTaskEvents } from '../../../../../shared/test-utils/event-spy.js'
import { __ipcEmitCalls, __resetIpcEmitCalls } from '../../../../../shared/test-utils/mock-electron.js'
import { taskEvents } from '@slayzone/task/main'
import { registerUnarchiveTaskTool } from './unarchive-task.js'

const h = await createTestHarness()
const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(projectId, 'P', '#000', '/tmp/p')

let notifyCount = 0
const stub = captureMcpServer()
registerUnarchiveTaskTool(stub.server as never, { db: h.db, notifyRenderer: () => { notifyCount++ } })

function seedArchived(): string {
  const id = crypto.randomUUID()
  h.db.prepare(`INSERT INTO tasks (id, project_id, title, status, priority, "order", archived_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`)
    .run(id, projectId, 'T', 'todo', 3, 0)
  return id
}

await describe('mcp unarchive_task', () => {
  test('register: tool registered', () => {
    expect(stub.has('unarchive_task')).toBe(true)
  })

  test('happy: clears archived_at; emits dual signals', async () => {
    const id = seedArchived()
    __resetIpcEmitCalls()
    const spy = spyTaskEvents(taskEvents, 'task:unarchived')
    notifyCount = 0
    const res = await stub.invoke('unarchive_task', { id }) as { content: { text: string }[]; isError?: boolean }
    spy.stop()
    expect(res.isError === true).toBe(false)
    const parsed = JSON.parse(res.content[0].text) as { id: string; archived_at: string | null }
    expect(parsed.archived_at).toBeNull()
    const row = h.db.prepare('SELECT archived_at FROM tasks WHERE id = ?').get(id) as { archived_at: string | null }
    expect(row.archived_at).toBeNull()
    expect(spy.calls.length).toBe(1)
    const emits = __ipcEmitCalls.filter((c) => c[0] === 'db:tasks:unarchive:done')
    expect(emits.length).toBeGreaterThanOrEqual(1)
    expect(notifyCount).toBeGreaterThanOrEqual(1)
  })

  test('error: returns isError when task missing', async () => {
    const ghost = crypto.randomUUID()
    const res = await stub.invoke('unarchive_task', { id: ghost }) as { content: { text: string }[]; isError?: boolean }
    expect(res.isError).toBe(true)
  })
})

h.cleanup()
