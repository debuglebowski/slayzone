import type { AgentEvent } from '@slayzone/terminal-contracts'

/**
 * Who a reply answers:
 *   - `voice`: a turn this voice loop sent;
 *   - `typed`: a message typed in the composer (still spoken in conversation mode);
 *   - `unprompted`: a turn the agent started by itself (background task done…).
 */
export type ReplyOrigin = 'voice' | 'typed' | 'unprompted'

export type ReplyStreamEvent =
  | { kind: 'message-start'; messageId: string; origin: ReplyOrigin; turnKey: string }
  | { kind: 'text'; messageId: string; text: string }
  | { kind: 'message-end'; messageId: string }
  /** The agent's turn is over (result / interrupted). */
  | { kind: 'turn-end'; turnKey: string | null }

/**
 * Reads the chat's agent events (the same stream the chat timeline reduces) and
 * yields the main agent's reply text as it streams: live `stream-block-delta`
 * text when the provider streams, else the saved `assistant-text` whole. Text of
 * sub-agents, thinking and tool input is never part of the reply.
 */
export class ReplyStreamReader {
  /** Message ids this loop sent (the chat outbox id = the turn's `execution.messageId`). */
  private readonly voiceIds = new Set<string>()
  /** Messages whose text arrived as live deltas (their saved copy is a duplicate). */
  private readonly streamed = new Set<string>()
  private readonly ended = new Set<string>()
  private streamMessageId: string | null = null
  private textBlock: number | null = null
  private textBlocksInMessage = 0
  /** The newest message this loop sent that is not answered yet. */
  private pendingVoiceId: string | null = null
  private currentTurnKey: string | null = null

  constructor(private readonly emit: (e: ReplyStreamEvent) => void) {}

  /** Register a message id before sending it, so its reply is attributed to voice. */
  expectVoiceMessage(id: string): void {
    this.voiceIds.add(id)
    this.pendingVoiceId = id
  }

  accept(event: AgentEvent): void {
    if (event.parentToolUseId) return
    switch (event.kind) {
      case 'stream-message-start': {
        this.closeStreamMessage()
        this.streamMessageId = event.messageId
        this.textBlock = null
        this.textBlocksInMessage = 0
        return
      }
      case 'stream-block-start': {
        if (event.blockType !== 'text' || !this.streamMessageId) return
        const id = this.streamMessageId
        if (!this.streamed.has(id)) {
          this.streamed.add(id)
          this.emit({ kind: 'message-start', messageId: id, ...this.attribute(event) })
        } else if (this.textBlocksInMessage > 0) {
          // A second text block of the same message is a new paragraph.
          this.emit({ kind: 'text', messageId: id, text: '\n' })
        }
        this.textBlock = event.blockIndex
        this.textBlocksInMessage++
        return
      }
      case 'stream-block-delta': {
        if (event.deltaType !== 'text' || !this.streamMessageId) return
        if (event.blockIndex !== this.textBlock) return
        this.emit({ kind: 'text', messageId: this.streamMessageId, text: event.text })
        return
      }
      case 'stream-block-stop': {
        if (event.blockIndex === this.textBlock) this.textBlock = null
        return
      }
      case 'stream-message-stop': {
        this.closeStreamMessage()
        return
      }
      case 'assistant-text': {
        if (this.streamed.has(event.messageId) || this.ended.has(event.messageId)) return
        this.ended.add(event.messageId)
        this.emit({ kind: 'message-start', messageId: event.messageId, ...this.attribute(event) })
        this.emit({ kind: 'text', messageId: event.messageId, text: event.text })
        this.emit({ kind: 'message-end', messageId: event.messageId })
        return
      }
      case 'result':
      case 'interrupted': {
        this.closeStreamMessage()
        const turnKey = this.currentTurnKey
        this.currentTurnKey = null
        if (event.kind === 'result' && event.execution?.messageId) {
          if (event.execution.messageId === this.pendingVoiceId) this.pendingVoiceId = null
        } else if (event.kind === 'interrupted' || !event.execution) {
          this.pendingVoiceId = null
        }
        this.emit({ kind: 'turn-end', turnKey })
        return
      }
      case 'user-message-delivery': {
        if (
          (event.state === 'failed' || event.state === 'cancelled') &&
          event.id === this.pendingVoiceId
        ) {
          this.pendingVoiceId = null
        }
        return
      }
      default:
        return
    }
  }

  private closeStreamMessage(): void {
    const id = this.streamMessageId
    this.streamMessageId = null
    this.textBlock = null
    if (id && this.streamed.has(id) && !this.ended.has(id)) {
      this.ended.add(id)
      this.emit({ kind: 'message-end', messageId: id })
    }
  }

  private attribute(event: AgentEvent): { origin: ReplyOrigin; turnKey: string } {
    const exec = event.execution
    let origin: ReplyOrigin
    let turnKey: string
    if (exec) {
      turnKey = exec.turnId
      if (exec.messageId) origin = this.voiceIds.has(exec.messageId) ? 'voice' : 'typed'
      else origin = 'unprompted'
    } else {
      // No attribution on this event: the open voice turn, if there is one.
      origin = this.pendingVoiceId ? 'voice' : 'unprompted'
      turnKey = this.currentTurnKey ?? this.pendingVoiceId ?? `anon:${Date.now()}`
    }
    this.currentTurnKey = turnKey
    return { origin, turnKey }
  }
}
