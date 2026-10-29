/**
 * Live vs saved events for one chat tab.
 *
 * Streaming fragments (`stream-*`) are LIVE ONLY: broadcast so the panel can
 * draw text as it arrives, never written to the tab's history. Each finished
 * block is saved exactly once:
 *   - Claude sends its own consolidated `assistant` event for every block (right
 *     after the block's last delta, before its stop) — that event is the saved one;
 *   - Codex sends fragments only — the splitter saves one `assistant-text` /
 *     `assistant-thinking` built from them when the block stops.
 *
 * Saving every fragment used to fill the 2000-event history with a single
 * reply (audit #5, Codex), and would do the same to Claude once token streaming
 * is switched on. A block cut short (Stop, crash, a result with the block still
 * open) is saved with the text it got, so nothing that was shown is lost.
 *
 * The reducer already skips a saved block event whose `messageId` it streamed,
 * so a live viewer sees the fragments once and a replay sees the block once.
 *
 * @module terminal/server/runtime/chat-event-splitter
 */
import type { AgentEvent, StreamBlockType } from '@slayzone/terminal-contracts'

export interface SplitResult {
  /** Broadcast only. */
  live: AgentEvent[]
  /** Saved (history + broadcast), in order. */
  saved: AgentEvent[]
}

interface OpenBlock {
  index: number
  type: StreamBlockType
  text: string
  hasSignature: boolean
  /** The provider sent this block's own saved event — build none. */
  consolidated: boolean
  toolUseId?: string
  toolName?: string
}

interface OpenMessage {
  messageId: string
  parentToolUseId?: string
  blocks: Map<number, OpenBlock>
}

/** Events after which no block of the turn can still be streaming. */
function endsTurn(kind: AgentEvent['kind']): boolean {
  return kind === 'result' || kind === 'interrupted' || kind === 'process-exit'
}

export function isStreamFragment(kind: AgentEvent['kind']): boolean {
  return (
    kind === 'stream-message-start' ||
    kind === 'stream-block-start' ||
    kind === 'stream-block-delta' ||
    kind === 'stream-block-stop' ||
    kind === 'stream-message-stop'
  )
}

export class ChatEventSplitter {
  private open: OpenMessage | null = null

  route(event: AgentEvent): SplitResult {
    switch (event.kind) {
      case 'stream-message-start': {
        const saved = this.closeOpen()
        this.open = {
          messageId: event.messageId,
          ...(event.parentToolUseId ? { parentToolUseId: event.parentToolUseId } : {}),
          blocks: new Map()
        }
        return { live: [event], saved }
      }
      case 'stream-block-start': {
        this.open?.blocks.set(event.blockIndex, {
          index: event.blockIndex,
          type: event.blockType,
          text: '',
          hasSignature: false,
          consolidated: false,
          ...(event.toolUseId ? { toolUseId: event.toolUseId } : {}),
          ...(event.toolName ? { toolName: event.toolName } : {})
        })
        return { live: [event], saved: [] }
      }
      case 'stream-block-delta': {
        const block = this.open?.blocks.get(event.blockIndex)
        if (block) {
          if (event.deltaType === 'signature') block.hasSignature = true
          else if (event.deltaType === 'text' || event.deltaType === 'thinking') {
            block.text += event.text
          }
        }
        return { live: [event], saved: [] }
      }
      case 'stream-block-stop': {
        const block = this.open?.blocks.get(event.blockIndex)
        const saved: AgentEvent[] = []
        if (block && this.open) {
          this.open.blocks.delete(event.blockIndex)
          const built = this.build(this.open, block)
          if (built) saved.push(built)
        }
        return { live: [event], saved }
      }
      case 'stream-message-stop': {
        return { live: [event], saved: this.closeOpen() }
      }
      case 'assistant-text':
      case 'assistant-thinking': {
        this.markConsolidated(
          event.messageId,
          event.kind === 'assistant-text' ? 'text' : 'thinking'
        )
        return { live: [], saved: [event] }
      }
      case 'tool-call': {
        if (this.open) {
          for (const block of this.open.blocks.values()) {
            if (block.type === 'tool_use' && block.toolUseId === event.id) block.consolidated = true
          }
        }
        return { live: [], saved: [event] }
      }
      default: {
        if (endsTurn(event.kind)) return { live: [], saved: [...this.closeOpen(), event] }
        return { live: [], saved: [event] }
      }
    }
  }

  /** Save what is still open (an abrupt end) and forget it. */
  closeOpen(): AgentEvent[] {
    const open = this.open
    if (!open) return []
    this.open = null
    const saved: AgentEvent[] = []
    for (const block of [...open.blocks.values()].sort((a, b) => a.index - b.index)) {
      const built = this.build(open, block)
      if (built) saved.push(built)
    }
    return saved
  }

  /** Live events that redraw the blocks still streaming (reload mid-stream). */
  snapshot(): AgentEvent[] {
    const open = this.open
    if (!open) return []
    const parent = open.parentToolUseId ? { parentToolUseId: open.parentToolUseId } : {}
    const out: AgentEvent[] = [
      { kind: 'stream-message-start', messageId: open.messageId, ...parent }
    ]
    for (const block of [...open.blocks.values()].sort((a, b) => a.index - b.index)) {
      if (block.consolidated) continue
      out.push({
        kind: 'stream-block-start',
        blockIndex: block.index,
        blockType: block.type,
        ...(block.toolUseId ? { toolUseId: block.toolUseId } : {}),
        ...(block.toolName ? { toolName: block.toolName } : {}),
        ...parent
      })
      if ((block.type === 'text' || block.type === 'thinking') && block.text) {
        out.push({
          kind: 'stream-block-delta',
          blockIndex: block.index,
          deltaType: block.type,
          text: block.text,
          ...parent
        })
      }
    }
    return out
  }

  private markConsolidated(messageId: string, type: 'text' | 'thinking'): void {
    if (!this.open || this.open.messageId !== messageId) return
    // The block it consolidates is the newest open one of that type.
    const candidates = [...this.open.blocks.values()].filter(
      (b) => b.type === type && !b.consolidated
    )
    const newest = candidates.sort((a, b) => b.index - a.index)[0]
    if (newest) newest.consolidated = true
  }

  private build(message: OpenMessage, block: OpenBlock): AgentEvent | null {
    if (block.consolidated || !block.text) return null
    const parent = message.parentToolUseId ? { parentToolUseId: message.parentToolUseId } : {}
    if (block.type === 'text') {
      return { kind: 'assistant-text', messageId: message.messageId, text: block.text, ...parent }
    }
    if (block.type === 'thinking') {
      return {
        kind: 'assistant-thinking',
        messageId: message.messageId,
        text: block.text,
        hasSignature: block.hasSignature,
        ...parent
      }
    }
    return null
  }
}
