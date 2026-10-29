import type { HookEffect, HookOutputEvent } from '@slayzone/terminal-contracts'

/** Hook events whose block (exit 2 / `decision:"block"`) reason the CLI feeds to the model. */
const BLOCK_REACHES_AGENT = new Set([
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStop',
  'PermissionRequest'
])

/** Hook events whose plain stdout (exit 0) the CLI adds to the model's context. */
const STDOUT_IS_CONTEXT = new Set(['SessionStart', 'UserPromptSubmit'])

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function jsonObject(text: string): Record<string, unknown> | null {
  const t = text.trim()
  if (!t.startsWith('{')) return null
  try {
    const v = JSON.parse(t) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Map a Claude Code `system/hook_response` frame to a chat event, or null for a
 * hook that changed nothing and told the model nothing (most runs — e.g.
 * SlayZone's own `notify.sh`, which prints `{}`). Null frames are never
 * persisted, so quiet hooks cost no history.
 *
 * Wire facts (CLI 2.1.312, `--include-hook-events`): an exit-2 block arrives
 * as `outcome:"error"` + `exit_code:2`, any other failure as `"error"` (or
 * `"non_blocking_error"`), a timeout as `"cancelled"`. A hook's `systemMessage`
 * arrives separately as `system/informational`, so it is not repeated here.
 */
export function classifyClaudeHookResponse(obj: Record<string, unknown>): HookOutputEvent | null {
  const hookEvent = str(obj.hook_event)
  const outcome = str(obj.outcome)
  const exitCode = typeof obj.exit_code === 'number' ? obj.exit_code : undefined
  const stdout = str(obj.stdout).trim()
  const stderr = str(obj.stderr).trim()
  const output = str(obj.output).trim()
  const blockAudience = BLOCK_REACHES_AGENT.has(hookEvent) ? 'agent' : 'user'
  const emit = (
    effect: HookEffect,
    audience: HookOutputEvent['audience'],
    text: string
  ): HookOutputEvent => ({
    kind: 'hook-output',
    hookId: str(obj.hook_id),
    hookName: str(obj.hook_name) || hookEvent,
    hookEvent,
    effect,
    audience,
    text,
    ...(exitCode === undefined ? {} : { exitCode })
  })

  if (outcome === 'blocking' || exitCode === 2)
    return emit('blocked', blockAudience, stderr || output)
  if (outcome === 'cancelled') return emit('cancelled', 'user', stderr || output)
  if (outcome === 'error' || outcome === 'non_blocking_error') {
    return emit('failed', 'user', stderr || output)
  }
  if (outcome !== 'success') return null

  const json = jsonObject(stdout)
  if (json) {
    const specific = (json.hookSpecificOutput ?? {}) as Record<string, unknown>
    if (json.continue === false) return emit('stopped', 'user', str(json.stopReason))
    if (json.decision === 'block') return emit('blocked', blockAudience, str(json.reason))
    if (specific.permissionDecision === 'deny') {
      return emit('blocked', 'agent', str(specific.permissionDecisionReason))
    }
    const context = str(specific.additionalContext).trim()
    return context ? emit('context', 'agent', context) : null
  }
  if (STDOUT_IS_CONTEXT.has(hookEvent) && stdout) return emit('context', 'agent', stdout)
  return null
}
