import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createTestHarness, createSlayzoneDbAdapter } from '../../../shared/test-utils/ipc-harness'
import { createComputerChatRuntime } from '../../../domains/chat-runtime/src/server/computer-runtime'
import { createChatMigrationAttachmentReader } from '@slayzone/chat-runtime/server'
import { createArtifactStore } from '@slayzone/task-artifacts/server'
import { createDbChatDataOps } from '@slayzone/terminal/server'
import { taskSessionStore } from './test-session-store'
import { createFixtureChatRuntime } from '../../computer/src/project-scope.fixture'
import { createComputerChatServices } from './computer-chat'

const dirs: string[] = []
const runtimes: ReturnType<typeof createComputerChatRuntime>[] = []
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const root = () => {
  const d = mkdtempSync(join(realpathSync(tmpdir()), 'lifecycle-audit-'))
  dirs.push(d)
  return d
}
const value = (id: string, taskId = id) => ({
  identity: { id, taskId, tabId: id, mode: 'claude-chat', epoch: 1 },
  projectId: null,
  cwd: '/tmp',
  revision: 1,
  providerConfig: {},
  defaultFlags: null,
  env: {}
})
function runtime(dir = root(), scope = 'hub') {
  const r = createComputerChatRuntime({ stateDir: dir, hubScope: scope, computerId: 'pc' })
  runtimes.push(r)
  return r
}
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
async function fixture() {
  const h = await createTestHarness(),
    dir = root(),
    bytes = Buffer.from('durable prepared attachment')
  h.db.exec("INSERT INTO projects(id,name,color) VALUES('p','P','#000')")
  h.db
    .prepare('INSERT INTO tasks(id,project_id,title,has_worktree) VALUES(?,?,?,1)')
    .run('task', 'p', 'Task')
  h.db.exec(
    "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
  )
  const artifact = await createArtifactStore(dir).uploadArtifactBlob(h.slayDb, {
    taskId: 'task',
    title: 'saved.txt',
    bytes
  })
  const ref = {
    artifactId: artifact!.id,
    contentHash: hash(bytes),
    name: 'saved.txt',
    kind: 'text' as const,
    mediaType: 'text/plain' as const,
    size: bytes.length
  }
  h.db
    .prepare(
      "INSERT INTO chat_tab_state(tab_id,draft_text,draft_attachments,rev,updated_at) VALUES('tab','survive Trash',?,4,123)"
    )
    .run(JSON.stringify([ref]))
  const open = () =>
    createFixtureChatRuntime({
      taskFolder: () => dir,
      stateDir: dir,
      hubScope: 'hub',
      computerId: () => 'pc',
      getProjectPaths: () => null,
      ctx: {
        config: {
          hubUrl: 'ws://hub/computers',
          name: 'pc',
          allowedRoots: [realpathSync(tmpdir())],
          capabilities: ['proc']
        },
        dialer: { notify: () => true },
        log: () => {}
      }
    })
  let pc = open(),
    interrupt = false
  const services = (db = h.slayDb) =>
    createComputerChatServices({
      db,
      legacyData: { ...createDbChatDataOps(db, taskSessionStore), buildMcpEnv: async () => ({}) },
      attachments: {
        read: async () => bytes,
        readForMigration: createChatMigrationAttachmentReader(db, dir)
      },
      request: async (_id, req) => {
        if ((req as { kind: string }).kind === 'attachment.put' && interrupt) {
          interrupt = false
          throw new Error('Disconnected before attachment bytes')
        }
        return pc.request(JSON.parse(JSON.stringify(req)))
      },
      resolveComputer: async () => 'pc',
      defaultComputer: async () => 'pc',
      hasLiveTask: async () => false
    })
  return {
    ...h,
    dir,
    bytes,
    ref,
    services,
    request: (req: unknown) => pc.request(JSON.parse(JSON.stringify(req))),
    interrupt: () => {
      interrupt = true
    },
    restart: async () => {
      await pc.close()
      pc = open()
    },
    close: async () => {
      await pc.close()
      h.cleanup()
    }
  }
}

test('Trash and undo survive reconnect during a prepared attachment migration', async () => {
  const f = await fixture()
  try {
    const before = f.services()
    f.interrupt()
    await expect(before.relay.ops.getTabState('tab')).rejects.toThrow(
      'Disconnected before attachment bytes'
    )
    expect(await before.ownership.forTab('tab')).toMatchObject({ state: 'copying', epoch: 1 })
    f.db.prepare("UPDATE tasks SET deleted_at=datetime('now') WHERE id='task'").run()
    await f.restart()
    const paused = f.services()
    await paused.recoverComputer('pc')
    expect(await f.request({ kind: 'inventory' })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          // Recovery may finish durable copying, but Trash still fences all writes.
          state: 'active',
          lifecycle: expect.objectContaining({ state: 'paused' })
        })
      ])
    )
    expect(await paused.relay.ops.getTabState('tab')).toMatchObject({
      draft: { text: 'survive Trash', attachments: [f.ref], rev: 4 }
    })
    await expect(
      paused.relay.ops.saveTabDraft('tab', { text: 'blocked', attachments: [] })
    ).rejects.toThrow(/paused/i)
    f.db.prepare("UPDATE tasks SET deleted_at=NULL WHERE id='task'").run()
    await paused.lifecycle.syncTask('task')
    expect(
      await paused.relay.ops.saveTabDraft('tab', { text: 'after undo', attachments: [f.ref] })
    ).toEqual({ rev: 5 })
    const owner = (await paused.ownership.forTab('tab'))!
    expect(owner).toMatchObject({ state: 'active', epoch: 2, cleanupPending: false })
    expect(
      await f.request({
        kind: 'attachment.read',
        route: { id: owner.id, epoch: owner.epoch },
        ref: f.ref
      })
    ).toEqual({ data: f.bytes.toString('base64') })
  } finally {
    await f.close()
  }
})

test('permanent deletion of a prepared migration defeats an older restored hub and late activation', async () => {
  const f = await fixture()
  let restored: Database.Database | undefined
  try {
    const before = f.services()
    f.interrupt()
    await expect(before.relay.ops.getTabState('tab')).rejects.toThrow(
      'Disconnected before attachment bytes'
    )
    const pending = (await before.ownership.forTab('tab'))!
    const prepared = (
      (await f.request({ kind: 'inventory' })) as Array<{
        identity: { id: string }
        migrationHash: string
      }>
    ).find((entry) => entry.identity.id === pending.id)!
    await f.request({
      kind: 'attachment.put',
      route: { id: pending.id, epoch: 2 },
      ref: f.ref,
      data: f.bytes.toString('base64')
    })
    expect(await f.request({ kind: 'migration.verify', id: pending.id })).toEqual({ missing: [] })
    const snapshot = join(f.dir, 'old-hub.sqlite')
    await f.db.backup(snapshot)
    f.db.prepare("DELETE FROM tasks WHERE id='task'").run()
    await before.lifecycle.sync('pc')
    await f.restart()
    const inventory = (await f.request({ kind: 'inventory' })) as Array<{
      identity: { taskId: string }
      state: string
    }>
    expect(
      inventory.filter((x) => x.identity.taskId === 'task').every((x) => x.state === 'deleted')
    ).toBe(true)
    await expect(
      f.request({
        kind: 'migration.activate',
        id: pending.id,
        epoch: 2,
        migrationId: pending.migrationId,
        hash: prepared.migrationHash
      })
    ).rejects.toThrow(/mismatch|deleted|integrity/i)
    restored = new Database(snapshot)
    const after = f.services(createSlayzoneDbAdapter(restored))
    await after.recoverComputer('pc')
    expect(await after.ownership.forTab('tab')).toMatchObject({ state: 'deleted' })
    await expect(after.relay.ops.getTabState('tab')).rejects.toThrow(/deleted/i)
    restored.prepare("UPDATE tasks SET deleted_at=NULL,archived_at=NULL WHERE id='task'").run()
    await after.lifecycle.syncTask('task')
    expect(
      await f.request({ kind: 'task.lifecycle', taskId: 'task', state: 'active', revision: 999 })
    ).toMatchObject({ state: 'deleted' })
    expect(await f.request({ kind: 'inventory' })).toEqual(
      expect.arrayContaining([expect.objectContaining({ state: 'deleted' })])
    )
    await expect(
      after.relay.ops.saveTabDraft('tab', { text: 'cannot resurrect', attachments: [] })
    ).rejects.toThrow(/deleted/i)
  } finally {
    restored?.close()
    await f.close()
  }
})

test('retention skips truly prepared and Trash content across restart while pruning other cold history', async () => {
  const now = Date.now(),
    old = now - 4 * 86_400_000,
    dir = root()
  const source = runtime(root(), 'source'),
    target = runtime(dir)
  source.bootstrap(value('prepared'))
  source.storage.append(
    'prepared',
    1,
    { kind: 'notice', id: 'notice', level: 'info', text: 'prepared must survive' },
    old
  )
  source.storage.freeze('prepared', 1, 'move')
  target.storage.stage(source.storage.exportConversation('prepared', 1, 'move'))
  target.bootstrap(value('trash'))
  target.bootstrap(value('cold'))
  target.storage.append(
    'trash',
    1,
    { kind: 'notice', id: 'notice', level: 'info', text: 'undo must preserve' },
    old
  )
  target.storage.append(
    'cold',
    1,
    { kind: 'notice', id: 'notice', level: 'info', text: 'expire me' },
    old
  )
  await target.applyTaskLifecycle('trash', 'paused', 1)
  const prepared = target.storage.records('prepared'),
    trash = target.storage.read('trash', -1)
  target.retention.configure(1)
  await target.retention.runNow(now)
  expect(target.storage.records('prepared')).toEqual(prepared)
  expect(target.storage.read('prepared', -1)).toHaveLength(1)
  expect(target.storage.read('trash', -1)).toEqual(trash)
  expect(target.storage.read('cold', -1)).toEqual([])
  await target.close()
  const reopened = runtime(dir)
  await reopened.retention.runNow(now)
  expect(reopened.storage.conversation('prepared')?.state).toBe('prepared')
  expect(reopened.storage.read('prepared', -1)).toHaveLength(1)
  expect(reopened.storage.read('trash', -1)).toEqual(trash)
  await reopened.applyTaskLifecycle('trash', 'active', 2)
  await reopened.retention.runNow(now)
  expect(reopened.storage.read('trash', -1)).toEqual([])
  expect(reopened.storage.read('prepared', -1)).toHaveLength(1)
})

async function backupFixture() {
  const r = runtime()
  r.bootstrap(value('c'))
  const bytes = Buffer.from('verified archive bytes')
  const ref = r.attachments.put(
    'c',
    {
      artifactId: 'f',
      name: 'archive.txt',
      kind: 'text',
      mediaType: 'text/plain',
      size: bytes.length
    },
    bytes
  )
  r.storage.append(
    'c',
    1,
    { kind: 'notice', id: 'notice', level: 'info', text: 'archive marker' },
    1
  )
  const backup = await r.backups.create(),
    manifestPath = join(r.backups.dir, backup.id, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    scope: string
    files: Array<{ path: string; hash: string; size: number }>
  }
  return { r, ref, bytes, backup, manifestPath, manifest }
}
test.each(['wrong-scope', 'duplicate-file', 'missing-database', 'corrupt-blob'] as const)(
  'archive publication rejects malformed backup %s',
  async (kind) => {
    const f = await backupFixture()
    const good = await f.r.backups.restore(f.backup.id)
    if (kind === 'wrong-scope') f.manifest.scope = 'another-hub'
    if (kind === 'duplicate-file') f.manifest.files.push(f.manifest.files[0])
    if (kind === 'missing-database')
      f.manifest.files = f.manifest.files.filter((file) => file.path !== 'chat.sqlite')
    if (kind === 'corrupt-blob')
      writeFileSync(join(f.r.backups.dir, f.backup.id, 'blobs', f.ref.contentHash!), 'bad bytes')
    writeFileSync(f.manifestPath, JSON.stringify(f.manifest))
    await expect(f.r.backups.restore(f.backup.id)).rejects.toThrow()
    expect(f.r.backups.listArchives()).toHaveLength(1)
    expect(f.r.backups.attachment(good.id, 'c', f.ref)).toEqual(f.bytes)
  }
)

test('archive publication rejects an omitted blob still referenced by the snapshot database', async () => {
  const f = await backupFixture()
  const blob = `blobs/${f.ref.contentHash}`
  f.manifest.files = f.manifest.files.filter((file) => file.path !== blob)
  rmSync(join(f.r.backups.dir, f.backup.id, blob))
  writeFileSync(f.manifestPath, JSON.stringify(f.manifest))
  await expect(f.r.backups.restore(f.backup.id)).rejects.toThrow(
    /missing|blob|reference|integrity/i
  )
  expect(f.r.backups.listArchives()).toEqual([])
})
