/**
 * Scenario types + event builders for the fake `claude` CLI (fake-claude.mjs).
 * A scenario is plain JSON: the fake reads it from the state dir at spawn time.
 * README.md walks through writing one.
 *
 * @module test-utils/fake-claude/scenario
 */
import { randomUUID } from 'node:crypto'

/** A stream-json event as the CLI writes it to stdout. Strings may use `{{var}}`. */
export type StreamEvent = Record<string, unknown>

/**
 * Template variables, substituted into every string of an emitted event:
 * `{{sessionId}}` (the `--session-id` / `--resume` value — the app requires the
 * init event to echo it), `{{cwd}}`, `{{model}}` and `{{permissionMode}}` (from
 * argv, updated by acked `set_model` / `set_permission_mode`), `{{effort}}`,
 * `{{userText}}` (the message that started this turn), `{{turn}}`, `{{spawn}}`.
 */
export type TemplateVar =
  | 'sessionId'
  | 'cwd'
  | 'model'
  | 'permissionMode'
  | 'effort'
  | 'userText'
  | 'turn'
  | 'spawn'

export type Step =
  /** Write events, one JSON line each (`gapMs` between them). */
  | { emit: StreamEvent | StreamEvent[]; gapMs?: number }
  /** Write ONE event as two stdout chunks split inside its first multi-byte char. */
  | { emitSplit: StreamEvent; gapMs?: number }
  /** Write a raw line verbatim (malformed-output tests). */
  | { emitRaw: string }
  | { stderr: string }
  | { sleep: number }
  /** Block until the turn is interrupted or the process is killed. */
  | { hang: true }
  /**
   * Ask the app for a decision: emits `control_request{subtype:'can_use_tool'}`
   * and blocks until the matching `control_response` arrives, then runs the
   * branch for its `behavior` (an error reply runs `deny`).
   */
  | {
      request: {
        tool_name: string
        input: Record<string, unknown>
        tool_use_id: string
        permission_suggestions?: unknown[]
      }
      then?: { allow?: Step[]; deny?: Step[] }
    }
  /** Exit now with `exit` as the code, or kill itself with `signal`. */
  | { exit: number | null; signal?: NodeJS.Signals }
  /** Re-emit one turn of a recorded transcript (see transcript.ts). */
  | { replay: { transcript: string; process?: number; turn?: number; speed?: number } }

export type ControlReply = 'success' | 'error' | 'ignore'

/** What ONE spawn of the fake does. */
export interface ProcessScript {
  /** Before reading stdin (a resume that fails at startup). */
  onStart?: Step[]
  /** `turns[i]` runs when the i-th user message arrives. */
  turns?: Step[][]
  /** Runs for any turn past `turns`. Unset → an error result names the turn. */
  defaultTurn?: Step[]
  /** On `interrupt` mid-turn. Unset → the real CLI's reaction (recorded). */
  onInterrupt?: Step[]
  /** Unset → exit 143 at once. Set → keep running these steps, then exit 143. */
  onSigterm?: Step[]
  /** How to answer the app's control requests. Default: `success` for all. */
  controlResponses?: Partial<
    Record<'interrupt' | 'set_model' | 'set_permission_mode', ControlReply>
  >
  /** Exit code once stdin closes. Default 0. */
  exitCodeOnStdinEnd?: number
}

export interface Scenario {
  /** `processes[i]` scripts the i-th spawn in this scenario. */
  processes: ProcessScript[]
  /** Reuse the last script for spawns past the end (else: exit 3, logged). */
  repeatLast?: boolean
}

// --- event builders -----------------------------------------------------------

let messageSeq = 0
const nextMessageId = (): string => `msg_fake_${++messageSeq}`

/** A generic tool list — the real one depends on the user's config. */
export const DEFAULT_INIT_TOOLS = [
  'Task',
  'AskUserQuestion',
  'Bash',
  'Edit',
  'ExitPlanMode',
  'Glob',
  'Grep',
  'NotebookEdit',
  'Read',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Write'
]

const ZERO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0
}

function assistant(
  content: StreamEvent,
  messageId?: string,
  parentToolUseId?: string
): StreamEvent {
  return {
    type: 'assistant',
    message: {
      id: messageId ?? nextMessageId(),
      type: 'message',
      role: 'assistant',
      model: '{{model}}',
      content: [content],
      stop_reason: null,
      usage: ZERO_USAGE
    },
    parent_tool_use_id: parentToolUseId ?? null,
    session_id: '{{sessionId}}',
    uuid: randomUUID()
  }
}

export const ev = {
  /** `system/init` — the real CLI sends one at the start of EVERY turn. */
  init(opts: { tools?: string[]; model?: string } = {}): StreamEvent {
    return {
      type: 'system',
      subtype: 'init',
      cwd: '{{cwd}}',
      session_id: '{{sessionId}}',
      tools: opts.tools ?? DEFAULT_INIT_TOOLS,
      mcp_servers: [],
      model: opts.model ?? '{{model}}',
      permissionMode: '{{permissionMode}}',
      slash_commands: [],
      apiKeySource: 'none',
      claude_code_version: '2.1.312',
      output_style: 'default',
      agents: [],
      skills: [],
      plugins: [],
      uuid: randomUUID()
    }
  },
  text(text: string, opts: { messageId?: string; parentToolUseId?: string } = {}): StreamEvent {
    return assistant({ type: 'text', text }, opts.messageId, opts.parentToolUseId)
  },
  thinking(text = '', opts: { messageId?: string } = {}): StreamEvent {
    return assistant(
      { type: 'thinking', thinking: text, signature: 'fake-signature' },
      opts.messageId
    )
  },
  toolUse(opts: {
    id: string
    name: string
    input: Record<string, unknown>
    messageId?: string
  }): StreamEvent {
    return assistant(
      { type: 'tool_use', id: opts.id, name: opts.name, input: opts.input },
      opts.messageId
    )
  },
  toolResult(opts: {
    toolUseId: string
    content: string
    isError?: boolean
    /** `tool_use_result`: the CLI's per-tool structured result (diffs etc.). */
    structured?: unknown
  }): StreamEvent {
    return {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: opts.toolUseId,
            content: opts.content,
            ...(opts.isError ? { is_error: true } : {})
          }
        ]
      },
      ...(opts.structured !== undefined ? { tool_use_result: opts.structured } : {}),
      parent_tool_use_id: null,
      session_id: '{{sessionId}}',
      uuid: randomUUID()
    }
  },
  result(
    opts: {
      text?: string
      isError?: boolean
      subtype?: string
      numTurns?: number
      stopReason?: string | null
      terminalReason?: string | null
      costUsd?: number
    } = {}
  ): StreamEvent {
    return {
      type: 'result',
      subtype: opts.subtype ?? (opts.isError ? 'error_during_execution' : 'success'),
      is_error: opts.isError ?? false,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: opts.numTurns ?? 1,
      result: opts.text ?? '',
      stop_reason: opts.stopReason ?? 'end_turn',
      terminal_reason: opts.terminalReason ?? null,
      session_id: '{{sessionId}}',
      total_cost_usd: opts.costUsd ?? 0,
      usage: ZERO_USAGE,
      modelUsage: {},
      permission_denials: [],
      uuid: randomUUID()
    }
  }
}

// --- step builders ------------------------------------------------------------

export const step = {
  emit: (...events: StreamEvent[]): Step => ({ emit: events }),
  emitSplit: (event: StreamEvent, gapMs?: number): Step =>
    gapMs === undefined ? { emitSplit: event } : { emitSplit: event, gapMs },
  stderr: (text: string): Step => ({ stderr: text }),
  sleep: (ms: number): Step => ({ sleep: ms }),
  hang: (): Step => ({ hang: true }),
  exit: (code: number | null, signal?: NodeJS.Signals): Step =>
    signal ? { exit: code, signal } : { exit: code },
  replay: (
    transcript: string,
    opts: { process?: number; turn?: number; speed?: number } = {}
  ): Step => ({
    replay: { transcript, ...opts }
  })
}

/** One complete turn that answers with `text`: init → text → result. */
export function reply(text: string): Step[] {
  return [step.emit(ev.init(), ev.text(text), ev.result({ text }))]
}

/** A turn that echoes the user's message back — handy as `defaultTurn`. */
export function echoTurn(prefix = 'echo: '): Step[] {
  return reply(`${prefix}{{userText}}`)
}
