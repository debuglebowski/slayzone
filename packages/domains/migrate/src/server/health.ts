import type { Database } from 'better-sqlite3'
import { MIGRATE_PROTOCOL_VERSION, type HealthInfo } from '../shared'

export function getHealth(db: Database, slayzoneVersion: string): HealthInfo {
  const schemaUserVersion = db.pragma('user_version', { simple: true }) as number
  return {
    slayzoneVersion,
    schemaUserVersion,
    isEmpty: isEmptyServer(db),
    protocolVersion: MIGRATE_PROTOCOL_VERSION,
  }
}

export function isEmptyServer(db: Database): boolean {
  const tablesPresent = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('tasks','projects')")
    .all() as Array<{ name: string }>
  if (tablesPresent.length === 0) return true
  for (const { name } of tablesPresent) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }
    if (row.n > 0) return false
  }
  return true
}
