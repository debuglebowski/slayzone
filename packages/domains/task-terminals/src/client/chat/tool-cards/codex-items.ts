/**
 * Readable views of Codex tool rows. The chat driver names them
 * `codex/commandExecution`, `codex/webSearch`, `mcp/<server>/<tool>`, … with
 * the STARTED Codex item as input and the COMPLETED item as the result's
 * `structured` (older saved rows carry only `{command, cwd}` / the arguments as
 * input). File changes: `@slayzone/terminal/client` `codexFileChanges`.
 *
 * @module chat/tool-cards/codex-items
 */
import type { ToolInvocation } from '@slayzone/terminal/client'

export const CODEX_COMMAND_TOOL = 'codex/commandExecution'
export const CODEX_WEB_SEARCH_TOOL = 'codex/webSearch'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** The completed item, else the started one (input), else {}. */
function itemOf(invocation: ToolInvocation): Record<string, unknown> {
  const structured = invocation.result?.structured
  const input = isRecord(invocation.input) ? invocation.input : {}
  return isRecord(structured) ? { ...input, ...structured } : input
}

/** `bash -lc 'cmd'` / `/bin/zsh -lc "cmd"` → `cmd`; anything else as is. */
export function unwrapShellCommand(command: string | string[]): string {
  if (Array.isArray(command)) {
    if (
      command.length === 3 &&
      /^(?:\S*\/)?(?:ba|z|da)?sh$/.test(command[0]) &&
      /^-l?c$/.test(command[1])
    ) {
      return command[2]
    }
    return command.join(' ')
  }
  const m = /^(?:\S*\/)?(?:ba|z|da)?sh\s+-(?:lc|cl|c)\s+([\s\S]+)$/.exec(command.trim())
  if (!m) return command
  const arg = m[1]
  if (arg.length >= 2 && arg.startsWith("'") && arg.endsWith("'")) {
    return arg.slice(1, -1).replace(/'\\''/g, "'")
  }
  if (arg.length >= 2 && arg.startsWith('"') && arg.endsWith('"')) {
    return arg.slice(1, -1).replace(/\\(["\\$`])/g, '$1')
  }
  return arg
}

export type CodexCommandStatus = 'running' | 'completed' | 'failed' | 'declined'

export interface CodexCommandView {
  /** The command as the agent wrote it (no shell wrapper). */
  command: string
  cwd?: string
  status: CodexCommandStatus
  exitCode: number | null
  durationMs: number | null
  /** Everything it printed (empty while it runs: that is the live output). */
  output: string
}

export function codexCommandView(invocation: ToolInvocation): CodexCommandView {
  const item = itemOf(invocation)
  const raw = item.command
  const command =
    typeof raw === 'string' || Array.isArray(raw)
      ? unwrapShellCommand(raw as string | string[])
      : ''
  const rawStatus = str(item.status)
  const status: CodexCommandStatus =
    rawStatus === 'declined'
      ? 'declined'
      : rawStatus === 'failed'
        ? 'failed'
        : rawStatus === 'completed'
          ? 'completed'
          : invocation.result
            ? invocation.result.isError
              ? 'failed'
              : 'completed'
            : 'running'
  const resultText = str(invocation.result?.rawContent)
  const output = resultText || str(item.aggregatedOutput) || ''
  const cwd = str(item.cwd)
  return {
    command,
    ...(cwd ? { cwd } : {}),
    status,
    exitCode: num(item.exitCode),
    durationMs: num(item.durationMs),
    output
  }
}

/** `2.9s`, `1m 4s` — a Codex `durationMs`. */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const sec = Math.round(ms / 1000)
  return `${Math.floor(sec / 60)}m ${sec % 60}s`
}

/**
 * A Codex MCP call (`mcpToolCall` item) in the shape the MCP card reads:
 * input = the tool's arguments, result content = what the tool returned (or its
 * error). Other rows unchanged.
 */
export function codexMcpInvocation(invocation: ToolInvocation): ToolInvocation {
  const input = invocation.input
  const structured = invocation.result?.structured
  const isItem = (v: unknown): v is Record<string, unknown> =>
    isRecord(v) && v.type === 'mcpToolCall'
  if (!isItem(input) && !isItem(structured)) return invocation
  const args = isItem(input) ? (input.arguments ?? null) : input
  if (!invocation.result || !isItem(structured)) return { ...invocation, input: args }
  const result = isRecord(structured.result) ? structured.result : null
  const error = isRecord(structured.error) ? str(structured.error.message) : str(structured.error)
  const content = result
    ? (result.content ?? result.structuredContent ?? null)
    : (error ?? invocation.result.rawContent)
  return {
    ...invocation,
    input: args,
    result: {
      ...invocation.result,
      isError: invocation.result.isError || error !== undefined,
      rawContent: content,
      structured: result?.structuredContent ?? null
    }
  }
}
