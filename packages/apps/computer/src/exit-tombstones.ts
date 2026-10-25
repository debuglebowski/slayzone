/**
 * What the computer remembers about sessions it has reaped (tombstones), shared
 * by the pty and proc handlers.
 *
 * The hub's registry is only a belief about what runs here, and a dropped
 * connection lets the two diverge. On reconnect the hub settles each session it
 * lost track of against `pty.list` / `proc.list`. Without a record of exits, a
 * session missing from the list could only be guessed at — the hub reported it as
 * "exited with code 1", which an agent mode turns into a recovery shell for a
 * process that may have exited cleanly. A tombstone carries the real code.
 *
 * It also keeps the session's output buffer when the exit could not be DELIVERED
 * (the hub was away), so the hub can backfill the tail it missed — often the line
 * saying why the agent exited. An exit the hub did receive keeps no buffer: the
 * hub already has that output, and buffers are the expensive part.
 *
 * Bounded both ways, because a tombstone only matters while some hub could still
 * be waiting on it: {@link TOMBSTONE_TTL_MS} matches the hub's detach grace, and
 * {@link TOMBSTONE_MAX} caps a burst of exits.
 *
 * @module computer/exit-tombstones
 */

import type { ExitedSession } from '@slayzone/computer-transport/shared'
import type { RingBuffer } from './ring-buffer'

/** The hub's `DETACH_GRACE_MS`: past it, no hub is still tracking the session. */
export const TOMBSTONE_TTL_MS = 10 * 60_000
export const TOMBSTONE_MAX = 64

export interface ExitTombstone {
  spawnId?: string
  pid?: number
  exitCode: number | null
  signal: string | null
  reason?: string
  /** Undelivered output, kept only when the exit itself was not delivered. */
  buffer?: RingBuffer
}

interface Stored extends ExitTombstone {
  at: number
}

export class ExitTombstones {
  private readonly bySession = new Map<string, Stored>()

  add(sessionId: string, tombstone: ExitTombstone): void {
    // Re-insert so iteration order stays oldest-first for eviction.
    this.bySession.delete(sessionId)
    this.bySession.set(sessionId, { ...tombstone, at: Date.now() })
    while (this.bySession.size > TOMBSTONE_MAX) {
      const oldest = this.bySession.keys().next().value
      if (oldest === undefined) break
      this.bySession.delete(oldest)
    }
  }

  get(sessionId: string): ExitTombstone | undefined {
    this.prune()
    return this.bySession.get(sessionId)
  }

  /** Did THIS spawn attempt already run and exit? (A keyless spawn never matches.) */
  ran(sessionId: string, spawnId: string | undefined): boolean {
    if (spawnId === undefined) return false
    return this.get(sessionId)?.spawnId === spawnId
  }

  /** Wire form for `pty.list` / `proc.list`. */
  list(): ExitedSession[] {
    this.prune()
    return [...this.bySession].map(([sessionId, t]) => ({
      sessionId,
      ...(t.spawnId !== undefined ? { spawnId: t.spawnId } : {}),
      ...(t.pid !== undefined ? { pid: t.pid } : {}),
      exitCode: t.exitCode,
      signal: t.signal,
      ...(t.reason !== undefined ? { reason: t.reason } : {})
    }))
  }

  private prune(): void {
    const cutoff = Date.now() - TOMBSTONE_TTL_MS
    for (const [sessionId, t] of this.bySession) {
      // Insertion order is age order, so the first fresh one ends the sweep.
      if (t.at > cutoff) break
      this.bySession.delete(sessionId)
    }
  }
}
