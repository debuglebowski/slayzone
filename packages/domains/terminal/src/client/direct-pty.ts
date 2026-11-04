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
import type { DirectLease, DirectLinkManager } from '@slayzone/transport/client'

type DirectPtyClient = DirectLease['client']

/** Sessions with a live direct lease, for the read/write helpers below. */
const directSessions = new Map<string, DirectPtyClient>()

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
  const retryMs = opts.retryMs ?? 60_000
  const lostRetryMs = opts.lostRetryMs ?? 1_000
  let stopped = false
  let connecting = false
  let lease: DirectLease | null = null
  let sub: { unsubscribe(): void } | null = null
  let offLost: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  function schedule(ms: number): void {
    if (stopped || timer) return
    timer = setTimeout(() => {
      timer = null
      void connect()
    }, ms)
  }

  function teardown(retryAfterMs: number | null): void {
    if (directSessions.get(sessionId) === lease?.client) directSessions.delete(sessionId)
    offLost?.()
    offLost = null
    sub?.unsubscribe()
    sub = null
    lease?.release()
    lease = null
    if (retryAfterMs !== null) schedule(retryAfterMs)
  }

  async function connect(): Promise<void> {
    if (stopped || connecting || lease) return
    connecting = true
    const got = await opts.manager.acquire({ kind: 'pty', sessionId }).catch(() => null)
    connecting = false
    if (stopped) {
      got?.release()
      return
    }
    if (!got) {
      schedule(retryMs)
      return
    }
    lease = got
    directSessions.set(sessionId, got.client)
    offLost = got.onLost(() => teardown(lostRetryMs))

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
        if (lease !== got) return
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
        onError: () => teardown(lostRetryMs),
        onComplete: () => teardown(lostRetryMs)
      }
    )
  }

  const retryNow = (): void => {
    if (lease || stopped) return
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    void connect()
  }
  const offConnected = opts.manager.onComputerConnected(retryNow)
  const offWake = opts.wake?.(retryNow) ?? (() => undefined)
  void connect()

  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
    offConnected()
    offWake()
    teardown(null)
  }
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
