import type { DbLike } from './db'

/** Opaque durable consumers may outlive an original or mutable version row. */
export function ensureArtifactBlobPins(db: DbLike): void {
  db.prepare(`CREATE TABLE IF NOT EXISTS artifact_blob_pins(
    scope TEXT NOT NULL,owner_id TEXT NOT NULL,token TEXT NOT NULL,reference_key TEXT NOT NULL,
    task_id TEXT NOT NULL,artifact_id TEXT NOT NULL,owner_epoch INTEGER NOT NULL,
    content_hash TEXT NOT NULL,size INTEGER NOT NULL,
    PRIMARY KEY(scope,owner_id,token,reference_key)
  )`).run()
  db.prepare(
    'CREATE INDEX IF NOT EXISTS artifact_blob_pins_hash ON artifact_blob_pins(content_hash)'
  ).run()
  db.prepare(
    'CREATE TABLE IF NOT EXISTS artifact_blob_leases(id TEXT PRIMARY KEY,expires_at INTEGER NOT NULL)'
  ).run()
  db.prepare(
    'CREATE TABLE IF NOT EXISTS artifact_blob_gc_pending(id INTEGER PRIMARY KEY CHECK(id=1))'
  ).run()
  db.prepare(
    'CREATE TABLE IF NOT EXISTS artifact_blob_gc_generation(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL)'
  ).run()
  db.prepare('INSERT OR IGNORE INTO artifact_blob_gc_generation VALUES(1,0)').run()
  db.prepare(`CREATE TRIGGER IF NOT EXISTS artifact_blob_gc_requested BEFORE INSERT ON artifact_blob_gc_pending
    BEGIN UPDATE artifact_blob_gc_generation SET version=version+1 WHERE id=1; END`).run()
}

export function hasArtifactBlobLeases(db: DbLike): boolean {
  for (const table of ['artifact_blob_leases', 'blob_leases'])
    if (
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) &&
      db.prepare(`SELECT 1 FROM ${table} WHERE expires_at>? LIMIT 1`).get(Date.now())
    )
      return true
  return false
}

export function requestArtifactBlobGc(db: DbLike): void {
  ensureArtifactBlobPins(db)
  db.prepare('INSERT OR IGNORE INTO artifact_blob_gc_pending VALUES(1)').run()
}

export function artifactBlobReferenceSql(db: DbLike): string {
  const pins = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifact_blob_pins'")
    .get()
  return (
    'SELECT content_hash FROM artifact_versions' +
    (pins ? ' UNION SELECT content_hash FROM artifact_blob_pins' : '')
  )
}

export function referencedArtifactBlobHashes(db: DbLike): Set<string> {
  return new Set(
    (db.prepare(artifactBlobReferenceSql(db)).all() as Array<{ content_hash: string }>).map(
      (row) => row.content_hash
    )
  )
}
