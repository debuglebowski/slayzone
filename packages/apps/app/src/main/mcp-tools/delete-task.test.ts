/**
 * MCP: delete_task tool tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/apps/app/src/main/mcp-tools/delete-task.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../../../shared/test-utils/ipc-harness.js'
import { captureMcpServer } from '../../../../../shared/test-utils/mcp-harness.js'
import { spyTaskEvents } from '../../../../../shared/test-utils/event-spy.js'
import { __ipcEmitCalls, __resetIpcEmitCalls } from '../../../../../shared/test-utils/mock-electron.js'
import { taskEvents } from '@slayzone/task/main'
import { registerDeleteTaskTool } from './delete-task.js'

const h = await createTestHarness()
const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(projectId, 'P', '#000', '/tmp/p')

let notifyCount = 0
const stub = captureMcpServer()
registerDeleteTaskTool(stub.server as never, { db: h.db, notifyRenderer: () => { notifyCount++ } })

function seedTask(): string {
  const id = crypto.randomUUID()
  h.db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, projectId, 'T', 'todo', 3, 0)
  return id
}

await describe('mcp delete_task', () => {
  test('register: tool registered', () => {
    expect(stub.has('delete_task')).toBe(true)
    expect(stub.get('delete_task')!.description.length).toBeGreaterThan(0)
  })

  test('happy: soft-deletes; emits taskEvents', async () => {
    const id = seedTask()
    __resetIpcEmitCalls()
    const spy = spyTaskEvents(taskEvents, 'task:deleted')
    notifyCount = 0
    const res = await stub.invoke('delete_task', { id }) as { content: { text: string }[]; isError?: boolean }
    spy.stop()
    expect(res.isError === true).toBe(false)
    const parsed = JSON.parse(res.content[0].text) as { id: string; deleted: boolean }
    expect(parsed.id).toBe(id)
    expect(parsed.deleted).toBe(true)
    const row = h.db.prepare('SELECT deleted_at FROM tasks WHERE id = ?').get(id) as { deleted_at: string | null }
    expect(row.deleted_at !== null).toBe(true)
    expect(spy.calls.length).toBe(1)
    expect(notifyCount).toBeGreaterThanOrEqual(1)
  })

  test('error: returns isError when task missing', async () => {
    const ghost = crypto.randomUUID()
    const res = await stub.invoke('delete_task', { id: ghost }) as { content: { text: string }[]; isError?: boolean }
    expect(res.isError).toBe(true)
    expect(res.content[0].text.includes('not found')).toBe(true)
  })

  test('blocked: linked_to_provider returns isError + does NOT soft-delete', async () => {
    const id = seedTask()
    const connId = crypto.randomUUID()
    h.db.prepare(`INSERT INTO integration_connections (id, provider, credential_ref) VALUES (?, 'github', 'ref')`).run(connId)
    h.db.prepare(`INSERT INTO external_links (id, provider, connection_id, external_type, external_id, external_key, task_id) VALUES (?, 'github', ?, 'issue', '42', '42', ?)`)
      .run(crypto.randomUUID(), connId, id)
    const res = await stub.invoke('delete_task', { id }) as { content: { text: string }[]; isError?: boolean }
    expect(res.isError).toBe(true)
    expect(res.content[0].text.includes('linked')).toBe(true)
    const row = h.db.prepare('SELECT deleted_at FROM tasks WHERE id = ?').get(id) as { deleted_at: string | null }
    expect(row.deleted_at).toBeNull()
  })
})

h.cleanup()
