import type { AgentEvent } from '@slayzone/terminal-contracts'
import { OutboxRestoreScan, type RestoredOutboxMessage } from './chat-outbox'

type Branch = Extract<AgentEvent, { kind: 'conversation-branch' }>
type TurnBoundary = 'none' | 'ended' | 'branch' | 'user' | 'imported'

/** Computer-local input to the next restart's scan, at the projection checkpoint's seq. */
export interface HydrateCheckpoint {
  version: 1
  messages: RestoredOutboxMessage[]
  newestBranch: Branch | null
  decided: TurnBoundary
  toolCall: boolean
}

/**
 * What hydrate needs from a tab's WHOLE saved history, folded in event by event
 * (fed a page at a time): the outbox's unconfirmed messages, the newest
 * conversation branch (an unconfirmed fork re-arms), and whether the history ends
 * in an unfinished turn (a tool call after the last turn end, not imported).
 */
export class HydrateScan {
  readonly outbox: OutboxRestoreScan
  newestBranch: Branch | null
  /** The newest event that decides whether the turn is unfinished. */
  private decided: TurnBoundary
  /** A tool call after it. */
  private toolCall: boolean

  constructor(saved?: HydrateCheckpoint) {
    this.outbox = new OutboxRestoreScan(saved?.messages)
    this.newestBranch = saved?.newestBranch ?? null
    this.decided = saved?.decided ?? 'none'
    this.toolCall = saved?.toolCall ?? false
  }

  checkpoint(): HydrateCheckpoint {
    return {
      version: 1,
      messages: [...this.outbox.messages.values()],
      newestBranch: this.newestBranch,
      decided: this.decided,
      toolCall: this.toolCall
    }
  }

  add(event: AgentEvent): void {
    this.outbox.add(event)
    switch (event.kind) {
      case 'result':
      case 'process-exit':
      case 'interrupted':
      case 'user-message-popped':
        this.decide('ended')
        break
      case 'conversation-branch':
        this.newestBranch = event
        this.decide('branch')
        break
      case 'user-message':
        this.decide(event.history ? 'imported' : 'user')
        break
      case 'tool-call':
        // A background child's tools can outlive a completed main turn.
        if (event.parentToolUseId == null) this.toolCall = true
        break
    }
  }

  /** Restored history with an unfinished turn gets a synthetic `interrupted`. */
  get unfinishedTurn(): boolean {
    if (this.decided === 'branch' || this.decided === 'imported') return false
    if (this.decided === 'user') return true
    return this.toolCall
  }

  private decide(kind: TurnBoundary): void {
    this.decided = kind
    this.toolCall = false
  }
}
