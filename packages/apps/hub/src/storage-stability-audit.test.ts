import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createTestHarness, createSlayzoneDbAdapter } from '../../../shared/test-utils/ipc-harness'
import { createComputerChatRuntime } from '../../../domains/chat-runtime/src/server/computer-runtime'
import { createChatOwnershipStore } from '../../../domains/chat-runtime/src/server/hub-ownership'
import { createLegacyChatSource } from '../../../domains/chat-runtime/src/server/legacy-source'
import { createChatMigration } from '../../../domains/chat-runtime/src/server/migration'
import { createChatRuntimeHandlers } from '../../computer/src/handlers/chat-runtime'
import { openChatStorage } from '../../../domains/chat-runtime/src/server/storage'
import { buildBackupOps } from './backup'

const dirs: string[] = []
const runtimes: ReturnType<typeof createComputerChatRuntime>[] = []
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex')
function runtime(scope = 'hub') {
  const dir = mkdtempSync(join(tmpdir(), 'storage-stability-audit-'))
  dirs.push(dir)
  const r = createComputerChatRuntime({ stateDir: dir, hubScope: scope, computerId: 'pc' })
  runtimes.push(r)
  return r
}
function bootstrap(id: string, taskId = 'task', model = id) {
  return {
    identity: { id, taskId, tabId: id, mode: 'claude-chat', epoch: 1 },
    projectId: null,
    cwd: '/tmp',
    revision: 1,
    providerConfig: { chatModel: model },
    defaultFlags: null,
    env: {}
  }
}
function preparedAlongsideActive() {
  const source = runtime('source'),
    target = runtime('target')
  target.bootstrap(bootstrap('z-active', 'task', 'sonnet'))
  source.bootstrap(bootstrap('a-prepared', 'task', 'opus'))
  source.storage.freeze('a-prepared', 1, 'move')
  target.storage.stage(source.storage.exportConversation('a-prepared', 1, 'move'))
  return { source, target }
}
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('task configuration reads choose active storage while another tab is only prepared', async () => {
  const { target } = preparedAlongsideActive()
  expect(
    await target.invoke({
      route: { id: 'z-active', epoch: 1 },
      target: 'ops',
      method: 'getModel',
      args: ['task', 'claude-chat']
    })
  ).toBe('sonnet')
})

test('task configuration writes continue on an active tab while another tab is only prepared', async () => {
  const { target } = preparedAlongsideActive()
  await expect(
    target.local.data.writeChatModel('task', 'claude-chat', 'haiku')
  ).resolves.toBeUndefined()
  expect(target.storage.getRecord('z-active', 'settings', 'provider')).toMatchObject({
    chatModel: 'haiku'
  })
})

test.each(['legacy', 'copying', 'verified'] as const)(
  'hub backup never publishes unrecoverable %s history',
  async (state) => {
    const h = await createTestHarness()
    const dir = mkdtempSync(join(tmpdir(), 'hub-backup-stability-'))
    dirs.push(dir)
    try {
      h.db.exec(
        "INSERT INTO projects(id,name,color) VALUES('p','P','#000'); INSERT INTO tasks(id,project_id,title) VALUES('task','p','Task'); INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
      )
      h.db.prepare("INSERT INTO chat_events(tab_id,seq,event,saved_at) VALUES('tab',0,?,1)").run(
        JSON.stringify({
          kind: 'assistant-text',
          messageId: 'm',
          text: 'only recoverable history'
        })
      )
      const owners = createChatOwnershipStore(h.slayDb)
      await owners.register({
        id: 'owner',
        taskId: 'task',
        tabId: 'tab',
        mode: 'claude-chat',
        computerId: null,
        epoch: 1
      })
      if (state !== 'legacy')
        await owners.beginMigration('owner', {
          expectedComputerId: null,
          expectedEpoch: 1,
          migrationId: 'move',
          destinationComputerId: 'pc'
        })
      if (state === 'verified') await owners.markVerified('owner', 'move', 'a'.repeat(64))
      const ops = buildBackupOps({
        db: {
          ...h.slayDb,
          backup: async (path: string) => {
            await h.db.backup(path)
          }
        },
        dataRoot: dir,
        dbPath: join(dir, 'slayzone.dev.data.sqlite'),
        supervised: true,
        closeDb: async () => {},
        appRelaunch: () => {},
        shellOpenPath: () => {}
      })
      let rejected = false,
        remaining = 0
      let published: { filename: string } | null = null
      try {
        published = await ops.create('during-migration')
      } catch {
        rejected = true
      }
      if (published) {
        const restored = new Database(join(dir, 'backups', published.filename), { readonly: true })
        try {
          expect(restored.prepare('SELECT state FROM chat_ownership').get()).toEqual({ state })
          remaining = (
            restored.prepare('SELECT count(*) n FROM chat_events').get() as { n: number }
          ).n
        } finally {
          restored.close()
        }
      }
      expect(h.db.prepare('SELECT count(*) n FROM chat_events').get()).toEqual({ n: 1 })
      // Either defer the backup until cutover or preserve a recoverable source.
      expect(
        rejected || remaining > 0,
        'Published snapshot retains pending owner but removes its only source history'
      ).toBe(true)
    } finally {
      h.cleanup()
    }
  }
)

test('computer backup remains available for active history during an interrupted attachment transfer', async () => {
  const source = runtime('source'),
    target = runtime('target')
  source.bootstrap(bootstrap('incoming'))
  const bytes = Buffer.from('waiting attachment')
  source.attachments.put(
    'incoming',
    {
      artifactId: 'f',
      name: 'file.txt',
      kind: 'text',
      mediaType: 'text/plain',
      size: bytes.length
    },
    bytes
  )
  source.storage.freeze('incoming', 1, 'move')
  target.bootstrap(bootstrap('active', 'other'))
  target.storage.append(
    'active',
    1,
    { kind: 'assistant-text', messageId: 'm', text: 'already owned' },
    1
  )
  target.storage.stage(source.storage.exportConversation('incoming', 1, 'move'))
  await expect(target.backups.create('manual')).resolves.toMatchObject({ events: 1 })
})

test('legacy draft attachment keeps current bytes when a pinned older version shares its artifact id', async () => {
  const h = await createTestHarness(),
    target = runtime()
  try {
    h.db.exec(
      "INSERT INTO projects(id,name,color) VALUES('p','P','#000'); INSERT INTO tasks(id,project_id,title) VALUES('task','p','Task'); INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
    )
    const [older, current] = [
      Buffer.from('first attachment'),
      Buffer.from('second attachment')
    ].sort((a, b) => hash(a).localeCompare(hash(b)))
    const ref = {
      artifactId: 'f',
      name: 'file.txt',
      kind: 'text' as const,
      mediaType: 'text/plain' as const,
      size: current.length
    }
    h.db
      .prepare('INSERT INTO task_artifacts(id,task_id,title) VALUES(?,?,?)')
      .run('f', 'task', 'file.txt')
    h.db
      .prepare(
        'INSERT INTO artifact_versions(id,artifact_id,version_num,content_hash,size) VALUES(?,?,?,?,?)'
      )
      .run('current', 'f', 2, hash(current), current.length)
    h.db
      .prepare(
        'INSERT INTO artifact_versions(id,artifact_id,version_num,content_hash,size) VALUES(?,?,?,?,?)'
      )
      .run('older', 'f', 1, hash(older), older.length)
    h.db.prepare("UPDATE task_artifacts SET current_version_id='current' WHERE id='f'").run()
    h.db.prepare("INSERT INTO chat_events(tab_id,seq,event,saved_at) VALUES('tab',0,?,1)").run(
      JSON.stringify({
        kind: 'user-message',
        id: 'm',
        text: 'old',
        content: [
          {
            type: 'attachment',
            attachment: { ...ref, contentHash: hash(older), size: older.length }
          }
        ]
      })
    )
    h.db
      .prepare("INSERT INTO chat_tab_state(tab_id,draft_attachments,updated_at) VALUES('tab',?,2)")
      .run(JSON.stringify([ref]))
    const owners = createChatOwnershipStore(h.slayDb)
    const owner = await owners.register({
      id: 'owner',
      taskId: 'task',
      tabId: 'tab',
      mode: 'claude-chat',
      computerId: null,
      epoch: 1
    })
    const source = createLegacyChatSource({
      db: h.slayDb,
      quiesce: async () => {},
      bootstrap: async () => ({
        ...bootstrap('owner'),
        identity: { id: 'owner', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 2 }
      }),
      readAttachment: async (o, r) => (r.contentHash === hash(older) ? older : current)
    })
    await owners.beginMigration('owner', {
      expectedComputerId: null,
      expectedEpoch: 1,
      migrationId: 'move',
      destinationComputerId: 'pc'
    })
    const exp = await source.open(owner, 'move'),
      begin = target.transfers.begin(exp.manifest)
    let offset = 0
    for await (const chunk of exp.chunks(0)) {
      target.transfers.chunk(begin.id, offset, chunk)
      offset += chunk.length
    }
    target.transfers.finish(begin.id)
    for (const missing of target.attachments.missing('owner'))
      target.attachments.putPrepared(
        'owner',
        2,
        missing,
        missing.contentHash === hash(older) ? older : current
      )
    target.storage.activate('owner', 'move', 2, exp.manifest.hash)
    const draft = await target.ops.getTabState('tab')
    expect(draft?.draft.attachments).toHaveLength(1)
    expect(Buffer.from(await target.attachments.reader.read(draft!.draft.attachments[0]))).toEqual(
      current
    )
  } finally {
    h.cleanup()
  }
})

test.each(['legacy', 'copying'] as const)(
  'restoring a new hub backup cannot activate empty history for a %s conversation',
  async (state) => {
    const h = await createTestHarness()
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'restore-history-audit-'))
    dirs.push(dir)
    const pcDir = join(dir, 'computer')
    const pc = createChatRuntimeHandlers({
      stateDir: pcDir,
      hubScope: 'restore',
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
    let restored: Database.Database | undefined
    try {
      h.db.exec(
        "INSERT INTO projects(id,name,color) VALUES('p','P','#000'); INSERT INTO tasks(id,project_id,title) VALUES('task','p','Task'); INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
      )
      h.db.prepare("INSERT INTO chat_events(tab_id,seq,event,saved_at) VALUES('tab',0,?,1)").run(
        JSON.stringify({
          kind: 'assistant-text',
          messageId: 'm',
          text: 'only recoverable history'
        })
      )
      const owners = createChatOwnershipStore(h.slayDb)
      await owners.register({
        id: 'owner',
        taskId: 'task',
        tabId: 'tab',
        mode: 'claude-chat',
        computerId: null,
        epoch: 1
      })
      if (state === 'copying')
        await owners.beginMigration('owner', {
          expectedComputerId: null,
          expectedEpoch: 1,
          migrationId: 'move',
          destinationComputerId: 'pc'
        })
      const ops = buildBackupOps({
        db: {
          ...h.slayDb,
          backup: async (path: string) => {
            await h.db.backup(path)
          }
        },
        dataRoot: dir,
        dbPath: join(dir, 'slayzone.dev.data.sqlite'),
        supervised: true,
        closeDb: async () => {},
        appRelaunch: () => {},
        shellOpenPath: () => {}
      })
      const backup = await ops.create('before-cutover')
      restored = new Database(join(dir, 'backups', backup.filename))
      const db = createSlayzoneDbAdapter(restored),
        ownership = createChatOwnershipStore(db)
      const source = createLegacyChatSource({
        db,
        quiesce: async () => {},
        bootstrap: async (o) => ({
          ...bootstrap('owner'),
          identity: {
            id: o.id,
            taskId: o.taskId,
            tabId: o.tabId,
            mode: o.mode,
            epoch: o.epoch + 1
          },
          cwd: dir
        }),
        readAttachment: async () => {
          throw new Error('No attachment expected')
        }
      })
      const migration = createChatMigration({
        ownership,
        source,
        request: (_id, req) => pc.request(JSON.parse(JSON.stringify(req)))
      })
      await migration.ensure('owner', 'pc')
      expect(await ownership.get('owner')).toMatchObject({
        state: 'active',
        epoch: 2,
        cleanupPending: false
      })
      expect(await pc.request({ kind: 'inspect', id: 'owner' })).toMatchObject({ state: 'active' })
      await pc.close()
      const destination = openChatStorage({ stateDir: pcDir, hubScope: 'restore' })
      try {
        // Both production endpoints and the hub accepted the cutover; source event must survive restore.
        expect(destination.read('owner', -1)).toMatchObject([
          { event: { text: 'only recoverable history' } }
        ])
      } finally {
        destination.close()
      }
    } finally {
      await pc.close()
      restored?.close()
      h.cleanup()
    }
  }
)
