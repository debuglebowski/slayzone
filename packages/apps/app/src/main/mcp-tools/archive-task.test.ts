/**
 * MCP: archive_task tool tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/apps/app/src/main/mcp-tools/archive-task.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../../../shared/test-utils/ipc-harness.js'
import { captureMcpServer } from '../../../../../shared/test-utils/mcp-harness.js'
import { spyTaskEvents } from '../../../../../shared/test-utils/event-spy.js'
import { __ipcEmitCalls, __resetIpcEmitCalls } from '../../../../../shared/test-utils/mock-electron.js'
import { taskEvents } from '@slayzone/task/main'
import { registerArchiveTaskTool } from './archive-task.js'

const h = await createTestHarness()
const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(projectId, 'P', '#000', '/tmp/p')

let notifyCount = 0
const stub = captureMcpServer()
registerArchiveTaskTool(stub.server as never, { db: h.db, notifyRenderer: () => { notifyCount++ } })

function seedTask(): string {
  const id = crypto.randomUUID()
  h.db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, projectId, 'T', 'todo', 3, 0)
  return id
}

await describe('mcp archive_task', () => {
  test('register: tool registered as archive_task with description + schema', () => {
    expect(stub.has('archive_task')).toBe(true)
    const tool = stub.get('archive_task')!
    expect(tool.name).toBe('archive_task')
    expect(typeof tool.description).toBe('string')
    expect(tool.description.length).toBeGreaterThan(0)
    expect(typeof tool.schema).toBe('object')
  })

  test('happy: archives + returns JSON; emits dual signals', async () => {
    const id = seedTask()
    __resetIpcEmitCalls()
    const spy = spyTaskEvents(taskEvents, 'task:archived')
    notifyCount = 0
    const res = await stub.invoke('archive_task', { id }) as { content: { type: string; text: string }[]; isError?: boolean }
    spy.stop()
    expect(res.isError === true).toBe(false)
    expect(res.content[0].type).toBe('text')
    const parsed = JSON.parse(res.content[0].text) as { id: string; archived_at: string | null }
    expect(parsed.id).toBe(id)
    expect(parsed.archived_at !== null).toBe(true)
    expect(spy.calls.length).toBe(1)
    const archiveEmits = __ipcEmitCalls.filter((c) => c[0] === 'db:tasks:archive:done')
    expect(archiveEmits.length).toBeGreaterThanOrEqual(1)
    expect(notifyCount).toBeGreaterThanOrEqual(1)
  })

  test('error: returns isError when task not found', async () => {
    const ghost = crypto.randomUUID()
    const res = await stub.invoke('archive_task', { id: ghost }) as { content: { text: string }[]; isError?: boolean }
    expect(res.isError).toBe(true)
    expect(res.content[0].text.includes('not found')).toBe(true)
  })
})

h.cleanup()
