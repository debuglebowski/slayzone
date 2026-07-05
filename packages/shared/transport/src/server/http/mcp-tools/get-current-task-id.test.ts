/**
 * MCP: get_current_task_id tool tests. Covers the warm-pool session→task
 * fallback (resolveCurrentTaskId): a pre-warmed agent boots with only
 * $SLAYZONE_SESSION_ID (no $SLAYZONE_TASK_ID yet), and must resolve its task
 * via agent_sessions.task_id once the pool binds it.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/shared/transport/src/server/http/mcp-tools/get-current-task-id.test.ts
 */
import {
  createTestHarness,
  test,
  expect,
  describe
} from '../../../../../test-utils/ipc-harness.js'
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

const stub = captureMcpServer()
registerGetCurrentTaskIdTool(stub.server as never, {
  db: h.slayDb,
  notifyRenderer: () => {}
})

async function invoke(): Promise<{ content: { text: string }[]; isError?: boolean }> {
  return (await stub.invoke('get_current_task_id', {})) as {
    content: { text: string }[]
    isError?: boolean
  }
}

const savedTaskIdEnv = process.env.SLAYZONE_TASK_ID
const savedSessionIdEnv = process.env.SLAYZONE_SESSION_ID
function resetEnv(): void {
  delete process.env.SLAYZONE_TASK_ID
  delete process.env.SLAYZONE_SESSION_ID
}

await describe('mcp get_current_task_id', () => {
  test('register: tool registered', () => {
    expect(stub.has('get_current_task_id')).toBe(true)
  })

  test('explicit arg wins over env', async () => {
    resetEnv()
    const explicit = seedTask()
    process.env.SLAYZONE_TASK_ID = crypto.randomUUID() // some other, unseeded id
    const res = (await stub.invoke('get_current_task_id', { task_id: explicit })) as {
      content: { text: string }[]
      isError?: boolean
    }
    expect(res.isError === true).toBe(false)
    const parsed = JSON.parse(res.content[0].text) as { task_id: string }
    expect(parsed.task_id).toBe(explicit)
  })

  test('$SLAYZONE_TASK_ID wins over session lookup (normal spawn, fast path)', async () => {
    resetEnv()
    const taskId = seedTask()
    process.env.SLAYZONE_TASK_ID = taskId
    process.env.SLAYZONE_SESSION_ID = seedAgentSession(null, 'pooled') // would resolve to null if consulted
    const res = await invoke()
    expect(res.isError === true).toBe(false)
    const parsed = JSON.parse(res.content[0].text) as { task_id: string }
    expect(parsed.task_id).toBe(taskId)
  })

  test('warm-pool fallback: no $SLAYZONE_TASK_ID, resolves via bound agent_sessions row', async () => {
    resetEnv()
    const taskId = seedTask()
    process.env.SLAYZONE_SESSION_ID = seedAgentSession(taskId, 'bound')
    const res = await invoke()
    expect(res.isError === true).toBe(false)
    const parsed = JSON.parse(res.content[0].text) as { task_id: string }
    expect(parsed.task_id).toBe(taskId)
  })

  test('warm-pool fallback: session still pooled (unbound) → no task id → isError', async () => {
    resetEnv()
    process.env.SLAYZONE_SESSION_ID = seedAgentSession(null, 'pooled')
    const res = await invoke()
    expect(res.isError).toBe(true)
  })

  test('no env at all → isError', async () => {
    resetEnv()
    const res = await invoke()
    expect(res.isError).toBe(true)
  })

  test('unknown $SLAYZONE_SESSION_ID → no task id → isError', async () => {
    resetEnv()
    process.env.SLAYZONE_SESSION_ID = crypto.randomUUID()
    const res = await invoke()
    expect(res.isError).toBe(true)
  })
})

resetEnv()
if (savedTaskIdEnv !== undefined) process.env.SLAYZONE_TASK_ID = savedTaskIdEnv
if (savedSessionIdEnv !== undefined) process.env.SLAYZONE_SESSION_ID = savedSessionIdEnv

h.cleanup()
