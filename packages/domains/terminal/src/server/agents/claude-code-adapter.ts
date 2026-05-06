import type {
  AgentEvent,
  ResultEvent,
  ModelUsage,
  TokenUsage,
} from '../../shared/agent-events'
import type { AgentAdapter, AgentSpawnOpts, SpawnArgs } from './types'

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
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      // `stdio` is the SDK's sentinel value for permission_prompt_tool_name —
      // it tells the CLI to route prompt-style tool calls (notably
      // AskUserQuestion, plus any tool the active permission mode hasn't
      // already auto-approved) via control_request on stdout instead of
      // dispatching to an MCP tool. Host (transport) parses the inbound
      // request, surfaces it to the renderer, and writes the user's answer
      // back as a control_response with `behavior:'allow'` + `updatedInput`.
      // Verified mechanism in claude-agent-sdk-python `_internal/client.py`.
      '--permission-prompt-tool', 'stdio',
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
      default:
        return { kind: 'unknown', reason: 'unknown-type', raw: obj }
    }
  },

  serializeUserMessage(text: string, _sessionId: string): string {
    return JSON.stringify({
      type: 'user',
      message: { role: 'user', content: text },
    })
  },

  serializeControlRequest({ requestId, request }): string {
    return JSON.stringify({
      type: 'control_request',
      request_id: requestId,
      request,
    })
  },

  serializeControlResponse({ requestId, response, isError, error }): string {
    if (isError) {
      return JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: requestId,
          error: error ?? 'unknown error',
        },
      })
    }
    return JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: response ?? {},
      },
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
            ...(isError ? { is_error: true } : {}),
          },
        ],
      },
    })
  },

  extractSessionId(event: AgentEvent): string | null {
    if (event.kind === 'turn-init') return event.sessionId
    return null
  },
}

// ------- internal parsers ---------

/**
 * Parse Claude Code's stream_event wrapper which envelopes one Anthropic SSE event.
 * Shape: `{"type":"stream_event","event":{...anthropic...},"parent_tool_use_id":null,"session_id":"..."}`.
 */
function parseStreamEvent(obj: Record<string, unknown>, parent: string | undefined): AgentEvent | null {
  const inner = obj.event as Record<string, unknown> | undefined
  if (!inner || typeof inner !== 'object') return null
  const t = inner.type
  switch (t) {
    case 'message_start': {
      const message = inner.message as { id?: string } | undefined
      return { kind: 'stream-message-start', messageId: message?.id ?? '', parentToolUseId: parent }
    }
    case 'content_block_start': {
      const block = inner.content_block as
        | { type?: string; id?: string; name?: string }
        | undefined
      const index = typeof inner.index === 'number' ? inner.index : 0
      if (!block) return null
      if (block.type === 'text') {
        return { kind: 'stream-block-start', blockIndex: index, blockType: 'text', parentToolUseId: parent }
      }
      if (block.type === 'thinking') {
        return { kind: 'stream-block-start', blockIndex: index, blockType: 'thinking', parentToolUseId: parent }
      }
      if (block.type === 'tool_use') {
        return {
          kind: 'stream-block-start',
          blockIndex: index,
          blockType: 'tool_use',
          toolUseId: block.id,
          toolName: block.name,
          parentToolUseId: parent,
        }
      }
      return null
    }
    case 'content_block_delta': {
      const d = inner.delta as
        | { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string }
        | undefined
      const index = typeof inner.index === 'number' ? inner.index : 0
      if (!d) return null
      if (d.type === 'text_delta') {
        return { kind: 'stream-block-delta', blockIndex: index, deltaType: 'text', text: d.text ?? '', parentToolUseId: parent }
      }
      if (d.type === 'thinking_delta') {
        return { kind: 'stream-block-delta', blockIndex: index, deltaType: 'thinking', text: d.thinking ?? '', parentToolUseId: parent }
      }
      if (d.type === 'signature_delta') {
        return { kind: 'stream-block-delta', blockIndex: index, deltaType: 'signature', text: d.signature ?? '', parentToolUseId: parent }
      }
      if (d.type === 'input_json_delta') {
        return { kind: 'stream-block-delta', blockIndex: index, deltaType: 'input_json', text: d.partial_json ?? '', parentToolUseId: parent }
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
    }
  }
  if (subtype === 'compact_boundary') {
    return { kind: 'compact-boundary' }
  }
  if (subtype === 'task_started' || subtype === 'task_updated' || subtype === 'task_notification') {
    const usageRaw = (obj.usage ?? null) as Record<string, unknown> | null
    const usage =
      usageRaw && (usageRaw.total_tokens != null || usageRaw.tool_uses != null || usageRaw.duration_ms != null)
        ? {
            totalTokens: toNum(usageRaw.total_tokens),
            toolUses: toNum(usageRaw.tool_uses),
            durationMs: toNum(usageRaw.duration_ms),
          }
        : undefined
    return {
      kind: 'sub-agent',
      phase: subtype === 'task_started' ? 'started'
        : subtype === 'task_updated' ? 'updated'
        : 'notification',
      toolUseId: (obj.tool_use_id as string) ?? '',
      parentToolUseId: parent,
      description: typeof obj.description === 'string' ? obj.description : undefined,
      status: typeof obj.status === 'string' ? obj.status : undefined,
      summary: typeof obj.summary === 'string' ? obj.summary : undefined,
      usage,
      raw: obj,
    }
  }
  if (subtype === 'api_retry') {
    return {
      kind: 'api-retry',
      attempt: (obj.attempt as number) ?? 0,
      maxRetries: (obj.max_retries as number) ?? 0,
      delayMs: (obj.retry_delay_ms as number) ?? 0,
      error: (obj.error as string) ?? '',
    }
  }
  // Drop noise that has no surface in the chat UI: per-tool hook events, plus
  // sub-agent progress ticks (the surrounding `task_started` / `task_notification`
  // already carry the user-visible signal). Returning null here avoids buffering
  // and persisting events that would otherwise render as "unsupported event".
  if (subtype === 'hook_started' || subtype === 'hook_response' || subtype === 'task_progress') {
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
  const message = obj.message as { id?: string; content?: RawContentBlock[] } | undefined
  if (!message) return { kind: 'unknown', reason: 'shape-mismatch', raw: obj }
  const messageId = message.id ?? ''
  const blocks = Array.isArray(message.content) ? message.content : []

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
    }
  }
  if (block.type === 'thinking') {
    return {
      kind: 'assistant-thinking',
      messageId,
      text: block.thinking ?? '',
      hasSignature: Boolean(block.signature),
      parentToolUseId: parent,
    }
  }
  if (block.type === 'tool_use') {
    return {
      kind: 'tool-call',
      id: block.id ?? '',
      name: block.name ?? '',
      input: block.input,
      parentToolUseId: parent,
    }
  }
  return { kind: 'unknown', reason: 'unknown-type', raw: obj }
}

function parseUser(obj: Record<string, unknown>, parent: string | undefined): AgentEvent | null {
  const message = obj.message as { content?: RawContentBlock[] } | undefined
  const toolUseResult = obj.tool_use_result
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
    parentToolUseId: parent,
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
    }
  }
  const tokenUsage: TokenUsage = {
    inputTokens: toNum(usage.input_tokens),
    outputTokens: toNum(usage.output_tokens),
    cacheReadInputTokens: toNum(usage.cache_read_input_tokens),
    cacheCreationInputTokens: toNum(usage.cache_creation_input_tokens),
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
    permissionDenials: Array.isArray(obj.permission_denials) ? obj.permission_denials : [],
  }
}

/**
 * Inbound `{type:"control_request", request_id, request:{subtype:'can_use_tool', ...}}`.
 * Surfaces under `--permission-prompt-tool stdio` whenever the CLI needs the
 * host to decide a tool's fate (notably AskUserQuestion, and any tool the
 * active permission mode hasn't already auto-approved).
 *
 * Schema (observed in claude-agent-sdk-python `_internal/query.py`):
 *   - tool_name: which tool wants to run
 *   - input: the args Claude proposed
 *   - tool_use_id: the originating block id (correlates w/ the tool item in our timeline)
 *   - permission_suggestions?: SDK-suggested permission rule additions
 *
 * Other subtypes (`hook_callback`, `mcp_message`) currently emit
 * shape-mismatch — wire them when we host hooks or SDK MCP servers.
 */
function parseControlRequest(obj: Record<string, unknown>): AgentEvent {
  const requestId = typeof obj.request_id === 'string' ? obj.request_id : ''
  const request = (obj.request ?? {}) as Record<string, unknown>
  const subtype = request.subtype
  if (subtype !== 'can_use_tool' || !requestId) {
    return { kind: 'unknown', reason: 'shape-mismatch', raw: obj }
  }
  return {
    kind: 'permission-request',
    requestId,
    toolName: typeof request.tool_name === 'string' ? request.tool_name : '',
    toolUseId: typeof request.tool_use_id === 'string' ? request.tool_use_id : '',
    input: request.input ?? null,
    permissionSuggestions: request.permission_suggestions,
  }
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
  void _s; void _r; void _e
  return {
    kind: 'control-response',
    requestId,
    isError,
    data,
    error,
  }
}

function parseRateLimit(obj: Record<string, unknown>): AgentEvent {
  const info = (obj.rate_limit_info ?? {}) as Record<string, unknown>
  return {
    kind: 'rate-limit',
    status: (info.status as string) ?? 'unknown',
    rateLimitType: (info.rateLimitType as string) ?? '',
    resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : null,
    overageStatus: (info.overageStatus as string) ?? null,
  }
}

function toNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
