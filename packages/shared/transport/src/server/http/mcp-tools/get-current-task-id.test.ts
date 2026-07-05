/**
 * MCP: get_current_task_id tool tests. Covers the warm-pool session→task
 * fallback (resolveCurrentTaskId): a pre-warmed agent boots with only
 * $SLAYZONE_SESSION_ID (no $SLAYZONE_TASK_ID yet), and must resolve its task
 * via agent_sessions.task_id once the pool binds it. Both ids are passed as
 * EXPLICIT tool arguments (session_id/task_id) — this handler runs in the
 * shared MCP sidecar process, which has no per-request env to fall back to;
 * the calling agent must read its own env and pass whichever id it has.
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

async function invoke(args: {
  task_id?: string
  session_id?: string
}): Promise<{ content: { text: string }[]; isError?: boolean }> {
  return (await stub.invoke('get_current_task_id', args)) as {
    content: { text: string }[]
    isError?: boolean
  }
}

await describe('mcp get_current_task_id', () => {
  test('register: tool registered', () => {
    expect(stub.has('get_current_task_id')).toBe(true)
  })

  test('explicit task_id arg wins over session_id arg', async () => {
    const explicit = seedTask()
    const pooledSession = seedAgentSession(null, 'pooled') // would resolve to null if consulted
    const res = await invoke({ task_id: explicit, session_id: pooledSession })
    expect(res.isError === true).toBe(false)
    const parsed = JSON.parse(res.content[0].text) as { task_id: string }
    expect(parsed.task_id).toBe(explicit)
  })

  test('warm-pool fallback: no task_id arg, resolves via bound agent_sessions row', async () => {
    const taskId = seedTask()
    const sessionId = seedAgentSession(taskId, 'bound')
    const res = await invoke({ session_id: sessionId })
    expect(res.isError === true).toBe(false)
    const parsed = JSON.parse(res.content[0].text) as { task_id: string }
    expect(parsed.task_id).toBe(taskId)
  })

  test('warm-pool fallback: session still pooled (unbound) → no task id → isError', async () => {
    const sessionId = seedAgentSession(null, 'pooled')
    const res = await invoke({ session_id: sessionId })
    expect(res.isError).toBe(true)
  })

  test('no args at all → isError', async () => {
    const res = await invoke({})
    expect(res.isError).toBe(true)
  })

  test('unknown session_id → no task id → isError', async () => {
    const res = await invoke({ session_id: crypto.randomUUID() })
    expect(res.isError).toBe(true)
  })
})

h.cleanup()
