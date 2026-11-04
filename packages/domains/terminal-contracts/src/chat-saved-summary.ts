/**
 * What the hub needs to know about every SAVED chat event, whether or not it relays
 * the event itself (docs/direct-link.md): its seq (history progress) and, for the
 * events the hub acts on, the few fields it reads — a user message (prompt lists),
 * a message's delivery state (`slay chat` waits on it). Computers send this for every
 * saved event; the full event goes to the hub only while a hub client watches the tab.
 */
import type { AgentEvent } from './agent-events'

export interface ChatSavedSummary {
  seq: number
  kind: string
  /** `user-message` / `user-message-delivery`: the message id. */
  id?: string
  /** `user-message-delivery`: its state, and the error when it failed. */
  state?: string
  error?: string
}

export function chatSavedSummary(event: AgentEvent, seq: number): ChatSavedSummary {
  if (event.kind === 'user-message-delivery') {
    return {
      seq,
      kind: event.kind,
      id: event.id,
      state: event.state,
      ...(event.error ? { error: event.error } : {})
    }
  }
  if (event.kind === 'user-message' && typeof event.id === 'string') {
    return { seq, kind: event.kind, id: event.id }
  }
  return { seq, kind: event.kind }
}
