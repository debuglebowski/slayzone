/**
 * The hub's evidence that a computer session's owner is gone: proof only — task
 * gone / in the Trash / archived / done or tab closed for a terminal, row deleted
 * for a process. Unmappable ids and anything still live are kept. Real database.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestHarness, type TestHarness } from '../../../shared/test-utils/ipc-harness'
import { createComputerSessionOwners } from './computer-session-owners'

const harnesses: TestHarness[] = []
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup()
})

async function setup() {
  const h = await createTestHarness()
  harnesses.push(h)
  const db = h.slayDb
  await db.run(`INSERT INTO projects (id, name, color) VALUES ('p1', 'P', '#123456')`)
  const task = async (id: string, extra: Record<string, string | null> = {}) => {
    await db.run(`INSERT INTO tasks (id, project_id, title) VALUES (?, 'p1', 'T')`, [id])
    for (const [col, value] of Object.entries(extra))
      await db.run(`UPDATE tasks SET ${col} = ? WHERE id = ?`, [value, id])
  }
  const tab = (id: string, taskId: string) =>
    db.run(`INSERT INTO terminal_tabs (id, task_id, mode, is_main) VALUES (?, ?, 'terminal', 0)`, [
      id,
      taskId
    ])
  return { db, owners: createComputerSessionOwners(db), task, tab }
}

describe('terminal sessions (<taskId>:<tabId>)', () => {
  it('a live task and an open tab: kept', async () => {
    const { owners, task, tab } = await setup()
    await task('t1', { status: 'in_progress' })
    await tab('tab-1', 't1')
    expect(await owners.terminal('c', 't1:tab-1')).toBeNull()
    expect(await owners.terminal('c', 't1:t1')).toBeNull() // main tab: row may be lazy
  })

  it('a task purged, in the Trash, archived or done: its owner is gone', async () => {
    const { owners, task } = await setup()
    await task('trashed', { deleted_at: new Date().toISOString() })
    await task('archived', { archived_at: new Date().toISOString() })
    await task('done', { status: 'done' })
    expect(await owners.terminal('c', 'purged:purged')).toBe('task-missing')
    expect(await owners.terminal('c', 'trashed:x')).toBe('task-deleted')
    expect(await owners.terminal('c', 'archived:archived')).toBe('task-archived')
    expect(await owners.terminal('c', 'done:done')).toBe('task-done')
  })

  it('a closed tab of a live task: its owner is gone', async () => {
    const { owners, task } = await setup()
    await task('t1', { status: 'in_progress' })
    expect(await owners.terminal('c', 't1:closed-tab')).toBe('tab-closed')
  })

  it('an id it cannot map is kept', async () => {
    const { owners } = await setup()
    expect(await owners.terminal('c', 'warm-uuid')).toBeNull()
    expect(await owners.terminal('c', 'a:b:c')).toBeNull()
    expect(await owners.terminal('c', ':x')).toBeNull()
  })

  it('a database error rejects (the controller then keeps the session)', async () => {
    const { owners } = await setup()
    harnesses.at(-1)!.db.close()
    await expect(owners.terminal('c', 't1:tab-1')).rejects.toThrow()
  })
})

describe('process sessions (process id)', () => {
  it('a deleted row: its owner is gone; an existing one is kept', async () => {
    const { db, owners, task } = await setup()
    await task('t1', { deleted_at: new Date().toISOString() })
    const live = randomUUID()
    await db.run(
      `INSERT INTO processes (id, task_id, project_id, label, command) VALUES (?, 't1', 'p1', 'dev', 'pnpm dev')`,
      [live]
    )
    // Trash stops a task's agents, not its processes: the row decides.
    expect(await owners.process('c', live)).toBeNull()
    expect(await owners.process('c', randomUUID())).toBe('process-deleted')
  })

  it('an id that is not a process id is kept', async () => {
    const { owners } = await setup()
    expect(await owners.process('c', 'task-1:tab-1')).toBeNull()
  })
})
