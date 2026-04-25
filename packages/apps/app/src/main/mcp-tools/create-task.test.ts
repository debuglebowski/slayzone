/**
 * MCP: create_task tool tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/apps/app/src/main/mcp-tools/create-task.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../../../shared/test-utils/ipc-harness.js'
import { captureMcpServer } from '../../../../../shared/test-utils/mcp-harness.js'
import { spyTaskEvents } from '../../../../../shared/test-utils/event-spy.js'
import { __ipcEmitCalls, __resetIpcEmitCalls } from '../../../../../shared/test-utils/mock-electron.js'
import { taskEvents } from '@slayzone/task/main'
import { registerCreateTaskTool } from './create-task.js'

const h = await createTestHarness()
const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(projectId, 'P', '#000', '/tmp/p')

let notifyCount = 0
const stub = captureMcpServer()
registerCreateTaskTool(stub.server as never, { db: h.db, notifyRenderer: () => { notifyCount++ } })

await describe('mcp create_task', () => {
  test('register: tool registered with description + schema', () => {
    expect(stub.has('create_task')).toBe(true)
    const tool = stub.get('create_task')!
    expect(tool.name).toBe('create_task')
    expect(tool.description.length).toBeGreaterThan(0)
  })

  test('happy: creates task; returns JSON; emits dual signals', async () => {
    __resetIpcEmitCalls()
    const spy = spyTaskEvents(taskEvents, 'task:created')
    notifyCount = 0
    const res = await stub.invoke('create_task', { projectId, title: 'MCP Created' }) as { content: { text: string }[]; isError?: boolean }
    spy.stop()
    expect(res.isError === true).toBe(false)
    const parsed = JSON.parse(res.content[0].text) as { id: string; title: string; project_id: string }
    expect(parsed.title).toBe('MCP Created')
    expect(parsed.project_id).toBe(projectId)
    const row = h.db.prepare('SELECT title FROM tasks WHERE id = ?').get(parsed.id) as { title: string }
    expect(row.title).toBe('MCP Created')
    expect(spy.calls.length).toBe(1)
    const createEmits = __ipcEmitCalls.filter((c) => c[0] === 'db:tasks:create:done')
    expect(createEmits.length).toBeGreaterThanOrEqual(1)
    expect(notifyCount).toBeGreaterThanOrEqual(1)
  })

  test('error: returns isError when ops throws', async () => {
    // projectId that doesn't exist will fail FK
    const res = await stub.invoke('create_task', { projectId: crypto.randomUUID(), title: 'Bad' }) as { content: { text: string }[]; isError?: boolean }
    expect(res.isError).toBe(true)
  })

  test('priority + status forwarded', async () => {
    const res = await stub.invoke('create_task', { projectId, title: 'Custom', status: 'todo', priority: 1 }) as { content: { text: string }[]; isError?: boolean }
    expect(res.isError === true).toBe(false)
    const parsed = JSON.parse(res.content[0].text) as { status: string; priority: number }
    expect(parsed.status).toBe('todo')
    expect(parsed.priority).toBe(1)
  })
})

h.cleanup()
