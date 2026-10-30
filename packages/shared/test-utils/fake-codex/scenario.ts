/**
 * Scenario types for the fake `codex app-server` (fake-codex.mjs) and builders
 * for the notifications it plays. Shapes are codex-cli 0.159.2's, as recorded
 * (transcripts/*.jsonl). README.md is the guide.
 *
 * Every string goes through the fake's template substitution: `{{threadId}}`,
 * `{{turnId}}`, `{{cwd}}`, `{{model}}`, `{{userText}}`, `{{turn}}`, `{{spawn}}`.
 *
 * @module test-utils/fake-codex/scenario
 */

/** A server→client notification. */
export interface CodexNotification {
  method: string
  params?: unknown
}

/** How the fake answers one handshake request. Unset = the recorded success. */
export interface CodexReplySpec {
  /** Answer later. */
  delayMs?: number
  /** Never answer. */
  hang?: boolean
  /** Answer with this JSON-RPC error. */
  error?: { code: number; message: string; data?: unknown }
  /** Answer with this result instead of the default one. */
  result?: unknown
}

/** Branches of an approval, by the decision the app sent (`{key}` variants by key). */
export interface CodexRequestBranches {
  accept?: CodexStep[]
  acceptForSession?: CodexStep[]
  decline?: CodexStep[]
  cancel?: CodexStep[]
  /** A legacy request's ReviewDecision (`approved`, `denied`, …) or any other key. */
  [decision: string]: CodexStep[] | undefined
}

export type CodexStep =
  | { emit: CodexNotification | CodexNotification[]; gapMs?: number }
  | { emitRaw: string }
  | { stderr: string }
  | { sleep: number }
  | { hang: true }
  | { exit: number; signal?: undefined }
  | { exit: null; signal: NodeJS.Signals }
  /** Send a server→client request and block until the app replies; then run the matching branch (`error` for an error reply, else `default`). */
  | { request: { method: string; params?: unknown }; branches?: CodexRequestBranches }
  /** End the turn yourself (`turn/completed` with this status). */
  | {
      endTurn: {
        status: 'completed' | 'interrupted' | 'failed'
        error?: { message: string } | null
      }
    }
  /** Play one recorded turn (see README). The recording carries its own turn/started + turn/completed. */
  | { replay: { transcript: string; process?: number; turn?: number; speed?: number } }

export interface CodexProcessScript {
  /** Before any request is read (startup failures). */
  onStart?: CodexStep[]
  handshake?: {
    initialize?: CodexReplySpec
    threadStart?: CodexReplySpec
    threadResume?: CodexReplySpec
  }
  /** turns[i] runs for the i-th `turn/start`. */
  turns?: CodexStep[][]
  /** Every turn past `turns`. Unset → an error + failed turn naming it. */
  defaultTurn?: CodexStep[]
  /** `turn/start`: hold back its reply AND `turn/started` (`replyDelayMs`), or refuse it. */
  turnStart?: { replyDelayMs?: number; error?: { code: number; message: string } }
  /**
   * `turn/interrupt`: default acks `{}` and aborts the turn (then idle +
   * `turn/completed {interrupted}` + `serverRequest/resolved` for open requests).
   */
  interrupt?: 'ignore' | 'error'
  /** Replaces the default interrupt output. */
  onInterrupt?: CodexStep[]
  /** Run on SIGTERM before exiting (default: exit at once, like 0.159.2). */
  onSigterm?: CodexStep[]
  sigtermExitCode?: number
  /** `stay`: keep running after stdin closes (default: exit at once). */
  onStdinEnd?: 'stay'
  exitCodeOnStdinEnd?: number
  /** Don't wrap scripted turns in turn/started … turn/completed. */
  autoTurnEvents?: false
  /** Results for other client methods (`model/list`, …); unset ones get -32601. */
  methods?: Record<string, CodexReplySpec>
}

export interface CodexScenario {
  /** processes[i] scripts the i-th spawn after `setScenario()`. */
  processes: CodexProcessScript[]
  /** Reuse the last script for every later spawn. */
  repeatLast?: boolean
  /** Thread ids `thread/resume` accepts (besides threads this fake started). */
  threads?: string[]
}

// --- builders ---------------------------------------------------------------------

let seq = 0
const nextId = (prefix: string): string => `${prefix}_fake_${(++seq).toString(36)}`

const T = { threadId: '{{threadId}}', turnId: '{{turnId}}' } as const

const item = (method: 'item/started' | 'item/completed', it: Record<string, unknown>) => ({
  method,
  params: { item: it, ...T }
})

export interface CommandSpec {
  id?: string
  command: string
  cwd?: string
  output?: string
  exitCode?: number
  status?: 'completed' | 'failed' | 'declined'
}

export interface FileChangeSpec {
  id?: string
  changes: Array<{ path: string; kind: 'add' | 'delete' | 'update'; diff: string }>
  status?: 'completed' | 'failed' | 'declined'
}

const commandItem = (c: CommandSpec & { id: string }, status: string, done: boolean) => ({
  type: 'commandExecution',
  id: c.id,
  pluginId: null,
  scriptPath: null,
  command: `/bin/zsh -lc '${c.command}'`,
  cwd: c.cwd ?? '{{cwd}}',
  processId: done ? '4242' : null,
  source: 'agent',
  status,
  commandActions: [{ type: 'unknown', command: c.command }],
  aggregatedOutput: done ? (c.output ?? '') : null,
  exitCode: done ? (c.exitCode ?? (status === 'completed' ? 0 : null)) : null,
  durationMs: done ? 12 : null
})

const fileItem = (f: FileChangeSpec & { id: string }, status: string) => ({
  type: 'fileChange',
  id: f.id,
  changes: f.changes.map((c) => ({
    path: c.path.startsWith('/') || c.path.startsWith('{{') ? c.path : `{{cwd}}/${c.path}`,
    kind: c.kind === 'update' ? { type: 'update', move_path: null } : { type: c.kind },
    diff: c.diff
  })),
  status
})

const agentItem = (id: string, text: string) => ({
  type: 'agentMessage',
  id,
  text,
  phase: 'final_answer',
  memoryCitation: null,
  delivery: null,
  questions: null
})

/** Notifications, in codex-cli 0.159.2's shapes. */
export const cx = {
  notification: (method: string, params: unknown): CodexNotification => ({ method, params }),
  agentStarted: (id: string): CodexNotification => item('item/started', agentItem(id, '')),
  agentDelta: (itemId: string, delta: string): CodexNotification => ({
    method: 'item/agentMessage/delta',
    params: { ...T, itemId, delta }
  }),
  agentCompleted: (id: string, text: string): CodexNotification =>
    item('item/completed', agentItem(id, text)),
  reasoningStarted: (id: string): CodexNotification =>
    item('item/started', { type: 'reasoning', id, summary: [], content: [] }),
  reasoningDelta: (itemId: string, delta: string): CodexNotification => ({
    method: 'item/reasoning/summaryTextDelta',
    params: { ...T, itemId, delta, summaryIndex: 0 }
  }),
  reasoningCompleted: (id: string, summary: string[]): CodexNotification =>
    item('item/completed', { type: 'reasoning', id, summary, content: [] }),
  commandStarted: (c: CommandSpec & { id: string }): CodexNotification =>
    item('item/started', commandItem(c, 'inProgress', false)),
  commandOutput: (itemId: string, delta: string): CodexNotification => ({
    method: 'item/commandExecution/outputDelta',
    params: { ...T, itemId, delta }
  }),
  commandCompleted: (c: CommandSpec & { id: string }): CodexNotification =>
    item('item/completed', commandItem(c, c.status ?? 'completed', true)),
  fileChangeStarted: (f: FileChangeSpec & { id: string }): CodexNotification =>
    item('item/started', fileItem(f, 'inProgress')),
  fileChangeCompleted: (f: FileChangeSpec & { id: string }): CodexNotification =>
    item('item/completed', fileItem(f, f.status ?? 'completed')),
  turnDiff: (diff: string): CodexNotification => ({
    method: 'turn/diff/updated',
    params: { ...T, diff }
  }),
  mcpStarted: (id: string, server: string, tool: string, args: unknown): CodexNotification =>
    item('item/started', {
      type: 'mcpToolCall',
      id,
      server,
      tool,
      status: 'inProgress',
      arguments: args,
      result: null,
      error: null,
      durationMs: null
    }),
  mcpCompleted: (
    id: string,
    server: string,
    tool: string,
    args: unknown,
    text: string
  ): CodexNotification =>
    item('item/completed', {
      type: 'mcpToolCall',
      id,
      server,
      tool,
      status: 'completed',
      arguments: args,
      result: { content: [{ type: 'text', text }], structuredContent: null, _meta: null },
      error: null,
      durationMs: 1
    }),
  /** 0.159.2 starts a web search with an EMPTY query; the completed item has it. */
  webSearchStarted: (id: string): CodexNotification =>
    item('item/started', { type: 'webSearch', id, query: '', action: null, results: null }),
  webSearchCompleted: (id: string, query: string): CodexNotification =>
    item('item/completed', {
      type: 'webSearch',
      id,
      query,
      action: { type: 'search', query, queries: null },
      results: []
    }),
  plan: (
    steps: Array<{ step: string; status: 'pending' | 'inProgress' | 'completed' }>,
    explanation: string | null = null
  ): CodexNotification => ({
    method: 'turn/plan/updated',
    params: { ...T, explanation, plan: steps }
  }),
  tokenUsage: (input: number, output: number, contextWindow = 258_400): CodexNotification => {
    const b = {
      totalTokens: input + output,
      inputTokens: input,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: output,
      reasoningOutputTokens: 0
    }
    return {
      method: 'thread/tokenUsage/updated',
      params: { ...T, tokenUsage: { total: b, last: b, modelContextWindow: contextWindow } }
    }
  },
  /** `error` notification. 0.159.2 puts the raw API error JSON in `message`. */
  error: (message: string, willRetry = false): CodexNotification => ({
    method: 'error',
    params: {
      error: { message, codexErrorInfo: 'other', additionalDetails: null },
      willRetry,
      ...T
    }
  }),
  serverRequestResolved: (requestId: number): CodexNotification => ({
    method: 'serverRequest/resolved',
    params: { threadId: '{{threadId}}', requestId }
  })
}

/** Steps. */
export const cstep = {
  emit: (...events: CodexNotification[]): CodexStep => ({ emit: events }),
  emitGap: (gapMs: number, ...events: CodexNotification[]): CodexStep => ({ emit: events, gapMs }),
  raw: (line: string): CodexStep => ({ emitRaw: line }),
  stderr: (text: string): CodexStep => ({ stderr: text }),
  sleep: (ms: number): CodexStep => ({ sleep: ms }),
  hang: (): CodexStep => ({ hang: true }),
  exit: (code: number): CodexStep => ({ exit: code }),
  endTurn: (status: 'completed' | 'interrupted' | 'failed', message?: string): CodexStep => ({
    endTurn: { status, error: message ? { message } : null }
  }),
  replay: (
    transcript: string,
    opts: { process?: number; turn?: number; speed?: number } = {}
  ): CodexStep => ({
    replay: { transcript, ...opts }
  }),
  request: (method: string, params: unknown, branches?: CodexRequestBranches): CodexStep => ({
    request: { method, params },
    branches
  }),
  /** `item/commandExecution/requestApproval` for an already started command item. */
  approveCommand: (
    c: CommandSpec & { id: string },
    branches?: CodexRequestBranches
  ): CodexStep => ({
    request: {
      method: 'item/commandExecution/requestApproval',
      params: {
        kind: 'command',
        ...T,
        itemId: c.id,
        environmentId: 'local',
        command: `/bin/zsh -lc '${c.command}'`,
        cwd: c.cwd ?? '{{cwd}}',
        commandActions: [{ type: 'unknown', command: c.command }],
        availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel']
      }
    },
    branches
  }),
  /** `item/fileChange/requestApproval` for an already started fileChange item. */
  approveFileChange: (itemId: string, branches?: CodexRequestBranches): CodexStep => ({
    request: {
      method: 'item/fileChange/requestApproval',
      params: { ...T, itemId, reason: null, grantRoot: null }
    },
    branches
  })
}

/** Stream one agent message: started, one delta per chunk, completed. */
export function streamReply(
  chunks: string[],
  opts: { id?: string; gapMs?: number } = {}
): CodexStep[] {
  const id = opts.id ?? nextId('msg')
  return [
    cstep.emit(cx.agentStarted(id)),
    ...chunks.map((c) =>
      opts.gapMs
        ? cstep.emitGap(opts.gapMs, cx.agentDelta(id, c))
        : cstep.emit(cx.agentDelta(id, c))
    ),
    cstep.emit(cx.agentCompleted(id, chunks.join('')), cx.tokenUsage(1200, chunks.length))
  ]
}

/** A turn that replies `text` (streamed in word-sized chunks). */
export function codexReply(text: string, opts: { id?: string; gapMs?: number } = {}): CodexStep[] {
  return streamReply(text.match(/\S+\s*|\s+/g) ?? [text], opts)
}

/** Replies `echo: <user text>`. */
export function codexEchoTurn(): CodexStep[] {
  return codexReply('echo: {{userText}}')
}

/** A command that runs (live output chunks), then the reply. */
export function commandTurn(
  c: CommandSpec & { id?: string; chunks?: string[]; gapMs?: number },
  then = 'Done.'
): CodexStep[] {
  const cmd = { ...c, id: c.id ?? nextId('exec'), output: c.output ?? (c.chunks ?? []).join('') }
  return [
    cstep.emit(cx.commandStarted(cmd)),
    ...(c.chunks ?? []).map((chunk) =>
      cstep.emitGap(c.gapMs ?? 0, cx.commandOutput(cmd.id, chunk))
    ),
    cstep.emit(cx.commandCompleted(cmd)),
    ...codexReply(then)
  ]
}
