/**
 * Agent-turn snapshots live only on the computer holding the checkout (robustness
 * plan §9, P0; hub migration v207): the wire shapes of one `chat.request` of kind
 * `turns`. The hub still detects turn boundaries (a submitted prompt, a chat result)
 * and knows the task's checkout; the computer snapshots, dedupes, keeps and lists.
 *
 * @module chat-runtime/shared/agent-turns
 */
import { z } from 'zod'

const id = z.string().min(1).max(500)
const path = z.string().min(1).max(10_000)

/** Longest prompt preview a turn keeps. */
export const TURN_PREVIEW_MAX = 200

export const turnsRequestSchema = z.discriminatedUnion('op', [
  /**
   * One turn boundary of `tabId` (task `taskId`) in the task's checkout — resolved
   * here (§9 Phase 7c: the hub keeps no task path): its worktree, else its project's
   * folder (`projectId`, as the hub records it). `repoPath`, when given, is judged
   * against the task's own folders.
   */
  z.object({
    op: z.literal('record'),
    taskId: id,
    tabId: id,
    projectId: id.nullable(),
    repoPath: path.optional(),
    promptPreview: z.string().max(TURN_PREVIEW_MAX)
  }),
  /**
   * Every live turn of the task's checkout, oldest first, filtered for display. The
   * computer resolves the checkout like `record` (§9 Phase 7d: nobody else names it).
   */
  z.object({
    op: z.literal('list'),
    taskId: id,
    projectId: id.nullable(),
    repoPath: path.optional()
  }),
  /** Consistency: ids of turns whose task is deleted here (its erasure should have taken them). */
  z.object({ op: z.literal('deletedTaskTurns') })
])
export type TurnsRequest = z.infer<typeof turnsRequestSchema>

/** One stored turn (the hub's former `agent_turns` row shape). */
export interface StoredAgentTurn {
  id: string
  worktree_path: string
  task_id: string | null
  terminal_tab_id: string
  snapshot_sha: string
  head_sha_at_snap: string | null
  prompt_preview: string
  created_at: number
}

/** A turn paired with the snapshot its diff starts from (null for the first). */
export interface StoredAgentTurnRange extends StoredAgentTurn {
  prev_snapshot_sha: string | null
}

export type TurnRecordResult =
  | { recorded: false }
  | { recorded: true; id: string; worktreePath: string; createdAt: number }

export interface TurnListResult {
  /** The checkout's canonical path on this computer. */
  worktreePath: string
  rows: StoredAgentTurnRange[]
}
