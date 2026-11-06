/**
 * Automation shell actions run on the computer that holds the work — the task's,
 * else the project's — through `exec.run`, with `{{project.path}}` and the default
 * cwd being the project's folder ON THAT COMPUTER. So a hub with processes switched
 * off can save and run them; only with no computer does the hub-local path (and its
 * refusal) apply.
 */
import { afterEach, describe, expect, test } from 'vitest'
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
