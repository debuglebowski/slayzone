/**
 * Prompt model: the agent's open questions to the user — permission requests,
 * AskUserQuestion, plan approval — derived from the chat event log alone, so a
 * reload (a replay of the same events) rebuilds exactly the same state.
 *
 *   permission-request   → pending
 *   permission-resolved  → resolved (the host answered; decision kept)
 *   permission-cancelled → cancelled (the CLI withdrew it)
 *   process-exit / session-spawn / interrupted → every pending one expired
 *     (its process can no longer take an answer)
 *   tool-result for the request's tool → resolved (logs written before
 *     `permission-resolved` existed)
 *
 * Keyed by request id, never by tool id: Codex approvals can carry an empty one.
 *
 * @module client/chat-prompts
 */
import type {
  AgentEvent,
  PermissionDecision,
  PermissionRequestEvent
} from '@slayzone/terminal-contracts'

export type ChatPromptStatus = 'pending' | 'resolved' | 'cancelled' | 'expired'

export interface ChatPrompt {
  requestId: string
  toolUseId: string
  toolName: string
  input: unknown
  /** The request as the CLI sent it (display fields, permission suggestions). */
  request: PermissionRequestEvent
  status: ChatPromptStatus
  /** The host's answer; null until resolved, and for answers older logs don't record. */
  decision: PermissionDecision | null
  /** The prompt row the user picked (display only). */
  optionId: string | null
}

interface PromptState {
  prompts: ChatPrompt[]
}

function update<S extends PromptState>(
  state: S,
  matches: (p: ChatPrompt) => boolean,
  change: (p: ChatPrompt) => ChatPrompt
): S {
  let changed = false
  const prompts = state.prompts.map((p) => {
    if (!matches(p)) return p
    changed = true
    return change(p)
  })
  return changed ? { ...state, prompts } : state
}

const isPending = (p: ChatPrompt): boolean => p.status === 'pending'

/** Apply one event's effect on the prompt list (identity when it has none). */
export function applyPromptEvent<S extends PromptState>(state: S, event: AgentEvent): S {
  switch (event.kind) {
    case 'permission-request': {
      if (state.prompts.some((p) => p.requestId === event.requestId)) return state
      const prompt: ChatPrompt = {
        requestId: event.requestId,
        toolUseId: event.toolUseId,
        toolName: event.toolName,
        input: event.input,
        request: event,
        status: 'pending',
        decision: null,
        optionId: null
      }
      return { ...state, prompts: [...state.prompts, prompt] }
    }
    case 'permission-resolved':
      return update(
        state,
        (p) => p.requestId === event.requestId && p.status !== 'resolved',
        (p) => ({
          ...p,
          status: 'resolved',
          decision: event.decision,
          optionId: event.optionId ?? null
        })
      )
    case 'permission-cancelled':
      return update(
        state,
        (p) => p.requestId === event.requestId && isPending(p),
        (p) => ({ ...p, status: 'cancelled' })
      )
    case 'tool-result':
      if (!event.toolUseId) return state
      return update(
        state,
        (p) => p.toolUseId === event.toolUseId && isPending(p),
        (p) => ({ ...p, status: 'resolved' })
      )
    case 'process-exit':
    case 'session-spawn':
    case 'interrupted':
      return expirePendingPrompts(state)
    default:
      return state
  }
}

/** Every pending prompt can no longer be answered (its process or turn is gone). */
export function expirePendingPrompts<S extends PromptState>(state: S): S {
  return update(state, isPending, (p) => ({ ...p, status: 'expired' }))
}

/** One pending prompt can no longer be answered (the server refused the answer). */
export function expirePrompt<S extends PromptState>(state: S, requestId: string): S {
  return update(
    state,
    (p) => p.requestId === requestId && isPending(p),
    (p) => ({ ...p, status: 'expired' })
  )
}

/** Prompts still waiting for the user, oldest first. */
export function selectPendingPrompts(state: PromptState): ChatPrompt[] {
  return state.prompts.filter(isPending)
}

export function hasPendingPrompt(state: PromptState): boolean {
  return state.prompts.some(isPending)
}

/** The latest prompt raised for a tool call, if any. */
export function selectPromptForTool(state: PromptState, toolUseId: string): ChatPrompt | null {
  if (!toolUseId) return null
  for (let i = state.prompts.length - 1; i >= 0; i--) {
    if (state.prompts[i].toolUseId === toolUseId) return state.prompts[i]
  }
  return null
}
