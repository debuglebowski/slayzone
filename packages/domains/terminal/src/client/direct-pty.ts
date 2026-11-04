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
  keepDirectLease,
  type DirectLease,
  type DirectLinkManager
} from '@slayzone/transport/client'

type DirectPtyClient = DirectLease['client']

/** Sessions with a live direct lease, for the read/write helpers below. */
const directSessions = new Map<string, DirectPtyClient>()

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
  return directSessions.get(sessionId) ?? null
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
  let sub: { unsubscribe(): void } | null = null

  function unlink(): void {
    sub?.unsubscribe()
    sub = null
    if (current && directSessions.get(sessionId) === current.client) {
      directSessions.delete(sessionId)
      changed()
    }
    current = null
  }

  function link(got: DirectLease): void {
    current = got
    directSessions.set(sessionId, got.client)
    changed()
    // Live chunks wait until the gap since the last delivered seq is filled, so
    // delivery stays in order (a later seq would make the gap's seqs look old).
    let catching = true
    const queue: Array<{ seq: number; data: string }> = []
    const catchUp = async (): Promise<void> => {
      const after = opts.lastSeq()
      if (after >= 0) {
        const missed = await got.client.pty.getBufferSince
          .query({ sessionId, afterSeq: after })
          .catch(() => null)
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
    target: { kind: 'pty', sessionId },
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
  pty: { write: { mutate(input: { sessionId: string; data: string }): Promise<boolean> } }
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

function refusedDirectly(err: unknown): boolean {
  const code = (err as { data?: { code?: string } } | null)?.data?.code
  return code === 'FORBIDDEN' || code === 'UNAUTHORIZED'
}

/**
 * Keystrokes: direct when the session has a lease, else the hub. A direct write
 * the computer refused (its grant ended) was not written, so it goes to the hub.
 */
export async function ptyWrite(
  hub: HubPtyWrite,
  sessionId: string,
  data: string
): Promise<boolean> {
  const direct = directPtyFor(sessionId)
  if (direct) {
    try {
      const written = await direct.pty.write.mutate({ sessionId, data })
      stats.writes++
      return written
    } catch (err) {
      if (!refusedDirectly(err)) throw err
    }
  }
  return hub.pty.write.mutate({ sessionId, data })
}

/** Backfill after `afterSeq`: direct when the session has a lease, else the hub. */
export async function ptyBufferSince(
  hub: HubPtyBuffer,
  sessionId: string,
  afterSeq: number
): ReturnType<HubPtyBuffer['pty']['getBufferSince']['query']> {
  const direct = directPtyFor(sessionId)
  if (direct) {
    const res = await direct.pty.getBufferSince.query({ sessionId, afterSeq }).catch(() => null)
    if (res) return res
  }
  return hub.pty.getBufferSince.query({ sessionId, afterSeq })
}

/** Test seam. */
export function __resetDirectPtyForTest(): void {
  directSessions.clear()
  stats.chunks = 0
  stats.writes = 0
}
