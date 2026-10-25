import type { TerminalState } from '@slayzone/terminal/shared'

/** What a terminal needs when it (re)attaches to its session. */
export interface PtyAttachResult {
  exists: boolean
  state: TerminalState | null
  buffer: {
    chunks: Array<{ seq: number; data: string }>
    currentSeq: number
    prelude?: string
  } | null
}

/** The slice of the tRPC client this helper calls. */
export interface PtyAttachClient {
  pty: {
    attach: {
      query: (input: { sessionId: string; afterSeq: number }) => Promise<PtyAttachResult>
    }
    exists: { query: (input: { sessionId: string }) => Promise<boolean> }
    getState: { query: (input: { sessionId: string }) => Promise<TerminalState | null> }
    getBufferSince: {
      query: (input: { sessionId: string; afterSeq: number }) => Promise<PtyAttachResult['buffer']>
    }
  }
}

// Set once a server answered without `pty.attach` (a sidecar/hub older than this
// renderer — the dev sidecar is not restarted on a renderer reload). Every later
// attach goes straight to the legacy three-call path.
let attachUnsupported = false

/**
 * How long an unspawned mark is trusted. The create and the first attach are one
 * user action (well under a second); past this the mark is ignored, so a mark
 * whose terminal never mounted cannot hide a session spawned much later.
 */
export const UNSPAWNED_MARK_TTL_MS = 10_000

// Sessions this renderer KNOWS have no PTY yet: the main tab of a task it created
// this instant to open it. Only the renderer spawns a task PTY (`pty.create`), so
// the first attach for one can only answer "absent" — skip asking.
const unspawned = new Map<string, number>()

/**
 * Mark `sessionId` as having no PTY yet, so its next `attachPty` answers "absent"
 * without a round trip. One-shot: consumed by that attach.
 */
export function markSessionUnspawned(sessionId: string, at: number = Date.now()): void {
  unspawned.set(sessionId, at)
}

/**
 * Whether `sessionId` is marked as having no PTY yet (a live, unexpired mark).
 * Does not consume the mark — the session's first `attachPty` still does.
 */
export function isSessionKnownUnspawned(sessionId: string): boolean {
  const at = unspawned.get(sessionId)
  return at !== undefined && Date.now() - at <= UNSPAWNED_MARK_TTL_MS
}

function consumeUnspawned(sessionId: string): boolean {
  const at = unspawned.get(sessionId)
  if (at === undefined) return false
  unspawned.delete(sessionId)
  return Date.now() - at <= UNSPAWNED_MARK_TTL_MS
}

function isMissingProcedure(e: unknown): boolean {
  const err = e as { data?: { code?: string }; message?: string } | null
  if (err?.data?.code === 'NOT_FOUND') return true
  return (
    typeof err?.message === 'string' && /No ["']?query["']?-procedure|not found/i.test(err.message)
  )
}

/**
 * exists + state + buffer-after-`afterSeq` for a session in ONE round trip
 * (`pty.attach`). Falls back to the three serial calls it replaces when the
 * server predates it, so a renderer/server version skew degrades to the old
 * latency instead of a terminal that fails to start.
 */
export async function attachPty(
  client: PtyAttachClient,
  sessionId: string,
  afterSeq: number
): Promise<PtyAttachResult> {
  if (consumeUnspawned(sessionId)) return { exists: false, state: null, buffer: null }
  if (!attachUnsupported) {
    try {
      return await client.pty.attach.query({ sessionId, afterSeq })
    } catch (e) {
      if (!isMissingProcedure(e)) throw e
      attachUnsupported = true
    }
  }
  const exists = await client.pty.exists.query({ sessionId })
  const state = await client.pty.getState.query({ sessionId })
  const buffer = await client.pty.getBufferSince.query({ sessionId, afterSeq })
  return { exists, state, buffer }
}

/** Test seam. */
export function __resetPtyAttachForTest(): void {
  attachUnsupported = false
  unspawned.clear()
}
