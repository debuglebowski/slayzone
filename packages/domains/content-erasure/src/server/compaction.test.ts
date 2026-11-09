import Database from 'better-sqlite3'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import {
  createSlayzoneDbAdapter,
  createTestHarness,
  type TestHarness
} from '../../../../shared/test-utils/ipc-harness'
import { isErasureDoneOrCompacting } from '../shared'
import {
  configureContentErasure,
  eraseContent,
  flushErasureCompaction,
  getErasureReport,
  resumeErasure,
  startErasureRetries
} from './index'

const fixtures: TestHarness[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const h of fixtures.splice(0)) h.cleanup()
})

async function fixture() {
  const h = await createTestHarness()
  fixtures.push(h)
  const root = h.tmpDir()
  for (const owner of ['alice', 'bob']) {
    h.db
      .prepare('INSERT INTO projects(id,name,color,owner_user_id) VALUES(?,?,?,?)')
      .run(`project-${owner}`, `${owner} private project`, '#000000', owner)
    h.db
      .prepare('INSERT INTO tasks(id,project_id,title,description) VALUES(?,?,?,?)')
      .run(`task-${owner}`, `project-${owner}`, `${owner} title`, `${owner} private description`)
    h.db
      .prepare('INSERT INTO task_artifacts(id,task_id,title) VALUES(?,?,?)')
      .run(`artifact-${owner}`, `task-${owner}`, `${owner}.txt`)
    const dir = join(root, 'artifacts', `task-${owner}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `artifact-${owner}.txt`), `${owner} original`)
  }
  return { h, root }
}

/** Counts real VACUUM statements on a connection: the cost this suite is about. */
function countVacuums(raw: Database.Database): () => number {
  let n = 0
  const exec = raw.exec.bind(raw)
  raw.exec = ((sql: string) => {
    if (/^\s*VACUUM\b/i.test(sql)) n++
    return exec(sql)
  }) as typeof raw.exec
  return () => n
}

function computer(h: TestHarness, id: string, taskIds: string[]) {
  h.db
    .prepare(
      'INSERT INTO computers(id,name,platform,version,capabilities_json,created_at,owner_user_id) VALUES(?,?,?,?,?,?,?)'
    )
    .run(id, `${id} name`, 'darwin', 'fixture', '[]', Date.now(), 'alice')
  for (const taskId of taskIds)
    h.db.prepare('INSERT INTO chat_task_computers VALUES(?,?)').run(taskId, id)
}
const revisionOf = (h: TestHarness, taskId: string) =>
  (
    h.db.prepare('SELECT revision FROM chat_task_lifecycle WHERE task_id=?').get(taskId) as {
      revision: number
    }
  ).revision

/** Real timers stay for setImmediate: lets promise chains settle under fake timers. */
const settle = async () => {
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve))
}
const FAKE = { toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }

test('deferred compaction: deletes return without a VACUUM; one VACUUM covers the burst; completion follows it', async () => {
  const { h, root } = await fixture()
  const vacuums = countVacuums(h.db)
  configureContentErasure(h.slayDb, { compaction: { quietMs: 60_000, maxDelayMs: 600_000 } })
  h.db
    .prepare(
      "INSERT INTO tasks(id,project_id,title) VALUES('task-alice-2','project-alice','second')"
    )
    .run()
  const reports = [
    await eraseContent(h.slayDb, root, { kind: 'tasks', ids: ['task-alice'] }),
    await eraseContent(h.slayDb, root, { kind: 'tasks', ids: ['task-alice-2'] }),
    await eraseContent(h.slayDb, root, { kind: 'artifacts', ids: ['artifact-bob'] })
  ]
  expect(vacuums()).toBe(0)
  for (const report of reports) {
    // Not complete: the database file's free space still holds the content.
    expect(report.state).toBe('incomplete')
    expect(report.failures).toEqual([])
    expect(report.compactionPending).toBe(true)
    expect(isErasureDoneOrCompacting(report)).toBe(true)
  }
  expect(h.db.prepare("SELECT 1 FROM tasks WHERE id='task-alice'").get()).toBeUndefined()
  expect(existsSync(join(root, 'artifacts', 'task-alice'))).toBe(false)
  await flushErasureCompaction(h.slayDb)
  expect(vacuums()).toBe(1)
  for (const report of reports) {
    const after = await getErasureReport(h.slayDb, report.id)
    expect(after.state).toBe('complete')
    expect(after.compactionPending).toBeFalsy()
  }
})

test('deferred compaction waits for a quiet period, bounded by a maximum delay', async () => {
  vi.useFakeTimers(FAKE as never)
  const { h, root } = await fixture()
  const vacuums = countVacuums(h.db)
  configureContentErasure(h.slayDb, { compaction: { quietMs: 1_000, maxDelayMs: 2_500 } })
  for (let i = 0; i < 6; i++)
    h.db
      .prepare('INSERT INTO tasks(id,project_id,title) VALUES(?,?,?)')
      .run(`burst-${i}`, 'project-alice', `burst ${i}`)
  await eraseContent(h.slayDb, root, { kind: 'tasks', ids: ['burst-0'] })
  await vi.advanceTimersByTimeAsync(900)
  await eraseContent(h.slayDb, root, { kind: 'tasks', ids: ['burst-1'] })
  await vi.advanceTimersByTimeAsync(900)
  await settle()
  expect(vacuums()).toBe(0)
  await vi.advanceTimersByTimeAsync(200)
  await settle()
  expect(vacuums()).toBe(1)
  // A steady stream never lets the quiet period pass; the maximum delay still runs it.
  for (let i = 2; i < 6; i++) {
    await eraseContent(h.slayDb, root, { kind: 'tasks', ids: [`burst-${i}`] })
    expect(vacuums()).toBe(1)
    await vi.advanceTimersByTimeAsync(800)
    await settle()
  }
  expect(vacuums()).toBe(2)
})

test('deferred compaction removes the free-space and WAL copies before reporting completion', async () => {
  const h = await createTestHarness()
  fixtures.push(h)
  const root = h.tmpDir(),
    path = join(root, 'main.sqlite'),
    secret = 'DEFERRED-ERASURE-MARKER-31c7'
  h.db
    .prepare("INSERT INTO projects(id,name,color,owner_user_id) VALUES('p','Project','#000','a')")
    .run()
  h.db
    .prepare("INSERT INTO tasks(id,project_id,title,description) VALUES('t','p','title',?)")
    .run(secret.repeat(200))
  await h.db.backup(path)
  const raw = new Database(path)
  raw.pragma('journal_mode=WAL')
  try {
    const db = createSlayzoneDbAdapter(raw)
    configureContentErasure(db, { compaction: { quietMs: 60_000, maxDelayMs: 600_000 } })
    // An earlier edit leaves the old text in free space, outside any live row.
    raw.prepare("UPDATE tasks SET description=? WHERE id='t'").run(secret.repeat(300))
    const report = await eraseContent(db, root, { kind: 'tasks', ids: ['t'] })
    expect(report.state).toBe('incomplete')
    const contains = () =>
      [path, path + '-wal'].some(
        (file) => existsSync(file) && readFileSync(file).includes(Buffer.from(secret))
      )
    expect(contains()).toBe(true)
    await flushErasureCompaction(db)
    expect((await getErasureReport(db, report.id)).state).toBe('complete')
    expect(contains()).toBe(false)
  } finally {
    raw.close()
  }
})

test('a failed deferred compaction is reported and the next run completes the job', async () => {
  const { h, root } = await fixture()
  const original = h.slayDb.namedTxn.bind(h.slayDb)
  let failNext = true
  h.slayDb.namedTxn = ((name, params) => {
    if (name === 'content-erasure:compact' && failNext) {
      failNext = false
      throw new Error('CHECKPOINT_BUSY')
    }
    return original(name, params)
  }) as typeof h.slayDb.namedTxn
  configureContentErasure(h.slayDb, { compaction: { quietMs: 60_000, maxDelayMs: 600_000 } })
  const report = await eraseContent(h.slayDb, root, { kind: 'tasks', ids: ['task-alice'] })
  await flushErasureCompaction(h.slayDb)
  const failed = await getErasureReport(h.slayDb, report.id)
  expect(failed.state).toBe('incomplete')
  expect(failed.failures).toContain('DATABASE_HISTORY_NOT_COMPACTED')
  expect(isErasureDoneOrCompacting(failed)).toBe(false)
  await flushErasureCompaction(h.slayDb)
  expect((await getErasureReport(h.slayDb, report.id)).state).toBe('complete')
})

test('a failing diagnostic step retries alone: file cleanup and hub compaction are not repeated', async () => {
  const { h, root } = await fixture()
  const vacuums = countVacuums(h.db)
  let removals = 0,
    diagnostics = 0,
    diagnosticCompactions = 0
  const failing = {
    compactAdditionalStores: async () => {
      diagnosticCompactions++
    },
    removePath: (file: string) => {
      removals++
      rmSync(file, { recursive: true, force: true })
    },
    cleanupAdditionalStores: async () => {
      diagnostics++
      throw new Error('LEGACY_DIAGNOSTICS_NEED_OWNERSHIP_REVIEW')
    }
  }
  const report = await eraseContent(h.slayDb, root, { kind: 'tasks', ids: ['task-alice'] }, failing)
  expect(report.failures).toContain('LEGACY_DIAGNOSTICS_NEED_OWNERSHIP_REVIEW')
  // The hub's rows are gone: its file is compacted even while diagnostics wait.
  expect(vacuums()).toBe(1)
  const firstRemovals = removals
  for (let i = 0; i < 3; i++) await resumeErasure(h.slayDb, root, report.id, failing)
  expect(diagnostics).toBe(4)
  expect(removals).toBe(firstRemovals)
  expect(vacuums()).toBe(1)
  const beforeSuccess = diagnosticCompactions
  const done = await resumeErasure(h.slayDb, root, report.id, {
    ...failing,
    cleanupAdditionalStores: async () => {
      diagnostics++
    }
  })
  expect(done.state).toBe('complete')
  // The successful diagnostic deletion is compacted in its own store before completion;
  // the hub database, untouched since its VACUUM, is not rewritten again.
  expect(diagnosticCompactions).toBe(beforeSuccess + 1)
  expect(vacuums()).toBe(1)
  expect(removals).toBe(firstRemovals)
})

test('retries re-send only to computers and tasks that have not confirmed', async () => {
  const { h, root } = await fixture()
  h.db
    .prepare(
      "INSERT INTO tasks(id,project_id,title) VALUES('task-alice-2','project-alice','second')"
    )
    .run()
  computer(h, 'c1', ['task-alice', 'task-alice-2'])
  computer(h, 'c2', ['task-alice'])
  const calls: Array<{ computerId: string; taskIds: string[] }> = []
  let c1Calls = 0
  const options = {
    cleanupComputer: async (request: { jobId: string; computerId: string; taskIds: string[] }) => {
      calls.push({ computerId: request.computerId, taskIds: [...request.taskIds].sort() })
      if (request.computerId === 'c2') throw new Error('COMPUTER_UNAVAILABLE')
      // The first time c1 only manages one of its tasks.
      const done = ++c1Calls === 1 ? ['task-alice'] : request.taskIds
      return done.map((taskId) => ({
        taskId,
        revision: revisionOf(h, taskId),
        erased: true as const
      }))
    }
  }
  const report = await eraseContent(
    h.slayDb,
    root,
    { kind: 'tasks', ids: ['task-alice', 'task-alice-2'] },
    options
  )
  expect(report.state).toBe('incomplete')
  expect(calls).toEqual([
    { computerId: 'c1', taskIds: ['task-alice', 'task-alice-2'] },
    { computerId: 'c2', taskIds: ['task-alice'] }
  ])
  calls.length = 0
  await resumeErasure(h.slayDb, root, report.id, options)
  expect(calls).toEqual([
    { computerId: 'c1', taskIds: ['task-alice-2'] },
    { computerId: 'c2', taskIds: ['task-alice'] }
  ])
  calls.length = 0
  const again = await resumeErasure(h.slayDb, root, report.id, options)
  expect(calls).toEqual([{ computerId: 'c2', taskIds: ['task-alice'] }])
  expect(again.computers).toEqual([
    expect.objectContaining({ id: 'c1', deleted: true }),
    expect.objectContaining({ id: 'c2', deleted: false })
  ])
})

test('periodic retries back off exponentially for a job that keeps failing; a manual retry is not held back', async () => {
  vi.useFakeTimers(FAKE as never)
  const { h, root } = await fixture()
  computer(h, 'offline', ['task-alice'])
  let attempts = 0
  configureContentErasure(h.slayDb, {
    cleanupComputer: async () => {
      attempts++
      throw new Error('COMPUTER_UNAVAILABLE')
    }
  })
  await eraseContent(h.slayDb, root, { kind: 'tasks', ids: ['task-alice'] })
  expect(attempts).toBe(1)
  const retries = startErasureRetries(h.slayDb, root)
  try {
    await settle()
    expect(attempts).toBe(2)
    await vi.advanceTimersByTimeAsync(30_000)
    await settle()
    expect(attempts).toBe(3)
    await vi.advanceTimersByTimeAsync(30_000)
    await settle()
    expect(attempts).toBe(3)
    await vi.advanceTimersByTimeAsync(30_000)
    await settle()
    expect(attempts).toBe(4)
    await vi.advanceTimersByTimeAsync(60_000)
    await settle()
    expect(attempts).toBe(4)
    // Reconnect / manual retry is a new opportunity, never delayed by the backoff.
    await retries.retry()
    expect(attempts).toBe(5)
  } finally {
    await retries.close()
  }
})
