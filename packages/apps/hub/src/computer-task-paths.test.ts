/**
 * A task's worktree path and base dir live on the computer holding its worktree
 * (robustness plan §9, P0; Phase 7a). Every hub write is run there (set, inherit,
 * clear) when it is connected, else staged and delivered once it is. A real hub
 * database against real computer chat runtimes.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { checkComputerChatConsistency } from '@slayzone/chat-runtime/hub'
import { createChatRuntimeHandlers } from '../../computer/src/handlers/chat-runtime'
import { createComputerDataHandoff } from './computer-data-handoff'
import { createTaskPathRequestGate } from './task-path-request-gate'
import { HubToComputerMethods } from '@slayzone/computer-transport/shared'
import {
  createComputerTaskPaths,
  readComputerTaskRoots,
  TASK_PATH_KIND,
  taskPathTarget
} from './computer-task-paths'

const cleanups: Array<() => unknown> = []
/** A folder inside the computers' allowed root: a live write is judged there (§9 7e). */
const W = (name: string) => join(realpathSync(tmpdir()), 'slz-task-paths-fixture', name)
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

function computer(id: string) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), `task-paths-${id}-`))
  const pc = createChatRuntimeHandlers({
    stateDir: dir,
    hubScope: 'hub',
    computerId: () => id,
    getProjectPaths: () => null,
    ctx: {
      config: {
        hubUrl: 'ws://hub/computers',
        name: id,
        allowedRoots: [realpathSync(tmpdir())],
        capabilities: ['proc']
      },
      dialer: { notify: () => true },
      log: () => {}
    }
  } as never)
  cleanups.push(async () => {
    await pc.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return pc
}

async function fixture() {
  const h = await createTestHarness()
  cleanups.push(() => h.cleanup())
  h.db.exec(`INSERT INTO projects(id,name,color) VALUES('p','Project','#000');
    INSERT INTO computers(id,name,platform,version,capabilities_json,created_at) VALUES('pc','pc','linux','1','{}',0),('pc2','pc2','linux','1','{}',0);
    INSERT INTO tasks(id,project_id,title,computer_id) VALUES('t1','p','One','pc'),('parent','p','Parent','pc'),('child','p','Child','pc');`)
  const pcs = { pc: computer('pc'), pc2: computer('pc2') }
  const online = new Set(['pc', 'pc2'])
  const request = async (computerId: string, req: unknown) => {
    if (!online.has(computerId)) throw Object.assign(new Error('offline'), { code: 'ECONNRESET' })
    return pcs[computerId as 'pc' | 'pc2'].request(JSON.parse(JSON.stringify(req)))
  }
  const handoff = createComputerDataHandoff({
    db: h.slayDb,
    request,
    isUnreachable: (error) => (error as { code?: string }).code === 'ECONNRESET',
    kindTargets: { [TASK_PATH_KIND]: taskPathTarget(h.slayDb) }
  })
  const paths = createComputerTaskPaths({
    db: h.slayDb,
    targetOf: handoff.targetOf,
    flushTask: handoff.flushTask,
    usable: (id) => online.has(id),
    request,
    log: () => {}
  })
  const onComputer = async (computerId: 'pc' | 'pc2', taskIds: string[]) =>
    pcs[computerId].request({ kind: 'taskPaths', value: { op: 'get', taskIds } })
  const staged = () =>
    h.db
      .prepare("SELECT item_key FROM computer_data_handoff WHERE kind='task-path' ORDER BY 1")
      .all()
  /**
   * A hub write of a task's paths (§9 7e): the hub records only whether each is set;
   * the values travel with the change to the computer holding the task's folders.
   */
  const set = async (taskId: string, worktree: string | null, base: string | null = null) => {
    h.db
      .prepare('UPDATE tasks SET has_worktree=?, has_base_dir=? WHERE id=?')
      .run(worktree ? 1 : 0, base ? 1 : 0, taskId)
    await paths.changed(taskId, { op: 'set', worktreePath: worktree, baseDir: base })
  }
  /** The hub's flags changed with no write reaching any computer (drift). */
  const flagOnly = (taskId: string, worktree: boolean) =>
    h.db.prepare('UPDATE tasks SET has_worktree=? WHERE id=?').run(worktree ? 1 : 0, taskId)
  return { h, pcs, online, request, handoff, paths, onComputer, staged, set, flagOnly }
}

test('a write runs on the connected computer; nothing is staged', async () => {
  const f = await fixture()
  await f.set('t1', W('w-one'), W('base'))
  expect(await f.onComputer('pc', ['t1'])).toEqual([
    expect.objectContaining({
      taskId: 't1',
      projectId: 'p',
      worktreePath: W('w-one'),
      baseDir: W('base')
    })
  ])
  expect(f.staged()).toEqual([])
})

test('offline: staged, then delivered on connect; a later live write is never rolled back', async () => {
  const f = await fixture()
  f.online.delete('pc')
  await f.set('t1', W('w-offline'))
  expect(f.staged()).toEqual([{ item_key: 't1' }])
  f.online.add('pc')
  await f.handoff.deliverTo('pc')
  expect(f.staged()).toEqual([])
  expect(await f.onComputer('pc', ['t1'])).toEqual([
    expect.objectContaining({ worktreePath: W('w-offline') })
  ])
  // A newer live write, then the same old row delivered again (a lost ack): newest stays.
  await f.set('t1', W('w-live'))
  await f.pcs.pc.request({
    kind: 'data.import',
    value: {
      kind: 'task-path',
      items: [
        {
          key: 't1',
          taskId: 't1',
          value: { projectId: 'p', worktreePath: W('w-offline'), baseDir: null, at: 1 }
        }
      ]
    }
  })
  expect(await f.onComputer('pc', ['t1'])).toEqual([
    expect.objectContaining({ worktreePath: W('w-live') })
  ])
})

test("a subtask's computer copies its parent's paths; archive clears them", async () => {
  const f = await fixture()
  await f.set('parent', W('w-shared'), W('b'))
  // The hub copies only the flags; the computer copies its own row.
  f.h.db.prepare('UPDATE tasks SET has_worktree=1, has_base_dir=1 WHERE id=?').run('child')
  await f.paths.changed('child', { op: 'inherit', parentTaskId: 'parent' })
  expect(await f.onComputer('pc', ['child'])).toEqual([
    expect.objectContaining({ worktreePath: W('w-shared'), baseDir: W('b') })
  ])
  f.h.db.prepare('UPDATE tasks SET has_worktree=0, has_base_dir=0 WHERE id=?').run('child')
  await f.paths.changed('child', { op: 'clear' })
  expect(await f.onComputer('pc', ['child'])).toEqual([
    expect.objectContaining({ worktreePath: null, baseDir: null })
  ])
})

test('the worktree computer holds the paths, not the task computer', async () => {
  const f = await fixture()
  f.h.db.exec("UPDATE tasks SET worktree_computer_id='pc2' WHERE id='t1'")
  await f.set('t1', W('w-on-pc2'))
  expect(await f.onComputer('pc2', ['t1'])).toEqual([
    expect.objectContaining({ worktreePath: W('w-on-pc2') })
  ])
  expect(await f.onComputer('pc', ['t1'])).toEqual([])
  // Staged while pc2 is offline: pc connecting takes nothing, pc2 connecting takes it.
  f.online.delete('pc2')
  await f.set('t1', W('w-later'))
  await f.handoff.deliverTo('pc')
  expect(f.staged()).toEqual([{ item_key: 't1' }])
  f.online.add('pc2')
  await f.handoff.deliverTo('pc2')
  expect(f.staged()).toEqual([])
})

test('consistency: a hub flag the computer does not back is reported', async () => {
  const f = await fixture()
  await f.set('t1', W('w-one'))
  const rules = async () =>
    (await checkComputerChatConsistency(f.h.slayDb, f.request, 'pc')).map((v) => v.rule)
  expect(await rules()).not.toContain('task-path-flag-drift')
  // The hub says "no worktree" while the computer holds one, nothing staged: drift.
  f.flagOnly('t1', false)
  expect(await rules()).toContain('task-path-flag-drift')
  // Staged for delivery: not drift (it is on its way).
  f.online.delete('pc')
  await f.set('t1', null)
  f.online.add('pc')
  expect(await rules()).not.toContain('task-path-flag-drift')
  await f.handoff.deliverTo('pc')
  expect(await rules()).not.toContain('task-path-flag-drift')
})

test("the hub's own disk: its computer reports its tasks' folders; away, it answers nothing", async () => {
  const f = await fixture()
  await f.set('t1', W('w-one'), W('base'))
  const deps = { db: f.h.slayDb, request: f.request, usable: (id: string) => f.online.has(id) }
  expect(await readComputerTaskRoots(deps, 'pc')).toEqual([
    { taskId: 't1', root: W('w-one') },
    { taskId: 't1', root: W('base') }
  ])
  // A task placed on another computer is not this computer's to report.
  expect(await readComputerTaskRoots(deps, 'pc2')).toEqual([])
  f.online.delete('pc')
  await expect(readComputerTaskRoots(deps, 'pc')).rejects.toThrow(/not connected/)
})

test('read (§9 7d): from each holding computer, staged rows first; away = offline, never the hub column', async () => {
  const f = await fixture()
  await f.set('t1', W('w-one'), W('base'))
  // `parent` was staged while its computer was away: the read delivers it first and
  // answers what the COMPUTER holds (the hub keeps only flags, §9 7e).
  f.online.delete('pc')
  await f.set('parent', W('w-parent'))
  expect(await f.paths.read(['t1', 'parent'])).toEqual({
    t1: { state: 'offline', computerId: 'pc' },
    parent: { state: 'offline', computerId: 'pc' }
  })
  f.online.add('pc')
  expect(await f.paths.read(['t1', 'parent', 'child'])).toEqual({
    t1: { state: 'ok', worktreePath: W('w-one'), baseDir: W('base') },
    parent: { state: 'ok', worktreePath: W('w-parent'), baseDir: null },
    child: { state: 'ok', worktreePath: null, baseDir: null }
  })
  expect(f.staged()).toEqual([])
})

test('read flushes only the task-path row: the open task never waits for any task’s history', async () => {
  const f = await fixture()
  f.online.delete('pc')
  await f.set('t1', W('w-one'))
  f.h.db
    .prepare(
      `INSERT INTO computer_data_handoff(kind,item_key,task_id,payload,created_at)
       VALUES('agent-prompt','p1','t1',?,0)`
    )
    .run(
      JSON.stringify({
        id: 'p1',
        agentId: 'claude-code',
        cliSessionId: null,
        text: 'x',
        createdAt: 1
      })
    )
  f.online.add('pc')
  expect(await f.paths.read(['t1'])).toEqual({
    t1: { state: 'ok', worktreePath: W('w-one'), baseDir: null }
  })
  expect(f.h.db.prepare('SELECT kind FROM computer_data_handoff ORDER BY kind').all()).toEqual([
    { kind: 'agent-prompt' }
  ])
})

test('read: one task failing its handoff is offline on its own; the batch’s others answer', async () => {
  const f = await fixture()
  await f.set('t1', W('w-one'))
  const paths = createComputerTaskPaths({
    db: f.h.slayDb,
    targetOf: f.handoff.targetOf,
    flushTask: async (taskId, computerId, kinds) => {
      if (taskId === 'parent') throw new Error('parent breaks')
      return f.handoff.flushTask(taskId, computerId, kinds)
    },
    usable: (id) => f.online.has(id),
    request: f.request,
    log: () => {}
  })
  expect(await paths.read(['t1', 'parent', 'child'])).toEqual({
    t1: { state: 'ok', worktreePath: W('w-one'), baseDir: null },
    parent: { state: 'offline', computerId: 'pc' },
    child: { state: 'ok', worktreePath: null, baseDir: null }
  })
})

test('S3: a process restarted on connect finds its staged worktree on the computer', async () => {
  const f = await fixture()
  f.online.delete('pc')
  await f.set('t1', W('w-restart'))
  f.online.add('pc')
  // The gateway's beforeRequest: the one place task paths reach the computer first.
  const gate = createTaskPathRequestGate({
    flushTaskPaths: (taskId, computerId) =>
      f.handoff.flushTask(taskId, computerId, [TASK_PATH_KIND])
  })
  let seen: unknown = null
  const spawn = async (computerId: 'pc', params: { taskId: string }) => {
    await gate(computerId, HubToComputerMethods.procSpawn, params)
    // What the computer judges the spawn's cwd against, when the spawn arrives.
    seen = await f.onComputer(computerId, [params.taskId])
  }
  // Before the reconnect handoff ran (processesComputerConnected spawns at once).
  await spawn('pc', { taskId: 't1' })
  expect(seen).toEqual([expect.objectContaining({ taskId: 't1', worktreePath: W('w-restart') })])
  expect(f.staged()).toEqual([])
})

test("a path given as '' is unset: no '' ever reaches a computer, live or staged (p10)", async () => {
  const f = await fixture()
  // Live: `changed` and `apply` on the connected computer.
  await f.set('t1', W('w-one'), W('base'))
  await f.paths.changed('t1', { op: 'set', worktreePath: '', baseDir: '' })
  expect(await f.onComputer('pc', ['t1'])).toEqual([
    expect.objectContaining({ taskId: 't1', worktreePath: null, baseDir: null })
  ])
  await f.set('t1', W('w-one'))
  await f.paths.apply('t1', { worktreePath: '' })
  expect(await f.onComputer('pc', ['t1'])).toEqual([
    expect.objectContaining({ taskId: 't1', worktreePath: null })
  ])
  // Staged while away, then delivered on reconnect.
  await f.set('parent', W('w-parent'), W('b-parent'))
  f.online.delete('pc')
  await f.paths.changed('parent', { op: 'set', worktreePath: '', baseDir: '' })
  const row = f.h.db
    .prepare(
      "SELECT payload FROM computer_data_handoff WHERE kind='task-path' AND item_key='parent'"
    )
    .get() as { payload: string }
  expect(JSON.parse(row.payload)).toMatchObject({ worktreePath: null, baseDir: null })
  f.online.add('pc')
  await f.handoff.flushTask('parent', 'pc')
  expect(f.staged()).toEqual([])
  expect(await f.onComputer('pc', ['parent'])).toEqual([
    expect.objectContaining({ taskId: 'parent', worktreePath: null, baseDir: null })
  ])
})
