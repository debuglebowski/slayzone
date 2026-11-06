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
  claudeTranscriptExists,
  computeSyncQueryResponse,
  filterBufferData,
  getAdapter,
  PtyOutputDetector,
  SESSION_ERROR_WINDOW_MS,
  type PtyOutputDetection,
  type TerminalTheme
} from '@slayzone/terminal/pty-detection'
// Its own entry: the headless xterm it loads stays out of the lean detection entry,
// which half the codebase imports (through the computer-transport frames).
import { TerminalReplyMirror } from '@slayzone/terminal/reply-mirror'
import type {
  PtyDetectedSnapshot,
  PtyDetectionParams,
  PtySignalPayload
} from '@slayzone/computer-transport/shared'

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
  /** What the output has said so far (`pty.list`, for a hub reattaching). */
  snapshot(): PtyDetectedSnapshot
  /** Detect output that predates this pipeline (a warm session's) into the snapshot. */
  absorb(text: string): void
  /** `/status` was submitted: look for a conversation id in the next output. */
  watchConversationId(): void
  /** The hub's terminal theme changed (OSC colour query answers). */
  setTheme(theme: TerminalTheme): void
  /** The terminal was resized: the screen mirror answers at the new size. */
  resize(cols: number, rows: number): void
  /**
   * The process exited. A resume that failed gets its cause reported (before the
   * exit frame): its transcript is gone from THIS disk, or `output` (the replay
   * buffer) carries the provider's error — the checks the hub used to run itself.
   */
  exited(exitCode: number | null, output: string): void
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
  /**
   * The terminal's size: queries whose answer depends on terminal STATE (CPR,
   * DECRQM, DECRQSS) are answered from a headless screen mirror of this size, in
   * stream order with the stateless ones — what the hub does for the sessions it
   * runs the pipeline for (`TerminalReplyMirror`). The renderer no longer answers
   * them. Default 80×24.
   */
  size?: { cols: number; rows: number }
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
  const mirror = new TerminalReplyMirror(opts.size?.cols ?? 80, opts.size?.rows ?? 24, respond)
  let lastClockSignalAt = -Infinity
  let trailing: { seq: number; at: number } | null = null
  let trailingTimer: ReturnType<typeof setTimeout> | undefined
  let watchTimer: ReturnType<typeof setTimeout> | undefined
  let lastSeq = -1
  let disposed = false
  let reportedError = false
  let sentFirst = false
  const current: PtyDetectedSnapshot = {
    activity: null,
    title: null,
    prompt: null,
    devServerUrls: [],
    conversationId: null,
    error: null
  }
  /** Fold one chunk's detection into {@link current}, as the hub's mirror does. */
  const remember = (d: PtyOutputDetection): void => {
    if (d.activity) {
      current.activity = d.activity
      if (d.activity === 'working') current.prompt = null
      if (d.activity !== 'unknown') current.error = null
    }
    if (d.error) current.error = d.error
    if (d.prompt) current.prompt = d.prompt
    if (d.title) current.title = d.title
    for (const url of d.devServerUrls) current.devServerUrls.push(url)
    if (d.conversationId) current.conversationId = d.conversationId
  }
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
          current.conversationId = id
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

  const send = (
    seq: number,
    d: PtyOutputDetection | null,
    exitError?: PtyOutputDetection['error'],
    idleClockAgoMs?: number,
    firstOutput?: true
  ): void => {
    const spawnId = ids.spawnId()
    emit({
      sessionId: ids.sessionId(),
      ...(spawnId !== undefined ? { spawnId } : {}),
      ...(firstOutput ? { firstOutput } : {}),
      ...(idleClockAgoMs ? { idleClockAgoMs } : {}),
      ...(exitError ? { exitError } : {}),
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
    const { seq, at } = trailing
    trailing = null
    lastClockSignalAt = now()
    send(seq, null, undefined, lastClockSignalAt - at)
  }

  return {
    process(data) {
      const { parts, forwarded, pendingPartial } = computeSyncQueryResponse(
        syncPending + data,
        theme
      )
      syncPending = pendingPartial
      // Every part, in order: stateless replies and the mirror's answers alike.
      mirror.apply(parts)
      return { clean: filterBufferData(forwarded), detection: detector.detect(forwarded) }
    },
    report(d, seq) {
      lastSeq = seq
      remember(d)
      if (!diskPollStarted) startDiskPoll()
      if (d.error) reportedError = true
      if (d.conversationId && watchTimer) {
        clearTimeout(watchTimer)
        watchTimer = undefined
      }
      if (!sentFirst) {
        // Always told: the hub learns the process started even when it gets no bytes.
        sentFirst = true
        if (d.refreshIdleClock) lastClockSignalAt = now()
        send(seq, d, undefined, undefined, true)
        return
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
      trailing = { seq, at: now() }
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
    snapshot() {
      return { ...current, devServerUrls: [...current.devServerUrls] }
    },
    absorb(text) {
      if (!diskPollStarted) startDiskPoll()
      const { detection } = this.process(text)
      if (detection.error) reportedError = true
      remember(detection)
    },
    exited(exitCode, output) {
      if (!params.resuming || reportedError || disposed) return
      // DISK TRUTH first: deterministic, needs no output (a fast exit can beat the
      // "No conversation found" line). Then the exit-code-agnostic string scan.
      // The hub's spawn-time lookup searched every project dir (a session can move
      // into a worktree's); 'unknown' defers to the scan. Not looked up: this disk,
      // beside the cwd.
      const transcriptGone =
        params.mode === 'claude-code' &&
        exitCode !== 0 &&
        !!params.resumeConversationId &&
        (params.resumeTranscript !== undefined
          ? params.resumeTranscript === 'missing'
          : !!disk && !claudeTranscriptExists(disk.cwd, params.resumeConversationId))
      const cause = transcriptGone
        ? { code: 'SESSION_NOT_FOUND', message: 'Session not found', recoverable: false }
        : detector.adapter.detectError(output)
      if (!cause) return
      reportedError = true
      send(lastSeq, EMPTY, cause)
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
    resize(cols, rows) {
      mirror.resize(cols, rows)
    },
    dispose() {
      disposed = true
      mirror.dispose()
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
