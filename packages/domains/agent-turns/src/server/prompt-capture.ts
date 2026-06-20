import { randomUUID } from 'node:crypto'
import type { SlayzoneDb } from '@slayzone/platform'
import { isPromptCaptureMode } from '@slayzone/terminal/shared'
import { insertPrompt, prunePrompts } from './prompt-db'
import { agentPromptsEvents } from './events'

/**
 * Normalize a raw hook event name and test whether it is a user-prompt-submit
 * boundary. Case- and separator-insensitive so `UserPromptSubmit`,
 * `user_prompt_submit`, `user-prompt-submit` all match. Gating capture to this
 * single per-turn event keeps it OFF the per-tool hook hot path.
 */
export function isUserPromptSubmitEvent(hookEvent: string): boolean {
  return hookEvent.trim().toLowerCase().replace(/[_\-\s]/g, '') === 'userpromptsubmit'
}

/**
 * Pull the user's prompt text out of a UserPromptSubmit hook payload. Claude
 * Code + Codex carry it as `prompt`; the other fields are best-effort fallbacks
 * for agents whose payload shape differs. Returns null when no non-empty string
 * is found (→ nothing is stored, keeping non-carrying agents graceful).
 */
export function extractUserPromptText(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  for (const v of [r.prompt, r.user_prompt, r.userPrompt, r.message, r.input, r.text]) {
    if (typeof v === 'string' && v.trim().length > 0) return v
  }
  return null
}

export interface CapturePromptInput {
  agentId: string
  hookEvent: string
  taskId: string
  /** Upstream CLI session id (notify.sh forwards it as `sessionId`). */
  sessionId?: string | null
  raw: unknown
  /** Override created_at (tests). Defaults to now. */
  now?: number
}

/**
 * Capture one user prompt from an agent hook ping. No-op unless: the agent is a
 * capture-capable terminal mode, the event is UserPromptSubmit, and the payload
 * carries non-empty prompt text. Best-effort — never throws into the hook path.
 */
export async function capturePrompt(db: SlayzoneDb, input: CapturePromptInput): Promise<void> {
  if (!input.taskId) return
  if (!isPromptCaptureMode(input.agentId)) return
  if (!isUserPromptSubmitEvent(input.hookEvent)) return
  const text = extractUserPromptText(input.raw)
  if (!text) return

  await insertPrompt(db, {
    id: randomUUID(),
    task_id: input.taskId,
    agent_id: input.agentId,
    cli_session_id: input.sessionId ?? null,
    text,
    created_at: input.now ?? Date.now()
  })
  await prunePrompts(db, input.taskId, input.agentId)
  agentPromptsEvents.emit('agent-prompts:changed', input.taskId)
}
