/**
 * `SLAYZONE_HUB_ENABLE_PROCESSES=0` (T-05): an automation action that execs on the
 * hub (`run_command`, `ai`) is refused at save and at run — including a rule written
 * straight into the database, which never passed the save check. Proven on the
 * filesystem: the command would create a marker file, and it never appears. Every
 * refusal is one `automation.run_command` audit line. The default path is
 * engine.test.ts.
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

process.env.SLAYZONE_HUB_ENABLE_PROCESSES = '0'

describe('processes off: save', () => {
  for (const [kind, action] of [
    ['run_command', runCommand(marker('save'))],
    ['ai', aiAction]
  ] as const) {
    test(`create with ${kind}: refused, nothing stored, one audit line`, async () => {
      const before = lines.length
      const err = await refused(() =>
        createAutomation(h.slayDb, {
          project_id: projectId,
          name: kind,
          trigger_config: trigger as never,
          actions: [action as never]
        })
      )
      expect(isHubSwitchedOffError(err)).toBe(true)
      expect((await listAutomationsByProject(h.slayDb, projectId)).length).toBe(0)
      expect(lines.length).toBe(before + 1)
      expect(lines[before].event).toBe('automation.run_command')
      expect(lines[before].outcome).toBe('denied')
      expect(lines[before].detail.op).toBe('save')
      expect(lines[before].detail.actionType).toBe(kind)
    })
  }

  test('update that sets a run_command action: refused, row unchanged', async () => {
    const id = insertRow([], 'empty')
    const err = await refused(() =>
      updateAutomation(h.slayDb, { id, actions: [runCommand(marker('upd')) as never] })
    )
    expect(isHubSwitchedOffError(err)).toBe(true)
    const row = h.db.prepare('SELECT actions FROM automations WHERE id = ?').get(id) as {
      actions: string
    }
    expect(row.actions).toBe('[]')
    expect(lines[lines.length - 1].detail.automationId).toBe(id)
  })

  test('update that leaves actions alone, toggle, delete: still work', async () => {
    const id = insertRow([runCommand(marker('keep'))], 'keep')
    const renamed = await updateAutomation(h.slayDb, { id, name: 'renamed' })
    expect(renamed.name).toBe('renamed')
    expect((await toggleAutomation(h.slayDb, id, false)).enabled).toBe(false)
    expect(await deleteAutomation(h.slayDb, id)).toBe(true)
  })
})

describe('processes off: run (row inserted directly)', () => {
  test('manual run: refused to the caller, no run row, no exec', async () => {
    h.db.prepare('DELETE FROM automations').run()
    const id = insertRow([runCommand(marker('manual'))])
    const before = lines.length
    const err = await refused(() => engine.executeManual(id))
    expect(isHubSwitchedOffError(err)).toBe(true)
    expect(runsOf(id)).toHaveLength(0)
    expect(existsSync(marker('manual'))).toBe(false)
    expect(lines.length).toBe(before + 1)
    expect(lines[before].event).toBe('automation.run_command')
    expect(lines[before].detail.op).toBe('run')
    expect(lines[before].detail.automationId).toBe(id)
  })

  test('event-triggered run: recorded as refused, no exec', async () => {
    h.db.prepare('DELETE FROM automations').run()
    const id = insertRow([runCommand(marker('event'))])
    const before = lines.length
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    // The engine runs off the event asynchronously; a fixed 300ms sleep raced it when
    // this file runs alongside other suites. Wait (deadline-bounded) for the run row
    // to settle instead.
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && runsOf(id)[0]?.status !== 'error') {
      await new Promise((r) => setTimeout(r, 25))
    }
    const runs = runsOf(id)
    expect(runs).toHaveLength(1)
    expect(runs[0].status).toBe('error')
    expect(String(runs[0].error)).toContain('SLAYZONE_HUB_ENABLE_PROCESSES=0')
    expect(existsSync(marker('event'))).toBe(false)
    expect(lines.length).toBe(before + 1)
    expect(lines[before].event).toBe('automation.run_command')
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })

  test('ai action inserted directly: refused at run too', async () => {
    h.db.prepare('DELETE FROM automations').run()
    const id = insertRow([aiAction])
    const err = await refused(() => engine.executeManual(id))
    expect(isHubSwitchedOffError(err)).toBe(true)
    expect(lines[lines.length - 1].detail.actionType).toBe('ai')
  })
})

describe('processes on (default)', () => {
  test('the same rule saves and runs', async () => {
    delete process.env.SLAYZONE_HUB_ENABLE_PROCESSES
    h.db.prepare('DELETE FROM automations').run()
    const before = lines.length
    const a = await createAutomation(h.slayDb, {
      project_id: projectId,
      name: 'on',
      trigger_config: trigger as never,
      actions: [runCommand(marker('default')) as never]
    })
    const run = await engine.executeManual(a.id)
    expect(run.status).toBe('success')
    expect(existsSync(marker('default'))).toBe(true)
    expect(lines.length).toBe(before)
  })
})

afterAll(() => {
  engine.stop()
  setSecurityLogSink()
})
