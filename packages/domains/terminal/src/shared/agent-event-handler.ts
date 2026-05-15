/**
 * Hook-driven agent lifecycle events.
 *
 * Distinct from `agent-events.ts` which models the streaming JSON event union
 * (TurnInit/UserMessage/AssistantText/...). Lifecycle events come from out-of-band
 * hooks installed in the agent's own config (e.g. `~/.claude/settings.json`),
 * POST'd over loopback to `/api/agent-hook`, and broadcast on the
 * `agent:lifecycle` IPC channel.
 */

export type AgentId = 'claude-code' | 'codex' | 'gemini' | 'opencode'

/**
 * Runtime allowlist for agents that currently emit hook lifecycle events.
 * Used at PTY/chat spawn time to gate `SLAYZONE_AGENT_HOOK_URL` injection.
 * Add an agent here once both its hook script + installer have shipped.
 */
export const HOOK_SUPPORTED_AGENT_IDS: ReadonlySet<AgentId> = new Set<AgentId>(['claude-code'])

export type AgentLifecycleEventType =
  | 'agent-start'
  | 'agent-stop'
  | 'permission-request'
  | 'session-start'
  | 'session-end'

export interface AgentLifecycleEvent {
  agentId: AgentId
  type: AgentLifecycleEventType
  taskId?: string
  sessionId?: string
  hookEvent: string
  cwd?: string
  timestamp: number
  raw?: unknown
}

const ALIAS_TABLE: Record<string, AgentLifecycleEventType> = {
  // Claude Code hook event names (Claude Code 2.x, 2026-05).
  sessionstart: 'session-start',
  sessionend: 'session-end',
  userpromptsubmit: 'agent-start',
  pretooluse: 'agent-start',
  posttooluse: 'agent-stop',
  posttooluse_failure: 'agent-stop',
  posttoolusefailure: 'agent-stop',
  stop: 'agent-stop',
  subagentstop: 'agent-stop',
  notification: 'permission-request',
  permissionrequest: 'permission-request',
  precompact: 'agent-stop',

  // Codex / generic aliases (forward-looking; mirrors Superset coverage).
  onstart: 'agent-start',
  onstop: 'agent-stop',
  onsessionstart: 'session-start',
  onsessionend: 'session-end',
  beforetool: 'agent-start',
  before_tool: 'agent-start',
  aftertool: 'agent-stop',
  after_tool: 'agent-stop',
  toolstart: 'agent-start',
  toolend: 'agent-stop',
  turnstart: 'agent-start',
  turnend: 'agent-stop',
  agentturnstart: 'agent-start',
  agentturnend: 'agent-stop',
  'agent-turn-start': 'agent-start',
  'agent-turn-complete': 'agent-stop',
  'agent-turn-end': 'agent-stop',
  'session-start': 'session-start',
  'session-end': 'session-end',
  'permission-request': 'permission-request',
  'permission-prompt': 'permission-request',
  approvalrequest: 'permission-request',
  approval_request: 'permission-request',
  // Gemini CLI style.
  prerequest: 'agent-start',
  pre_request: 'agent-start',
  postrequest: 'agent-stop',
  post_request: 'agent-stop',
}

/**
 * Map a raw upstream hook event name to a normalized lifecycle type.
 * Case-insensitive. Returns null for unknown names so the REST handler
 * can return 204 + skip the broadcast (drop, don't default to Stop).
 */
export function mapEventType(hookEvent: string): AgentLifecycleEventType | null {
  if (!hookEvent) return null
  const key = hookEvent.trim().toLowerCase()
  if (key in ALIAS_TABLE) return ALIAS_TABLE[key]
  const stripped = key.replace(/[_\-\s]/g, '')
  if (stripped in ALIAS_TABLE) return ALIAS_TABLE[stripped]
  return null
}
