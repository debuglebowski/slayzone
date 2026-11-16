import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { ChatEventLog } from '../../../domains/terminal/src/server/chat-events-store'
import { TimelineProjection } from '../../../domains/terminal/src/server/runtime/chat-timeline-projection'
import { buildLongSession } from '../../../shared/test-utils/chat-long-session'
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
  realArtifacts = false,
  collectReleasedAttachments?: () => Promise<unknown>
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
    collectReleasedAttachments: collectReleasedAttachments ?? pinnedReader?.collectGarbage
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
    async restart(afterClose?: () => void) {
      await computer.close()
      afterClose?.()
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

test('idle migration retains timeline-only history and records a recoverable fault after the mode changed', async () => {
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
    expect(owner).toMatchObject({ state: 'legacy', computerId: null, epoch: 1 })
    expect(f.h.db.prepare("SELECT rows FROM chat_timeline_pages WHERE tab_id='tab'").get()).toEqual(
      { rows: JSON.stringify([{ kind: 'assistant', text: 'retained timeline' }]) }
    )
    expect(
      f.h.db
        .prepare(
          "SELECT kind,message FROM item_faults WHERE pass='hub-legacy-chat-migration' AND item_key='task'"
        )
        .get()
    ).toMatchObject({
      kind: 'transient',
      message: expect.stringMatching(/LEGACY_CHAT_HISTORY_UNREPLAYABLE.*retained/i)
    })
    expect(await f.request('pc', { kind: 'inventory' })).toEqual([])
    expect(f.h.db.prepare("SELECT mode FROM terminal_tabs WHERE id='tab'").get()).toEqual({
      mode: 'codex'
    })
  } finally {
    await f.close()
  }
})

const guardedHistory = /LEGACY_CHAT_HISTORY_UNREPLAYABLE/
function seedGuardedHistory(f: Awaited<ReturnType<typeof fixture>>, checkpointOnly = false) {
  f.h.db.exec("DELETE FROM chat_events WHERE tab_id='tab'")
  const text = 'sole source history'
  if (checkpointOnly)
    f.h.db.prepare("INSERT INTO chat_timeline_checkpoints VALUES('tab','19.1',5,?,123)").run(
      JSON.stringify({
        tail: [{ kind: 'text', role: 'assistant', messageId: 'old', text, timestamp: 1 }]
      })
    )
  else
    f.h.db
      .prepare("INSERT INTO chat_timeline_pages VALUES('tab',0,0,1,?,'{}',?)")
      .run(
        JSON.stringify([{ kind: 'text', role: 'assistant', messageId: 'old', text, timestamp: 1 }]),
        text
      )
}
function sourceHistory(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    pages: f.h.db
      .prepare("SELECT * FROM chat_timeline_pages WHERE tab_id='tab' ORDER BY page")
      .all(),
    checkpoints: f.h.db.prepare("SELECT * FROM chat_timeline_checkpoints WHERE tab_id='tab'").all(),
    drafts: f.h.db.prepare("SELECT * FROM chat_tab_state WHERE tab_id='tab'").all(),
    attachments: f.h.db.prepare('SELECT * FROM artifact_versions ORDER BY id').all(),
    pins: f.h.db
      .prepare('SELECT * FROM artifact_blob_pins ORDER BY scope,owner_id,token,reference_key')
      .all()
  }
}

function cleanupCounters(db: Database.Database) {
  return db.prepare('SELECT name,n FROM audit_cleanup_effects ORDER BY name').all()
}
function observeCleanup(db: Database.Database) {
  db.exec(`CREATE TABLE audit_cleanup_effects(name TEXT PRIMARY KEY,n INTEGER NOT NULL);
    INSERT INTO audit_cleanup_effects VALUES('events',0),('pins',0),('diagnostics',0);
    CREATE TRIGGER audit_event_delete AFTER DELETE ON chat_events BEGIN
      UPDATE audit_cleanup_effects SET n=n+1 WHERE name='events'; END;
    CREATE TRIGGER audit_pin_delete AFTER DELETE ON artifact_blob_pins WHEN OLD.scope='legacy-chat-migration' BEGIN
      UPDATE audit_cleanup_effects SET n=n+1 WHERE name='pins'; END;
    CREATE TABLE audit_diagnostics(task_id TEXT PRIMARY KEY,message TEXT,at INTEGER);
    INSERT INTO audit_diagnostics VALUES('task','diagnostic source',1);
    CREATE TRIGGER audit_diagnostic_update AFTER UPDATE ON audit_diagnostics WHEN OLD.message<>NEW.message BEGIN
      UPDATE audit_cleanup_effects SET n=n+1 WHERE name='diagnostics'; END;`)
}
function cleanupDiagnostics(db: () => Database.Database, fail = false): LegacyChatDiagnostics {
  return {
    freeze: async () => 1,
    async *records() {
      yield { kind: 'settings', id: 'audit-diagnostic', value: 'diagnostic source', at: 1 }
    },
    tasks: async () =>
      (
        db().prepare("SELECT task_id FROM audit_diagnostics WHERE message<>''").all() as {
          task_id: string
        }[]
      ).map((r) => r.task_id),
    cleanup: async (taskId, cutoff) => {
      db()
        .prepare(
          "UPDATE audit_diagnostics SET message='' WHERE task_id=? AND at<=? AND message<>''"
        )
        .run(taskId, cutoff)
      if (fail) {
        fail = false
        throw new Error('diagnostics post-cleanup failure')
      }
    }
  }
}

test.each(['checkpoint-busy', 'diagnostics', 'gc', 'completion-update', 'interrupted'] as const)(
  'authorized source cleanup resumes through restart/normal relay after %s failure',
  async (fault) => {
    let raw: Database.Database | undefined
    const diagnostics = cleanupDiagnostics(() => raw!, fault === 'diagnostics')
    let failGc = fault === 'gc'
    const f = await fixture(false, true, diagnostics, false, async () => {
      raw!.prepare('DELETE FROM artifact_blob_gc_pending').run()
      if (failGc) {
        failGc = false
        throw new Error('GC post-cleanup failure')
      }
    })
    raw = f.h.db
    let restored: Database.Database | undefined
    const restores: Array<() => void> = []
    try {
      observeCleanup(raw)
      const expected = raw
        .prepare("SELECT event FROM chat_events WHERE tab_id='tab' ORDER BY seq")
        .all() as { event: string }[]
      if (fault === 'checkpoint-busy') {
        const get = f.h.slayDb.get.bind(f.h.slayDb)
        let fail = true
        const spy = vi.spyOn(f.h.slayDb, 'get').mockImplementation(async (sql, params) => {
          if (sql === 'PRAGMA wal_checkpoint(TRUNCATE)' && fail) {
            fail = false
            return { busy: 1 }
          }
          return get(sql, params)
        })
        restores.push(() => spy.mockRestore())
      }
      if (fault === 'completion-update')
        raw.exec(`CREATE TRIGGER fail_cleanup_completion BEFORE UPDATE ON chat_ownership
          WHEN OLD.cleanup_pending=1 AND NEW.cleanup_pending=0 BEGIN SELECT RAISE(ABORT,'native cleanup completion failure'); END`)
      const migration =
        fault === 'interrupted'
          ? createChatMigration({
              ownership: f.ownership,
              request: f.request,
              source: {
                ...f.source,
                cleanup: async (owner) => {
                  await f.source.cleanup(owner)
                  throw new Error('hub interrupted before cleanup completion')
                }
              }
            })
          : f.migration()
      await expect(migration.ensure('store', 'pc')).rejects.toThrow(
        fault === 'checkpoint-busy'
          ? /checkpoint.*busy/i
          : fault === 'diagnostics'
            ? 'diagnostics post-cleanup failure'
            : fault === 'gc'
              ? 'GC post-cleanup failure'
              : fault === 'completion-update'
                ? 'native cleanup completion failure'
                : 'hub interrupted before cleanup completion'
      )
      for (const restore of restores.splice(0)) restore()
      if (fault === 'completion-update') raw.exec('DROP TRIGGER fail_cleanup_completion')
      expect(await f.ownership.get('store')).toMatchObject({
        state: 'active',
        epoch: 2,
        cleanupPending: true
      })
      expect(raw.prepare("SELECT count(*) AS n FROM chat_events WHERE tab_id='tab'").get()).toEqual(
        { n: 0 }
      )
      const effects = cleanupCounters(raw)
      expect(effects).toContainEqual({ name: 'events', n: 1 })
      expect(effects).toContainEqual({ name: 'pins', n: 1 })
      const generation = raw
        .prepare("SELECT value FROM settings WHERE key='computer_chat_compaction_generation'")
        .get()
      const localBefore = openChatStorage({ stateDir: f.dir, hubScope: 'audit' })
      try {
        expect(localBefore.read('store', -1).map((e) => JSON.stringify(e.event))).toEqual(
          expected.map((e) => e.event)
        )
      } finally {
        localBefore.close()
      }
      // Persist/reopen the actual hub DB; no closure or in-memory retry state
      // can stand in for a committed cleanup marker.
      const snapshot = join(f.dir, 'restart-hub.sqlite')
      await raw.backup(snapshot)
      restored = new Database(snapshot)
      const db = createSlayzoneDbAdapter(restored)
      const restartedRaw = restored
      await f.restart()
      let collected = 0
      const pinnedReader = Object.assign(async () => originalBytes, {
        collectGarbage: async () => {
          collected++
          restartedRaw.prepare('DELETE FROM artifact_blob_gc_pending').run()
          return { deletedBlobs: 0, deferred: false }
        }
      })
      const services = createComputerChatServices({
        db,
        legacyData: { ...createDbChatDataOps(db, taskSessionStore), buildMcpEnv: async () => ({}) },
        attachments: { read: async () => originalBytes, readForMigration: pinnedReader },
        diagnostics: cleanupDiagnostics(() => restartedRaw),
        request: f.request,
        resolveComputer: async () => 'pc',
        defaultComputer: async () => 'pc',
        hasLiveTask: async () => false
      })
      // A real ordinary chat request must resume pending cleanup, not get stuck
      // behind a newly written unsafe-generation fault.
      await expect(services.relay.ops.getTabState('tab')).resolves.toMatchObject({
        draft: { text: 'preserved draft' }
      })
      const owner = await createChatOwnershipStore(db).get('store')
      expect(owner).toMatchObject({ state: 'active', epoch: 2, cleanupPending: false })
      expect(collected).toBe(1)
      expect(
        cleanupCounters(restored).filter((e) => (e as { name: string }).name !== 'diagnostics')
      ).toEqual(effects.filter((e) => (e as { name: string }).name !== 'diagnostics'))
      expect(
        restored.prepare("SELECT n FROM audit_cleanup_effects WHERE name='diagnostics'").get()
      ).toEqual({ n: 1 })
      expect(
        restored
          .prepare("SELECT value FROM settings WHERE key='computer_chat_compaction_generation'")
          .get()
      ).toEqual(generation)
      expect(
        restored
          .prepare(
            "SELECT block_reason FROM chat_legacy_migration_safety WHERE conversation_id='store'"
          )
          .get()
      ).toEqual({ block_reason: null })
      const localAfter = openChatStorage({ stateDir: f.dir, hubScope: 'audit' })
      try {
        expect(localAfter.read('store', -1).map((e) => JSON.stringify(e.event))).toEqual(
          expected.map((e) => e.event)
        )
      } finally {
        localAfter.close()
      }
      await expect(services.relay.ops.getTabState('tab')).resolves.toMatchObject({
        draft: { text: 'preserved draft' }
      })
    } finally {
      for (const restore of restores) restore()
      restored?.close()
      await f.close()
    }
  }
)

test('cleanup marker write failure rolls back source deletes, pin release and generation update', async () => {
  const f = await fixture()
  try {
    observeCleanup(f.h.db)
    await f.source.assertSafe!((await f.ownership.get('store'))!)
    f.h.db.exec(`CREATE TRIGGER fail_cleanup_marker BEFORE UPDATE OF cleanup_owner ON chat_legacy_migration_safety
      BEGIN SELECT RAISE(ABORT,'cleanup marker write failure'); END`)
    await expect(f.migration().ensure('store', 'pc')).rejects.toThrow(
      'cleanup marker write failure'
    )
    expect(await f.ownership.get('store')).toMatchObject({ state: 'active', cleanupPending: true })
    expect(
      f.h.db.prepare("SELECT count(*) AS n FROM chat_events WHERE tab_id='tab'").get()
    ).toEqual({ n: 1 })
    expect(
      f.h.db
        .prepare("SELECT count(*) AS n FROM artifact_blob_pins WHERE scope='legacy-chat-migration'")
        .get()
    ).toEqual({ n: 1 })
    expect(cleanupCounters(f.h.db)).toEqual([
      { name: 'diagnostics', n: 0 },
      { name: 'events', n: 0 },
      { name: 'pins', n: 0 }
    ])
    expect(
      f.h.db
        .prepare("SELECT value FROM settings WHERE key='computer_chat_compaction_generation'")
        .get()
    ).toBeUndefined()
    f.h.db.exec('DROP TRIGGER fail_cleanup_marker')
    await expect(f.migration().ensure('store', 'pc')).resolves.toMatchObject({
      cleanupPending: false
    })
    expect(cleanupCounters(f.h.db)).toContainEqual({ name: 'events', n: 1 })
  } finally {
    await f.close()
  }
})

test.each(['epoch', 'migration', 'proof', 'owner', 'task-deleted', 'source-reappearance'] as const)(
  'authorized cleanup marker cannot bypass %s validation',
  async (change) => {
    const f = await fixture()
    try {
      observeCleanup(f.h.db)
      f.h.db.exec(`CREATE TRIGGER pause_after_cleanup BEFORE UPDATE ON chat_ownership
        WHEN OLD.cleanup_pending=1 AND NEW.cleanup_pending=0 BEGIN SELECT RAISE(ABORT,'pause after cleanup'); END`)
      await expect(f.migration().ensure('store', 'pc')).rejects.toThrow('pause after cleanup')
      f.h.db.exec('DROP TRIGGER pause_after_cleanup')
      const owner = (await f.ownership.get('store'))!
      const marker = f.h.db
        .prepare(
          "SELECT cleanup_owner FROM chat_legacy_migration_safety WHERE conversation_id='store'"
        )
        .get() as { cleanup_owner: string }
      expect(marker.cleanup_owner).toEqual(expect.any(String))
      const before = cleanupCounters(f.h.db)
      const generation = f.h.db
        .prepare("SELECT value FROM settings WHERE key='computer_chat_compaction_generation'")
        .get()
      if (change === 'epoch')
        f.h.db.exec(
          "UPDATE chat_legacy_migration_safety SET source_epoch=source_epoch+1 WHERE conversation_id='store'"
        )
      else if (change === 'migration')
        f.h.db.exec(
          "UPDATE chat_legacy_migration_safety SET migration_id='wrong-generation' WHERE conversation_id='store'"
        )
      else if (change === 'proof')
        f.h.db
          .prepare(
            "UPDATE chat_legacy_migration_safety SET proof_hash=? WHERE conversation_id='store'"
          )
          .run('b'.repeat(64))
      else if (change === 'owner')
        f.h.db
          .prepare(
            "UPDATE chat_legacy_migration_safety SET cleanup_owner=? WHERE conversation_id='store'"
          )
          .run(JSON.stringify({ ...JSON.parse(marker.cleanup_owner), taskId: 'wrong-owner' }))
      else if (change === 'task-deleted')
        f.h.db.exec(
          "INSERT INTO chat_task_lifecycle(task_id,state,revision) VALUES('task','deleted',1) ON CONFLICT(task_id) DO UPDATE SET state='deleted'"
        )
      else restoreGuardedSource(f)
      await expect(f.migration().ensure('store', 'pc')).rejects.toThrow(
        change === 'task-deleted' ? /ownership|deleted/i : guardedHistory
      )
      await expect(f.source.cleanup(owner)).rejects.toThrow(
        change === 'task-deleted' ? /ownership|deleted/i : guardedHistory
      )
      expect(cleanupCounters(f.h.db)).toEqual(before)
      expect(
        f.h.db
          .prepare("SELECT value FROM settings WHERE key='computer_chat_compaction_generation'")
          .get()
      ).toEqual(generation)
      expect(await f.ownership.get('store')).toMatchObject({ cleanupPending: true })
      if (change === 'source-reappearance')
        expect(
          f.h.db.prepare("SELECT count(*) AS n FROM chat_events WHERE tab_id='tab'").get()
        ).toEqual({ n: 1 })
    } finally {
      await f.close()
    }
  }
)

test('S6 safety receipts upgrade without inferring cleanup or losing their captured source proof', async () => {
  const f = await fixture()
  try {
    f.failReply('transfer.finish')
    await expect(f.migration().ensure('store', 'pc')).rejects.toThrow(
      'Lost reply after transfer.finish'
    )
    const before = f.h.db
      .prepare(
        "SELECT proof_hash,source_seq FROM chat_legacy_migration_safety WHERE conversation_id='store'"
      )
      .get()
    // Persisted S6 layout: a receipt exists, but no authorized-delete marker.
    f.h.db.exec('ALTER TABLE chat_legacy_migration_safety DROP COLUMN cleanup_owner')
    expect(
      f.h.db.prepare("SELECT count(*) AS n FROM chat_events WHERE tab_id='tab'").get()
    ).toEqual({ n: 1 })
    await f.restart()
    await expect(f.migration().ensure('store', 'pc')).resolves.toMatchObject({
      cleanupPending: false
    })
    expect(
      f.h.db
        .prepare(
          "SELECT proof_hash,source_seq FROM chat_legacy_migration_safety WHERE conversation_id='store'"
        )
        .get()
    ).toEqual(before)
    expect(
      f.h.db
        .prepare(
          "SELECT cleanup_owner FROM chat_legacy_migration_safety WHERE conversation_id='store'"
        )
        .get()
    ).toEqual({ cleanup_owner: expect.any(String) })
  } finally {
    await f.close()
  }
})
test.each(['checkpoint-only', 'unknown-body', 'checkpoint-ahead'] as const)(
  '%s legacy history is deferred from headers without selecting or parsing bodies',
  async (kind) => {
    const f = await fixture()
    try {
      seedGuardedHistory(f, kind !== 'unknown-body')
      if (kind === 'checkpoint-ahead')
        f.h.db
          .prepare("INSERT INTO chat_events(tab_id,seq,event,saved_at) VALUES('tab',0,?,1)")
          .run(
            JSON.stringify({ kind: 'assistant-text', messageId: 'later', text: 'event remains' })
          )
      if (kind === 'unknown-body')
        f.h.db
          .prepare("UPDATE chat_timeline_pages SET rows=? WHERE tab_id='tab'")
          .run('unknown old format:' + 'x'.repeat(8 * 1024 * 1024))
      const before = sourceHistory(f)
      // Native selection tripwire: EXISTS/header probes need none of these
      // bodies. Old export paths selecting the view value hit the tripwire.
      f.h.db.function('audit_history_body', (_body: unknown) => {
        throw new Error('Timeline body selected on owner')
      })
      if (kind === 'unknown-body') {
        f.h.db.exec(`ALTER TABLE chat_timeline_pages RENAME TO audit_history_pages;
          CREATE VIEW chat_timeline_pages AS SELECT tab_id,page,start_row,end_row,audit_history_body(rows) AS rows,summary,search_text FROM audit_history_pages`)
      } else {
        f.h.db.exec(`ALTER TABLE chat_timeline_checkpoints RENAME TO audit_history_checkpoints;
          CREATE VIEW chat_timeline_checkpoints AS SELECT tab_id,version,seq,audit_history_body(data) AS data,updated_at FROM audit_history_checkpoints`)
      }
      try {
        await expect(f.migration().ensure('store', 'pc')).rejects.toThrow(guardedHistory)
      } finally {
        if (kind === 'unknown-body')
          f.h.db.exec(
            'DROP VIEW chat_timeline_pages; ALTER TABLE audit_history_pages RENAME TO chat_timeline_pages'
          )
        else
          f.h.db.exec(
            'DROP VIEW chat_timeline_checkpoints; ALTER TABLE audit_history_checkpoints RENAME TO chat_timeline_checkpoints'
          )
      }
      expect(sourceHistory(f)).toEqual(before)
      expect(await f.ownership.get('store')).toMatchObject({
        state: 'legacy',
        epoch: 1,
        computerId: null
      })
      expect(await f.request('pc', { kind: 'inventory' })).toEqual([])
    } finally {
      await f.close()
    }
  }
)

async function prepareOldGuardedTransfer(f: Awaited<ReturnType<typeof fixture>>, phase: string) {
  seedGuardedHistory(f)
  const owner = await f.ownership.beginMigration('store', {
    expectedComputerId: null,
    expectedEpoch: 1,
    migrationId: 'old-transfer',
    destinationComputerId: 'pc'
  })
  // Real old payload: pages were counted on the wire and discarded by the
  // destination. Bypass today's source exporter only to stage this historical state.
  const payload = encodeTransfer({
    version: 1,
    migrationId: 'old-transfer',
    identity: {
      id: owner.id,
      taskId: owner.taskId,
      tabId: owner.tabId,
      mode: owner.mode,
      epoch: owner.epoch
    },
    events: [],
    records: [{ kind: 'timeline', id: 'page:0', value: { rows: 'sole source history' }, at: 1 }],
    receipts: [],
    hash: ''
  })
  const start = await f.request('pc', { kind: 'transfer.begin', manifest: payload.manifest })
  await f.request('pc', {
    kind: 'transfer.chunk',
    id: start.id,
    offset: 0,
    data: payload.bytes.toString('base64')
  })
  await f.request('pc', { kind: 'transfer.finish', id: start.id })
  if (phase !== 'prepared')
    await f.ownership.markVerified('store', 'old-transfer', payload.manifest.hash)
  if (phase === 'cleanup-pending' || phase === 'lost-activation-ack')
    await f.ownership.commitMigration('store', 'old-transfer', payload.manifest.hash)
  if (phase === 'lost-activation-ack') {
    f.failReply('migration.activate')
    await expect(
      f.request('pc', {
        kind: 'migration.activate',
        id: 'store',
        epoch: 2,
        migrationId: 'old-transfer',
        hash: payload.manifest.hash
      })
    ).rejects.toThrow('Lost reply')
  }
  return { owner: (await f.ownership.get('store'))!, manifest: payload.manifest }
}

/** Scratch operator recovery: restore backed-up events without changing the gate. */
function restoreGuardedSource(f: Awaited<ReturnType<typeof fixture>>) {
  const triggers = f.h.db
    .prepare(
      "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='chat_events' ORDER BY name"
    )
    .all() as Array<{ name: string; sql: string }>
  f.h.db.transaction(() => {
    for (const trigger of triggers)
      f.h.db.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`)
    f.h.db
      .prepare("INSERT INTO chat_events(tab_id,seq,event,saved_at) VALUES('tab',0,?,1)")
      .run(
        JSON.stringify({ kind: 'assistant-text', messageId: 'old', text: 'sole source history' })
      )
    for (const trigger of triggers) f.h.db.exec(trigger.sql)
  })()
  expect(
    f.h.db
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='chat_events' ORDER BY name"
      )
      .all()
  ).toEqual(triggers)
}

test.each(['prepared', 'lost-activation-ack'] as const)(
  'a failed safety-record write cannot authorize a repaired old %s proof',
  async (phase) => {
    const f = await fixture()
    try {
      await f.source.assertSafe!((await f.ownership.get('store'))!)
      const old = await prepareOldGuardedTransfer(f, phase)
      f.h.db.exec(
        "CREATE TRIGGER fail_safety_record BEFORE INSERT ON chat_legacy_migration_safety BEGIN SELECT RAISE(ABORT,'safety record write failed'); END"
      )
      await expect(f.migration().ensure('store', 'pc')).rejects.toThrow(
        'safety record write failed'
      )
      f.h.db.exec('DROP TRIGGER fail_safety_record')
      restoreGuardedSource(f)
      const before = sourceHistory(f)
      await f.restart()
      await expect(f.migration().ensure('store', 'pc')).rejects.toThrow(
        /LEGACY_CHAT_HISTORY_UNREPLAYABLE.*proof/i
      )
      expect(sourceHistory(f)).toEqual(before)
      expect(await f.ownership.get('store')).toEqual(old.owner)
      expect(
        f.h.db.prepare("SELECT count(*) AS n FROM chat_events WHERE tab_id='tab'").get()
      ).toEqual({ n: 1 })
    } finally {
      await f.close()
    }
  }
)

test('canonical unavailable-owner reseed re-exports repaired history after a failed recovery copy', async () => {
  const f = await fixture()
  try {
    const old = await prepareOldGuardedTransfer(f, 'lost-activation-ack')
    await expect(f.migration().ensure('store', 'pc')).rejects.toThrow(guardedHistory)
    restoreGuardedSource(f)
    const before = sourceHistory(f)
    // Actual loss of this scratch computer store. Production recovery then
    // marks the missing owner unavailable and invokes its existing reseed gate.
    await f.restart(() => rmSync(join(f.dir, 'computer-runtime'), { recursive: true, force: true }))
    await f.ownership.markUnavailable('store', 'pc', old.owner.epoch)
    f.failReply('transfer.chunk')
    await expect(f.migration().ensure('store', 'pc')).rejects.toThrow(
      'Lost reply after transfer.chunk'
    )
    const pending = (await f.ownership.get('store'))!
    expect(pending).toMatchObject({ state: 'copying', computerId: null, epoch: 3 })
    expect(pending.migrationId).not.toBe(old.owner.migrationId)
    expect(sourceHistory(f).pages).toEqual(before.pages)
    expect(sourceHistory(f).drafts).toEqual(before.drafts)
    expect(
      f.h.db.prepare("SELECT count(*) AS n FROM chat_events WHERE tab_id='tab'").get()
    ).toEqual({ n: 1 })
    await f.restart()
    const complete = await f.migration().ensure('store', 'pc')
    expect(complete).toMatchObject({ state: 'active', epoch: 4, cleanupPending: false })
    const local = openChatStorage({ stateDir: f.dir, hubScope: 'audit' })
    try {
      expect(local.read('store', -1)).toMatchObject([{ event: { text: 'sole source history' } }])
    } finally {
      local.close()
    }
    expect(
      f.h.db.prepare("SELECT count(*) AS n FROM chat_events WHERE tab_id='tab'").get()
    ).toEqual({ n: 0 })
  } finally {
    await f.close()
  }
})

test.each(['prepared', 'verified', 'cleanup-pending', 'lost-activation-ack'] as const)(
  'source repair never authorizes the old empty %s destination proof',
  async (phase) => {
    const f = await fixture()
    try {
      const old = await prepareOldGuardedTransfer(f, phase)
      await expect(f.migration().ensure('store', 'pc')).rejects.toThrow(guardedHistory)
      const before = sourceHistory(f)
      restoreGuardedSource(f)
      expect(await f.ownership.get('store')).toEqual(old.owner)
      await f.restart()
      for (let retry = 0; retry < 2; retry++) {
        await expect(f.migration().ensure('store', 'pc')).rejects.toThrow(
          /LEGACY_CHAT_HISTORY_UNREPLAYABLE.*(?:proof|generation)/i
        )
        expect(await f.ownership.get('store')).toEqual(old.owner)
        expect(sourceHistory(f)).toEqual(before)
        expect(f.h.db.prepare("SELECT event FROM chat_events WHERE tab_id='tab'").all()).toEqual([
          {
            event: JSON.stringify({
              kind: 'assistant-text',
              messageId: 'old',
              text: 'sole source history'
            })
          }
        ])
        if (phase === 'cleanup-pending' || phase === 'lost-activation-ack')
          await expect(f.source.cleanup(old.owner)).rejects.toThrow(
            /LEGACY_CHAT_HISTORY_UNREPLAYABLE/
          )
      }
      const local = openChatStorage({ stateDir: f.dir, hubScope: 'audit' })
      try {
        expect(local.read('store', -1)).toEqual([])
      } finally {
        local.close()
      }
    } finally {
      await f.close()
    }
  }
)
test.each([
  'prepared',
  'verified',
  'cleanup-pending',
  'lost-activation-ack',
  'old-destination'
] as const)(
  'an old %s migration cannot bypass the source history guard on resume/restart',
  async (phase) => {
    const f = await fixture()
    try {
      const old = await prepareOldGuardedTransfer(
        f,
        phase === 'old-destination' ? 'prepared' : phase
      )
      const before = sourceHistory(f)
      await f.restart()
      const migration =
        phase === 'old-destination'
          ? createChatMigration({
              ownership: f.ownership,
              source: f.source,
              request: async () => {
                throw new Error('Old destination: unknown migration request')
              }
            })
          : f.migration()
      for (let retry = 0; retry < 2; retry++)
        await expect(migration.ensure('store', 'pc')).rejects.toThrow(guardedHistory)
      expect(sourceHistory(f)).toEqual(before)
      expect(await f.ownership.get('store')).toEqual(old.owner)
      if (phase === 'prepared' || phase === 'verified')
        expect(await f.request('pc', { kind: 'migration.prepared', id: 'store' })).toMatchObject({
          hash: old.manifest.hash
        })
    } finally {
      await f.close()
    }
  }
)

test.each(['prepared', 'verified', 'cleanup-pending', 'lost-activation-ack'] as const)(
  'an unobserved old empty %s proof cannot authorize already-repaired source events',
  async (phase) => {
    const f = await fixture()
    try {
      const old = await prepareOldGuardedTransfer(f, phase)
      restoreGuardedSource(f)
      const before = sourceHistory(f)
      await f.restart()
      await expect(f.migration().ensure('store', 'pc')).rejects.toThrow(
        /LEGACY_CHAT_HISTORY_UNREPLAYABLE.*proof/i
      )
      expect(sourceHistory(f)).toEqual(before)
      expect(await f.ownership.get('store')).toEqual(old.owner)
      expect(
        f.h.db.prepare("SELECT count(*) AS n FROM chat_events WHERE tab_id='tab'").get()
      ).toEqual({ n: 1 })
    } finally {
      await f.close()
    }
  }
)

test('canonical history left by async event write errors is retained; restored events make retry readable', async () => {
  const f = await fixture(false, false)
  try {
    f.h.db.exec(
      "DELETE FROM chat_events; UPDATE terminal_tabs SET mode='codex' WHERE id='tab'; CREATE TRIGGER fail_legacy_event BEFORE INSERT ON chat_events BEGIN SELECT RAISE(ABORT,'injected write error'); END"
    )
    const data = createDbChatDataOps(f.h.slayDb, taskSessionStore)
    let failed = 0
    const log = new ChatEventLog(
      'tab',
      {
        insert: (tab, seq, event, at) => data.persistChatEvent(tab, seq, event, at),
        readPage: (tab, after, before, budget) =>
          data.loadChatEventsPage(tab, after, before, budget),
        tailStart: (tab, count) => data.chatEventsTailStart(tab, count)
      },
      { events: [], nextSeq: 0 },
      { onWriteError: () => failed++ }
    )
    // Model residue ALREADY STORED by the historical publish-before-insert bug.
    // Today's log must reject this failure, never manufacture that residue again.
    const history = buildLongSession({ events: 4000, seed: 21, askEveryTool: true }).map(
      (e, seq) => ({
        seq,
        at: Date.now(),
        event: e.kind === 'assistant-text' ? { ...e, text: 'SOURCE-ONLY-HISTORY:' + e.text } : e
      })
    )
    await expect(log.append(history[0].event)).rejects.toThrow('injected write error')
    await expect(log.flush()).rejects.toThrow('injected write error')
    await expect(log.append(history[1].event)).rejects.toThrow('injected write error')
    expect(failed).toBe(1)
    expect(log.events).toEqual([])
    expect(log.lastSeq).toBe(-1)
    f.h.db.exec('DROP TRIGGER fail_legacy_event')
    const projection = await TimelineProjection.open({
      store: {
        loadCheckpoint: () => data.loadTimelineCheckpoint('tab'),
        loadPages: (pages) => data.loadTimelinePages('tab', pages),
        loadSummaries: () => data.loadTimelineSummaries('tab'),
        save: (write) => data.saveTimeline('tab', write),
        searchPages: (needle) => data.searchTimelinePages('tab', needle),
        discard: () => data.clearTimeline('tab')
      },
      history,
      agentStartedTurns: true
    })
    expect(JSON.stringify(await projection.openSnapshot())).toContain('SOURCE-ONLY-HISTORY:')
    await projection.close()
    const before = sourceHistory(f)
    const services = createComputerChatServices({
      db: f.h.slayDb,
      legacyData: { ...data, buildMcpEnv: async () => ({}) },
      attachments: { read: async () => originalBytes },
      request: f.request,
      resolveComputer: async () => 'pc',
      defaultComputer: async () => 'pc',
      hasLiveTask: async () => false
    })
    await services.migrateIdleComputer('pc')
    expect(sourceHistory(f)).toEqual(before)
    expect(await services.ownership.forTab('tab')).toMatchObject({
      state: 'legacy',
      computerId: null
    })
    expect(
      f.h.db
        .prepare(
          "SELECT kind,message FROM item_faults WHERE pass='hub-legacy-chat-migration' AND item_key='task'"
        )
        .get()
    ).toMatchObject({ kind: 'transient', message: expect.stringMatching(guardedHistory) })
    // Simulate repairing the missing source events from a verified backup.
    for (const e of history) await data.persistChatEvent('tab', e.seq, e.event, e.at)
    await services.migrateIdleComputer('pc')
    const owner = (await services.ownership.forTab('tab'))!
    expect(owner).toMatchObject({ state: 'active', cleanupPending: false })
    expect(
      f.h.db
        .prepare(
          "SELECT 1 FROM item_faults WHERE pass='hub-legacy-chat-migration' AND item_key='task'"
        )
        .get()
    ).toBeUndefined()
    await f.restart()
    const local = openChatStorage({ stateDir: f.dir, hubScope: 'audit' })
    try {
      expect(local.read(owner.id, -1)).toHaveLength(history.length)
      expect(JSON.stringify(local.read(owner.id, -1))).toContain('SOURCE-ONLY-HISTORY:')
    } finally {
      local.close()
    }
    expect(
      f.h.db.prepare("SELECT count(*) AS n FROM chat_timeline_pages WHERE tab_id='tab'").get()
    ).toEqual({ n: 0 })
  } finally {
    await f.close()
  }
})

test('ownership changing during transfer is refused before commit and activation', async () => {
  const f = await fixture()
  try {
    f.h.db
      .prepare("INSERT INTO chat_timeline_pages VALUES('tab',0,0,1,?,'{}','')")
      .run(JSON.stringify([{ text: 'recoverable copy' }]))
    const before = sourceHistory(f)
    const requests: string[] = []
    const migration = createChatMigration({
      ownership: f.ownership,
      source: f.source,
      request: async (pc, raw) => {
        const kind = (raw as { kind: string }).kind
        requests.push(kind)
        const result = await f.request(pc, raw)
        if (kind === 'transfer.finish')
          f.h.db.exec("UPDATE chat_ownership SET epoch=epoch+1 WHERE id='store'")
        return result
      }
    })
    await expect(migration.ensure('store', 'pc')).rejects.toThrow(/ownership/i)
    expect(await f.ownership.get('store')).toMatchObject({
      state: 'copying',
      computerId: null,
      epoch: 2
    })
    expect(requests).not.toContain('migration.activate')
    expect(sourceHistory(f).pages).toEqual(before.pages)
    expect(sourceHistory(f).drafts).toEqual(before.drafts)
    expect(await f.request('pc', { kind: 'migration.prepared', id: 'store' })).toMatchObject({
      epoch: 2
    })
  } finally {
    await f.close()
  }
})

test('cleanup rechecks source history after activation; an old cleanup caller cannot delete it', async () => {
  const f = await fixture()
  try {
    f.h.db
      .prepare("INSERT INTO chat_timeline_pages VALUES('tab',0,0,1,?,'{}','')")
      .run(JSON.stringify([{ text: 'recoverable copy' }]))
    const migration = createChatMigration({
      ownership: f.ownership,
      source: f.source,
      request: async (pc, raw) => {
        const result = await f.request(pc, raw)
        if ((raw as { kind: string }).kind === 'migration.activate')
          f.h.db.exec("DELETE FROM chat_events WHERE tab_id='tab'")
        return result
      }
    })
    await expect(migration.ensure('store', 'pc')).rejects.toThrow(guardedHistory)
    const owner = (await f.ownership.get('store'))!
    expect(owner).toMatchObject({ state: 'active', cleanupPending: true, epoch: 2 })
    const before = sourceHistory(f)
    await expect(f.source.cleanup(owner)).rejects.toThrow(guardedHistory)
    expect(sourceHistory(f)).toEqual(before)
    expect(before.pages).toHaveLength(1)
  } finally {
    await f.close()
  }
})

test.each(['epoch', 'history', 'proof'] as const)(
  'cleanup atomically rechecks %s at its final transaction boundary',
  async (change) => {
    const f = await fixture()
    const restores: Array<() => void> = []
    try {
      f.h.db
        .prepare("INSERT INTO chat_timeline_pages VALUES('tab',0,0,1,?,'{}','')")
        .run(JSON.stringify([{ text: 'recoverable copy' }]))
      const copying = await f.ownership.beginMigration('store', {
        expectedComputerId: null,
        expectedEpoch: 1,
        migrationId: 'cleanup-race',
        destinationComputerId: 'pc'
      })
      const exported = await f.source.open(copying, 'cleanup-race')
      await f.ownership.markVerified('store', 'cleanup-race', exported.manifest.hash)
      const owner = await f.ownership.commitMigration(
        'store',
        'cleanup-race',
        exported.manifest.hash
      )
      const before = sourceHistory(f)
      expect(before.pins.length).toBeGreaterThan(0)
      let injected = false
      const mutate = () => {
        if (injected) return
        injected = true
        f.h.db.exec(
          change === 'epoch'
            ? "UPDATE chat_ownership SET epoch=epoch+1 WHERE id='store'"
            : change === 'proof'
              ? "UPDATE chat_legacy_migration_safety SET proof_hash='bad-old-proof' WHERE conversation_id='store'"
              : "DELETE FROM chat_events WHERE tab_id='tab'"
        )
      }
      const batch = f.h.slayDb.batchTxn.bind(f.h.slayDb)
      const batchSpy = vi.spyOn(f.h.slayDb, 'batchTxn').mockImplementation((ops) => {
        if (ops.some((op) => /DELETE FROM chat_events/.test(op.sql))) mutate()
        return batch(ops)
      })
      restores.push(() => batchSpy.mockRestore())
      const named = f.h.slayDb.namedTxn.bind(f.h.slayDb)
      const namedSpy = vi.spyOn(f.h.slayDb, 'namedTxn').mockImplementation((name, params) => {
        if (String(name) === 'chat-migration:cleanup-source') mutate()
        return named(name, params)
      })
      restores.push(() => namedSpy.mockRestore())
      await expect(f.source.cleanup(owner)).rejects.toThrow(
        change === 'epoch' ? /ownership/i : guardedHistory
      )
      expect(injected).toBe(true)
      expect(sourceHistory(f)).toEqual(before)
      expect(await f.ownership.get('store')).toMatchObject({ cleanupPending: true })
    } finally {
      for (const restore of restores) restore()
      await f.close()
    }
  }
)

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
