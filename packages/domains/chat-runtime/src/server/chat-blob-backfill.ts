/**
 * Event-blob backfill (crash fix 4): rows saved before chat storage v13 hold their
 * screenshots and files as base64 inline (`events.blob_form = 0`). This background
 * pass moves those bytes to the blob store and rewrites each row IN PLACE to its
 * stored form — representation, never meaning:
 *
 * - Per row, BEFORE its UPDATE commits: every blob is written + fsynced, re-read
 *   hash- and size-verified, and resolving the new form gives back exactly the
 *   original event. Any doubt: the row stays inline and a fault is recorded.
 * - Small slices (≈20 ms / a byte budget) with a pause between them, so the
 *   computer's event loop never stalls; checkpointed per conversation, so a restart
 *   resumes where it stopped; idempotent (stored-form rows are never touched).
 * - Excluded from: backups (no slice while a blob lease is held), retention (a chat
 *   it prunes waits), erasure / moves / migrations (only `active` conversations, a
 *   slice re-checks ownership synchronously). Concurrent appends are already in
 *   stored form.
 * - A rewritten chat's timeline projection (its pages embed the old inline rows) is
 *   reset once the chat is idle — rebuilt from the now-small events on next open.
 *
 * Progress and completion go to the computer log: counts and bytes, no content.
 */
import { isDeepStrictEqual } from 'node:util'
import { StructuralFaultError, isStorageFatal } from '@slayzone/platform/isolation'
import {
  CHAT_BLOB_MIN_BASE64,
  chatBlobRefs,
  resolveChatBlobs,
  type AgentEvent
} from '@slayzone/terminal-contracts'
import type { ChatOwnership } from '../shared'
import { freeDiskBytes } from './disk-space'
import { EVENT_BLOBS_MAINTENANCE, type ChatStorage } from './storage'
import { dropTimelineInSteps } from './timeline-drop'

/** Done marker (`storage_maintenance`) and checkpoint key (`maintenance_cursors`). */
export const CHAT_BLOB_BACKFILL = EVENT_BLOBS_MAINTENANCE
const PASS = 'computer.chat-blob-backfill'
/**
 * Chats this backfill rewrote that have timeline pages: pages built from their
 * legacy rows embed the inline base64, so they are reset. (Pages written before
 * v13 need no reset: the projection version refuses them and rebuilds on open.)
 */
const TIMELINES = `${CHAT_BLOB_BACKFILL}:timelines`
/** Chats a pass could not finish (frozen, prepared, ownership moved): retried first. */
const PENDING = `${CHAT_BLOB_BACKFILL}:pending`
const GiB = 1024 * 1024 * 1024
/** Row sizes looked up per read (record headers only: no row is loaded). */
const SIZES_PER_READ = 256

export interface ChatBlobBackfillReport {
  /** Rows rewritten to stored form. */
  rows: number
  /** References made (one per extracted payload). */
  blobs: number
  /** Decoded bytes moved out-of-line. */
  bytes: number
  /** Rows left inline because their round trip could not be verified. */
  faults: number
  /** Timeline projections reset. */
  timelines: number
}

export interface ChatBlobBackfillOptions {
  storage: ChatStorage
  /** Start on its own after boot (and retry an incomplete pass). Default true. */
  automatic?: boolean
  /**
   * Run `work` with the chat's task locked and its session quiesced — retention's own
   * mechanism (`createChatRetention().withQuiesced`): skipped (false) while the chat
   * is busy or has calls in flight, checked with no await before quiescing and again
   * after. The timeline reset runs only through it.
   */
  withQuiesced(
    owner: ChatOwnership,
    work: () => Promise<void>,
    opts: { allowPaused: boolean }
  ): Promise<boolean>
  /** Retention prunes this conversation right now. */
  pruning(conversationId: string): boolean
  /** The tab's clients re-read (its timeline was reset). */
  changed(tabId: string): void
  /** Computer log line. Default: console. */
  log?(line: string): void
  /** Pause between slices / while blocked. Default: a timer. */
  sleep?(ms: number): Promise<void>
  now?(): number
  /** Work per slice (ms). Default 20. */
  sliceMs?: number
  /** Saved bytes read per slice at most (one row may exceed it). Default 8 MiB. */
  sliceBytes?: number
  /** Pause between slices (ms). Default 80 (≈20 % duty). */
  idleMs?: number
  /** First automatic run after boot (ms). Default 30 s. */
  startDelayMs?: number
  /** Retry of an incomplete pass (ms). Default 10 min. */
  retryMs?: number
  /** Free bytes on the store's disk. Default: `statfs` of the store dir. */
  freeBytes?(): number
}

type Cursor = { conversation: string; seq: number }

/** Cheap pre-check before parsing a row: could it hold a binary slot at all? */
function mayHoldBlob(json: string): boolean {
  return (
    json.length >= CHAT_BLOB_MIN_BASE64 &&
    (json.includes('"base64"') || json.includes('"mimeType"') || json.includes('"blob"'))
  )
}

const MiB = 1024 * 1024
const formatMiB = (bytes: number) => `${(bytes / MiB).toFixed(1)} MiB`

export function createChatBlobBackfill(opts: ChatBlobBackfillOptions) {
  const store = opts.storage
  const log = opts.log ?? ((line: string) => console.log(line))
  const now = opts.now ?? Date.now
  const sliceMs = opts.sliceMs ?? 20,
    sliceBytes = opts.sliceBytes ?? 8 * MiB,
    idleMs = opts.idleMs ?? 80
  // Every pause ends early on close(): a pass awaited by close() must never wait on
  // a timer close() cleared.
  const sleepers = new Set<() => void>()
  const sleep = (ms: number): Promise<void> => {
    if (closed) return Promise.resolve()
    if (opts.sleep) return opts.sleep(ms)
    return new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer)
        sleepers.delete(wake)
        resolve()
      }
      const timer = setTimeout(wake, ms)
      sleepers.add(wake)
    })
  }
  const freeBytes = opts.freeBytes ?? (() => freeDiskBytes(store.dir))
  /** Room the next slice must leave: blobs it may write, twice, and a floor. */
  const freeMargin = Math.max(GiB, 2 * sliceBytes)
  let closed = false,
    pending: Promise<ChatBlobBackfillReport | null> | null = null,
    schedule: ReturnType<typeof setTimeout> | null = null

  const pendingTimelines = () => store.maintenanceCursor<string[]>(TIMELINES) ?? []
  const setPendingTimelines = (ids: string[]) => store.setMaintenanceCursor(TIMELINES, ids)
  const pendingChats = () => store.maintenanceCursor<string[]>(PENDING) ?? []
  const setPendingChats = (ids: string[]) => store.setMaintenanceCursor(PENDING, ids)
  /** Disk too full for the next slice: logged once per pass. */
  let lowDiskLogged = false
  function roomForSlice(): boolean {
    const free = freeBytes()
    if (free >= freeMargin) return true
    if (!lowDiskLogged) {
      lowDiskLogged = true
      log(
        `[chat-blob-backfill] paused: low disk space (${formatMiB(free)} free, needs ${formatMiB(freeMargin)}); retrying later`
      )
    }
    return false
  }
  /** What a fault records: its class only — never a message that may quote the row. */
  const faultClass = (error: unknown) =>
    error instanceof SyntaxError || (error as Error | null)?.name === 'SyntaxError'
      ? 'parse'
      : error instanceof StructuralFaultError
        ? 'verify'
        : 'io'

  /** Extract, verify, rewrite ONE legacy row. Throws when the round trip is not proven. */
  function rewrite(
    owner: ChatOwnership,
    row: { seq: number; event: string },
    report: ChatBlobBackfillReport
  ) {
    const original = JSON.parse(row.event) as AgentEvent
    // Blobs written (temp + fsync + rename + dir fsync) by the store's extraction.
    const stored = store.extractEventBlobs(original)
    if (stored === original) return
    const refs = chatBlobRefs(stored)
    // Proof, from what is on disk: every blob reads back hash- and size-verified, and
    // the stored form resolves to exactly the original event.
    const verified = new Map<string, string>()
    for (const ref of refs) {
      if (verified.has(ref.sha256)) continue
      const bytes = store.blobs.readBlob(ref.sha256)
      if (bytes.length !== ref.size)
        throw new StructuralFaultError('Event blob size does not match its reference')
      verified.set(ref.sha256, Buffer.from(bytes).toString('base64'))
    }
    const roundTrip = resolveChatBlobs(stored, (ref) => verified.get(ref.sha256)!)
    if (!isDeepStrictEqual(roundTrip, original))
      throw new StructuralFaultError('Out-of-line form does not reproduce the saved event')
    if (
      !store.rewriteLegacyEvent(owner.identity.id, owner.identity.epoch, row.seq, row.event, stored)
    )
      return
    report.rows++
    report.blobs += refs.length
    report.bytes += refs.reduce((n, ref) => n + ref.size, 0)
  }

  /** Waits while a backup or retention needs this conversation left alone. False: closed. */
  async function unblocked(id: string): Promise<boolean> {
    while (!closed && (store.hasBlobLeases() || opts.pruning(id))) await sleep(idleMs)
    return !closed
  }

  /**
   * One conversation's legacy rows, in slices: `done` (all processed, or the chat is
   * gone), `skipped` (not active / ownership moved: retry in a later pass), `stopped`
   * (closed, or the disk is short: the checkpoint resumes it).
   */
  async function backfillConversation(
    owner: ChatOwnership,
    from: number,
    report: ChatBlobBackfillReport
  ): Promise<'done' | 'skipped' | 'stopped'> {
    const i = owner.identity
    let seq = from
    const live = () => {
      const current = store.conversation(i.id)
      return current?.state === 'active' && current.identity.epoch === i.epoch
    }
    for (;;) {
      if (!(await unblocked(i.id))) return 'stopped'
      // One slice: synchronous from here, so nothing (a backup, erasure, retention, a
      // move) interleaves with it; each row re-checks ownership in its own transaction.
      if (!live()) {
        const current = store.conversation(i.id)
        return !current || current.state === 'deleted' ? 'done' : 'skipped'
      }
      if (store.hasBlobLeases() || opts.pruning(i.id)) continue
      if (!roomForSlice()) return 'stopped'
      const start = now()
      let bytes = 0,
        finished = false
      // Sizes first (record headers, no row loaded); a body is read once, only when
      // the row fits what is left of the slice (the first row of a slice always does)
      // and is long enough to hold a binary slot at all.
      slice: for (;;) {
        const sizes = store.legacyEventSizes(i.id, seq, SIZES_PER_READ)
        for (const candidate of sizes) {
          // Shorter than any blob slot (UTF-8 bytes ≥ characters): the prefilter could
          // never pass, so nothing is read.
          if (candidate.bytes < CHAT_BLOB_MIN_BASE64) {
            seq = candidate.seq
            continue
          }
          // It would take this slice past its budget: the next slice starts with it.
          if (bytes > 0 && bytes + candidate.bytes > sliceBytes) break slice
          const row = store.legacyEvent(i.id, candidate.seq)
          if (row && mayHoldBlob(row.event))
            try {
              rewrite(owner, row, report)
            } catch (error) {
              if (isStorageFatal(error)) throw error
              report.faults++
              store.faults.record(
                {
                  pass: PASS,
                  itemKey: `${i.id}:${row.seq}`,
                  taskId: i.taskId,
                  kind: 'structural',
                  fingerprint: `${row.event.length}`,
                  error: new Error(`Saved event ${row.seq} kept inline (${faultClass(error)})`)
                },
                now()
              )
            }
          seq = candidate.seq
          bytes += candidate.bytes
          if (bytes >= sliceBytes || now() - start >= sliceMs) break slice
        }
        if (sizes.length < SIZES_PER_READ) {
          finished = true
          break
        }
        // A long run of short rows: still bounded in time.
        if (now() - start >= sliceMs) break
      }
      store.setMaintenanceCursor(CHAT_BLOB_BACKFILL, { conversation: i.id, seq } satisfies Cursor)
      if (finished) return 'done'
      await sleep(idleMs)
      if (closed) return 'stopped'
    }
  }

  /**
   * Reset the timeline projection (derived; rebuilt from the events on next open) of
   * every chat it rewrote — only through `withQuiesced`, so a busy chat is never
   * quiesced: it waits for a later pass. A paused task's chat qualifies (no agent can
   * start there), so a paused task never holds the pass open. Returns how many wait.
   */
  async function resetTimelines(report: ChatBlobBackfillReport): Promise<number> {
    const left: string[] = []
    for (const id of pendingTimelines()) {
      const owner = store.conversation(id)
      if (!owner || owner.state === 'deleted' || !store.hasTimeline(id)) continue
      const reset =
        !closed &&
        owner.state === 'active' &&
        (await opts.withQuiesced(
          owner,
          async () => {
            // In byte-bounded steps, the event loop running between them (and so
            // between chats: an idle chat's quiesce resolves without a loop turn).
            await dropTimelineInSteps(store, id, owner.identity.epoch)
            report.timelines++
            opts.changed(owner.identity.tabId)
          },
          { allowPaused: true }
        ))
      if (!reset) left.push(id)
    }
    setPendingTimelines(left)
    return left.length
  }

  function runNow(): Promise<ChatBlobBackfillReport | null> {
    if (closed || store.maintenanceDone(CHAT_BLOB_BACKFILL)) return Promise.resolve(null)
    if (pending) return pending
    pending = (async () => {
      const report: ChatBlobBackfillReport = {
        rows: 0,
        blobs: 0,
        bytes: 0,
        faults: 0,
        timelines: 0
      }
      const cursor = store.maintenanceCursor<Cursor>(CHAT_BLOB_BACKFILL)
      const owners = store
        .inventory()
        .filter((o) => o.state !== 'deleted')
        .sort((a, b) =>
          a.identity.id < b.identity.id ? -1 : a.identity.id > b.identity.id ? 1 : 0
        )
      log(
        `[chat-blob-backfill] ${cursor ? 'resuming' : 'starting'}: ${owners.length} conversations`
      )
      let complete = true,
        stopped = false,
        done = 0,
        lastLog = now()
      lowDiskLogged = false
      const skipped = new Set<string>()
      const progress = () => {
        if (now() - lastLog < 30_000) return
        lastLog = now()
        log(
          `[chat-blob-backfill] progress: ${done}/${owners.length} conversations, ${report.rows} rows, ${report.blobs} blobs, ${formatMiB(report.bytes)} moved, ${report.faults} faults`
        )
      }
      /** One chat, whatever its outcome is recorded (pending retry, timeline reset). */
      const visit = async (owner: ChatOwnership, from: number) => {
        const id = owner.identity.id
        if (owner.state !== 'active') {
          // Frozen (a move), prepared (a transfer): its rows wait for a later pass.
          skipped.add(id)
          return
        }
        const rowsBefore = report.rows
        const outcome = await backfillConversation(owner, from, report)
        if (outcome === 'stopped') {
          stopped = true
          return
        }
        if (outcome === 'skipped') skipped.add(id)
        else done++
        if (report.rows > rowsBefore && store.hasTimeline(id))
          setPendingTimelines([...new Set([...pendingTimelines(), id])])
        progress()
      }
      // Chats an earlier pass could not finish come first, from their start.
      for (const id of pendingChats()) {
        if (closed || stopped) break
        const owner = store.conversation(id)
        if (!owner || owner.state === 'deleted') continue
        await visit(owner, -1)
      }
      for (const owner of owners) {
        if (closed || stopped) break
        const id = owner.identity.id
        // Conversations before the checkpoint's were visited; its own resumes after its seq.
        if (cursor && id < cursor.conversation) continue
        if (skipped.has(id)) continue
        await visit(owner, cursor && id === cursor.conversation ? cursor.seq : -1)
      }
      if (closed || stopped) {
        // Not visited yet: the checkpoint resumes there; earlier skips stay pending.
        complete = false
        setPendingChats([...new Set([...pendingChats(), ...skipped])])
      } else {
        setPendingChats([...skipped])
        if (skipped.size) complete = false
      }
      // Every conversation visited: the next pass only retries the pending ones.
      if (!closed && !stopped)
        store.setMaintenanceCursor(CHAT_BLOB_BACKFILL, { conversation: '\uffff', seq: -1 })
      const timelinesLeft = closed ? pendingTimelines().length : await resetTimelines(report)
      const summary = `${report.rows} rows, ${report.blobs} blobs, ${formatMiB(report.bytes)} moved, ${report.faults} faults, ${report.timelines} timelines reset`
      if (!closed && complete && timelinesLeft === 0) {
        store.completeMaintenance(CHAT_BLOB_BACKFILL)
        log(`[chat-blob-backfill] complete: ${summary}`)
      } else
        log(
          `[chat-blob-backfill] ${closed ? 'stopped' : `incomplete (${skipped.size} chats pending, ${timelinesLeft} timeline reset${timelinesLeft === 1 ? '' : 's'} pending, retrying later)`}: ${summary}`
        )
      return report
    })().finally(() => {
      pending = null
    })
    return pending
  }

  function plan(delay: number) {
    if (closed || opts.automatic === false) return
    schedule = setTimeout(() => {
      schedule = null
      void runNow()
        .catch((error: unknown) => {
          console.error('[chat-blob-backfill] pass failed; retrying later:', error)
        })
        .finally(() => {
          if (!store.maintenanceDone(CHAT_BLOB_BACKFILL)) plan(opts.retryMs ?? 600_000)
        })
    }, delay)
    schedule.unref?.()
  }
  plan(opts.startDelayMs ?? 30_000)

  return {
    runNow,
    /** The pass finished for good (every legacy row and reset handled). */
    done: () => store.maintenanceDone(CHAT_BLOB_BACKFILL),
    async close() {
      closed = true
      if (schedule) clearTimeout(schedule)
      for (const wake of [...sleepers]) wake()
      await pending?.catch(() => undefined)
    }
  }
}
