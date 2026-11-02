import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { createComputerChatRuntime } from './computer-runtime'
import { openChatStorage, CHAT_STORAGE_SCHEMA_VERSION } from './storage'

// Audit-only regression probes. Faults target disposable files / real SQLite.
// Assertions describe the required invariant, so confirmed defects remain red.
const roots: string[] = []
const runtimes: ReturnType<typeof createComputerChatRuntime>[] = []
const stores: ReturnType<typeof openChatStorage>[] = []
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const identity = { id: 'chat', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 }
// Real hub upload caller routes new originals through a task artifact root.
const filesIdentity = { ...identity, id: 'files', tabId: 'artifact-store:task:pc' }
const route = { id: filesIdentity.id, epoch: 1 }
function root() {
  const dir = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'chat-durability-second-'))
  roots.push(dir)
  return dir
}
function runtime(dir = root()) {
  const r = createComputerChatRuntime({ stateDir: dir, hubScope: 'audit', computerId: 'pc' })
  runtimes.push(r)
  r.bootstrap({
    identity,
    projectId: null,
    cwd: dir,
    revision: 1,
    providerConfig: {},
    defaultFlags: null,
    env: {}
  })
  r.bootstrap({
    identity: filesIdentity,
    projectId: null,
    cwd: dir,
    revision: 1,
    providerConfig: {},
    defaultFlags: null,
    env: {}
  })
  return r
}
async function upload(r: ReturnType<typeof runtime>, content = 'original private file') {
  return (await r.artifacts.invoke({
    route,
    method: 'uploadArtifactBlob',
    operationId: randomUUID(),
    args: [
      {
        taskId: identity.taskId,
        title: 'private.txt',
        data: Buffer.from(content).toString('base64')
      }
    ]
  })) as { id: string; title: string }
}
async function edit(r: ReturnType<typeof runtime>, id: string, content: string) {
  return r.artifacts.invoke({
    route,
    method: 'updateArtifact',
    operationId: randomUUID(),
    args: [{ id, content }]
  })
}
async function readCurrent(r: ReturnType<typeof runtime>, id: string) {
  return r.artifacts.invoke({ route, method: 'readArtifactContent', args: [id] })
}
function rehashBackup(
  r: ReturnType<typeof runtime>,
  id: string,
  mutate: (db: Database.Database) => void
) {
  const dir = join(r.backups.dir, id),
    path = join(dir, 'chat.sqlite')
  const db = new Database(path)
  try {
    mutate(db)
  } finally {
    db.close()
  }
  const manifestPath = join(dir, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const dbEntry = manifest.files.find((f: { path: string }) => f.path === 'chat.sqlite')
  const data = fs.readFileSync(path)
  dbEntry.hash = sha(data)
  dbEntry.size = data.length
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))
}
function failNextBlobWrite() {
  const original = fs.writeFileSync.bind(fs)
  let injected = false
  const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((path, data, options) => {
    // Both blob implementations write via an opened fd. Working files use paths.
    if (!injected && typeof path === 'number') {
      injected = true
      const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data as Uint8Array)
      fs.writeSync(path, bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))))
      throw Object.assign(new Error('Injected device full after partial blob write'), {
        code: 'ENOSPC'
      })
    }
    return original(path, data, options)
  })
  syncBuiltinESMExports()
  return { spy, injected: () => injected }
}
afterEach(async () => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  for (const r of runtimes.splice(0)) await r.close()
  for (const s of stores.splice(0)) s.close()
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

test('control: actual SQLITE_FULL rejects append atomically and permits repair/retry', () => {
  const s = openChatStorage({ stateDir: root(), hubScope: 'audit' })
  stores.push(s)
  s.createConversation(identity)
  s.append('chat', 1, { kind: 'assistant-text', messageId: 'before', text: 'committed' }, 123)
  s.compose((db) => db.pragma(`max_page_count=${db.pragma('page_count', { simple: true })}`))
  expect(() =>
    s.append(
      'chat',
      1,
      { kind: 'assistant-text', messageId: 'full', text: 'x'.repeat(1_000_000) },
      124
    )
  ).toThrow(/full/i)
  expect(s.read('chat', -1)).toEqual([
    { seq: 0, at: 123, event: { kind: 'assistant-text', messageId: 'before', text: 'committed' } }
  ])
  s.compose((db) => db.pragma('max_page_count=1073741823'))
  expect(
    s.append('chat', 1, { kind: 'assistant-text', messageId: 'after', text: 'retry' }, 125).seq
  ).toBe(1)
})

test('failed artifact blob write leaves visible original consistent with committed HEAD', async () => {
  const dir = root(),
    r = runtime(dir),
    original = 'original private file'
  const artifact = await upload(r, original)
  const failure = failNextBlobWrite()
  await expect(edit(r, artifact.id, 'uncommitted replacement')).rejects.toThrow(/device full/)
  failure.spy.mockRestore()
  syncBuiltinESMExports()
  expect(failure.injected()).toBe(true)
  const current = await r.artifacts.invoke({
    route,
    method: 'readArtifactVersion',
    args: [{ artifactId: artifact.id, versionRef: 'current' }]
  })
  expect(current).toBe(original)
  // The original is read by editor/download; HEAD is what a backup restores.
  const beforeRestart = await readCurrent(r, artifact.id)
  await r.close()
  const reopened = runtime(dir)
  expect({ beforeRestart, afterRestart: await readCurrent(reopened, artifact.id) }).toEqual({
    beforeRestart: original,
    afterRestart: original
  })
})

test('rejected historical-version write cannot overwrite the original before validating its version ref', async () => {
  const r = runtime(),
    original = 'original private file',
    artifact = await upload(r, original)
  await expect(
    r.artifacts.invoke({
      route,
      method: 'writeArtifactContent',
      operationId: 'invalid-ref-write',
      args: [
        {
          artifactId: artifact.id,
          mutateRef: 'nonexistent-version',
          data: Buffer.from('rejected replacement').toString('base64')
        }
      ]
    })
  ).rejects.toThrow(/NOT_FOUND|not found/)
  expect(await readCurrent(r, artifact.id)).toBe(original)
})

test('mutating a historical version keeps current file bytes aligned with its current HEAD', async () => {
  const r = runtime(),
    artifact = await upload(r, 'historical A')
  await edit(r, artifact.id, 'current B')
  await r.artifacts.invoke({
    route,
    method: 'writeArtifactContent',
    operationId: 'mutate-historical',
    args: [
      {
        artifactId: artifact.id,
        mutateRef: 1,
        data: Buffer.from('historical A edited').toString('base64')
      }
    ]
  })
  const head = await r.artifacts.invoke({
    route,
    method: 'readArtifactVersion',
    args: [{ artifactId: artifact.id, versionRef: 'current' }]
  })
  expect(head).toBe('current B')
  expect(await readCurrent(r, artifact.id)).toBe(head)
})

test.each(['attachment', 'artifact'] as const)(
  'failed %s blob staging cannot retain private payload after permanent deletion',
  async (kind) => {
    const dir = root(),
      r = runtime(dir),
      bytes = Buffer.from('PRIVATE_PARTIAL_PAYLOAD_FROM_FAILED_UPLOAD')
    const failure = failNextBlobWrite()
    if (kind === 'attachment') {
      expect(() =>
        r.attachments.put(
          'tab',
          {
            artifactId: 'flat',
            name: 'private.txt',
            kind: 'text',
            mediaType: 'text/plain',
            size: bytes.length
          },
          bytes
        )
      ).toThrow(/device full/)
    } else {
      await expect(upload(r, bytes.toString())).rejects.toThrow(/device full/)
    }
    failure.spy.mockRestore()
    syncBuiltinESMExports()
    expect(failure.injected()).toBe(true)
    await r.applyTaskLifecycle('task', 'deleted', 1)
    await r.close()
    const reopened = createComputerChatRuntime({
      stateDir: dir,
      hubScope: 'audit',
      computerId: 'pc'
    })
    runtimes.push(reopened)
    reopened.attachments.collectGarbage()
    reopened.artifacts.collectGarbage()
    const leftovers = fs
      .readdirSync(reopened.attachments.dir, { recursive: true })
      .map(String)
      .filter((relative) => {
        const path = join(reopened.attachments.dir, relative)
        return fs.lstatSync(path).isFile() && fs.readFileSync(path).includes(bytes.subarray(0, 12))
      })
    expect(
      leftovers,
      'Failed upload temp files contain private bytes after task deletion and both GCs'
    ).toEqual([])
  }
)

test('prune failure cannot restore committed version rows whose bytes were already removed', async () => {
  const r = runtime(),
    artifact = await upload(r, 'historical A')
  await edit(r, artifact.id, 'historical B')
  await edit(r, artifact.id, 'current C')
  const versions = (await r.artifacts.invoke({
    route,
    method: 'listArtifactVersions',
    args: [{ artifactId: artifact.id }]
  })) as Array<{ id: string; version_num: number; content_hash: string }>
  const original = fs.rmSync.bind(fs)
  const removed: string[] = []
  let calls = 0
  const spy = vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
    if (
      String(path).startsWith(r.attachments.dir + '/') &&
      /\/[a-f0-9]{2}\/[a-f0-9]{62}$/.test(String(path))
    ) {
      if (++calls === 2)
        throw Object.assign(new Error('Injected second blob unlink I/O error'), { code: 'EIO' })
      removed.push(String(path))
    }
    return original(path, options)
  })
  syncBuiltinESMExports()
  await expect(
    r.artifacts.invoke({
      route,
      method: 'pruneArtifactVersions',
      operationId: 'prune',
      args: [{ artifactId: artifact.id, keepCurrent: true, keepNamed: false }]
    })
  ).rejects.toThrow(/I\/O/)
  spy.mockRestore()
  syncBuiltinESMExports()
  expect(removed).toHaveLength(1)
  expect(
    await r.artifacts.invoke({
      route,
      method: 'listArtifactVersions',
      args: [{ artifactId: artifact.id }]
    })
  ).toHaveLength(versions.length)
  for (const version of versions) {
    await expect(
      r.artifacts.invoke({ route, method: 'readBytes', args: [artifact.id, version.version_num] }),
      `Committed version ${version.id} must remain readable after rollback`
    ).resolves.toBeDefined()
  }
})

test.each(['future-schema', 'missing-events-table', 'invalid-event-json'] as const)(
  'restore rejects unsupported or unreadable %s database before publishing a verified archive',
  async (fault) => {
    const r = runtime()
    r.storage.append('chat', 1, { kind: 'assistant-text', messageId: 'm', text: 'recover me' }, 123)
    const backup = await r.backups.create('manual')
    rehashBackup(r, backup.id, (db) => {
      if (fault === 'future-schema') db.pragma(`user_version=${CHAT_STORAGE_SCHEMA_VERSION + 1}`)
      else if (fault === 'missing-events-table') db.exec('DROP TABLE events')
      else db.prepare("UPDATE events SET event='{' ").run()
      expect(db.pragma('quick_check', { simple: true })).toBe('ok')
      expect(db.pragma('foreign_key_check')).toEqual([])
    })
    const [result] = await Promise.allSettled([r.backups.restore(backup.id)])
    if (result.status === 'fulfilled') {
      const archive = result.value
      if (fault === 'missing-events-table')
        expect(() => r.backups.read(archive.id, 'chat')).toThrow(/no such table.*events/)
      if (fault === 'invalid-event-json')
        expect(() => r.backups.read(archive.id, 'chat')).toThrow(SyntaxError)
    }
    expect(result.status, 'Readable history must be verified before archive publication').toBe(
      'rejected'
    )
    expect(r.backups.listArchives()).toEqual([])
  }
)

test('control: live database created by newer schema is rejected with prior history retained', async () => {
  const dir = root(),
    r = runtime(dir),
    path = r.storage.path
  r.storage.append(
    'chat',
    1,
    { kind: 'assistant-text', messageId: 'm', text: 'future history' },
    123
  )
  await r.close()
  const db = new Database(path)
  db.pragma(`user_version=${CHAT_STORAGE_SCHEMA_VERSION + 1}`)
  db.close()
  expect(() => openChatStorage({ stateDir: dir, hubScope: 'audit' })).toThrow(/newer version/)
  const check = new Database(path, { readonly: true })
  try {
    expect(check.pragma('user_version', { simple: true })).toBe(CHAT_STORAGE_SCHEMA_VERSION + 1)
    expect(check.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 1 })
  } finally {
    check.close()
  }
})

test('control: original-artifact snapshots survive live mutation, deletion and GC while copying', async () => {
  const r = runtime(),
    artifact = await upload(r, 'snapshot version A')
  let release!: () => void, ready!: () => void
  const paused = new Promise<void>((resolve) => {
    release = resolve
  })
  const snapshotted = new Promise<void>((resolve) => {
    ready = resolve
  })
  const original = r.storage.backupTo.bind(r.storage)
  r.storage.backupTo = async (path) => {
    const result = await original(path)
    ready()
    await paused
    return result
  }
  const work = r.backups.create('manual')
  try {
    await snapshotted
    await edit(r, artifact.id, 'live version B')
    await r.applyTaskLifecycle('task', 'deleted', 1)
    expect(r.artifacts.collectGarbage()).toBe(0)
    release()
    const backup = await work,
      archive = await r.backups.restore(backup.id)
    expect(
      r.backups
        .file(archive.id, 'files', artifact.id, sha(Buffer.from('snapshot version A')))
        .data.toString()
    ).toBe('snapshot version A')
    expect(r.storage.conversation('chat')?.state).toBe('deleted')
  } finally {
    release()
    await work.catch(() => {})
  }
})

test('corrupt original-artifact blob cannot be returned silently as verified version bytes', async () => {
  const r = runtime(),
    artifact = await upload(r, 'valid artifact bytes')
  const version = (await r.artifacts.invoke({
    route,
    method: 'getCurrentArtifactVersion',
    args: [{ artifactId: artifact.id }]
  })) as { id: string; content_hash: string }
  fs.writeFileSync(
    join(r.storage.dir, 'blobs', version.content_hash.slice(0, 2), version.content_hash.slice(2)),
    'CORRUPT'
  )
  await expect(
    r.artifacts.invoke({ route, method: 'readBytes', args: [artifact.id, version.content_hash] })
  ).rejects.toThrow(/hash|integrity|corrupt/i)
})

test('control: flat sealed attachments reject corruption and verified upload repairs the bytes', async () => {
  const r = runtime(),
    bytes = Buffer.from('valid sealed bytes')
  const ref = r.attachments.put(
    'tab',
    {
      artifactId: 'sealed',
      name: 'saved.txt',
      kind: 'text',
      mediaType: 'text/plain',
      size: bytes.length
    },
    bytes
  )
  fs.writeFileSync(join(r.attachments.dir, ref.contentHash!), 'CORRUPT')
  await expect(r.attachments.reader.read(ref)).rejects.toThrow(/hash integrity/)
  r.attachments.put('tab', ref, bytes)
  await expect(r.attachments.reader.read(ref)).resolves.toEqual(bytes)
})

test('control: deleting a chat preserves its separately owned task original and exposes no names/content through metadata', async () => {
  const r = runtime(),
    title = 'PRIVATE_ORIGINAL_NAME.txt',
    bytes = Buffer.from('PRIVATE_ORIGINAL_BYTES')
  const artifact = (await r.artifacts.invoke({
    route,
    method: 'uploadArtifactBlob',
    operationId: 'original',
    args: [{ taskId: 'task', title, data: bytes.toString('base64') }]
  })) as { id: string }
  const ref = await r.artifacts.seal('tab', {
    artifactId: artifact.id,
    name: title,
    kind: 'text',
    mediaType: 'text/plain',
    size: bytes.length
  })
  const metadata = JSON.stringify(await r.artifacts.metadata('files'))
  expect(metadata).not.toContain(title)
  expect(metadata).not.toContain(bytes.toString())
  expect(metadata).not.toContain(bytes.toString('base64'))
  await r.deleteConversation({ ...identity, epoch: 2 })
  expect(r.storage.conversation('chat')?.state).toBe('deleted')
  expect(r.storage.conversation('files')?.state).toBe('active')
  expect(await readCurrent(r, artifact.id)).toBe(bytes.toString())
  await expect(r.attachments.reader.read(ref)).rejects.toThrow(/does not belong/)
})
