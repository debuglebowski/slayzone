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
import type { ChatStorage } from './storage'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
interface FileEntry {
  path: string
  hash: string
  size: number
}
interface Manifest {
  version: 1
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
async function syncFile(path: string) {
  const fd = await fsAsync.open(path, 'r')
  try {
    await fd.sync()
  } finally {
    await fd.close()
  }
}
async function syncDir(path: string) {
  if (process.platform !== 'win32') await syncFile(path)
}
async function copyDurable(source: string, dest: string) {
  await fsAsync.copyFile(source, dest)
  await fsAsync.chmod(dest, 0o600)
  await syncFile(dest)
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
export function createChatBackups(store: ChatStorage) {
  const dir = join(store.dir, 'backups'),
    archiveDir = join(store.dir, 'archives'),
    scope = basename(store.dir)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  mkdirSync(archiveDir, { recursive: true, mode: 0o700 })
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
          version: z.literal(1),
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
      new Set(value.files.map((f) => f.path)).size !== value.files.length
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
      const temp = join(dir, `.pending-${id}`)
      rmSync(temp, { recursive: true, force: true })
      mkdirSync(temp, { mode: 0o700 })
      const lease = store.acquireBlobLease(id, 60_000),
        renew = setInterval(() => store.acquireBlobLease(id, 60_000), 20_000)
      renew.unref()
      try {
        await store.backupTo(join(temp, 'chat.sqlite'))
        chmodSync(join(temp, 'chat.sqlite'), 0o600)
        await syncFile(join(temp, 'chat.sqlite'))
        const db = new Database(join(temp, 'chat.sqlite'), { readonly: true, fileMustExist: true }),
          refs = new Set<string>()
        let events = 0,
          conversations = 0
        try {
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
        const files: FileEntry[] = [
          {
            path: 'chat.sqlite',
            hash: await hashFileAsync(join(temp, 'chat.sqlite')),
            size: statSync(join(temp, 'chat.sqlite')).size
          }
        ]
        for (const relative of [...refs].sort()) {
          const source = fileWithin(store.dir, relative),
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
          readOnlyRestore: true,
          providerResumable: false
        }
        durableJson(join(temp, 'manifest.json'), {
          version: 1,
          scope,
          backup,
          files
        } satisfies Manifest)
        await syncDir(temp)
        renameSync(temp, target)
        await syncDir(dir)
        return backup
      } catch (error) {
        rmSync(temp, { recursive: true, force: true })
        throw error
      } finally {
        clearInterval(renew)
        lease.release()
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
    if (closed || !policy.autoEnabled) return
    const last = list().find((b) => b.kind === 'auto')?.createdAt ?? 0
    const delay = Math.max(1000, last + policy.intervalMinutes * 60_000 - Date.now())
    timer = setTimeout(() => {
      void create('auto')
        .then(() => {
          if (policy.maxAutoBackups > 0)
            for (const item of list()
              .filter((b) => b.kind === 'auto')
              .slice(policy.maxAutoBackups))
              if (!restorePins.has(item.id))
                rmSync(folder(dir, item.id), { recursive: true, force: true })
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
          temp = join(archiveDir, `.pending-${id}`)
        rmSync(temp, { recursive: true, force: true })
        mkdirSync(temp, { mode: 0o700 })
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
        const artifactRows = hasArtifacts
          ? ` UNION ALL
          SELECT v.rowid*2+1 AS cursor,'artifact-version' AS kind,v.id,
            json_object('artifactId',a.id,'name',a.title,'contentHash',v.content_hash,'size',v.size,
              'versionNum',v.version_num,'versionName',v.name,'createdAt',v.created_at) AS value
          FROM artifact_versions v JOIN task_artifacts a ON a.id=v.artifact_id
          JOIN artifact_owners o ON o.id=a.id AND o.kind='artifact'
          WHERE o.conversation_id=?`
          : ''
        for (const row of db
          .prepare(`SELECT * FROM (
            SELECT rowid*2 AS cursor,kind,id,value FROM records WHERE conversation_id=? AND
              (kind IN ('draft','prompt','workspace','thread') OR (kind='settings' AND id LIKE 'diagnostic:%'))
            ${artifactRows}) WHERE cursor>? ORDER BY cursor LIMIT 101`)
          .iterate(
            conversationId,
            ...(hasArtifacts ? [conversationId] : []),
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
        const record = rows
          .map((r) => JSON.parse(r.value) as ChatAttachment)
          .find(
            (r) =>
              r.artifactId === ref.artifactId &&
              (!ref.contentHash || r.contentHash === ref.contentHash)
          )
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
        const row = db
          .prepare(`SELECT a.title AS name,v.size FROM task_artifacts a
          JOIN artifact_owners o ON o.id=a.id AND o.kind='artifact'
          JOIN artifact_versions v ON v.artifact_id=a.id
          WHERE o.conversation_id=? AND a.id=? AND v.content_hash=?`)
          .get(conversationId, artifactId, contentHash) as
          | { name: string; size: number }
          | undefined
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
    async close() {
      closed = true
      if (timer) clearTimeout(timer)
      await Promise.allSettled([...pending.values(), ...[...restoring.values()].map((r) => r.work)])
    }
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
