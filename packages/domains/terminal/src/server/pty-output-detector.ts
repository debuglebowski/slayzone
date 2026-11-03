import { DEV_SERVER_URL_PATTERN, extractOscTitle } from '@slayzone/terminal-contracts'
import type { ActivityState, ErrorInfo, PromptInfo, TerminalAdapter } from './adapters/types'
import { shouldRefreshIdleClock } from './state-machine'
import { shouldHonorDetectedError } from './session-error-gate'

/** What one chunk of pty output says, as data. Deciding state is the caller's job. */
export interface PtyOutputDetection {
  /** Adapter-detected activity, or null when the chunk says nothing. */
  activity: ActivityState | null
  /** Whether this chunk counts as output for the silence (idle) clock. */
  refreshIdleClock: boolean
  /** ANSI-stripped head of the chunk, for transition-trigger diagnostics. */
  preview: string
  /** An adapter error that passed the session-error gate, or null. */
  error: ErrorInfo | null
  /** The error says: hide this session's further output (stale resume). */
  suppressOutput: boolean
  /** A prompt the agent is waiting on (needs-attention UI). */
  prompt: PromptInfo | null
  /** OSC window title (agent modes only; plain terminals ignore it). */
  title: string | null
  /** Dev-server URLs seen for the FIRST time in this session, normalized. */
  devServerUrls: string[]
  /** Conversation id parsed from `/status`-style output while watching for it. */
  conversationId: string | null
}

export interface PtyOutputDetectorOptions {
  adapter: TerminalAdapter
  mode: string
  /** Spawned to resume a conversation: opens the stale-resume error window. */
  resuming: boolean
}

/** How long after a resuming process starts a stale-resume error still counts. */
export const SESSION_ERROR_WINDOW_MS = 5_000
/** How long after `/status` is submitted its output is searched for a conversation id. */
export const CONVERSATION_ID_WATCH_TIMEOUT_MS = 5_000

export function stripAnsiForSessionParse(data: string): string {
  return data
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences
    .replace(/\x1b\[[?0-9;:]*[ -/]*[@-~]/g, '') // CSI sequences
    .replace(/\x1b[()][AB012]/g, '') // Character set sequences
}

const LABELED_SESSION_ID =
  /\bsession(?:\s*id)?:\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/im
const ANY_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/**
 * Per-session detection over raw pty output (after terminal sync-query answers are
 * stripped): activity, errors, prompts, OSC title, dev-server URLs, conversation id.
 * Pure apart from its own small per-session memory (seen URLs, the `/status` watch,
 * the stale-resume window), so the hub and the computer run the same logic.
 */
export class PtyOutputDetector {
  readonly adapter: TerminalAdapter
  readonly mode: string
  private readonly resuming: boolean
  /** Inside the resume startup window: SESSION_NOT_FOUND / SESSION_IN_USE count. */
  checkingForSessionError: boolean
  private readonly seenDevUrls = new Set<string>()
  private watching = false
  private statusOutput = ''

  constructor(opts: PtyOutputDetectorOptions) {
    this.adapter = opts.adapter
    this.mode = opts.mode
    this.resuming = opts.resuming
    this.checkingForSessionError = opts.resuming
  }

  /** Start collecting output to parse a conversation id from (`/status` was sent). */
  watchConversationId(): void {
    this.watching = true
    this.statusOutput = ''
  }

  stopWatchingConversationId(): void {
    this.watching = false
    this.statusOutput = ''
  }

  get watchingConversationId(): boolean {
    return this.watching
  }

  detect(data: string): PtyOutputDetection {
    const adapter = this.adapter
    const activity = adapter.detectActivity(data, 'unknown')
    let error: ErrorInfo | null = null
    let suppressOutput = false
    const detectedError = adapter.detectError(data)
    if (
      detectedError &&
      shouldHonorDetectedError(detectedError.code, this.checkingForSessionError)
    ) {
      error = detectedError
      this.checkingForSessionError = false
      suppressOutput =
        this.resuming &&
        (detectedError.code === 'SESSION_NOT_FOUND' || detectedError.code === 'SESSION_IN_USE')
    }
    return {
      activity,
      refreshIdleClock: shouldRefreshIdleClock(adapter, activity),
      preview:
        activity || error
          ? stripAnsiForSessionParse(data).slice(0, 200).replace(/\s+/g, ' ').trim()
          : '',
      error,
      suppressOutput,
      prompt: adapter.detectPrompt(data),
      title: this.mode !== 'terminal' ? extractOscTitle(data) || null : null,
      devServerUrls: this.newDevServerUrls(data),
      conversationId: this.watching ? this.parseConversationId(data) : null
    }
  }

  private newDevServerUrls(data: string): string[] {
    DEV_SERVER_URL_PATTERN.lastIndex = 0
    const matches = data.match(DEV_SERVER_URL_PATTERN)
    if (!matches) return []
    const fresh: string[] = []
    for (const url of matches) {
      const normalized = url.replace('0.0.0.0', 'localhost')
      if (this.seenDevUrls.has(normalized)) continue
      this.seenDevUrls.add(normalized)
      fresh.push(normalized)
    }
    return fresh
  }

  private parseConversationId(data: string): string | null {
    this.statusOutput += data
    let id: string | null = null
    if (this.adapter.detectConversationId) {
      id = this.adapter.detectConversationId(this.statusOutput)
    } else {
      const normalized = stripAnsiForSessionParse(this.statusOutput)
      const match = normalized.match(LABELED_SESSION_ID) ?? normalized.match(ANY_UUID)
      if (match) id = match[1] ?? match[0]
    }
    if (id) this.stopWatchingConversationId()
    return id
  }
}
