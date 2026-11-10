import type { ChatStorage } from './storage'
import { agentTurnsStore } from './agent-turns'
import type { createLocalChatData } from './local-data'
import type { ChatOwnership, ChatRecord } from '../shared'
import type { AgentEvent, ChatAttachment } from '@slayzone/terminal-contracts'
import { forEachIsolated, isStorageFatal } from '@slayzone/platform/isolation'
import { eventAttachmentReferences, recordAttachmentReferences } from './attachment-references'

const DAY = 86_400_000,
  BATCH = 500
const pause = () => new Promise<void>((resolve) => setImmediate(resolve))
export interface ChatRetentionReport {
  events: number
  records: number
  receiptResults: number
  attachments: number
  skipped: number
  /** Turn snapshots whose prompt preview was blanked. */
  turnPreviews: number
}

/** Durable per-hub policy. Foreground calls and cold-history pruning never overlap. */
export function createChatRetention(opts: {
  automatic?: boolean
  storage: ChatStorage
  local: ReturnType<typeof createLocalChatData>
  busy(owner: ChatOwnership): boolean
  quiesce(tabId: string): Promise<(() => Promise<void>) | void>
  collectGarbage(): void
  changed(tabId: string): void
}) {
  const store = opts.storage,
    db = store.compose((db) => db)
  const storedDays =
    (
      db.prepare('SELECT days FROM retention_policy WHERE id=1').get() as
        | { days: number }
        | undefined
    )?.days ?? 0
  let days = Number.isSafeInteger(storedDays) && storedDays >= 0 ? storedDays : 0
  let stopped = false,
    timer: ReturnType<typeof setTimeout> | null = null
  let pending: Promise<ChatRetentionReport | null> | null = null
  const active = new Map<string, number>(),
    locks = new Map<string, Promise<void>>()
  function schedule(delay = DAY) {
    if (timer) clearTimeout(timer)
    timer = null
    if (!stopped && opts.automatic !== false && days > 0) {
      timer = setTimeout(() => {
        void runNow()
          .catch(() => {
            console.error('[chat-retention] sweep incomplete; retrying at next scheduled pass')
          })
          .finally(() => schedule())
      }, delay)
      timer.unref()
    }
  }
  function runNow(now = Date.now()): Promise<ChatRetentionReport | null> {
    if (stopped || days === 0) return Promise.resolve(null)
    if (pending) return pending
    const policy = days,
      cutoff = now - policy * DAY
    pending = (async () => {
      const report: ChatRetentionReport = {
        events: 0,
        records: 0,
        receiptResults: 0,
        attachments: 0,
        skipped: 0,
        turnPreviews: 0
      }
      // One conversation at a time: a conversation whose history cannot be pruned
      // is recorded (item_faults) and retried on its backoff; the sweep, garbage
      // collection and checkpoint still run for every other conversation.
      await forEachIsolated(
        store.inventory(),
        {
          pass: 'computer.chat-retention',
          key: (owner) => owner.identity.id,
          taskId: (owner) => owner.identity.taskId,
          ledger: store.faults,
          // A daily (or explicitly requested) sweep: every conversation is tried
          // each time; the ledger only records what still fails.
          ignoreGate: true,
          isFatal: isStorageFatal
        },
        async (owner) => {
          const i = owner.identity
          const owned = () =>
            store.conversation(i.id)?.state === 'active' &&
            store.conversation(i.id)?.identity.epoch === i.epoch &&
            store.taskLifecycle(i.taskId).state === 'active'
          const valid = () => !stopped && days === policy && owned() && !opts.busy(owner)
          if (stopped || days !== policy) return
          if (i.id.startsWith('__') || i.tabId.startsWith('artifact-store:')) return
          if (!valid() || active.has(i.taskId) || opts.busy(owner)) {
            report.skipped++
            return
          }
          let release!: () => void
          locks.set(
            i.taskId,
            new Promise((resolve) => {
              release = resolve
            })
          )
          let resume: (() => Promise<void>) | void = undefined
          try {
            resume = await opts.quiesce(i.tabId)
            if (!valid() || opts.busy(owner)) {
              report.skipped++
              return
            }
            // Keep content-free message identities before old history is expired,
            // including legacy conversations activated since this runtime opened.
            opts.local.repairQueueIdentities(i.tabId)
            for (;;) {
              if (!valid()) break
              const n = store.transaction(() => {
                if (!valid()) return 0
                const events = db
                  .prepare(
                    `SELECT seq,json_extract(event,'$.kind') AS kind,
                    json_extract(event,'$.sessionId') AS session_id,
                    json_extract(event,'$.conversationId') AS branch_id
                    FROM events WHERE conversation_id=? AND saved_at<? ORDER BY saved_at,seq LIMIT ?`
                  )
                  .all(i.id, cutoff, BATCH) as {
                  seq: number
                  kind: string
                  session_id: string | null
                  branch_id: string | null
                }[]
                if (!events.length) return 0
                store.putRecord(i.id, i.epoch, {
                  kind: 'settings',
                  id: 'event-sequence-floor',
                  value: store.nextSeq(i.id),
                  at: now
                })
                // Atomic with event removal: a crash cannot leave pages containing expired text.
                db.prepare("DELETE FROM records WHERE conversation_id=? AND kind='timeline'").run(
                  i.id
                )
                const remove = db.prepare('DELETE FROM events WHERE conversation_id=? AND seq=?')
                for (const e of events) {
                  const sessionId =
                    e.kind === 'turn-init'
                      ? e.session_id
                      : e.kind === 'conversation-branch'
                        ? e.branch_id
                        : null
                  if (sessionId)
                    store.putRecord(i.id, i.epoch, {
                      kind: 'settings',
                      id: `session-anchor:${e.seq}`,
                      value: { seq: e.seq, sessionId },
                      at: now
                    })
                  remove.run(i.id, e.seq)
                }
                return events.length
              })
              report.events += n
              if (n < BATCH) break
              await pause()
            }
            for (;;) {
              if (!valid()) break
              const n = store.transaction(() => {
                if (!valid()) return 0
                const rows = db
                  .prepare(`SELECT kind,id,value,saved_at FROM records WHERE conversation_id=? AND saved_at<? AND (
                kind IN ('draft','queue','prompt','workspace','pinned-message') OR
                (kind='thread' AND COALESCE(json_extract(value,'$.title'),'')<>'Thread') OR
                (kind='settings' AND (id LIKE 'attachment-message:%' OR id LIKE 'diagnostic:%' OR id LIKE 'legacy-turn-preview:%' OR id IN ('cli-snapshot','cli-models','cli-details')))
              ) ORDER BY saved_at,kind,id LIMIT ?`)
                  .all(i.id, cutoff, BATCH) as {
                  kind: ChatRecord['kind']
                  id: string
                  value: string
                  saved_at: number
                }[]
                for (const row of rows) {
                  if (row.kind === 'draft' && row.id === 'state') {
                    const state = JSON.parse(row.value)
                    store.putRecord(i.id, i.epoch, {
                      kind: row.kind,
                      id: row.id,
                      value: {
                        draft: { text: '', attachments: [], rev: (state.draft?.rev ?? 0) + 1 },
                        scroll: null
                      },
                      at: now
                    })
                  } else if (row.kind === 'thread') {
                    store.putRecord(i.id, i.epoch, {
                      kind: row.kind,
                      id: row.id,
                      value: { ...JSON.parse(row.value), title: 'Thread' },
                      at: row.saved_at
                    })
                  } else {
                    store.removeRecord(i.id, i.epoch, row.kind, row.id)
                  }
                }
                return rows.length
              })
              report.records += n
              if (n < BATCH) break
              await pause()
            }
            for (;;) {
              if (!valid()) break
              const result = store.transaction(
                () =>
                  db
                    .prepare(
                      `UPDATE receipts SET result='null',result_expired=1 WHERE conversation_id=? AND id IN(SELECT id FROM receipts WHERE conversation_id=? AND saved_at<? AND state='delivered' AND result_expired=0 LIMIT ?)`
                    )
                    .run(i.id, i.id, cutoff, BATCH).changes
              )
              report.receiptResults += result
              if (result < BATCH) break
              await pause()
            }
            // Scan retained references in pages; only distinct attachment identities stay in memory.
            const hashes = new Set<string>(),
              unversioned = new Set<string>()
            function remember(refs: ChatAttachment[]) {
              for (const ref of refs)
                if (ref.contentHash) hashes.add(`${ref.artifactId}:${ref.contentHash}`)
                else unversioned.add(ref.artifactId)
            }
            let after = -1
            while (valid()) {
              const rows = db
                .prepare(
                  'SELECT seq,event FROM events WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT ?'
                )
                .all(i.id, after, BATCH) as { seq: number; event: string }[]
              for (const row of rows) {
                after = row.seq
                remember(eventAttachmentReferences(JSON.parse(row.event) as AgentEvent))
              }
              if (rows.length < BATCH) break
              await pause()
            }
            after = 0
            while (valid()) {
              const rows = db
                .prepare(
                  "SELECT rowid AS cursor,kind,id,value FROM records WHERE conversation_id=? AND rowid>? AND (kind IN ('draft','queue') OR (kind='settings' AND id LIKE 'attachment-message:%')) ORDER BY rowid LIMIT ?"
                )
                .all(i.id, after, BATCH) as {
                cursor: number
                kind: ChatRecord['kind']
                id: string
                value: string
              }[]
              for (const row of rows) {
                after = row.cursor
                remember(recordAttachmentReferences({ ...row, value: JSON.parse(row.value) }))
              }
              if (rows.length < BATCH) break
              await pause()
            }
            // Even if disabled during scanning, the guard prevents collection from an incomplete scan.
            if (valid()) {
              let cursor = ''
              for (;;) {
                if (!valid()) break
                const rows = db
                  .prepare(
                    "SELECT id,value FROM records WHERE conversation_id=? AND kind='attachment' AND saved_at<? AND id>? ORDER BY id LIMIT ?"
                  )
                  .all(i.id, cutoff, cursor, BATCH) as { id: string; value: string }[]
                store.transaction(() => {
                  for (const row of rows) {
                    cursor = row.id
                    const ref = JSON.parse(row.value) as { artifactId: string; contentHash: string }
                    if (
                      !unversioned.has(ref.artifactId) &&
                      !hashes.has(`${ref.artifactId}:${ref.contentHash}`)
                    ) {
                      store.removeRecord(i.id, i.epoch, 'attachment', row.id)
                      report.attachments++
                    }
                  }
                })
                if (rows.length < BATCH) break
                await pause()
              }
              opts.changed(i.tabId)
            }
          } finally {
            try {
              if (resume && owned() && !stopped) await resume()
            } finally {
              locks.delete(i.taskId)
              release()
            }
          }
          await pause()
        }
      )
      // Turn snapshots keep their row (it pins a snapshot ref the per-checkout cap
      // removes with it); only the prompt preview, session content, ages out.
      try {
        report.turnPreviews = store.transaction(() =>
          agentTurnsStore(store).redactPreviewsBefore(cutoff)
        )
      } catch (error) {
        if (isStorageFatal(error)) throw error
        console.error('[chat-retention] turn previews not redacted; retried next sweep:', error)
      }
      opts.collectGarbage()
      store.checkpoint()
      return report
    })().finally(() => {
      pending = null
    })
    return pending
  }
  schedule(5000)
  return {
    get days() {
      return days
    },
    configure(value: number) {
      if (stopped) throw new Error('Chat retention is closed')
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid chat retention days')
      db.prepare(
        'INSERT INTO retention_policy VALUES(1,?) ON CONFLICT(id) DO UPDATE SET days=excluded.days'
      ).run(value)
      if (days !== value) {
        days = value
        schedule(5000)
      }
    },
    isPruning(id: string) {
      return locks.has(store.conversation(id)?.identity.taskId ?? id)
    },
    async access<T>(id: string, work: () => Promise<T>): Promise<T> {
      const key = store.conversation(id)?.identity.taskId ?? id
      while (locks.has(key)) await locks.get(key)
      if (stopped) throw new Error('Chat retention is closed')
      active.set(key, (active.get(key) ?? 0) + 1)
      try {
        return await work()
      } finally {
        const n = active.get(key)! - 1
        if (n) active.set(key, n)
        else active.delete(key)
      }
    },
    runNow,
    async close() {
      stopped = true
      if (timer) clearTimeout(timer)
      await pending?.catch(() => {
        /* Maintenance errors must not prevent storage shutdown. */
      })
    }
  }
}
