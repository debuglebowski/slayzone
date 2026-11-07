/**
 * Final review H1: cron "catch up on start" ran at launch (and after sleep), before
 * the local computer had connected. The run failed with "connect a computer", was
 * recorded as an error and moved last_run_at — the missed slot was lost for good.
 * A catch-up now waits for the computer, like a process does, and runs once when it
 * connects: never lost, never twice.
 */
import { afterEach, describe, expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { AutomationEngine } from './engine.js'
import { setAutomationCommandRouting, type AutomationCommand } from './command-routing.js'

const h = await createTestHarness()
const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(projectId, 'P', '#000')

const engine = new AutomationEngine(h.slayDb, () => undefined)
const ran: AutomationCommand[] = []
let reachable = false

function wire(): void {
  setAutomationCommandRouting({
    computerFor: async () => 'c1',
    isReachable: () => reachable,
    run: async (_id, command) => {
      ran.push(command)
      return { stdout: 'ok', stderr: '', status: 0, timedOut: false }
    }
  })
}

afterEach(() => {
  ran.length = 0
  reachable = false
  setAutomationCommandRouting(null)
  h.db.prepare('DELETE FROM automations').run()
  h.db.prepare('DELETE FROM automation_runs').run()
})

const hourAgo = () =>
  new Date(Date.now() - 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)

function cron(lastRunAt: string): string {
  const id = crypto.randomUUID()
  h.db
    .prepare(
      `INSERT INTO automations (id, project_id, name, enabled, trigger_config, conditions, actions, sort_order, last_run_at, catchup_on_start)
       VALUES (?, ?, 'c', 1, ?, '[]', ?, 0, ?, 1)`
    )
    .run(
      id,
      projectId,
      JSON.stringify({ type: 'cron', params: { expression: '* * * * *' } }),
      JSON.stringify([{ type: 'run_command', params: { command: 'echo caught-up' } }]),
      lastRunAt
    )
  return id
}

const runs = (id: string) =>
  h.db.prepare('SELECT status FROM automation_runs WHERE automation_id = ?').all(id) as Array<{
    status: string
  }>
const lastRun = (id: string) =>
  (
    h.db.prepare('SELECT last_run_at FROM automations WHERE id = ?').get(id) as {
      last_run_at: string
    }
  ).last_run_at
const settle = () => new Promise((r) => setTimeout(r, 200))

describe('H1: cron catch-up waits for the computer', () => {
  test('before routing is wired (launch): nothing recorded; on connect it runs once', async () => {
    const before = hourAgo()
    const id = cron(before)
    await engine.runCatchup()
    await settle()
    expect(runs(id)).toEqual([])
    expect(lastRun(id)).toBe(before)

    wire()
    reachable = true
    await engine.computerConnected()
    await settle()
    expect(runs(id)).toEqual([{ status: 'success' }])
    expect(ran.map((c) => c.command)).toEqual(['echo caught-up'])
  })

  test('computer not yet connected (after sleep): deferred, then once — even if asked twice', async () => {
    wire()
    const id = cron(hourAgo())
    await engine.runCatchup()
    await engine.runCatchup() // the resume trigger as well as start
    await settle()
    expect(runs(id)).toEqual([])

    reachable = true
    await Promise.all([engine.computerConnected(), engine.computerConnected()])
    await settle()
    await engine.runCatchup() // a later trigger finds the slot already caught up
    await settle()
    expect(runs(id)).toEqual([{ status: 'success' }])
    expect(ran).toHaveLength(1)
  })
})
