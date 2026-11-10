import Database from 'better-sqlite3'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { migrations } from '@slayzone/db-migrations'
import {
  createTestHarness,
  createSlayzoneDbAdapter,
  type TestHarness
} from '../../../../shared/test-utils/ipc-harness'
import { eraseContent, exportErasureReceipt, resumeErasure } from './index'
import type { ErasureReceipt } from '../shared'
const fixtures: TestHarness[] = []
afterEach(() => {
  for (const h of fixtures.splice(0)) h.cleanup()
})

test('erasure compacts live SQLite/WAL bytes; an external receipt can guide manual erasure of a restored snapshot', async () => {
  const h = await createTestHarness()
  fixtures.push(h)
  const root = h.tmpDir(),
    vault = h.tmpDir(),
    path = join(root, 'main.sqlite'),
    snapshot = join(vault, 'pre-erasure.sqlite')
  const secret = 'ERASURE-PRIVATE-MARKER-7420d5d9',
    retained = 'RETAINED-BOB-MARKER-b66c'
  for (const [id, title] of [
    ['alice', secret],
    ['bob', retained]
  ]) {
    h.db
      .prepare('INSERT INTO projects(id,name,color,owner_user_id) VALUES(?,?,?,?)')
      .run('p-' + id, 'Project', '#000', id)
    h.db
      .prepare('INSERT INTO tasks(id,project_id,title,description) VALUES(?,?,?,?)')
      .run('t-' + id, 'p-' + id, title, title.repeat(200))
  }
  await h.db.backup(path)
  copyFileSync(path, snapshot)
  let raw = new Database(path)
  raw.pragma('journal_mode=WAL')
  let db = createSlayzoneDbAdapter(raw)
  try {
    raw.prepare("UPDATE tasks SET description=? WHERE id='t-alice'").run(secret.repeat(300))
    const report = await eraseContent(db, root, { kind: 'user', userId: 'alice' })
    expect(report.state).toBe('complete')
    const receiptPath = join(vault, 'erasure.json')
    writeFileSync(receiptPath, JSON.stringify(await exportErasureReceipt(db, report.id)))
    for (const file of [path, path + '-wal'])
      if (existsSync(file)) expect(readFileSync(file).includes(Buffer.from(secret))).toBe(false)
    expect(raw.prepare("SELECT title FROM tasks WHERE id='t-bob'").get()).toEqual({
      title: retained
    })
    raw.close()
    // The old snapshot really restores old content. Access remains closed while
    // the operator reapplies the external receipt, as the documented runbook requires.
    copyFileSync(snapshot, path)
    raw = new Database(path)
    raw.pragma('journal_mode=WAL')
    db = createSlayzoneDbAdapter(raw)
    expect(raw.prepare("SELECT title FROM tasks WHERE id='t-alice'").get()).toEqual({
      title: secret
    })
    mkdirSync(join(root, 'artifacts', 't-alice'), { recursive: true })
    writeFileSync(join(root, 'artifacts', 't-alice', 'restored.txt'), secret)
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as ErasureReceipt
    const reapplied = await eraseContent(db, root, receipt.scope)
    expect(reapplied.state).toBe('complete')
    expect(existsSync(join(root, 'artifacts', 't-alice'))).toBe(false)
    expect(raw.prepare("SELECT id FROM tasks WHERE id='t-alice'").get()).toBeUndefined()
    expect(raw.prepare("SELECT title FROM tasks WHERE id='t-bob'").get()).toEqual({
      title: retained
    })
  } finally {
    if (raw.open) raw.close()
  }
})

test('upgrading migration 197 preserves old Trash as Archive without reactivating it', () => {
  const raw = new Database(':memory:')
  try {
    for (const migration of migrations.filter((m) => m.version <= 197)) migration.up(raw)
    raw.prepare("INSERT INTO projects(id,name,color) VALUES('p','Project','#000')").run()
    raw
      .prepare(
        "INSERT INTO tasks(id,project_id,title,deleted_at) VALUES('t','p','Recoverable content','2026-10-01 12:00:00')"
      )
      .run()
    const attachmentHash = 'a'.repeat(64)
    raw
      .prepare('INSERT INTO chat_attachment_messages(task_id,message_id,attachments) VALUES(?,?,?)')
      .run(
        't',
        'legacy-message',
        JSON.stringify([{ artifactId: 'legacy-file', contentHash: attachmentHash }])
      )
    migrations.find((m) => m.version === 198)!.up(raw)
    expect(
      raw.prepare("SELECT title,archived_at,deleted_at FROM tasks WHERE id='t'").get()
    ).toEqual({
      title: 'Recoverable content',
      archived_at: '2026-10-01 12:00:00',
      deleted_at: null
    })
    expect(raw.prepare("SELECT state FROM chat_task_lifecycle WHERE task_id='t'").get()).toEqual({
      state: 'paused'
    })
    expect(
      raw
        .prepare(
          "SELECT task_id,content_hash FROM artifact_blob_pins WHERE scope='legacy-chat-reference'"
        )
        .all()
    ).toEqual([{ task_id: 't', content_hash: attachmentHash }])
  } finally {
    raw.close()
  }
})

/** The worktree's computer acknowledges its task's erasure. */
const ackFrom = (raw: Database.Database) => async (request: { taskIds: string[] }) =>
  request.taskIds.map((taskId) => ({
    taskId,
    revision: (
      raw.prepare('SELECT revision FROM chat_task_lifecycle WHERE task_id=?').get(taskId) as {
        revision: number
      }
    ).revision,
    erased: true as const
  }))

async function worktreeFixture() {
  const h = await createTestHarness()
  fixtures.push(h)
  const root = h.tmpDir(),
    path = join(root, 'worktree-erasure.sqlite')
  const secret = 'PRIVATE-WORKTREE-TITLE-d2e50bc1'
  h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','Project','#000')").run()
  // A located worktree: its computer and that computer's project folder are known.
  h.db
    .prepare(
      "INSERT INTO computers(id,name,platform,version,capabilities_json,created_at) VALUES('c','Computer','darwin','1','[]',1)"
    )
    .run()
  h.db
    .prepare(
      "INSERT INTO project_placements(computer_id,project_id,root_path,status,updated_at) VALUES('c','p',?,'ready',1)"
    )
    .run(join(root, 'repo'))
  h.db
    .prepare(
      "INSERT INTO tasks(id,project_id,title,has_worktree,worktree_computer_id) VALUES(?,?,?,1,'c')"
    )
    .run('t', 'p', secret)
  await h.db.backup(path)
  const raw = new Database(path)
  raw.pragma('journal_mode=WAL')
  return { raw, root, path, secret }
}

test('completed worktree cleanup leaves no private path in SQLite or historical WAL frames', async () => {
  const { raw, root, path, secret } = await worktreeFixture()
  try {
    const db = createSlayzoneDbAdapter(raw)
    const report = await eraseContent(
      db,
      root,
      { kind: 'tasks', ids: ['t'] },
      {
        cleanupComputer: ackFrom(raw),
        // The computer holding the worktree names it (the hub keeps no path, §9 7e).
        releaseWorktree: async () => ({ worktreePath: join(root, secret), shared: false }),
        cleanupWorktree: async () => {}
      }
    )
    expect(report.state).toBe('complete')
    for (const file of [path, path + '-wal'])
      if (existsSync(file)) expect(readFileSync(file).includes(Buffer.from(secret))).toBe(false)
  } finally {
    raw.close()
  }
})

test('a failed final compaction stays incomplete and resumes after restart without repeating worktree removal', async () => {
  const fixture = await worktreeFixture()
  let raw = fixture.raw
  let removals = 0,
    compactions = 0
  try {
    const db = createSlayzoneDbAdapter(raw),
      original = db.namedTxn.bind(db)
    db.namedTxn = ((name, params) => {
      if (name === 'content-erasure:compact' && ++compactions === 2)
        throw new Error('CHECKPOINT_BUSY')
      return original(name, params)
    }) as typeof db.namedTxn
    const report = await eraseContent(
      db,
      fixture.root,
      { kind: 'tasks', ids: ['t'] },
      {
        cleanupComputer: ackFrom(raw),
        // The computer holding the worktree names it (the hub keeps no path, §9 7e).
        releaseWorktree: async () => ({
          worktreePath: join(fixture.root, fixture.secret),
          shared: false
        }),
        cleanupWorktree: async () => {
          removals++
        }
      }
    )
    expect(report.state).toBe('incomplete')
    expect(report.failures).toContain('DATABASE_HISTORY_NOT_COMPACTED')
    raw.close()
    raw = new Database(fixture.path)
    raw.pragma('journal_mode=WAL')
    const resumed = await resumeErasure(createSlayzoneDbAdapter(raw), fixture.root, report.id)
    expect(resumed.state).toBe('complete')
    expect(removals).toBe(1)
    for (const file of [fixture.path, fixture.path + '-wal'])
      if (existsSync(file))
        expect(readFileSync(file).includes(Buffer.from(fixture.secret))).toBe(false)
  } finally {
    if (raw.open) raw.close()
  }
})
