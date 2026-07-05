/**
 * MCP: create_subtask tool tests — focused on parent_task_id resolution
 * (resolveCurrentTaskId), including the warm-pool session→task fallback.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/shared/transport/src/server/http/mcp-tools/create-subtask.test.ts
 */
import {
  createTestHarness,
  test,
  expect,
  describe
} from '../../../../../test-utils/ipc-harness.js'
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

function seedAgentSession(taskId: string | null, status: 'pooled' | 'bound'): string {
  const id = crypto.randomUUID()
  h.db
    .prepare(
      `INSERT INTO agent_sessions (id, mode, cwd, task_id, origin, status, created_at)
       VALUES (?, 'claude-code', '/tmp', ?, 'slay-spawned-fresh', ?, 0)`
    )
    .run(id, taskId, status)
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

function resetEnv(): void {
  delete process.env.SLAYZONE_TASK_ID
  delete process.env.SLAYZONE_SESSION_ID
}

await describe('mcp create_subtask', () => {
  test('register: tool registered', () => {
    expect(stub.has('create_subtask')).toBe(true)
  })

  test('explicit parent_task_id (no env needed)', async () => {
    resetEnv()
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

  test('warm-pool fallback: no parent_task_id arg, no $SLAYZONE_TASK_ID, resolves via bound session', async () => {
    resetEnv()
    const parent = seedParent()
    process.env.SLAYZONE_SESSION_ID = seedAgentSession(parent, 'bound')
    const res = (await stub.invoke('create_subtask', { title: 'Sub via pool' })) as {
      content: { text: string }[]
      isError?: boolean
    }
    expect(res.isError === true).toBe(false)
    const parsed = JSON.parse(res.content[0].text) as { parent_id: string }
    expect(parsed.parent_id).toBe(parent)
  })

  test('warm-pool fallback: session still pooled (unbound) → isError', async () => {
    resetEnv()
    process.env.SLAYZONE_SESSION_ID = seedAgentSession(null, 'pooled')
    const res = (await stub.invoke('create_subtask', { title: 'Sub' })) as {
      content: { text: string }[]
      isError?: boolean
    }
    expect(res.isError).toBe(true)
  })

  test('no parent_task_id, no env → isError', async () => {
    resetEnv()
    const res = (await stub.invoke('create_subtask', { title: 'Sub' })) as {
      content: { text: string }[]
      isError?: boolean
    }
    expect(res.isError).toBe(true)
  })
})

resetEnv()
h.cleanup()
