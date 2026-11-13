import { z } from 'zod'

/**
 * Duplicate a task as a fresh follow-up in a project of the same hub (its own
 * project included). The copy keeps what describes the work — title (or `title`),
 * description, priority, assignee, agent, tags (by name) — and starts fresh: the
 * target's default status, no parent, subtasks, worktree or sessions.
 */
export const duplicateTaskInputSchema = z.object({
  taskId: z.string().min(1),
  targetProjectId: z.string().min(1),
  /** The copy's title. Absent: the source task's. */
  title: z.string().trim().min(1).optional()
})
export type DuplicateTaskInput = z.input<typeof duplicateTaskInputSchema>

export interface DuplicateTaskResult {
  /** The new task. */
  taskId: string
}
