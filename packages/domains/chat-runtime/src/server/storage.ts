import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import type {
  ChatMigrationSnapshot,
  ChatOwnership,
  ChatRecord,
  CommandReceipt,
  ConversationIdentity,
  StoredChatEvent
} from '../shared'

function digest(value: unknown): string {
  return createHash('sha256')
    .update(
      JSON.stringify(value, (_key, v) =>
        v && typeof v === 'object' && !Array.isArray(v)
          ? Object.fromEntries(
              Object.keys(v)
                .sort()
                .map((key) => [key, v[key]])
            )
          : v
      )
    )
    .digest('hex')
}
function requireEpoch(epoch: number): void {
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error('Invalid ownership epoch')
}
interface OwnerRow {
  id: string
  task_id: string
  tab_id: string
  mode: string
  epoch: number
  state: ChatOwnership['state']
  migration_id: string | null
  migration_hash: string | null
}

/** One database per authenticated hub namespace. Never accepts a caller-supplied disk path. */
export function openChatStorage(opts: { stateDir: string; hubScope: string }) {
  if (!opts.hubScope.trim()) throw new Error('Hub storage scope is required')
  const dir = join(opts.stateDir, 'computer-runtime', digest(opts.hubScope))
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const path = join(dir, 'chat.sqlite')
  const db = new Database(path)
  chmodSync(path, 0o600)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = FULL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.pragma('secure_delete = ON')
  const schema = db.pragma('user_version', { simple: true }) as number
  if (schema > 1) {
    db.close()
    throw new Error('Chat storage was created by a newer version')
  }
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, tab_id TEXT NOT NULL, mode TEXT NOT NULL,
        epoch INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','frozen','prepared','deleted')),
        migration_id TEXT, migration_hash TEXT
      );
      CREATE INDEX IF NOT EXISTS conversations_task ON conversations(task_id);
      CREATE TABLE IF NOT EXISTS events (
        conversation_id TEXT NOT NULL REFERENCES conversations(id), seq INTEGER NOT NULL,
        saved_at INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY(conversation_id, seq)
      );
      CREATE TABLE IF NOT EXISTS records (
        conversation_id TEXT NOT NULL REFERENCES conversations(id), kind TEXT NOT NULL,
        id TEXT NOT NULL, value TEXT NOT NULL, saved_at INTEGER NOT NULL,
        PRIMARY KEY(conversation_id, kind, id)
      );
      CREATE TABLE IF NOT EXISTS receipts (
        conversation_id TEXT NOT NULL REFERENCES conversations(id), id TEXT NOT NULL,
        hash TEXT NOT NULL, state TEXT NOT NULL, result TEXT NOT NULL,
        PRIMARY KEY(conversation_id, id)
      );
      PRAGMA user_version = 1;
    `)
  })()
  let closed = false
  const row = (id: string) =>
    db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as OwnerRow | undefined
  const identity = (r: OwnerRow): ConversationIdentity => ({
    id: r.id,
    taskId: r.task_id,
    tabId: r.tab_id,
    mode: r.mode,
    epoch: r.epoch
  })
  function requireOwner(id: string, epoch: number, allowFrozen = false): OwnerRow {
    requireEpoch(epoch)
    const r = row(id)
    if (!r) throw new Error('Unknown conversation')
    if (r.state === 'deleted') throw new Error('Conversation deleted')
    if (r.epoch !== epoch) throw new Error('Stale ownership epoch')
    if (r.state !== 'active' && !(allowFrozen && r.state === 'frozen'))
      throw new Error(`Conversation ${r.state}`)
    return r
  }
  function read(
    id: string,
    afterSeq: number,
    beforeSeq = Number.MAX_SAFE_INTEGER
  ): StoredChatEvent[] {
    return (
      db
        .prepare(
          'SELECT seq,saved_at,event FROM events WHERE conversation_id=? AND seq>? AND seq<? ORDER BY seq'
        )
        .all(id, afterSeq, beforeSeq) as Array<{ seq: number; saved_at: number; event: string }>
    ).map((r) => ({ seq: r.seq, at: r.saved_at, event: JSON.parse(r.event) as AgentEvent }))
  }
  function records(id: string): ChatRecord[] {
    return (
      db
        .prepare(
          'SELECT kind,id,value,saved_at FROM records WHERE conversation_id=? ORDER BY kind,id'
        )
        .all(id) as Array<{ kind: ChatRecord['kind']; id: string; value: string; saved_at: number }>
    ).map((r) => ({ kind: r.kind, id: r.id, value: JSON.parse(r.value), at: r.saved_at }))
  }
  function receipts(id: string): CommandReceipt[] {
    return (
      db
        .prepare('SELECT id,hash,state,result FROM receipts WHERE conversation_id=? ORDER BY id')
        .all(id) as Array<{
        id: string
        hash: string
        state: CommandReceipt['state']
        result: string
      }>
    ).map((r) => ({ ...r, result: JSON.parse(r.result) }))
  }
  function verify(snapshot: ChatMigrationSnapshot): void {
    const { hash, ...body } = snapshot
    if (body.version !== 1 || !body.migrationId || digest(body) !== hash)
      throw new Error('Migration integrity mismatch')
    requireEpoch(body.identity.epoch)
    let previous = -1
    for (const e of body.events) {
      if (
        !Number.isSafeInteger(e.seq) ||
        e.seq <= previous ||
        !Number.isSafeInteger(e.at) ||
        !e.event?.kind
      )
        throw new Error('Migration event integrity mismatch')
      previous = e.seq
    }
    if (
      new Set(body.records.map((r) => `${r.kind}:${r.id}`)).size !== body.records.length ||
      new Set(body.receipts.map((r) => r.id)).size !== body.receipts.length
    )
      throw new Error('Migration record integrity mismatch')
  }
  const api = {
    dir,
    path,
    transaction<T>(action: () => T): T {
      return db.transaction(action)()
    },
    close() {
      if (!closed) {
        db.close()
        closed = true
      }
    },
    conversation(id: string): ChatOwnership | null {
      const r = row(id)
      return r
        ? {
            identity: identity(r),
            state: r.state,
            migrationId: r.migration_id,
            migrationHash: r.migration_hash
          }
        : null
    },
    listForTask(taskId: string): ChatOwnership[] {
      return (
        db
          .prepare('SELECT id FROM conversations WHERE task_id=? ORDER BY id')
          .all(taskId) as Array<{ id: string }>
      ).map((r) => api.conversation(r.id)!)
    },
    createConversation(value: ConversationIdentity): void {
      requireEpoch(value.epoch)
      const existing = row(value.id)
      if (existing) {
        if (existing.state === 'deleted') throw new Error('Conversation deleted')
        if (digest(identity(existing)) !== digest(value))
          throw new Error('Conversation ownership conflict')
        return
      }
      db.prepare(
        "INSERT INTO conversations(id,task_id,tab_id,mode,epoch,state) VALUES(?,?,?,?,?,'active')"
      ).run(value.id, value.taskId, value.tabId, value.mode, value.epoch)
    },
    forTab(tabId: string): ChatOwnership | null {
      const found = db
        .prepare(
          "SELECT id FROM conversations WHERE tab_id=? AND state<>'deleted' ORDER BY rowid DESC LIMIT 1"
        )
        .get(tabId) as { id: string } | undefined
      return found ? api.conversation(found.id) : null
    },
    getRecord<T>(id: string, kind: ChatRecord['kind'], key: string): T | null {
      const found = db
        .prepare('SELECT value FROM records WHERE conversation_id=? AND kind=? AND id=?')
        .get(id, kind, key) as { value: string } | undefined
      return found ? (JSON.parse(found.value) as T) : null
    },
    findRecords(
      kind: ChatRecord['kind'],
      taskId?: string
    ): Array<ChatRecord & { conversationId: string }> {
      const found = db
        .prepare(
          "SELECT r.*,c.id AS conversation_id FROM records r JOIN conversations c ON c.id=r.conversation_id WHERE r.kind=? AND c.state<>'deleted'" +
            (taskId ? ' AND c.task_id=?' : '') +
            ' ORDER BY r.saved_at,r.id'
        )
        .all(...(taskId ? [kind, taskId] : [kind])) as Array<{
        conversation_id: string
        kind: ChatRecord['kind']
        id: string
        value: string
        saved_at: number
      }>
      return found.map((r) => ({
        conversationId: r.conversation_id,
        kind: r.kind,
        id: r.id,
        value: JSON.parse(r.value),
        at: r.saved_at
      }))
    },
    appendAt(
      id: string,
      epoch: number,
      seq: number,
      event: AgentEvent,
      at: number
    ): 'inserted' | 'clash' {
      return db.transaction(() => {
        requireOwner(id, epoch)
        const result = db
          .prepare('INSERT INTO events VALUES(?,?,?,?) ON CONFLICT(conversation_id,seq) DO NOTHING')
          .run(id, seq, at, JSON.stringify(event))
        return result.changes ? 'inserted' : 'clash'
      })()
    },
    clearHistory(id: string, epoch: number): void {
      db.transaction(() => {
        requireOwner(id, epoch)
        db.prepare('DELETE FROM events WHERE conversation_id=?').run(id)
        db.prepare(
          "DELETE FROM records WHERE conversation_id=? AND kind IN ('timeline','workspace')"
        ).run(id)
      })()
    },
    append(id: string, epoch: number, event: AgentEvent, at = Date.now()): StoredChatEvent {
      return db.transaction(() => {
        requireOwner(id, epoch)
        const seq = (
          db
            .prepare('SELECT COALESCE(MAX(seq),-1)+1 AS seq FROM events WHERE conversation_id=?')
            .get(id) as { seq: number }
        ).seq
        db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(id, seq, at, JSON.stringify(event))
        return { seq, at, event }
      })()
    },
    read,
    records,
    putRecord(id: string, epoch: number, record: ChatRecord): void {
      db.transaction(() => {
        requireOwner(id, epoch)
        db.prepare(
          'INSERT INTO records VALUES(?,?,?,?,?) ON CONFLICT(conversation_id,kind,id) DO UPDATE SET value=excluded.value,saved_at=excluded.saved_at'
        ).run(id, record.kind, record.id, JSON.stringify(record.value), record.at)
      })()
    },
    removeRecord(id: string, epoch: number, kind: ChatRecord['kind'], key: string): void {
      db.transaction(() => {
        requireOwner(id, epoch)
        db.prepare('DELETE FROM records WHERE conversation_id=? AND kind=? AND id=?').run(
          id,
          kind,
          key
        )
      })()
    },
    acceptCommand(
      id: string,
      epoch: number,
      operationId: string,
      input: unknown
    ): 'accepted' | 'duplicate' {
      return db.transaction(() => {
        requireOwner(id, epoch)
        const hash = digest(input)
        const previous = db
          .prepare('SELECT hash FROM receipts WHERE conversation_id=? AND id=?')
          .get(id, operationId) as { hash: string } | undefined
        if (previous) {
          if (previous.hash !== hash) throw new Error('Operation id reused with different input')
          return 'duplicate'
        }
        db.prepare("INSERT INTO receipts VALUES(?,?,?,'accepted','null')").run(
          id,
          operationId,
          hash
        )
        return 'accepted'
      })()
    },
    completeCommand(id: string, epoch: number, operationId: string, result: unknown): void {
      db.transaction(() => {
        requireOwner(id, epoch)
        const changed = db
          .prepare(
            "UPDATE receipts SET state='delivered',result=? WHERE conversation_id=? AND id=?"
          )
          .run(JSON.stringify(result), id, operationId)
        if (!changed.changes) throw new Error('Unknown operation')
      })()
    },
    receipt(id: string, operationId: string): CommandReceipt | null {
      return receipts(id).find((r) => r.id === operationId) ?? null
    },
    freeze(id: string, epoch: number, migrationId: string): void {
      db.transaction(() => {
        const r = requireOwner(id, epoch, true)
        if (r.state === 'frozen' && r.migration_id && r.migration_id !== migrationId)
          throw new Error('Another migration owns this conversation')
        db.prepare(
          "UPDATE conversations SET state='frozen',migration_id=?,migration_hash=NULL WHERE id=?"
        ).run(migrationId, id)
      })()
    },
    unfreeze(id: string, epoch: number, migrationId: string): void {
      db.transaction(() => {
        const r = requireOwner(id, epoch, true)
        if (r.state !== 'frozen' || r.migration_id !== migrationId)
          throw new Error('Migration ownership mismatch')
        db.prepare(
          "UPDATE conversations SET state='active',migration_id=NULL,migration_hash=NULL WHERE id=?"
        ).run(id)
      })()
    },
    exportConversation(id: string, epoch: number, migrationId: string): ChatMigrationSnapshot {
      return db.transaction(() => {
        const r = requireOwner(id, epoch, true)
        if (r.state !== 'frozen' || r.migration_id !== migrationId)
          throw new Error('Migration must freeze source first')
        const body = {
          version: 1 as const,
          migrationId,
          identity: identity(r),
          events: read(id, -1),
          records: records(id),
          receipts: receipts(id)
        }
        return { ...body, hash: digest(body) }
      })()
    },
    stage(snapshot: ChatMigrationSnapshot): void {
      verify(snapshot)
      db.transaction(() => {
        const r = row(snapshot.identity.id)
        if (r) {
          if (
            r.migration_id === snapshot.migrationId &&
            r.migration_hash === snapshot.hash &&
            r.state !== 'deleted'
          )
            return
          throw new Error('Migration would overwrite existing conversation')
        }
        const i = snapshot.identity
        db.prepare("INSERT INTO conversations VALUES(?,?,?,?,?,'prepared',?,?)").run(
          i.id,
          i.taskId,
          i.tabId,
          i.mode,
          i.epoch + 1,
          snapshot.migrationId,
          snapshot.hash
        )
        for (const e of snapshot.events)
          db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(
            i.id,
            e.seq,
            e.at,
            JSON.stringify(e.event)
          )
        for (const r of snapshot.records)
          db.prepare('INSERT INTO records VALUES(?,?,?,?,?)').run(
            i.id,
            r.kind,
            r.id,
            JSON.stringify(r.value),
            r.at
          )
        for (const r of snapshot.receipts)
          db.prepare('INSERT INTO receipts VALUES(?,?,?,?,?)').run(
            i.id,
            r.id,
            r.hash,
            r.state,
            JSON.stringify(r.result)
          )
      })()
    },
    activate(id: string, migrationId: string, epoch: number, hash: string): void {
      db.transaction(() => {
        const r = row(id)
        if (
          !r ||
          r.state === 'deleted' ||
          r.migration_id !== migrationId ||
          r.migration_hash !== hash
        )
          throw new Error('Migration integrity mismatch')
        if (r.epoch !== epoch) throw new Error('Migration ownership epoch mismatch')
        if (r.state !== 'prepared' && r.state !== 'active')
          throw new Error('Migration activation state mismatch')
        db.prepare("UPDATE conversations SET state='active' WHERE id=?").run(id)
      })()
    },
    deleteConversation(id: string, epoch: number): void {
      requireEpoch(epoch)
      db.transaction(() => {
        const r = row(id)
        if (!r) throw new Error('Unknown conversation')
        if (epoch < r.epoch) throw new Error('Stale ownership epoch')
        db.prepare("UPDATE conversations SET state='deleted',epoch=? WHERE id=?").run(epoch, id)
        for (const table of ['events', 'records', 'receipts'])
          db.prepare(`DELETE FROM ${table} WHERE conversation_id=?`).run(id)
      })()
    },
    checkpoint(): void {
      db.pragma('wal_checkpoint(TRUNCATE)')
    }
  }
  return api
}
export type ChatStorage = ReturnType<typeof openChatStorage>
