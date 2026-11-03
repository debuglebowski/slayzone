/**
 * What opened an agent-started turn, for ONE Claude Code process.
 *
 * A background task tells the agent something with a `<task-notification>`: a
 * Monitor reported a line, a background command or sub-agent ended. The CLI
 * queues it as a hidden user message and, between turns, answers it with a turn
 * of its own. The stream-json output never carries that message (only the
 * turn's `init`, then the reply), so the chat could not say why the agent spoke.
 * The CLI does write it to its session file — as a `user` record with
 * `origin.kind: "task-notification"`, ~30–100 ms AFTER the turn's `init`
 * (measured on 2.1.316) and long before the reply's first output.
 *
 * So from each turn's `init` until its first output, this reads what the CLI
 * appended to the session file and emits a `background-notification` for every
 * such record no main-chain `assistant` record follows (one followed is already
 * answered: the CLI folded it into a turn that ran). Records older than this
 * process are its predecessor's (a resumed conversation's past): skipped. The
 * timeline names the pending ones above the agent-started turn they opened; a
 * user's turn (or a turn's end) drops them.
 *
 * @module agents/claude-task-notifications
 */
import { open } from 'node:fs/promises'
import type { AgentEvent, BackgroundNotificationEvent } from '@slayzone/terminal-contracts'
import { claudeTranscriptPath, locateClaudeTranscript } from '../claude-transcripts'

/** A turn's cause is in the file well within this; past it, stop looking. */
const TURN_READ_LIMIT_MS = 15_000
/** Read at most this much of a session file at once (its newest part). */
const MAX_READ_BYTES = 1024 * 1024
const POLL_INTERVAL_MS = 50

export interface TaskNotificationsIo {
  emit(event: AgentEvent): void
  /** When this process started (host clock): older records are not its own. */
  startedAt: number
  /** The session file of `sessionId` run in `cwd` (default: the CLI's own path). */
  pathOf?: (cwd: string, sessionId: string) => string
  /** 0 = never on a timer (tests call `poll`). */
  intervalMs?: number
}

const TAG = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)
const tag = (text: string, name: string): string | undefined => {
  const value = TAG(name).exec(text)?.[1]?.trim()
  return value ? value : undefined
}

function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const parts = content.flatMap((block) =>
    block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
      ? [String((block as { text?: unknown }).text ?? '')]
      : []
  )
  return parts.length > 0 ? parts.join('\n') : null
}

/** A session-file record → its notification, or null when it is not one. */
export function parseTaskNotification(record: unknown): BackgroundNotificationEvent | null {
  if (!record || typeof record !== 'object') return null
  const r = record as Record<string, unknown>
  if (r.type !== 'user' || r.isSidechain === true || typeof r.uuid !== 'string') return null
  const text = textOf((r.message as { content?: unknown } | undefined)?.content)
  if (text === null) return null
  const origin = r.origin as { kind?: unknown } | undefined
  const isNotification =
    origin?.kind === 'task-notification' || text.trimStart().startsWith('<task-notification>')
  if (!isNotification) return null
  const taskId = tag(text, 'task-id')
  const summary = tag(text, 'summary')
  if (!taskId || !summary) return null
  const toolUseId = tag(text, 'tool-use-id')
  const status = tag(text, 'status')
  const event = tag(text, 'event')
  return {
    kind: 'background-notification',
    uuid: r.uuid,
    taskId,
    ...(toolUseId ? { toolUseId } : {}),
    ...(status ? { status } : {}),
    summary,
    ...(event ? { event } : {})
  }
}

export class ClaudeTaskNotifications {
  private path: string | null = null
  /** The session the path is for — to find its file if it moved folders. */
  private target: { cwd: string; sessionId: string } | null = null
  /** Byte offset of the next unread line of `path`. */
  private offset = 0
  /** An incomplete last line, completed by the next read. */
  private partial = ''
  /** Notifications no assistant record answered (yet). */
  private candidates: BackgroundNotificationEvent[] = []
  private readonly emitted = new Set<string>()
  private reading = false
  private readUntil = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private inflight: Promise<void> | null = null
  private disposed = false

  constructor(private readonly io: TaskNotificationsIo) {}

  /** A turn's `init`: read what the CLI appends until the turn's first output. */
  turnStarted(cwd: string, sessionId: string): void {
    if (this.disposed || !sessionId) return
    // Same session as last turn: keep the file found then (it may have been
    // located under another project dir; a failed open re-locates it).
    const same = this.target?.cwd === cwd && this.target.sessionId === sessionId
    const path =
      same && this.path ? this.path : (this.io.pathOf ?? claudeTranscriptPath)(cwd, sessionId)
    this.target = { cwd, sessionId }
    if (path !== this.path) {
      this.path = path
      this.offset = -1 // set on the first read: the file's newest part
      this.partial = ''
      this.candidates = []
    }
    this.reading = true
    this.readUntil = Date.now() + TURN_READ_LIMIT_MS
    const interval = this.io.intervalMs ?? POLL_INTERVAL_MS
    if (interval > 0 && !this.timer) {
      this.timer = setInterval(() => void this.poll(), interval)
      this.timer.unref?.()
    }
    void this.poll()
  }

  /** The turn's first output, its end, or the process's: its cause is known by now. */
  turnOutput(): void {
    this.reading = false
    this.stopTimer()
  }

  /** Read what was appended since the last read (one read at a time). */
  poll(): Promise<void> {
    if (!this.reading || this.disposed || !this.path) return Promise.resolve()
    if (Date.now() > this.readUntil) {
      this.turnOutput()
      return Promise.resolve()
    }
    // A read already running may have started before the newest append.
    if (this.inflight) return this.inflight.then(() => this.poll())
    const run = this.readAppended().catch(() => {
      /* no session file yet, or it vanished: nothing to name */
    })
    this.inflight = run.finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  dispose(): void {
    this.disposed = true
    this.reading = false
    this.stopTimer()
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async readAppended(): Promise<void> {
    const path = this.path
    if (!path) return
    let handle: Awaited<ReturnType<typeof open>>
    try {
      handle = await open(path, 'r')
    } catch (err) {
      // Not where the cwd says: a session that used EnterWorktree keeps its file
      // only under the worktree's project dir. Follow it (default lookup only).
      const target = this.target
      if (this.io.pathOf || !target) throw err
      const found = await locateClaudeTranscript(target.sessionId, target.cwd)
      if (!found || found.path === path || this.path !== path || this.disposed) throw err
      this.path = found.path
      this.offset = -1
      this.partial = ''
      this.candidates = []
      return this.readAppended()
    }
    let chunk: string
    try {
      const { size } = await handle.stat()
      if (this.offset < 0 || size < this.offset) {
        // First read of this file (or it was rewritten): its newest part.
        this.offset = Math.max(0, size - MAX_READ_BYTES)
        this.partial = ''
        this.candidates = []
      } else if (size - this.offset > MAX_READ_BYTES) {
        this.offset = size - MAX_READ_BYTES
        this.partial = ''
      }
      if (size === this.offset) return
      const buffer = Buffer.alloc(size - this.offset)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset)
      this.offset += bytesRead
      chunk = buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
    if (path !== this.path || this.disposed) return
    const lines = (this.partial + chunk).split('\n')
    this.partial = lines.pop() ?? ''
    for (const line of lines) this.take(line)
    for (const notification of this.candidates) {
      if (this.emitted.has(notification.uuid)) continue
      this.emitted.add(notification.uuid)
      this.io.emit(notification)
    }
  }

  /** One complete session-file line. */
  private take(line: string): void {
    const isAssistant = line.includes('"type":"assistant"')
    if (!isAssistant && !line.includes('task-notification')) return
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line) as Record<string, unknown>
    } catch {
      return // a line cut by a skipped-ahead offset
    }
    if (record.type === 'assistant') {
      if (record.isSidechain !== true) this.candidates = []
      return
    }
    const notification = parseTaskNotification(record)
    if (!notification) return
    const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN
    if (!(at >= this.io.startedAt)) return
    this.candidates.push(notification)
  }
}
