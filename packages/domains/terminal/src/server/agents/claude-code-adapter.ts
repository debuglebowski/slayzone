import type {
  AgentEvent,
  OutgoingUserMessage,
  ResultEvent,
  ModelUsage,
  TokenUsage
} from '@slayzone/terminal-contracts'
import type { AgentAdapter, AgentSpawnOpts, SpawnArgs } from './types'
import { classifyClaudeHookResponse } from './claude-hook-output'

/**
 * Claude Code stream-json transport.
 *
 * Emits via: claude -p --input-format stream-json --output-format stream-json --verbose ...
 * Schema reverse-engineered from real sessions — see
 * packages/domains/terminal/test/fixtures/claude-stream/SPIKE.md.
 */
export const claudeCodeAdapter: AgentAdapter = {
  id: 'claude-code',
  binaryName: 'claude',

  buildSpawnArgs(opts: AgentSpawnOpts): SpawnArgs {
    const base = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      // `stdio` is the SDK's sentinel value for permission_prompt_tool_name —
      // it tells the CLI to route prompt-style tool calls (notably
      // AskUserQuestion, plus any tool the active permission mode hasn't
      // already auto-approved) via control_request on stdout instead of
      // dispatching to an MCP tool. Host (transport) parses the inbound
      // request, surfaces it to the renderer, and writes the user's answer
      // back as a control_response with `behavior:'allow'` + `updatedInput`.
      // Verified mechanism in claude-agent-sdk-python `_internal/client.py`.
      '--permission-prompt-tool',
      'stdio',
      // Every hook run arrives as system/hook_started + hook_response (without
      // it only SessionStart's do). The parser keeps the ones that blocked,
      // failed or told the model something; the rest are dropped unpersisted.
      '--include-hook-events',
      // Echo each user message back with its `uuid`: with `command_lifecycle`,
      // the CLI's own confirmation that it has the message (the outbox's
      // `delivered`). Also what rewind/fork (plan 3.3) keys on.
      '--replay-user-messages'
    ]
    if (opts.resume) {
      base.push('--resume', opts.sessionId)
    } else {
      base.push('--session-id', opts.sessionId)
    }
    base.push(...opts.providerFlags)
    return { args: base }
  },

  parseLine(line: string): AgentEvent | null {
    const trimmed = line.trim()
    if (!trimmed) return null

    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(trimmed)
    } catch {
      return { kind: 'unknown', reason: 'parse-error', raw: trimmed }
    }
    if (typeof obj !== 'object' || obj === null) {
      return { kind: 'unknown', reason: 'shape-mismatch', raw: obj }
    }

    // Every Claude Code envelope (system / assistant / user / stream_event) carries
    // `parent_tool_use_id` at the top level. When non-null, the event was emitted by
    // a sub-agent spawned via the Task tool — used downstream to nest in the timeline.
    const parent = typeof obj.parent_tool_use_id === 'string' ? obj.parent_tool_use_id : undefined

    const type = obj.type
    switch (type) {
      case 'system':
        return parseSystem(obj, parent)
      case 'assistant':
        return parseAssistant(obj, parent)
      case 'user':
        return parseUser(obj, parent)
      case 'result':
        return parseResult(obj)
      case 'rate_limit_event':
        return parseRateLimit(obj)
      case 'stream_event':
        return parseStreamEvent(obj, parent)
      case 'control_response':
        return parseControlResponse(obj)
      case 'control_request':
        return parseControlRequest(obj)
      case 'control_cancel_request':
        return parseControlCancelRequest(obj)
      case 'command_lifecycle':
        return parseCommandLifecycle(obj)
      default:
        return { kind: 'unknown', reason: 'unknown-type', raw: obj }
    }
  },

  serializeUserMessage(text: string, _sessionId: string): string {
    return JSON.stringify({
      type: 'user',
      message: { role: 'user', content: text }
    })
  },

  serializeUserTurn(message: OutgoingUserMessage): string {
    // One text block travels as a plain string, exactly like `serializeUserMessage`;
    // anything richer (3.5 attachments) as the block array the CLI accepts.
    const only = message.content.length === 1 ? message.content[0] : null
    return JSON.stringify({
      type: 'user',
      uuid: message.id,
      message: {
        role: 'user',
        content: only && only.type === 'text' ? only.text : message.content
      }
    })
  },

  serializeControlRequest({ requestId, request }): string {
    return JSON.stringify({
      type: 'control_request',
      request_id: requestId,
      request
    })
  },

  serializeControlResponse({ requestId, response, isError, error }): string {
    if (isError) {
      return JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: requestId,
          error: error ?? 'unknown error'
        }
      })
    }
    return JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: response ?? {}
      }
    })
  },

  serializeToolResult({ toolUseId, content, isError }): string {
    return JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content,
            ...(isError ? { is_error: true } : {})
          }
        ]
      }
    })
  },

  extractSessionId(event: AgentEvent): string | null {
    if (event.kind === 'turn-init') return event.sessionId
    return null
  }
}

// ------- internal parsers ---------

/**
 * Parse Claude Code's stream_event wrapper which envelopes one Anthropic SSE event.
 * Shape: `{"type":"stream_event","event":{...anthropic...},"parent_tool_use_id":null,"session_id":"..."}`.
 */
function parseStreamEvent(
  obj: Record<string, unknown>,
  parent: string | undefined
): AgentEvent | null {
  const inner = obj.event as Record<string, unknown> | undefined
  if (!inner || typeof inner !== 'object') return null
  const t = inner.type
  switch (t) {
    case 'message_start': {
      const message = inner.message as { id?: string } | undefined
      return { kind: 'stream-message-start', messageId: message?.id ?? '', parentToolUseId: parent }
    }
    case 'content_block_start': {
      const block = inner.content_block as { type?: string; id?: string; name?: string } | undefined
      const index = typeof inner.index === 'number' ? inner.index : 0
      if (!block) return null
      if (block.type === 'text') {
        return {
          kind: 'stream-block-start',
          blockIndex: index,
          blockType: 'text',
          parentToolUseId: parent
        }
      }
      if (block.type === 'thinking') {
        return {
          kind: 'stream-block-start',
          blockIndex: index,
          blockType: 'thinking',
          parentToolUseId: parent
        }
      }
      if (block.type === 'tool_use') {
        return {
          kind: 'stream-block-start',
          blockIndex: index,
          blockType: 'tool_use',
          toolUseId: block.id,
          toolName: block.name,
          parentToolUseId: parent
        }
      }
      return null
    }
    case 'content_block_delta': {
      const d = inner.delta as
        | {
            type?: string
            text?: string
            thinking?: string
            signature?: string
            partial_json?: string
          }
        | undefined
      const index = typeof inner.index === 'number' ? inner.index : 0
      if (!d) return null
      if (d.type === 'text_delta') {
        return {
          kind: 'stream-block-delta',
          blockIndex: index,
          deltaType: 'text',
          text: d.text ?? '',
          parentToolUseId: parent
        }
      }
      if (d.type === 'thinking_delta') {
        return {
          kind: 'stream-block-delta',
          blockIndex: index,
          deltaType: 'thinking',
          text: d.thinking ?? '',
          parentToolUseId: parent
        }
      }
      if (d.type === 'signature_delta') {
        return {
          kind: 'stream-block-delta',
          blockIndex: index,
          deltaType: 'signature',
          text: d.signature ?? '',
          parentToolUseId: parent
        }
      }
      if (d.type === 'input_json_delta') {
        return {
          kind: 'stream-block-delta',
          blockIndex: index,
          deltaType: 'input_json',
          text: d.partial_json ?? '',
          parentToolUseId: parent
        }
      }
      return null
    }
    case 'content_block_stop': {
      const index = typeof inner.index === 'number' ? inner.index : 0
      return { kind: 'stream-block-stop', blockIndex: index, parentToolUseId: parent }
    }
    case 'message_stop':
      return { kind: 'stream-message-stop', parentToolUseId: parent }
    case 'message_delta':
      return null
    default:
      return null
  }
}

function parseSystem(obj: Record<string, unknown>, parent: string | undefined): AgentEvent | null {
  const subtype = obj.subtype as string | undefined
  if (subtype === 'init') {
    return {
      kind: 'turn-init',
      sessionId: (obj.session_id as string) ?? '',
      model: (obj.model as string) ?? '',
      cwd: (obj.cwd as string) ?? '',
      tools: Array.isArray(obj.tools) ? (obj.tools as string[]) : [],
      permissionMode: (obj.permissionMode as string) ?? undefined,
      slashCommands: toStringList(obj.slash_commands),
      terminalSlashCommands: toStringList(obj.terminal_slash_commands),
      skills: toStringList(obj.skills),
      cliVersion: typeof obj.claude_code_version === 'string' ? obj.claude_code_version : undefined
    }
  }
  if (subtype === 'compact_boundary') {
    const meta = (obj.compact_metadata ?? {}) as Record<string, unknown>
    return {
      kind: 'compact-boundary',
      trigger: meta.trigger === 'manual' || meta.trigger === 'auto' ? meta.trigger : undefined,
      preTokens: toOptionalNum(meta.pre_tokens),
      postTokens: toOptionalNum(meta.post_tokens),
      durationMs: toOptionalNum(meta.duration_ms)
    }
  }
  if (subtype === 'status') {
    // `compacting` opens a compaction; the frame that carries `compact_result`
    // closes it. `requesting` (per API call) is a transport heartbeat; any other
    // status (a bare `null`) has no surface — drop it rather than persist it as
    // `unknown`.
    if (obj.compact_result === 'success') return { kind: 'compact-status', phase: 'succeeded' }
    if (obj.compact_result === 'failed') {
      return {
        kind: 'compact-status',
        phase: 'failed',
        ...(typeof obj.compact_error === 'string' ? { error: obj.compact_error } : {})
      }
    }
    if (obj.status === 'compacting') return { kind: 'compact-status', phase: 'started' }
    // A mode switch made mid-session (plan approval, "switch to accept edits",
    // set_permission_mode) is only reported here until the next turn's init.
    if (typeof obj.permissionMode === 'string') {
      return { kind: 'permission-mode-changed', mode: obj.permissionMode }
    }
    // An API request just started: the agent is working, silently.
    if (obj.status === 'requesting') return { kind: 'heartbeat', source: 'status:requesting' }
    return null
  }
  if (subtype === 'thinking_tokens') {
    // Thinking progress (estimated tokens): no chat surface, but proof of life.
    return { kind: 'heartbeat', source: 'thinking_tokens' }
  }
  if (subtype === 'local_command_output') {
    return {
      kind: 'command-output',
      id: typeof obj.uuid === 'string' ? obj.uuid : '',
      command: null,
      text: typeof obj.content === 'string' ? obj.content : ''
    }
  }
  if (subtype === 'task_started' || subtype === 'task_updated' || subtype === 'task_notification') {
    const usageRaw = (obj.usage ?? null) as Record<string, unknown> | null
    const usage =
      usageRaw &&
      (usageRaw.total_tokens != null || usageRaw.tool_uses != null || usageRaw.duration_ms != null)
        ? {
            totalTokens: toNum(usageRaw.total_tokens),
            toolUses: toNum(usageRaw.tool_uses),
            durationMs: toNum(usageRaw.duration_ms)
          }
        : undefined
    // All three `task_*` system events map to the same semantic state:
    // 'in-flight'. The sub-agent row is closed (→ 'completed'/'failed') by the
    // outer Task tool's `tool-result`, which is contract-guaranteed (every
    // tool_use → exactly one tool_result). Notification is kept purely as
    // enrichment for usage stats. See chat-timeline reducer for the close.
    return {
      kind: 'sub-agent',
      phase: 'in-flight',
      toolUseId: (obj.tool_use_id as string) ?? '',
      parentToolUseId: parent,
      description: typeof obj.description === 'string' ? obj.description : undefined,
      status: typeof obj.status === 'string' ? obj.status : undefined,
      summary: typeof obj.summary === 'string' ? obj.summary : undefined,
      usage,
      raw: obj
    }
  }
  if (subtype === 'api_retry') {
    return {
      kind: 'api-retry',
      attempt: (obj.attempt as number) ?? 0,
      maxRetries: (obj.max_retries as number) ?? 0,
      delayMs: (obj.retry_delay_ms as number) ?? 0,
      error: (obj.error as string) ?? ''
    }
  }
  // A hook run that blocked, failed or told the model something is shown; the
  // rest (most runs) is dropped so it is never buffered or persisted.
  if (subtype === 'hook_response') return classifyClaudeHookResponse(obj)
  // A hook's `systemMessage` (and other CLI notices for the user).
  if (subtype === 'informational') {
    return {
      kind: 'notice',
      id: typeof obj.uuid === 'string' ? obj.uuid : '',
      level: typeof obj.level === 'string' ? obj.level : 'info',
      text: typeof obj.content === 'string' ? obj.content : ''
    }
  }
  // Drop noise that has no surface in the chat UI: hook start / progress
  // frames, plus sub-agent progress ticks (the surrounding `task_started` /
  // `task_notification` already carry the user-visible signal). Returning null
  // here avoids buffering and persisting events that would otherwise render as
  // "unsupported event".
  if (subtype === 'hook_started' || subtype === 'hook_progress' || subtype === 'task_progress') {
    return null
  }
  return { kind: 'unknown', reason: 'unknown-type', raw: obj }
}

interface RawContentBlock {
  type?: string
  text?: string
  thinking?: string
  signature?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
}

function parseAssistant(obj: Record<string, unknown>, parent: string | undefined): AgentEvent {
  const message = obj.message as
    | { id?: string; model?: string; content?: RawContentBlock[]; usage?: unknown }
    | undefined
  if (!message) return { kind: 'unknown', reason: 'shape-mismatch', raw: obj }
  const messageId = message.id ?? ''
  const blocks = Array.isArray(message.content) ? message.content : []

  // A slash command the CLI ran locally (`/context`, `/usage`, a failed
  // `/compact`, …) comes back as a synthetic assistant message tagged with
  // `local_command_run`. It is command output, not a model reply, and its
  // all-zero usage must not read as the conversation's context size.
  const localRun = obj.local_command_run as { command?: unknown } | undefined
  if (localRun && typeof localRun === 'object') {
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n')
    return {
      kind: 'command-output',
      id: typeof obj.uuid === 'string' ? obj.uuid : messageId,
      command: typeof localRun.command === 'string' ? localRun.command : null,
      text
    }
  }
  const usage = message.model === '<synthetic>' ? undefined : parseCallUsage(message.usage)

  // Spike B confirmed: assistant events are block-scoped (one content block per event).
  // If we ever see multiple blocks, take the first — reducer can handle it, but warn.
  const block = blocks[0]
  if (!block) return { kind: 'unknown', reason: 'shape-mismatch', raw: obj }

  if (block.type === 'text') {
    return {
      kind: 'assistant-text',
      messageId,
      text: block.text ?? '',
      parentToolUseId: parent,
      ...(usage ? { usage } : {})
    }
  }
  if (block.type === 'thinking') {
    return {
      kind: 'assistant-thinking',
      messageId,
      text: block.thinking ?? '',
      hasSignature: Boolean(block.signature),
      parentToolUseId: parent,
      ...(usage ? { usage } : {})
    }
  }
  if (block.type === 'tool_use') {
    return {
      kind: 'tool-call',
      id: block.id ?? '',
      name: block.name ?? '',
      input: block.input,
      parentToolUseId: parent,
      ...(usage ? { usage } : {})
    }
  }
  return { kind: 'unknown', reason: 'unknown-type', raw: obj }
}

function parseUser(obj: Record<string, unknown>, parent: string | undefined): AgentEvent | null {
  // `--replay-user-messages` echo of a message we sent: its `uuid` is ours —
  // the CLI's confirmation it received it. Never a timeline event.
  if (obj.isReplay === true) {
    return typeof obj.uuid === 'string' ? { kind: 'user-replay', uuid: obj.uuid } : null
  }
  const message = obj.message as { content?: RawContentBlock[] | string } | undefined
  const toolUseResult = obj.tool_use_result
  // Plain-string user records are CLI-synthesized context (the compaction
  // summary, replayed local-command stdout) — never a chat-visible event.
  // Except stderr of a local command: a custom command whose `!shell` line was
  // refused reports only that, and runs no turn.
  if (message && typeof message.content === 'string') {
    const stderr = /^\s*<local-command-stderr>([\s\S]*)<\/local-command-stderr>\s*$/.exec(
      message.content
    )
    if (!stderr) return null
    return {
      kind: 'command-output',
      id: typeof obj.uuid === 'string' ? obj.uuid : '',
      command: null,
      text: stderr[1].trim(),
      isError: true
    }
  }
  if (!message || !Array.isArray(message.content)) {
    return { kind: 'unknown', reason: 'shape-mismatch', raw: obj }
  }
  const block = message.content[0]
  if (block?.type !== 'tool_result' || !block.tool_use_id) {
    // SDK echoes the user's prompt back as a `user`/text record; we already
    // emit a synthetic `user-message` for that send, so the echo is a dup.
    // Drop it here instead of letting it become an "unsupported event" row.
    if (block?.type === 'text') return null
    return { kind: 'unknown', reason: 'shape-mismatch', raw: obj }
  }
  const rawContent = block.content
  // is_error can be boolean field on block, or inferred from structured result
  const isError = Boolean((block as { is_error?: boolean }).is_error)
  return {
    kind: 'tool-result',
    toolUseId: block.tool_use_id,
    isError,
    rawContent: rawContent ?? null,
    structured: toolUseResult ?? null,
    parentToolUseId: parent
  }
}

function parseResult(obj: Record<string, unknown>): ResultEvent {
  const usage = (obj.usage ?? {}) as Record<string, unknown>
  const modelUsageRaw = (obj.modelUsage ?? {}) as Record<string, Record<string, unknown>>
  const modelUsage: Record<string, ModelUsage> = {}
  for (const [model, u] of Object.entries(modelUsageRaw)) {
    modelUsage[model] = {
      inputTokens: toNum(u.inputTokens),
      outputTokens: toNum(u.outputTokens),
      cacheReadInputTokens: toNum(u.cacheReadInputTokens),
      cacheCreationInputTokens: toNum(u.cacheCreationInputTokens),
      costUsd: toNum(u.costUSD),
      ...(typeof u.contextWindow === 'number' ? { contextWindow: u.contextWindow } : {}),
      ...(typeof u.maxOutputTokens === 'number' ? { maxOutputTokens: u.maxOutputTokens } : {})
    }
  }
  const tokenUsage: TokenUsage = {
    inputTokens: toNum(usage.input_tokens),
    outputTokens: toNum(usage.output_tokens),
    cacheReadInputTokens: toNum(usage.cache_read_input_tokens),
    cacheCreationInputTokens: toNum(usage.cache_creation_input_tokens)
  }
  return {
    kind: 'result',
    subtype: (obj.subtype as string) ?? 'unknown',
    isError: Boolean(obj.is_error),
    durationMs: toNum(obj.duration_ms),
    durationApiMs: toNum(obj.duration_api_ms),
    numTurns: toNum(obj.num_turns),
    totalCostUsd: toNum(obj.total_cost_usd),
    stopReason: (obj.stop_reason as string) ?? null,
    terminalReason: (obj.terminal_reason as string) ?? null,
    text: (obj.result as string) ?? null,
    modelUsage,
    usage: tokenUsage,
    permissionDenials: Array.isArray(obj.permission_denials) ? obj.permission_denials : []
  }
}

/**
 * Inbound `{type:"control_request", request_id, request:{subtype, ...}}`.
 *
 * `can_use_tool` surfaces under `--permission-prompt-tool stdio` whenever the
 * CLI needs the host to decide a tool's fate (AskUserQuestion, ExitPlanMode,
 * and any tool the active permission mode hasn't already auto-approved). The
 * display fields drive the approval card (shapes: CLI spike report, item 1).
 *
 * Every other subtype (`hook_callback`, `mcp_message`, future ones) becomes a
 * transport-internal `host-control-request` the driver answers with an error:
 * the CLI blocks on an unanswered request (30 s for a hook, then the prompt is
 * refused). A request without an id can't be answered at all.
 */
function parseControlRequest(obj: Record<string, unknown>): AgentEvent {
  const requestId = typeof obj.request_id === 'string' ? obj.request_id : ''
  const request = (obj.request ?? {}) as Record<string, unknown>
  const subtype = request.subtype
  if (!requestId || typeof subtype !== 'string') {
    return { kind: 'unknown', reason: 'shape-mismatch', raw: obj }
  }
  if (subtype !== 'can_use_tool') {
    return { kind: 'host-control-request', requestId, subtype }
  }
  const mcp = request.mcp_server as { name?: unknown; source?: unknown } | null | undefined
  return {
    kind: 'permission-request',
    requestId,
    toolName: typeof request.tool_name === 'string' ? request.tool_name : '',
    toolUseId: typeof request.tool_use_id === 'string' ? request.tool_use_id : '',
    input: request.input ?? null,
    permissionSuggestions: request.permission_suggestions,
    ...optionalString('displayName', request.display_name),
    ...optionalString('title', request.title),
    ...optionalString('description', request.description),
    ...optionalString('decisionReason', request.decision_reason),
    ...optionalString('decisionReasonType', request.decision_reason_type),
    ...optionalString('blockedPath', request.blocked_path),
    ...optionalString('agentId', request.agent_id),
    ...(mcp && typeof mcp.name === 'string'
      ? {
          mcpServer: {
            name: mcp.name,
            ...(typeof mcp.source === 'string' ? { source: mcp.source } : {})
          }
        }
      : {}),
    ...optionalTrue('suppressAlwaysAllow', request.suppress_always_allow_rule),
    ...optionalTrue('defaultToNo', request.default_to_no),
    ...optionalTrue('requiresUserInteraction', request.requires_user_interaction),
    ...optionalTrue('serverPolicyAskOnly', request.server_policy_ask_only)
  }
}

/** Absent or non-string wire fields stay absent (no `undefined` keys persisted). */
function optionalString<K extends string>(key: K, v: unknown): { [P in K]?: string } {
  return (typeof v === 'string' ? { [key]: v } : {}) as { [P in K]?: string }
}

function optionalTrue<K extends string>(key: K, v: unknown): { [P in K]?: true } {
  return (v === true ? { [key]: true } : {}) as { [P in K]?: true }
}

/**
 * `{type:"control_cancel_request", request_id}` — the CLI withdrew one of its
 * own pending requests (sent for a pending `can_use_tool` on interrupt).
 */
function parseControlCancelRequest(obj: Record<string, unknown>): AgentEvent {
  if (typeof obj.request_id !== 'string' || !obj.request_id) {
    return { kind: 'unknown', reason: 'shape-mismatch', raw: obj }
  }
  return { kind: 'permission-cancelled', requestId: obj.request_id }
}

/**
 * `{type:"control_response", response:{subtype:"success"|"error", request_id, ...}}`.
 * Mirrors the SDK's stdin → stdout reply for control_request envelopes.
 */
function parseControlResponse(obj: Record<string, unknown>): AgentEvent | null {
  const response = obj.response as Record<string, unknown> | undefined
  if (!response || typeof response !== 'object') {
    return { kind: 'unknown', reason: 'shape-mismatch', raw: obj }
  }
  const requestId = response.request_id
  if (typeof requestId !== 'string') {
    return { kind: 'unknown', reason: 'shape-mismatch', raw: obj }
  }
  const subtype = response.subtype
  const isError = subtype === 'error'
  const error = typeof response.error === 'string' ? response.error : undefined
  // Strip envelope fields so `data` is just the payload (subtype/request_id are
  // routing metadata, not user data).
  const { subtype: _s, request_id: _r, error: _e, ...data } = response
  void _s
  void _r
  void _e
  return {
    kind: 'control-response',
    requestId,
    isError,
    data,
    error
  }
}

/**
 * `{type:"command_lifecycle", command_uuid, state}` — the CLI's delivery state for
 * a user message that carried a `uuid`: queued (received) → started → completed,
 * or cancelled.
 */
function parseCommandLifecycle(obj: Record<string, unknown>): AgentEvent {
  const state = obj.state
  if (
    typeof obj.command_uuid !== 'string' ||
    (state !== 'queued' && state !== 'started' && state !== 'completed' && state !== 'cancelled')
  ) {
    return { kind: 'unknown', reason: 'shape-mismatch', raw: obj }
  }
  return { kind: 'command-lifecycle', commandUuid: obj.command_uuid, state }
}

function parseRateLimit(obj: Record<string, unknown>): AgentEvent {
  const info = (obj.rate_limit_info ?? {}) as Record<string, unknown>
  return {
    kind: 'rate-limit',
    status: (info.status as string) ?? 'unknown',
    rateLimitType: (info.rateLimitType as string) ?? '',
    resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : null,
    overageStatus: (info.overageStatus as string) ?? null
  }
}

function toNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function toOptionalNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function toStringList(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined
}

/** One API call's `message.usage` (snake_case) → `TokenUsage`; undefined when absent. */
function parseCallUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const u = raw as Record<string, unknown>
  return {
    inputTokens: toNum(u.input_tokens),
    outputTokens: toNum(u.output_tokens),
    cacheReadInputTokens: toNum(u.cache_read_input_tokens),
    cacheCreationInputTokens: toNum(u.cache_creation_input_tokens)
  }
}
