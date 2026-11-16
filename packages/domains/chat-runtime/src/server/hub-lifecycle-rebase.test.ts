/**
 * Plan §5: task lifecycle revisions are never trusted as proof. The hub is the
 * authority over pause/delete; a computer at a revision the hub did not expect
 * (hub restored from a backup) or behind what the hub thinks it acknowledged
 * (computer restored from a backup) is rebased to the hub's state, never left
 * fenced.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness'
import { createComputerChatRuntime } from './computer-runtime'
import { createChatLifecycle } from './hub-lifecycle'
import { createChatOwnershipStore } from './hub-ownership'

type State = 'active' | 'paused' | 'deleted'
type Harness = Awaited<ReturnType<typeof createTestHarness>>
const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

/** A computer's lifecycle store, with the computer's own apply rules. */
function fakeComputer() {
  const tasks = new Map<string, { state: State; revision: number }>()
  const calls: string[] = []
  const request = async (_pc: string, raw: unknown): Promise<unknown> => {
    const p = raw as { kind: string; taskId: string; state: State; revision: number }
    calls.push(p.kind)
    if (p.kind === 'task.lifecycles')
      return [...tasks].map(([taskId, l]) => ({ taskId, ...l })).sort()
    if (p.kind === 'task.lifecycle') {
      const previous = tasks.get(p.taskId) ?? { state: 'active' as const, revision: 0 }
      if (previous.state === 'deleted') {
        if (p.state === 'deleted' && p.revision > previous.revision)
          tasks.set(p.taskId, { state: 'deleted', revision: p.revision })
        return tasks.get(p.taskId)
      }
      if (previous.revision >= p.revision) return previous
      tasks.set(p.taskId, { state: p.state, revision: p.revision })
      return tasks.get(p.taskId)
    }
    return { ok: true }
  }
  return { tasks, calls, request }
}

async function hub() {
  const h: Harness = await createTestHarness()
  cleanups.push(() => h.cleanup())
  h.db.exec(
    "INSERT INTO projects(id,name,color) VALUES('p','P','#000'); INSERT INTO tasks(id,project_id,title) VALUES('task','p','T'),('bare','p','No chats')"
  )
  const lifecycleRow = (taskId: string) =>
    h.db.prepare('SELECT state,revision FROM chat_task_lifecycle WHERE task_id=?').get(taskId)
  const ack = (taskId: string) =>
    (
      h.db
        .prepare("SELECT revision FROM chat_lifecycle_acks WHERE task_id=? AND computer_id='pc'")
        .get(taskId) as { revision: number } | undefined
    )?.revision
  const setLifecycle = (taskId: string, state: State, revision: number) =>
    h.db
      .prepare(
        'INSERT INTO chat_task_lifecycle(task_id,state,revision) VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET state=excluded.state,revision=excluded.revision'
      )
      .run(taskId, state, revision)
  const track = (taskId: string) =>
    h.db.prepare("INSERT OR IGNORE INTO chat_task_computers VALUES(?, 'pc')").run(taskId)
  return { h, lifecycleRow, ack, setLifecycle, track }
}

test('hub restored from a backup: a computer at a newer revision is rebased, the task is not fenced', async () => {
  const { h, lifecycleRow, ack, setLifecycle, track } = await hub()
  const pc = fakeComputer()
  setLifecycle('task', 'paused', 2)
  track('task')
  // After the backup the hub had re-activated and paused it again (rev 5).
  pc.tasks.set('task', { state: 'active', revision: 5 })
  const lifecycle = createChatLifecycle({ db: h.slayDb, request: pc.request })
  await lifecycle.request('pc', { kind: 'invoke', taskId: 'task' })
  expect(pc.tasks.get('task')).toEqual({ state: 'paused', revision: 6 })
  expect(lifecycleRow('task')).toEqual({ state: 'paused', revision: 6 })
  expect(ack('task')).toBe(6)
  expect(lifecycle.taskFailure('pc', 'task')).toBeUndefined()
})

test('computer restored from a backup: acknowledgements it no longer holds are redelivered', async () => {
  const { h, ack, setLifecycle, track } = await hub()
  const pc = fakeComputer()
  setLifecycle('task', 'paused', 3)
  track('task')
  h.db.prepare("INSERT INTO chat_lifecycle_acks VALUES('task','pc',3)").run()
  // The restored computer never saw the pause.
  pc.tasks.set('task', { state: 'active', revision: 1 })
  const lifecycle = createChatLifecycle({ db: h.slayDb, request: pc.request })
  await lifecycle.reconcile('pc')
  await lifecycle.sync('pc')
  expect(pc.tasks.get('task')).toEqual({ state: 'paused', revision: 3 })
  expect(ack('task')).toBe(3)
})

test('the lifecycle inventory covers tasks without chats', async () => {
  const { h, lifecycleRow, ack, setLifecycle, track } = await hub()
  const pc = fakeComputer()
  setLifecycle('bare', 'active', 1)
  track('bare')
  h.db.prepare("INSERT INTO chat_lifecycle_acks VALUES('bare','pc',1)").run()
  // The computer paused it at a revision this (restored) hub never issued.
  pc.tasks.set('bare', { state: 'paused', revision: 4 })
  const lifecycle = createChatLifecycle({ db: h.slayDb, request: pc.request })
  await lifecycle.reconcile('pc')
  await lifecycle.sync('pc')
  expect(lifecycleRow('bare')).toEqual({ state: 'active', revision: 5 })
  expect(pc.tasks.get('bare')).toEqual({ state: 'active', revision: 5 })
  expect(ack('bare')).toBe(5)
})

test('inventory: a deletion the computer committed is honored; an untracked task gets tracked', async () => {
  const { h, lifecycleRow, setLifecycle } = await hub()
  const pc = fakeComputer()
  const owners = createChatOwnershipStore(h.slayDb)
  h.db
    .prepare(
      "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
    )
    .run()
  await owners.register({
    id: 'c',
    taskId: 'task',
    tabId: 'tab',
    mode: 'claude-chat',
    computerId: 'pc',
    epoch: 1
  })
  setLifecycle('task', 'active', 2)
  pc.tasks.set('task', { state: 'deleted', revision: 7 })
  setLifecycle('bare', 'active', 3)
  pc.tasks.set('bare', { state: 'active', revision: 3 })
  // A task the computer holds that the hub does not know at all stays alone.
  pc.tasks.set('unknown', { state: 'active', revision: 1 })
  const lifecycle = createChatLifecycle({ db: h.slayDb, request: pc.request })
  await lifecycle.reconcile('pc')
  expect(lifecycleRow('task')).toEqual({ state: 'deleted', revision: 7 })
  expect(await owners.get('c')).toMatchObject({ state: 'deleted' })
  expect(
    h.db.prepare("SELECT task_id FROM chat_task_computers WHERE computer_id='pc' ORDER BY 1").all()
  ).toEqual([{ task_id: 'bare' }, { task_id: 'task' }])
})

test('erasing a task the computer already deleted at a higher revision is idempotent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slz-erase-rebase-'))
  const r = createComputerChatRuntime({ stateDir: dir, hubScope: 'hub', computerId: 'pc' })
  cleanups.push(async () => {
    await r.close()
    rmSync(dir, { recursive: true, force: true })
  })
  await r.applyTaskLifecycle('task', 'deleted', 7)
  // A hub restored from a backup asks with its older deletion revision.
  await expect(r.eraseTask('task', 5)).resolves.toEqual({
    taskId: 'task',
    revision: 7,
    erased: true
  })
  // Never an erasure of a task the computer has not deleted.
  await r.applyTaskLifecycle('other', 'paused', 9)
  await expect(r.eraseTask('other', 5)).rejects.toThrow(/stale/i)
})
