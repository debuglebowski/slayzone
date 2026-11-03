import { isDeepStrictEqual } from 'node:util'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { eventAttachmentReferences, recordAttachmentReferences } from './attachment-references'
import type { AgentEvent, ChatAttachment } from '@slayzone/terminal-contracts'
import type {
  ChatMigrationSnapshot,
  ChatTransferManifest,
  ChatOwnership,
  ChatRecord,
  CommandReceipt,
  ConversationIdentity,
  StoredChatEvent,
  ChatTabTransition
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
export { digest as chatStorageDigest }
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

export const CHAT_STORAGE_SCHEMA_VERSION = 5

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
  if (schema > CHAT_STORAGE_SCHEMA_VERSION) {
    db.close()
    throw new Error('Chat storage was created by a newer version')
  }
  let redactedSideAnswers = 0
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, tab_id TEXT NOT NULL, mode TEXT NOT NULL,
        epoch INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','frozen','prepared','deleted')),
        migration_id TEXT, migration_hash TEXT
      );
      CREATE INDEX IF NOT EXISTS conversations_task ON conversations(task_id);
      CREATE INDEX IF NOT EXISTS conversations_tab ON conversations(tab_id);
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
      CREATE TABLE IF NOT EXISTS retention_policy(id INTEGER PRIMARY KEY CHECK(id=1),days INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS events_retention ON events(conversation_id,saved_at,seq);
      CREATE INDEX IF NOT EXISTS records_retention ON records(conversation_id,saved_at);
      CREATE INDEX IF NOT EXISTS records_kind_id ON records(kind,id,conversation_id);
      CREATE TABLE IF NOT EXISTS provider_configs (
        task_id TEXT NOT NULL, mode TEXT NOT NULL, revision INTEGER NOT NULL,
        value TEXT NOT NULL, PRIMARY KEY(task_id,mode)
      );
      CREATE TABLE IF NOT EXISTS storage_maintenance (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS task_cleanup_pending (task_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS queue_message_identities (
        task_id TEXT NOT NULL,id TEXT NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        value TEXT NOT NULL,PRIMARY KEY(task_id,id)
      );
    `)
    if (schema < 3) {
      db.exec(
        'ALTER TABLE receipts ADD COLUMN saved_at INTEGER NOT NULL DEFAULT 0; ALTER TABLE receipts ADD COLUMN result_expired INTEGER NOT NULL DEFAULT 0;'
      )
      // v2 receipts had no clock; first-seen time avoids expiring recent retry outcomes on upgrade.
      db.prepare('UPDATE receipts SET saved_at=?').run(Date.now())
      db.exec(
        "DELETE FROM migration_checkpoints WHERE EXISTS(SELECT 1 FROM conversations c WHERE c.id=json_extract(migration_checkpoints.identity,'$.id') AND c.state='active' AND c.migration_id=migration_checkpoints.migration_id)"
      )
    }
    if (
      !(db.pragma('table_info(receipts)') as Array<{ name: string }>).some(
        (column) => column.name === 'method'
      )
    )
      db.exec('ALTER TABLE receipts ADD COLUMN method TEXT')
    if (schema <= 3) {
      // Across the complete v2/v3 mutation result union, only SideAnswer had
      // exactly {text: string|null}. Preserve hashes/states to fence provider
      // retries; ordinary text-bearing results have other required fields.
      redactedSideAnswers = db
        .prepare(`UPDATE receipts SET result='null',result_expired=1,method='askSideQuestion'
        WHERE state='delivered' AND (method IS NULL OR method='askSideQuestion') AND
          CASE WHEN json_valid(result) THEN json_type(result)='object' AND
            json_type(result,'$.text') IN ('text','null') AND
            (SELECT count(*) FROM json_each(result))=1 ELSE 0 END`)
        .run().changes
    }
    if (schema < 5)
      db.prepare(
        "INSERT OR IGNORE INTO task_cleanup_pending SELECT task_id FROM task_lifecycle WHERE state='deleted'"
      ).run()
    // Local index is not part of transfer records. Rebuild from copied ledgers
    // even when their per-conversation initialization marker is already true.
    db.prepare(`INSERT OR IGNORE INTO queue_message_identities
      SELECT c.task_id,substr(r.id,15),c.id,r.value FROM records r
      JOIN conversations c ON c.id=r.conversation_id
      WHERE r.kind='settings' AND r.id GLOB 'queue-message:*'
      ORDER BY r.saved_at,c.rowid`).run()
    db.pragma(`user_version = ${CHAT_STORAGE_SCHEMA_VERSION}`)
  })()
  if (redactedSideAnswers) db.pragma('wal_checkpoint(TRUNCATE)')
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
  function records(id: string, kind?: ChatRecord['kind']): ChatRecord[] {
    return (
      db
        .prepare(
          'SELECT kind,id,value,saved_at FROM records WHERE conversation_id=?' +
            (kind ? ' AND kind=?' : '') +
            ' ORDER BY kind,id'
        )
        .all(id, ...(kind ? [kind] : [])) as Array<{
        kind: ChatRecord['kind']
        id: string
        value: string
        saved_at: number
      }>
    ).map((r) => ({ kind: r.kind, id: r.id, value: JSON.parse(r.value), at: r.saved_at }))
  }
  function indexQueueMessage(id: string, record: Pick<ChatRecord, 'kind' | 'id' | 'value'>) {
    if (record.kind !== 'settings' || !record.id.startsWith('queue-message:')) return
    const target = row(id)
    if (!target) throw new Error('Unknown queue message owner')
    db.prepare(`INSERT INTO queue_message_identities VALUES(?,?,?,?)
      ON CONFLICT(task_id,id) DO UPDATE SET value=excluded.value
      WHERE queue_message_identities.conversation_id=excluded.conversation_id`).run(
      target.task_id,
      record.id.slice(14),
      id,
      JSON.stringify(record.value)
    )
  }
  type ReceiptRow = {
    id: string
    hash: string
    state: CommandReceipt['state']
    result: string
    at: number
    resultExpired: number
    method: string | null
  }
  const receiptColumns =
    'id,hash,state,result,saved_at AS at,result_expired AS resultExpired,method'
  function decodeReceipt(r: ReceiptRow): CommandReceipt {
    const { method, ...rest } = r
    return {
      ...rest,
      ...(method ? { method } : {}),
      result: JSON.parse(r.result),
      resultExpired: !!r.resultExpired
    }
  }
  function receipts(id: string): CommandReceipt[] {
    return (
      db
        .prepare(`SELECT ${receiptColumns} FROM receipts WHERE conversation_id=? ORDER BY id`)
        .all(id) as ReceiptRow[]
    ).map(decodeReceipt)
  }
  function nextSeq(id: string): number {
    const last = (
      db
        .prepare('SELECT COALESCE(MAX(seq),-1)+1 AS seq FROM events WHERE conversation_id=?')
        .get(id) as { seq: number }
    ).seq
    const floor = db
      .prepare(
        "SELECT value FROM records WHERE conversation_id=? AND kind='settings' AND id='event-sequence-floor'"
      )
      .get(id) as { value: string } | undefined
    return Math.max(last, floor ? Number(JSON.parse(floor.value)) : 0)
  }
  /** Every durable content reference owns its pin, even when imported from a sibling. */
  function pinAttachments(id: string, value: unknown, at: number, recoverStoredReference = false) {
    const target = row(id)
    if (!target) throw new Error('Unknown attachment destination')
    const pending: unknown[] = [value]
    const seen = new Set<string>()
    while (pending.length) {
      const item = pending.pop()
      if (!item || typeof item !== 'object') continue
      const ref = item as Partial<ChatAttachment>
      if (
        typeof ref.artifactId === 'string' &&
        typeof ref.name === 'string' &&
        typeof ref.kind === 'string' &&
        typeof ref.mediaType === 'string' &&
        typeof ref.size === 'number'
      ) {
        const key = `${ref.artifactId}:${ref.contentHash ?? ''}`
        if (seen.has(key)) continue
        seen.add(key)
        const pins = db
          .prepare(`SELECT r.id,r.value FROM records r
          JOIN conversations c ON c.id=r.conversation_id
          WHERE c.task_id=? AND c.state IN ('active','frozen') AND r.kind='attachment'
            AND json_extract(r.value,'$.artifactId')=?
            AND (? IS NULL OR json_extract(r.value,'$.contentHash')=?)`)
          .all(
            target.task_id,
            ref.artifactId,
            ref.contentHash ?? null,
            ref.contentHash ?? null
          ) as Array<{ id: string; value: string }>
        const hashes = new Set(pins.map((p) => (JSON.parse(p.value) as ChatAttachment).contentHash))
        if ((hashes.size !== 1 || !pins.length) && !(recoverStoredReference && ref.contentHash))
          throw new Error('Attachment reference is unavailable or ambiguous')
        // A sealed reference already committed in this owner's history is itself
        // ownership proof during upgrade repair, even if its old source pin expired.
        const pin = pins.length
          ? (JSON.parse(pins[0].value) as ChatAttachment)
          : (ref as ChatAttachment)
        if (!pin.contentHash || !/^[a-f0-9]{64}$/.test(pin.contentHash))
          throw new Error('Attachment pin is not sealed')
        const pinId = `${pin.artifactId}:${pin.contentHash}`
        if (
          !db
            .prepare("SELECT 1 FROM records WHERE conversation_id=? AND kind='attachment' AND id=?")
            .get(id, pinId)
        ) {
          const file = join(dir, 'blobs', pin.contentHash)
          if (!lstatSync(file).isFile()) throw new Error('Attachment is not a regular file')
          const bytes = readFileSync(file)
          if (
            bytes.length !== pin.size ||
            createHash('sha256').update(bytes).digest('hex') !== pin.contentHash
          )
            throw new Error('Attachment pin integrity failure')
          db.prepare("INSERT INTO records VALUES(?,'attachment',?,?,?)").run(
            id,
            pinId,
            JSON.stringify({ ...pin, taskId: target.task_id }),
            at
          )
        }
      }
      for (const child of Object.values(item))
        if (child && typeof child === 'object') pending.push(child)
    }
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
    pendingTaskCleanup(): string[] {
      return (
        db.prepare('SELECT task_id FROM task_cleanup_pending ORDER BY task_id').all() as Array<{
          task_id: string
        }>
      ).map((r) => r.task_id)
    },
    completeTaskCleanup(taskId: string): void {
      if (api.taskLifecycle(taskId).state !== 'deleted')
        throw new Error('Task cleanup requires committed deletion')
      db.prepare('DELETE FROM task_cleanup_pending WHERE task_id=?').run(taskId)
    },
    queueMessageIdentity<T>(
      taskId: string,
      messageId: string
    ): { conversationId: string; value: T } | null {
      const found = db
        .prepare(
          'SELECT conversation_id,value FROM queue_message_identities WHERE task_id=? AND id=?'
        )
        .get(taskId, messageId) as { conversation_id: string; value: string } | undefined
      return found
        ? { conversationId: found.conversation_id, value: JSON.parse(found.value) as T }
        : null
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
    prepareTabTransition(value: ChatTabTransition): void {
      api.transaction(() => {
        const { from, to, next } = value
        if (
          !value.id ||
          from.id !== to.id ||
          from.taskId !== to.taskId ||
          from.mode !== to.mode ||
          from.tabId === to.tabId ||
          to.epoch !== from.epoch + 1 ||
          next.id === from.id ||
          next.taskId !== from.taskId ||
          next.tabId !== from.tabId ||
          next.mode === from.mode ||
          next.epoch !== 1
        )
          throw new Error('Invalid provider transition')
        requireEpoch(to.epoch)
        const committed = api.getRecord<ChatTabTransition>(
          from.id,
          'settings',
          `tab-transition:${value.id}`
        )
        if (committed) {
          if (digest(committed) !== digest(value)) throw new Error('Provider transition conflict')
          return
        }
        const owner = requireOwner(from.id, from.epoch)
        if (digest(identity(owner)) !== digest(from))
          throw new Error('Provider transition identity mismatch')
        if (api.taskLifecycle(from.taskId).state === 'deleted')
          throw new Error('Task chat is deleted')
        const pending = api.getRecord<ChatTabTransition>(
          from.id,
          'settings',
          'tab-transition-pending'
        )
        if (pending && digest(pending) !== digest(value))
          throw new Error('Another provider transition is pending')
        api.putRecord(from.id, from.epoch, {
          kind: 'settings',
          id: 'tab-transition-pending',
          value,
          at: Date.now()
        })
      })
    },
    commitTabTransition(value: ChatTabTransition): ConversationIdentity {
      return api.transaction(() => {
        const committed = api.getRecord<ChatTabTransition>(
          value.from.id,
          'settings',
          `tab-transition:${value.id}`
        )
        if (committed) {
          if (digest(committed) !== digest(value)) throw new Error('Provider transition conflict')
          const owner = api.conversation(value.to.id)
          if (!owner || owner.state === 'deleted') throw new Error('Conversation deleted')
          return owner.identity
        }
        const owner = requireOwner(value.from.id, value.from.epoch)
        if (
          digest(identity(owner)) !== digest(value.from) ||
          digest(api.getRecord(value.from.id, 'settings', 'tab-transition-pending')) !==
            digest(value)
        )
          throw new Error('Provider transition is not reserved')
        if (
          db
            .prepare("SELECT 1 FROM conversations WHERE tab_id=? AND state<>'deleted'")
            .get(value.to.tabId)
        )
          throw new Error('Provider archive tab already belongs to another conversation')
        db.prepare('UPDATE conversations SET tab_id=?,epoch=? WHERE id=?').run(
          value.to.tabId,
          value.to.epoch,
          value.from.id
        )
        const draft = api.getRecord(value.from.id, 'draft', 'state')
        if (draft)
          api.putRecord(value.to.id, value.to.epoch, {
            kind: 'draft',
            id: `transition:${value.id}`,
            value: { ...(draft as object), targetConversationId: value.next.id },
            at: Date.now()
          })
        for (const r of db
          .prepare(
            `SELECT r.conversation_id,r.kind,r.id,r.value FROM records r JOIN conversations c ON c.id=r.conversation_id WHERE c.task_id=?`
          )
          .all(value.from.taskId) as Array<{
          conversation_id: string
          kind: string
          id: string
          value: string
        }>) {
          let record = JSON.parse(r.value) as unknown
          let changed = false
          const own = r.conversation_id === value.from.id
          if (r.kind === 'settings' && r.id === 'thread-parent' && record === value.from.tabId) {
            record = value.to.tabId
            changed = true
          } else if (record && typeof record === 'object' && !Array.isArray(record)) {
            const data = record as Record<string, unknown>
            if (own && r.kind === 'settings' && r.id === 'bootstrap') {
              data.identity = value.to
              changed = true
            }
            if (own && ['queue', 'workspace'].includes(r.kind) && data.tabId === value.from.tabId) {
              data.tabId = value.to.tabId
              changed = true
            }
            if (r.kind === 'thread' && data.parentTabId === value.from.tabId) {
              data.parentTabId = value.to.tabId
              changed = true
            }
            if (r.kind === 'settings' && r.id.startsWith('metadata:')) {
              if (own) {
                data.tabId = value.to.tabId
                data.epoch = value.to.epoch
                changed = true
              }
              const content = data.value as Record<string, unknown> | undefined
              if (data.kind === 'thread-created' && content?.parentTabId === value.from.tabId) {
                content.parentTabId = value.to.tabId
                changed = true
              }
            }
          }
          if (changed)
            db.prepare(
              'UPDATE records SET value=? WHERE conversation_id=? AND kind=? AND id=?'
            ).run(JSON.stringify(record), r.conversation_id, r.kind, r.id)
        }
        db.prepare(
          "DELETE FROM records WHERE conversation_id=? AND kind='settings' AND id='tab-transition-pending'"
        ).run(value.from.id)
        api.putRecord(value.to.id, value.to.epoch, {
          kind: 'settings',
          id: `tab-transition:${value.id}`,
          value,
          at: Date.now()
        })
        return value.to
      })
    },
    forTab(tabId: string): ChatOwnership | null {
      const found = db
        .prepare(
          "SELECT id FROM conversations WHERE tab_id=? AND state<>'deleted' ORDER BY rowid DESC LIMIT 1"
        )
        .get(tabId) as { id: string } | undefined
      return found ? api.conversation(found.id) : null
    },
    isTabDeleted(taskId: string, tabId: string): boolean {
      return !!db
        .prepare(
          "SELECT 1 FROM conversations WHERE task_id=? AND tab_id=? AND state='deleted' LIMIT 1"
        )
        .get(taskId, tabId)
    },
    getRecord<T>(id: string, kind: ChatRecord['kind'], key: string): T | null {
      const found = db
        .prepare('SELECT value FROM records WHERE conversation_id=? AND kind=? AND id=?')
        .get(id, kind, key) as { value: string } | undefined
      return found ? (JSON.parse(found.value) as T) : null
    },
    findRecords(
      kind: ChatRecord['kind'],
      taskId?: string,
      filter: { id?: string; idPrefix?: string; limit?: number } = {}
    ): Array<ChatRecord & { conversationId: string }> {
      const found = db
        .prepare(
          "SELECT r.*,c.id AS conversation_id FROM records r JOIN conversations c ON c.id=r.conversation_id WHERE r.kind=? AND c.state<>'deleted'" +
            (taskId ? ' AND c.task_id=?' : '') +
            (filter.id !== undefined ? ' AND r.id=?' : '') +
            (filter.idPrefix !== undefined ? ' AND r.id>=? AND r.id<?' : '') +
            (filter.limit
              ? " ORDER BY r.conversation_id,json_extract(r.value,'$.sequence') LIMIT ?"
              : ' ORDER BY r.saved_at,r.id')
        )
        .all(
          kind,
          ...(taskId ? [taskId] : []),
          ...(filter.id !== undefined ? [filter.id] : []),
          ...(filter.idPrefix !== undefined ? [filter.idPrefix, filter.idPrefix + '\uffff'] : []),
          ...(filter.limit ? [filter.limit] : [])
        ) as Array<{
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
        if (seq < (api.getRecord<number>(id, 'settings', 'event-sequence-floor') ?? 0))
          return 'clash'
        if (db.prepare('SELECT 1 FROM events WHERE conversation_id=? AND seq=?').get(id, seq))
          return 'clash'
        pinAttachments(id, eventAttachmentReferences(event), at)
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
          "DELETE FROM records WHERE conversation_id=? AND kind='settings' AND id='event-sequence-floor'"
        ).run(id)
        db.prepare(
          "DELETE FROM records WHERE conversation_id=? AND kind IN ('timeline','workspace')"
        ).run(id)
      })()
    },
    append(id: string, epoch: number, event: AgentEvent, at = Date.now()): StoredChatEvent {
      return db.transaction(() => {
        requireOwner(id, epoch)
        const seq = nextSeq(id)
        pinAttachments(id, eventAttachmentReferences(event), at)
        db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(id, seq, at, JSON.stringify(event))
        return { seq, at, event }
      })()
    },
    read,
    records,
    nextSeq,
    repairAttachmentPins() {
      if (db.prepare("SELECT 1 FROM storage_maintenance WHERE id='attachment-pins-v4'").get())
        return { unresolved: 0 }
      let unresolved = 0
      for (const [table, column, filter] of [
        ['events', 'event', ''],
        [
          'records',
          'value',
          "AND (r.kind IN ('draft','queue') OR (r.kind='settings' AND r.id GLOB 'attachment-message:*'))"
        ]
      ]) {
        let cursor = 0
        for (;;) {
          const batch = db
            .prepare(`SELECT r.rowid AS cursor,r.conversation_id AS id,r.${column} AS value,r.saved_at AS at
            ,${table === 'events' ? 'NULL AS kind,NULL AS record_id' : 'r.kind,r.id AS record_id'}
            FROM ${table} r JOIN conversations c ON c.id=r.conversation_id
            WHERE c.state='active' AND r.rowid>? AND r.${column} LIKE '%"artifactId"%' ${filter}
            ORDER BY r.rowid LIMIT 100`)
            .all(cursor) as Array<{
            cursor: number
            id: string
            value: string
            at: number
            kind: ChatRecord['kind']
            record_id: string
          }>
          for (const record of batch) {
            cursor = record.cursor
            try {
              const parsed = JSON.parse(record.value)
              const refs =
                table === 'events'
                  ? eventAttachmentReferences(parsed as AgentEvent)
                  : recordAttachmentReferences({
                      kind: record.kind,
                      id: record.record_id,
                      value: parsed
                    })
              api.transaction(() => pinAttachments(record.id, refs, record.at, true))
            } catch {
              unresolved++
            }
          }
          if (batch.length < 100) break
        }
      }
      if (!unresolved)
        db.prepare("INSERT INTO storage_maintenance VALUES('attachment-pins-v4')").run()
      return { unresolved }
    },
    hasConversationContent(id: string): boolean {
      return !!db
        .prepare(`SELECT 1 FROM events WHERE conversation_id=? UNION ALL
        SELECT 1 FROM records WHERE conversation_id=? AND
          (kind IN ('queue','thread','workspace','timeline') OR
           (kind='settings' AND id IN ('metadata-state:agent-state','metadata-state:activity')) OR (kind='draft' AND
            (COALESCE(json_extract(value,'$.draft.text'),'')<>'' OR
             COALESCE(json_array_length(value,'$.draft.attachments'),0)>0))) LIMIT 1`)
        .get(id, id)
    },
    putRecord(id: string, epoch: number, record: ChatRecord): void {
      db.transaction(() => {
        requireOwner(id, epoch)
        if (
          record.kind === 'draft' ||
          record.kind === 'queue' ||
          (record.kind === 'settings' && record.id.startsWith('attachment-message:'))
        )
          pinAttachments(id, recordAttachmentReferences(record), record.at)
        db.prepare(
          'INSERT INTO records VALUES(?,?,?,?,?) ON CONFLICT(conversation_id,kind,id) DO UPDATE SET value=excluded.value,saved_at=excluded.saved_at'
        ).run(id, record.kind, record.id, JSON.stringify(record.value), record.at)
        indexQueueMessage(id, record)
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
        const method =
          input &&
          typeof input === 'object' &&
          'method' in input &&
          typeof input.method === 'string'
            ? input.method
            : null
        db.prepare(
          "INSERT INTO receipts(conversation_id,id,hash,state,result,saved_at,method) VALUES(?,?,?,'accepted','null',?,?)"
        ).run(id, operationId, hash, Date.now(), method)
        return 'accepted'
      })()
    },
    completeCommand(id: string, epoch: number, operationId: string, result: unknown): void {
      db.transaction(() => {
        requireOwner(id, epoch)
        const changed = db
          .prepare(
            "UPDATE receipts SET state='delivered',result=CASE WHEN method='askSideQuestion' THEN 'null' ELSE ? END WHERE conversation_id=? AND id=?"
          )
          .run(JSON.stringify(result ?? null), id, operationId)
        if (!changed.changes) throw new Error('Unknown operation')
      })()
    },
    receipt(id: string, operationId: string): CommandReceipt | null {
      const found = db
        .prepare(`SELECT ${receiptColumns} FROM receipts WHERE conversation_id=? AND id=?`)
        .get(id, operationId) as ReceiptRow | undefined
      return found ? decodeReceipt(found) : null
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
            indexQueueMessage(i.id, r)
            records++
          } else if (entry.kind === 'receipt') {
            const r = entry.value as CommandReceipt
            if (
              typeof r.id !== 'string' ||
              typeof r.hash !== 'string' ||
              !['accepted', 'delivered'].includes(r.state)
            )
              throw new Error('Transfer receipt integrity mismatch')
            db.prepare(
              'INSERT INTO receipts(conversation_id,id,hash,state,result,saved_at,result_expired,method) VALUES(?,?,?,?,?,?,?,?)'
            ).run(
              i.id,
              r.id,
              r.hash,
              r.state,
              JSON.stringify(r.result ?? null),
              r.at ?? Date.now(),
              r.resultExpired ? 1 : 0,
              r.method ?? null
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
        for (const r of snapshot.records) {
          db.prepare('INSERT INTO records VALUES(?,?,?,?,?)').run(
            i.id,
            r.kind,
            r.id,
            JSON.stringify(r.value),
            r.at
          )
          indexQueueMessage(i.id, r)
        }
        for (const r of snapshot.receipts)
          db.prepare(
            'INSERT INTO receipts(conversation_id,id,hash,state,result,saved_at,result_expired,method) VALUES(?,?,?,?,?,?,?,?)'
          ).run(
            i.id,
            r.id,
            r.hash,
            r.state,
            JSON.stringify(r.result),
            r.at ?? Date.now(),
            r.resultExpired ? 1 : 0,
            r.method ?? null
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
        db.prepare('DELETE FROM migration_checkpoints WHERE migration_id=?').run(migrationId)
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
          const saved = JSON.parse(previous.value) as ChatRecord[]
          const upgrade = (r: ChatRecord) =>
            r.kind === 'settings' &&
            ['legacy-attachment-manifest', 'legacy-task-content-authority'].includes(r.id)
          const added = candidate?.slice(saved.length) ?? []
          if (added.length && added.every(upgrade)) {
            if (
              (owner && ['prepared', 'active', 'deleted'].includes(owner.state)) ||
              new Set([...saved, ...added].map((r) => `${r.kind}:${r.id}`)).size !==
                saved.length + added.length ||
              digest(candidate!.slice(0, saved.length)) !== digest(saved)
            )
              throw new Error('Migration checkpoint cannot replace frozen content')
            const encoded = JSON.stringify(candidate)
            if (Buffer.byteLength(encoded) > 16 * 1024 * 1024)
              throw new Error('Migration metadata is too large')
            db.prepare('UPDATE migration_checkpoints SET value=? WHERE migration_id=?').run(
              encoded,
              migrationId
            )
            return JSON.parse(encoded) as ChatRecord[]
          }
          return saved
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
        let inheritedTab = value.tabId
        if (
          existing &&
          existing.tab_id !== value.tabId &&
          existing.task_id === value.taskId &&
          existing.mode === value.mode
        ) {
          const transitions = records(value.id, 'settings')
            .filter((r) => r.id.startsWith('tab-transition:'))
            .map((r) => r.value as ChatTabTransition)
            .sort((a, b) => a.from.epoch - b.from.epoch)
          for (const transition of transitions)
            if (transition.from.tabId === inheritedTab && transition.to.epoch <= value.epoch)
              inheritedTab = transition.to.tabId
        }
        if (
          existing &&
          (existing.task_id !== value.taskId ||
            existing.tab_id !== inheritedTab ||
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
          // Filesystem removal runs only after this tombstone and its cleanup
          // intent commit together. A SQL rollback must preserve live originals.
          db.prepare('INSERT OR IGNORE INTO task_cleanup_pending VALUES(?)').run(value.taskId)
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
          db.prepare(
            "DELETE FROM records WHERE kind='thread' AND id=? AND conversation_id IN(SELECT id FROM conversations WHERE task_id=?)"
          ).run(value.tabId, value.taskId)
          for (const table of ['events', 'records', 'receipts'])
            db.prepare(`DELETE FROM ${table} WHERE conversation_id=?`).run(value.id)
          db.prepare("DELETE FROM migration_checkpoints WHERE json_extract(identity,'$.id')=?").run(
            value.id
          )
        }
        if (taskDeleted)
          db.prepare('DELETE FROM provider_configs WHERE task_id=?').run(value.taskId)
        if (taskDeleted)
          db.prepare('DELETE FROM queue_message_identities WHERE task_id=?').run(value.taskId)
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
