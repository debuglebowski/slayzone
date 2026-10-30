/**
 * CodexChatSession — `ChatSessionDriver` for the `codex-chat` mode.
 *
 * Drives the Codex CLI `app-server` JSON-RPC protocol and translates its
 * notifications into SlayZone's normalized `AgentEvent` stream so the existing
 * chat timeline reducer + renderers work unchanged. One instance per OS
 * subprocess (`codexChatBackend.createDriver()`).
 *
 * Protocol lifecycle (see `test/fixtures/codex-app-server/SPIKE.md`):
 *  - `start()` runs `initialize` → `initialized` → `thread/start|resume`.
 *  - `sendUserMessage()` issues `turn/start`; the turn streams as notifications.
 *  - Codex `item/agentMessage/delta` etc. are bridged onto the Claude-shaped
 *    streaming-block events (`stream-message-start` … `stream-message-stop`)
 *    so the reducer drives the Codex UI with no fork.
 *
 * @module agents/codex/codex-chat-session
 */
import { randomUUID } from 'node:crypto'
import {
  userMessageText,
  type AgentEvent,
  type ChatModelInfo,
  type CommandTaskOutput,
  type OutgoingUserMessage,
  type PermissionRequestEvent,
  type TokenUsage
} from '@slayzone/terminal-contracts'
import type {
  AgentBackend,
  ChatDriverContext,
  ChatSessionDriver,
  PermissionDecision
} from '../types'
import { CodexAppServerClient, CodexRpcError, type JsonRpcId } from './codex-app-server-client'
import { CODEX_FAST_SERVICE_TIER } from '@slayzone/terminal-contracts'
import {
  CODEX_DEFAULT_INSTRUCTIONS,
  CODEX_PLAN_INSTRUCTIONS
} from './codex-collaboration-instructions'
import type {
  CodexApprovalDecision,
  CodexApprovalPolicy,
  CodexCollaborationMode,
  CodexDeltaNotification,
  CodexErrorNotification,
  CodexItemNotification,
  CodexModeKind,
  CodexModel,
  CodexModelListResponse,
  CodexPlanNotification,
  CodexReviewDecision,
  CodexSandboxMode,
  CodexSandboxPolicy,
  CodexThreadItem,
  CodexThreadStartResponse,
  CodexTokenUsageNotification,
  CodexTurnNotification,
  CodexTurnsListResponse,
  CodexTurnStartResponse
} from './codex-protocol'

const CLIENT_INFO = { name: 'slayzone', title: 'SlayZone', version: '1.0' } as const
const HANDSHAKE_TIMEOUT_MS = 30_000
/** A turn streams via notifications; its `turn/start` reply is quick, but a
 *  slow first model token can still delay it — keep the request unbounded. */
const TURN_REQUEST_TIMEOUT_MS = 0

/**
 * Server→client requests the user answers from a prompt card (each becomes a
 * `permission-request`; the answer goes back in the request's own vocabulary,
 * see `codexReplyFor`).
 */
const PROMPT_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'applyPatchApproval',
  'execCommandApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request'
])

/** A server→client request waiting for the user. */
interface PendingRequest {
  id: JsonRpcId
  method: string
  params: Record<string, unknown>
}

/** A message waiting for the handshake. */
interface QueuedTurn {
  text: string
  /** The outbox id, when the message came through the outbox. */
  messageId?: string
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface CodexRuntimePolicy {
  approvalPolicy: CodexApprovalPolicy
  sandboxMode: CodexSandboxMode
  sandboxPolicy: CodexSandboxPolicy
}

/**
 * Map a SlayZone runtime/permission mode onto Codex's approval + sandbox
 * vocabulary. Accepts both the codex-chat mode names and the legacy Claude
 * ones defensively so the driver is robust to whatever the handler passes.
 */
function mapRuntimePolicy(mode: string | null, cwd: string): CodexRuntimePolicy {
  switch (mode) {
    case 'approval-required':
    case 'plan':
      return {
        approvalPolicy: 'untrusted',
        sandboxMode: 'read-only',
        sandboxPolicy: { type: 'readOnly', networkAccess: false }
      }
    case 'full-access':
    case 'bypass':
    case 'bypassPermissions':
    case 'auto':
      return {
        approvalPolicy: 'never',
        sandboxMode: 'danger-full-access',
        sandboxPolicy: { type: 'dangerFullAccess' }
      }
    case 'auto-accept-edits':
    case 'auto-accept':
    case 'acceptEdits':
    default:
      return {
        approvalPolicy: 'on-request',
        sandboxMode: 'workspace-write',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [cwd],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false
        }
      }
  }
}

/**
 * Map a SlayZone collaboration mode onto Codex's `ModeKind`. `null`/unknown →
 * undefined so the driver omits `collaborationMode` entirely (Codex default).
 */
function mapCollaboration(value: string | null): CodexModeKind | undefined {
  return value === 'plan' || value === 'default' ? value : undefined
}

/**
 * Reasoning efforts Codex knows when the model's own list is not known yet.
 * Since 0.15x an effort is any string a model advertises (0.159.2: `max`,
 * `ultra`); the model's list (`model/list`) decides once it is known.
 */
const KNOWN_EFFORTS: ReadonlySet<string> = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra'
])

/** Title-cased effort id for the picker (`xhigh` → `Xhigh`). */
function effortLabel(id: string): string {
  return id ? id[0].toUpperCase() + id.slice(1) : id
}

/** `model/list` rows → the picker's models (hidden ones left out). */
function toModelInfos(rows: CodexModel[]): ChatModelInfo[] {
  return rows
    .filter((m) => !m.hidden)
    .map((m) => {
      const efforts = (m.supportedReasoningEfforts ?? []).map((e) => ({
        id: e.reasoningEffort,
        label: effortLabel(e.reasoningEffort),
        ...(e.description ? { description: e.description } : {})
      }))
      return {
        id: m.id,
        label: m.displayName || m.id,
        ...(m.description ? { description: m.description } : {}),
        supportsEffort: efforts.length > 0,
        isDefault: m.isDefault === true,
        ...(m.defaultReasoningEffort ? { defaultEffort: m.defaultReasoningEffort } : {}),
        efforts
      }
    })
}

/** The CLI version in the handshake's `userAgent` (`slayzone/0.159.2 (Mac OS …)`). */
function cliVersionOf(userAgent: unknown): string | null {
  if (typeof userAgent !== 'string') return null
  return /^[^/\s]+\/(\d+\.\d+\.\d+[^\s]*)/.exec(userAgent)?.[1] ?? null
}

/**
 * The plain message of a Codex error. 0.159.2 puts the raw API error JSON into
 * `error.message` (`{"type":"error","status":400,"error":{"message":…}}`).
 */
function readableCodexError(raw: string): string {
  const text = raw.trim()
  if (!text.startsWith('{')) return raw
  try {
    const j = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown }
    const inner = j.error?.message ?? j.message
    if (typeof inner === 'string' && inner.trim()) return inner
  } catch {
    // not JSON after all — show it as it came
  }
  return raw
}

/** How many past turns a switched-to conversation shows (newest kept). */
const HISTORY_MAX_TURNS = 200

/** A past turn as `thread/turns/list {itemsView:'full'}` returns it. */
interface CodexHistoryTurn {
  id: string
  items?: Array<
    Record<string, unknown> & {
      type: string
      id: string
      clientId?: string | null
      text?: unknown
      /** userMessage: `UserInput` objects; reasoning: strings. */
      content?: unknown[]
      summary?: unknown[]
    }
  >
}

/** Last part of a command's output kept for `commandTaskOutput` (8 KiB, like Claude's). */
const COMMAND_OUTPUT_TAIL = 8192

interface CommandOutput {
  output: string
  totalBytes: number
  ended: boolean
}

/**
 * `thread/resume` failed because the server has no such thread — codex-cli
 * 0.159.2 answers `-32600 no rollout found for thread id <id>` (recipe
 * resume-missing). Every other failure leaves the thread's existence open.
 */
function isThreadNotFound(err: unknown): boolean {
  if (!(err instanceof CodexRpcError)) return false
  return /no rollout found|thread not found|unknown thread/i.test(err.message)
}

/** A v2 approval decision (`CommandExecutionApprovalDecision` / `FileChangeApprovalDecision`). */
function v2Decision(decision: PermissionDecision): CodexApprovalDecision {
  if (decision.behavior === 'deny') return decision.interrupt ? 'cancel' : 'decline'
  const a = decision.amendment
  if (a?.kind === 'execpolicy')
    return { acceptWithExecpolicyAmendment: { execpolicy_amendment: a.command } }
  if (a?.kind === 'network')
    return {
      applyNetworkPolicyAmendment: { network_policy_amendment: { host: a.host, action: a.action } }
    }
  return decision.scope === 'session' ? 'acceptForSession' : 'accept'
}

/** A legacy `ReviewDecision` (`execCommandApproval` / `applyPatchApproval`). */
function reviewDecision(decision: PermissionDecision): CodexReviewDecision {
  if (decision.behavior === 'deny')
    return decision.interrupt ? 'abort' : { denied: { rejection: decision.message } }
  const a = decision.amendment
  if (a?.kind === 'execpolicy')
    return { approved_execpolicy_amendment: { proposed_execpolicy_amendment: a.command } }
  if (a?.kind === 'network')
    return {
      network_policy_amendment: { network_policy_amendment: { host: a.host, action: a.action } }
    }
  return decision.scope === 'session' ? 'approved_for_session' : 'approved'
}

/** The JSON-RPC result answering a prompt request with the user's decision. */
function codexReplyFor(req: PendingRequest, decision: PermissionDecision): unknown {
  const allow = decision.behavior === 'allow'
  const input = allow ? decision.updatedInput : undefined
  switch (req.method) {
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { decision: reviewDecision(decision) }
    case 'item/permissions/requestApproval':
      return {
        permissions: allow ? (req.params.permissions ?? {}) : {},
        scope: allow && decision.scope === 'session' ? 'session' : 'turn'
      }
    case 'item/tool/requestUserInput': {
      const given = (input?.answers ?? {}) as Record<string, unknown>
      const answers: Record<string, { answers: string[] }> = {}
      for (const [qid, value] of Object.entries(given)) {
        const list = Array.isArray(value) ? value : [value]
        answers[qid] = { answers: list.filter((v): v is string => typeof v === 'string') }
      }
      return { answers }
    }
    case 'mcpServer/elicitation/request':
      if (allow) {
        const content = input?.content
        return { action: 'accept', content: content && typeof content === 'object' ? content : {} }
      }
      return { action: decision.interrupt ? 'cancel' : 'decline', content: null }
    default:
      return { decision: v2Decision(decision) }
  }
}

/** What a prompt card shows about a request (the `permission-request` display fields). */
function promptDisplay(
  method: string,
  p: Record<string, unknown>
): Partial<PermissionRequestEvent> {
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
  const reason = str(p.reason)
  const withReason = (fields: Partial<PermissionRequestEvent>): Partial<PermissionRequestEvent> =>
    reason ? { ...fields, decisionReason: reason } : fields
  switch (method) {
    case 'item/commandExecution/requestApproval': {
      const command = str(p.command)
      return withReason({
        displayName: 'Run command',
        ...(command ? { description: command } : {})
      })
    }
    case 'execCommandApproval': {
      const command = Array.isArray(p.command) ? p.command.map(String).join(' ') : undefined
      return withReason({
        displayName: 'Run command',
        ...(command ? { description: command } : {})
      })
    }
    case 'item/fileChange/requestApproval':
    case 'applyPatchApproval': {
      const root = str(p.grantRoot)
      return withReason({ displayName: 'Edit files', ...(root ? { blockedPath: root } : {}) })
    }
    case 'item/permissions/requestApproval':
      return withReason({ displayName: 'Extra permissions' })
    case 'item/tool/requestUserInput':
      return { displayName: 'Question', requiresUserInteraction: true }
    case 'mcpServer/elicitation/request': {
      const server = str(p.serverName)
      const message = str(p.message)
      return {
        displayName: 'MCP input',
        requiresUserInteraction: true,
        ...(server ? { mcpServer: { name: server } } : {}),
        ...(message ? { description: message } : {})
      }
    }
    default:
      return {}
  }
}

/** The tool call a request is about: the item it names (legacy: its call id). */
function promptToolUseId(p: Record<string, unknown>): string {
  if (typeof p.itemId === 'string') return p.itemId
  if (typeof p.callId === 'string') return p.callId
  return ''
}

/**
 * Guard against a non-Codex model leaking through (e.g. a Claude `sonnet`
 * alias from a not-yet-mode-aware handler). Returns the model only when it
 * looks like a Codex model id, else undefined so Codex falls back to its own
 * default. Provider-aware model selection is finalized in a later phase; this
 * keeps the driver robust in the meantime.
 */
function codexModelOrUndefined(model: string | null): string | undefined {
  if (!model) return undefined
  return /gpt|codex|^o\d/i.test(model) ? model : undefined
}

/** The installed version, said in an error ("installed Codex 0.139.0"). */
function installedPart(version: string | null): string {
  return version ? ` (installed Codex ${version})` : ''
}

class CodexChatSession implements ChatSessionDriver {
  private ctx: ChatDriverContext | null = null
  private client: CodexAppServerClient | null = null
  private threadId: string | null = null
  private currentTurnId: string | null = null
  private handshakeDone = false
  private disposed = false

  /** User messages sent before the handshake resolved; flushed once it does. */
  private readonly queued: QueuedTurn[] = []
  /** `turn/start` requests written whose reply (the turn id) has not come yet. */
  private turnStartsInFlight = 0
  /**
   * A Stop that came before the running turn had an id: sent as soon as the id
   * arrives (the TUI does the same), resolved with that `turn/interrupt`'s reply.
   */
  private pendingInterrupt: Deferred<unknown> | null = null
  /** Outbox message id → the turn it started and its text (this process's turns). */
  private readonly turnByMessage = new Map<string, { turnId: string; text: string }>()
  /** A `/compact` the user asked for is running (its compaction is `manual`). */
  private manualCompaction = false
  /** Waiters for the running turn to end (`turn/completed`). */
  private turnEndWaiters: Array<() => void> = []
  /** Latest token usage from `thread/tokenUsage/updated`, folded into `result`. */
  private lastUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0
  }

  /** Open streaming block: the Codex item id whose deltas we are bridging. */
  private streamItemId: string | null = null
  private streamBlockType: 'text' | 'thinking' | null = null

  /** requestId (string) → a server request waiting for the user's answer. */
  private readonly pendingRequests = new Map<string, PendingRequest>()

  /** The CLI version from the handshake (`userAgent`). */
  private cliVersion: string | null = null
  /** The account's models (`model/list`); null until it answered. */
  private models: ChatModelInfo[] | null = null
  /** The model the thread runs when a turn names none (`thread/start|resume` reply). */
  private threadModel: string | null = null
  /** Output of the turn's commands, by item id (live output, polled). */
  private readonly commands = new Map<string, CommandOutput>()
  /** Last context-usage emitted (only a change is emitted again). */
  private lastContext: { tokens: number; window: number | null } | null = null

  /** Turns that already ended (a late `turn/start` reply must not revive one). */
  private readonly endedTurns = new Set<string>()

  private model: string | null = null
  private effort: string | null = null
  private mode: string | null = null
  private collaboration: string | null = null
  private fastMode = false

  start(ctx: ChatDriverContext): Promise<void> {
    this.ctx = ctx
    this.model = ctx.chatModel
    this.effort = ctx.chatEffort
    this.mode = ctx.chatMode
    this.collaboration = ctx.chatCollaboration
    this.fastMode = ctx.chatFastMode
    this.client = new CodexAppServerClient({
      write: (line) => ctx.write(line),
      onNotification: (method, params) => this.onNotification(method, params),
      onServerRequest: (method, params, id) => this.onServerRequest(method, params, id),
      onParseError: (line, err) =>
        console.warn('[codex-chat] unparseable app-server line:', err, line.slice(0, 200))
    })
    return this.handshake(ctx)
  }

  private async handshake(ctx: ChatDriverContext): Promise<void> {
    const client = this.client
    if (!client) return
    try {
      const init = await client.request<{ userAgent?: unknown }>(
        'initialize',
        {
          clientInfo: CLIENT_INFO,
          capabilities: { experimentalApi: true, requestAttestation: false }
        },
        HANDSHAKE_TIMEOUT_MS
      )
      this.cliVersion = cliVersionOf(init?.userAgent)
    } catch (err) {
      this.emitFatalStartError(ctx, err)
      return
    }
    client.notify('initialized')

    const policy = mapRuntimePolicy(this.mode, ctx.cwd)
    let resp: CodexThreadStartResponse
    if (ctx.fork) {
      const forked = await this.forkThread(ctx, client, policy)
      if (!forked) return
      resp = forked
    } else if (ctx.resume && ctx.sessionId) {
      try {
        resp = await client.request<CodexThreadStartResponse>(
          'thread/resume',
          {
            threadId: ctx.sessionId,
            cwd: ctx.cwd,
            approvalPolicy: policy.approvalPolicy,
            sandbox: policy.sandboxMode
          },
          HANDSHAKE_TIMEOUT_MS
        )
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        if (isThreadNotFound(err)) {
          // The server has no such thread: the `stderr` marker the transport's
          // resume guard recognizes, so it starts a fresh one (and clears the
          // stale stored id via `onInvalidResume`).
          this.emit(ctx, {
            kind: 'stderr',
            text: `No conversation found for Codex thread ${ctx.sessionId}: ${reason}`
          })
          return
        }
        // Anything else (timeout, network, a crash) says nothing about the
        // thread: it is kept, and Retry resumes it again (audit #2).
        this.emit(ctx, {
          kind: 'error',
          message: `Codex could not reopen the conversation: ${reason}`,
          detail: { phase: 'resume', fatal: true, reason }
        })
        return
      }
    } else {
      const startModel = codexModelOrUndefined(this.model)
      try {
        resp = await client.request<CodexThreadStartResponse>(
          'thread/start',
          {
            cwd: ctx.cwd,
            approvalPolicy: policy.approvalPolicy,
            sandbox: policy.sandboxMode,
            ...(startModel ? { model: startModel } : {})
          },
          HANDSHAKE_TIMEOUT_MS
        )
      } catch (err) {
        this.emitFatalStartError(ctx, err)
        return
      }
    }

    this.threadId = resp.thread.id
    this.threadModel = resp.model ?? null
    if (ctx.importHistory && ctx.addHistory) await this.importHistory(ctx.addHistory)
    this.handshakeDone = true
    // Synthetic turn-init so the timeline reducer materializes a session-start
    // row and `extractSessionId` can persist the thread id for resume.
    this.emit(ctx, {
      kind: 'turn-init',
      sessionId: resp.thread.id,
      model: this.model ?? resp.model,
      cwd: resp.cwd,
      tools: [],
      permissionMode: this.mode ?? undefined,
      ...(this.cliVersion ? { cliVersion: this.cliVersion } : {})
    })
    void this.loadModels(ctx)
    // Flush any messages the user sent before the handshake completed.
    const pending = this.queued.splice(0)
    for (const turn of pending) this.startTurn(turn.text, turn.messageId)
  }

  /**
   * Branch `ctx.fork.fromSessionId` through the turn of message
   * `ctx.fork.atMessageUuid` (found by its `clientId`; works on a thread no
   * process has loaded — 0.159.2). A failure is a fatal `phase: 'fork'` error:
   * the transport takes the tab back to the original conversation.
   */
  private async forkThread(
    ctx: ChatDriverContext,
    client: CodexAppServerClient,
    policy: CodexRuntimePolicy
  ): Promise<CodexThreadStartResponse | null> {
    const fork = ctx.fork!
    const fail = (reason: string): null => {
      this.emit(ctx, {
        kind: 'error',
        message: `Codex could not fork the conversation: ${reason}`,
        detail: { phase: 'fork', fatal: true, reason }
      })
      return null
    }
    try {
      const turn = await this.findTurn(fork.atMessageUuid, fork.fromSessionId)
      if (!turn) return fail('that message is not in the conversation')
      const model = this.turnModel()
      return await client.request<CodexThreadStartResponse>(
        'thread/fork',
        {
          threadId: fork.fromSessionId,
          lastTurnId: turn.turnId,
          cwd: ctx.cwd,
          approvalPolicy: policy.approvalPolicy,
          sandbox: policy.sandboxMode,
          ...(model ? { model } : {})
        },
        HANDSHAKE_TIMEOUT_MS
      )
    } catch (err) {
      return fail(readableCodexError(err instanceof Error ? err.message : String(err)))
    }
  }

  /**
   * Hand a switched-to thread's past to the tab (`thread/turns/list`, oldest
   * first): the latest `HISTORY_MAX_TURNS` turns as history events, and a
   * notice when older ones are left out — or when the past cannot be read.
   */
  private async importHistory(addHistory: (events: AgentEvent[]) => void): Promise<void> {
    const client = this.client
    if (!client || !this.threadId) return
    const turns: CodexHistoryTurn[] = []
    let cursor: string | null = null
    let more = false
    try {
      do {
        const res: CodexTurnsListResponse = await client.request<CodexTurnsListResponse>(
          'thread/turns/list',
          {
            threadId: this.threadId,
            itemsView: 'full',
            sortDirection: 'desc',
            limit: 50,
            ...(cursor ? { cursor } : {})
          },
          HANDSHAKE_TIMEOUT_MS
        )
        turns.push(...((res.data ?? []) as CodexHistoryTurn[]))
        cursor = res.nextCursor ?? null
        more = cursor !== null && turns.length >= HISTORY_MAX_TURNS
      } while (cursor && !more)
    } catch (err) {
      addHistory([
        {
          kind: 'notice',
          id: randomUUID(),
          level: 'warning',
          code: 'history-unavailable',
          text: `The earlier messages of this conversation could not be read from Codex (${readableCodexError(
            err instanceof Error ? err.message : String(err)
          )}); Codex still remembers them.`
        }
      ])
      return
    }
    const kept = turns.slice(0, HISTORY_MAX_TURNS).reverse()
    const events: AgentEvent[] = []
    if (more || turns.length > HISTORY_MAX_TURNS) {
      events.push({
        kind: 'notice',
        id: randomUUID(),
        level: 'info',
        code: 'history-truncated',
        text: `Only the latest ${HISTORY_MAX_TURNS} turns of this conversation are shown.`
      })
    }
    for (const turn of kept) events.push(...this.historyOfTurn(turn))
    addHistory(events)
  }

  /** One past turn as history events: its message, replies, reasoning and tool calls. */
  private historyOfTurn(turn: CodexHistoryTurn): AgentEvent[] {
    const out: AgentEvent[] = []
    for (const item of turn.items ?? []) {
      switch (item.type) {
        case 'userMessage': {
          const text = (item.content ?? [])
            .map((c) => {
              const t = (c as { text?: unknown } | null)?.text
              return typeof t === 'string' ? t : ''
            })
            .join('')
          out.push({
            kind: 'user-message',
            text,
            id: item.clientId ?? item.id,
            content: [{ type: 'text', text }],
            history: true
          })
          break
        }
        case 'agentMessage':
          if (typeof item.text === 'string' && item.text)
            out.push({ kind: 'assistant-text', messageId: item.id, text: item.text })
          break
        case 'reasoning': {
          const text = [...(item.summary ?? []), ...(item.content ?? [])]
            .filter((t): t is string => typeof t === 'string')
            .join('\n\n')
          if (text) {
            out.push({ kind: 'assistant-thinking', messageId: item.id, text, hasSignature: false })
          }
          break
        }
        default: {
          const call = this.toToolCall(item as CodexThreadItem)
          const result = this.toToolResult(item as CodexThreadItem)
          if (call) out.push(call)
          if (result) out.push(result)
        }
      }
    }
    return out
  }

  /**
   * Ask the account's models (`model/list`) — never blocking a turn. A stored
   * model the account does not offer is replaced by its default (said once):
   * sending it would fail every turn ("not supported when using Codex with a
   * ChatGPT account").
   */
  private async loadModels(ctx: ChatDriverContext): Promise<void> {
    const client = this.client
    if (!client) return
    let res: CodexModelListResponse
    try {
      res = await client.request<CodexModelListResponse>('model/list', {}, HANDSHAKE_TIMEOUT_MS)
    } catch (err) {
      console.warn('[codex-chat] model/list failed:', err)
      return
    }
    if (this.disposed) return
    const models = toModelInfos(res?.data ?? [])
    this.models = models
    this.emit(ctx, { kind: 'cli-models', models })
    const stored = codexModelOrUndefined(this.model)
    if (!stored || models.length === 0 || models.some((m) => m.id === stored)) return
    const fallback = models.find((m) => m.isDefault) ?? models[0]
    this.model = fallback.id
    this.emit(ctx, {
      kind: 'notice',
      id: randomUUID(),
      level: 'warning',
      text: `The model ${stored} is not available to this Codex account; chat uses ${fallback.label} instead.`,
      detail: { model: stored, fallback: fallback.id }
    })
  }

  /** The model a turn names: the chosen one (checked against the account's list once known). */
  private turnModel(): string | undefined {
    return codexModelOrUndefined(this.model)
  }

  /** The effort a turn sends: the chosen one, when the model accepts it. */
  private turnEffort(): string | undefined {
    const effort = this.effort
    if (!effort) return undefined
    const info = this.modelInfo()
    if (info?.efforts) return info.efforts.some((e) => e.id === effort) ? effort : undefined
    return KNOWN_EFFORTS.has(effort) ? effort : undefined
  }

  /** What `model/list` says about the model the next turn runs on. */
  private modelInfo(): ChatModelInfo | undefined {
    const id = this.turnModel() ?? this.threadModel
    return this.models?.find((m) => m.id === id)
  }

  /**
   * Emit a fatal driver-start error. Unlike a resume failure (recoverable —
   * the transport respawns fresh), an `initialize` or `thread/start` failure
   * leaves the session with nowhere to go. `detail.fatal` tells the transport
   * to tear the session down to its terminal dead state (Retry overlay)
   * rather than leave it half-alive, silently queueing input that never sends.
   */
  private emitFatalStartError(ctx: ChatDriverContext, err: unknown): void {
    this.emit(ctx, {
      kind: 'error',
      message: `Codex failed to start a session: ${
        err instanceof Error ? err.message : String(err)
      }`,
      detail: { phase: 'driver-start', fatal: true }
    })
  }

  handleLine(line: string): void {
    this.client?.handleLine(line)
  }

  sendUserMessage(text: string): void {
    if (!this.handshakeDone) {
      this.queued.push({ text })
      return
    }
    this.startTurn(text)
  }

  /**
   * An outbox message: its id goes to Codex as `clientUserMessageId` (it comes
   * back as the user item's `clientId`), so the turn can be found again to
   * rewind or fork at. Text only (`attachments: 'paths'`).
   */
  sendUserTurn(message: OutgoingUserMessage): Promise<void> {
    if (message.content.some((b) => b.type !== 'text')) {
      return Promise.reject(new Error('Codex chat takes text only; attached files are not sent.'))
    }
    const text = userMessageText(message.content)
    if (!this.handshakeDone) this.queued.push({ text, messageId: message.id })
    else this.startTurn(text, message.id)
    return Promise.resolve()
  }

  /**
   * Build the `turn/start.collaborationMode` payload for the current
   * collaboration setting. Returns undefined when no collaboration mode is
   * set so the param is omitted entirely (Codex falls back to its default).
   */
  private buildCollaborationMode(): CodexCollaborationMode | undefined {
    const kind = mapCollaboration(this.collaboration)
    if (!kind) return undefined
    const info = this.modelInfo()
    return {
      mode: kind,
      settings: {
        // The thread's model when none was chosen (`resp.model`, the account's default).
        model: this.turnModel() ?? this.threadModel ?? info?.id ?? '',
        reasoning_effort: this.turnEffort() ?? info?.defaultEffort ?? 'medium',
        developer_instructions:
          kind === 'plan' ? CODEX_PLAN_INSTRUCTIONS : CODEX_DEFAULT_INSTRUCTIONS
      }
    }
  }

  private startTurn(text: string, messageId?: string): void {
    const client = this.client
    const ctx = this.ctx
    if (!client || !ctx || !this.threadId) return
    if (text.trim() === '/compact') {
      this.startCompaction(ctx, client)
      return
    }
    const policy = mapRuntimePolicy(this.mode, ctx.cwd)
    const effort = this.turnEffort()
    const model = this.turnModel()
    const collaborationMode = this.buildCollaborationMode()
    this.turnStartsInFlight++
    client
      .request<CodexTurnStartResponse>(
        'turn/start',
        {
          threadId: this.threadId,
          input: [{ type: 'text', text, text_elements: [] }],
          approvalPolicy: policy.approvalPolicy,
          sandboxPolicy: policy.sandboxPolicy,
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          ...(collaborationMode ? { collaborationMode } : {}),
          ...(this.fastMode ? { serviceTier: CODEX_FAST_SERVICE_TIER } : {}),
          ...(messageId ? { clientUserMessageId: messageId } : {})
        },
        TURN_REQUEST_TIMEOUT_MS
      )
      .then((res) => {
        this.turnStartsInFlight--
        if (messageId) this.turnByMessage.set(messageId, { turnId: res.turn.id, text })
        // `turn/completed` may already have come (a fast turn): don't revive it.
        if (!this.endedTurns.has(res.turn.id)) this.onTurnId(res.turn.id)
      })
      .catch((err) => {
        this.turnStartsInFlight--
        this.settlePendingInterrupt(undefined)
        this.emit(
          ctx,
          this.errorEvent(err instanceof Error ? err.message : String(err), 'Codex turn failed: ')
        )
        // Balance the in-flight counter so the typing indicator clears.
        this.emitTurnResult(ctx, 'failed', 0)
      })
  }

  /**
   * `/compact` (the composer's Compact): Codex compacts the thread as a turn of
   * its own (`thread/compact/start` → turn/started, a `contextCompaction` item,
   * turn/completed — 0.159.2), shown with Claude's compact events.
   */
  private startCompaction(ctx: ChatDriverContext, client: CodexAppServerClient): void {
    this.manualCompaction = true
    this.turnStartsInFlight++
    client
      .request('thread/compact/start', { threadId: this.threadId })
      .then(() => {
        this.turnStartsInFlight--
      })
      .catch((err) => {
        this.turnStartsInFlight--
        this.manualCompaction = false
        this.settlePendingInterrupt(undefined)
        const error = readableCodexError(err instanceof Error ? err.message : String(err))
        this.emit(ctx, { kind: 'compact-status', phase: 'failed', error })
        this.emitTurnResult(ctx, 'failed', 0)
      })
  }

  applyControl(request: Record<string, unknown>): Promise<unknown> {
    const subtype = typeof request.subtype === 'string' ? request.subtype : ''
    if (subtype === 'interrupt') return this.interrupt()
    if (subtype === 'rewind_files') {
      // Codex keeps no file checkpoints (`thread/revert` changes history only).
      return Promise.resolve({
        response: {
          canRewind: false,
          error: 'Codex keeps no file checkpoints: the files stay as they are.'
        }
      })
    }
    if (subtype === 'rewind_conversation') {
      const target = request.target_message_uuid
      return typeof target === 'string'
        ? this.forgetMessage(target)
        : Promise.reject(new Error('rewind_conversation needs target_message_uuid'))
    }
    // Model / effort / mode are applied per-turn via `turn/start` params — just
    // update the in-memory fields; the next turn picks them up. No respawn.
    if (subtype === 'set_model' && typeof request.model === 'string') {
      this.model = request.model
    } else if (subtype === 'set_permission_mode' && typeof request.mode === 'string') {
      this.mode = request.mode
    } else if (subtype === 'set_effort' && typeof request.effort === 'string') {
      this.effort = request.effort
    } else if (subtype === 'apply_flag_settings') {
      // The transport's live effort path (Claude's control request).
      const level = (request.settings as { effortLevel?: unknown } | undefined)?.effortLevel
      if (typeof level === 'string') this.effort = level
    } else if (subtype === 'set_collaboration' && typeof request.collaboration === 'string') {
      this.collaboration = request.collaboration
    } else if (subtype === 'set_fast' && typeof request.fastMode === 'boolean') {
      this.fastMode = request.fastMode
    }
    return Promise.resolve({ ok: true })
  }

  respondPermission(args: {
    requestId: string
    decision: PermissionDecision
    optionId?: string
  }): boolean {
    const client = this.client
    if (!client) return false
    const req = this.pendingRequests.get(args.requestId)
    if (!req) return false
    this.pendingRequests.delete(args.requestId)
    client.respond(req.id, codexReplyFor(req, args.decision))
    // Recorded like Claude's answers: the card closes now (a cancel brings no
    // tool result) and a reload shows what was picked.
    if (this.ctx) {
      this.emit(this.ctx, {
        kind: 'permission-resolved',
        requestId: args.requestId,
        decision: args.decision,
        ...(args.optionId ? { optionId: args.optionId } : {})
      })
    }
    // A question has no "stop" answer of its own: decline, then stop the turn.
    if (
      req.method === 'item/tool/requestUserInput' &&
      args.decision.behavior === 'deny' &&
      args.decision.interrupt
    ) {
      void this.applyControl({ subtype: 'interrupt' }).catch(() => undefined)
    }
    return true
  }

  /**
   * Stop the running turn in place (`turn/interrupt`). A turn whose id is not
   * known yet (its `turn/start` reply is on its way) is stopped as soon as it is.
   * Resolves with the interrupt's reply; at once when no turn runs.
   */
  private interrupt(): Promise<unknown> {
    const client = this.client
    if (!client || !this.threadId) return Promise.resolve()
    if (this.currentTurnId) {
      return client.request('turn/interrupt', {
        threadId: this.threadId,
        turnId: this.currentTurnId
      })
    }
    if (this.turnStartsInFlight === 0) return Promise.resolve()
    this.pendingInterrupt ??= deferred<unknown>()
    return this.pendingInterrupt.promise
  }

  /** The running turn's id is known: remember it, and send a Stop that waited for it. */
  private onTurnId(turnId: string): void {
    this.currentTurnId = turnId
    const waiting = this.pendingInterrupt
    if (!waiting || !this.client || !this.threadId) return
    this.pendingInterrupt = null
    this.client
      .request('turn/interrupt', { threadId: this.threadId, turnId })
      .then(waiting.resolve, waiting.reject)
  }

  private settlePendingInterrupt(value: unknown): void {
    const waiting = this.pendingInterrupt
    this.pendingInterrupt = null
    waiting?.resolve(value)
  }

  /**
   * Take a message back out of the conversation (Stop before any output gave
   * it back): its turn and every later one are reverted (`thread/revert`). The
   * answer has the shape the transport reads from Claude's `rewind_conversation`.
   */
  private async forgetMessage(messageId: string): Promise<unknown> {
    const client = this.client
    const threadId = this.threadId
    if (!client || !threadId) throw new Error('Codex is not running')
    // A turn still winding down after its interrupt cannot be reverted yet.
    if (this.currentTurnId || this.turnStartsInFlight > 0) await this.turnEnded(5_000)
    const turn = this.turnByMessage.get(messageId) ?? (await this.findTurn(messageId))
    if (!turn) return { response: { rewound: false, reason: 'target_not_found' } }
    try {
      await client.request('thread/revert', { threadId, beforeTurnId: turn.turnId })
    } catch (err) {
      return {
        response: { rewound: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
    // That turn and every later one are gone.
    let drop = false
    for (const [id, t] of [...this.turnByMessage]) {
      if (t.turnId === turn.turnId) drop = true
      if (drop) this.turnByMessage.delete(id)
    }
    // The message's text, for "edit & resend" (Claude's `prefillText`).
    return { response: { rewound: true, prefillText: turn.text } }
  }

  /** The turn a message started, from the thread's history (`userMessage.clientId`). */
  private async findTurn(
    messageId: string,
    threadId: string | null = this.threadId
  ): Promise<{ turnId: string; text: string } | null> {
    const client = this.client
    if (!client || !threadId) return null
    let cursor: string | null = null
    for (let page = 0; page < 20; page++) {
      const res: CodexTurnsListResponse = await client.request<CodexTurnsListResponse>(
        'thread/turns/list',
        {
          threadId,
          itemsView: 'full',
          ...(cursor ? { cursor } : {})
        }
      )
      for (const turn of res.data ?? []) {
        const hit = (turn.items ?? []).find(
          (item) => item.type === 'userMessage' && item.clientId === messageId
        )
        if (hit) {
          const text = (hit.content ?? [])
            .map((c) => (typeof c?.text === 'string' ? c.text : ''))
            .join('')
          return { turnId: turn.id, text }
        }
      }
      cursor = res.nextCursor ?? null
      if (!cursor) return null
    }
    return null
  }

  /** Resolves once no turn runs (or after `timeoutMs`). */
  private turnEnded(timeoutMs: number): Promise<void> {
    if (!this.currentTurnId && this.turnStartsInFlight === 0) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(done, timeoutMs)
      const waiters = this.turnEndWaiters
      function done(): void {
        clearTimeout(timer)
        const i = waiters.indexOf(done)
        if (i >= 0) waiters.splice(i, 1)
        resolve()
      }
      waiters.push(done)
    })
  }

  extractSessionId(event: AgentEvent): string | null {
    return event.kind === 'turn-init' ? event.sessionId : null
  }

  dispose(): void {
    this.disposed = true
    this.settlePendingInterrupt(undefined)
    for (const wake of this.turnEndWaiters.splice(0)) wake()
    this.client?.dispose()
    this.pendingRequests.clear()
  }

  // ---- notification handling ----

  private onNotification(method: string, params: unknown): void {
    const ctx = this.ctx
    if (!ctx || this.disposed) return
    switch (method) {
      case 'turn/started': {
        const id = (params as CodexTurnNotification | undefined)?.turn?.id
        if (id && id !== this.currentTurnId && !this.endedTurns.has(id)) this.onTurnId(id)
        return
      }
      case 'item/started':
        this.onItemStarted(ctx, params as CodexItemNotification)
        return
      case 'item/completed':
        this.onItemCompleted(ctx, params as CodexItemNotification)
        return
      case 'item/agentMessage/delta':
        this.onDelta(ctx, params as CodexDeltaNotification, 'text', 'agentMessage')
        return
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
        this.onDelta(ctx, params as CodexDeltaNotification, 'thinking', 'reasoning')
        return
      case 'thread/tokenUsage/updated':
        this.onTokenUsage(ctx, params as CodexTokenUsageNotification)
        return
      case 'turn/plan/updated': {
        const p = params as CodexPlanNotification
        if (p?.plan?.length) {
          this.emit(ctx, {
            kind: 'agent-plan',
            ...(p.explanation ? { explanation: p.explanation } : {}),
            steps: p.plan.map((s) => ({ step: s.step, status: s.status }))
          })
        }
        return
      }
      case 'turn/completed': {
        const p = params as CodexTurnNotification
        if (p.turn?.id) this.endedTurns.add(p.turn.id)
        this.closeStream(ctx)
        this.emitTurnResult(ctx, p.turn?.status ?? 'completed', p.turn?.durationMs ?? 0)
        return
      }
      case 'serverRequest/resolved': {
        // Answered (our own reply echoed) or withdrawn by the server, e.g. after
        // an interrupt: a card still open for it closes.
        const id = (params as { requestId?: unknown } | undefined)?.requestId
        if (id === undefined || id === null) return
        const requestId = String(id)
        if (this.pendingRequests.delete(requestId)) {
          this.emit(ctx, { kind: 'permission-cancelled', requestId })
        }
        return
      }
      case 'error': {
        const p = params as CodexErrorNotification
        this.emit(ctx, this.errorEvent(p.error?.message ?? 'Codex error'))
        return
      }
      case 'item/commandExecution/outputDelta': {
        const p = params as CodexDeltaNotification
        const out = p?.itemId ? this.commands.get(p.itemId) : undefined
        if (!out || out.ended || typeof p.delta !== 'string') return
        out.totalBytes += Buffer.byteLength(p.delta)
        out.output = (out.output + p.delta).slice(-COMMAND_OUTPUT_TAIL)
        return
      }
      default:
        // Unhandled notifications (hooks, thread status, mcp status, …) carry
        // no chat-timeline signal — ignore.
        return
    }
  }

  private onItemStarted(ctx: ChatDriverContext, params: CodexItemNotification): void {
    const item = params?.item
    if (!item) return
    if (item.type === 'userMessage') {
      // Codex echoes the user message as an item; the transport already
      // emitted its own synthetic `user-message` — skip the echo.
      return
    }
    // agentMessage / reasoning streams open lazily on their first delta (see
    // `onDelta`). Opening here would emit an empty stream block for an item
    // that never produces text — e.g. a reasoning item with no textDelta.
    if (item.type === 'agentMessage' || item.type === 'reasoning') return
    if (item.type === 'contextCompaction') {
      this.emit(ctx, { kind: 'compact-status', phase: 'started' })
      return
    }
    const toolCall = this.toToolCall(item)
    if (toolCall) this.emit(ctx, toolCall)
    if (item.type === 'commandExecution' && !this.commands.has(item.id)) {
      // Live output (plan 3.9's command-task path): its card polls `commandTaskOutput`.
      this.commands.set(item.id, { output: '', totalBytes: 0, ended: false })
      this.emit(ctx, {
        kind: 'command-task',
        taskId: item.id,
        toolUseId: item.id,
        status: 'running',
        backgrounded: false,
        startedAt: Date.now()
      })
    }
  }

  private onItemCompleted(ctx: ChatDriverContext, params: CodexItemNotification): void {
    const item = params?.item
    if (!item) return
    if (item.type === 'userMessage') return
    if (item.type === 'agentMessage' || item.type === 'reasoning') {
      if (this.streamItemId === item.id) this.closeStream(ctx)
      return
    }
    if (item.type === 'contextCompaction') {
      // A `/compact` the user asked for, else Codex compacting on its own.
      const trigger = this.manualCompaction ? 'manual' : 'auto'
      this.manualCompaction = false
      this.emit(ctx, { kind: 'compact-boundary', trigger })
      this.emit(ctx, { kind: 'compact-status', phase: 'succeeded' })
      return
    }
    if (item.type === 'commandExecution') {
      const failed =
        item.status === 'failed' ||
        item.status === 'declined' ||
        (typeof item.exitCode === 'number' && item.exitCode !== 0)
      this.endCommand(ctx, item.id, failed ? 'failed' : 'completed')
    }
    const toolResult = this.toToolResult(item)
    if (toolResult) this.emit(ctx, toolResult)
  }

  /** A command ended: its command-task says how (once), its output stays readable. */
  private endCommand(
    ctx: ChatDriverContext,
    id: string,
    status: 'completed' | 'failed' | 'killed'
  ): void {
    const out = this.commands.get(id)
    if (!out || out.ended) return
    out.ended = true
    this.emit(ctx, {
      kind: 'command-task',
      taskId: id,
      toolUseId: id,
      status,
      backgrounded: false,
      endedAt: Date.now()
    })
  }

  commandTaskOutput(taskId: string): Promise<CommandTaskOutput> {
    const out = this.commands.get(taskId)
    if (!out) return Promise.resolve({ state: 'gone' })
    return Promise.resolve({
      state: out.ended ? 'ended' : 'running',
      output: out.output,
      totalBytes: out.totalBytes,
      truncated: out.totalBytes > Buffer.byteLength(out.output)
    })
  }

  /** Codex tool-ish items → `tool-call`. Returns null for non-tool items. */
  private toToolCall(
    item: Record<string, unknown> & { type: string; id: string }
  ): AgentEvent | null {
    switch (item.type) {
      // Command, file change, web search: the whole started item, today's keys
      // (`command`, `cwd`, `changes`, `query`) first — a generic card shows the
      // start of the input; `commandActions` etc. ride along.
      case 'commandExecution':
        return {
          kind: 'tool-call',
          id: item.id,
          name: 'codex/commandExecution',
          input: { command: item.command, cwd: item.cwd, ...item }
        }
      case 'fileChange':
        return {
          kind: 'tool-call',
          id: item.id,
          name: 'codex/fileChange',
          input: { changes: item.changes, ...item }
        }
      case 'mcpToolCall':
        return {
          kind: 'tool-call',
          id: item.id,
          name: `mcp/${String(item.server ?? '')}/${String(item.tool ?? '')}`,
          input: item.arguments ?? null
        }
      case 'dynamicToolCall':
        return {
          kind: 'tool-call',
          id: item.id,
          name: String(item.tool ?? 'codex/tool'),
          input: item.arguments ?? null
        }
      case 'webSearch':
        return {
          kind: 'tool-call',
          id: item.id,
          name: 'codex/webSearch',
          input: { query: item.query, ...item }
        }
      default:
        return null
    }
  }

  /** Codex tool-ish completed items → `tool-result`. Returns null otherwise. */
  private toToolResult(
    item: Record<string, unknown> & { type: string; id: string }
  ): AgentEvent | null {
    const toolTypes = [
      'commandExecution',
      'fileChange',
      'mcpToolCall',
      'dynamicToolCall',
      'webSearch'
    ]
    if (!toolTypes.includes(item.type)) return null
    const status = typeof item.status === 'string' ? item.status : ''
    const isError = status === 'failed' || status === 'declined' || item.success === false
    const rawContent = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : ''
    return {
      kind: 'tool-result',
      toolUseId: item.id,
      isError,
      rawContent,
      structured: item
    }
  }

  // ---- streaming bridge ----

  /**
   * Open a streaming block for a Codex item, bridging onto the Claude-shaped
   * `stream-message-start` + `stream-block-start` events. Each Codex item is
   * its own single-block "message"; block index 0 is always used.
   */
  private openStream(ctx: ChatDriverContext, itemId: string, blockType: 'text' | 'thinking'): void {
    if (this.streamItemId === itemId && this.streamBlockType === blockType) return
    if (this.streamItemId) this.closeStream(ctx)
    this.streamItemId = itemId
    this.streamBlockType = blockType
    this.emit(ctx, { kind: 'stream-message-start', messageId: itemId })
    this.emit(ctx, { kind: 'stream-block-start', blockIndex: 0, blockType })
  }

  private closeStream(ctx: ChatDriverContext): void {
    if (!this.streamItemId) return
    this.emit(ctx, { kind: 'stream-block-stop', blockIndex: 0 })
    this.emit(ctx, { kind: 'stream-message-stop' })
    this.streamItemId = null
    this.streamBlockType = null
  }

  private onDelta(
    ctx: ChatDriverContext,
    params: CodexDeltaNotification,
    blockType: 'text' | 'thinking',
    _kind: string
  ): void {
    if (!params || !params.delta) return
    // Open lazily if the matching `item/started` was missed or arrived for a
    // different modality.
    if (this.streamItemId !== params.itemId || this.streamBlockType !== blockType) {
      this.openStream(ctx, params.itemId, blockType)
    }
    this.emit(ctx, {
      kind: 'stream-block-delta',
      blockIndex: 0,
      deltaType: blockType,
      text: params.delta
    })
  }

  // ---- helpers ----

  /**
   * A Codex error as chat shows it: the CLI's plain message (never its JSON
   * blob). The CLI refusing a model because it is too old ends the session
   * (`cli-too-old`, fatal: Retry once updated); a model the account may not use
   * says what to do (`model-refused`; another model may work).
   */
  private errorEvent(raw: string, prefix = ''): AgentEvent {
    const message = readableCodexError(raw)
    const installed = this.cliVersion ? { installed: this.cliVersion } : {}
    if (/requires a newer version of codex/i.test(message)) {
      return {
        kind: 'error',
        message: `${message} Update Codex${installedPart(this.cliVersion)}: \`${codexChatBackend.updateCommand}\`, then press Retry.`,
        detail: { code: 'cli-too-old', ...installed, fatal: true }
      }
    }
    if (/not supported when using codex/i.test(message)) {
      return {
        kind: 'error',
        message: `${message} Pick another model${
          this.cliVersion ? `, or update Codex${installedPart(this.cliVersion)}` : ''
        } (\`${codexChatBackend.updateCommand}\`).`,
        detail: { code: 'model-refused', ...installed }
      }
    }
    return { kind: 'error', message: `${prefix}${message}` }
  }

  private onTokenUsage(ctx: ChatDriverContext, params: CodexTokenUsageNotification): void {
    const usage = params?.tokenUsage
    if (usage?.last) {
      const tokens = usage.last.totalTokens ?? 0
      const window = usage.modelContextWindow ?? null
      const prev = this.lastContext
      if (!prev || prev.tokens !== tokens || prev.window !== window) {
        this.lastContext = { tokens, window }
        this.emit(ctx, { kind: 'context-usage', contextTokens: tokens, contextWindow: window })
      }
    }
    const last = usage?.last
    if (!last) return
    this.lastUsage = {
      inputTokens: last.inputTokens ?? 0,
      outputTokens: last.outputTokens ?? 0,
      cacheReadInputTokens: last.cachedInputTokens ?? 0,
      cacheCreationInputTokens: 0
    }
  }

  private emitTurnResult(
    ctx: ChatDriverContext,
    status: 'completed' | 'interrupted' | 'failed' | 'inProgress',
    durationMs: number
  ): void {
    // 0.159.2 sends no item/completed for a command a Stop cut off.
    for (const [id, out] of this.commands) if (!out.ended) this.endCommand(ctx, id, 'killed')
    this.currentTurnId = null
    if (this.turnStartsInFlight === 0) {
      this.settlePendingInterrupt(undefined)
      for (const wake of this.turnEndWaiters.splice(0)) wake()
    }
    this.emit(ctx, {
      kind: 'result',
      subtype: status === 'failed' ? 'error' : status,
      isError: status === 'failed',
      durationMs,
      durationApiMs: durationMs,
      numTurns: 1,
      totalCostUsd: 0,
      stopReason: null,
      terminalReason: null,
      text: null,
      modelUsage: {},
      usage: this.lastUsage,
      permissionDenials: []
    })
  }

  private onServerRequest(method: string, params: unknown, id: JsonRpcId): void {
    const ctx = this.ctx
    if (!ctx) return
    if (method === 'currentTime/read') {
      this.client?.respond(id, { currentTimeAt: Math.floor(Date.now() / 1000) })
      return
    }
    if (!PROMPT_METHODS.has(method)) {
      // Dynamic tools, externally managed tokens, attestation: chat declares
      // none of them. An error, so Codex isn't left hanging.
      this.client?.respondError(id, -32601, `unhandled server request ${method}`)
      return
    }
    const p = (params ?? {}) as Record<string, unknown>
    const requestId = String(id)
    this.pendingRequests.set(requestId, { id, method, params: p })
    this.emit(ctx, {
      kind: 'permission-request',
      requestId,
      toolName: method,
      toolUseId: promptToolUseId(p),
      input: params ?? null,
      ...promptDisplay(method, p)
    })
  }

  private emit(ctx: ChatDriverContext, event: AgentEvent): void {
    ctx.emit(event)
  }
}

/**
 * `AgentBackend` for the `codex-chat` mode. `buildSpawnArgs` returns the
 * `app-server` subcommand; `createDriver` mints one `CodexChatSession` per
 * spawn. `codex` reuses the user's existing `codex login` — no API key.
 */
export const codexChatBackend: AgentBackend = {
  binaryName: 'codex',
  displayName: 'Codex',
  updateCommand: 'npm install -g @openai/codex',
  // The protocol, transcripts and fake are 0.159.2's (codex-protocol-drift.test.ts).
  // An older CLI still runs; chat says it is untested (its own refusals are errors).
  minTestedCliVersion: '0.159.2',
  // `thread/start` answers with the thread id the server minted.
  mintsConversationId: true,
  // `thread/fork {lastTurnId}`: through a user message's turn.
  forkAt: 'message',
  buildSpawnArgs: () => ({ args: ['app-server'] }),
  createDriver: () => new CodexChatSession()
}
