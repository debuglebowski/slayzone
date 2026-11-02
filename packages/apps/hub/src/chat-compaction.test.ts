import Database from 'better-sqlite3'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createSlayzoneDbAdapter } from '../../../shared/test-utils/ipc-harness'
import { createChatCompaction } from './chat-compaction'

test('privacy compaction removes pre-feature freed pages and runs once per cleanup generation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-compaction-'))
  const path = join(dir, 'hub.sqlite'),
    raw = new Database(path)
  try {
    raw.exec(
      'PRAGMA secure_delete=OFF; CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE old_content(value TEXT)'
    )
    const marker = 'private-pre-feature-freed-page-marker'
    raw.prepare('INSERT INTO old_content VALUES(?)').run(marker.repeat(200))
    raw.exec('DELETE FROM old_content')
    expect(readFileSync(path).includes(Buffer.from(marker))).toBe(true)
    const db = createSlayzoneDbAdapter(raw)
    let vacuums = 0
    const compaction = createChatCompaction({
      ...db,
      exec: async (sql) => {
        if (sql === 'VACUUM') vacuums++
        await db.exec(sql)
      }
    })
    await Promise.all([compaction.run(), compaction.run()])
    expect(readFileSync(path).includes(Buffer.from(marker))).toBe(false)
    await compaction.run()
    expect(vacuums).toBe(1)
    raw.exec("UPDATE settings SET value='2' WHERE key='computer_chat_compaction_generation'")
    await compaction.run()
    expect(vacuums).toBe(2)
  } finally {
    raw.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
