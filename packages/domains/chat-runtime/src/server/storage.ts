import { isDeepStrictEqual } from 'node:util'
import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { isMainThread } from 'node:worker_threads'
import { chatStorageDigest as digest } from './storage-digest'
import { commitStorageFence } from './storage-fence'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createSwappableDb } from './chat-db-handle'
import { attachCheckpointer, type CheckpointResult, type StoreCheckpointer } from './checkpointer'
import { uptime } from 'node:os'
import {
  createSyncFaultLedger,
  ITEM_FAULTS_DDL,
  type ItemFaultRow
} from '@slayzone/platform/isolation'
import { eventAttachmentReferences, recordAttachmentReferences } from './attachment-references'
import { createBlobStore } from './blob-store'
import {
  chatBlobRefs,
  clampChatHistoryPageBudget,
  cutChatHistoryPage,
  escapeChatBlobLiterals,
  extractChatBlobs,
  resolveChatBlobs,
  type AgentEvent,
  type ChatAttachment,
  type ChatBlobRefBody,
  type ChatHistoryPageBudget
} from '@slayzone/terminal-contracts'
import type {
  ChatMigrationSnapshot,
  ChatTransferManifest,
  ChatOwnership,
  ChatRecord,
  ChatRecordKind,
  CommandReceipt,
  ConversationIdentity,
  StoredChatEvent,
  ChatTabTransition
} from '../shared'
import { CHAT_RECORD_KINDS } from '../shared'
import type { EncodedTimelineWrite } from '@slayzone/terminal/timeline-records'
import { historyReadTurns } from '@slayzone/terminal/history-turns'

export { chatStorageDigest } from './storage-digest'
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

/**
 * v13: out-of-line event payloads (crash fix 4) — `events.blob_form`, `event-blob`
 * pins, `maintenance_cursors`. An older build must never open a v13 store: its blob
 * GC knows only attachment pins and would delete every event blob.
 */
export const CHAT_STORAGE_SCHEMA_VERSION = 13

/**
 * Bytes one `readEventBlob` call returns at most (raw; ≈683 KiB base64): below the
 * direct link's 1 MiB message and any hub↔computer frame limit. Clients page.
 */
export const CHAT_BLOB_CHUNK_BYTES = 512 * 1024
/**
 * Stored bytes of timeline pages one `dropTimelineStep` deletes at most (one page
 * always): the event loop runs between steps (secure-delete zero-fills every freed
 * byte, so a chat's whole projection at once froze the computer for seconds).
 */
export const TIMELINE_DROP_STEP_BYTES = 4 * 1024 * 1024

/** A referenced event blob cannot be read back (export / transfer refuses: no lossy copy). */
/** How long an export's blob lease lasts without renewal (renewed while it runs). */
const EXPORT_LEASE_MS = 60_000

/** A move's export of one conversation, from a read snapshot (`openExportReader`). */
export interface ChatExportReader {
  readonly identity: ConversationIdentity
  readonly migrationId: string
  /** Saved events in the snapshot. */
  readonly eventCount: number
  /** Counts only: no retained or derived body is loaded while the source is frozen. */
  readonly recordCount: number
  readonly receiptCount: number
  /** One history page (stored form) after `afterSeq`; `more`: pages follow. */
  eventPage(afterSeq: number): { events: StoredChatEvent[]; more: boolean }
  /** Retained records in `(kind,id)` order; excluded kinds never load their bodies. */
  recordPage(after?: Pick<ChatRecord, 'kind' | 'id'>): { records: ChatRecord[]; more: boolean }
  receiptPage(afterId?: string): { receipts: CommandReceipt[]; more: boolean }
  /** A stored event's raw form (images back inline, hash-verified). */
  resolve(event: AgentEvent): AgentEvent
  /** End the snapshot, release its blob lease. Idempotent. */
  close(): void
}

export class EventBlobUnavailableError extends Error {
  constructor(
    readonly sha256: string,
    why: string,
    options?: { cause?: unknown }
  ) {
    super(`Event blob ${sha256} is ${why}`, options)
    this.name = 'EventBlobUnavailableError'
  }
}

/**
 * `events.blob_form`: the representation a row holds. 0 = LEGACY raw content, saved
 * before v13 (base64 inline; the backfill extracts it); 1 = STORED form (binary
 * payloads are `ChatBlobRef`s, foreign reference-shaped objects escaped). Every
 * insert in this file writes 1, through `insertEvent`.
 */
export const EVENT_BLOB_FORM = 1

/** The event-blob backfill's maintenance key (`storage_maintenance` / `maintenance_cursors`). */
export const EVENT_BLOBS_MAINTENANCE = 'event-blobs-v1'

/** One database per authenticated hub namespace. Never accepts a caller-supplied disk path. */

/** Record kinds that never reach the hub's metadata (conversation content only). */
const LOCAL_ONLY_RECORD_KINDS = [
  'draft',
  'prompt',
  'workspace',
  'attachment',
  'timeline',
  'pinned-message',
  'event-blob'
] as const satisfies readonly ChatRecordKind[]
/** The event kinds `prompts.summaries` reads: they name a native conversation, or are a prompt. */
export const EVENT_MARKER_KINDS = ['turn-init', 'conversation-branch', 'user-message'] as const
const MARKER_KINDS_SQL = EVENT_MARKER_KINDS.map((k) => `'${k}'`).join(',')
/** One marker row's values from event JSON `e` — the extracts the old full scan made. */
const markerValues = (e: string) =>
  `json_extract(${e},'$.kind'),json_extract(${e},'$.sessionId'),json_extract(${e},'$.conversationId'),json_extract(${e},'$.id')`
/** `e` is a valid event of a marker kind (an invalid row never refuses its write). */
const isMarker = (e: string) =>
  `json_valid(${e}) AND json_extract(${e},'$.kind') IN (${MARKER_KINDS_SQL})`

/**
 * Event markers (FU5 computer stalls; derived, no schema version): the ~0.4 % of event
 * rows `prompts.summaries` needs, so it never parses every event of a task again.
 *
 * - `event_markers`: per marker-kind row, the values the old scan extracted. Value
 *   columns have NO declared type: they keep `json_extract`'s exact SQL type.
 * - `event_marker_coverage`: conversations whose rows are ALL indexed. Born covered
 *   (the conversation row exists before any of its events: FK); a conversation from
 *   before markers is covered once `event-marker-backfill.ts` reaches its end.
 * - Triggers, not the JS insert path: every writer is covered (inserts, the legacy-row
 *   rewrite, retention / clear deletes) — including an OLDER build reopening this
 *   file, because the triggers live in it. That is why no version bump is needed.
 */
export const EVENT_MARKERS_DDL = `
  CREATE TABLE IF NOT EXISTS event_markers (
    conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, kind, session_id, branch_id, message_id,
    PRIMARY KEY(conversation_id, seq)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS event_marker_coverage (conversation_id TEXT PRIMARY KEY) WITHOUT ROWID;
  CREATE TRIGGER IF NOT EXISTS event_markers_insert AFTER INSERT ON events
  WHEN ${isMarker('NEW.event')}
  BEGIN
    INSERT OR REPLACE INTO event_markers VALUES(NEW.conversation_id,NEW.seq,${markerValues('NEW.event')});
  END;
  CREATE TRIGGER IF NOT EXISTS event_markers_update AFTER UPDATE OF conversation_id,seq,event ON events
  BEGIN
    DELETE FROM event_markers WHERE conversation_id=OLD.conversation_id AND seq=OLD.seq;
    INSERT OR REPLACE INTO event_markers
      SELECT NEW.conversation_id,NEW.seq,${markerValues('NEW.event')} WHERE ${isMarker('NEW.event')};
  END;
  CREATE TRIGGER IF NOT EXISTS event_markers_delete AFTER DELETE ON events
  BEGIN
    DELETE FROM event_markers WHERE conversation_id=OLD.conversation_id AND seq=OLD.seq;
  END;
  CREATE TRIGGER IF NOT EXISTS event_marker_coverage_insert AFTER INSERT ON conversations
  BEGIN
    INSERT OR IGNORE INTO event_marker_coverage VALUES(NEW.id);
  END;
  CREATE TRIGGER IF NOT EXISTS event_marker_coverage_delete AFTER DELETE ON conversations
  BEGIN
    DELETE FROM event_marker_coverage WHERE conversation_id=OLD.id;
  END;
`

/** Derived metadata: old writers invalidate it without decoding page bodies. */
const TIMELINE_METADATA_DDL = `
  CREATE TABLE IF NOT EXISTS timeline_page_metadata (
    conversation_id TEXT NOT NULL, page_id TEXT NOT NULL,
    summary TEXT NOT NULL, search_text TEXT NOT NULL,
    PRIMARY KEY(conversation_id,page_id)
  ) WITHOUT ROWID;
  CREATE TRIGGER IF NOT EXISTS timeline_page_metadata_insert AFTER INSERT ON records
  WHEN NEW.kind='timeline' AND NEW.id GLOB 'page:*' BEGIN
    DELETE FROM timeline_page_metadata WHERE conversation_id=NEW.conversation_id AND page_id=NEW.id;
  END;
  CREATE TRIGGER IF NOT EXISTS timeline_page_metadata_update AFTER UPDATE OF conversation_id,kind,id,value ON records
  BEGIN
    DELETE FROM timeline_page_metadata WHERE OLD.kind='timeline'
      AND conversation_id=OLD.conversation_id AND page_id=OLD.id;
    DELETE FROM timeline_page_metadata WHERE NEW.kind='timeline'
      AND conversation_id=NEW.conversation_id AND page_id=NEW.id;
  END;
  CREATE TRIGGER IF NOT EXISTS timeline_page_metadata_delete AFTER DELETE ON records
  WHEN OLD.kind='timeline' AND OLD.id GLOB 'page:*' BEGIN
    DELETE FROM timeline_page_metadata WHERE conversation_id=OLD.conversation_id AND page_id=OLD.id;
  END;
`

/** Trigger body: bump `task_state_versions` for the task named by SQL expression `task`. */
export function bumpTaskStateVersion(task: string): string {
  return `INSERT INTO task_state_versions(task_id,version) SELECT ${task},1 WHERE ${task} IS NOT NULL
    ON CONFLICT(task_id) DO UPDATE SET version=version+1;`
}

/** The agent-session ledger's tables (session-ledger.ts). Idempotent. */
export const SESSION_LEDGER_DDL = `
  CREATE TABLE IF NOT EXISTS agent_sessions (
    id TEXT PRIMARY KEY, mode TEXT NOT NULL, cwd TEXT, task_id TEXT, tab_id TEXT,
    conversation_id TEXT, origin TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pooled','bound','dead')),
    pending_meta TEXT, created_at INTEGER NOT NULL, bound_at INTEGER, ended_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS agent_sessions_task_tab ON agent_sessions(task_id, mode, tab_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS agent_sessions_conversation ON agent_sessions(conversation_id);
  CREATE INDEX IF NOT EXISTS agent_sessions_pool ON agent_sessions(cwd, mode) WHERE status = 'pooled';
  -- FU5: a chat task holds hundreds of spawns on ONE conversation. Without these the
  -- resume / sessions-list rules probed every spawn of it per candidate row (n²;
  -- 250–520 ms on the dev store). The first serves CURRENT_CONVERSATION_SQL's ORDER BY
  -- (same expression) so the newest accepted row ends the walk; the second answers the
  -- claim probes' (conversation, task) test from the index. Plain indexes: older builds
  -- ignore them, inserts keep them.
  CREATE INDEX IF NOT EXISTS agent_sessions_task_mode_owned
    ON agent_sessions(task_id, mode, coalesce(bound_at, created_at) DESC);
  CREATE INDEX IF NOT EXISTS agent_sessions_conversation_task ON agent_sessions(conversation_id, task_id);
  CREATE TABLE IF NOT EXISTS task_conversations (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, mode TEXT NOT NULL, tab_id TEXT,
    conversation_id TEXT, origin TEXT NOT NULL, pending_meta TEXT, created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS task_conversations_lookup ON task_conversations(task_id, mode, created_at);
  CREATE TABLE IF NOT EXISTS session_turns (
    conversation_id TEXT PRIMARY KEY, first_turn_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS session_resets (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, mode TEXT NOT NULL, tab_id TEXT,
    except_chat INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS session_resets_lookup ON session_resets(task_id, mode, tab_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS session_deletions (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, mode TEXT NOT NULL,
    conversation_id TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS session_deletions_lookup ON session_deletions(task_id, mode, conversation_id);
  CREATE TABLE IF NOT EXISTS mode_agents (mode TEXT PRIMARY KEY, agent_type TEXT);
  CREATE TABLE IF NOT EXISTS legacy_conversation_history (
    task_id TEXT NOT NULL, mode TEXT NOT NULL, ids TEXT NOT NULL, PRIMARY KEY(task_id, mode)
  );
`

/**
 * Agent-turn snapshots (agent-turns.ts): one row per turn boundary, grouped by the
 * checkout's canonical path on this computer. Only here since robustness plan §9
 * (hub migration v207). Idempotent.
 */
export const AGENT_TURNS_DDL = `
  CREATE TABLE IF NOT EXISTS agent_turns (
    id TEXT PRIMARY KEY, worktree_path TEXT NOT NULL, task_id TEXT, terminal_tab_id TEXT NOT NULL,
    snapshot_sha TEXT NOT NULL, head_sha_at_snap TEXT, prompt_preview TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS agent_turns_worktree ON agent_turns(worktree_path, created_at);
  CREATE INDEX IF NOT EXISTS agent_turns_task ON agent_turns(task_id);
`

/**
 * v10: this computer's read offsets into its agents' usage logs (robustness plan §9,
 * P0; hub v209 — the hub keeps none). Moved only after the hub stored the records
 * (usage-analytics collector.ts). Not task data: no task id, not erased.
 */
export const USAGE_CURSORS_DDL = `
  CREATE TABLE IF NOT EXISTS usage_cursors (
    file_path TEXT PRIMARY KEY, offset INTEGER NOT NULL, modified_ms REAL NOT NULL
  );
`

/**
 * v12 `task_path_releases`: the worktree of a purged task, kept until the hub has
 * removed (or kept, shared) the checkout and says `forget` (hub v211: the hub holds
 * no path to remove it by) — at most {@link TASK_PATH_RELEASE_TTL_MS}.
 *
 * v11: a task's worktree path and base dir (task-paths.ts; robustness plan §9, P0,
 * Phase 7a, hub v210) — only here; the hub hands its rows over once. Task data:
 * purged with the task.
 */
export const TASK_PATHS_DDL = `
  CREATE TABLE IF NOT EXISTS task_paths (
    task_id TEXT PRIMARY KEY, project_id TEXT, worktree_path TEXT, base_dir TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS task_path_releases (
    task_id TEXT PRIMARY KEY, project_id TEXT, worktree_path TEXT NOT NULL,
    released_at INTEGER NOT NULL
  );
`

export function openChatStorage(opts: {
  stateDir: string
  hubScope: string
  /**
   * Diagnostic boot time (epoch ms). Default: now − `os.uptime()`. Every unclean
   * start rotates identity: uptime cannot reliably distinguish short OS boots.
   */
  machineBootedAt?: number
  /** WAL sync / checkpoint cadence of the off-thread checkpointer (ms). Default 1000. */
  checkpointIntervalMs?: number
  /** Internal owner-worker binding. Never serialized: the worker constructs its local bridge. */
  ownerWorker?: {
    createCheckpointer(
      path: string,
      hooks: {
        intervalMs?: number
        onFailure(message: string): void
        onRecovered(): void
      }
    ): StoreCheckpointer
  }
}) {
  if (opts.ownerWorker && isMainThread) throw new Error('Chat storage owner must run on a worker')
  if (!opts.hubScope.trim()) throw new Error('Hub storage scope is required')
  const dir = join(opts.stateDir, 'computer-runtime', digest(opts.hubScope))
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const path = join(dir, 'chat.sqlite')
  const blobs = createBlobStore(join(dir, 'blobs'))
  recoverInterruptedSwap(dir, path)
  // The store's one connection, behind a handle that survives a swap (chat-db-handle).
  const connection = createSwappableDb(openChatConnection(path))
  const db = connection.db
  const schema = db.pragma('user_version', { simple: true }) as number
  if (schema > CHAT_STORAGE_SCHEMA_VERSION) {
    connection.current().close()
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
        saved_at INTEGER NOT NULL, event TEXT NOT NULL, blob_form INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(conversation_id, seq)
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
      -- A chat's settings handed off by the hub (chat-settings, hub v205) before this
      -- computer had a configuration for the chat: the first read starts from them.
      CREATE TABLE IF NOT EXISTS provider_config_seeds (
        task_id TEXT NOT NULL, mode TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY(task_id,mode)
      );
      CREATE TABLE IF NOT EXISTS storage_maintenance (id TEXT PRIMARY KEY);
      -- v13: where a resumable background maintenance pass (event-blob backfill) is.
      CREATE TABLE IF NOT EXISTS maintenance_cursors (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_cleanup_pending (task_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS queue_message_identities (
        task_id TEXT NOT NULL,id TEXT NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        value TEXT NOT NULL,PRIMARY KEY(task_id,id)
      );
    `)
    // v6: per-item fault ledger (same DDL as the hub's v203) and the index of
    // which restored archives hold which task (erasure opens only those).
    db.exec(ITEM_FAULTS_DDL)
    db.exec(`
      CREATE TABLE IF NOT EXISTS archive_index (archive_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS archive_tasks (
        archive_id TEXT NOT NULL REFERENCES archive_index(archive_id) ON DELETE CASCADE,
        task_id TEXT NOT NULL, PRIMARY KEY(archive_id, task_id)
      );
      CREATE INDEX IF NOT EXISTS archive_tasks_task ON archive_tasks(task_id);
    `)
    // v7: the agent-session ledger (robustness plan §9, P0) — only here, never on
    // the hub. `session_resets` / `session_deletions` are the hub's intent as
    // delivered (same names, so the ledger's rules read them as plain tables).
    db.exec(SESSION_LEDGER_DDL)
    // v8: agent-turn snapshots (robustness plan §9, P0; hub migration v207).
    db.exec(AGENT_TURNS_DDL)
    // v10: usage-log read offsets (usage-cursors.ts).
    db.exec(USAGE_CURSORS_DDL)
    // v11: task worktree paths and base dirs (task-paths.ts).
    db.exec(TASK_PATHS_DDL)
    // FU5: the event-marker index of `prompts.summaries` (derived; see the DDL).
    db.exec(EVENT_MARKERS_DDL)
    db.exec(TIMELINE_METADATA_DDL)
    // Version of the hub-facing metadata state, per task. Triggers are the one
    // choke point, so every writer (bootstrap, retention, migration, future code)
    // bumps it. Fail safe: a record kind counts unless it is known to stay local.
    // Recovery re-reads a conversation's metadata only when this moved past what
    // the hub last applied.
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_state_versions (
        task_id TEXT PRIMARY KEY, version INTEGER NOT NULL
      );
      ${['INSERT', 'UPDATE', 'DELETE']
        .map((op) => {
          const r = op === 'DELETE' ? 'OLD' : 'NEW'
          // Recreated on every open: the local-only kinds are this build's, so a
          // kind added since the database was created stays local too.
          return `
      DROP TRIGGER IF EXISTS records_state_version_${op.toLowerCase()};
      CREATE TRIGGER records_state_version_${op.toLowerCase()} AFTER ${op} ON records
      WHEN NOT (${r}.kind IN (${LOCAL_ONLY_RECORD_KINDS.map((k) => `'${k}'`).join(',')})
        OR (${r}.kind='settings' AND (${r}.id='metadata-counter' OR ${r}.id GLOB 'metadata:*')))
      BEGIN ${bumpTaskStateVersion(`(SELECT task_id FROM conversations WHERE id=${r}.conversation_id)`)} END;
      CREATE TRIGGER IF NOT EXISTS provider_configs_state_version_${op.toLowerCase()} AFTER ${op} ON provider_configs
      BEGIN ${bumpTaskStateVersion(`${r}.task_id`)} END;`
        })
        .join('')}
      CREATE TRIGGER IF NOT EXISTS conversations_state_version AFTER UPDATE ON conversations
      BEGIN ${bumpTaskStateVersion('NEW.task_id')} END;
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
    // v13: rows already saved hold raw content (form 0) — metadata-only, no row is read.
    if (
      !(db.pragma('table_info(events)') as Array<{ name: string }>).some(
        (column) => column.name === 'blob_form'
      )
    )
      db.exec('ALTER TABLE events ADD COLUMN blob_form INTEGER NOT NULL DEFAULT 0')
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
    // v9 (hub v208): chat settings, session ids and queued messages are this
    // computer's alone, so the hub no longer takes `provider-config`,
    // `conversation` or `queue-item` updates. Any still awaiting delivery go.
    if (schema < 9)
      db.prepare(
        `DELETE FROM records WHERE kind='settings' AND id GLOB 'metadata:*' AND json_valid(value)
          AND json_extract(value,'$.kind') IN ('provider-config','conversation','queue-item')`
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
  // This database's identity, created once. Metadata counters are only
  // comparable within one database: the hub re-reads a conversation whose
  // updates arrive from another store (a recreated database restarts at 1).
  // A copy (backup restore) keeps the id; the hub's receipts catch that rollback.
  db.exec(
    'CREATE TABLE IF NOT EXISTS store_identity (id INTEGER PRIMARY KEY CHECK(id=1), store_id TEXT NOT NULL)'
  )
  db.prepare('INSERT OR IGNORE INTO store_identity VALUES(1,?)').run(randomUUID())
  // An unclean start can follow an OS crash with a lost NORMAL tail. Uptime-based
  // boot estimates cannot distinguish short reboots reliably. Rotate conservatively
  // after EVERY unclean run, including process-only crashes; clean restarts keep ID.
  // The FULL session commit publishes both identity and unclean mark before serving.
  const machineBootedAt = Math.round(opts.machineBootedAt ?? Date.now() - uptime() * 1000)
  const session = (
    db.prepare("SELECT value FROM maintenance_cursors WHERE id='store-session'").get() as
      | { value: string }
      | undefined
  )?.value
  const previous = session ? (JSON.parse(session) as StoreSession) : null
  // Absence (legacy/restored state) is not proof of a clean shutdown either.
  const unclean = previous?.clean !== true
  const saveSession = (clean: boolean) =>
    db
      .prepare(
        "INSERT INTO maintenance_cursors VALUES('store-session',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value"
      )
      .run(JSON.stringify({ clean, bootedAt: machineBootedAt } satisfies StoreSession))
  // Durable before anything is served (a boot-time fsync on this thread): a crash
  // later in this run must find "not clean".
  db.pragma('synchronous = FULL')
  db.transaction(() => {
    if (unclean) db.prepare('UPDATE store_identity SET store_id=? WHERE id=1').run(randomUUID())
    saveSession(false)
  })()
  db.pragma('synchronous = NORMAL')
  const storeId = (
    db.prepare('SELECT store_id FROM store_identity WHERE id=1').get() as { store_id: string }
  ).store_id
  const purgeListeners: Array<(taskId: string) => void> = []
  let closed = false
  let unavailable: ChatStorageSwapError | undefined
  // Retain every attempted replacement until physical close or facade selection.
  const swapConnections = new Set<Database.Database>()
  /** `on`: another connection on this file (an export's read snapshot); default the store's. */
  const row = (id: string, on: Database.Database = db) =>
    on.prepare('SELECT * FROM conversations WHERE id=?').get(id) as OwnerRow | undefined
  const identity = (r: OwnerRow): ConversationIdentity => ({
    id: r.id,
    taskId: r.task_id,
    tabId: r.tab_id,
    mode: r.mode,
    epoch: r.epoch
  })
  function requireOwner(
    id: string,
    epoch: number,
    allowFrozen = false,
    allowPrepared = false
  ): OwnerRow {
    requireEpoch(epoch)
    const r = row(id)
    if (!r) throw new Error('Unknown conversation')
    if (r.state === 'deleted') throw new Error('Conversation deleted')
    if (r.epoch !== epoch) throw new Error('Stale ownership epoch')
    if (
      r.state !== 'active' &&
      !(allowFrozen && r.state === 'frozen') &&
      !(allowPrepared && r.state === 'prepared')
    )
      throw new Error(`Conversation ${r.state}`)
    return r
  }
  function read(
    id: string,
    afterSeq: number,
    beforeSeq = Number.MAX_SAFE_INTEGER,
    on: Database.Database = db
  ): StoredChatEvent[] {
    return (
      on
        .prepare(
          'SELECT seq,saved_at,event,blob_form FROM events WHERE conversation_id=? AND seq>? AND seq<? ORDER BY seq'
        )
        .all(id, afterSeq, beforeSeq) as Array<{
        seq: number
        saved_at: number
        event: string
        blob_form: number
      }>
    ).map((r) => {
      const event = JSON.parse(r.event) as AgentEvent
      // Every reader gets STORED form: a legacy row's look-alikes escaped (no bytes move).
      return {
        seq: r.seq,
        at: r.saved_at,
        event: r.blob_form === EVENT_BLOB_FORM ? event : escapeChatBlobLiterals(event)
      }
    })
  }
  /**
   * Where ONE page of `read(id, afterSeq, beforeSeq)` ends, from the rows' sizes in
   * their record headers (`octet_length`, no body loaded): the first row always
   * fits. `more`: rows follow the page in the range.
   */
  function pageBounds(
    id: string,
    afterSeq: number,
    beforeSeq: number,
    budget: Required<ChatHistoryPageBudget>,
    on: Database.Database = db
  ): { through: number | null; more: boolean; sizes: Map<number, number> } {
    const sizes = on
      .prepare(
        'SELECT seq, octet_length(event) AS bytes FROM events WHERE conversation_id=? AND seq>? AND seq<? ORDER BY seq LIMIT ?'
      )
      .all(id, afterSeq, beforeSeq, budget.maxEvents + 1) as Array<{ seq: number; bytes: number }>
    return {
      ...cutChatHistoryPage(sizes, budget),
      sizes: new Map(sizes.map((r) => [r.seq, r.bytes]))
    }
  }
  /**
   * ONE page of `read(id, afterSeq, beforeSeq)`: cut at the budget from the rows'
   * stored sizes (`pageBounds`), then only its rows are loaded and parsed.
   */
  function readPage(
    id: string,
    afterSeq: number,
    beforeSeq: number,
    budget: Required<ChatHistoryPageBudget>
  ): { events: StoredChatEvent[]; bytes: number[]; more: boolean } {
    const bounds = pageBounds(id, afterSeq, beforeSeq, budget)
    if (bounds.through === null) return { events: [], bytes: [], more: false }
    const events = read(id, afterSeq, bounds.through + 1)
    return {
      events,
      bytes: events.map((e) => bounds.sizes.get(e.seq) ?? 0),
      more: bounds.more
    }
  }
  /**
   * Events with `afterSeq < seq < beforeSeq` whose stored JSON contains one of
   * `needles` — SQLite filters, only the matching rows are parsed (a caller still
   * checks what it parsed: a needle can occur anywhere in an event).
   */
  function readMatching(
    id: string,
    afterSeq: number,
    beforeSeq: number,
    needles: readonly string[]
  ): StoredChatEvent[] {
    if (needles.length === 0) return []
    return (
      db
        .prepare(
          `SELECT seq,saved_at,event,blob_form FROM events WHERE conversation_id=? AND seq>? AND seq<? AND (${needles
            .map(() => 'instr(event, ?) > 0')
            .join(' OR ')}) ORDER BY seq`
        )
        .all(id, afterSeq, beforeSeq, ...needles) as Array<{
        seq: number
        saved_at: number
        event: string
        blob_form: number
      }>
    ).map((r) => {
      const event = JSON.parse(r.event) as AgentEvent
      // STORED form, as `read` serves it.
      return {
        seq: r.seq,
        at: r.saved_at,
        event: r.blob_form === EVENT_BLOB_FORM ? event : escapeChatBlobLiterals(event)
      }
    })
  }
  /** Seq of the `count`-th newest event (index only); null when there are fewer. */
  function tailStart(id: string, count: number): number | null {
    if (count < 1) return null
    const r = db
      .prepare('SELECT seq FROM events WHERE conversation_id=? ORDER BY seq DESC LIMIT 1 OFFSET ?')
      .get(id, count - 1) as { seq: number } | undefined
    return r?.seq ?? null
  }
  type RecordRow = { kind: ChatRecord['kind']; id: string; value: string; saved_at: number }
  const decodeRecord = (r: RecordRow): ChatRecord => ({
    kind: r.kind,
    id: r.id,
    value: JSON.parse(r.value),
    at: r.saved_at
  })
  function records(
    id: string,
    kind?: ChatRecord['kind'],
    on: Database.Database = db
  ): ChatRecord[] {
    return (
      on
        .prepare(
          'SELECT kind,id,value,saved_at FROM records WHERE conversation_id=?' +
            (kind ? ' AND kind=?' : '') +
            ' ORDER BY kind,id'
        )
        .all(id, ...(kind ? [kind] : [])) as RecordRow[]
    ).map(decodeRecord)
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
  function receipts(id: string, on: Database.Database = db): CommandReceipt[] {
    return (
      on
        .prepare(`SELECT ${receiptColumns} FROM receipts WHERE conversation_id=? ORDER BY id`)
        .all(id) as ReceiptRow[]
    ).map(decodeReceipt)
  }
  /** What a migration export carries of a conversation's records: derived ones left out. */
  const exportRecordWhere = "conversation_id=? AND kind NOT IN ('event-blob','timeline')"
  function exportRecords(id: string, on: Database.Database = db): ChatRecord[] {
    return (
      on
        .prepare(`SELECT kind,id,value,saved_at FROM records
      WHERE ${exportRecordWhere} ORDER BY kind,id`)
        .all(id) as RecordRow[]
    ).map(decodeRecord)
  }
  /** Cut header-only candidates before loading a body; one oversized row always fits. */
  function exportThrough<T extends { bytes: number }>(
    headers: Iterable<T>,
    budget: Required<ChatHistoryPageBudget>
  ): { through: T | undefined; more: boolean } {
    let n = 0,
      bytes = 0
    let through: T | undefined
    for (const header of headers) {
      if (n > 0 && (n >= budget.maxEvents || bytes + header.bytes > budget.maxBytes))
        return { through, more: true }
      through = header
      bytes += header.bytes
      n++
    }
    return { through, more: false }
  }
  function exportRecordPage(
    id: string,
    on: Database.Database,
    after?: Pick<ChatRecord, 'kind' | 'id'>
  ) {
    const budget = clampChatHistoryPageBudget()
    const where = exportRecordWhere + (after ? ' AND (kind,id)>(?,?)' : '')
    const params = [id, ...(after ? [after.kind, after.id] : [])]
    const headers = on
      .prepare(`SELECT kind,id,octet_length(value)+octet_length(kind)+octet_length(id) AS bytes FROM records
      WHERE ${where} ORDER BY kind,id LIMIT ?`)
      .iterate(...params, budget.maxEvents + 1) as Iterable<{
      kind: ChatRecord['kind']
      id: string
      bytes: number
    }>
    const { through, more } = exportThrough(headers, budget)
    if (!through) return { records: [], more: false }
    const found = on
      .prepare(`SELECT kind,id,value,saved_at FROM records
      WHERE ${where} AND (kind,id)<=(?,?) ORDER BY kind,id`)
      .all(...params, through.kind, through.id) as RecordRow[]
    return { records: found.map(decodeRecord), more }
  }
  function exportReceiptPage(id: string, on: Database.Database, afterId?: string) {
    const budget = clampChatHistoryPageBudget()
    const where = 'conversation_id=?' + (afterId !== undefined ? ' AND id>?' : '')
    const params = [id, ...(afterId !== undefined ? [afterId] : [])]
    const headers = on
      .prepare(`SELECT id,octet_length(result)+octet_length(id)+octet_length(hash)
        +octet_length(state)+COALESCE(octet_length(method),0) AS bytes FROM receipts
      WHERE ${where} ORDER BY id LIMIT ?`)
      .iterate(...params, budget.maxEvents + 1) as Iterable<{ id: string; bytes: number }>
    const { through, more } = exportThrough(headers, budget)
    if (!through) return { receipts: [], more: false }
    const found = on
      .prepare(`SELECT ${receiptColumns} FROM receipts
      WHERE ${where} AND id<=? ORDER BY id`)
      .all(...params, through.id) as ReceiptRow[]
    return { receipts: found.map(decodeReceipt), more }
  }
  const timelineMetadataFrom = `records r LEFT JOIN timeline_page_metadata m
    ON m.conversation_id=r.conversation_id AND m.page_id=r.id`
  /** Migrate/read only a bounded page of metadata in each process history turn. */
  async function readTimelineMetadata<T extends { page: number }>(
    id: string,
    epoch: number,
    field: 'summary' | 'search_text',
    read: (where: string, params: string[]) => T[]
  ): Promise<T[]> {
    const job = historyReadTurns.job({ yieldFirst: true })
    const budget = clampChatHistoryPageBudget()
    const out: T[] = []
    let after = ''
    for (let done = false; !done; ) {
      const part = await job.step(() =>
        api.transaction(() => {
          const owner = row(id)
          if (!owner || owner.state === 'deleted' || owner.epoch !== epoch)
            throw new Error('Timeline ownership changed')
          const where = `r.conversation_id=? AND r.kind='timeline' AND r.id>? AND r.id GLOB 'page:*'
              AND CAST(substr(r.id,6) AS INTEGER) BETWEEN 0 AND 9007199254740991
              AND r.id='page:' || CAST(CAST(substr(r.id,6) AS INTEGER) AS TEXT)`
          const headers = db
            .prepare(`SELECT r.id,
          CASE WHEN m.page_id IS NULL THEN octet_length(r.value)
            ELSE octet_length(m.${field}) END + octet_length(r.id) AS bytes
          FROM ${timelineMetadataFrom} WHERE ${where} ORDER BY r.id LIMIT ?`)
            .iterate(id, after, budget.maxEvents + 1) as Iterable<{ id: string; bytes: number }>
          const { through, more } = exportThrough(headers, budget)
          if (!through) return { rows: [] as T[], after, done: true }
          const range = where + ' AND r.id<=?'
          const params = [id, after, through.id]
          // Frozen/prepared sources remain readable without acquiring new writes.
          // Their missing metadata is read directly within this same bounded range.
          if (owner.state === 'active')
            db.prepare(`INSERT INTO timeline_page_metadata
            SELECT r.conversation_id,r.id,json_extract(r.value,'$.summary'),json_extract(r.value,'$.searchText')
            FROM ${timelineMetadataFrom} WHERE ${range} AND m.page_id IS NULL`).run(...params)
          return { rows: read(range, params), after: through.id, done: !more }
        })
      )
      out.push(...part.rows)
      after = part.after
      done = part.done
    }
    return out.sort((a, b) => a.page - b.page)
  }
  /** Serialize a conversation's derived operations across scheduled loop turns. */
  const timelineWork = new Map<string, Promise<unknown>>()
  function queueTimeline<T>(id: string, work: () => Promise<T>): Promise<T> {
    const run = (timelineWork.get(id) ?? Promise.resolve()).then(work, work)
    timelineWork.set(id, run)
    const clean = () => {
      if (timelineWork.get(id) === run) timelineWork.delete(id)
    }
    void run.then(clean, clean)
    return run
  }
  async function dropTimeline(id: string, epoch: number, from?: number): Promise<void> {
    const job = historyReadTurns.job({ yieldFirst: true })
    while (
      !(await job.step(() => api.dropTimelineStep(id, epoch, TIMELINE_DROP_STEP_BYTES, from)))
    );
  }
  /** Caller holds an owner-checked transaction and has already invalidated its checkpoint. */
  function putTimeline(
    id: string,
    pages: EncodedTimelineWrite['pages'],
    checkpoint: string | null
  ) {
    const put = db.prepare(`INSERT INTO records VALUES(?,'timeline',?,?,?)
      ON CONFLICT(conversation_id,kind,id) DO UPDATE SET value=excluded.value,saved_at=excluded.saved_at`)
    const metadata = db.prepare(`INSERT INTO timeline_page_metadata VALUES(?,?,?,?)
      ON CONFLICT(conversation_id,page_id) DO UPDATE SET summary=excluded.summary,search_text=excluded.search_text`)
    const at = Date.now()
    for (const page of pages) {
      put.run(id, `page:${page.page}`, page.value, at)
      if (page.summary !== undefined && page.searchText !== undefined)
        metadata.run(id, `page:${page.page}`, page.summary, page.searchText)
    }
    if (checkpoint !== null) put.run(id, 'checkpoint', checkpoint, at)
  }
  /** Owned export cleanup, including partial failures; retried when the store closes. */
  const exportReaders = new Set<() => void>()
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
  /** `put` of {@link extractChatBlobs}: the bytes go to the blob store (canonical base64 only). */
  function putEventBlob(base64: string, mediaType: string): ChatBlobRefBody | null {
    const stored = blobs.putBase64(base64)
    return stored ? { v: 1, sha256: stored.sha256, mediaType, size: stored.size } : null
  }
  /** RAW content → stored form: binary payloads written to the blob store, references in place. */
  function extractEventBlobs<T>(value: T): T {
    return extractChatBlobs(value, putEventBlob).value
  }
  /** STORED form → raw content: every reference replaced by its (hash-verified) bytes. */
  function resolveEventBlobs<T>(value: T): T {
    return resolveChatBlobs(value, (ref) => {
      let bytes: Uint8Array
      try {
        bytes = blobs.readBlob(ref.sha256)
      } catch (cause) {
        throw new EventBlobUnavailableError(ref.sha256, 'missing or corrupt', { cause })
      }
      if (bytes.length !== ref.size)
        throw new EventBlobUnavailableError(ref.sha256, 'size does not match its reference')
      return Buffer.from(bytes).toString('base64')
    })
  }
  /**
   * Pin every reference of STORED `value` to conversation `id`: the bytes must be in
   * the store. A pin's `saved_at` is its newest reference's time, so retention can
   * drop exactly the pins whose every referencing event expired.
   */
  function pinEventBlobs(id: string, value: unknown, at: number): void {
    const seen = new Set<string>()
    for (const ref of chatBlobRefs(value)) {
      if (seen.has(ref.sha256)) continue
      seen.add(ref.sha256)
      if (blobs.sizeOf(ref.sha256) !== ref.size)
        throw new Error('Event blob is missing from the blob store')
      db.prepare(
        `INSERT INTO records VALUES(?,'event-blob',?,?,?) ON CONFLICT(conversation_id,kind,id)
          DO UPDATE SET saved_at=MAX(saved_at,excluded.saved_at)`
      ).run(id, ref.sha256, JSON.stringify({ mediaType: ref.mediaType, size: ref.size }), at)
    }
  }
  /** The ONE insert of an event row: STORED form, pins first (same transaction as the caller's). */
  function insertEvent(
    id: string,
    seq: number,
    at: number,
    event: AgentEvent,
    onConflictKeep = false
  ) {
    pinEventBlobs(id, event, at)
    return db
      .prepare(
        `INSERT INTO events(conversation_id,seq,saved_at,event,blob_form) VALUES(?,?,?,?,${EVENT_BLOB_FORM})` +
          (onConflictKeep ? ' ON CONFLICT(conversation_id,seq) DO NOTHING' : '')
      )
      .run(id, seq, at, JSON.stringify(event))
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
        for (const closeReader of [...exportReaders]) closeReader()
        maintenance.closeSecondaries()
        // Failed native closes retain ownership for a later close retry.
        checkpointer.closeSync()
        const errors: unknown[] = []
        for (const native of new Set([connection.current(), ...swapConnections])) {
          try {
            if (native.open) native.close()
          } catch (error) {
            errors.push(error)
          }
          if (!native.open) swapConnections.delete(native)
        }
        if (errors.length === 1) throw errors[0]
        if (errors.length)
          throw new AggregateError(errors, 'Chat storage close failed', { cause: errors[0] })
        closed = true
      }
    },
    /**
     * A clean stop: marked clean, the WAL checkpointed and truncated off this thread,
     * then closed. Nothing committed is lost. (`close` alone also loses nothing on a
     * process exit; only an OS crash could lose the last second.)
     */
    async shutdown(): Promise<void> {
      if (closed) return
      if (unavailable) {
        api.close()
        return
      }
      for (const closeReader of [...exportReaders]) closeReader()
      if (opts.ownerWorker) {
        // A real FULL commit of the clean mark includes every earlier NORMAL frame.
        db.pragma('synchronous = FULL')
        saveSession(true)
        const active = checkpointer.active
        await checkpointer.close(true)
        if (!active) db.pragma('wal_checkpoint(TRUNCATE)')
        api.close()
        return
      }
      saveSession(true)
      if (checkpointer.active) await checkpointer.close(true).catch(() => undefined)
      else db.pragma('wal_checkpoint(TRUNCATE)')
      api.close()
    },
    /**
     * Committed data is on disk when this resolves: the WAL synced off this thread.
     * Await it before telling the hub something it then relies on (data it handed over
     * and will drop, a durable state change). Never for live output.
     */
    async flush(): Promise<void> {
      if (unavailable) throw unavailable
      if (closed) throw new Error('Chat storage is closed')
      while (resumed) await resumed.promise
      if (unavailable) throw unavailable
      if (opts.ownerWorker) {
        commitStorageFence(db, { resumeNormal: !inline && checkpointer.active })
        return
      }
      if (inline || !checkpointer.active) return // Legacy S5 path, removed by full caller migration.
      await checkpointer.flush()
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
    /** This computer's own fault ledger (origin 'computer'). */
    faults: createSyncFaultLedger(db, { origin: 'computer' }),
    listFaults(): ItemFaultRow[] {
      return db
        .prepare("SELECT * FROM item_faults WHERE origin='computer' ORDER BY last_at DESC")
        .all() as ItemFaultRow[]
    },
    /** Explicit Retry: the next pass runs the item regardless of backoff or quarantine. */
    retryFault(pass: string, itemKey: string): boolean {
      return (
        db
          .prepare(`UPDATE item_faults SET kind='transient', fingerprint=NULL, next_retry_at=0
            WHERE origin='computer' AND pass=? AND item_key=?`)
          .run(pass, itemKey).changes > 0
      )
    },
    deleteFault(pass: string, itemKey: string): boolean {
      return (
        db
          .prepare("DELETE FROM item_faults WHERE origin='computer' AND pass=? AND item_key=?")
          .run(pass, itemKey).changes > 0
      )
    },
    deleteTaskFaults(taskId: string): void {
      db.prepare("DELETE FROM item_faults WHERE origin='computer' AND task_id=?").run(taskId)
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
        const result = insertEvent(id, seq, at, event, true)
        return result.changes ? 'inserted' : 'clash'
      })()
    },
    /** Blob dir of this store (shared by attachments and event blobs). */
    blobs,
    /**
     * RAW event → the form it is stored in: binary payloads (≥ 1 KiB base64) moved
     * to the blob store, references in place. Feed the result to {@link appendAt};
     * apply once (stored form is never extracted again).
     */
    extractEventBlobs: (event: AgentEvent): AgentEvent => extractEventBlobs(event),
    /** Hashes pinned by event blobs of conversations not deleted (kept by GC). */
    eventBlobHashes(): string[] {
      return (
        db
          .prepare(`SELECT DISTINCT r.id FROM records r JOIN conversations c ON c.id=r.conversation_id
          WHERE r.kind='event-blob' AND c.state<>'deleted'`)
          .all() as Array<{ id: string }>
      ).map((r) => r.id)
    },
    /**
     * One bounded chunk of an event blob, ONLY if conversation `id` (not deleted)
     * pins it: a hash of another chat is refused, whoever asks.
     */
    readEventBlob(
      id: string,
      sha256: string,
      offset: number
    ): { mediaType: string; size: number; offset: number; data: string } {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid blob offset')
      const owner = row(id)
      if (!owner || owner.state === 'deleted') throw new Error('Conversation is unavailable')
      const pin =
        /^[a-f0-9]{64}$/.test(sha256) &&
        (db
          .prepare(
            "SELECT value FROM records WHERE conversation_id=? AND kind='event-blob' AND id=?"
          )
          .get(id, sha256) as { value: string } | undefined)
      if (!pin) throw new Error('Blob is not part of this conversation')
      const { mediaType, size } = JSON.parse(pin.value) as { mediaType: string; size: number }
      if (offset > size) throw new Error('Invalid blob offset')
      const bytes = blobs.readRange(sha256, offset, CHAT_BLOB_CHUNK_BYTES)
      if (offset + bytes.length > size || (bytes.length === 0 && offset < size))
        throw new Error('Event blob size integrity failure')
      return { mediaType, size, offset, data: Buffer.from(bytes).toString('base64') }
    },
    /**
     * Backfill (chat-blob-backfill.ts): seq and stored size (record header,
     * `octet_length` — no row loaded) of up to `limit` LEGACY rows (form 0, saved
     * before v13) of `id` after `afterSeq`, in seq order. The backfill reads a body
     * only once it knows the row fits its slice (and could hold a blob at all).
     */
    legacyEventSizes(
      id: string,
      afterSeq: number,
      limit: number
    ): Array<{ seq: number; bytes: number }> {
      return db
        .prepare(
          'SELECT seq,octet_length(event) AS bytes FROM events WHERE conversation_id=? AND seq>? AND blob_form=0 ORDER BY seq LIMIT ?'
        )
        .all(id, afterSeq, limit) as Array<{ seq: number; bytes: number }>
    },
    /** Backfill: legacy row `seq` of `id` as saved (null: gone or no longer legacy). */
    legacyEvent(id: string, seq: number): { seq: number; at: number; event: string } | null {
      return (
        (db
          .prepare(
            'SELECT seq,saved_at AS at,event FROM events WHERE conversation_id=? AND seq=? AND blob_form=0'
          )
          .get(id, seq) as { seq: number; at: number; event: string } | undefined) ?? null
      )
    },
    /**
     * Backfill: legacy row `seq` — only if it is still exactly `original` and still
     * legacy — becomes `stored` (its stored form, whose blobs the caller wrote and
     * verified), with its pins, atomically. The ONE in-place rewrite of an event:
     * representation only, never meaning (the caller proved resolve(stored) =
     * original). False when the row changed, left, or the conversation is not
     * active under `epoch`.
     */
    rewriteLegacyEvent(
      id: string,
      epoch: number,
      seq: number,
      original: string,
      stored: AgentEvent
    ): boolean {
      return api.transaction(() => {
        const owner = row(id)
        if (!owner || owner.state !== 'active' || owner.epoch !== epoch) return false
        const at = (
          db
            .prepare(
              'SELECT saved_at AS at FROM events WHERE conversation_id=? AND seq=? AND blob_form=0 AND event=?'
            )
            .get(id, seq, original) as { at: number } | undefined
        )?.at
        if (at === undefined) return false
        pinEventBlobs(id, stored, at)
        return (
          db
            .prepare(
              `UPDATE events SET event=?,blob_form=${EVENT_BLOB_FORM} WHERE conversation_id=? AND seq=? AND blob_form=0`
            )
            .run(JSON.stringify(stored), id, seq).changes === 1
        )
      })
    },
    /** Pre-encoded bytes only. Large replacements drop old bodies in paced steps first. */
    writeTimeline(id: string, epoch: number, write: EncodedTimelineWrite): Promise<void> {
      return queueTimeline(id, async () => {
        const job = historyReadTurns.job({ yieldFirst: true })
        if (write.dropPagesFrom !== null) {
          const atomic = await job.step(() =>
            api.transaction(() => {
              requireOwner(id, epoch)
              if (write.pages.length > 2000) return false
              const checkpoint = db
                .prepare(
                  "SELECT octet_length(value) AS bytes FROM records WHERE conversation_id=? AND kind='timeline' AND id='checkpoint'"
                )
                .get(id) as { bytes: number } | undefined
              let bytes = (checkpoint?.bytes ?? 0) + Buffer.byteLength(write.checkpoint ?? '')
              if (bytes > TIMELINE_DROP_STEP_BYTES) return false
              for (const page of write.pages) {
                bytes +=
                  Buffer.byteLength(page.value) +
                  Buffer.byteLength(page.summary ?? '') +
                  Buffer.byteLength(page.searchText ?? '')
                if (page.page < write.dropPagesFrom!) {
                  const old = db
                    .prepare(`SELECT octet_length(r.value)
                    +COALESCE(octet_length(m.summary)+octet_length(m.search_text),0) AS bytes
                  FROM ${timelineMetadataFrom} WHERE r.conversation_id=? AND r.kind='timeline' AND r.id=?`)
                    .get(id, `page:${page.page}`) as { bytes: number } | undefined
                  bytes += old?.bytes ?? 0
                }
                if (bytes > TIMELINE_DROP_STEP_BYTES) return false
              }
              const old = db
                .prepare(`SELECT octet_length(r.value)
                +COALESCE(octet_length(m.summary)+octet_length(m.search_text),0) AS bytes
              FROM ${timelineMetadataFrom} WHERE r.conversation_id=? AND r.kind='timeline'
                AND r.id GLOB 'page:*' AND CAST(substr(r.id,6) AS INTEGER)>=? LIMIT 2001`)
                .iterate(id, write.dropPagesFrom) as Iterable<{ bytes: number }>
              let count = 0
              for (const page of old) {
                bytes += page.bytes
                if (++count + write.pages.length > 2000 || bytes > TIMELINE_DROP_STEP_BYTES)
                  return false
              }
              // The entire affected range fits one turn: retain the old all-or-
              // nothing rollback contract. The immediate transaction pins this plan.
              db.prepare(
                "DELETE FROM records WHERE conversation_id=? AND kind='timeline' AND id='checkpoint'"
              ).run(id)
              db.prepare(
                "DELETE FROM records WHERE conversation_id=? AND kind='timeline' AND id GLOB 'page:*' AND CAST(substr(id,6) AS INTEGER)>=?"
              ).run(id, write.dropPagesFrom)
              putTimeline(id, write.pages, write.checkpoint)
              return true
            })
          )
          if (atomic) return
          await dropTimeline(id, epoch, write.dropPagesFrom)
        }
        let next = 0
        for (let done = false; !done; )
          done = await job.step(() =>
            api.transaction(() => {
              requireOwner(id, epoch)
              const pages: EncodedTimelineWrite['pages'] = []
              const oldCheckpoint = db
                .prepare(
                  "SELECT octet_length(value) AS bytes FROM records WHERE conversation_id=? AND kind='timeline' AND id='checkpoint'"
                )
                .get(id) as { bytes: number } | undefined
              let bytes = oldCheckpoint?.bytes ?? 0
              db.prepare(
                "DELETE FROM records WHERE conversation_id=? AND kind='timeline' AND id='checkpoint'"
              ).run(id)
              while (next < write.pages.length && pages.length < 2000) {
                const page = write.pages[next]
                const old = db
                  .prepare(`SELECT octet_length(r.value)
                  +COALESCE(octet_length(m.summary)+octet_length(m.search_text),0) AS bytes
                FROM ${timelineMetadataFrom} WHERE r.conversation_id=? AND r.kind='timeline' AND r.id=?`)
                  .get(id, `page:${page.page}`) as { bytes: number } | undefined
                const size =
                  (old?.bytes ?? 0) +
                  Buffer.byteLength(page.value) +
                  Buffer.byteLength(page.summary ?? '') +
                  Buffer.byteLength(page.searchText ?? '')
                if ((pages.length > 0 || bytes > 0) && bytes + size > TIMELINE_DROP_STEP_BYTES)
                  break
                pages.push(page)
                bytes += size
                next++
                if (bytes >= TIMELINE_DROP_STEP_BYTES) break
              }
              // A large checkpoint gets its own last turn; ordinary last-page and
              // checkpoint writes remain atomic. Intermediate writes invalidate it.
              const last =
                next === write.pages.length &&
                ((pages.length === 0 && !oldCheckpoint) ||
                  bytes + Buffer.byteLength(write.checkpoint ?? '') <= TIMELINE_DROP_STEP_BYTES)
              putTimeline(id, pages, last ? write.checkpoint : null)
              return last
            })
          )
      })
    },
    timelineRecord(id: string, key: string): string | null {
      return (
        (
          db
            .prepare(
              "SELECT value FROM records WHERE conversation_id=? AND kind='timeline' AND id=?"
            )
            .get(id, key) as { value: string } | undefined
        )?.value ?? null
      )
    },
    timelinePageIds(id: string): number[] {
      return (
        db
          .prepare(
            "SELECT id FROM records WHERE conversation_id=? AND kind='timeline' AND id GLOB 'page:*'"
          )
          .all(id) as Array<{ id: string }>
      )
        .map((r) => Number(r.id.slice(5)))
        .filter((page) => Number.isSafeInteger(page) && page >= 0)
        .sort((a, b) => a - b)
    },
    /**
     * One step of dropping a conversation's timeline projection (derived; rebuilt from
     * its events on next open): the checkpoint first — so a drop stopped half way is
     * never restored from — then pages, oldest first, up to `budget` stored bytes (one
     * page always; sizes from record headers, no page loaded). A page can be MBs and
     * every freed byte is zeroed (`secure_delete`): the caller lets the event loop run
     * between steps (`dropTimelineInSteps`). True once nothing of it is left.
     */
    dropTimelineStep(id: string, epoch: number, budget: number, from?: number): boolean {
      return api.transaction(() => {
        requireOwner(id, epoch)
        const checkpoint = db
          .prepare(
            "SELECT octet_length(value) AS bytes FROM records WHERE conversation_id=? AND kind='timeline' AND id='checkpoint'"
          )
          .get(id) as { bytes: number } | undefined
        db.prepare(
          "DELETE FROM records WHERE conversation_id=? AND kind='timeline' AND id='checkpoint'"
        ).run(id)
        const pages = db
          .prepare(
            `SELECT r.id, octet_length(r.value)
                +COALESCE(octet_length(m.summary)+octet_length(m.search_text),0) AS bytes
              FROM ${timelineMetadataFrom} WHERE r.conversation_id=? AND r.kind='timeline'
                AND ${from === undefined ? "r.id<>'checkpoint'" : "r.id GLOB 'page:*' AND CAST(substr(r.id,6) AS INTEGER)>=?"}
              ORDER BY CAST(substr(r.id,6) AS INTEGER),r.id LIMIT 2001`
          )
          .all(id, ...(from === undefined ? [] : [from])) as Array<{ id: string; bytes: number }>
        const remove = db.prepare(
          "DELETE FROM records WHERE conversation_id=? AND kind='timeline' AND id=?"
        )
        let bytes = checkpoint?.bytes ?? 0,
          removed = 0
        for (const p of pages) {
          if (removed >= 2000 || ((removed > 0 || bytes > 0) && bytes + p.bytes > budget)) break
          remove.run(id, p.id)
          bytes += p.bytes
          removed++
        }
        return removed === pages.length
      })
    },
    /**
     * Marker backfill (event-marker-backfill.ts): conversations not yet covered by
     * `event_markers` — rows saved before markers existed — oldest first. Deleted
     * ones are skipped: nothing reads their summaries.
     */
    uncoveredMarkerConversations(): string[] {
      return (
        db
          .prepare(
            `SELECT c.id FROM conversations c WHERE c.state<>'deleted'
              AND NOT EXISTS (SELECT 1 FROM event_marker_coverage v WHERE v.conversation_id=c.id)
              ORDER BY c.rowid`
          )
          .all() as Array<{ id: string }>
      ).map((r) => r.id)
    },
    /**
     * Marker backfill: ONE slice — the markers of `id`'s rows after `afterSeq`, up to
     * the budget (cut from record-header sizes, no body loaded: the first row always
     * fits) — in one transaction. When no row follows the slice the conversation is
     * covered in that same transaction: rows appended later carry markers already
     * (trigger), so nothing can slip between the slice and the coverage.
     */
    backfillEventMarkers(
      id: string,
      afterSeq: number,
      budget: Required<ChatHistoryPageBudget>
    ): { through: number; done: boolean; bytes: number } {
      return api.transaction(() => {
        const bounds = pageBounds(id, afterSeq, Number.MAX_SAFE_INTEGER, budget)
        let bytes = 0
        if (bounds.through !== null) {
          for (const [seq, size] of bounds.sizes) if (seq <= bounds.through) bytes += size
          db.prepare(
            `INSERT OR IGNORE INTO event_markers
              SELECT conversation_id,seq,${markerValues('event')} FROM events
              WHERE conversation_id=? AND seq>? AND seq<=? AND ${isMarker('event')}`
          ).run(id, afterSeq, bounds.through)
        }
        if (!bounds.more)
          db.prepare('INSERT OR IGNORE INTO event_marker_coverage VALUES(?)').run(id)
        return { through: bounds.through ?? afterSeq, done: !bounds.more, bytes }
      })
    },
    /**
     * Timeline pages `from` and later go (a projection whose rows moved writes them
     * again): by id, no page loaded.
     */
    dropTimelinePagesFrom(id: string, epoch: number, from?: number): Promise<void> {
      return queueTimeline(id, () => dropTimeline(id, epoch, from))
    },
    /** Page-ordered indexed summaries, with paced migration of legacy page bodies. */
    timelineSummaries(
      id: string,
      epoch: number
    ): Promise<Array<{ page: number; summary: string }>> {
      return queueTimeline(id, () =>
        readTimelineMetadata(
          id,
          epoch,
          'summary',
          (where, params) =>
            db
              .prepare(`SELECT CAST(substr(r.id,6) AS INTEGER) AS page,
          COALESCE(m.summary,json_extract(r.value,'$.summary')) AS summary
          FROM ${timelineMetadataFrom} WHERE ${where}`)
              .all(...params) as Array<{ page: number; summary: string }>
        )
      )
    },
    /** Stored timeline pages whose (lowercased) search text holds `needle`, ascending. */
    async searchTimelinePages(id: string, epoch: number, needle: string): Promise<number[]> {
      return queueTimeline(id, async () =>
        (
          await readTimelineMetadata(
            id,
            epoch,
            'search_text',
            (where, params) =>
              db
                .prepare(`SELECT CAST(substr(r.id,6) AS INTEGER) AS page FROM ${timelineMetadataFrom}
          WHERE ${where} AND instr(COALESCE(m.search_text,json_extract(r.value,'$.searchText')),?)>0`)
                .all(...params, needle) as Array<{ page: number }>
          )
        ).map((r) => r.page)
      )
    },
    hasTimeline(id: string): boolean {
      return !!db
        .prepare("SELECT 1 FROM records WHERE conversation_id=? AND kind='timeline' LIMIT 1")
        .get(id)
    },
    /** A resumable maintenance pass's checkpoint (`maintenance_cursors`). */
    maintenanceCursor<T>(key: string): T | null {
      const found = db.prepare('SELECT value FROM maintenance_cursors WHERE id=?').get(key) as
        | { value: string }
        | undefined
      return found ? (JSON.parse(found.value) as T) : null
    },
    setMaintenanceCursor(key: string, value: unknown): void {
      db.prepare(
        'INSERT INTO maintenance_cursors VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value'
      ).run(key, JSON.stringify(value))
    },
    maintenanceDone(key: string): boolean {
      return !!db.prepare('SELECT 1 FROM storage_maintenance WHERE id=?').get(key)
    },
    completeMaintenance(key: string): void {
      api.transaction(() => {
        db.prepare('INSERT OR IGNORE INTO storage_maintenance VALUES(?)').run(key)
        db.prepare('DELETE FROM maintenance_cursors WHERE id=? OR id GLOB ?').run(key, `${key}:*`)
      })
    },
    clearHistory(id: string, epoch: number): void {
      db.transaction(() => {
        requireOwner(id, epoch)
        db.prepare('DELETE FROM events WHERE conversation_id=?').run(id)
        db.prepare(
          "DELETE FROM records WHERE conversation_id=? AND kind='settings' AND id='event-sequence-floor'"
        ).run(id)
        db.prepare(
          "DELETE FROM records WHERE conversation_id=? AND kind IN ('timeline','workspace','event-blob')"
        ).run(id)
      })()
    },
    /** Append a RAW event (extracted here); returns it as stored. */
    append(id: string, epoch: number, raw: AgentEvent, at = Date.now()): StoredChatEvent {
      return db.transaction(() => {
        requireOwner(id, epoch)
        const seq = nextSeq(id)
        const event = extractEventBlobs(raw)
        pinAttachments(id, eventAttachmentReferences(event), at)
        insertEvent(id, seq, at, event)
        return { seq, at, event }
      })()
    },
    read,
    readPage,
    pageBounds,
    readMatching,
    tailStart,
    records,
    /** See `store_identity`. */
    storeId: () => {
      if (unavailable) throw unavailable
      return storeId
    },
    nextSeq,
    /** See `task_state_versions`. 0 = nothing written since this table existed. */
    stateVersion(taskId: string): number {
      return (
        (
          db.prepare('SELECT version FROM task_state_versions WHERE task_id=?').get(taskId) as
            | { version: number }
            | undefined
        )?.version ?? 0
      )
    },
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
          (kind IN ('queue','thread','workspace','timeline','pinned-message') OR
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
      input: unknown,
      allowPrepared = false
    ): 'accepted' | 'duplicate' {
      return db.transaction(() => {
        requireOwner(id, epoch, false, allowPrepared)
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
    completeCommand(
      id: string,
      epoch: number,
      operationId: string,
      result: unknown,
      allowPrepared = false
    ): void {
      db.transaction(() => {
        requireOwner(id, epoch, false, allowPrepared)
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
      try {
        return db.transaction(() => {
          const r = requireOwner(id, epoch, true)
          if (r.state !== 'frozen' || r.migration_id !== migrationId)
            throw new Error('Migration must freeze source first')
          const body = {
            version: 1 as const,
            migrationId,
            identity: identity(r),
            // On the wire: RAW content (base64 inline), as every version reads it; the
            // destination stores it out-of-line again. Event-blob pins are derived, and
            // the timeline projection (pages embed rows as strings) is rebuilt from the
            // events where it lands.
            events: read(id, -1).map((e) => ({ ...e, event: resolveEventBlobs(e.event) })),
            records: exportRecords(id),
            receipts: receipts(id)
          }
          return { ...body, hash: digest(body) }
        })()
      } catch (error) {
        api.recordExportBlobFault(id, error)
        throw error
      }
    },
    /**
     * A move's export of conversation `id`, which the caller has frozen for it
     * (`freeze` … this … `unfreeze`, all synchronous): a READ SNAPSHOT of the chat as
     * of now, on its own read-only connection, held until `close()` — the chat is
     * unfrozen again at once (live writes go on), while the export reads it a page
     * at a time (`writeExportTransfer`) and gets exactly what `exportConversation`
     * would have read here. A blob lease keeps every image it references (GC skips
     * while one is held). Open readers are listed (`hasExportReaders`) and closed with
     * the store; a file swap of the store must wait for them to close.
     */
    openExportReader(id: string, epoch: number, migrationId: string): ChatExportReader {
      const conn = new Database(path, { readonly: true, fileMustExist: true })
      const secondary = maintenance.registerSecondary('chat export reader')
      let lease: { release(): void } | undefined
      let renew: ReturnType<typeof setInterval> | undefined
      let open = true
      let disposed = false
      const live = () => {
        if (!open) throw new Error('Export reader closed')
      }
      const close = () => {
        if (disposed) return
        open = false
        if (renew) clearInterval(renew)
        // Retain the secondary and cleanup callback if native close fails: the
        // connection still owns its snapshot. Shutdown can retry physical close.
        conn.close()
        disposed = true
        exportReaders.delete(close)
        try {
          if (!closed) lease?.release()
        } finally {
          secondary.release()
        }
      }
      exportReaders.add(close)
      try {
        conn.pragma('busy_timeout = 5000')
        // The snapshot starts with the transaction's first read.
        conn.exec('BEGIN')
        const r = row(id, conn)
        if (!r) throw new Error('Unknown conversation')
        if (r.epoch !== epoch) throw new Error('Stale ownership epoch')
        if (r.state !== 'frozen' || r.migration_id !== migrationId)
          throw new Error('Migration must freeze source first')
        const leaseId = `export:${migrationId}:${id}:${randomUUID()}`
        lease = api.acquireBlobLease(leaseId, EXPORT_LEASE_MS)
        const reader: ChatExportReader = {
          identity: identity(r),
          migrationId,
          eventCount: (
            conn.prepare('SELECT COUNT(*) AS n FROM events WHERE conversation_id=?').get(id) as {
              n: number
            }
          ).n,
          recordCount: (
            conn
              .prepare(`SELECT COUNT(*) AS n FROM records WHERE ${exportRecordWhere}`)
              .get(id) as { n: number }
          ).n,
          receiptCount: (
            conn.prepare('SELECT COUNT(*) AS n FROM receipts WHERE conversation_id=?').get(id) as {
              n: number
            }
          ).n,
          eventPage(afterSeq) {
            live()
            const bounds = pageBounds(
              id,
              afterSeq,
              Number.MAX_SAFE_INTEGER,
              clampChatHistoryPageBudget(),
              conn
            )
            if (bounds.through === null) return { events: [], more: false }
            return { events: read(id, afterSeq, bounds.through + 1, conn), more: bounds.more }
          },
          recordPage(after) {
            live()
            return exportRecordPage(id, conn, after)
          },
          receiptPage(afterId) {
            live()
            return exportReceiptPage(id, conn, afterId)
          },
          resolve(event) {
            live()
            return resolveEventBlobs(event)
          },
          close
        }
        // Renew only after construction succeeds; the cleanup callback already
        // owns partial failures and stays registered until physical close.
        renew = setInterval(() => {
          if (open && !closed) api.acquireBlobLease(leaseId, EXPORT_LEASE_MS)
        }, EXPORT_LEASE_MS / 3)
        renew.unref?.()
        return reader
      } catch (error) {
        try {
          close()
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'Export reader initialization cleanup failed',
            { cause: error }
          )
        }
        throw error
      }
    },
    /** An export's read snapshot is open (`openExportReader`): a store file swap waits. */
    hasExportReaders(): boolean {
      return exportReaders.size > 0
    },
    /**
     * An export failed on an image it could not read: the move fails (never a
     * silently degraded copy); a structural fault names the chat and the blob, no
     * content. Other errors: nothing recorded.
     */
    recordExportBlobFault(id: string, error: unknown): void {
      if (!(error instanceof EventBlobUnavailableError)) return
      api.faults.record(
        {
          pass: 'computer.chat-event-blob',
          itemKey: `${id}:${error.sha256}`,
          taskId: row(id)?.task_id ?? null,
          kind: 'structural',
          fingerprint: error.sha256,
          error
        },
        Date.now()
      )
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
          // A task's move to this hub again: the copy this store kept from the task's
          // earlier stay is older (its epoch is lower than the incoming one) — replaced.
          // Only a move's own export may ask for it, and only for the same chat.
          if (
            !(
              h.move &&
              previous.state === 'active' &&
              previous.task_id === h.identity.taskId &&
              previous.tab_id === h.identity.tabId &&
              previous.mode === h.identity.mode &&
              previous.epoch < h.identity.epoch + 1
            )
          )
            throw new Error('Transfer would overwrite existing ownership')
          for (const table of ['events', 'records', 'receipts', 'queue_message_identities'])
            db.prepare(`DELETE FROM ${table} WHERE conversation_id=?`).run(h.identity.id)
          db.prepare('DELETE FROM conversations WHERE id=?').run(h.identity.id)
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
            insertEvent(i.id, e.seq, e.at, extractEventBlobs(e.event))
            lastSeq = e.seq
            events++
          } else if (entry.kind === 'record') {
            const r = entry.value as ChatRecord
            if (
              !(CHAT_RECORD_KINDS as readonly string[]).includes(r.kind) ||
              typeof r.id !== 'string' ||
              !Number.isSafeInteger(r.at)
            )
              throw new Error('Transfer record integrity mismatch')
            // Pins are this store's own (made by the event inserts above); never imported.
            // Timeline pages are derived (rows embedded as strings, possibly raw from an
            // older source): rebuilt from the events on open, like after retention.
            if (r.kind === 'event-blob' || r.kind === 'timeline') {
              records++
              continue
            }
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
        for (const e of snapshot.events) insertEvent(i.id, e.seq, e.at, extractEventBlobs(e.event))
        for (const r of snapshot.records) {
          if (r.kind === 'event-blob' || r.kind === 'timeline') continue
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
    /** Every task's lifecycle this database holds (the hub's lifecycle inventory). */
    taskLifecycles(): Array<{
      taskId: string
      state: 'active' | 'paused' | 'deleted'
      revision: number
    }> {
      return db
        .prepare('SELECT task_id AS taskId,state,revision FROM task_lifecycle ORDER BY task_id')
        .all() as Array<{
        taskId: string
        state: 'active' | 'paused' | 'deleted'
        revision: number
      }>
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
    /**
     * Hygiene after deletions: a checkpoint off this thread, soon. (A TRUNCATE here
     * fsyncs on this thread, and one from another connection would block this one's
     * writes.) The WAL is reset by a later write and capped by `journal_size_limit`.
     */
    checkpoint(): void {
      if (inline || !checkpointer.active) return
      void checkpointer.checkpoint().catch(() => undefined)
    }
  }
  // ── the off-thread checkpointer (S5) ─────────────────────────────────────
  /** The checkpointer failed: this connection makes its own commits durable again. */
  let inline = !!opts.ownerWorker
  /** Set while it is paused (a swap): `flush` waits for the resume. */
  let resumed: { promise: Promise<void>; resolve(): void } | null = null
  const checkpointer = (opts.ownerWorker?.createCheckpointer ?? attachCheckpointer)(path, {
    intervalMs: opts.checkpointIntervalMs,
    onRecovered: () => {
      if (closed || unavailable || !opts.ownerWorker) return
      try {
        commitStorageFence(db, { resumeNormal: true })
        inline = false
      } catch (error) {
        inline = true
        console.error('[chat-storage] recovered checkpointer fence failed:', error)
      }
    },
    onFailure: (message) => {
      if (closed || unavailable || (inline && !opts.ownerWorker)) return
      inline = true
      if (opts.ownerWorker) {
        try {
          commitStorageFence(db)
        } catch (error) {
          console.error('[chat-storage] durability fence failed:', error)
        }
        return
      }
      db.pragma('synchronous = FULL')
      db.pragma('wal_autocheckpoint = 1000')
      console.error(`[chat-storage] checkpointer unavailable (${message}); committing with FULL`)
    }
  })
  void checkpointer.open()
  /**
   * Connection lifecycle for storage maintenance (compaction): the live file's size,
   * other connections on it, and the swap that replaces it. See DOMAIN.md.
   */
  const secondaries = new Map<symbol, { label: string; close?(): void }>()
  let connectionEpoch = 0
  const maintenance = {
    connectionEpoch: () => connectionEpoch,
    /** Owner admission is already closed; let accepted fences drain before native close. */
    releasePauseForClose() {
      if (!opts.ownerWorker) throw new Error('Only an owner worker may release a shutdown pause')
      const waiting = resumed
      resumed = null
      waiting?.resolve()
    },
    /** Before a swap: the checkpointer syncs, checkpoints and closes its connection. */
    async pauseCheckpointer(): Promise<void> {
      if (!opts.ownerWorker && (inline || !checkpointer.active)) return
      if (opts.ownerWorker) {
        inline = true
        db.pragma('synchronous = FULL')
      }
      if (!resumed) {
        let resolve: () => void = () => undefined
        const promise = new Promise<void>((r) => {
          resolve = r
        })
        resumed = { promise, resolve }
      }
      if (checkpointer.active) await checkpointer.checkpoint().catch(() => undefined)
      await checkpointer.close(false)
    },
    /** After a swap (or a refused one): open again on the live file. */
    resumeCheckpointer(): void {
      if (closed) return
      const waiting = resumed
      resumed = null
      if (!unavailable && (opts.ownerWorker || !inline)) void checkpointer.open()
      waiting?.resolve()
    },
    /** A checkpoint now, off this thread (complete unless a reader holds old frames). */
    async checkpointNow(): Promise<CheckpointResult | null> {
      if (inline || !checkpointer.active) return null
      return checkpointer.checkpoint()
    },
    /** Page-level size of the live file: O(1) pragmas and a stat. */
    fileStats(): ChatStoreFileStats {
      const pragma = (name: string) => db.pragma(name, { simple: true }) as number
      const size = (file: string) => (existsSync(file) ? statSync(file).size : 0)
      return {
        pageSize: pragma('page_size'),
        pageCount: pragma('page_count'),
        freePages: pragma('freelist_count'),
        autoVacuum: pragma('auto_vacuum') as 0 | 1 | 2,
        fileBytes: size(path),
        walBytes: size(`${path}-wal`)
      }
    },
    /** A fresh path for a compacted copy (removed at boot if a run never swaps it in). */
    tempPath(): string {
      return join(dir, `${COMPACT_PREFIX}${process.pid}-${randomUUID()}`)
    },
    /**
     * Every OTHER connection on the live file (a read-only export reader, a compaction
     * reader) registers for its lifetime: the swap never runs while one is open.
     */
    registerSecondary(label: string, close?: () => void): { release(): void } {
      const token = Symbol(label)
      secondaries.set(token, { label, close })
      return { release: () => void secondaries.delete(token) }
    },
    /** Retry retained native closes. Async copy helpers retain their own exit lease. */
    closeSecondaries(label?: string): void {
      const errors: unknown[] = []
      for (const entry of [...secondaries.values()]) {
        if (label !== undefined && entry.label !== label) continue
        try {
          entry.close?.()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length)
        throw new AggregateError(errors, 'Secondary connection close failed', { cause: errors[0] })
    },
    secondaryConnections(): string[] {
      return [...secondaries.values()].map((entry) => entry.label)
    },
    /**
     * Replace the live file with `compacted` (a finished, settled copy of THIS store in
     * its directory), synchronously: no write can interleave, writes that arrive wait on
     * the event loop and land in the new file. Order: verify the copy → close the live
     * connection (refused while busy) → no WAL may survive the close (an unregistered
     * connection would leave one: applied to the new file it would corrupt it) → link
     * the live file to `.pre-compact` → rename the copy over it → reopen; any failure
     * after the close restores old or selects the verified new file; if neither can
     * open/replay safely, this store fails closed. Boot recovery: `recoverInterruptedSwap`.
     * `phase`: test hook at each step (crash injection).
     */
    swapIn(
      compacted: string,
      opts: { phase?(step: ChatSwapPhase): void } = {}
    ): { holdMs: number } {
      if (unavailable) throw unavailable
      if (closed) throw new Error('Chat storage is closed')
      const started = performance.now()
      if (dirname(compacted) !== dir || !basename(compacted).startsWith(COMPACT_PREFIX))
        throw new Error('Swap source must be a compaction file of this store')
      if (swapConnections.size)
        throw new ChatStorageSwapRefused(
          'a retained native connection still needs physical close',
          true
        )
      if (secondaries.size)
        throw new ChatStorageSwapRefused(
          `a secondary connection is open (${maintenance.secondaryConnections().join(', ')})`,
          true
        )
      if (checkpointer.active)
        throw new ChatStorageSwapRefused('the checkpointer is running (pause it first)', true)
      const discard = (reason: string): never => {
        rmCompaction(compacted)
        throw new ChatStorageSwapRefused(reason, false)
      }
      const version = db.pragma('user_version', { simple: true }) as number
      let candidate: ReturnType<typeof describeConnection>
      try {
        candidate = describeStoreFile(compacted, swapConnections)
      } catch (cause) {
        throw new ChatStorageSwapError(cause, [cause], {
          usable: true,
          selectedFile: path,
          retainedConnections: swapConnections.size
        })
      }
      if (candidate.storeId !== storeId) discard('the compacted copy has another store identity')
      if (candidate.version !== version) discard('the compacted copy has another schema version')
      if (existsSync(`${compacted}-journal`) || existsSync(`${compacted}-wal`))
        discard('the compacted copy is not settled')
      opts.phase?.('verified')
      const old = connection.current()
      const pre = join(dir, PRE_COMPACT)
      let linked = false
      let renamed = false
      let selected = false
      const select = () => {
        // fileMustExist prevents an IO/recovery failure from manufacturing an empty store.
        const next = openChatConnection(path, {
          fileMustExist: true,
          opened: (native) => swapConnections.add(native)
        })
        const opened = describeConnection(next)
        if (opened.storeId !== storeId || opened.version !== version)
          throw new Error('the swapped-in file does not match this store')
        // replace replays state before publishing. Until it succeeds, next is ours.
        connection.replace(next)
        swapConnections.delete(next)
        connectionEpoch++
        selected = true
      }
      try {
        try {
          old.close()
        } catch (error) {
          // SQLite BUSY leaves this exact connection usable. A close that really
          // closed before throwing must instead enter recovery and change epoch.
          if (!old.open) throw error
          throw new ChatStorageSwapRefused(
            `the live connection is busy (${error instanceof Error ? error.message : String(error)})`,
            true,
            { cause: error }
          )
        }
        opts.phase?.('closed')
        if (existsSync(`${path}-wal`))
          throw new ChatStorageSwapRefused(
            'the live WAL is still in use by an unregistered connection',
            false
          )
        rmSync(`${path}-shm`, { force: true })
        rmSync(pre, { force: true })
        linkSync(path, pre)
        linked = true
        opts.phase?.('linked')
        renameSync(compacted, path)
        renamed = true
        syncDirSync(dir)
        opts.phase?.('renamed')
        select()
        // Not synced: a resurrected link is harmless and removed at boot.
        unlinkSync(pre)
      } catch (cause) {
        if (old.open) throw cause // native busy close: never disturb the live facade
        const errors: unknown[] = [cause]
        const attempt = (work: () => void) => {
          try {
            work()
          } catch (error) {
            errors.push(error)
          }
        }
        // Never rename/reopen under an unused connection whose close failed.
        for (const native of swapConnections) {
          attempt(() => {
            if (native.open) native.close()
          })
          if (!native.open) swapConnections.delete(native)
        }
        if (!selected && !swapConnections.size) {
          if (renamed && linked) {
            attempt(() => renameSync(pre, path))
            attempt(() => syncDirSync(dir))
          }
          // A refused rollback rename can leave the verified new file at path.
          // Select only after checking identity/version and replaying all state.
          attempt(select)
          // Initialization/replay can itself fail after opening another connection.
          for (const native of swapConnections) {
            attempt(() => {
              if (native.open) native.close()
            })
            if (!native.open) swapConnections.delete(native)
          }
        }
        if (selected) {
          if (linked) attempt(() => rmSync(pre, { force: true }))
          attempt(() => rmCompaction(compacted))
        }
        const failure = new ChatStorageSwapError(cause, errors, {
          usable: selected,
          selectedFile: selected ? path : null,
          retainedConnections: swapConnections.size
        })
        if (!selected) {
          unavailable = failure
          // Invalidate cached statements/tokens even when no usable replacement won.
          connectionEpoch++
          connection.invalidate(failure)
        }
        throw failure
      }
      return { holdMs: performance.now() - started }
    }
  }
  return Object.assign(api, { maintenance })
}

/** The store's last run (`maintenance_cursors` 'store-session'). */
interface StoreSession {
  /** Stopped with `shutdown` (everything checkpointed). */
  clean: boolean
  /** When the machine had booted (epoch ms) during that run. */
  bootedAt: number
}

/** Name prefix of compacted copies in a store dir (`<prefix><pid>-<uuid>`). */
const COMPACT_PREFIX = 'chat.sqlite.compact-'
/** The live file's second name while a swap renames over it. */
const PRE_COMPACT = 'chat.sqlite.pre-compact'
/** WAL file kept at most this size after a checkpoint (it never shrank: 612 MB seen). */
export const CHAT_WAL_SIZE_LIMIT = 64 * 1024 * 1024

export interface ChatStoreFileStats {
  pageSize: number
  pageCount: number
  freePages: number
  /** 0 none, 1 full, 2 incremental. */
  autoVacuum: 0 | 1 | 2
  fileBytes: number
  walBytes: number
}
export type ChatSwapPhase = 'verified' | 'closed' | 'linked' | 'renamed'

/** A swap was not done. `transient`: the copy is kept; try again later. */
export class ChatStorageSwapRefused extends Error {
  constructor(
    reason: string,
    readonly transient: boolean,
    options?: ErrorOptions
  ) {
    super(`Chat storage swap refused: ${reason}`, options)
    this.name = 'ChatStorageSwapRefused'
  }
}

/** A post-close failure, with truthful facade selection and all recovery/cleanup causes. */
export class ChatStorageSwapError extends AggregateError {
  readonly usable: boolean
  readonly selectedFile: string | null
  readonly retainedConnections: number
  constructor(
    cause: unknown,
    errors: unknown[],
    state: {
      usable: boolean
      selectedFile: string | null
      retainedConnections: number
    }
  ) {
    super(
      errors,
      `Chat storage swap failed (${state.usable ? 'recovered' : 'store unavailable'}): ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    )
    this.name = 'ChatStorageSwapError'
    this.usable = state.usable
    this.selectedFile = state.selectedFile
    this.retainedConnections = state.retainedConnections
  }
}

/** The store's one connection: the same settings at boot and after a swap. */
export function openChatConnection(
  path: string,
  opts: { fileMustExist?: boolean; opened?(db: Database.Database): void } = {}
): Database.Database {
  const db = new Database(path, { fileMustExist: opts.fileMustExist ?? false })
  opts.opened?.(db)
  try {
    chmodSync(path, 0o600)
    db.pragma('journal_mode = WAL')
    // NORMAL: a commit appends to the WAL without an fsync; the off-thread checkpointer
    // syncs it within a second (`checkpointer.ts`). No checkpoint on this connection.
    db.pragma('synchronous = NORMAL')
    db.pragma('wal_autocheckpoint = 0')
    db.pragma('foreign_keys = ON')
    db.pragma('busy_timeout = 5000')
    db.pragma('secure_delete = ON')
    db.pragma(`journal_size_limit = ${CHAT_WAL_SIZE_LIMIT}`)
  } catch (error) {
    try {
      db.close()
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Chat connection initialization cleanup failed', {
        cause: error
      })
    }
    throw error
  }
  return db
}

function describeConnection(db: Database.Database) {
  const row = db.prepare('SELECT store_id FROM store_identity WHERE id=1').get() as
    | { store_id: string }
    | undefined
  return { storeId: row?.store_id, version: db.pragma('user_version', { simple: true }) as number }
}
/** Read-write on purpose: a read-only connection to a WAL file leaves its -wal/-shm behind. */
function describeStoreFile(file: string, owned: Set<Database.Database>) {
  const native = new Database(file, { fileMustExist: true })
  owned.add(native)
  let description: ReturnType<typeof describeConnection> | undefined
  const errors: unknown[] = []
  try {
    description = describeConnection(native)
  } catch (error) {
    errors.push(error)
  }
  try {
    native.close()
  } catch (error) {
    errors.push(error)
  }
  if (!native.open) owned.delete(native)
  if (errors.length === 1) throw errors[0]
  if (errors.length)
    throw new AggregateError(errors, 'Compaction file verification failed', { cause: errors[0] })
  return description!
}
function rmCompaction(file: string) {
  const errors: unknown[] = []
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try {
      rmSync(`${file}${suffix}`, { force: true })
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length)
    throw new AggregateError(errors, 'Compaction file cleanup failed', { cause: errors[0] })
}
function syncDirSync(dir: string) {
  if (process.platform === 'win32') return
  const fd = openSync(dir, 'r')
  const errors: unknown[] = []
  try {
    fsyncSync(fd)
  } catch (error) {
    errors.push(error)
  }
  try {
    closeSync(fd)
  } catch (error) {
    errors.push(error)
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length)
    throw new AggregateError(errors, 'Compaction directory sync failed', { cause: errors[0] })
}
/**
 * Before opening: finish what an interrupted swap left. A compacted copy never swapped
 * in is garbage; `.pre-compact` is the old file's second name (the live name holds
 * either the old file or the verified copy, both valid) — unless a kill left only it.
 */
function recoverInterruptedSwap(dir: string, path: string) {
  const pre = join(dir, PRE_COMPACT)
  if (!existsSync(path) && existsSync(pre)) {
    renameSync(pre, path)
    syncDirSync(dir)
  }
  const failures: unknown[] = []
  for (const name of readdirSync(dir)) {
    try {
      if (name.startsWith(COMPACT_PREFIX) || name === PRE_COMPACT)
        rmSync(join(dir, name), { force: true })
    } catch (error) {
      failures.push(error)
    }
  }
  // Attempt every independent cleanup, but never open with stale content left behind.
  if (failures.length)
    throw new AggregateError(failures, 'Cannot remove interrupted chat compaction files')
}
export type ChatStorage = ReturnType<typeof openChatStorage>
