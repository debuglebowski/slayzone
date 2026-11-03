/**
 * The output pipeline for one pty, run where the output is: the computer.
 *
 * The hub spawns a session with `detection` (mode, patterns, resuming, theme); this
 * runs the SAME steps the hub used to run over every chunk:
 *  1. answer timing-critical terminal queries (DA/DSR/CPR/OSC colour) at once, with
 *     the hub's terminal theme — an answer that waits for a network round-trip lands
 *     after the program moved on and shows up as garbage in its input;
 *  2. `PtyOutputDetector` over what is left, reported as small `pty-signal` events
 *     the hub's state machine mirrors;
 *  3. `filterBufferData`, giving the bytes that are buffered and streamed (one copy
 *     for both, so a seq's bytes never depend on the delivery path).
 *
 * A chunk that only refreshes the silence (idle) clock — a plain shell's every
 * redraw — is coalesced to at most one signal per {@link IDLE_CLOCK_SIGNAL_MS}
 * (leading + trailing edge), so a busy shell does not double its frame rate.
 *
 * @module computer/pty-signals
 */
import {
  CONVERSATION_ID_WATCH_TIMEOUT_MS,
  DISK_SESSION_POLL_ATTEMPTS,
  DISK_SESSION_POLL_MS,
  computeSyncQueryResponse,
  filterBufferData,
  getAdapter,
  PtyOutputDetector,
  SESSION_ERROR_WINDOW_MS,
  type PtyOutputDetection,
  type TerminalTheme
} from '@slayzone/terminal/pty-detection'
import type { PtyDetectionParams, PtySignalPayload } from '@slayzone/computer-transport/shared'

export const IDLE_CLOCK_SIGNAL_MS = 500

const EMPTY: PtyOutputDetection = {
  activity: null,
  refreshIdleClock: false,
  preview: '',
  error: null,
  suppressOutput: false,
  prompt: null,
  title: null,
  devServerUrls: [],
  conversationId: null
}

/** Until the hub says otherwise: xterm.js's own defaults. */
const DEFAULT_THEME: TerminalTheme = {
  foreground: '#ffffff',
  background: '#000000',
  cursor: '#ffffff'
}

export interface PtySignalSink {
  (payload: PtySignalPayload): void
}

export interface PtySessionSignals {
  /**
   * One raw chunk in: queries answered (via `respond`), detection run. Returns the
   * bytes to buffer and stream, and the detection to {@link report} under the seq
   * those bytes are buffered as.
   */
  process(data: string): { clean: string; detection: PtyOutputDetection }
  report(detection: PtyOutputDetection, seq: number): void
  /** `/status` was submitted: look for a conversation id in the next output. */
  watchConversationId(): void
  /** The hub's terminal theme changed (OSC colour query answers). */
  setTheme(theme: TerminalTheme): void
  dispose(): void
}

interface Ids {
  sessionId: () => string
  spawnId: () => string | undefined
}

/** Where and when the process started: what disk conversation-id detection matches on. */
export interface PtyDiskSessionContext {
  cwd: string
  startedAt: number
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

export interface PtySessionSignalsOptions {
  params: PtyDetectionParams
  ids: Ids
  emit: PtySignalSink
  /** Write a terminal-query answer to the process, synchronously when possible. */
  respond: (answer: string) => void
  now?: () => number
  disk?: PtyDiskSessionContext
}

export function createPtySessionSignals(opts: PtySessionSignalsOptions): PtySessionSignals {
  const { params, ids, emit, respond, disk } = opts
  const now = opts.now ?? Date.now
  let theme: TerminalTheme = params.theme ?? DEFAULT_THEME
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
  let lastSeq = -1
  let disposed = false
  let diskPoll: ReturnType<typeof setInterval> | undefined
  let diskPollStarted = false
  /**
   * Some providers (codex) write the conversation id to THIS machine's disk rather
   * than printing it. Polled after the first output — the CLI may not write the
   * file until its first API handshake — as the hub used to, against the cwd the
   * process really runs in.
   */
  const startDiskPoll = (): void => {
    diskPollStarted = true
    const detectFromDisk = detector.adapter.detectSessionFromDisk
    if (!detectFromDisk || detector.resuming || !disk) return
    let attempts = 0
    let found = false
    const stop = (): void => {
      if (diskPoll) clearInterval(diskPoll)
      diskPoll = undefined
    }
    diskPoll = setInterval(() => {
      attempts++
      if (attempts >= DISK_SESSION_POLL_ATTEMPTS) stop()
      detectFromDisk
        .call(detector.adapter, disk.startedAt, disk.cwd)
        .then((id) => {
          if (!id || found || disposed) return
          found = true
          stop()
          send(lastSeq, { ...EMPTY, conversationId: id })
        })
        .catch(() => {
          // Unreadable session dir: try again next tick.
        })
    }, DISK_SESSION_POLL_MS)
    diskPoll.unref?.()
  }
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
    process(data) {
      const { response, forwarded, pendingPartial } = computeSyncQueryResponse(
        syncPending + data,
        theme
      )
      syncPending = pendingPartial
      if (response) respond(response)
      return { clean: filterBufferData(forwarded), detection: detector.detect(forwarded) }
    },
    report(d, seq) {
      lastSeq = seq
      if (!diskPollStarted) startDiskPoll()
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
    setTheme(next) {
      theme = next
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
      disposed = true
      if (trailingTimer) clearTimeout(trailingTimer)
      if (watchTimer) clearTimeout(watchTimer)
      if (errorWindow) clearTimeout(errorWindow)
      if (diskPoll) clearInterval(diskPoll)
      trailingTimer = watchTimer = errorWindow = undefined
      diskPoll = undefined
      trailing = null
    }
  }
}
