/**
 * Liveness policy for a running chat turn.
 *
 * "Stuck" used to mean "silent for 5 minutes" — but a running tool is silent
 * until it finishes (Claude sends no output while a Bash command runs), so a
 * healthy 8-minute build was killed (#4). While a tool call is open the turn is
 * bounded by THAT tool's own timeout instead; with none open, by the silence
 * window. The TUI never kills an active turn; this only reaps a dead one.
 *
 * @module terminal/server/runtime/chat-watchdog
 */

/** Claude Code's Bash default and maximum `timeout` (ms). */
const BASH_DEFAULT_MS = 120_000
const BASH_MAX_MS = 600_000
/** Claude Code's MCP tool default, unless `MCP_TOOL_TIMEOUT` says otherwise. */
const MCP_DEFAULT_MS = 30 * 60_000
/** Any other tool (WebFetch, a sub-agent Task, …). */
const OTHER_TOOL_MS = 10 * 60_000
/** Slack past a tool's own timeout before calling the turn stuck. */
export const TOOL_GRACE_MS = 60_000

export interface OpenToolBound {
  startedAt: number
  /** 0 = the tool returns at once (e.g. a backgrounded Bash): no extension. */
  boundMs: number
}

/** How long a call of `name` may legitimately run without output. */
export function toolBoundMs(
  name: string,
  input: unknown,
  env: Record<string, string | undefined>
): number {
  const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  if (name === 'Bash') {
    if (args.run_in_background === true) return 0
    const requested = typeof args.timeout === 'number' && args.timeout > 0 ? args.timeout : null
    return Math.min(requested ?? BASH_DEFAULT_MS, BASH_MAX_MS)
  }
  if (name.startsWith('mcp__')) {
    const fromEnv = Number(env.MCP_TOOL_TIMEOUT)
    return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : MCP_DEFAULT_MS
  }
  return OTHER_TOOL_MS
}

/** When a running turn with this progress and these open tools counts as stuck. */
export function runningDeadline(opts: {
  lastProgressAt: number
  stallMs: number
  openTools: Iterable<OpenToolBound>
}): number {
  let deadline = opts.lastProgressAt + opts.stallMs
  for (const tool of opts.openTools) {
    if (tool.boundMs <= 0) continue
    deadline = Math.max(deadline, tool.startedAt + tool.boundMs + TOOL_GRACE_MS)
  }
  return deadline
}
