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
import type { AgentEvent, TokenUsage } from '../../../shared/agent-events'
import type {
  AgentBackend,
  ChatDriverContext,
  ChatSessionDriver,
  PermissionDecision
} from '../types'
import { CodexAppServerClient, type JsonRpcId } from './codex-app-server-client'
import { defaultModelForMode } from '../../../shared/chat-model-catalog'
import { CODEX_FAST_SERVICE_TIER } from '../../../shared/chat-fast-mode'
import { CODEX_DEFAULT_INSTRUCTIONS, CODEX_PLAN_INSTRUCTIONS } from './codex-collaboration-instructions'
import type {
  CodexApprovalDecision,
  CodexApprovalPolicy,
  CodexCollaborationMode,
  CodexDeltaNotification,
  CodexErrorNotification,
  CodexItemNotification,
  CodexModeKind,
  CodexPlanNotification,
  CodexReasoningEffort,
  CodexSandboxMode,
  CodexSandboxPolicy,
  CodexThreadStartResponse,
  CodexTokenUsageNotification,
  CodexTurnNotification,
  CodexTurnStartResponse
} from './codex-protocol'

const CLIENT_INFO = { name: 'slayzone', title: 'SlayZone', version: '1.0' } as const
const HANDSHAKE_TIMEOUT_MS = 30_000
/** A turn streams via notifications; its `turn/start` reply is quick, but a
 *  slow first model token can still delay it — keep the request unbounded. */
const TURN_REQUEST_TIMEOUT_MS = 0

/** Server→client approval request methods Codex can send. */
const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'applyPatchApproval',
  'execCommandApproval'
])

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

/** Map a SlayZone reasoning-effort alias onto Codex's `ReasoningEffort` enum. */
function mapEffort(effort: string | null): CodexReasoningEffort | undefined {
  switch (effort) {
    case 'none':
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return effort
    case 'max':
      // SlayZone's `max` has no Codex equivalent — clamp to the highest.
      return 'xhigh'
    default:
      return undefined
  }
}

/** Translate a SlayZone permission decision to a Codex approval decision. */
function mapApprovalDecision(decision: PermissionDecision): CodexApprovalDecision {
  return decision.behavior === 'allow' ? 'accept' : 'decline'
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

class CodexChatSession implements ChatSessionDriver {
  private ctx: ChatDriverContext | null = null
  private client: CodexAppServerClient | null = null
  private threadId: string | null = null
  private currentTurnId: string | null = null
  private handshakeDone = false
  private disposed = false

  /** User messages sent before the handshake resolved; flushed once it does. */
  private readonly queued: string[] = []
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

  /** requestId (string) → live JSON-RPC id of a pending Codex approval request. */
  private readonly pendingApprovals = new Map<string, JsonRpcId>()

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
      await client.request(
        'initialize',
        {
          clientInfo: CLIENT_INFO,
          capabilities: { experimentalApi: true, requestAttestation: false }
        },
        HANDSHAKE_TIMEOUT_MS
      )
    } catch (err) {
      this.emitFatalStartError(ctx, err)
      return
    }
    client.notify('initialized')

    const policy = mapRuntimePolicy(this.mode, ctx.cwd)
    let resp: CodexThreadStartResponse
    if (ctx.resume && ctx.sessionId) {
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
        // Resume failed — emit a `stderr` marker the transport's
        // `detectResumeFailure` recognizes so it respawns fresh (which clears
        // the stale stored thread id via `onInvalidResume`). Stop here.
        this.emit(ctx, {
          kind: 'stderr',
          text: `No conversation found for Codex thread ${ctx.sessionId}: ${
            err instanceof Error ? err.message : String(err)
          }`
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
    this.handshakeDone = true
    // Synthetic turn-init so the timeline reducer materializes a session-start
    // row and `extractSessionId` can persist the thread id for resume.
    this.emit(ctx, {
      kind: 'turn-init',
      sessionId: resp.thread.id,
      model: this.model ?? resp.model,
      cwd: resp.cwd,
      tools: [],
      permissionMode: this.mode ?? undefined
    })
    // Flush any messages the user sent before the handshake completed.
    const pending = this.queued.splice(0)
    for (const text of pending) this.startTurn(text)
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
      this.queued.push(text)
      return
    }
    this.startTurn(text)
  }

  /**
   * Build the `turn/start.collaborationMode` payload for the current
   * collaboration setting. Returns undefined when no collaboration mode is
   * set so the param is omitted entirely (Codex falls back to its default).
   */
  private buildCollaborationMode(): CodexCollaborationMode | undefined {
    const kind = mapCollaboration(this.collaboration)
    if (!kind) return undefined
    return {
      mode: kind,
      settings: {
        model: codexModelOrUndefined(this.model) ?? defaultModelForMode('codex-chat'),
        reasoning_effort: mapEffort(this.effort) ?? 'medium',
        developer_instructions:
          kind === 'plan' ? CODEX_PLAN_INSTRUCTIONS : CODEX_DEFAULT_INSTRUCTIONS
      }
    }
  }

  private startTurn(text: string): void {
    const client = this.client
    const ctx = this.ctx
    if (!client || !ctx || !this.threadId) return
    const policy = mapRuntimePolicy(this.mode, ctx.cwd)
    const effort = mapEffort(this.effort)
    const model = codexModelOrUndefined(this.model)
    const collaborationMode = this.buildCollaborationMode()
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
          ...(this.fastMode ? { serviceTier: CODEX_FAST_SERVICE_TIER } : {})
        },
        TURN_REQUEST_TIMEOUT_MS
      )
      .then((res) => {
        this.currentTurnId = res.turn.id
      })
      .catch((err) => {
        this.emit(ctx, {
          kind: 'error',
          message: `Codex turn failed: ${err instanceof Error ? err.message : String(err)}`
        })
        // Balance the in-flight counter so the typing indicator clears.
        this.emitTurnResult(ctx, 'failed', 0)
      })
  }

  applyControl(request: Record<string, unknown>): Promise<unknown> {
    const subtype = typeof request.subtype === 'string' ? request.subtype : ''
    if (subtype === 'interrupt') {
      const client = this.client
      if (client && this.threadId && this.currentTurnId) {
        return client.request('turn/interrupt', {
          threadId: this.threadId,
          turnId: this.currentTurnId
        })
      }
      return Promise.resolve()
    }
    // Model / effort / mode are applied per-turn via `turn/start` params — just
    // update the in-memory fields; the next turn picks them up. No respawn.
    if (subtype === 'set_model' && typeof request.model === 'string') {
      this.model = request.model
    } else if (subtype === 'set_permission_mode' && typeof request.mode === 'string') {
      this.mode = request.mode
    } else if (subtype === 'set_effort' && typeof request.effort === 'string') {
      this.effort = request.effort
    } else if (subtype === 'set_collaboration' && typeof request.collaboration === 'string') {
      this.collaboration = request.collaboration
    } else if (subtype === 'set_fast' && typeof request.fastMode === 'boolean') {
      this.fastMode = request.fastMode
    }
    return Promise.resolve({ ok: true })
  }

  respondPermission(args: { requestId: string; decision: PermissionDecision }): boolean {
    const client = this.client
    if (!client) return false
    const jsonRpcId = this.pendingApprovals.get(args.requestId)
    if (jsonRpcId === undefined) return false
    this.pendingApprovals.delete(args.requestId)
    client.respond(jsonRpcId, { decision: mapApprovalDecision(args.decision) })
    return true
  }

  extractSessionId(event: AgentEvent): string | null {
    return event.kind === 'turn-init' ? event.sessionId : null
  }

  dispose(): void {
    this.disposed = true
    this.client?.dispose()
    this.pendingApprovals.clear()
  }

  // ---- notification handling ----

  private onNotification(method: string, params: unknown): void {
    const ctx = this.ctx
    if (!ctx || this.disposed) return
    switch (method) {
      case 'turn/started':
        this.currentTurnId =
          (params as CodexTurnNotification | undefined)?.turn?.id ?? this.currentTurnId
        return
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
        this.onTokenUsage(params as CodexTokenUsageNotification)
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
        this.closeStream(ctx)
        this.emitTurnResult(ctx, p.turn?.status ?? 'completed', p.turn?.durationMs ?? 0)
        return
      }
      case 'error': {
        const p = params as CodexErrorNotification
        this.emit(ctx, { kind: 'error', message: p.error?.message ?? 'Codex error' })
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
    const toolCall = this.toToolCall(item)
    if (toolCall) this.emit(ctx, toolCall)
  }

  private onItemCompleted(ctx: ChatDriverContext, params: CodexItemNotification): void {
    const item = params?.item
    if (!item) return
    if (item.type === 'userMessage') return
    if (item.type === 'agentMessage' || item.type === 'reasoning') {
      if (this.streamItemId === item.id) this.closeStream(ctx)
      return
    }
    const toolResult = this.toToolResult(item)
    if (toolResult) this.emit(ctx, toolResult)
  }

  /** Codex tool-ish items → `tool-call`. Returns null for non-tool items. */
  private toToolCall(item: Record<string, unknown> & { type: string; id: string }): AgentEvent | null {
    switch (item.type) {
      case 'commandExecution':
        return {
          kind: 'tool-call',
          id: item.id,
          name: 'codex/commandExecution',
          input: { command: item.command, cwd: item.cwd }
        }
      case 'fileChange':
        return {
          kind: 'tool-call',
          id: item.id,
          name: 'codex/fileChange',
          input: { changes: item.changes }
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
          input: { query: item.query }
        }
      default:
        return null
    }
  }

  /** Codex tool-ish completed items → `tool-result`. Returns null otherwise. */
  private toToolResult(
    item: Record<string, unknown> & { type: string; id: string }
  ): AgentEvent | null {
    const toolTypes = ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch']
    if (!toolTypes.includes(item.type)) return null
    const status = typeof item.status === 'string' ? item.status : ''
    const isError = status === 'failed' || status === 'declined' || item.success === false
    const rawContent =
      typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : ''
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

  private onTokenUsage(params: CodexTokenUsageNotification): void {
    const last = params?.tokenUsage?.last
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
    this.currentTurnId = null
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
    if (!APPROVAL_METHODS.has(method)) {
      // Unknown server request — decline politely so Codex isn't left hanging.
      this.client?.respondError(id, -32601, `unhandled server request ${method}`)
      return
    }
    const p = (params ?? {}) as Record<string, unknown>
    const requestId = String(id)
    this.pendingApprovals.set(requestId, id)
    this.emit(ctx, {
      kind: 'permission-request',
      requestId,
      toolName: method,
      toolUseId: typeof p.itemId === 'string' ? p.itemId : '',
      input: params ?? null
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
  buildSpawnArgs: () => ({ args: ['app-server'] }),
  createDriver: () => new CodexChatSession()
}
