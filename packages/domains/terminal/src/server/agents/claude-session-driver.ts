/**
 * ClaudeSessionDriver — stateful per-spawn wrapper around the stateless
 * `claudeCodeAdapter`. Owns the Claude half of the chat control protocol:
 * correlating the host's own control_requests with their responses, and the
 * CLI's inbound requests (prompts) with the host's answers.
 *
 * Prompts: every `can_use_tool` (ExitPlanMode and AskUserQuestion included)
 * reaches the timeline as `permission-request` and stays pending here until
 * the host answers it (`permission-resolved`, persisted) or the CLI withdraws
 * it (`permission-cancelled`). Only a pending request can be answered, so a
 * stale card (reload after the process was replaced) or a second click can't
 * write a reply the CLI would ignore — or worse, misattribute.
 *
 * @module agents/claude-session-driver
 */
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type {
  AgentEvent,
  CommandTaskOutput,
  CliCommandDetailsEvent,
  OutgoingUserMessage,
  PermissionDecision
} from '@slayzone/terminal-contracts'
import { claudeCodeAdapter } from './claude-code-adapter'
import { ClaudeCommandTasks } from './claude-command-tasks'
import {
  buildClaudeContent,
  getChatAttachmentReader,
  type ChatAttachmentReader
} from './claude-content'
import type { AgentBackend, ChatDriverContext, ChatSessionDriver, PreparedUserTurn } from './types'

/**
 * How long the `initialize` reply may take. It only adds command descriptions
 * and argument hints (the CLI answers in well under a second, before its first
 * `init`), so a missing reply costs nothing but those.
 */
const INITIALIZE_TIMEOUT_MS = 10_000

/** `commands[]` of an `initialize` reply, well-formed entries only. */
function initializeCommands(data: unknown): CliCommandDetailsEvent['commands'] | null {
  const body = asRecord(data)
  const reply = asRecord(body.response ?? body)
  if (!Array.isArray(reply.commands)) return null
  const out: CliCommandDetailsEvent['commands'] = []
  for (const raw of reply.commands) {
    const c = asRecord(raw)
    if (typeof c.name !== 'string' || !c.name) continue
    out.push({
      name: c.name,
      description: typeof c.description === 'string' ? c.description : '',
      argumentHint: typeof c.argumentHint === 'string' ? c.argumentHint : ''
    })
  }
  return out
}

interface PendingControl {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

/** A `can_use_tool` request the CLI is blocked on. */
interface PendingPrompt {
  toolName: string
  toolUseId: string
  input: unknown
  suggestions: unknown[]
}

/** Fields a user's answer may add to an AskUserQuestion input (answers + preview notes). */
const QUESTION_ANSWER_KEYS = ['answers', 'annotations'] as const

/**
 * Session-scoped mode switches a prompt row may apply besides the request's
 * own suggestions: "switch to auto mode" (Bash, plan approval) and "auto-accept
 * edits" (plan approval without auto mode).
 */
const ALLOWED_SESSION_MODES = new Set(['auto', 'acceptEdits'])

function isAllowedPermissionUpdate(entry: unknown, suggestions: unknown[]): boolean {
  if (suggestions.some((s) => isDeepStrictEqual(s, entry))) return true
  const e = entry as { type?: unknown; mode?: unknown; destination?: unknown } | null
  return (
    e?.type === 'setMode' &&
    e.destination === 'session' &&
    typeof e.mode === 'string' &&
    ALLOWED_SESSION_MODES.has(e.mode) &&
    Object.keys(e).length === 3
  )
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/**
 * The control_response body for a decision, built from what the CLI asked:
 * the input is the one the user saw (plus a question's answers), and every
 * permission update must be one the CLI suggested or an allowed mode switch.
 * Returns null for a decision this request can't carry.
 */
function buildWireDecision(
  prompt: PendingPrompt,
  decision: PermissionDecision
): PermissionDecision | null {
  if (decision.behavior === 'deny') {
    return {
      behavior: 'deny',
      message: decision.message,
      ...(decision.interrupt ? { interrupt: true } : {})
    }
  }
  const updatedInput = { ...asRecord(prompt.input) }
  if (prompt.toolName === 'AskUserQuestion') {
    const extra = asRecord(decision.updatedInput)
    for (const key of QUESTION_ANSWER_KEYS) {
      if (extra[key] !== undefined) updatedInput[key] = extra[key]
    }
  }
  const updates = decision.updatedPermissions ?? []
  if (!updates.every((u) => isAllowedPermissionUpdate(u, prompt.suggestions))) return null
  return {
    behavior: 'allow',
    updatedInput,
    ...(updates.length > 0 ? { updatedPermissions: updates } : {})
  }
}

export class ClaudeSessionDriver implements ChatSessionDriver {
  /** Claude reports delivery itself: `command_lifecycle` + the replay of the message `uuid`. */
  readonly confirmsDelivery = true
  private readonly readAttachment: ChatAttachmentReader | undefined

  constructor(opts: { readAttachment?: ChatAttachmentReader } = {}) {
    this.readAttachment = opts.readAttachment
  }
  private ctx: ChatDriverContext | null = null
  /** In-flight `control_request` promises, keyed by request_id. */
  private readonly pendingControl = new Map<string, PendingControl>()
  private controlReqCounter = 0
  /** Inbound `can_use_tool` requests awaiting the host's answer, keyed by request_id. */
  private readonly pendingPrompts = new Map<string, PendingPrompt>()
  /** Last permission mode the CLI reported (turn-init or status). */
  private permissionMode: string | null = null
  /** Commands this process runs as tasks (Bash / Monitor): live output, stop, background. */
  private readonly tasks = new ClaudeCommandTasks({
    request: (request, timeoutMs) => this.applyControl(request, timeoutMs),
    emit: (ev) => this.ctx?.emit(ev),
    now: () => Date.now()
  })

  /**
   * Asks the CLI for its slash commands with descriptions and argument hints
   * (`initialize`, as the official SDK does; it changes nothing else about the
   * session — verified on 2.1.312). Written FIRST, and start resolves once it
   * was written, so it precedes every user message on stdin. The reply arrives
   * on its own (or never: then the composer keeps names only).
   */
  start(ctx: ChatDriverContext): Promise<void> {
    this.ctx = ctx
    const { written, response } = this.issueControl(
      { subtype: 'initialize' },
      INITIALIZE_TIMEOUT_MS
    )
    response.then(
      (data) => {
        const commands = initializeCommands(data)
        if (commands && commands.length > 0)
          this.ctx?.emit({ kind: 'cli-command-details', commands })
      },
      () => {
        /* no reply, an error reply, or the session ended: names only */
      }
    )
    return written.catch(() => undefined)
  }

  handleLine(line: string): void {
    const ev = claudeCodeAdapter.parseLine(line)
    if (!ev) return

    // Control responses route to the pending sender promise — they are
    // transport plumbing, not chat timeline events.
    if (ev.kind === 'control-response') {
      const pending = this.pendingControl.get(ev.requestId)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingControl.delete(ev.requestId)
        if (ev.isError) pending.reject(new Error(ev.error ?? 'control_request failed'))
        else pending.resolve(ev.data)
      }
      return
    }

    // A request we don't implement must still be answered: the CLI blocks on
    // it (a hook callback stalls 30 s, then refuses the prompt). An error reply
    // makes it skip the hook / server and carry on.
    if (ev.kind === 'host-control-request') {
      this.writeSafely(
        claudeCodeAdapter.serializeControlResponse?.({
          requestId: ev.requestId,
          isError: true,
          error: `SlayZone does not handle control request "${ev.subtype}"`
        })
      )
      return
    }

    // A task frame becomes a command task or a sub-agent — or nothing.
    if (ev.kind === 'cli-task') {
      const routed = this.tasks.route(ev)
      if (routed) this.ctx?.emit(routed)
      return
    }
    if (ev.kind === 'tool-call') this.tasks.noteToolCall(ev.id)

    if (ev.kind === 'permission-request') {
      this.pendingPrompts.set(ev.requestId, {
        toolName: ev.toolName,
        toolUseId: ev.toolUseId,
        input: ev.input,
        suggestions: Array.isArray(ev.permissionSuggestions) ? ev.permissionSuggestions : []
      })
    } else if (ev.kind === 'permission-cancelled') {
      // The CLI also withdraws requests that were never prompts (its own hook
      // callbacks); only a withdrawn prompt means something to the timeline.
      if (!this.pendingPrompts.delete(ev.requestId)) return
    } else if (ev.kind === 'turn-init') {
      if (ev.permissionMode) this.permissionMode = ev.permissionMode
    } else if (ev.kind === 'permission-mode-changed') {
      if (ev.mode === this.permissionMode) return
      this.permissionMode = ev.mode
    }

    if (ev.kind === 'unknown' && ev.reason === 'unknown-type') {
      const raw = ev.raw as { type?: string } | null
      console.warn(`[chat-parser] unknown event type=${raw?.type ?? '<no-type>'}`)
    }

    this.ctx?.emit(ev)
  }

  sendUserMessage(text: string): void {
    void this.sendUserTurn({ id: randomUUID(), content: [{ type: 'text', text }] })
  }

  /** Reads the message's attached files into image / document blocks (see `claude-content.ts`). */
  async prepareUserTurn(message: OutgoingUserMessage): Promise<PreparedUserTurn> {
    const content = await buildClaudeContent(message.content, this.readAttachment)
    return { id: message.id, line: this.serializeTurn(message.id, content) }
  }

  sendUserTurn(message: OutgoingUserMessage, prepared?: PreparedUserTurn): Promise<void> {
    // Never a silent no-op: a message written before the driver has its IO
    // context is a lost message (it used to return quietly — P0 N1).
    if (!this.ctx) return Promise.reject(new Error('the agent driver has not started'))
    let line: string
    if (prepared && prepared.id === message.id) {
      line = prepared.line
    } else if (message.content.every((b) => b.type === 'text')) {
      line = this.serializeTurn(
        message.id,
        message.content.map((b) => ({
          type: 'text' as const,
          text: b.type === 'text' ? b.text : ''
        }))
      )
    } else {
      // Attached files are read by `prepareUserTurn`; never send them as nothing.
      return Promise.reject(new Error('attachments were not prepared for this message'))
    }
    // The id doubles as the write's idempotency key: a retried write lands once.
    return this.sendLine(line, { writeId: message.id })
  }

  private serializeTurn(
    id: string,
    content: Parameters<NonNullable<typeof claudeCodeAdapter.serializeUserTurn>>[0]['content']
  ): string {
    if (claudeCodeAdapter.serializeUserTurn)
      return claudeCodeAdapter.serializeUserTurn({ id, content })
    return claudeCodeAdapter.serializeUserMessage(
      content.map((b) => (b.type === 'text' ? b.text : '')).join('\n\n'),
      this.ctx?.sessionId ?? ''
    )
  }

  sendToolResult(args: { toolUseId: string; content: string; isError?: boolean }): boolean {
    if (!this.ctx || !claudeCodeAdapter.serializeToolResult) return false
    const line = claudeCodeAdapter.serializeToolResult({
      toolUseId: args.toolUseId,
      content: args.content,
      isError: args.isError,
      sessionId: this.ctx.sessionId
    })
    if (line == null) return false
    this.ctx.write(line)
    return true
  }

  applyControl(request: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    return this.issueControl(request, timeoutMs).response
  }

  /**
   * Send a control_request: `written` settles with the write, `response` with
   * the CLI's control_response (or the timeout / the session ending). Callers
   * that only need one of them must still observe the other's rejection.
   */
  private issueControl(
    request: Record<string, unknown>,
    timeoutMs: number
  ): { written: Promise<void>; response: Promise<unknown> } {
    const refuse = (msg: string): { written: Promise<void>; response: Promise<unknown> } => {
      const err = Promise.reject(new Error(msg))
      return { written: err, response: err }
    }
    if (!this.ctx) return refuse('driver not started')
    if (!claudeCodeAdapter.serializeControlRequest) return refuse('adapter has no control channel')
    this.controlReqCounter++
    const requestId = `req_${this.controlReqCounter}_${Date.now().toString(36)}`
    const line = claudeCodeAdapter.serializeControlRequest({ requestId, request })
    if (line == null) return refuse('adapter refused to serialize control_request')
    let written!: Promise<void>
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingControl.delete(requestId)
        reject(new Error(`control_request timeout after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pendingControl.set(requestId, { resolve, reject, timer })
      const fail = (err: unknown): void => {
        // Not delivered: fail now rather than waiting out the timeout.
        if (!this.pendingControl.has(requestId)) return
        clearTimeout(timer)
        this.pendingControl.delete(requestId)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
      try {
        written = this.sendLine(line)
      } catch (err) {
        written = Promise.reject(err instanceof Error ? err : new Error(String(err)))
      }
      written.catch(fail)
    })
    return { written, response }
  }

  /** A confirmed write when the transport offers one. */
  private sendLine(line: string, opts?: { writeId?: string }): Promise<void> {
    if (!this.ctx) return Promise.reject(new Error('the agent driver has not started'))
    if (this.ctx.send) return this.ctx.send(line, opts)
    this.ctx.write(line)
    return Promise.resolve()
  }

  respondPermission(args: {
    requestId: string
    decision: PermissionDecision
    optionId?: string
  }): boolean {
    const prompt = this.pendingPrompts.get(args.requestId)
    if (!this.ctx || !prompt || !claudeCodeAdapter.serializeControlResponse) return false
    const decision = buildWireDecision(prompt, args.decision)
    if (!decision) return false
    const line = claudeCodeAdapter.serializeControlResponse({
      requestId: args.requestId,
      response: decision as unknown as Record<string, unknown>
    })
    if (line == null || !this.writeSafely(line)) return false
    this.pendingPrompts.delete(args.requestId)
    if (decision.behavior === 'allow') this.tasks.noteToolApproved(prompt.toolUseId)
    this.ctx.emit({
      kind: 'permission-resolved',
      requestId: args.requestId,
      decision,
      ...(args.optionId ? { optionId: args.optionId } : {})
    })
    // The TUI's plain "No": the CLI aborts the turn. Same boundary as Stop.
    if (decision.behavior === 'deny' && decision.interrupt) this.ctx.emit({ kind: 'interrupted' })
    return true
  }

  extractSessionId(event: AgentEvent): string | null {
    return claudeCodeAdapter.extractSessionId(event)
  }

  commandTaskOutput(taskId: string): Promise<CommandTaskOutput> {
    return this.tasks.output(taskId)
  }

  stopCommandTask(taskId: string): Promise<void> {
    return this.tasks.stop(taskId)
  }

  backgroundCommandTask(toolUseId: string): Promise<boolean> {
    return this.tasks.background(toolUseId)
  }

  dispose(): void {
    this.tasks.dispose()
    for (const [id, pending] of this.pendingControl) {
      clearTimeout(pending.timer)
      pending.reject(new Error('session ended before control_response'))
      this.pendingControl.delete(id)
    }
    this.pendingPrompts.clear()
  }

  /** Write one line; false when there's no context or the child's stdin is gone. */
  private writeSafely(line: string | null | undefined): boolean {
    if (!this.ctx || line == null) return false
    try {
      this.ctx.write(line)
      return true
    } catch {
      return false
    }
  }
}

/**
 * The only Claude Code version chat was verified end to end with (CLI spikes,
 * P0 transcripts). Lower it once an older release is verified.
 */
export const MIN_TESTED_CLAUDE_CLI_VERSION = '2.1.312'

/**
 * `AgentBackend` for the `claude-chat` mode. `buildSpawnArgs` delegates to the
 * stateless adapter; `createDriver` mints one `ClaudeSessionDriver` per spawn.
 */
export const claudeChatBackend: AgentBackend = {
  binaryName: claudeCodeAdapter.binaryName,
  displayName: 'Claude Code',
  updateCommand: 'claude update',
  minTestedCliVersion: MIN_TESTED_CLAUDE_CLI_VERSION,
  // File checkpoints: `rewind_files` restores Edit/Write/NotebookEdit changes to
  // before a message (plan 3.3). Off, the CLI answers "File rewinding is not
  // enabled." (spike item 5).
  spawnEnv: { CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: 'true' },
  buildSpawnArgs: (opts) => claudeCodeAdapter.buildSpawnArgs(opts),
  createDriver: () => new ClaudeSessionDriver({ readAttachment: getChatAttachmentReader() }),
  refusedOptionalFlag: (stderr) =>
    /unknown option '--thinking-display'/.test(stderr) ? '--thinking-display' : null
}
