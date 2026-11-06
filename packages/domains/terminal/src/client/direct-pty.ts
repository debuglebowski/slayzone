/**
 * A terminal's direct link to the computer that runs its session
 * (docs/direct-link.md). While a lease lives:
 *  - output streams straight from the computer into the same seq-ordered delivery
 *    the hub stream uses (PtyContext drops any seq it already has, so the two
 *    streams can overlap safely);
 *  - keystrokes, attach and backfill go direct.
 * Everything else — state, exit, prompts, resize, touch — stays on the hub.
 *
 * When the lease ends (socket closed, grant refused, the computer restarted), the
 * session is back on the hub relay at once and the link tries again. A computer
 * that reconnects is retried right away; a relay answer waits `retryMs`.
 *
 * @module terminal/client/direct-pty
 */
import {
  createOrderedPtyWriter,
  DIRECT_CALL_DEADLINE_MS,
  directCallFailure,
  keepDirectLease,
  newDirectWriteId,
  readDirectPtyBuffer,
  withDirectDeadline,
  noteDirectUse,
  type DirectLease,
  type DirectLinkManager,
  type OrderedPtyWriter,
  type PtyWritePath
} from '@slayzone/transport/direct-client'
import { taskIdFromSessionId } from './session-id'

type DirectPtyClient = DirectLease['client']

/** Sessions with a live direct lease, for the read/write helpers below. */
interface DirectSessionLink {
  client: DirectPtyClient
  lost: () => void
}
/**
 * Every live link per session, newest last. A session can be mounted twice (two
 * terminals of it), and both share one socket client: each link removes only its
 * own entry, so one ending never takes the other off the direct link.
 */
const directSessions = new Map<string, DirectSessionLink[]>()
const directFor = (sessionId: string): DirectSessionLink | undefined =>
  directSessions.get(sessionId)?.at(-1)

/** How long a direct write or backfill may take (`@slayzone/transport`). */
export const DIRECT_WRITE_DEADLINE_MS = DIRECT_CALL_DEADLINE_MS

const changeListeners = new Set<() => void>()
function changed(): void {
  for (const cb of [...changeListeners]) cb()
}

/** Told whenever a session joins or leaves the direct link (the hub relay set follows). */
export function onDirectPtySessionsChanged(cb: () => void): () => void {
  changeListeners.add(cb)
  return () => changeListeners.delete(cb)
}

/** The direct client for a session, or null (use the hub). */
export function directPtyFor(sessionId: string): DirectPtyClient | null {
  return directFor(sessionId)?.client ?? null
}

/** What went direct since load (diagnostics, e2e): chunks received, writes sent. */
const stats = { chunks: 0, writes: 0 }

/** Sessions on the direct link now, and what went direct (diagnostics, e2e). */
export function directPtyStatus(): { sessionIds: string[]; chunks: number; writes: number } {
  return { sessionIds: [...directSessions.keys()], ...stats }
}

if (typeof window !== 'undefined') {
  ;(window as unknown as { __slayzone_directPty?: () => unknown }).__slayzone_directPty =
    directPtyStatus
}

export interface DirectPtyLinkOptions {
  sessionId: string
  manager: Pick<DirectLinkManager, 'acquire' | 'onComputerConnected'>
  /** PtyContext's seq-ordered delivery (drops seq <= the last delivered). */
  deliver: (data: string, seq: number) => void
  /** The last seq PtyContext delivered for the session (-1 = none yet). */
  lastSeq: () => number
  /**
   * Something about the session changed (it started, restarted): try again now if
   * not linked. A terminal mounts before its process exists, and the hub can only
   * issue for a session that runs.
   */
  wake?: (cb: () => void) => () => void
  /** After a relay answer (nothing to reach directly). */
  retryMs?: number
  /** After a lease was lost (socket closed, grant ended). */
  lostRetryMs?: number
}

export function startDirectPtyLink(opts: DirectPtyLinkOptions): () => void {
  const { sessionId } = opts
  let current: DirectLease | null = null
  let mine: DirectSessionLink | null = null
  let sub: { unsubscribe(): void } | null = null

  function unlink(): void {
    sub?.unsubscribe()
    sub = null
    current = null
    const links = directSessions.get(sessionId)
    const at = mine ? (links?.indexOf(mine) ?? -1) : -1
    mine = null
    if (!links || at < 0) return
    links.splice(at, 1)
    // Another terminal of this session is still linked: it stays direct.
    if (links.length > 0) return
    directSessions.delete(sessionId)
    noteDirectUse('pty', sessionId, false)
    changed()
  }

  function link(got: DirectLease): void {
    current = got
    mine = { client: got.client, lost: () => keeper.lost() }
    const links = directSessions.get(sessionId)
    if (links) links.push(mine)
    else directSessions.set(sessionId, [mine])
    noteDirectUse('pty', sessionId, true)
    changed()
    // Live chunks wait until the gap since the last delivered seq is filled, so
    // delivery stays in order (a later seq would make the gap's seqs look old).
    let catching = true
    const queue: Array<{ seq: number; data: string }> = []
    const catchUp = async (): Promise<void> => {
      const after = opts.lastSeq()
      if (after >= 0) {
        // Paged: a full scrollback is larger than one WebRTC message.
        const missed = await readDirectPtyBuffer(got.client, sessionId, after).catch(() => null)
        if (current !== got) return
        for (const c of missed?.chunks ?? []) opts.deliver(c.data, c.seq)
      }
      catching = false
      for (const c of queue.splice(0)) opts.deliver(c.data, c.seq)
    }
    sub = got.client.pty.onData.subscribe(
      { sessionId },
      {
        onStarted: () => void catchUp(),
        onData: (chunk) => {
          stats.chunks++
          if (catching) queue.push(chunk)
          else opts.deliver(chunk.data, chunk.seq)
        },
        // The grant ended or the process exited (a respawn reuses the id): back to
        // the hub, and try again shortly.
        onError: () => keeper.lost(),
        onComplete: () => keeper.lost()
      }
    )
  }

  const keeper = keepDirectLease({
    target: { kind: 'pty', sessionId, taskId: taskIdFromSessionId(sessionId) },
    manager: opts.manager,
    ...(opts.wake ? { wake: opts.wake } : {}),
    ...(opts.retryMs !== undefined ? { retryMs: opts.retryMs } : {}),
    ...(opts.lostRetryMs !== undefined ? { lostRetryMs: opts.lostRetryMs } : {}),
    onChange: (lease) => {
      unlink()
      if (lease) link(lease)
    }
  })

  return () => keeper.stop()
}

/** The hub client slice the helpers fall back to. */
interface HubPtyWrite {
  pty: {
    write: {
      mutate(input: { sessionId: string; data: string; writeId?: string }): Promise<boolean>
    }
  }
}

interface HubPtyBuffer {
  pty: {
    getBufferSince: {
      query(input: { sessionId: string; afterSeq: number }): Promise<{
        chunks: Array<{ seq: number; data: string }>
        currentSeq: number
        prelude?: string
      } | null>
    }
  }
}

/**
 * Keystrokes: direct when the session has a lease, else the hub. A direct write that
 * may not have landed (refused, not taken, socket gone, no answer in time) goes to the hub with
 * the same id — the computer applies it once, so it is neither lost nor typed twice;
 * a transport failure also drops the lease. Keys reach the computer in the order
 * typed: one typed while a direct write is in flight waits for it.
 */
export function ptyWrite(hub: HubPtyWrite, sessionId: string, data: string): Promise<boolean> {
  let entry = writers.get(sessionId)
  if (!entry) {
    const e: { hub: HubPtyWrite; writer: OrderedPtyWriter } = {
      hub,
      writer: createOrderedPtyWriter({
        isDirect: () => directFor(sessionId) !== undefined,
        send: (path, chunk): Promise<boolean> => sendPtyWrite(e.hub, sessionId, chunk, path)
      })
    }
    writers.set(sessionId, e)
    entry = e
  }
  entry.hub = hub
  const own = entry
  return own.writer.write(data).finally(() => {
    if (own.writer.idle() && writers.get(sessionId) === own) writers.delete(sessionId)
  })
}

/**
 * Per session: keys go out in the order typed, across both paths
 * (`createOrderedPtyWriter`). Dropped once idle.
 */
const writers = new Map<string, { hub: HubPtyWrite; writer: OrderedPtyWriter }>()

/** One write, starting on `path`; a direct one that may not have landed goes to the hub. */
async function sendPtyWrite(
  hub: HubPtyWrite,
  sessionId: string,
  data: string,
  path: PtyWritePath
): Promise<boolean> {
  const writeId = newDirectWriteId()
  const direct = path === 'direct' ? directFor(sessionId) : undefined
  if (direct) {
    try {
      const written = await withDirectDeadline(
        direct.client.pty.write.mutate({ sessionId, data, writeId })
      )
      stats.writes++
      // False: the computer had no session to take it (not started yet, or gone).
      // The hub queues for a session waiting to start; same id, applied once.
      if (written) return true
    } catch (err) {
      const why = directCallFailure(err)
      if (why === 'answered') throw err
      if (why === 'transport') direct.lost()
    }
  }
  return hub.pty.write.mutate({ sessionId, data, writeId })
}

/**
 * A direct read for `sessionId` failed: a transport failure (socket gone, no answer
 * in time) drops the lease, so the session goes back to the relay at once.
 */
export function noteDirectPtyFailure(sessionId: string, err: unknown): void {
  if (directCallFailure(err) === 'transport') directFor(sessionId)?.lost()
}

/** Backfill after `afterSeq`: direct when the session has a lease, else the hub. */
export async function ptyBufferSince(
  hub: HubPtyBuffer,
  sessionId: string,
  afterSeq: number
): ReturnType<HubPtyBuffer['pty']['getBufferSince']['query']> {
  const direct = directFor(sessionId)
  if (direct) {
    // Each call has its own deadline (a long paged read is not cut off).
    const res = await readDirectPtyBuffer(direct.client, sessionId, afterSeq).catch(
      (err: unknown) => {
        if (directCallFailure(err) === 'transport') direct.lost()
        return null
      }
    )
    if (res) return res
  }
  return hub.pty.getBufferSince.query({ sessionId, afterSeq })
}

/**
 * For `void`-style call sites (keystrokes from xterm handlers): a write neither path
 * could deliver is reported, never an unhandled rejection.
 */
export function reportPtyWriteFailure(err: unknown): void {
  console.warn('[terminal] keystroke not delivered', err)
}

/** Test seam. */
export function __resetDirectPtyForTest(): void {
  directSessions.clear()
  writers.clear()
  stats.chunks = 0
  stats.writes = 0
}
