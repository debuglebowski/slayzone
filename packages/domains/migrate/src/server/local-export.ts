import {
  createReadStream,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { migrateEvents } from './events'
import { packArchive } from './archive'
import {
  DEFAULT_MAX_CHUNK_BYTES,
  type Manifest,
  type MigrateReceipt,
  PRUNE_SETTINGS_KEYS,
  SKIP_TABLES,
} from '../shared'

export interface RemoteClient {
  health(): Promise<{ slayzoneVersion: string; schemaUserVersion: number; isEmpty: boolean; protocolVersion: number }>
  preflight(): Promise<{ uploadId: string; maxChunkBytes: number; maxArchiveBytes: number }>
  uploadAppend(input: { uploadId: string; seq: number; data: string; sha256: string }): Promise<void>
  uploadFinalize(input: {
    uploadId: string
    manifest: Manifest
    archiveSha256: string
    archiveBytes: number
    dryRun: boolean
  }): Promise<MigrateReceipt>
  cancel(input: { uploadId: string }): Promise<void>
}

export interface LocalExportOptions {
  db: Database
  dataRoot: string
  slayzoneVersion: string
  remote: RemoteClient
  dryRun: boolean
  /** Override for tests / explicit chunk size; default = remote's reported max. */
  chunkBytes?: number
}

interface TableCounts {
  [table: string]: number
}

function listExportableTables(db: Database): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>
  return rows.map((r) => r.name).filter((n) => !SKIP_TABLES.has(n) && !n.endsWith('_new'))
}

function countTableRows(db: Database, tables: string[]): TableCounts {
  const out: TableCounts = {}
  for (const t of tables) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM "${t.replaceAll('"', '""')}"`).get() as { n: number }
    out[t] = row.n
  }
  return out
}

export async function runLocalExport(opts: LocalExportOptions): Promise<MigrateReceipt> {
  const tmpUploadId = randomUUID()
  const stagingDir = join(opts.dataRoot, 'migrations-tmp', `local-${tmpUploadId}`)
  mkdirSync(stagingDir, { recursive: true })

  const dbSnapshotPath = join(stagingDir, 'db.sqlite')
  const archiveOut = join(stagingDir, 'archive.tar')
  const manifestOut = join(stagingDir, 'manifest.json')

  const cleanup = (): void => {
    try {
      if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }

  let remoteUploadId: string | null = null

  try {
    // 1. Remote health + version match.
    migrateEvents.emit('progress', {
      uploadId: tmpUploadId,
      phase: 'preflight',
      percent: 0,
      message: 'checking remote server',
    })
    const health = await opts.remote.health()
    const localUserVersion = opts.db.pragma('user_version', { simple: true }) as number
    if (!health.isEmpty) {
      throw new Error('Destination server is not empty — refusing migration')
    }
    if (health.schemaUserVersion !== localUserVersion) {
      throw new Error(
        `Schema version mismatch (local user_version=${localUserVersion}, remote=${health.schemaUserVersion}). Upgrade both sides to the same version.`,
      )
    }

    // 2. Snapshot DB.
    migrateEvents.emit('progress', {
      uploadId: tmpUploadId,
      phase: 'preflight',
      percent: 0.1,
      message: 'snapshotting local database',
    })
    snapshotDatabase(opts.db, dbSnapshotPath)

    // 3. Pre-flight on remote — get uploadId + caps.
    const remotePre = await opts.remote.preflight()
    remoteUploadId = remotePre.uploadId

    // 4. Pack archive.
    migrateEvents.emit('progress', {
      uploadId: remoteUploadId,
      phase: 'preflight',
      percent: 0.3,
      message: 'packing archive',
    })
    const tables = listExportableTables(opts.db)
    const tableCounts = countTableRows(opts.db, tables)
    const { manifest, archiveSha256, archiveBytes } = await packArchive({
      dbSnapshotPath,
      dataRoot: opts.dataRoot,
      outArchivePath: archiveOut,
      outManifestPath: manifestOut,
      hostname: hostname(),
      slayzoneVersion: opts.slayzoneVersion,
      schemaUserVersion: localUserVersion,
      tables: tableCounts,
    })

    // 5. Stream chunks.
    const chunkBytes = Math.min(
      opts.chunkBytes ?? remotePre.maxChunkBytes,
      remotePre.maxChunkBytes,
      DEFAULT_MAX_CHUNK_BYTES,
    )
    if (archiveBytes > remotePre.maxArchiveBytes) {
      throw new Error(
        `Archive (${archiveBytes} bytes) exceeds remote cap (${remotePre.maxArchiveBytes})`,
      )
    }
    let seq = 0
    let bytesSent = 0
    await streamChunks(archiveOut, chunkBytes, async (buf) => {
      const sha = createHash('sha256').update(buf).digest('hex')
      await opts.remote.uploadAppend({
        uploadId: remoteUploadId!,
        seq,
        data: buf.toString('base64'),
        sha256: sha,
      })
      bytesSent += buf.byteLength
      const pct = archiveBytes === 0 ? 1 : bytesSent / archiveBytes
      migrateEvents.emit('progress', {
        uploadId: remoteUploadId!,
        phase: 'uploading',
        percent: pct,
        message: `chunk ${seq + 1} (${bytesSent}/${archiveBytes} bytes)`,
      })
      seq += 1
    })

    // 6. Finalize.
    migrateEvents.emit('progress', {
      uploadId: remoteUploadId,
      phase: 'committing',
      percent: 0,
      message: opts.dryRun ? 'awaiting remote dry-run' : 'awaiting remote commit',
    })
    const receipt = await opts.remote.uploadFinalize({
      uploadId: remoteUploadId,
      manifest,
      archiveSha256,
      archiveBytes,
      dryRun: opts.dryRun,
    })

    migrateEvents.emit('progress', {
      uploadId: remoteUploadId,
      phase: 'done',
      percent: 1,
      message: receipt.dryRun ? 'dry-run complete' : 'migration complete',
    })

    void PRUNE_SETTINGS_KEYS // re-export of constant; not used here

    return receipt
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    migrateEvents.emit('progress', {
      uploadId: remoteUploadId ?? tmpUploadId,
      phase: 'error',
      percent: 0,
      message,
    })
    if (remoteUploadId) {
      try {
        await opts.remote.cancel({ uploadId: remoteUploadId })
      } catch {
        /* best-effort */
      }
    }
    throw err
  } finally {
    cleanup()
  }
}

function snapshotDatabase(db: Database, outPath: string): void {
  // VACUUM INTO produces a clean (no WAL) point-in-time copy. Better than a raw file
  // copy because it's transactionally consistent and de-fragmented.
  db.exec(`VACUUM INTO '${outPath.replaceAll("'", "''")}'`)
  if (!existsSync(outPath)) {
    throw new Error('VACUUM INTO did not produce a snapshot file')
  }
  const stat = statSync(outPath)
  if (stat.size === 0) throw new Error('Snapshot is empty')
}

async function streamChunks(
  filePath: string,
  chunkBytes: number,
  onChunk: (buf: Buffer) => Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, { highWaterMark: chunkBytes })
    let pending: Buffer = Buffer.alloc(0)
    let processing = Promise.resolve()
    let errored = false

    const flush = async (): Promise<void> => {
      while (pending.byteLength >= chunkBytes) {
        const chunk = pending.subarray(0, chunkBytes)
        pending = pending.subarray(chunkBytes)
        await onChunk(chunk)
      }
    }

    stream.on('data', (chunk) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      pending = Buffer.concat([pending, buf])
      processing = processing.then(() => {
        stream.pause()
        return flush().then(
          () => {
            if (!errored) stream.resume()
          },
          (err) => {
            errored = true
            stream.destroy(err as Error)
            reject(err)
          },
        )
      })
    })

    stream.on('end', () => {
      processing = processing.then(async () => {
        if (errored) return
        if (pending.byteLength > 0) {
          await onChunk(pending)
          pending = Buffer.alloc(0)
        }
        resolve()
      })
    })

    stream.on('error', (err) => {
      errored = true
      reject(err)
    })
  })
}
