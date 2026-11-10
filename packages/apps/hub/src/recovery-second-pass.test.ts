import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from 'vitest'
import Database from 'better-sqlite3'
import { createSlayzoneDbAdapter, createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { createDbChatDataOps } from '@slayzone/terminal/server'
import { taskSessionStore } from './test-session-store'
import { createFixtureChatRuntime } from '../../computer/src/project-scope.fixture'
import { createComputerChatServices } from './computer-chat'
import { createComputerChatCommandBarrier } from './computer-chat-maintenance'
import { openChatStorage } from '../../../domains/chat-runtime/src/server/storage'
import {
  createChatTransfers,
  encodeTransfer,
  TRANSFER_CHUNK_BYTES
} from '../../../domains/chat-runtime/src/server/transfers'
import type { ChatMigrationSnapshot } from '../../../domains/chat-runtime/src/shared'

// These tests call the real endpoint and storage. No provider is started.
// Faults before a request and SIGKILL inside an uncommitted transaction are
// deliberately separate from "handler finished but its reply was lost".
async function fixture() {
  const h = await createTestHarness()
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'chat-recovery-second-pass-'))
  const previousHome = process.env.HOME
  const previousUserProfile = process.env.USERPROFILE
  process.env.HOME = root
  process.env.USERPROFILE = root
  h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','Project','#000')").run()
  h.db
    .prepare('INSERT INTO tasks(id,project_id,title,has_worktree) VALUES(?,?,?,1)')
    .run('task', 'p', 'Task')
  const openComputer = () =>
    createFixtureChatRuntime({
      taskFolder: () => root,
      stateDir: root,
      hubScope: 'second-pass',
      computerId: () => 'pc',
      getProjectPaths: () => null,
      ctx: {
        config: {
          hubUrl: 'ws://second-pass.invalid/computers',
          name: 'test',
          allowedRoots: [root],
          capabilities: ['proc']
        },
        dialer: { notify: () => true },
        log: () => {}
      }
    })
  let computer = openComputer()
  let failBefore = ''
  let hold: { kind: string; started: () => void; wait: Promise<void> } | undefined
  const calls: string[] = []
  const request = async (_pc: string, raw: unknown) => {
    const input = JSON.parse(JSON.stringify(raw)) as { kind: string }
    calls.push(input.kind)
    if (input.kind === failBefore) {
      failBefore = ''
      throw new Error(`Disconnected before ${input.kind}`)
    }
    const result = await computer.request(input)
    if (hold?.kind === input.kind) {
      const current = hold
      hold = undefined
      current.started()
      await current.wait
    }
    return result
  }
  const services = (db = h.slayDb) =>
    createComputerChatServices({
      db,
      legacyData: { ...createDbChatDataOps(db, taskSessionStore), buildMcpEnv: async () => ({}) },
      attachments: { read: async () => new Uint8Array() },
      request,
      resolveComputer: async () => 'pc',
      defaultComputer: async () => 'pc',
      hasLiveTask: async () => false
    })
  return {
    h,
    root,
    services,
    calls,
    request: (raw: unknown) => request('pc', raw),
    assertTaskActive: (taskId: string) => computer.assertTaskActive(taskId),
    failBefore: (kind: string) => {
      failBefore = kind
    },
    holdReply(kind: string) {
      let started!: () => void
      let release!: () => void
      const ready = new Promise<void>((resolve) => {
        started = resolve
      })
      const wait = new Promise<void>((resolve) => {
        release = resolve
      })
      hold = { kind, started, wait }
      return { ready, release }
    },
    restart: async () => {
      await computer.close()
      computer = openComputer()
    },
    close: async () => {
      await computer.close()
      h.cleanup()
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousUserProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = previousUserProfile
      rmSync(root, { recursive: true, force: true })
    }
  }
}

test('new: interrupted first prompt-only bootstrap must not strand an active locator and block reconnect', async () => {
  const f = await fixture()
  try {
    f.h.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('native','task','codex',0)"
      )
      .run()
    const before = f.services()
    f.failBefore('bootstrap')
    await expect(before.prompts('task', 'codex')).rejects.toThrow('Disconnected before bootstrap')
    const stranded = await before.ownership.forTab('prompt-history:task')
    expect(stranded).toMatchObject({
      state: 'legacy',
      epoch: 1,
      computerId: null,
      destinationComputerId: 'pc'
    })
    expect(await before.ownership.bootstrapReservation(stranded!.id)).toEqual({
      computerId: 'pc',
      epoch: 1
    })
    expect(await f.request({ kind: 'inspect', id: stranded!.id })).toBeNull()
    await f.restart()
    const after = f.services()
    const barrier = createComputerChatCommandBarrier({ lifecycle: after.lifecycle.syncNative })
    // Reservation remains uncommitted until the computer durably acknowledges bootstrap.
    // This is a fresh prompt recall, not a damaged DB or a forged inventory.
    await expect(barrier('pc', 'pty.kill')).resolves.toBeUndefined()
    await expect(after.prompts('task', 'codex')).resolves.toEqual([])
  } finally {
    await f.close()
  }
})

test('control: interrupted first ordinary chat bootstrap leaves a reservation and reconnect retries safely', async () => {
  const f = await fixture()
  try {
    f.h.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
      )
      .run()
    const before = f.services()
    f.failBefore('bootstrap')
    await expect(before.relay.ops.getTabState('tab')).rejects.toThrow(
      'Disconnected before bootstrap'
    )
    expect(await before.ownership.forTab('tab')).toMatchObject({
      state: 'legacy',
      computerId: null,
      destinationComputerId: 'pc'
    })
    await f.restart()
    const after = f.services()
    await expect(after.relay.ops.getTabState('tab')).resolves.toBeNull()
    expect(await after.ownership.forTab('tab')).toMatchObject({ state: 'active', computerId: 'pc' })
  } finally {
    await f.close()
  }
})

test('new: deleting a tab while its first computer bootstrap reply is pending must prevent reconnect resurrection', async () => {
  const f = await fixture()
  try {
    f.h.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
      )
      .run()
    const before = f.services()
    const held = f.holdReply('bootstrap')
    const opening = before.relay.ops.getTabState('tab')
    await held.ready
    // Computer committed, but hub only has the durable initialization reservation.
    expect(await before.ownership.forTab('tab')).toMatchObject({
      state: 'legacy',
      computerId: null,
      destinationComputerId: 'pc'
    })
    f.h.db.prepare("DELETE FROM terminal_tabs WHERE id='tab'").run()
    expect(f.h.db.prepare("SELECT 1 FROM terminal_tabs WHERE id='tab'").get()).toBeUndefined()
    held.release()
    await opening.catch(() => {})
    await f.restart()
    await f.services().recoverComputer('pc')
    // Tab close is a permanent per-conversation delete, not task Trash.
    expect(f.h.db.prepare("SELECT 1 FROM terminal_tabs WHERE id='tab'").get()).toBeUndefined()
  } finally {
    await f.close()
  }
})

test('new: permanently deleting a prepared chat tab must erase its raw staged transfer bytes across restart', async () => {
  const f = await fixture()
  try {
    const secret = 'second-pass-private-history-for-deleted-tab'
    f.h.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
      )
      .run()
    f.h.db
      .prepare("INSERT INTO chat_events(tab_id,seq,event,saved_at) VALUES('tab',0,?,123)")
      .run(JSON.stringify({ kind: 'assistant-text', messageId: 'm', text: secret }))
    const hub = f.services()
    f.failBefore('migration.activate')
    await expect(hub.relay.ops.getTabState('tab')).rejects.toThrow(
      'Disconnected before migration.activate'
    )
    const owner = (await hub.ownership.forTab('tab'))!
    expect(await f.request({ kind: 'inspect', id: owner.id })).toMatchObject({ state: 'prepared' })
    const scopeDir = join(
      f.root,
      'computer-runtime',
      createHash('sha256').update(JSON.stringify('second-pass')).digest('hex')
    )
    const transferDir = join(scopeDir, 'transfers')
    const rawFiles = readdirSync(transferDir).filter((name) => name.endsWith('.data'))
    expect(rawFiles).toHaveLength(1)
    expect(readFileSync(join(transferDir, rawFiles[0]), 'utf8')).toContain(secret)
    // Actual tab deletion trigger, then actual hub deletion delivery and ACK.
    f.h.db.prepare("DELETE FROM terminal_tabs WHERE id='tab'").run()
    await hub.lifecycle.sync('pc')
    expect(await hub.ownership.get(owner.id)).toMatchObject({
      state: 'deleted',
      cleanupPending: false
    })
    expect(await f.request({ kind: 'inspect', id: owner.id })).toMatchObject({ state: 'deleted' })
    expect(
      f.h.db.prepare("SELECT count(*) AS n FROM chat_events WHERE tab_id='tab'").get()
    ).toEqual({ n: 0 })
    await f.restart()
    await f.request({ kind: 'inventory' })
    const surviving = rawFiles.filter((name) => existsSync(join(transferDir, name)))
    expect(surviving).toEqual([])
  } finally {
    await f.close()
  }
})

test.each(['unregistered', 'legacy', 'copying'] as const)(
  'restore matrix: real %s hub snapshot plus surviving prepared computer must remain usable',
  async (hubState) => {
    const f = await fixture()
    let restored: Database.Database | undefined
    try {
      f.h.db
        .prepare(
          "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
        )
        .run()
      f.h.db
        .prepare(
          "INSERT INTO chat_tab_state(tab_id,draft_text,rev,updated_at) VALUES('tab','restored draft',1,123)"
        )
        .run()
      const before = f.services()
      if (hubState === 'legacy') await before.ownership.register({ ...identity, computerId: null })
      const backupPath = join(f.root, 'old-hub.sqlite')
      if (hubState !== 'copying') await f.h.db.backup(backupPath)
      f.failBefore('migration.verify')
      await expect(before.relay.ops.getTabState('tab')).rejects.toThrow(
        'Disconnected before migration.verify'
      )
      const originalOwner = (await before.ownership.forTab('tab'))!
      expect(await f.request({ kind: 'inspect', id: originalOwner.id })).toMatchObject({
        state: 'prepared'
      })
      if (hubState === 'copying') await f.h.db.backup(backupPath)
      await f.restart()
      // This opens an actual prior SQLite snapshot. No locator fields are
      // hand-edited into an impossible ownership combination.
      restored = new Database(backupPath)
      restored.pragma('foreign_keys = ON')
      const after = f.services(createSlayzoneDbAdapter(restored))
      await after.recoverComputer('pc')
      await expect(after.relay.ops.getTabState('tab')).resolves.toMatchObject({
        draft: { text: 'restored draft' }
      })
      const inventory = (await f.request({ kind: 'inventory' })) as Array<{
        identity: { id: string; tabId: string }
        state: string
      }>
      const tabStores = inventory.filter(
        (entry) => entry.identity.tabId === 'tab' && entry.state !== 'deleted'
      )
      if (hubState === 'unregistered') {
        expect(tabStores.map((entry) => entry.state)).toEqual(['active'])
        expect((await after.ownership.forTab('tab'))!.id).toBe(originalOwner.id)
      }
      // Restoring before locator creation adopts the original prepared identity;
      // no orphan remains to block native admission.
      expect(() => f.assertTaskActive('task')).not.toThrow()
      expect(tabStores).toHaveLength(1)
    } finally {
      restored?.close()
      await f.close()
    }
  }
)

test('control: concurrent reconnect invalidation preserves an existing tab tombstone against a captured active inventory', async () => {
  const f = await fixture()
  try {
    f.h.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
      )
      .run()
    const before = f.services()
    await before.relay.ops.getTabState('tab')
    const owner = (await before.ownership.forTab('tab'))!
    await f.restart()
    const after = f.services()
    const held = f.holdReply('inventory')
    const first = after.recoverComputer('pc')
    await held.ready
    after.invalidateRecovery('pc')
    const overlapping = after.recoverComputer('pc')
    f.h.db.prepare("DELETE FROM terminal_tabs WHERE id='tab'").run()
    held.release()
    await Promise.all([first, overlapping])
    expect(await after.ownership.get(owner.id)).toMatchObject({
      state: 'deleted',
      cleanupPending: false
    })
    expect(await f.request({ kind: 'inspect', id: owner.id })).toMatchObject({ state: 'deleted' })
    expect(f.h.db.prepare("SELECT 1 FROM terminal_tabs WHERE id='tab'").get()).toBeUndefined()
  } finally {
    await f.close()
  }
})

const identity = { id: 'store', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 }
const snapshot: ChatMigrationSnapshot = {
  version: 1,
  migrationId: 'crash-move',
  identity,
  events: [
    {
      seq: 0,
      at: 123,
      event: { kind: 'assistant-text', messageId: 'm1', text: 'x'.repeat(300_000) }
    },
    {
      seq: 1,
      at: 124,
      event: { kind: 'assistant-text', messageId: 'm2', text: 'surviving history' }
    }
  ],
  records: [
    {
      kind: 'draft',
      id: 'state',
      value: { draft: { text: 'crash draft', attachments: [], rev: 1 }, scroll: null },
      at: 125
    }
  ],
  receipts: [],
  hash: 'unused-by-transfer'
}
const crashPoints = [
  'checkpoint-commit',
  'chunk-data-fsync',
  'chunk-progress-rename',
  'stage-event-before-commit',
  'prepared-commit',
  'activation-commit'
] as const

test('control: restarted tombstones fence late transfer/checkpoint/activation requests and remain scoped to one hub', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'chat-recovery-scope-'))
  let first: ReturnType<typeof openChatStorage> | undefined
  let other: ReturnType<typeof openChatStorage> | undefined
  try {
    first = openChatStorage({ stateDir: root, hubScope: 'scope-a' })
    let transfers = createChatTransfers(first)
    const payload = encodeTransfer(snapshot)
    const start = transfers.begin(payload.manifest)
    for (let offset = 0; offset < payload.bytes.length; offset += TRANSFER_CHUNK_BYTES)
      transfers.chunk(
        start.id,
        offset,
        payload.bytes.subarray(offset, offset + TRANSFER_CHUNK_BYTES)
      )
    transfers.finish(start.id)
    first.applyTombstone({ ...identity, epoch: 3 })
    first.close()
    first = openChatStorage({ stateDir: root, hubScope: 'scope-a' })
    transfers = createChatTransfers(first)
    expect(() => transfers.finish(start.id)).toThrow(/overwrite|ownership|deleted/i)
    expect(() => first!.migrationCheckpoint(identity, snapshot.migrationId, [])).toThrow(/deleted/i)
    expect(() =>
      first!.activate(identity.id, snapshot.migrationId, 2, payload.manifest.hash)
    ).toThrow()
    expect(() => first!.createConversation(identity)).toThrow(/deleted/i)
    first.applyTombstone(identity)
    expect(first.conversation(identity.id)).toMatchObject({
      state: 'deleted',
      identity: { epoch: 3 }
    })
    other = openChatStorage({ stateDir: root, hubScope: 'scope-b' })
    expect(other.conversation(identity.id)).toBeNull()
    expect(other.migrationCheckpoint(identity, snapshot.migrationId)).toBeNull()
    expect(() => createChatTransfers(other!).progress(start.id)).toThrow(/ENOENT/)
    other.createConversation(identity)
    expect(other.conversation(identity.id)).toMatchObject({
      state: 'active',
      identity: { epoch: 1 }
    })
    expect(first.conversation(identity.id)).toMatchObject({
      state: 'deleted',
      identity: { epoch: 3 }
    })
  } finally {
    first?.close()
    other?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test.each(crashPoints)(
  'control: true SIGKILL at %s resumes durable checkpoint, transfer, history, and ownership',
  (point) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'chat-recovery-sigkill-'))
    const payload = encodeTransfer(snapshot)
    const workerPath = join(root, 'crash-worker.mjs')
    const storageUrl = pathToFileURL(
      join(import.meta.dirname, '../../../domains/chat-runtime/src/server/storage.ts')
    ).href
    const transfersUrl = pathToFileURL(
      join(import.meta.dirname, '../../../domains/chat-runtime/src/server/transfers.ts')
    ).href
    // fs hooks kill after the real I/O has completed; the SQLite hook kills
    // inside the actual staging transaction, after an INSERT but before COMMIT.
    const worker = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const point = ${JSON.stringify(point)};
const die = () => process.kill(process.pid, 'SIGKILL');
const originalFsync = fs.fsyncSync;
const originalRename = fs.renameSync;
if (point === 'chunk-data-fsync') fs.fsyncSync = (...args) => { const result = originalFsync(...args); die(); return result; };
if (point === 'chunk-progress-rename') fs.renameSync = (...args) => { const result = originalRename(...args); if (JSON.parse(fs.readFileSync(args[1], 'utf8')).offset > 0) die(); return result; };
syncBuiltinESMExports();
const { openChatStorage } = await import(${JSON.stringify(storageUrl)});
const { createChatTransfers, encodeTransfer, TRANSFER_CHUNK_BYTES } = await import(${JSON.stringify(transfersUrl)});
const snapshot = ${JSON.stringify(snapshot)};
const store = openChatStorage({ stateDir: ${JSON.stringify(root)}, hubScope: 'sigkill' });
const transfers = createChatTransfers(store);
store.migrationCheckpoint(snapshot.identity, snapshot.migrationId, [{ kind: 'settings', id: 'provider', value: { model: 'frozen-model' }, at: 0 }]);
if (point === 'checkpoint-commit') die();
const payload = encodeTransfer(snapshot);
const transfer = transfers.begin(payload.manifest);
for (let offset = 0; offset < payload.bytes.length; offset += TRANSFER_CHUNK_BYTES) transfers.chunk(transfer.id, offset, payload.bytes.subarray(offset, offset + TRANSFER_CHUNK_BYTES));
if (point === 'stage-event-before-commit') store.compose((raw) => {
  const prepare = raw.prepare.bind(raw);
  raw.prepare = (sql) => {
    const statement = prepare(sql);
    if (sql === 'INSERT INTO events VALUES(?,?,?,?)') {
      const run = statement.run.bind(statement);
      statement.run = (...args) => { const result = run(...args); die(); return result; };
    }
    return statement;
  };
});
transfers.finish(transfer.id);
if (point === 'prepared-commit') die();
store.activate('store', 'crash-move', 2, payload.manifest.hash);
if (point === 'activation-commit') die();
throw new Error('Expected SIGKILL hook did not run');
`
    writeFileSync(workerPath, worker, { mode: 0o600 })
    let store: ReturnType<typeof openChatStorage> | undefined
    try {
      const killed = spawnSync(process.execPath, ['--import', 'tsx', workerPath], {
        cwd: join(import.meta.dirname, '../../../..'),
        env: { ...process.env, HOME: root, USERPROFILE: root },
        encoding: 'utf8',
        timeout: 15_000
      })
      expect(killed.stderr, `worker stderr: ${killed.stderr}`).toBe('')
      expect(killed.signal).toBe('SIGKILL')
      store = openChatStorage({ stateDir: root, hubScope: 'sigkill' })
      const transfers = createChatTransfers(store)
      if (point !== 'activation-commit') {
        expect(store.migrationCheckpoint(identity, snapshot.migrationId)).toEqual([
          { kind: 'settings', id: 'provider', value: { model: 'frozen-model' }, at: 0 }
        ])
      }
      if (point === 'stage-event-before-commit') expect(store.conversation('store')).toBeNull()
      const start = transfers.begin(payload.manifest)
      for (let offset = start.offset; offset < payload.bytes.length; offset += TRANSFER_CHUNK_BYTES)
        transfers.chunk(
          start.id,
          offset,
          payload.bytes.subarray(offset, offset + TRANSFER_CHUNK_BYTES)
        )
      expect(transfers.finish(start.id)).toEqual({
        id: 'store',
        epoch: 2,
        hash: payload.manifest.hash
      })
      store.activate('store', snapshot.migrationId, 2, payload.manifest.hash)
      transfers.collectActivated()
      expect(store.conversation('store')).toMatchObject({ state: 'active', identity: { epoch: 2 } })
      expect(store.read('store', -1)).toEqual(snapshot.events)
      expect(store.getRecord('store', 'draft', 'state')).toEqual(snapshot.records[0].value)
      expect(store.migrationCheckpoint(identity, snapshot.migrationId)).toBeNull()
      expect(
        readdirSync(join(store.dir, 'transfers')).filter((name) => name.endsWith('.data'))
      ).toEqual([])
    } finally {
      store?.close()
      rmSync(root, { recursive: true, force: true })
    }
  },
  20_000
)

test('legacy active locator with missing computer store is quarantined without wedging healthy history', async () => {
  const f = await fixture()
  try {
    f.h.db
      .prepare(
        "INSERT INTO tasks(id,project_id,title,has_worktree) VALUES('healthy','p','Healthy',1)"
      )
      .run()
    f.h.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('healthy-tab','healthy','claude-chat',0)"
      )
      .run()
    const before = f.services()
    await before.relay.ops.getTabState('healthy-tab')
    const missing = {
      id: 'old-missing-store',
      taskId: 'task',
      tabId: 'prompt-history:task',
      mode: 'claude-chat',
      epoch: 1
    }
    await before.ownership.register({ ...missing, computerId: 'pc' })
    await f.restart()
    const after = f.services()
    await expect(after.recoverComputer('pc')).resolves.toBeUndefined()
    expect(await f.request({ kind: 'inspect', id: missing.id })).toBeNull()
    await expect(after.prompts('task')).rejects.toThrow(/missing|unavailable|recover/i)
    await expect(after.resolvePtyComputer('task', { mode: 'claude-code' })).rejects.toThrow(
      /unavailable/i
    )
    await expect(after.resolvePtyComputer('healthy', { mode: 'claude-code' })).resolves.toBe('pc')
    await expect(after.relay.ops.getTabState('healthy-tab')).resolves.toBeDefined()
    const barrier = createComputerChatCommandBarrier({ lifecycle: after.lifecycle.syncNative })
    await expect(barrier('pc', 'fs.pathExists')).resolves.toBeUndefined()
    await expect(barrier('pc', 'proc.kill')).resolves.toBeUndefined()
    // A matching restored store clears the quarantine; recovery must not create
    // this empty replacement itself while its missing source is unexplained.
    await f.request({
      kind: 'bootstrap',
      value: {
        identity: missing,
        projectId: 'p',
        cwd: f.root,
        revision: 1,
        providerConfig: {},
        defaultFlags: null,
        env: {}
      }
    })
    await after.recoverComputer('pc', true)
    await expect(after.prompts('task')).resolves.toEqual([])
  } finally {
    await f.close()
  }
})
