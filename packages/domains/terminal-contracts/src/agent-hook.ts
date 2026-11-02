const AGENT_IDS = ['claude-code', 'codex', 'gemini', 'antigravity', 'opencode'] as const
export type HookAgentId = (typeof AGENT_IDS)[number]
export interface ResolvedAgentHook {
  agentId: HookAgentId
  mode: string
  hookEvent: string
  taskId?: string
  sessionId?: string
  spawnToken?: string
  source?: string
  cwd?: string
  raw?: unknown
  releaseChannel?: string
}
const record = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
/** Shared parser for legacy flat hooks, context envelopes and argv-based agents. */
export function resolveAgentHook(input: unknown): ResolvedAgentHook | null {
  const body = record(input)
  if (!body) return null
  const ctx = record(body.ctx),
    agent = body.agentId ?? ctx?.agentId
  if (!AGENT_IDS.includes(agent as HookAgentId)) return null
  let raw = record(body.raw)
  const arg = str(body.arg),
    argJson = arg?.trimStart().startsWith('{')
  if (!raw && argJson) {
    try {
      raw = record(JSON.parse(arg!))
    } catch {
      // An invalid JSON argument is not a usable raw hook envelope.
    }
  }
  const hookEvent =
    str(body.hookEvent) ??
    (!argJson && arg ? arg : undefined) ??
    str(raw?.hook_event_name) ??
    str(raw?.type)
  if (!hookEvent) return null
  return {
    agentId: agent as HookAgentId,
    mode: str(ctx?.mode) || String(agent),
    hookEvent,
    taskId: str(body.taskId) ?? str(ctx?.taskId),
    sessionId: str(body.sessionId) ?? str(raw?.session_id) ?? str(raw?.conversationId),
    spawnToken: str(ctx?.spawnToken),
    source: str(raw?.source),
    cwd: str(body.cwd) ?? str(raw?.cwd),
    raw: raw ?? body.raw,
    releaseChannel: str(ctx?.releaseChannel)
  }
}
/** Preserve lifecycle facts. Prompt text, tool arguments and tool output stay local. */
export function sanitizeAgentHook(hook: ResolvedAgentHook) {
  const r = record(hook.raw) ?? {},
    raw: Record<string, unknown> = {}
  for (const key of ['tool_name', 'agent_id', 'agent_type', 'source'])
    if (typeof r[key] === 'string') raw[key] = r[key]
  if (typeof r.stop_hook_active === 'boolean') raw.stop_hook_active = r.stop_hook_active
  if (['Bash', 'Monitor', 'TaskStop', 'KillShell'].includes(String(r.tool_name))) {
    const input = record(r.tool_input),
      response = record(r.tool_response),
      safeInput: Record<string, unknown> = {},
      safeResponse: Record<string, unknown> = {}
    for (const key of ['task_id', 'shell_id'])
      if (typeof input?.[key] === 'string') safeInput[key] = input[key]
    // Monitor stdout is a pipe; its command is needed transiently for liveness probes.
    // The hub must never log or persist this lifecycle payload.
    if (r.tool_name === 'Monitor' && typeof input?.command === 'string')
      safeInput.command = input.command
    for (const key of ['task_id', 'taskId', 'backgroundTaskId'])
      if (typeof response?.[key] === 'string') safeResponse[key] = response[key]
    if (Object.keys(safeInput).length) raw.tool_input = safeInput
    if (Object.keys(safeResponse).length) raw.tool_response = safeResponse
  }
  return {
    agentId: hook.agentId,
    hookEvent: hook.hookEvent,
    taskId: hook.taskId,
    sessionId: hook.sessionId,
    cwd: hook.cwd,
    ctx: { mode: hook.mode, spawnToken: hook.spawnToken, releaseChannel: hook.releaseChannel },
    raw
  }
}
export function agentHookPrompt(hook: ResolvedAgentHook): string | null {
  if (
    hook.hookEvent
      .trim()
      .toLowerCase()
      .replace(/[_\-\s]/g, '') !== 'userpromptsubmit'
  )
    return null
  const raw = record(hook.raw)
  if (!raw) return null
  for (const key of ['prompt', 'user_prompt', 'userPrompt', 'message', 'input', 'text']) {
    const v = raw[key]
    if (typeof v === 'string' && v.trim()) return v
  }
  return null
}
