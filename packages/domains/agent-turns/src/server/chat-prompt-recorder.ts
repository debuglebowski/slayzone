import { randomUUID } from 'node:crypto'
import type { SlayzoneDb } from '@slayzone/platform'
import {
  chatCapabilitiesForMode,
  isSyntheticChatPrompt,
  type AgentEvent
} from '@slayzone/terminal-contracts'
import { insertPrompt, prunePrompts } from './prompt-db'
import { agentPromptsEvents } from './events'

/** Who a chat event belongs to — resolved by the chat runtime from its live session. */
export interface ChatPromptContext {
  taskId: string
  /** Chat terminal mode (`claude-chat`, …) — stored as the prompt's `agent_id`. */
  mode: string
  /** CLI conversation id of the session — stored as `cli_session_id`. */
  conversationId: string | null
}

/**
 * Chat-mode counterpart of `capturePrompt`. Chat CLIs get no UserPromptSubmit
 * hook, so the chat runtime's `user-message` events (exactly what was sent) are
 * recorded instead — only for modes whose UI offers prompt history. Wired as the
 * chat handlers' `onChatEvent` by the composition root. Best-effort: never
 * throws into the event path.
 */
export function createChatPromptRecorder(
  db: SlayzoneDb
): (tabId: string, event: AgentEvent, ctx: ChatPromptContext | null) => Promise<void> {
  return async (_tabId, event, ctx) => {
    if (event.kind !== 'user-message' || !ctx) return
    if (!chatCapabilitiesForMode(ctx.mode).promptHistory) return
    const text = event.text
    if (!text.trim() || isSyntheticChatPrompt(text)) return
    try {
      await insertPrompt(db, {
        id: randomUUID(),
        task_id: ctx.taskId,
        agent_id: ctx.mode,
        cli_session_id: ctx.conversationId,
        text,
        created_at: Date.now()
      })
      await prunePrompts(db, ctx.taskId, ctx.mode)
      agentPromptsEvents.emit('agent-prompts:changed', ctx.taskId)
    } catch (err) {
      console.error('[chat-prompt-recorder] record failed:', err)
    }
  }
}
