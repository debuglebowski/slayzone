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

function isMissingProcedure(e: unknown): boolean {
  const err = e as { data?: { code?: string }; message?: string } | null
  if (err?.data?.code === 'NOT_FOUND') return true
  return typeof err?.message === 'string' && /No ["']?query["']?-procedure|not found/i.test(err.message)
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
}
