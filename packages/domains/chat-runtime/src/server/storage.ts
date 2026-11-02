import { isDeepStrictEqual } from 'node:util'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import type {
  ChatMigrationSnapshot,
  ChatTransferManifest,
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
  if (schema > 2) {
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
      CREATE TABLE IF NOT EXISTS blob_leases (id TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS task_lifecycle (task_id TEXT PRIMARY KEY,state TEXT NOT NULL,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS migration_checkpoints (
        migration_id TEXT PRIMARY KEY, identity TEXT NOT NULL, value TEXT NOT NULL
      );
      PRAGMA user_version = 2;
    `)
  })()
  const purgeListeners: Array<(taskId: string) => void> = []
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
      return db.transaction(action).immediate()
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
    compose<T>(factory: (db: Database.Database) => T): T {
      return factory(db)
    },
    onTaskPurge(listener: (taskId: string) => void) {
      purgeListeners.push(listener)
    },
    inventory(): ChatOwnership[] {
      return (
        db.prepare('SELECT id FROM conversations ORDER BY task_id,rowid').all() as { id: string }[]
      ).map((r) => api.conversation(r.id)!)
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
      if (row(`task-tombstone:${value.taskId}`)?.state === 'deleted')
        throw new Error('Task chat history was deleted')
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
          .run(JSON.stringify(result ?? null), id, operationId)
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
    stageTransfer(manifest: ChatTransferManifest, lines: Iterable<string>): void {
      const h = manifest.header
      if (row(`task-tombstone:${h.identity.taskId}`)?.state === 'deleted')
        throw new Error('Task chat history was deleted')
      requireEpoch(h.identity.epoch + 1)
      if (
        h.format !== 'slayzone-chat' ||
        h.version !== 1 ||
        !h.migrationId ||
        ![h.events, h.records, h.receipts].every((n) => Number.isSafeInteger(n) && n >= 0)
      )
        throw new Error('Invalid transfer header')
      db.transaction(() => {
        const previous = row(h.identity.id)
        if (previous) {
          if (
            previous.migration_id === h.migrationId &&
            previous.migration_hash === manifest.hash &&
            ['active', 'prepared'].includes(previous.state)
          )
            return
          throw new Error('Transfer would overwrite existing ownership')
        }
        const i = h.identity,
          hash = createHash('sha256')
        let first = true,
          events = 0,
          records = 0,
          receipts = 0,
          lastSeq = -1
        db.prepare("INSERT INTO conversations VALUES(?,?,?,?,?,'prepared',?,?)").run(
          i.id,
          i.taskId,
          i.tabId,
          i.mode,
          i.epoch + 1,
          h.migrationId,
          manifest.hash
        )
        for (const line of lines) {
          hash.update(line + '\n')
          const entry = JSON.parse(line)
          if (first) {
            first = false
            if (!isDeepStrictEqual(entry, h)) throw new Error('Transfer header integrity mismatch')
            continue
          }
          if (entry.kind === 'event') {
            const e = entry.value as StoredChatEvent
            if (
              !Number.isSafeInteger(e.seq) ||
              e.seq <= lastSeq ||
              !Number.isSafeInteger(e.at) ||
              !e.event?.kind
            )
              throw new Error('Transfer event integrity mismatch')
            db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(
              i.id,
              e.seq,
              e.at,
              JSON.stringify(e.event)
            )
            lastSeq = e.seq
            events++
          } else if (entry.kind === 'record') {
            const r = entry.value as ChatRecord
            if (
              ![
                'draft',
                'queue',
                'prompt',
                'thread',
                'workspace',
                'attachment',
                'settings',
                'timeline'
              ].includes(r.kind) ||
              typeof r.id !== 'string' ||
              !Number.isSafeInteger(r.at)
            )
              throw new Error('Transfer record integrity mismatch')
            db.prepare('INSERT INTO records VALUES(?,?,?,?,?)').run(
              i.id,
              r.kind,
              r.id,
              JSON.stringify(r.value),
              r.at
            )
            records++
          } else if (entry.kind === 'receipt') {
            const r = entry.value as CommandReceipt
            if (
              typeof r.id !== 'string' ||
              typeof r.hash !== 'string' ||
              !['accepted', 'delivered'].includes(r.state)
            )
              throw new Error('Transfer receipt integrity mismatch')
            db.prepare('INSERT INTO receipts VALUES(?,?,?,?,?)').run(
              i.id,
              r.id,
              r.hash,
              r.state,
              JSON.stringify(r.result ?? null)
            )
            receipts++
          } else throw new Error('Transfer record kind integrity mismatch')
        }
        if (
          first ||
          events !== h.events ||
          records !== h.records ||
          receipts !== h.receipts ||
          hash.digest('hex') !== manifest.hash
        )
          throw new Error('Transfer hash/count integrity mismatch')
      })()
    },
    stage(snapshot: ChatMigrationSnapshot): void {
      if (row(`task-tombstone:${snapshot.identity.taskId}`)?.state === 'deleted')
        throw new Error('Task chat history was deleted')
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
    migrationCheckpoint(
      value: ConversationIdentity,
      migrationId: string,
      candidate?: ChatRecord[]
    ): ChatRecord[] | null {
      requireEpoch(value.epoch)
      if (!migrationId) throw new Error('Migration id is required')
      const tombstone = row(`task-tombstone:${value.taskId}`),
        owner = row(value.id)
      if (tombstone?.state === 'deleted' || owner?.state === 'deleted')
        throw new Error('Conversation deleted')
      if (
        owner &&
        (owner.task_id !== value.taskId ||
          owner.tab_id !== value.tabId ||
          owner.mode !== value.mode ||
          owner.epoch > value.epoch + 1)
      )
        throw new Error('Migration checkpoint ownership mismatch')
      return db.transaction(() => {
        const previous = db
          .prepare('SELECT identity,value FROM migration_checkpoints WHERE migration_id=?')
          .get(migrationId) as { identity: string; value: string } | undefined
        if (previous) {
          if (digest(JSON.parse(previous.identity)) !== digest(value))
            throw new Error('Migration checkpoint identity mismatch')
          return JSON.parse(previous.value) as ChatRecord[]
        }
        if (!candidate) return null
        const encoded = JSON.stringify(candidate)
        if (Buffer.byteLength(encoded) > 16 * 1024 * 1024)
          throw new Error('Migration metadata is too large')
        db.prepare('INSERT INTO migration_checkpoints VALUES(?,?,?)').run(
          migrationId,
          JSON.stringify(value),
          encoded
        )
        return JSON.parse(encoded) as ChatRecord[]
      })()
    },
    taskLifecycle(taskId: string): { state: 'active' | 'paused' | 'deleted'; revision: number } {
      return (
        (db.prepare('SELECT state,revision FROM task_lifecycle WHERE task_id=?').get(taskId) as
          | { state: 'active' | 'paused' | 'deleted'; revision: number }
          | undefined) ?? { state: 'active', revision: 0 }
      )
    },
    applyTaskLifecycle(taskId: string, state: 'active' | 'paused' | 'deleted', revision: number) {
      requireEpoch(revision)
      return api.transaction(() => {
        const previous = api.taskLifecycle(taskId)
        if (previous.state === 'deleted') {
          if (state === 'deleted' && revision > previous.revision) {
            db.prepare('UPDATE task_lifecycle SET revision=? WHERE task_id=?').run(revision, taskId)
            return { state, revision }
          }
          return previous
        }
        if (previous.revision >= revision) return previous
        db.prepare(
          'INSERT INTO task_lifecycle VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET state=excluded.state,revision=excluded.revision'
        ).run(taskId, state, revision)
        if (state === 'deleted') {
          api.applyTombstone(
            {
              id: `task-tombstone:${taskId}`,
              taskId,
              tabId: `task-tombstone:${taskId}`,
              mode: 'claude-chat',
              epoch: revision
            },
            true
          )
        }
        return { state, revision }
      })
    },
    applyTombstone(value: ConversationIdentity, taskDeleted = false): void {
      requireEpoch(value.epoch)
      api.transaction(() => {
        const existing = row(value.id)
        if (
          existing &&
          (existing.task_id !== value.taskId ||
            existing.tab_id !== value.tabId ||
            existing.mode !== value.mode)
        )
          throw new Error('Deletion ownership mismatch')
        if (existing && existing.epoch > value.epoch && existing.state !== 'deleted')
          throw new Error('Stale deletion epoch')
        const epoch = Math.max(existing?.epoch ?? 0, value.epoch)
        db.prepare(
          "INSERT INTO conversations(id,task_id,tab_id,mode,epoch,state) VALUES(?,?,?,?,?,'deleted') ON CONFLICT(id) DO UPDATE SET state='deleted',epoch=excluded.epoch"
        ).run(value.id, value.taskId, value.tabId, value.mode, epoch)
        if (taskDeleted) {
          for (const listener of purgeListeners) listener(value.taskId)
          const id = `task-tombstone:${value.taskId}`
          db.prepare(
            "INSERT INTO conversations(id,task_id,tab_id,mode,epoch,state) VALUES(?,?,?,'claude-chat',1,'deleted') ON CONFLICT(id) DO UPDATE SET state='deleted'"
          ).run(id, value.taskId, id)
          db.prepare(
            "INSERT INTO task_lifecycle VALUES(?,'deleted',?) ON CONFLICT(task_id) DO UPDATE SET state='deleted',revision=MAX(task_lifecycle.revision,excluded.revision)"
          ).run(value.taskId, value.epoch)
          db.prepare(
            "UPDATE conversations SET state='deleted',epoch=epoch+CASE WHEN state='deleted' THEN 0 ELSE 1 END WHERE task_id=?"
          ).run(value.taskId)
          for (const table of ['events', 'records', 'receipts'])
            db.prepare(
              `DELETE FROM ${table} WHERE conversation_id IN(SELECT id FROM conversations WHERE task_id=?)`
            ).run(value.taskId)
          db.prepare(
            "DELETE FROM migration_checkpoints WHERE json_extract(identity,'$.taskId')=?"
          ).run(value.taskId)
        } else {
          for (const table of ['events', 'records', 'receipts'])
            db.prepare(`DELETE FROM ${table} WHERE conversation_id=?`).run(value.id)
          db.prepare("DELETE FROM migration_checkpoints WHERE json_extract(identity,'$.id')=?").run(
            value.id
          )
        }
      })
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
    backupTo(destination: string) {
      return db.backup(destination)
    },
    acquireBlobLease(id: string, ttlMs: number) {
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error('Invalid blob lease')
      db.prepare(
        'INSERT INTO blob_leases VALUES(?,?) ON CONFLICT(id) DO UPDATE SET expires_at=excluded.expires_at'
      ).run(id, Date.now() + ttlMs)
      return {
        release: () => {
          db.prepare('DELETE FROM blob_leases WHERE id=?').run(id)
        }
      }
    },
    hasBlobLeases() {
      return !!db.prepare('SELECT 1 FROM blob_leases WHERE expires_at>? LIMIT 1').get(Date.now())
    },
    checkpoint(): void {
      db.pragma('wal_checkpoint(TRUNCATE)')
    }
  }
  return api
}
export type ChatStorage = ReturnType<typeof openChatStorage>
