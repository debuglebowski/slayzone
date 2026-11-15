/**
 * The chat store's connection is swappable (storage compaction, fu-2): `compose` hands
 * out a stable handle that always reaches the CURRENT connection, so services that keep
 * it for their lifetime survive a swap; connection state (SQL functions, pragmas) is
 * re-applied; secondary connections and a leftover WAL refuse the swap; leftovers of an
 * interrupted swap are cleaned at boot.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'
import { agentTurnsStore } from './agent-turns'
import { createComputerChatRuntime } from './computer-runtime'
import { openChatStorage, type ChatStorage } from './storage'
import { usageCursorStore } from './usage-cursors'

const roots: string[] = []
const stores: ChatStorage[] = []
const runtimes: Array<ReturnType<typeof createComputerChatRuntime>> = []
const extra: Database.Database[] = []
afterEach(async () => {
  for (const db of extra.splice(0)) if (db.open) db.close()
  for (const r of runtimes.splice(0)) await r.close()
  for (const s of stores.splice(0)) s.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'slz-chat-swap-'))
  roots.push(root)
  return root
}
function open(root = tempRoot(), scope = 'hub-a') {
  const store = openChatStorage({ stateDir: root, hubScope: scope })
  stores.push(store)
  return { store, root }
}
const identity = { id: 'conv-a', taskId: 'task-a', tabId: 'tab-a', mode: 'claude-chat', epoch: 1 }
const text = (t: string) => ({ kind: 'assistant-text', messageId: t, text: t }) as const

/** A compacted copy of the live store, as the compactor makes it (VACUUM INTO). */
function compactedCopy(store: ChatStorage): string {
  store.checkpoint()
  const target = store.maintenance.tempPath()
  const reader = new Database(store.path, { readonly: true, fileMustExist: true })
  try {
    reader.pragma('auto_vacuum = INCREMENTAL')
    reader.prepare('VACUUM INTO ?').run(target)
  } finally {
    reader.close()
  }
  return target
}
const leftovers = (store: ChatStorage) =>
  readdirSync(store.dir).filter((n) => n.startsWith('chat.sqlite.'))

describe('swappable chat store connection', () => {
  test('a handle kept from compose reaches the new file after a swap', () => {
    const { store } = open()
    store.createConversation(identity)
    store.append(identity.id, 1, text('before'))
    const held = store.compose((db) => db)
    expect(store.maintenance.fileStats().autoVacuum).toBe(0)

    const result = store.maintenance.swapIn(compactedCopy(store))

    expect(result.holdMs).toBeGreaterThanOrEqual(0)
    expect(store.maintenance.fileStats().autoVacuum).toBe(2)
    expect(held.prepare('SELECT count(*) n FROM events').get()).toEqual({ n: 1 })
    store.append(identity.id, 1, text('after'))
    expect(store.read(identity.id, -1).map((e) => (e.event as { text: string }).text)).toEqual([
      'before',
      'after'
    ])
    expect(held.pragma('auto_vacuum', { simple: true })).toBe(2)
    expect(leftovers(store)).toEqual([])
  })

  test('connection pragmas hold on the new connection, journal_size_limit included', () => {
    const { store } = open()
    const db = store.compose((d) => d)
    const pragmas = () => ({
      journal: db.pragma('journal_mode', { simple: true }),
      synchronous: db.pragma('synchronous', { simple: true }),
      foreignKeys: db.pragma('foreign_keys', { simple: true }),
      busy: db.pragma('busy_timeout', { simple: true }),
      secureDelete: db.pragma('secure_delete', { simple: true }),
      walLimit: db.pragma('journal_size_limit', { simple: true })
    })
    const expected = {
      journal: 'wal',
      synchronous: 2,
      foreignKeys: 1,
      busy: 5000,
      secureDelete: 1,
      walLimit: 64 * 1024 * 1024
    }
    expect(pragmas()).toEqual(expected)
    store.maintenance.swapIn(compactedCopy(store))
    expect(pragmas()).toEqual(expected)
  })

  test('connection state set through the handle is re-applied: SQL functions and pragmas', () => {
    const { store } = open()
    const db = store.compose((d) => d)
    db.function('swap_probe', () => 42)
    db.pragma('cache_size = -4096')
    store.maintenance.swapIn(compactedCopy(store))
    expect(db.prepare('SELECT swap_probe() v').get()).toEqual({ v: 42 })
    expect(db.pragma('cache_size', { simple: true })).toBe(-4096)
  })

  test('a statement prepared before the swap fails loudly after it', () => {
    const { store } = open()
    store.createConversation(identity)
    const stale = store.compose((db) => db.prepare('SELECT count(*) n FROM events'))
    store.maintenance.swapIn(compactedCopy(store))
    expect(() => stale.get()).toThrow(/not open/)
  })

  test('the handle cannot close the store connection', () => {
    const { store } = open()
    expect(() => store.compose((db) => db.close())).toThrow(/owns its connection/)
    expect(store.compose((db) => db.open)).toBe(true)
  })

  test('a registered secondary connection makes the swap wait; the live store is unchanged', () => {
    const { store } = open()
    store.createConversation(identity)
    store.append(identity.id, 1, text('kept'))
    const copy = compactedCopy(store)
    const reader = store.maintenance.registerSecondary('export reader')
    expect(store.maintenance.secondaryConnections()).toEqual(['export reader'])
    expect(() => store.maintenance.swapIn(copy)).toThrow(/secondary connection/)
    expect(store.maintenance.fileStats().autoVacuum).toBe(0)
    expect(store.read(identity.id, -1)).toHaveLength(1)
    reader.release()
    reader.release()
    expect(store.maintenance.secondaryConnections()).toEqual([])
    store.maintenance.swapIn(copy)
    expect(store.maintenance.fileStats().autoVacuum).toBe(2)
    expect(store.read(identity.id, -1)).toHaveLength(1)
  })

  test('backstop: an unregistered connection keeps the WAL alive → swap refused, nothing lost', () => {
    const { store } = open()
    store.createConversation(identity)
    const copy = compactedCopy(store)
    // An unregistered reader that has read once holds the WAL index open (a connection
    // that never read holds nothing; registration is the rule, this is the backstop).
    const rogue = new Database(store.path, { readonly: true })
    extra.push(rogue)
    rogue.prepare('SELECT count(*) FROM events').get()
    store.append(identity.id, 1, text('in the wal'))
    expect(() => store.maintenance.swapIn(copy)).toThrow(/WAL/)
    expect(store.maintenance.fileStats().autoVacuum).toBe(0)
    expect(store.read(identity.id, -1).map((e) => (e.event as { text: string }).text)).toEqual([
      'in the wal'
    ])
    store.append(identity.id, 1, text('still writable'))
    expect(store.read(identity.id, -1)).toHaveLength(2)
    expect(existsSync(copy)).toBe(false)
    expect(leftovers(store)).toEqual([])
  })

  test('a file from another store is refused and the live file restored', () => {
    const { store } = open()
    store.createConversation(identity)
    store.append(identity.id, 1, text('mine'))
    const other = open().store
    const foreign = compactedCopy(other)
    renameSync(foreign, join(store.dir, 'chat.sqlite.compact-foreign'))
    expect(() => store.maintenance.swapIn(join(store.dir, 'chat.sqlite.compact-foreign'))).toThrow(
      /store identity/
    )
    expect(store.read(identity.id, -1)).toHaveLength(1)
    store.append(identity.id, 1, text('writable'))
    expect(store.read(identity.id, -1)).toHaveLength(2)
    expect(leftovers(store)).toEqual([])
  })
})

describe('boot cleanup', () => {
  test('leftovers of an interrupted compaction are removed before opening', () => {
    const { store, root } = open()
    store.createConversation(identity)
    const dir = store.dir
    store.close()
    for (const name of [
      'chat.sqlite.compact-1-x',
      'chat.sqlite.compact-1-x-journal',
      'chat.sqlite.compact-2-y-wal',
      'chat.sqlite.pre-compact'
    ])
      writeFileSync(join(dir, name), 'junk')
    const reopened = open(root).store
    expect(leftovers(reopened)).toEqual([])
    expect(reopened.conversation(identity.id)?.state).toBe('active')
  })

  test('a store found only as pre-compact (killed between link and rename) is restored', () => {
    const { store, root } = open()
    store.createConversation(identity)
    const dir = store.dir
    store.close()
    renameSync(join(dir, 'chat.sqlite'), join(dir, 'chat.sqlite.pre-compact'))
    const reopened = open(root).store
    expect(reopened.conversation(identity.id)?.state).toBe('active')
    expect(leftovers(reopened)).toEqual([])
  })
})

describe('computer runtime services across a swap', () => {
  test('services that keep the handle for their lifetime keep working', async () => {
    const stateDir = tempRoot()
    const r = createComputerChatRuntime({ stateDir, hubScope: 'hub', computerId: 'pc' })
    runtimes.push(r)
    r.bootstrap({
      identity: { id: 'c', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 },
      projectId: 'project',
      cwd: stateDir,
      revision: 1,
      providerConfig: {},
      defaultFlags: null,
      env: {}
    })
    const cursors = usageCursorStore(r.storage)
    const turns = agentTurnsStore(r.storage)

    r.storage.maintenance.swapIn(compactedCopy(r.storage))

    // retention keeps its handle from construction
    r.retention.configure(3)
    expect(r.retention.days).toBe(3)
    // task paths keep theirs
    r.taskPaths.handle({ op: 'set', taskId: 'task', projectId: 'project', baseDir: '/b', at: 1 })
    expect(r.taskPaths.get('task')?.baseDir).toBe('/b')
    // usage cursors
    cursors.commit([{ sourceFile: '/log', offset: 7, modifiedMs: 1 }])
    expect(cursors.all()).toEqual({ '/log': { offset: 7, modifiedMs: 1 } })
    // agent turns
    turns.insert({
      id: 'turn',
      worktree_path: '/w',
      task_id: 'task',
      terminal_tab_id: 'tab',
      snapshot_sha: 'a'.repeat(40),
      head_sha_at_snap: 'b'.repeat(40),
      prompt_preview: 'p',
      created_at: 1
    })
    expect(turns.get('turn')?.task_id).toBe('task')
    // artifacts: their triggers call a SQL function registered on the connection
    const artifact = (await r.artifacts.invoke({
      route: { id: 'c', epoch: 1 },
      method: 'uploadArtifactBlob',
      operationId: randomUUID(),
      args: [{ taskId: 'task', title: 'a.txt', data: Buffer.from('x').toString('base64') }]
    })) as { id: string }
    expect(
      r.storage.compose((db) =>
        db.prepare('SELECT conversation_id FROM artifact_owners WHERE id=?').get(artifact.id)
      )
    ).toEqual({ conversation_id: 'c' })
  })
})
