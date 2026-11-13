import Database from 'better-sqlite3'
import { randomUUID, createHash } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  lstatSync,
  existsSync,
  renameSync,
  rmSync,
  openSync,
  closeSync,
  readSync,
  chmodSync,
  fsyncSync
} from 'node:fs'
import { fsyncFile } from '@slayzone/platform/durable-fs'
import {
  asItemDamage,
  classifyFault,
  forEachIsolated,
  forEachIsolatedSync,
  isStorageFatal,
  StructuralFaultError
} from '@slayzone/platform/isolation'
import {
  eraseQuarantinedForTask,
  fileFingerprint,
  quarantineMove
} from '@slayzone/platform/quarantine'
import { basename, join, resolve, sep } from 'node:path'
import { createReadStream, promises as fsAsync } from 'node:fs'
import { z } from 'zod'
import type {
  ComputerChatBackup,
  ComputerChatArchive,
  ComputerChatBackupPolicy,
  AgentEvent,
  ChatAttachment
} from '@slayzone/terminal-contracts'
import { CHAT_STORAGE_SCHEMA_VERSION, type ChatStorage } from './storage'
import { captureArtifactWorkingFiles } from './artifact-backup'
import { eventAttachmentReferences, recordAttachmentReferences } from './attachment-references'
import { prepareStoredTaskErasure, finishStoredTaskErasure } from './erase-stored-task'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const activeBackupStaging = new Set<string>()

function collectAbandonedStaging(root: string) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const match = /^\.pending-(?:(\d+)-)?([a-f0-9-]{36})$/.exec(entry.name)
    if (!match || !UUID.test(match[2])) continue
    const path = join(root, entry.name)
    if (activeBackupStaging.has(path)) continue
    const pid = match[1] ? Number(match[1]) : null
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0)
        continue
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue
      }
    }
    // Unpublished legacy directories have no PID. Host handover has already
    // stopped their old writer before this per-hub service can be opened.
    rmSync(path, { recursive: true, force: true })
  }
}
interface FileEntry {
  path: string
  hash: string
  size: number
}
interface Manifest {
  version: 1 | 2
  artifactFiles?: number
  workingFiles?: number
  scope: string
  backup: ComputerChatBackup
  files: FileEntry[]
}
const backupSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['manual', 'auto']),
  createdAt: z.number().finite().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
  events: z.number().int().nonnegative(),
  conversations: z.number().int().nonnegative(),
  deferredConversations: z.number().int().nonnegative().optional(),
  readOnlyRestore: z.literal(true),
  providerResumable: z.literal(false)
})
const archiveSchema = z.object({
  id: z.string().uuid(),
  backupId: z.string().uuid(),
  createdAt: z.number().finite().nonnegative(),
  readOnly: z.literal(true),
  providerResumable: z.literal(false)
})
const hashFile = (path: string) => {
  const hash = createHash('sha256'),
    fd = openSync(path, 'r'),
    buffer = Buffer.allocUnsafe(256 * 1024)
  try {
    let n: number
    while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, n))
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}
function fileWithin(root: string, relative: string) {
  if (!relative || relative.split(/[\\/]/).some((p) => !p || p === '.' || p === '..'))
    throw new Error('Invalid backup path')
  const path = resolve(root, relative)
  if (!path.startsWith(root + sep)) throw new Error('Invalid backup path')
  let parent = root
  for (const part of relative.split(/[\\/]/)) {
    parent = join(parent, part)
    if (lstatSync(parent).isSymbolicLink()) throw new Error('Backup symlinks are not allowed')
  }
  if (!lstatSync(path).isFile()) throw new Error('Backup entry is not a file')
  return path
}
async function hashFileAsync(path: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
async function syncDir(path: string) {
  if (process.platform === 'win32') return
  const fd = await fsAsync.open(path, 'r')
  try {
    await fd.sync()
  } finally {
    await fd.close()
  }
}
async function copyDurable(source: string, dest: string) {
  await fsAsync.copyFile(source, dest)
  await fsAsync.chmod(dest, 0o600)
  await fsyncFile(dest)
  await syncDir(resolve(dest, '..'))
}
function durableJson(path: string, value: unknown) {
  const fd = openSync(path, 'wx', 0o600)
  try {
    writeFileSync(fd, JSON.stringify(value))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Online SQLite snapshot + immutable referenced blobs. Restore never opens a live runtime. */
/** Quarantine pass of restored archives that can no longer be read. */
export const ARCHIVE_QUARANTINE_PASS = 'chat-archive'
const isMissingFile = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'

export function createChatBackups(store: ChatStorage, options: { automatic?: boolean } = {}) {
  const dir = join(store.dir, 'backups'),
    archiveDir = join(store.dir, 'archives'),
    scope = basename(store.dir)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  mkdirSync(archiveDir, { recursive: true, mode: 0o700 })
  collectAbandonedStaging(dir)
  collectAbandonedStaging(archiveDir)
  const folder = (root: string, id: string) => {
    if (!UUID.test(id)) throw new Error('Invalid backup id')
    const path = join(root, id)
    if (existsSync(path) && lstatSync(path).isSymbolicLink())
      throw new Error('Backup symlinks are not allowed')
    return path
  }
  function manifest(root: string, id: string): Manifest {
    const path = folder(root, id),
      value = z
        .object({
          version: z.union([z.literal(1), z.literal(2)]),
          artifactFiles: z.number().int().nonnegative().optional(),
          workingFiles: z.number().int().nonnegative().optional(),
          scope: z.literal(scope),
          backup: backupSchema,
          files: z.array(
            z.object({
              path: z.string().min(1),
              hash: z.string().regex(/^[a-f0-9]{64}$/),
              size: z.number().int().nonnegative()
            })
          )
        })
        .parse(JSON.parse(readFileSync(fileWithin(path, 'manifest.json'), 'utf8')))
    if (
      (root === dir && value.backup.id !== id) ||
      new Set(value.files.map((f) => f.path)).size !== value.files.length ||
      (value.version === 2 &&
        (value.artifactFiles === undefined || value.workingFiles === undefined))
    )
      throw new Error('Backup scope or format mismatch')
    return value
  }
  function descriptor(root: string, id: string) {
    return manifest(root, id).backup
  }
  function archiveDescriptor(id: string): ComputerChatArchive {
    const path = folder(archiveDir, id),
      value = archiveSchema.parse(
        JSON.parse(readFileSync(fileWithin(path, 'archive.json'), 'utf8'))
      )
    if (value.id !== id || value.backupId !== manifest(archiveDir, id).backup.id)
      throw new Error('Archive descriptor mismatch')
    return value
  }
  async function verifyContent(m: Manifest, path: string) {
    if (!m.files.some((f) => f.path === 'chat.sqlite'))
      throw new Error('Backup database is missing')
    for (const file of m.files) {
      const actual = fileWithin(path, file.path)
      if (
        !/^[a-f0-9]{64}$/.test(file.hash) ||
        statSync(actual).size !== file.size ||
        (await hashFileAsync(actual)) !== file.hash
      )
        throw new Error('Backup hash integrity failure')
    }
    const db = new Database(fileWithin(path, 'chat.sqlite'), {
      readonly: true,
      fileMustExist: true
    })
    try {
      if (db.pragma('quick_check', { simple: true }) !== 'ok')
        throw new Error('Backup database integrity failure')
      if ((db.pragma('foreign_key_check') as unknown[]).length)
        throw new Error('Backup reference integrity failure')
      const version = db.pragma('user_version', { simple: true }) as number
      if (version < 2 || version > CHAT_STORAGE_SCHEMA_VERSION)
        throw new Error('Unsupported backup database schema')
      // Integrity/FKs alone do not prove that the archive reader can open its data.
      db.prepare('SELECT id,task_id,tab_id,mode,epoch,state FROM conversations LIMIT 0').all()
      db.prepare('SELECT conversation_id,seq,saved_at,event FROM events LIMIT 0').all()
      db.prepare('SELECT conversation_id,kind,id,value,saved_at FROM records LIMIT 0').all()
      db.prepare('SELECT conversation_id,id,hash,state,result FROM receipts LIMIT 0').all()
      if (
        db
          .prepare(`SELECT 1 FROM events WHERE NOT json_valid(event) OR
        json_type(event)<>'object' OR COALESCE(json_type(event,'$.kind'),'')<>'text' OR
        seq<0 OR typeof(seq)<>'integer' OR typeof(saved_at)<>'integer' LIMIT 1`)
          .get() ||
        db.prepare('SELECT 1 FROM records WHERE NOT json_valid(value) LIMIT 1').get() ||
        db.prepare('SELECT 1 FROM receipts WHERE NOT json_valid(result) LIMIT 1').get()
      )
        throw new Error('Backup content JSON integrity failure')
      const files = new Map(m.files.map((file) => [file.path, file]))
      function requireBlob(relative: string, hash: string, size: number) {
        const file = files.get(relative)
        if (!/^[a-f0-9]{64}$/.test(hash) || !file || file.hash !== hash || file.size !== size)
          throw new Error('Backup blob reference is missing or invalid')
      }
      for (const row of db
        .prepare("SELECT value FROM records WHERE kind='attachment'")
        .iterate() as Iterable<{ value: string }>) {
        const ref = JSON.parse(row.value) as ChatAttachment
        requireBlob(`blobs/${ref.contentHash}`, ref.contentHash ?? '', ref.size)
      }
      const pins =
        db.prepare(`SELECT value FROM records WHERE conversation_id=? AND kind='attachment'
        AND json_extract(value,'$.artifactId')=? AND (? IS NULL OR json_extract(value,'$.contentHash')=?)`)
      const checked = new Set<string>()
      function verifyReferences(conversationId: string, refs: ChatAttachment[]) {
        for (const ref of refs) {
          const key = JSON.stringify([conversationId, ref])
          if (checked.has(key)) continue
          const matches = (
            pins.all(
              conversationId,
              ref.artifactId,
              ref.contentHash ?? null,
              ref.contentHash ?? null
            ) as Array<{ value: string }>
          ).map((row) => JSON.parse(row.value) as ChatAttachment)
          if (
            new Set(matches.map((pin) => pin.contentHash)).size !== 1 ||
            !matches.length ||
            matches[0].size !== ref.size ||
            matches[0].kind !== ref.kind ||
            matches[0].mediaType !== ref.mediaType
          )
            throw new Error('Backup attachment reference has no unambiguous owning pin')
          checked.add(key)
        }
      }
      for (const row of db
        .prepare(`SELECT conversation_id,event FROM events
        WHERE json_extract(event,'$.kind')='user-message'`)
        .iterate() as Iterable<{ conversation_id: string; event: string }>)
        verifyReferences(
          row.conversation_id,
          eventAttachmentReferences(JSON.parse(row.event) as AgentEvent)
        )
      for (const row of db
        .prepare(`SELECT conversation_id,kind,id,value FROM records WHERE
        kind IN ('draft','queue') OR (kind='settings' AND id GLOB 'attachment-message:*')`)
        .iterate() as Iterable<{
        conversation_id: string
        kind: 'draft' | 'queue' | 'settings'
        id: string
        value: string
      }>)
        verifyReferences(
          row.conversation_id,
          recordAttachmentReferences({ ...row, value: JSON.parse(row.value) })
        )
      const artifactTables = ['artifact_versions', 'task_artifacts', 'artifact_owners'].map(
        (name) =>
          !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
      )
      if (artifactTables.some(Boolean) && !artifactTables.every(Boolean))
        throw new Error('Backup artifact schema is incomplete')
      const hasWorking = !!db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifact_working_files'")
        .get()
      if (m.version === 2) {
        if (artifactTables.every(Boolean)) {
          if (!hasWorking) throw new Error('Backup working originals table is missing')
          const count = (
            db.prepare("SELECT count(*) n FROM artifact_owners WHERE kind='artifact'").get() as {
              n: number
            }
          ).n
          const working = (
            db.prepare('SELECT count(*) n FROM artifact_working_files').get() as { n: number }
          ).n
          if (count !== m.artifactFiles || working !== m.workingFiles)
            throw new Error('Backup original file inventory is incomplete')
        } else if (m.artifactFiles || m.workingFiles)
          throw new Error('Backup original file schema is missing')
      }
      if (
        artifactTables.every(Boolean) &&
        db
          .prepare(`SELECT 1 FROM task_artifacts a
        JOIN artifact_owners o ON o.id=a.id AND o.kind='artifact'
        WHERE NOT EXISTS(SELECT 1 FROM artifact_versions v WHERE v.artifact_id=a.id)
        ${hasWorking ? 'AND NOT EXISTS(SELECT 1 FROM artifact_working_files w WHERE w.artifact_id=a.id)' : ''} LIMIT 1`)
          .get()
      )
        throw new Error('Backup artifact has no recoverable version or working original')
      if (artifactTables.every(Boolean))
        for (const row of db
          .prepare('SELECT content_hash,size FROM artifact_versions')
          .iterate() as Iterable<{ content_hash: string; size: number }>)
          requireBlob(
            `blobs/${row.content_hash.slice(0, 2)}/${row.content_hash.slice(2)}`,
            row.content_hash,
            row.size
          )
      if (hasWorking)
        for (const row of db
          .prepare('SELECT content_hash,size FROM artifact_working_files')
          .iterate() as Iterable<{ content_hash: string; size: number }>)
          requireBlob(
            `blobs/${row.content_hash.slice(0, 2)}/${row.content_hash.slice(2)}`,
            row.content_hash,
            row.size
          )
    } finally {
      db.close()
    }
    return m
  }
  async function verify(root: string, id: string) {
    return verifyContent(manifest(root, id), folder(root, id))
  }
  const pending = new Map<string, Promise<ComputerChatBackup>>()
  const restoring = new Map<string, { backupId: string; work: Promise<ComputerChatArchive> }>()
  const restorePins = new Map<string, number>()
  let closed = false,
    timer: ReturnType<typeof setTimeout> | null = null
  const settingsPath = join(dir, 'settings.json')
  type Policy = ComputerChatBackupPolicy
  let policy: Policy = { autoEnabled: false, intervalMinutes: 60, maxAutoBackups: 10 }
  try {
    if (existsSync(settingsPath)) {
      const value = JSON.parse(readFileSync(settingsPath, 'utf8'))
      if (
        typeof value.autoEnabled === 'boolean' &&
        Number.isSafeInteger(value.intervalMinutes) &&
        value.intervalMinutes >= 15 &&
        Number.isSafeInteger(value.maxAutoBackups) &&
        value.maxAutoBackups >= 0
      )
        policy = value
    }
  } catch {
    /* Invalid backup preferences must not block readable chat history. */
  }
  function list() {
    return readdirSync(dir)
      .filter((id) => UUID.test(id))
      .map((id) => {
        try {
          return descriptor(dir, id)
        } catch {
          return {
            id,
            kind: 'manual' as const,
            createdAt: lstatSync(join(dir, id)).mtimeMs,
            sizeBytes: 0,
            events: 0,
            conversations: 0,
            readOnlyRestore: true as const,
            providerResumable: false as const,
            error: 'Backup manifest is invalid'
          }
        }
      })
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
  }
  async function create(
    kind: 'manual' | 'auto' = 'manual',
    id: string = randomUUID()
  ): Promise<ComputerChatBackup> {
    if (closed) throw new Error('Backup service is closed')
    const target = folder(dir, id)
    if (existsSync(target)) {
      await verify(dir, id)
      return descriptor(dir, id)
    }
    const running = pending.get(id)
    if (running) return running
    const work = (async () => {
      const temp = join(dir, `.pending-${process.pid}-${randomUUID()}`)
      mkdirSync(temp, { mode: 0o700 })
      const lease = store.acquireBlobLease(id, 60_000),
        renew = setInterval(() => store.acquireBlobLease(id, 60_000), 20_000)
      renew.unref()
      activeBackupStaging.add(temp)
      let originals: Awaited<ReturnType<typeof captureArtifactWorkingFiles>> | undefined
      try {
        originals = await captureArtifactWorkingFiles(store, join(temp, '.working'))
        await store.backupTo(join(temp, 'chat.sqlite'))
        chmodSync(join(temp, 'chat.sqlite'), 0o600)
        const db = new Database(join(temp, 'chat.sqlite'), { fileMustExist: true }),
          refs = new Set<string>(),
          sources = new Map<string, string>()
        let events = 0,
          conversations = 0,
          deferredConversations = 0,
          artifactFiles = 0,
          workingFiles = 0
        try {
          // An unfinished migration is recoverable at its source, not from a
          // half-received destination. Defer it without disabling healthy backups.
          db.pragma('secure_delete = ON')
          deferredConversations = (
            db.prepare("SELECT count(*) AS n FROM conversations WHERE state='prepared'").get() as {
              n: number
            }
          ).n
          db.transaction(() => {
            for (const table of ['events', 'records', 'receipts'])
              db.prepare(
                `DELETE FROM ${table} WHERE conversation_id IN(SELECT id FROM conversations WHERE state='prepared')`
              ).run()
            db.prepare(
              "DELETE FROM migration_checkpoints WHERE json_extract(identity,'$.id') IN(SELECT id FROM conversations WHERE state='prepared')"
            ).run()
            db.prepare("DELETE FROM conversations WHERE state='prepared'").run()
          })()
          for (const file of originals.apply(db)) {
            refs.add(file.path)
            sources.set(file.path, file.source)
          }
          if (
            db
              .prepare(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifact_working_files'"
              )
              .get()
          ) {
            artifactFiles = (
              db.prepare("SELECT count(*) n FROM artifact_owners WHERE kind='artifact'").get() as {
                n: number
              }
            ).n
            workingFiles = (
              db.prepare('SELECT count(*) n FROM artifact_working_files').get() as { n: number }
            ).n
          }
          events = (db.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n
          conversations = (
            db
              .prepare(
                "SELECT count(*) AS n FROM conversations WHERE state<>'deleted' AND task_id NOT LIKE '\\_\\_%' ESCAPE '\\'"
              )
              .get() as { n: number }
          ).n
          for (const row of db
            .prepare("SELECT value FROM records WHERE kind='attachment'")
            .iterate() as Iterable<{ value: string }>) {
            const ref = JSON.parse(row.value) as ChatAttachment
            if (!ref.contentHash || !/^[a-f0-9]{64}$/.test(ref.contentHash))
              throw new Error('Backup attachment hash is missing')
            refs.add(`blobs/${ref.contentHash}`)
          }
          if (
            db
              .prepare(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifact_versions'"
              )
              .get()
          )
            for (const row of db
              .prepare('SELECT DISTINCT content_hash FROM artifact_versions')
              .iterate() as Iterable<{ content_hash: string }>) {
              if (!/^[a-f0-9]{64}$/.test(row.content_hash))
                throw new Error('Backup artifact hash is invalid')
              refs.add(`blobs/${row.content_hash.slice(0, 2)}/${row.content_hash.slice(2)}`)
            }
        } finally {
          db.close()
        }
        await fsyncFile(join(temp, 'chat.sqlite'))
        const files: FileEntry[] = [
          {
            path: 'chat.sqlite',
            hash: await hashFileAsync(join(temp, 'chat.sqlite')),
            size: statSync(join(temp, 'chat.sqlite')).size
          }
        ]
        for (const relative of [...refs].sort()) {
          const source = sources.get(relative) ?? fileWithin(store.dir, relative),
            destination = join(temp, relative)
          mkdirSync(resolve(destination, '..'), { recursive: true, mode: 0o700 })
          await copyDurable(source, destination)
          const hash = await hashFileAsync(destination),
            expected = relative.slice(6).replace('/', '')
          if (hash !== expected) throw new Error('Backup blob hash integrity failure')
          files.push({ path: relative, hash, size: statSync(destination).size })
        }
        const backup: ComputerChatBackup = {
          id,
          kind,
          createdAt: Date.now(),
          sizeBytes: files.reduce((n, f) => n + f.size, 0),
          events,
          conversations,
          deferredConversations,
          readOnlyRestore: true,
          providerResumable: false
        }
        const complete = {
          version: 2,
          artifactFiles,
          workingFiles,
          scope,
          backup,
          files
        } satisfies Manifest
        await verifyContent(complete, temp)
        originals.dispose()
        durableJson(join(temp, 'manifest.json'), complete)
        await syncDir(temp)
        renameSync(temp, target)
        await syncDir(dir)
        return backup
      } catch (error) {
        rmSync(temp, { recursive: true, force: true })
        throw error
      } finally {
        try {
          originals?.dispose()
        } finally {
          activeBackupStaging.delete(temp)
          clearInterval(renew)
          lease.release()
        }
      }
    })().finally(() => {
      pending.delete(id)
    })
    pending.set(id, work)
    return work
  }
  function schedule() {
    if (timer) clearTimeout(timer)
    timer = null
    if (closed || options.automatic === false || !policy.autoEnabled) return
    const last = list().find((b) => b.kind === 'auto')?.createdAt ?? 0
    const delay = Math.max(1000, last + policy.intervalMinutes * 60_000 - Date.now())
    timer = setTimeout(() => {
      void create('auto')
        .then(() => {
          // One old backup that cannot be removed is recorded and retried next run;
          // the rest of the rotation still happens.
          if (policy.maxAutoBackups > 0)
            forEachIsolatedSync(
              list()
                .filter((b) => b.kind === 'auto')
                .slice(policy.maxAutoBackups)
                .filter((b) => !restorePins.has(b.id)),
              {
                pass: 'chat-backup-rotation',
                key: (item) => item.id,
                ledger: store.faults,
                isFatal: isStorageFatal
              },
              (item) => rmSync(folder(dir, item.id), { recursive: true, force: true })
            )
        })
        .catch(() => {
          // Keep the previous verified backups; the next scheduled run retries.
        })
        .finally(schedule)
    }, delay)
    timer.unref()
  }
  schedule()
  const api = {
    dir,
    archiveDir,
    create,
    list,
    delete(id: string) {
      if (pending.has(id)) throw new Error('Backup is in progress')
      if (restorePins.has(id)) throw new Error('Backup restore is in progress')
      rmSync(folder(dir, id), { recursive: true, force: true })
    },
    settings: () => ({ ...policy }),
    configure(value: Policy) {
      if (closed) throw new Error('Backup service is closed')
      if (
        !Number.isSafeInteger(value.intervalMinutes) ||
        value.intervalMinutes < 15 ||
        !Number.isSafeInteger(value.maxAutoBackups) ||
        value.maxAutoBackups < 0
      )
        throw new Error('Invalid backup settings')
      if (JSON.stringify(value) === JSON.stringify(policy)) return
      const temp = `${settingsPath}.${randomUUID()}.tmp`
      try {
        durableJson(temp, value)
        renameSync(temp, settingsPath)
        if (process.platform !== 'win32') {
          const fd = openSync(dir, 'r')
          try {
            fsyncSync(fd)
          } finally {
            closeSync(fd)
          }
        }
      } finally {
        rmSync(temp, { force: true })
      }
      policy = { ...value }
      schedule()
    },
    async restore(backupId: string, id: string = randomUUID()): Promise<ComputerChatArchive> {
      if (closed) throw new Error('Backup service is closed')
      const source = folder(dir, backupId),
        target = folder(archiveDir, id)
      const running = restoring.get(id)
      if (running) {
        if (running.backupId !== backupId) throw new Error('Archive id conflict')
        return running.work
      }
      restorePins.set(backupId, (restorePins.get(backupId) ?? 0) + 1)
      const work = (async () => {
        if (existsSync(target)) {
          const existing = archiveDescriptor(id)
          if (existing.backupId !== backupId) throw new Error('Archive id conflict')
          return existing
        }
        const m = await verify(dir, backupId),
          temp = join(archiveDir, `.pending-${process.pid}-${randomUUID()}`)
        mkdirSync(temp, { mode: 0o700 })
        activeBackupStaging.add(temp)
        try {
          for (const file of m.files) {
            const dest = join(temp, file.path)
            mkdirSync(resolve(dest, '..'), { recursive: true, mode: 0o700 })
            await copyDurable(fileWithin(source, file.path), dest)
          }
          // Verify the actual copy before publishing; the source may have changed during copying.
          await verifyContent(m, temp)
          durableJson(join(temp, 'manifest.json'), m)
          const archive: ComputerChatArchive = {
            id,
            backupId,
            createdAt: Date.now(),
            readOnly: true,
            providerResumable: false
          }
          durableJson(join(temp, 'archive.json'), archive)
          await syncDir(temp)
          renameSync(temp, target)
          await syncDir(archiveDir)
          return archive
        } catch (error) {
          rmSync(temp, { recursive: true, force: true })
          throw error
        } finally {
          activeBackupStaging.delete(temp)
        }
      })().finally(() => {
        restoring.delete(id)
        const pins = restorePins.get(backupId)! - 1
        if (pins) restorePins.set(backupId, pins)
        else restorePins.delete(backupId)
      })
      restoring.set(id, { backupId, work })
      return work
    },
    listArchives() {
      return readdirSync(archiveDir)
        .filter((id) => UUID.test(id))
        .map((id): ComputerChatArchive => {
          try {
            return archiveDescriptor(id)
          } catch {
            return {
              id,
              backupId: id,
              createdAt: 0,
              readOnly: true,
              providerResumable: false,
              error: 'Archive descriptor is invalid'
            }
          }
        })
        .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    },
    conversations(id: string) {
      return withArchive(id, (db) =>
        db
          .prepare(
            "SELECT id,task_id AS taskId,tab_id AS tabId,mode,CASE WHEN tab_id LIKE 'artifact-store:%' THEN 'Task files' END AS title,(SELECT count(*) FROM events e WHERE e.conversation_id=c.id) AS events FROM conversations c WHERE state<>'deleted' AND task_id NOT LIKE '\\_\\_%' ESCAPE '\\' ORDER BY task_id,tab_id"
          )
          .all()
      ) as Array<{ id: string; taskId: string; tabId: string; mode: string; events: number }>
    },
    read(id: string, conversationId: string, afterSeq = -1, limit = 200) {
      if (
        !Number.isSafeInteger(afterSeq) ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 1000
      )
        throw new Error('Invalid archive page')
      return withArchive(id, (db) => {
        const rows = db
          .prepare(
            'SELECT seq,saved_at,event FROM events WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT ?'
          )
          .all(conversationId, afterSeq, limit + 1) as Array<{
          seq: number
          saved_at: number
          event: string
        }>
        const events = rows
          .slice(0, limit)
          .map((r) => ({ seq: r.seq, at: r.saved_at, event: JSON.parse(r.event) as AgentEvent }))
        return { events, hasMore: rows.length > limit, nextSeq: events.at(-1)?.seq ?? afterSeq }
      })
    },
    records(id: string, conversationId: string, afterCursor = 0) {
      if (!Number.isSafeInteger(afterCursor) || afterCursor < 0)
        throw new Error('Invalid archive record page')
      return withArchive(id, (db) => {
        const result: Array<{ cursor: number; kind: string; id: string; value: unknown }> = []
        let bytes = 0,
          hasMore = false,
          nextCursor = afterCursor
        const hasArtifacts = !!db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifact_owners'")
          .get()
        const hasWorking = !!db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifact_working_files'"
          )
          .get()
        const stride = hasWorking ? 3 : 2
        const artifactRows = hasArtifacts
          ? ` UNION ALL
          SELECT v.rowid*${stride}+1 AS cursor,'artifact-version' AS kind,v.id,
            json_object('artifactId',a.id,'name',a.title,'contentHash',v.content_hash,'size',v.size,
              'versionNum',v.version_num,'versionName',v.name,'createdAt',v.created_at) AS value
          FROM artifact_versions v JOIN task_artifacts a ON a.id=v.artifact_id
          JOIN artifact_owners o ON o.id=a.id AND o.kind='artifact'
          WHERE o.conversation_id=?`
          : ''
        const workingRows = hasWorking
          ? ` UNION ALL
          SELECT w.rowid*3+2 AS cursor,'artifact-original' AS kind,w.artifact_id AS id,
            json_object('artifactId',a.id,'name',a.title,'contentHash',w.content_hash,'size',w.size,'workingCopy',json('true')) AS value
          FROM artifact_working_files w JOIN task_artifacts a ON a.id=w.artifact_id
          JOIN artifact_owners o ON o.id=a.id AND o.kind='artifact' WHERE o.conversation_id=?`
          : ''
        for (const row of db
          .prepare(`SELECT * FROM (
            SELECT rowid*${stride} AS cursor,kind,id,value FROM records WHERE conversation_id=? AND
              (kind IN ('draft','queue','prompt','workspace','thread','pinned-message') OR (kind='settings' AND (id LIKE 'diagnostic:%' OR id LIKE 'legacy-turn-preview:%')))
            ${artifactRows}${workingRows}) WHERE cursor>? ORDER BY cursor LIMIT 101`)
          .iterate(
            conversationId,
            ...(hasArtifacts ? [conversationId] : []),
            ...(hasWorking ? [conversationId] : []),
            afterCursor
          ) as Iterable<{
          cursor: number
          kind: string
          id: string
          value: string
        }>) {
          if (
            result.length >= 100 ||
            (bytes + Buffer.byteLength(row.value) > 4 * 1024 * 1024 && result.length)
          ) {
            hasMore = true
            break
          }
          result.push({ ...row, value: JSON.parse(row.value) })
          bytes += Buffer.byteLength(row.value)
          nextCursor = row.cursor
        }
        return { records: result, hasMore, nextCursor }
      })
    },
    attachment(id: string, conversationId: string, ref: ChatAttachment) {
      return withArchive(id, (db) => {
        const rows = db
          .prepare("SELECT value FROM records WHERE conversation_id=? AND kind='attachment'")
          .all(conversationId) as Array<{ value: string }>
        const matching = rows
          .map((r) => JSON.parse(r.value) as ChatAttachment)
          .filter(
            (r) =>
              r.artifactId === ref.artifactId &&
              (!ref.contentHash || r.contentHash === ref.contentHash)
          )
        if (!ref.contentHash && new Set(matching.map((ref) => ref.contentHash)).size > 1)
          throw new Error(
            'Archive attachment version is ambiguous; select an explicit saved version'
          )
        const record = matching[0]
        if (!record?.contentHash)
          throw new Error('Attachment does not belong to this archive conversation')
        const file = fileWithin(folder(archiveDir, id), `blobs/${record.contentHash}`)
        if (hashFile(file) !== record.contentHash)
          throw new Error('Archive attachment integrity failure')
        return readFileSync(file)
      })
    },
    file(id: string, conversationId: string, artifactId: string, contentHash: string) {
      if (!/^[a-f0-9]{64}$/.test(contentHash)) throw new Error('Invalid archive file hash')
      return withArchive(id, (db) => {
        const hasWorking = !!db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifact_working_files'"
          )
          .get()
        const row = db
          .prepare(`SELECT a.title AS name,v.size FROM task_artifacts a
          JOIN artifact_owners o ON o.id=a.id AND o.kind='artifact'
          JOIN artifact_versions v ON v.artifact_id=a.id
          WHERE o.conversation_id=? AND a.id=? AND v.content_hash=?
          ${
            hasWorking
              ? `UNION ALL SELECT a.title,w.size FROM task_artifacts a
            JOIN artifact_owners o ON o.id=a.id AND o.kind='artifact'
            JOIN artifact_working_files w ON w.artifact_id=a.id
            WHERE o.conversation_id=? AND a.id=? AND w.content_hash=?`
              : ''
          }`)
          .get(
            conversationId,
            artifactId,
            contentHash,
            ...(hasWorking ? [conversationId, artifactId, contentHash] : [])
          ) as { name: string; size: number } | undefined
        if (!row) throw new Error('File does not belong to this archive conversation')
        const path = fileWithin(
          folder(archiveDir, id),
          `blobs/${contentHash.slice(0, 2)}/${contentHash.slice(2)}`
        )
        if (statSync(path).size !== row.size || hashFile(path) !== contentHash)
          throw new Error('Archive file integrity failure')
        return { name: row.name, data: readFileSync(path) }
      })
    },
    async eraseTask(taskId: string) {
      // Finish already-started copies before cleaning readable restored copies.
      // Retained backup snapshots keep their normal retention policy.
      await Promise.all([...restoring.values()].map((r) => r.work))
      const unchecked = await refreshArchiveIndex()
      const holding = store.compose(
        (raw) =>
          raw.prepare('SELECT archive_id FROM archive_tasks WHERE task_id=?').all(taskId) as Array<{
            archive_id: string
          }>
      )
      // One archive at a time: a damaged archive is set aside (or recorded) and
      // the others are still erased. Only THIS task's erasure reports a failure.
      const erased = await forEachIsolated(
        holding.map((row) => row.archive_id),
        {
          pass: 'chat-archive-erasure',
          key: (id) => id,
          taskId: () => taskId,
          ledger: store.faults,
          ignoreGate: true,
          isFatal: isStorageFatal
        },
        async (id) => {
          try {
            await eraseFromArchive(id, taskId)
          } catch (raw) {
            // A corrupt archive database is the archive's damage, not this disk's.
            const error = asItemDamage(raw)
            if (classifyFault(error) === 'structural') quarantineArchive(id, error)
            else throw error
          }
        }
      )
      // Unreadable archives cannot be inspected row by row: any whose raw bytes
      // name the task is deleted outright (the user's erasure wins over a copy
      // that can no longer be read anyway).
      eraseQuarantinedForTask(store.dir, taskId)
      const failed = [...erased.failed.map((f) => f.key), ...unchecked]
      if (failed.length)
        throw new Error(
          `Restored archive could not be erased yet (${failed.join(', ')}); retrying later`
        )
    },
    async close() {
      closed = true
      if (timer) clearTimeout(timer)
      await Promise.allSettled([...pending.values(), ...[...restoring.values()].map((r) => r.work)])
    }
  }
  /** Moves an unreadable restored archive out of the archive list into quarantine. */
  function quarantineArchive(id: string, error: unknown) {
    quarantineMove(store.dir, {
      pass: ARCHIVE_QUARANTINE_PASS,
      path: folder(archiveDir, id),
      reason: error instanceof Error ? error.message : String(error)
    })
    store.compose((raw) => raw.prepare('DELETE FROM archive_index WHERE archive_id=?').run(id))
  }
  /**
   * Brings the archive→task index up to date: an archive is (re)read only when
   * its manifest changed since it was indexed. An archive that cannot be read is
   * quarantined (structural) or recorded (transient). Returns the ids that could
   * not be checked this time: an erasure cannot rule them out.
   */
  async function refreshArchiveIndex(): Promise<string[]> {
    const ids = readdirSync(archiveDir).filter((id) => UUID.test(id))
    const indexed = new Map(
      store
        .compose(
          (raw) =>
            raw.prepare('SELECT archive_id,fingerprint FROM archive_index').all() as Array<{
              archive_id: string
              fingerprint: string
            }>
        )
        .map((row) => [row.archive_id, row.fingerprint])
    )
    store.compose((raw) => {
      for (const id of indexed.keys())
        if (!ids.includes(id)) raw.prepare('DELETE FROM archive_index WHERE archive_id=?').run(id)
    })
    const fingerprintOf = (id: string) =>
      fileFingerprint(join(archiveDir, id, 'manifest.json')) ?? 'missing'
    const report = await forEachIsolated(
      ids.filter((id) => indexed.get(id) !== fingerprintOf(id)),
      {
        pass: 'chat-archive-index',
        key: (id) => id,
        ledger: store.faults,
        ignoreGate: true,
        isFatal: isStorageFatal
      },
      (id) => {
        try {
          indexArchive(id, fingerprintOf(id))
        } catch (raw) {
          const error = asItemDamage(raw)
          if (classifyFault(error) === 'structural' || isMissingFile(error))
            quarantineArchive(id, error)
          else throw error
        }
      }
    )
    return report.failed.map((f) => f.key)
  }
  function indexArchive(id: string, fingerprint: string) {
    manifest(archiveDir, id)
    const db = new Database(fileWithin(folder(archiveDir, id), 'chat.sqlite'), {
      readonly: true,
      fileMustExist: true
    })
    let taskIds: string[]
    try {
      taskIds = (
        db.prepare('SELECT DISTINCT task_id FROM conversations').all() as Array<{ task_id: string }>
      ).map((row) => row.task_id)
    } catch (error) {
      // A file that is not a readable chat database is the archive's own damage.
      throw new StructuralFaultError('Archive database cannot be read', { cause: error })
    } finally {
      db.close()
    }
    store.transaction(() =>
      store.compose((raw) => {
        raw.prepare('DELETE FROM archive_index WHERE archive_id=?').run(id)
        raw.prepare('INSERT INTO archive_index VALUES(?,?)').run(id, fingerprint)
        const insert = raw.prepare('INSERT INTO archive_tasks VALUES(?,?)')
        for (const taskId of taskIds) insert.run(id, taskId)
      })
    )
  }
  async function eraseFromArchive(id: string, taskId: string) {
    const path = folder(archiveDir, id),
      m = manifest(archiveDir, id)
    const db = new Database(fileWithin(path, 'chat.sqlite'), { fileMustExist: true })
    try {
      if (!db.prepare('SELECT 1 FROM conversations WHERE task_id=? LIMIT 1').get(taskId)) return
      // A restored copy has no live backup writer; copied leases are stale.
      db.exec('DELETE FROM blob_leases')
      if (
        db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifact_blob_leases'")
          .get()
      )
        db.exec('DELETE FROM artifact_blob_leases')
      prepareStoredTaskErasure(db, taskId)
      finishStoredTaskErasure(db, path, taskId)
    } finally {
      db.close()
    }
    // Archive manifests describe the remaining readable files. Rebuild after
    // every retry, including a crash between DB cleanup and manifest publish.
    m.files = m.files
      .filter((file) => {
        try {
          return existsSync(fileWithin(path, file.path))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
          throw error
        }
      })
      .map((file) => {
        const actual = fileWithin(path, file.path)
        return { ...file, size: statSync(actual).size, hash: hashFile(actual) }
      })
    const next = join(path, `.erasure-${randomUUID()}.json`)
    durableJson(next, m)
    renameSync(next, join(path, 'manifest.json'))
    await syncDir(path)
    // The manifest changed: drop the task from the index now (re-read lazily).
    store.compose((raw) =>
      raw.prepare('DELETE FROM archive_tasks WHERE archive_id=? AND task_id=?').run(id, taskId)
    )
  }
  function withArchive<T>(id: string, read: (db: Database.Database) => T): T {
    const path = folder(archiveDir, id)
    archiveDescriptor(id)
    const db = new Database(fileWithin(path, 'chat.sqlite'), {
      readonly: true,
      fileMustExist: true
    })
    try {
      return read(db)
    } finally {
      db.close()
    }
  }
  return api
}
