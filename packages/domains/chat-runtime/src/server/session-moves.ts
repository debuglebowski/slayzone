/**
 * A task's agent sessions leaving this computer for another hub (cross-hub move,
 * slice 4a): what the SOURCE computer hands out, and the one `data.import` kind the
 * TARGET takes the session ledger with. The bytes travel through the app (it is
 * authorised on both hubs); this module only produces and reads them.
 *
 *  - `exportTask`: each of the task's chats is frozen, read whole, encoded as the
 *    chat-migration transfer (same NDJSON, same sha-256) and unfrozen again — the
 *    copy is a file, so the freeze lasts one read and the source chat is untouched
 *    (it stays usable, and the task can move back). Plus the task's session ledger
 *    (`ledger`): its sessions, their provenance, resumability proofs, resets,
 *    deletions, pre-ledger history and chat settings / session ids per mode.
 *    Repeatable: a retried export of the same move answers what the first did.
 *  - `read`: one chunk of one chat's transfer file, base64.
 *  - `discard`: the export's files go (once the target confirmed, or on cancel).
 *  - `sessionLedgerMoveImport` (`session-ledger-move`): on the target, the task's
 *    ledger BECOMES the bundle's — replacing what an earlier stay of the task left
 *    here (the incoming rows are newer by construction). Path-bound rows
 *    (`agent_sessions.cwd`, worktree paths, turn snapshots) do not travel.
 *
 * The chats themselves go in through the existing transfer machinery on the target
 * (`transfer.begin/chunk/finish`, `migration.verify`, `attachment.put`,
 * `migration.activate`); a move's header carries `move: true`, so a transfer may
 * replace the older copy of the same chat.
 *
 * @module chat-runtime/server/session-moves
 */
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { ChatTransferManifest } from '../shared'
import type { DataImportKind } from './task-data'
import type { ChatStorage } from './storage'
import { encodeTransfer } from './transfers'

const id = z.string().min(1).max(500)
const ts = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const text = z.string().max(1_000_000)

const agentSessionRow = z.object({
  id,
  mode: id,
  tabId: id.nullable(),
  conversationId: id.nullable(),
  origin: id,
  status: z.enum(['pooled', 'bound', 'dead']),
  pendingMeta: z.string().max(10_000).nullable(),
  createdAt: ts,
  boundAt: ts.nullable(),
  endedAt: ts.nullable()
})
const taskConversationRow = z.object({
  id,
  mode: id,
  tabId: id.nullable(),
  conversationId: id.nullable(),
  origin: id,
  pendingMeta: z.string().max(10_000).nullable(),
  createdAt: ts
})
const sessionResetRow = z.object({
  id,
  mode: id,
  tabId: id.nullable(),
  exceptChat: z.number().int().min(0).max(1),
  createdAt: ts
})
const sessionDeletionRow = z.object({ id, mode: id, conversationId: id, createdAt: ts })
const legacyHistoryRow = z.object({ mode: id, ids: z.array(id).max(10_000) })
const providerConfigRow = z.object({ mode: id, revision: ts, value: text })
const sessionTurnRow = z.object({ conversationId: id, firstTurnAt: ts })

/** A task's session ledger on one computer, without what is bound to this computer's paths. */
export const sessionLedgerBundleSchema = z.object({
  agentSessions: z.array(agentSessionRow).max(100_000),
  taskConversations: z.array(taskConversationRow).max(100_000),
  sessionTurns: z.array(sessionTurnRow).max(100_000),
  sessionResets: z.array(sessionResetRow).max(100_000),
  sessionDeletions: z.array(sessionDeletionRow).max(100_000),
  legacyHistory: z.array(legacyHistoryRow).max(100),
  providerConfigs: z.array(providerConfigRow).max(100)
})
export type SessionLedgerBundle = z.infer<typeof sessionLedgerBundleSchema>

export interface SessionMoveExport {
  /** One transfer per chat, in the order the target must take them. */
  transfers: ChatTransferManifest[]
  ledger: SessionLedgerBundle
}

/** Storage-only owners of artifacts: moved by the artifact copy, not here. */
const isArtifactStore = (tabId: string) => tabId.startsWith('artifact-store:')

export function createSessionMoves(store: ChatStorage) {
  const root = join(store.dir, 'session-moves')
  const dirOf = (moveId: string) => {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(moveId)) throw new Error('Invalid move id')
    return join(root, moveId)
  }
  const fileOf = (moveId: string, conversationId: string) =>
    join(dirOf(moveId), `${createHash('sha256').update(conversationId).digest('hex')}.data`)

  function readLedger(taskId: string): SessionLedgerBundle {
    return store.compose((db) => {
      const rows = <T>(sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as T[]
      const conversationIds = new Set<string>()
      const agentSessions = rows<Record<string, unknown>>(
        `SELECT id, mode, tab_id, conversation_id, origin, status, pending_meta, created_at,
                bound_at, ended_at FROM agent_sessions WHERE task_id = ? ORDER BY created_at, id`,
        taskId
      ).map((r) => {
        if (r.conversation_id) conversationIds.add(r.conversation_id as string)
        return {
          id: r.id,
          mode: r.mode,
          tabId: r.tab_id,
          conversationId: r.conversation_id,
          origin: r.origin,
          status: r.status,
          pendingMeta: r.pending_meta,
          createdAt: r.created_at,
          boundAt: r.bound_at,
          endedAt: r.ended_at
        }
      })
      const taskConversations = rows<Record<string, unknown>>(
        `SELECT id, mode, tab_id, conversation_id, origin, pending_meta, created_at
           FROM task_conversations WHERE task_id = ? ORDER BY created_at, id`,
        taskId
      ).map((r) => {
        if (r.conversation_id) conversationIds.add(r.conversation_id as string)
        return {
          id: r.id,
          mode: r.mode,
          tabId: r.tab_id,
          conversationId: r.conversation_id,
          origin: r.origin,
          pendingMeta: r.pending_meta,
          createdAt: r.created_at
        }
      })
      const sessionTurns = rows<{ conversation_id: string; first_turn_at: number }>(
        'SELECT conversation_id, first_turn_at FROM session_turns WHERE conversation_id IN (SELECT value FROM json_each(?))',
        JSON.stringify([...conversationIds])
      ).map((r) => ({ conversationId: r.conversation_id, firstTurnAt: r.first_turn_at }))
      const sessionResets = rows<Record<string, unknown>>(
        'SELECT id, mode, tab_id, except_chat, created_at FROM session_resets WHERE task_id = ? ORDER BY created_at, id',
        taskId
      ).map((r) => ({
        id: r.id,
        mode: r.mode,
        tabId: r.tab_id,
        exceptChat: r.except_chat,
        createdAt: r.created_at
      }))
      const sessionDeletions = rows<Record<string, unknown>>(
        'SELECT id, mode, conversation_id, created_at FROM session_deletions WHERE task_id = ? ORDER BY created_at, id',
        taskId
      ).map((r) => ({
        id: r.id,
        mode: r.mode,
        conversationId: r.conversation_id,
        createdAt: r.created_at
      }))
      const legacyHistory = rows<{ mode: string; ids: string }>(
        'SELECT mode, ids FROM legacy_conversation_history WHERE task_id = ? ORDER BY mode',
        taskId
      ).map((r) => ({ mode: r.mode, ids: JSON.parse(r.ids) as string[] }))
      const providerConfigs = rows<{ mode: string; revision: number; value: string }>(
        'SELECT mode, revision, value FROM provider_configs WHERE task_id = ? ORDER BY mode',
        taskId
      )
      return sessionLedgerBundleSchema.parse({
        agentSessions,
        taskConversations,
        sessionTurns,
        sessionResets,
        sessionDeletions,
        legacyHistory,
        providerConfigs
      })
    })
  }

  return {
    /**
     * Freeze → read → encode → unfreeze each of the task's chats; the ledger beside
     * them. The files and the answer persist under the move's id: a retry (the app
     * lost the answer) is answered from them, never from chats that changed since.
     */
    exportTask(moveId: string, taskId: string): SessionMoveExport {
      const dir = dirOf(moveId)
      const manifestPath = join(dir, 'manifest.json')
      const taken = (() => {
        try {
          return JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, SessionMoveExport>
        } catch {
          return {} as Record<string, SessionMoveExport>
        }
      })()
      if (taken[taskId]) return taken[taskId]
      if (store.taskLifecycle(taskId).state === 'deleted')
        throw new Error('Task chat history was deleted')
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const migrationId = `move:${moveId}`
      const transfers: ChatTransferManifest[] = []
      for (const owner of store.listForTask(taskId)) {
        if (owner.state !== 'active' || isArtifactStore(owner.identity.tabId)) continue
        const { id: conversationId, epoch } = owner.identity
        store.freeze(conversationId, epoch, migrationId)
        let encoded: ReturnType<typeof encodeTransfer>
        try {
          encoded = encodeTransfer(store.exportConversation(conversationId, epoch, migrationId), {
            move: true
          })
        } finally {
          store.unfreeze(conversationId, epoch, migrationId)
        }
        const path = fileOf(moveId, conversationId)
        writeFileSync(`${path}.tmp`, encoded.bytes, { mode: 0o600 })
        renameSync(`${path}.tmp`, path)
        transfers.push(encoded.manifest)
      }
      const exported: SessionMoveExport = { transfers, ledger: readLedger(taskId) }
      writeFileSync(manifestPath, JSON.stringify({ ...taken, [taskId]: exported }), {
        mode: 0o600
      })
      return exported
    },

    /** Bytes `[offset, offset + length)` of a chat's transfer, base64 (empty past the end). */
    read(moveId: string, conversationId: string, offset: number, length: number): string {
      const path = fileOf(moveId, conversationId)
      if (!existsSync(path)) throw new Error('Unknown session export')
      const size = statSync(path).size
      if (offset >= size) return ''
      const buffer = Buffer.allocUnsafe(Math.min(length, size - offset))
      const fd = openSync(path, 'r')
      try {
        let read = 0
        while (read < buffer.length) {
          const n = readSync(fd, buffer, read, buffer.length - read, offset + read)
          if (n === 0) break
          read += n
        }
        return buffer.subarray(0, read).toString('base64')
      } finally {
        closeSync(fd)
      }
    },

    /** Forget a move's export (its files). Idempotent. */
    discard(moveId: string): void {
      rmSync(dirOf(moveId), { recursive: true, force: true })
    }
  }
}

export type SessionMoves = ReturnType<typeof createSessionMoves>

/** `session-ledger-move` — the task's ledger here becomes the bundle's (see module doc). */
export const sessionLedgerMoveImport: DataImportKind<SessionLedgerBundle> = {
  value: sessionLedgerBundleSchema,
  apply(storage, item) {
    const b = item.value
    storage.compose((db) => {
      const old = db
        .prepare(
          `SELECT conversation_id AS c FROM agent_sessions WHERE task_id = ? AND conversation_id IS NOT NULL
           UNION SELECT conversation_id FROM task_conversations WHERE task_id = ? AND conversation_id IS NOT NULL`
        )
        .all(item.taskId, item.taskId) as Array<{ c: string }>
      const oldRevisions = new Map(
        (
          db
            .prepare('SELECT mode, revision FROM provider_configs WHERE task_id = ?')
            .all(item.taskId) as Array<{ mode: string; revision: number }>
        ).map((r) => [r.mode, r.revision])
      )
      db.prepare(
        'DELETE FROM session_turns WHERE conversation_id IN (SELECT value FROM json_each(?))'
      ).run(JSON.stringify(old.map((r) => r.c)))
      for (const table of [
        'agent_sessions',
        'task_conversations',
        'session_resets',
        'session_deletions',
        'legacy_conversation_history',
        'provider_configs',
        'provider_config_seeds'
      ])
        db.prepare(`DELETE FROM ${table} WHERE task_id = ?`).run(item.taskId)
      const addSession = db.prepare(
        `INSERT INTO agent_sessions
           (id, mode, cwd, task_id, tab_id, conversation_id, origin, status, pending_meta, created_at, bound_at, ended_at)
         VALUES (?,?,NULL,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
           mode=excluded.mode, cwd=NULL, task_id=excluded.task_id, tab_id=excluded.tab_id,
           conversation_id=excluded.conversation_id, origin=excluded.origin, status=excluded.status,
           pending_meta=excluded.pending_meta, created_at=excluded.created_at,
           bound_at=excluded.bound_at, ended_at=excluded.ended_at`
      )
      for (const r of b.agentSessions)
        addSession.run(
          r.id,
          r.mode,
          item.taskId,
          r.tabId,
          r.conversationId,
          r.origin,
          r.status,
          r.pendingMeta,
          r.createdAt,
          r.boundAt,
          r.endedAt
        )
      for (const r of b.taskConversations)
        db.prepare(
          `INSERT OR REPLACE INTO task_conversations
             (id, task_id, mode, tab_id, conversation_id, origin, pending_meta, created_at)
           VALUES (?,?,?,?,?,?,?,?)`
        ).run(
          r.id,
          item.taskId,
          r.mode,
          r.tabId,
          r.conversationId,
          r.origin,
          r.pendingMeta,
          r.createdAt
        )
      for (const r of b.sessionTurns)
        db.prepare(
          'INSERT OR REPLACE INTO session_turns(conversation_id, first_turn_at) VALUES(?,?)'
        ).run(r.conversationId, r.firstTurnAt)
      for (const r of b.sessionResets)
        db.prepare(
          `INSERT OR REPLACE INTO session_resets (id, task_id, mode, tab_id, except_chat, created_at)
           VALUES (?,?,?,?,?,?)`
        ).run(r.id, item.taskId, r.mode, r.tabId, r.exceptChat, r.createdAt)
      for (const r of b.sessionDeletions)
        db.prepare(
          `INSERT OR REPLACE INTO session_deletions (id, task_id, mode, conversation_id, created_at)
           VALUES (?,?,?,?,?)`
        ).run(r.id, item.taskId, r.mode, r.conversationId, r.createdAt)
      for (const r of b.legacyHistory)
        db.prepare(
          'INSERT OR REPLACE INTO legacy_conversation_history(task_id, mode, ids) VALUES(?,?,?)'
        ).run(item.taskId, r.mode, JSON.stringify(r.ids))
      for (const r of b.providerConfigs)
        db.prepare(
          'INSERT OR REPLACE INTO provider_configs(task_id, mode, revision, value) VALUES(?,?,?,?)'
        ).run(item.taskId, r.mode, Math.max(r.revision, oldRevisions.get(r.mode) ?? 0) + 1, r.value)
    })
  }
}
