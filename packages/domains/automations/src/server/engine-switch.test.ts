/**
 * Automation actions (`run_command`, `ai`) never exec on the hub, on any hub (T-05
 * superseded: they run on computers). With no computer, a run is refused — including
 * a rule written straight into the database. Proven on the filesystem: the command
 * would create a marker file, and it never appears.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { isHubSwitchedOffError } from '@slayzone/platform/hub-switch-refusal'
import { taskEvents } from '@slayzone/task/server'
import type { AutomationRun } from '@slayzone/automations/shared'
import { AutomationEngine } from './engine.js'
import {
  createAutomation,
  deleteAutomation,
  listAutomationsByProject,
  toggleAutomation,
  updateAutomation
} from './automations-store.js'

const h = await createTestHarness()
const projectPath = h.tmpDir()
const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'SwitchProj', '#000', projectPath)
const taskId = crypto.randomUUID()
h.db
  .prepare(
    'INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)'
  )
  .run(taskId, projectId, 'T', 'todo', 3, 0)

const engine = new AutomationEngine(h.slayDb, () => undefined)
type Listener = (...args: unknown[]) => void
const listeners = new Map<string, Listener[]>()
engine.start({
  on(channel: string, handler: Listener) {
    listeners.set(channel, [...(listeners.get(channel) ?? []), handler])
  },
  emit(channel: string, ...args: unknown[]) {
    for (const l of listeners.get(channel) ?? []) l(...args)
  }
} as never)

const lines: Array<{ event: string; outcome: string; detail: Record<string, unknown> }> = []
setSecurityLogSink((line) => lines.push(JSON.parse(line)))

const marker = (name: string): string => join(projectPath, name)
const runCommand = (file: string) => ({
  type: 'run_command' as const,
  params: { command: `touch ${file}` }
})
const aiAction = { type: 'ai' as const, params: { provider: 'claude-code', prompt: 'hi' } }
const trigger = { type: 'task_status_change', params: { toStatus: 'done' } }

/** A rule written straight into the database — it never passed the save check. */
function insertRow(actions: unknown[], name = 'direct'): string {
  const id = crypto.randomUUID()
  h.db
    .prepare(
      `INSERT INTO automations (id, project_id, name, enabled, trigger_config, conditions, actions, sort_order)
       VALUES (?, ?, ?, 1, ?, '[]', ?, 0)`
    )
    .run(id, projectId, name, JSON.stringify(trigger), JSON.stringify(actions))
  return id
}
const runsOf = (id: string): AutomationRun[] =>
  h.db.prepare('SELECT * FROM automation_runs WHERE automation_id = ?').all(id) as AutomationRun[]

async function refused(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
    return null
  } catch (e) {
    return e
  }
}

// Automation actions run on computers (engine-routing.test.ts), never on the hub: so
// saving one is fine on any hub, and running one with no computer is the actionable
// "connect a computer" — with nothing exec'd here, whatever the switch says.
for (const processes of ['0', undefined] as const) {
  const label = processes === '0' ? 'processes off' : 'processes on'
  describe(`${label}, no computer`, () => {
    const setSwitch = () => {
      if (processes === undefined) delete process.env.SLAYZONE_HUB_ENABLE_PROCESSES
      else process.env.SLAYZONE_HUB_ENABLE_PROCESSES = processes
    }

    test('save: a run_command and an ai action are stored', async () => {
      setSwitch()
      h.db.prepare('DELETE FROM automations').run()
      for (const [kind, action] of [
        ['run_command', runCommand(marker('save'))],
        ['ai', aiAction]
      ] as const) {
        await createAutomation(h.slayDb, {
          project_id: projectId,
          name: kind,
          trigger_config: trigger as never,
          actions: [action as never]
        })
      }
      expect((await listAutomationsByProject(h.slayDb, projectId)).length).toBe(2)
      const id = insertRow([], 'empty')
      await updateAutomation(h.slayDb, { id, actions: [runCommand(marker('upd')) as never] })
      expect((await toggleAutomation(h.slayDb, id, false)).enabled).toBe(false)
      expect(await deleteAutomation(h.slayDb, id)).toBe(true)
    })

    test('manual run: "connect a computer" to the caller, no run row, no exec', async () => {
      setSwitch()
      h.db.prepare('DELETE FROM automations').run()
      const id = insertRow([runCommand(marker('manual'))])
      const err = await refused(() => engine.executeManual(id))
      expect(isHubSwitchedOffError(err)).toBe(true)
      expect((err as Error).message).toMatch(/Connect a computer/)
      expect(runsOf(id)).toHaveLength(0)
      expect(existsSync(marker('manual'))).toBe(false)
    })

    test('event-triggered run: recorded as failed with "connect a computer", no exec', async () => {
      setSwitch()
      h.db.prepare('DELETE FROM automations').run()
      const id = insertRow([runCommand(marker('event'))])
      h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
      taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline && runsOf(id)[0]?.status !== 'error') {
        await new Promise((r) => setTimeout(r, 25))
      }
      const runs = runsOf(id)
      expect(runs).toHaveLength(1)
      expect(runs[0].status).toBe('error')
      expect(String(runs[0].error)).toMatch(/Connect a computer/)
      expect(existsSync(marker('event'))).toBe(false)
      h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
    })

    test('ai action: refused at run too', async () => {
      setSwitch()
      h.db.prepare('DELETE FROM automations').run()
      const id = insertRow([aiAction])
      const err = await refused(() => engine.executeManual(id))
      expect(isHubSwitchedOffError(err)).toBe(true)
    })
  })
}

afterAll(() => {
  engine.stop()
  setSecurityLogSink()
})
