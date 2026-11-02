import Database from 'better-sqlite3'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SlayzoneDb } from '@slayzone/platform'
import type {} from './artifact-store-txns'

export const HUB_BACKUP_PIN_SCOPE = 'hub-backup'
const TTL = 300_000
interface Ref {
  hash: string
  size: number
  taskId: string
  artifactId: string
}
export interface ArtifactBackupProtection {
  prepare(): Promise<void>
  begin(filename: string): Promise<{
    pinSnapshot(path: string): Promise<void>
    finish(published: boolean): Promise<void>
  }>
  forget(filename: string): Promise<void>
  close(): Promise<void>
}

/** Completed snapshots own their hashes independently of mutable live versions.
 * Their refs are rebuilt from disk after a hub restore; backup pins themselves
 * are excluded so each snapshot retains only its own content, not older backups.
 */
export function createArtifactBackupProtection(
  db: SlayzoneDb,
  dataRoot: string,
  isBackup: (name: string) => boolean
): ArtifactBackupProtection {
  const dir = join(dataRoot, 'backups'),
    guard = `hub-backup-recovery:${randomUUID()}`
  const inspected = new Map<string, string>()
  let closed = false,
    pending: Promise<void> | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  const leaseId = (name: string) => `hub-backup:${name}`
  const lease = (id: string) =>
    db.run(
      'INSERT INTO artifact_blob_leases(id,expires_at) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET expires_at=excluded.expires_at',
      [id, Date.now() + TTL]
    )
  function schedule(delay = 30_000) {
    if (closed || retry) return
    retry = setTimeout(() => {
      retry = null
      void prepare()
    }, delay)
    retry.unref()
  }
  async function collect() {
    await db.run('INSERT OR IGNORE INTO artifact_blob_gc_pending VALUES(1)')
    try {
      if ((await db.namedTxn('task-artifacts:blobs:collect', { dataDir: dataRoot })).deferred)
        schedule()
    } catch {
      // The durable marker retries cleanup; a failed GC must not turn a valid
      // completed backup into a reported failure.
      schedule()
    }
  }
  function references(path: string): Ref[] {
    const snapshot = new Database(path, { readonly: true, fileMustExist: true })
    try {
      const tables = new Set(
        (
          snapshot.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
            name: string
          }>
        ).map((r) => r.name)
      )
      const refs = new Map<string, Ref>()
      const remember = (row: Ref) => {
        if (!/^[a-f0-9]{64}$/.test(row.hash) || !Number.isSafeInteger(row.size) || row.size < 0)
          throw new Error('Invalid backup artifact reference')
        refs.set(row.hash, row)
      }
      if (tables.has('artifact_versions') && tables.has('task_artifacts'))
        for (const row of snapshot
          .prepare(`SELECT v.content_hash AS hash,v.size,a.task_id AS taskId,a.id AS artifactId
          FROM artifact_versions v JOIN task_artifacts a ON a.id=v.artifact_id`)
          .iterate() as Iterable<Ref>)
          remember(row)
      if (tables.has('artifact_blob_pins'))
        for (const row of snapshot
          .prepare(`SELECT content_hash AS hash,size,task_id AS taskId,artifact_id AS artifactId
          FROM artifact_blob_pins WHERE scope<>?`)
          .iterate(HUB_BACKUP_PIN_SCOPE) as Iterable<Ref>)
          remember(row)
      return [...refs.values()]
    } finally {
      snapshot.close()
    }
  }
  async function pin(filename: string, path: string) {
    const stat = statSync(path),
      signature = `${stat.size}:${stat.mtimeMs}`
    if (inspected.get(filename) === signature) return
    const refs = references(path)
    await db.run('DELETE FROM artifact_blob_pins WHERE scope=? AND owner_id=?', [
      HUB_BACKUP_PIN_SCOPE,
      filename
    ])
    for (let offset = 0; offset < refs.length; offset += 500)
      await db.batchTxn(
        refs.slice(offset, offset + 500).map((r) => ({
          type: 'run' as const,
          sql: 'INSERT INTO artifact_blob_pins VALUES(?,?,?,?,?,?,?,?,?)',
          params: [
            HUB_BACKUP_PIN_SCOPE,
            filename,
            filename,
            r.hash,
            r.taskId,
            r.artifactId,
            0,
            r.hash,
            r.size
          ]
        }))
      )
    inspected.set(filename, signature)
  }
  function prepare(): Promise<void> {
    if (closed) return Promise.resolve()
    if (pending) return pending
    pending = (async () => {
      // Queue the guard before any async snapshot reads. Composition creates
      // this service before migration GC, so restored snapshots cannot lose
      // their blobs while their opaque pins are being reconstructed.
      await lease(guard)
      const renew = setInterval(() => {
        void lease(guard).catch(() => {
          schedule()
        })
      }, 60_000)
      renew.unref()
      let complete = false
      try {
        const files = new Set(existsSync(dir) ? readdirSync(dir).filter(isBackup) : [])
        for (const filename of files) await pin(filename, join(dir, filename))
        const owners = await db.all<{ owner_id: string }>(
          'SELECT DISTINCT owner_id FROM artifact_blob_pins WHERE scope=?',
          [HUB_BACKUP_PIN_SCOPE]
        )
        for (const owner of owners)
          if (!files.has(owner.owner_id)) {
            const active = await db.get(
              'SELECT 1 FROM artifact_blob_leases WHERE id=? AND expires_at>?',
              [leaseId(owner.owner_id), Date.now()]
            )
            if (active) {
              schedule(TTL)
              continue
            }
            // Publication can finish after this pass's file census and remove
            // its lease before the query above. Recheck the durable pathname.
            const published = join(dir, owner.owner_id)
            if (existsSync(published)) {
              await pin(owner.owner_id, published)
              continue
            }
            await db.run('DELETE FROM artifact_blob_pins WHERE scope=? AND owner_id=?', [
              HUB_BACKUP_PIN_SCOPE,
              owner.owner_id
            ])
            inspected.delete(owner.owner_id)
          }
        complete = true
      } catch {
        // Keep the guard if a snapshot cannot be inspected. Operators can still
        // list/delete it; content GC waits for a successful reconciliation.
        console.error('[artifact-backups] snapshot inspection failed; blob cleanup deferred')
        schedule()
      } finally {
        clearInterval(renew)
        if (complete) await db.run('DELETE FROM artifact_blob_leases WHERE id=?', [guard])
      }
      if (complete) await collect()
    })().finally(() => {
      pending = null
    })
    return pending
  }
  return {
    prepare,
    async begin(filename) {
      if (closed) throw new Error('Backup protection is closed')
      await prepare()
      const id = leaseId(filename)
      await lease(id)
      let renewalFailed = false
      const renew = setInterval(() => {
        void lease(id).catch(() => {
          renewalFailed = true
        })
      }, 60_000)
      renew.unref()
      let finished = false
      return {
        pinSnapshot: async (path) => {
          if (renewalFailed) throw new Error('Backup blob lease renewal failed; retry backup')
          await lease(id)
          await pin(filename, path)
        },
        async finish(published) {
          if (finished) return
          finished = true
          clearInterval(renew)
          if (!published) {
            inspected.delete(filename)
            await db.run('DELETE FROM artifact_blob_pins WHERE scope=? AND owner_id=?', [
              HUB_BACKUP_PIN_SCOPE,
              filename
            ])
          }
          await db.run('DELETE FROM artifact_blob_leases WHERE id=?', [id])
          await collect()
        }
      }
    },
    async forget(filename) {
      // A pass that already read this file may still be inserting its pins.
      // Let it finish before removing the owner and taking a fresh census.
      await pending
      inspected.delete(filename)
      await db.run('DELETE FROM artifact_blob_pins WHERE scope=? AND owner_id=?', [
        HUB_BACKUP_PIN_SCOPE,
        filename
      ])
      await prepare()
    },
    async close() {
      closed = true
      if (retry) clearTimeout(retry)
      await pending
      // A failed inspection intentionally retains its bounded recovery guard.
      // Do not expose unknown snapshot refs to queued GC before DB shutdown.
    }
  }
}
