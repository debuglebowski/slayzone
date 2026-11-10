import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createTestHarness, createSlayzoneDbAdapter } from '../../../shared/test-utils/ipc-harness'
import { createFixtureChatRuntime } from '../../computer/src/project-scope.fixture'
import { createChatOwnershipStore } from '../../../domains/chat-runtime/src/server/hub-ownership'
import {
  createLegacyChatSource,
  type LegacyChatDiagnostics
} from '../../../domains/chat-runtime/src/server/legacy-source'
import { createLegacyChatDiagnostics } from './chat-diagnostics'
import { openChatStorage } from '../../../domains/chat-runtime/src/server/storage'
import { createChatMigration } from '../../../domains/chat-runtime/src/server/migration'
import { createChatRecovery } from '../../../domains/chat-runtime/src/server/hub-recovery'
import { createComputerChatServices } from './computer-chat'
import { createDbChatDataOps } from '@slayzone/terminal/server'
import { taskSessionStore } from './test-session-store'
import type { ChatRecord } from '../../../domains/chat-runtime/src/shared'
import {
  encodeTransfer,
  TRANSFER_CHUNK_BYTES
} from '../../../domains/chat-runtime/src/server/transfers'
import { createChatMigrationAttachmentReader } from '../../../domains/chat-runtime/src/server/migration-attachments'

const originalBytes = Buffer.from('file version A')
const editedBytes = Buffer.from('file version B')
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function fixture(
  unsealed = false,
  registered = true,
  diagnostics?: LegacyChatDiagnostics,
  realArtifacts = false
) {
  const h = await createTestHarness()
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'chat-migration-audit-'))
  h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','Project','#000')").run()
  h.db
    .prepare('INSERT INTO tasks(id,project_id,title,has_worktree) VALUES(?,?,?,1)')
    .run('task', 'p', 'Task')
  h.db
    .prepare(
      "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
    )
    .run()
  const ref = {
    artifactId: 'attachment',
    name: 'saved.txt',
    size: originalBytes.length,
    kind: 'text' as const,
    mediaType: 'text/plain' as const,
    ...(!unsealed ? { contentHash: hash(originalBytes) } : {})
  }
  h.db
    .prepare(
      "INSERT INTO chat_tab_state(tab_id,draft_text,draft_attachments,rev,updated_at) VALUES('tab','preserved draft',?,3,123)"
    )
    .run(JSON.stringify([ref]))
  h.db
    .prepare("INSERT INTO chat_events(tab_id,seq,event,saved_at) VALUES('tab',0,?,123)")
    .run(JSON.stringify({ kind: 'assistant-text', messageId: 'large', text: 'x'.repeat(300_000) }))
  {
    h.db
      .prepare(
        "INSERT INTO task_artifacts(id,task_id,title) VALUES('attachment','task','saved.txt')"
      )
      .run()
    h.db
      .prepare(
        "INSERT INTO artifact_versions(id,artifact_id,version_num,content_hash,size) VALUES('v1','attachment',1,?,?)"
      )
      .run(hash(originalBytes), originalBytes.length)
    h.db
      .prepare(
        "INSERT INTO artifact_versions(id,artifact_id,version_num,content_hash,size) VALUES('v2','attachment',2,?,?)"
      )
      .run(hash(editedBytes), editedBytes.length)
    h.db.prepare("UPDATE task_artifacts SET current_version_id='v1' WHERE id='attachment'").run()
  }
  const ownership = createChatOwnershipStore(h.slayDb)
  if (registered)
    await ownership.register({
      id: 'store',
      taskId: 'task',
      tabId: 'tab',
      mode: 'claude-chat',
      epoch: 1,
      computerId: null
    })
  const openComputer = () =>
    createFixtureChatRuntime({
      taskFolder: () => dir,
      stateDir: dir,
      hubScope: 'audit',
      computerId: () => 'pc',
      getProjectPaths: () => null,
      ctx: {
        config: {
          hubUrl: 'ws://audit/computers',
          name: 'audit',
          allowedRoots: [realpathSync(tmpdir())],
          capabilities: ['proc']
        },
        dialer: { notify: () => true },
        log: () => {}
      }
    })
  let computer = openComputer()
  let failKind = '',
    failAt = 1,
    seen = 0
  const request = async (_computerId: string, raw: unknown) => {
    // The actual endpoint parses serialized requests and uses the durable local DB.
    const req = JSON.parse(JSON.stringify(raw)) as { kind: string }
    const result = await computer.request(req)
    if (req.kind === failKind && ++seen === failAt) {
      failKind = ''
      throw new Error('Lost reply after ' + req.kind)
    }
    return JSON.parse(JSON.stringify(result ?? null))
  }
  const pinnedReader = realArtifacts
    ? createChatMigrationAttachmentReader(h.slayDb, dir)
    : undefined
  const source = createLegacyChatSource({
    db: h.slayDb,
    diagnostics,
    quiesce: async () => {},
    bootstrap: async (owner) => ({
      identity: {
        id: owner.id,
        taskId: owner.taskId,
        tabId: owner.tabId,
        mode: owner.mode,
        epoch: owner.epoch + 1
      },
      projectId: 'p',
      cwd: dir,
      revision: 0,
      providerConfig: {},
      defaultFlags: null,
      env: {}
    }),
    freezeMetadata: async (owner, migrationId, candidate) =>
      request('pc', {
        kind: 'migration.checkpoint',
        identity: {
          id: owner.id,
          taskId: owner.taskId,
          tabId: owner.tabId,
          mode: owner.mode,
          epoch: owner.epoch
        },
        migrationId,
        ...(candidate ? { candidate } : {})
      }) as Promise<ChatRecord[] | null>,
    readAttachment: async (_owner, ref) =>
      ref.contentHash === hash(editedBytes) ? editedBytes : originalBytes,
    readPinnedAttachment: pinnedReader,
    collectReleasedAttachments: pinnedReader?.collectGarbage
  })
  return {
    h,
    dir,
    source,
    ownership,
    request,
    ref,
    migration: () => createChatMigration({ ownership, source, request }),
    failReply(kind: string, nth = 1) {
      failKind = kind
      failAt = nth
      seen = 0
    },
    async restart() {
      await computer.close()
      computer = openComputer()
    },
    async close() {
      await computer.close()
      h.cleanup()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

const replyFaults = [
  ['migration.checkpoint', 1],
  ['migration.checkpoint', 2],
  ['transfer.begin', 1],
  ['transfer.chunk', 1],
  ['transfer.chunk', 2],
  ['transfer.finish', 1],
  ['migration.verify', 1],
  ['migration.verify', 2],
  ['attachment.put', 1],
  ['migration.activate', 1]
] as const

test.each(replyFaults)(
  'migration survives lost %s reply %i and computer restart',
  async (kind, nth) => {
    const f = await fixture()
    try {
      f.failReply(kind, nth)
      await expect(f.migration().ensure('store', 'pc')).rejects.toThrow('Lost reply after ' + kind)
      const pending = await f.ownership.get('store')
      expect(pending!.cleanupPending || pending!.state === 'copying').toBe(true)
      expect(
        f.h.db.prepare("SELECT draft_text FROM chat_tab_state WHERE tab_id='tab'").get()
      ).toEqual({ draft_text: 'preserved draft' })
      await f.restart()
      const complete = await f.migration().ensure('store', 'pc')
      expect(complete).toMatchObject({
        state: 'active',
        epoch: 2,
        computerId: 'pc',
        cleanupPending: false,
        migrationId: pending!.migrationId
      })
      expect(
        f.h.db.prepare("SELECT 1 FROM chat_tab_state WHERE tab_id='tab'").get()
      ).toBeUndefined()
      expect(
        await f.request('pc', {
          kind: 'attachment.read',
          route: { id: 'store', epoch: 2 },
          ref: f.ref
        })
      ).toEqual({ data: originalBytes.toString('base64') })
    } finally {
      await f.close()
    }
  }
)

test('migration resumes prepared legacy attachment after the source artifact is edited', async () => {
  const f = await fixture(true)
  try {
    f.failReply('transfer.finish')
    await expect(f.migration().ensure('store', 'pc')).rejects.toThrow(
      'Lost reply after transfer.finish'
    )
    const pending = await f.ownership.get('store')
    const before = await f.source.open(pending!, pending!.migrationId!)
    f.h.db.prepare("UPDATE task_artifacts SET current_version_id='v2' WHERE id='attachment'").run()
    const after = await f.source.open(pending!, pending!.migrationId!)
    // Editing the artifact is legal while the durable chat gate is closed.
    // The durable checkpoint pins attachment versions before any export pass.
    expect(after.manifest.hash).toBe(before.manifest.hash)
    await f.restart()
    // Required property: previously prepared bytes remain resumable using their original manifest.
    await expect(f.migration().ensure('store', 'pc')).resolves.toMatchObject({
      state: 'active',
      epoch: 2,
      computerId: 'pc',
      cleanupPending: false
    })
  } finally {
    await f.close()
  }
})

test('legacy event pagination seeks by sequence without sorting the entire conversation per page', async () => {
  const f = await fixture()
  try {
    const plans: string[] = []
    const originalAll = f.h.slayDb.all.bind(f.h.slayDb)
    f.h.slayDb.all = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      if (sql.includes('FROM chat_events')) {
        const plan = f.h.db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params) as {
          detail: string
        }[]
        plans.push(...plan.map((row) => row.detail))
      }
      return originalAll<T>(sql, params)
    }
    const owner = await f.ownership.beginMigration('store', {
      expectedComputerId: null,
      expectedEpoch: 1,
      migrationId: 'plan-audit',
      destinationComputerId: 'pc'
    })
    await f.source.open(owner, 'plan-audit')
    expect(plans.length).toBeGreaterThan(0)
    // This inspects actual export queries, not a hand-copied query.
    // Repeated full-conversation sorts make migration superlinear despite 256-row batches.
    expect(plans.join('\n')).not.toMatch(/TEMP B-TREE/)
  } finally {
    await f.close()
  }
})

test('restoring pre-migration hub metadata can recover a prepared computer store', async () => {
  const f = await fixture()
  try {
    f.failReply('transfer.finish')
    await expect(f.migration().ensure('store', 'pc')).rejects.toThrow(
      'Lost reply after transfer.finish'
    )
    // This is exactly the locator in an older hub snapshot: same storage id,
    // full original chat data, migration not started yet. The computer DB survives.
    f.h.db
      .prepare(
        "UPDATE chat_ownership SET state='legacy',computer_id=NULL,epoch=1,migration_id=NULL,destination_computer_id=NULL,source_computer_id=NULL,manifest_hash=NULL,cleanup_pending=0 WHERE id='store'"
      )
      .run()
    expect(
      f.h.db.prepare("SELECT draft_text FROM chat_tab_state WHERE tab_id='tab'").get()
    ).toEqual({ draft_text: 'preserved draft' })
    await f.restart()
    await createChatRecovery({ db: f.h.slayDb, request: f.request }).reconcile('pc')
    const restored = f.migration()
    await expect(restored.ensure('store', 'pc')).resolves.toMatchObject({
      state: 'active',
      epoch: 2,
      computerId: 'pc',
      cleanupPending: false
    })
  } finally {
    await f.close()
  }
})

// Prompts are not legacy chat content any more: v207 hands them to the computer.
test.each(['claude-code', 'codex', 'gemini', 'removed-provider', 'shell'] as const)(
  'idle migration covers old chat rows on a tab now in %s mode',
  async (mode) => {
    const f = await fixture(false, false)
    try {
      // A legitimate pre-upgrade DB after user continued a chat in its native terminal.
      // No ownership rows yet, but the old chat events and draft remain under the tab id.
      f.h.db.prepare("UPDATE terminal_tabs SET mode=? WHERE id='tab'").run(mode)
      const services = createComputerChatServices({
        db: f.h.slayDb,
        legacyData: {
          ...createDbChatDataOps(f.h.slayDb, taskSessionStore),
          buildMcpEnv: async () => ({})
        },
        attachments: { read: async () => originalBytes },
        request: f.request,
        resolveComputer: async () => 'pc',
        defaultComputer: async () => 'pc',
        hasLiveTask: async () => false
      })
      await services.relay.ops.getTabState('tab')
      await services.migrateIdleComputer('pc')
      services.invalidateRecovery('pc')
      await services.recoverComputer('pc')
      await services.migrateIdleComputer('pc')
      const inventory = (await f.request('pc', { kind: 'inventory' })) as Array<{
        identity: { tabId: string }
      }>
      // Background prompt migration and later computer reconciliation must cover dormant chat content too.
      const actual = {
        sourceEvents: (
          f.h.db.prepare("SELECT count(*) AS n FROM chat_events WHERE tab_id='tab'").get() as {
            n: number
          }
        ).n,
        sourceDraft: !!f.h.db.prepare("SELECT 1 FROM chat_tab_state WHERE tab_id='tab'").get(),
        ownerPresent: !!(await services.ownership.forTab('tab')),
        computerStorePresent: inventory.some((o) => o.identity.tabId === 'tab')
      }
      expect(actual).toEqual({
        sourceEvents: 0,
        sourceDraft: false,
        ownerPresent: true,
        computerStorePresent: true
      })
    } finally {
      await f.close()
    }
  }
)

test('idle migration covers timeline-only history after the terminal mode changed', async () => {
  const f = await fixture(false, false)
  try {
    f.h.db.exec(
      "DELETE FROM chat_events; DELETE FROM chat_tab_state; UPDATE terminal_tabs SET mode='codex' WHERE id='tab'"
    )
    f.h.db
      .prepare(
        "INSERT INTO chat_timeline_pages(tab_id,page,start_row,end_row,rows,summary,search_text) VALUES('tab',0,0,1,?,'{}','retained timeline')"
      )
      .run(JSON.stringify([{ kind: 'assistant', text: 'retained timeline' }]))
    const services = createComputerChatServices({
      db: f.h.slayDb,
      legacyData: {
        ...createDbChatDataOps(f.h.slayDb, taskSessionStore),
        buildMcpEnv: async () => ({})
      },
      attachments: { read: async () => originalBytes },
      request: f.request,
      resolveComputer: async () => 'pc',
      defaultComputer: async () => 'pc',
      hasLiveTask: async () => false
    })
    await services.migrateIdleComputer('pc')
    const owner = await services.ownership.forTab('tab')
    expect(owner).toMatchObject({ state: 'active', computerId: 'pc', cleanupPending: false })
    expect(
      f.h.db.prepare("SELECT count(*) AS n FROM chat_timeline_pages WHERE tab_id='tab'").get()
    ).toEqual({ n: 0 })
    const sqlite = new Database(
      join(
        f.dir,
        'computer-runtime',
        createHash('sha256').update(JSON.stringify('audit')).digest('hex'),
        'chat.sqlite'
      ),
      { readonly: true }
    )
    try {
      const retained = sqlite
        .prepare(
          "SELECT value FROM records WHERE conversation_id=? AND kind='timeline' AND id='page:0'"
        )
        .get(owner!.id) as { value: string }
      expect(JSON.parse(retained.value)).toMatchObject({
        rows: JSON.stringify([{ kind: 'assistant', text: 'retained timeline' }])
      })
    } finally {
      sqlite.close()
    }
    expect(f.h.db.prepare("SELECT mode FROM terminal_tabs WHERE id='tab'").get()).toEqual({
      mode: 'codex'
    })
  } finally {
    await f.close()
  }
})

test('upgrading an old metadata-only checkpoint freezes attachment HEAD across a partial-transfer restart', async () => {
  const f = await fixture(true)
  try {
    const owner = (await f.ownership.get('store'))!
    const migrationId = 'old-metadata-checkpoint'
    await f.ownership.beginMigration(owner.id, {
      expectedComputerId: null,
      expectedEpoch: owner.epoch,
      migrationId,
      destinationComputerId: 'pc'
    })
    await f.request('pc', {
      kind: 'migration.checkpoint',
      identity: {
        id: owner.id,
        taskId: owner.taskId,
        tabId: owner.tabId,
        mode: owner.mode,
        epoch: owner.epoch
      },
      migrationId,
      candidate: [{ kind: 'settings', id: 'provider', value: {}, at: 0 }]
    })
    f.failReply('transfer.chunk')
    await expect(f.migration().ensure('store', 'pc')).rejects.toThrow(
      'Lost reply after transfer.chunk'
    )
    f.h.db.prepare("UPDATE task_artifacts SET current_version_id='v2' WHERE id='attachment'").run()
    await f.restart()
    expect(await f.migration().ensure('store', 'pc')).toMatchObject({
      state: 'active',
      epoch: 2,
      cleanupPending: false
    })
    const state = (await f.request('pc', {
      kind: 'invoke',
      value: {
        route: { id: 'store', epoch: 2 },
        target: 'ops',
        method: 'getTabState',
        args: ['tab']
      }
    })) as { draft: { attachments: Array<{ contentHash: string }> } }
    expect(state.draft.attachments[0].contentHash).toBe(hash(originalBytes))
    expect(
      await f.request('pc', {
        kind: 'attachment.read',
        route: { id: 'store', epoch: 2 },
        ref: { ...f.ref, contentHash: hash(originalBytes) }
      })
    ).toEqual({ data: originalBytes.toString('base64') })
  } finally {
    await f.close()
  }
})

test('a pre-fix prepared transfer resumes its saved manifest after artifact HEAD changes', async () => {
  const f = await fixture(true)
  try {
    const owner = (await f.ownership.get('store'))!,
      migrationId = 'old-prepared-format'
    await f.ownership.beginMigration(owner.id, {
      expectedComputerId: null,
      expectedEpoch: owner.epoch,
      migrationId,
      destinationComputerId: 'pc'
    })
    const payload = encodeTransfer({
      version: 1,
      migrationId,
      identity: {
        id: owner.id,
        taskId: owner.taskId,
        tabId: owner.tabId,
        mode: owner.mode,
        epoch: owner.epoch
      },
      events: [
        {
          seq: 0,
          at: 123,
          event: { kind: 'assistant-text', messageId: 'large', text: 'x'.repeat(300_000) }
        }
      ],
      records: [
        {
          kind: 'draft',
          id: 'state',
          value: { draft: { text: 'preserved draft', attachments: [f.ref], rev: 3 }, scroll: null },
          at: 123
        },
        {
          kind: 'attachment',
          id: `attachment:${hash(originalBytes)}`,
          value: { ...f.ref, contentHash: hash(originalBytes), taskId: 'task' },
          at: 0
        }
      ],
      receipts: [],
      hash: ''
    })
    const start = (await f.request('pc', {
      kind: 'transfer.begin',
      manifest: payload.manifest
    })) as { id: string }
    for (let offset = 0; offset < payload.bytes.length; offset += TRANSFER_CHUNK_BYTES)
      await f.request('pc', {
        kind: 'transfer.chunk',
        id: start.id,
        offset,
        data: payload.bytes.subarray(offset, offset + TRANSFER_CHUNK_BYTES).toString('base64')
      })
    await f.request('pc', { kind: 'transfer.finish', id: start.id })
    f.h.db.prepare("UPDATE task_artifacts SET current_version_id='v2' WHERE id='attachment'").run()
    await f.restart()
    expect(await f.migration().ensure('store', 'pc')).toMatchObject({
      state: 'active',
      epoch: 2,
      cleanupPending: false,
      manifestHash: payload.manifest.hash
    })
    expect(
      await f.request('pc', {
        kind: 'attachment.read',
        route: { id: 'store', epoch: 2 },
        ref: f.ref
      })
    ).toEqual({ data: originalBytes.toString('base64') })
  } finally {
    await f.close()
  }
})

test('native-only content leader cleans copied diagnostics after deleting its last source rows', async () => {
  const raw = new Database(':memory:')
  raw.exec(
    'CREATE TABLE diagnostics_events(id TEXT PRIMARY KEY,task_id TEXT,event TEXT,message TEXT,payload_json TEXT,ts_ms INTEGER)'
  )
  raw
    .prepare('INSERT INTO diagnostics_events VALUES(?,?,?,?,?,?)')
    .run('private', 'task', 'chat.failed', 'private-native-diagnostic-marker', '{}', 1)
  const diagnostics = createLegacyChatDiagnostics({ db: createSlayzoneDbAdapter(raw) })
  const f = await fixture(false, true, diagnostics)
  try {
    f.h.db.prepare("UPDATE terminal_tabs SET mode='claude-code' WHERE id='tab'").run()
    await f.migration().ensure('store', 'pc')
    expect(f.h.db.prepare("SELECT 1 FROM chat_events WHERE tab_id='tab'").get()).toBeUndefined()
    await f.restart()
    const local = openChatStorage({ stateDir: f.dir, hubScope: 'audit' })
    try {
      expect(JSON.stringify(local.records('store'))).toContain('private-native-diagnostic-marker')
    } finally {
      local.close()
    }
    expect(await diagnostics.tasks()).toEqual([])
    expect(raw.prepare("SELECT message FROM diagnostics_events WHERE id='private'").get()).toEqual({
      message: ''
    })
  } finally {
    await f.close()
    raw.close()
  }
})

test('idle migration covers a native parent whose only retained chat content is an answer thread', async () => {
  const f = await fixture(false, false)
  try {
    f.h.db.exec(
      "DELETE FROM chat_events; DELETE FROM chat_tab_state; UPDATE terminal_tabs SET mode='gemini' WHERE id='tab'; INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('child','task','gemini',1)"
    )
    f.h.db
      .prepare(
        "INSERT INTO chat_threads(id,parent_tab_id,task_id,mode,parent_conversation_id,answer_id,source_message_id,source_uuid,title,created_at) VALUES('child','tab','task','codex-chat','','','','','private orphan thread title',123)"
      )
      .run()
    const services = createComputerChatServices({
      db: f.h.slayDb,
      legacyData: {
        ...createDbChatDataOps(f.h.slayDb, taskSessionStore),
        buildMcpEnv: async () => ({})
      },
      attachments: { read: async () => originalBytes },
      request: f.request,
      resolveComputer: async () => 'pc',
      defaultComputer: async () => 'pc',
      hasLiveTask: async () => false
    })
    await services.migrateIdleComputer('pc')
    const owner = await services.ownership.forTab('tab')
    expect(owner).toMatchObject({ state: 'active', cleanupPending: false })
    expect(f.h.db.prepare("SELECT title FROM chat_threads WHERE id='child'").get()).toEqual({
      title: 'Thread'
    })
    const sqlite = new Database(
      join(
        f.dir,
        'computer-runtime',
        createHash('sha256').update(JSON.stringify('audit')).digest('hex'),
        'chat.sqlite'
      ),
      { readonly: true }
    )
    try {
      const record = sqlite
        .prepare(
          "SELECT value FROM records WHERE conversation_id=? AND kind='thread' AND id='child'"
        )
        .get(owner!.id) as { value: string }
      expect(JSON.parse(record.value)).toMatchObject({ title: 'private orphan thread title' })
    } finally {
      sqlite.close()
    }
  } finally {
    await f.close()
  }
})

// Turn previews are not legacy chat content any more: v207 hands turns to the computer.
test.each(['chat_attachment_messages'] as const)(
  'idle migration covers sole task-scoped legacy content in %s',
  async (_table) => {
    const f = await fixture(false, false)
    try {
      f.h.db.exec(
        "DELETE FROM chat_events; DELETE FROM chat_tab_state; UPDATE terminal_tabs SET mode='codex' WHERE id='tab'"
      )
      f.h.db
        .prepare(
          "INSERT INTO chat_attachment_messages(task_id,message_id,attachments) VALUES('task','orphan-message',?)"
        )
        .run(JSON.stringify([f.ref]))
      const services = createComputerChatServices({
        db: f.h.slayDb,
        legacyData: {
          ...createDbChatDataOps(f.h.slayDb, taskSessionStore),
          buildMcpEnv: async () => ({})
        },
        attachments: { read: async () => originalBytes },
        request: f.request,
        resolveComputer: async () => 'pc',
        defaultComputer: async () => 'pc',
        hasLiveTask: async () => false
      })
      await services.migrateIdleComputer('pc')
      const owner = await services.ownership.forTab('task-content:task')
      expect(owner).toMatchObject({ state: 'active', cleanupPending: false })
      const sqlite = new Database(
        join(
          f.dir,
          'computer-runtime',
          createHash('sha256').update(JSON.stringify('audit')).digest('hex'),
          'chat.sqlite'
        ),
        { readonly: true }
      )
      try {
        const key = 'attachment-message:orphan-message'
        const record = sqlite
          .prepare("SELECT value FROM records WHERE conversation_id=? AND kind='settings' AND id=?")
          .get(owner!.id, key) as { value: string }
        expect(JSON.parse(record.value)).toMatchObject([
          { artifactId: f.ref.artifactId, contentHash: hash(originalBytes) }
        ])
        expect(
          f.h.db
            .prepare("SELECT count(*) AS n FROM chat_attachment_messages WHERE task_id='task'")
            .get()
        ).toEqual({ n: 0 })
      } finally {
        sqlite.close()
      }
      expect(
        f.h.db
          .prepare("SELECT count(*) AS n FROM terminal_tabs WHERE id='prompt-history:task'")
          .get()
      ).toEqual({ n: 0 })
    } finally {
      await f.close()
    }
  }
)

test.each(['transfer.finish', 'migration.checkpoint'] as const)(
  'prepared migration keeps frozen attachment bytes through real editor autosave mutation after lost %s reply',
  async (failure) => {
    const f = await fixture(true, true, undefined, true)
    try {
      const { createArtifactStore } = await import('@slayzone/task-artifacts/server')
      const { createChatAttachmentReader } = await import('./chat-attachment-reader')
      const artifacts = createArtifactStore(f.dir)
      const artifact = await artifacts.uploadArtifactBlob(f.h.slayDb, {
        taskId: 'task',
        title: 'editor-context.txt',
        bytes: originalBytes
      })
      const ref = { ...f.ref, artifactId: artifact!.id }
      f.h.db
        .prepare("UPDATE chat_tab_state SET draft_attachments=? WHERE tab_id='tab'")
        .run(JSON.stringify([ref]))
      const reader = createChatAttachmentReader(f.h.slayDb, f.dir)
      f.h.db.prepare("DELETE FROM task_artifacts WHERE id='attachment'").run()
      f.failReply(failure, failure === 'migration.checkpoint' ? 2 : 1)
      await expect(f.migration().ensure('store', 'pc')).rejects.toThrow(
        'Lost reply after ' + failure
      )
      await artifacts.writeArtifactContent(f.h.slayDb, {
        artifactId: artifact!.id,
        bytes: editedBytes,
        mutateCurrent: true
      })
      await expect(reader.read({ ...ref, contentHash: hash(originalBytes) })).rejects.toThrow(
        /version not found/
      )
      await artifacts.pruneArtifactVersions(f.h.slayDb, {
        artifactId: artifact!.id,
        keepLast: 1,
        keepNamed: false
      })
      expect(
        f.h.db.prepare('SELECT count(*) AS n FROM artifact_blob_pins WHERE owner_id=?').get('store')
      ).toEqual({ n: 1 })
      await f.restart()
      await expect(f.migration().ensure('store', 'pc')).resolves.toMatchObject({
        state: 'active',
        cleanupPending: false
      })
      expect(
        await f.request('pc', {
          kind: 'attachment.read',
          route: { id: 'store', epoch: 2 },
          ref: { ...ref, contentHash: hash(originalBytes) }
        })
      ).toEqual({ data: originalBytes.toString('base64') })
      expect(
        f.h.db.prepare('SELECT count(*) AS n FROM artifact_blob_pins WHERE owner_id=?').get('store')
      ).toEqual({ n: 0 })
      const { BlobStore } = await import('@slayzone/task-artifacts/storage')
      expect(new BlobStore(f.dir).has(hash(originalBytes))).toBe(false)
      await artifacts.pruneArtifactVersions(f.h.slayDb, {
        artifactId: artifact!.id,
        keepLast: 1,
        keepNamed: false
      })
      expect(new BlobStore(f.dir).has(hash(originalBytes))).toBe(false)
    } finally {
      await f.close()
    }
  }
)
