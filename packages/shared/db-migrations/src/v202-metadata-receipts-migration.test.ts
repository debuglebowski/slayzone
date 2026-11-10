/**
 * v202: chat metadata receipts, store id on the metadata cursor, and the
 * "unavailable on computer" mark on computer-held file locations.
 */
import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { staleContentErasureFences } from './content-erasure-fences'
import { migrations, runMigrations } from './index'

const columns = (db: Database.Database, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)

describe('v202: metadata receipts', () => {
  test('migrations 200-203 are contiguous', () => {
    const versions = migrations.map((m) => m.version).filter((v) => v >= 200)
    expect(versions.slice(0, 4)).toEqual([200, 201, 202, 203])
  })

  test('adds receipts, store id and unavailable marks', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    expect(staleContentErasureFences(db)).toEqual([])
    expect(columns(db, 'chat_metadata_receipts')).toEqual([
      'conversation_id',
      'operation_id',
      'sequence',
      'acked'
    ])
    expect(columns(db, 'chat_metadata_progress')).toContain('store_id')
    for (const t of ['chat_artifact_locations', 'chat_folder_locations'])
      expect(columns(db, t)).toEqual(
        expect.arrayContaining(['unavailable_reason', 'unavailable_since'])
      )
  })
})
