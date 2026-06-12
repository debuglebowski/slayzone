import { TypedEmitter } from '@slayzone/platform/events'
import type { CreateWorktreePhaseEvent } from '../shared/types'

export type WorktreesEventMap = {
  /** Emitted per createWorktree phase when the caller supplied a requestId. */
  'createWorktree:phase': [event: CreateWorktreePhaseEvent]
}

/**
 * Domain event bus for worktree progress. The tRPC `worktrees.createWorktree`
 * mutation emits phase events here; the `worktrees.onCreateWorktreePhase`
 * subscription wraps it in a per-request observable. The legacy IPC handler
 * streams the same phases via `webContents.send('git:createWorktree:phase')`
 * until the legacy IPC surface drops (slice 8).
 */
export const worktreesEvents = new TypedEmitter<WorktreesEventMap>()
