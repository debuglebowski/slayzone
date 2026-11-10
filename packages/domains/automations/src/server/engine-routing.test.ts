/**
 * Automation shell actions run on the computer that holds the work — the task's,
 * else the project's — through `exec.run`, with `{{project.path}}` and the default
 * cwd being the project's folder ON THAT COMPUTER. So a hub with processes switched
 * off can save and run them; only with no computer does the hub-local path (and its
 * refusal) apply.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { isHubSwitchedOffError } from '@slayzone/platform/hub-switch-refusal'
import { AutomationEngine } from './engine.js'
import { createAutomation } from './automations-store.js'
import { setAutomationCommandRouting, type AutomationCommand } from './command-routing.js'

const h = await createTestHarness()
const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(projectId, 'P', '#000')
h.db
  .prepare(
    `INSERT INTO computers (id, name, platform, version, capabilities_json, created_at) VALUES ('c1', 'c1', 'darwin', '1', '[]', 1)`
  )
  .run()
h.db
  .prepare(
    `INSERT INTO project_placements (computer_id, project_id, root_path, status, updated_at) VALUES ('c1', ?, '/remote/proj', 'ready', 1)`
  )
  .run(projectId)

const engine = new AutomationEngine(h.slayDb, () => undefined)
const ran: Array<{ computerId: string; command: AutomationCommand }> = []
let computer: string | null = 'c1'

function route(answer: { status: number | null; timedOut?: boolean; stderr?: string }): void {
  setAutomationCommandRouting({
    computerFor: async () => computer,
    run: async (computerId, command) => {
      ran.push({ computerId, command })
      return {
        stdout: 'out\n',
        stderr: answer.stderr ?? '',
        status: answer.status,
        timedOut: answer.timedOut ?? false
      }
    }
  })
}

afterEach(() => {
  ran.length = 0
  computer = 'c1'
  setAutomationCommandRouting(null)
  delete process.env.SLAYZONE_HUB_ENABLE_PROCESSES
})

const manual = { type: 'manual', params: {} }
const save = (command: string) =>
  createAutomation(h.slayDb, {
    project_id: projectId,
    name: `a-${crypto.randomUUID().slice(0, 6)}`,
    trigger_config: manual,
    actions: [{ type: 'run_command', params: { command } }]
  } as never)

describe('automation actions on a computer', () => {
  test("runs there, in the project's folder on that computer", async () => {
    route({ status: 0 })
    const a = await save('echo {{project.path}}')
    const run = await engine.executeManual(a.id)
    expect(run.status).toBe('success')
    expect(ran).toEqual([
      {
        computerId: 'c1',
        command: expect.objectContaining({
          command: 'echo /remote/proj',
          cwd: '/remote/proj',
          projectId
        })
      }
    ])
  })

  test('a processes-off hub saves and runs it — nothing runs on the hub', async () => {
    route({ status: 0 })
    process.env.SLAYZONE_HUB_ENABLE_PROCESSES = '0'
    const a = await save('echo hi')
    expect((await engine.executeManual(a.id)).status).toBe('success')
    expect(ran).toHaveLength(1)
  })

  test("a failing command fails the run with the computer's stderr", async () => {
    route({ status: 2, stderr: 'boom' })
    const a = await save('false')
    const run = await engine.executeManual(a.id)
    expect(run.status).toBe('error')
    expect(run.error).toContain('boom')
  })

  test('no computer on a processes-off hub: refused, nothing run', async () => {
    route({ status: 0 })
    const a = await save('echo hi')
    computer = null
    process.env.SLAYZONE_HUB_ENABLE_PROCESSES = '0'
    const err = await engine.executeManual(a.id).catch((e: unknown) => e)
    expect(isHubSwitchedOffError(err)).toBe(true)
    expect(ran).toHaveLength(0)
  })
})

describe('{{task.worktree_path}} comes from the computer the actions run on (§9 Phase 7c)', () => {
  const fire = (taskId: string) =>
    (engine as unknown as { handleEvent(e: Record<string, unknown>): Promise<void> }).handleEvent({
      type: 'task_created',
      taskId,
      projectId,
      depth: 0
    })
  const task = () => {
    const id = crypto.randomUUID()
    h.db
      .prepare('INSERT INTO tasks (id, project_id, title, has_worktree) VALUES (?, ?, ?, 1)')
      .run(id, projectId, 't')
    return id
  }
  const onCreate = (command: string) =>
    createAutomation(h.slayDb, {
      project_id: projectId,
      name: `w-${crypto.randomUUID().slice(0, 6)}`,
      trigger_config: { type: 'task_created', params: {} },
      actions: [{ type: 'run_command', params: { command } }]
    } as never)
  const lastRun = (automationId: string) =>
    h.db
      .prepare(
        'SELECT status, error FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT 1'
      )
      .get(automationId) as { status: string; error: string | null }

  test("expands to the computer's path, never a hub copy", async () => {
    const asked: Array<[string, string]> = []
    setAutomationCommandRouting({
      computerFor: async () => 'c1',
      taskPaths: async (computerId, taskId) => {
        asked.push([computerId, taskId])
        return { worktreePath: '/remote/wt', baseDir: null }
      },
      run: async (computerId, command) => {
        ran.push({ computerId, command })
        return { stdout: '', stderr: '', status: 0, timedOut: false }
      }
    })
    const a = await onCreate('echo {{task.worktree_path}}')
    const id = task()
    await fire(id)
    await vi.waitFor(() => expect(lastRun(a.id).status).toBe('success'))
    expect(asked).toEqual([['c1', id]])
    expect(ran.map((r) => r.command.command)).toEqual(['echo /remote/wt'])
  })

  test('§9 7d: path conditions — "exists" is the hub fact, a compared path the computer\'s', async () => {
    setAutomationCommandRouting({
      computerFor: async () => 'c1',
      taskPaths: async () => ({ worktreePath: '/remote/wt', baseDir: null }),
      run: async (computerId, command) => {
        ran.push({ computerId, command })
        return { stdout: '', stderr: '', status: 0, timedOut: false }
      }
    })
    const withCondition = (command: string, operator: string, value?: string) =>
      createAutomation(h.slayDb, {
        project_id: projectId,
        name: `c-${crypto.randomUUID().slice(0, 6)}`,
        trigger_config: { type: 'task_created', params: {} },
        conditions: [
          { type: 'task_property', params: { field: 'worktree_path', operator, value } }
        ],
        actions: [{ type: 'run_command', params: { command } }]
      } as never)
    await withCondition('echo exists', 'exists')
    await withCondition('echo remote', 'equals', '/remote/wt')
    await withCondition('echo stale', 'equals', '/hub/stale-copy')
    await fire(task())
    const mine = () =>
      ran
        .map((r) => r.command.command)
        .filter((c) => ['echo exists', 'echo remote', 'echo stale'].includes(c))
        .sort()
    await vi.waitFor(() => expect(mine().length).toBeGreaterThanOrEqual(2))
    await new Promise((r) => setTimeout(r, 50))
    expect(mine()).toEqual(['echo exists', 'echo remote'])
  })

  test('the computer cannot answer: the run fails, nothing runs with the variable empty', async () => {
    setAutomationCommandRouting({
      computerFor: async () => 'c1',
      taskPaths: async () => {
        throw new Error('computer c1 is not connected')
      },
      run: async (computerId, command) => {
        ran.push({ computerId, command })
        return { stdout: '', stderr: '', status: 0, timedOut: false }
      }
    })
    const a = await onCreate('rm -rf {{task.worktree_path}}/build')
    await fire(task())
    await vi.waitFor(() =>
      expect(lastRun(a.id)).toEqual(
        expect.objectContaining({ status: 'error', error: expect.stringMatching(/not connected/) })
      )
    )
    expect(ran).toEqual([])
  })
})
