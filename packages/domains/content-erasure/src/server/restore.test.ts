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
import { eraseContent, exportErasureReceipt } from './index'
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
