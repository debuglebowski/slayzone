/**
 * Output detection for one pty, run where the output is: the computer.
 *
 * The hub spawns a session with `detection` (mode, patterns, resuming); this runs the
 * SAME `PtyOutputDetector` the hub used to run over every chunk, and reports what it
 * finds as small `pty-signal` events. The hub's state machine mirrors those instead
 * of parsing a copy of the output.
 *
 * Detection sees the chunk the way the hub's did: with timing-critical terminal
 * queries (DA/DSR/CPR/OSC colour queries) already taken out, so a query is never
 * mistaken for agent output. Whoever answers those queries, the forwarded text is
 * the same (`computeSyncQueryResponse` is pure).
 *
 * A chunk that only refreshes the silence (idle) clock — a plain shell's every
 * redraw — is coalesced to at most one signal per {@link IDLE_CLOCK_SIGNAL_MS}
 * (leading + trailing edge), so a busy shell does not double its frame rate.
 *
 * @module computer/pty-signals
 */
import {
  CONVERSATION_ID_WATCH_TIMEOUT_MS,
  computeSyncQueryResponse,
  getAdapter,
  PtyOutputDetector,
  SESSION_ERROR_WINDOW_MS,
  type PtyOutputDetection,
  type TerminalTheme
} from '@slayzone/terminal/pty-detection'
import type { PtyDetectionParams, PtySignalPayload } from '@slayzone/computer-transport/shared'

export const IDLE_CLOCK_SIGNAL_MS = 500

/** Any theme: the forwarded text of `computeSyncQueryResponse` does not depend on it. */
const NO_THEME: TerminalTheme = { foreground: '#ffffff', background: '#000000', cursor: '#ffffff' }

export interface PtySignalSink {
  (payload: PtySignalPayload): void
}

export interface PtySessionSignals {
  /** Run detection over one raw output chunk (as streamed under `seq`). */
  onOutput(data: string, seq: number): void
  /** `/status` was submitted: look for a conversation id in the next output. */
  watchConversationId(): void
  dispose(): void
}

interface Ids {
  sessionId: () => string
  spawnId: () => string | undefined
}

function says(d: PtyOutputDetection): boolean {
  return (
    d.activity !== null ||
    d.error !== null ||
    d.prompt !== null ||
    d.title !== null ||
    d.devServerUrls.length > 0 ||
    d.conversationId !== null
  )
}

export function createPtySessionSignals(
  params: PtyDetectionParams,
  ids: Ids,
  emit: PtySignalSink,
  now: () => number = Date.now
): PtySessionSignals {
  const detector = new PtyOutputDetector({
    adapter: getAdapter({ mode: params.mode, type: params.type, patterns: params.patterns }),
    mode: params.mode,
    resuming: params.resuming
  })
  let syncPending = ''
  let lastClockSignalAt = -Infinity
  let trailing: { seq: number } | null = null
  let trailingTimer: ReturnType<typeof setTimeout> | undefined
  let watchTimer: ReturnType<typeof setTimeout> | undefined
  // The stale-resume window opens at the real process start — here.
  let errorWindow: ReturnType<typeof setTimeout> | undefined = params.resuming
    ? setTimeout(() => {
        detector.checkingForSessionError = false
        errorWindow = undefined
      }, SESSION_ERROR_WINDOW_MS)
    : undefined
  errorWindow?.unref?.()

  const send = (seq: number, d: PtyOutputDetection | null): void => {
    const spawnId = ids.spawnId()
    emit({
      sessionId: ids.sessionId(),
      ...(spawnId !== undefined ? { spawnId } : {}),
      seq,
      activity: d?.activity ?? null,
      refreshIdleClock: d ? d.refreshIdleClock : true,
      preview: d?.preview ?? '',
      error: d?.error ?? null,
      suppressOutput: d?.suppressOutput ?? false,
      prompt: d?.prompt ?? null,
      title: d?.title ?? null,
      devServerUrls: d?.devServerUrls ?? [],
      conversationId: d?.conversationId ?? null
    })
  }

  const flushTrailing = (): void => {
    trailingTimer = undefined
    if (!trailing) return
    const { seq } = trailing
    trailing = null
    lastClockSignalAt = now()
    send(seq, null)
  }

  return {
    onOutput(data, seq) {
      const { forwarded, pendingPartial } = computeSyncQueryResponse(syncPending + data, NO_THEME)
      syncPending = pendingPartial
      const d = detector.detect(forwarded)
      if (d.conversationId && watchTimer) {
        clearTimeout(watchTimer)
        watchTimer = undefined
      }
      if (says(d)) {
        if (d.refreshIdleClock) {
          lastClockSignalAt = now()
          trailing = null
        }
        send(seq, d)
        return
      }
      if (!d.refreshIdleClock) return
      if (now() - lastClockSignalAt >= IDLE_CLOCK_SIGNAL_MS) {
        lastClockSignalAt = now()
        trailing = null
        send(seq, d)
        return
      }
      trailing = { seq }
      if (!trailingTimer) {
        trailingTimer = setTimeout(
          flushTrailing,
          IDLE_CLOCK_SIGNAL_MS - (now() - lastClockSignalAt)
        )
        trailingTimer.unref?.()
      }
    },
    watchConversationId() {
      detector.watchConversationId()
      if (watchTimer) clearTimeout(watchTimer)
      watchTimer = setTimeout(() => {
        watchTimer = undefined
        detector.stopWatchingConversationId()
      }, CONVERSATION_ID_WATCH_TIMEOUT_MS)
      watchTimer.unref?.()
    },
    dispose() {
      if (trailingTimer) clearTimeout(trailingTimer)
      if (watchTimer) clearTimeout(watchTimer)
      if (errorWindow) clearTimeout(errorWindow)
      trailingTimer = watchTimer = errorWindow = undefined
      trailing = null
    }
  }
}
