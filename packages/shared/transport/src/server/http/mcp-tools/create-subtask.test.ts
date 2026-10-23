/**
 * MCP: create_subtask tool tests — focused on the parent id. It is passed as an
 * EXPLICIT tool argument (`parent_task_id`, from the agent's own `$SLAYZONE_TASK_ID`)
 * — this handler runs in the shared MCP sidecar process, which has no per-request
 * env to read.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/shared/transport/src/server/http/mcp-tools/create-subtask.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../../../test-utils/ipc-harness.js'
import { captureMcpServer } from '../../../../../test-utils/mcp-harness.js'
import { registerCreateSubtaskTool } from './create-subtask.js'

const h = await createTestHarness()
const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'P', '#000', '/tmp/p')

function seedParent(): string {
  const id = crypto.randomUUID()
  h.db
    .prepare(
      `INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(id, projectId, 'Parent', 'todo', 3, 0)
  return id
}

let notifyCount = 0
const stub = captureMcpServer()
registerCreateSubtaskTool(stub.server as never, {
  db: h.slayDb,
  notifyRenderer: () => {
    notifyCount++
  }
})

await describe('mcp create_subtask', () => {
  test('register: tool registered', () => {
    expect(stub.has('create_subtask')).toBe(true)
  })

  test('takes the parent id only — no session id argument, no mention of one', () => {
    const tool = stub.get('create_subtask')!
    expect('session_id' in tool.schema).toBe(false)
    expect(tool.description.includes('SESSION_ID')).toBe(false)
  })

  test('explicit parent_task_id', async () => {
    const parent = seedParent()
    notifyCount = 0
    const res = (await stub.invoke('create_subtask', {
      parent_task_id: parent,
      title: 'Sub'
    })) as { content: { text: string }[]; isError?: boolean }
    expect(res.isError === true).toBe(false)
    const parsed = JSON.parse(res.content[0].text) as { parent_id: string }
    expect(parsed.parent_id).toBe(parent)
    expect(notifyCount).toBeGreaterThanOrEqual(1)
  })

  test('a created subtask gets its task.created history entry', async () => {
    const parent = seedParent()
    const res = (await stub.invoke('create_subtask', {
      parent_task_id: parent,
      title: 'With history'
    })) as { content: { text: string }[]; isError?: boolean }
    const { id } = JSON.parse(res.content[0].text) as { id: string }
    const events = h.db.prepare(`SELECT kind FROM activity_events WHERE task_id = ?`).all(id) as {
      kind: string
    }[]
    expect(events.map((e) => e.kind).join(',')).toBe('task.created')
  })

  test('no parent_task_id → isError', async () => {
    const res = (await stub.invoke('create_subtask', { title: 'Sub' })) as {
      content: { text: string }[]
      isError?: boolean
    }
    expect(res.isError).toBe(true)
  })
})

h.cleanup()
