/**
 * MCP: get_current_task_id tool tests. The id comes in as an EXPLICIT tool argument
 * (`task_id`, from the agent's own `$SLAYZONE_TASK_ID`) — this handler runs in the
 * shared MCP sidecar process, which has no per-request env to fall back to. Every
 * agent has that variable, warm-pool agents included (they boot with the id their
 * task is later created under), so there is no second id to resolve it through.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run --config packages/shared/test-utils/vitest.harness.config.ts packages/shared/transport/src/server/http/mcp-tools/get-current-task-id.test.ts
 */
import { afterAll, describe, expect, test } from 'vitest'
import { createTestHarness } from '../../../../../test-utils/ipc-harness.js'
import { captureMcpServer } from '../../../../../test-utils/mcp-harness.js'
import { registerGetCurrentTaskIdTool } from './get-current-task-id.js'

const h = await createTestHarness()
const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'P', '#000', '/tmp/p')

function seedTask(): string {
  const id = crypto.randomUUID()
  h.db
    .prepare(
      `INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(id, projectId, 'T', 'todo', 3, 0)
  return id
}

const stub = captureMcpServer()
registerGetCurrentTaskIdTool(stub.server as never, {
  db: h.slayDb,
  notifyRenderer: () => {}
})

async function invoke(args: {
  task_id?: string
}): Promise<{ content: { text: string }[]; isError?: boolean }> {
  return (await stub.invoke('get_current_task_id', args)) as {
    content: { text: string }[]
    isError?: boolean
  }
}

describe('mcp get_current_task_id', () => {
  test('register: tool registered', () => {
    expect(stub.has('get_current_task_id')).toBe(true)
  })

  test('takes the task id only — no session id argument, no mention of one', () => {
    const tool = stub.get('get_current_task_id')!
    expect(Object.keys(tool.schema).join(',')).toBe('task_id')
    expect(tool.description.includes('SESSION_ID')).toBe(false)
  })

  test('explicit task_id → that task', async () => {
    const taskId = seedTask()
    const res = await invoke({ task_id: taskId })
    expect(res.isError === true).toBe(false)
    const parsed = JSON.parse(res.content[0].text) as { task_id: string }
    expect(parsed.task_id).toBe(taskId)
  })

  test('unknown task_id → isError', async () => {
    const res = await invoke({ task_id: crypto.randomUUID() })
    expect(res.isError).toBe(true)
  })

  test('no args at all → isError', async () => {
    const res = await invoke({})
    expect(res.isError).toBe(true)
  })
})

afterAll(() => h.cleanup())
