/**
 * A task's computer paths — its worktree path and its base dir — live only on the
 * computer that holds the task's work (robustness plan §9, P0; Phase 7a, hub
 * migration v210). The wire shapes of one `chat.request` of kind `taskPaths`, the
 * `task-path` hand-off value, and the scope every path-taking request will name
 * (Phase 7b on): the hub authorizes the scope, the computer confines each path in
 * the request to the scope's roots, which it reads from its own store.
 *
 * Import-light (zod only).
 *
 * @module chat-runtime/shared/task-paths
 */
import { z } from 'zod'

const id = z.string().min(1).max(500)
const ts = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
/** An absolute path on the computer (POSIX `/…`, Windows `C:\…` or `\\server\…`). */
export const computerPathSchema = z
  .string()
  .min(1)
  .max(10_000)
  .refine(
    (p) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\'),
    'an absolute path'
  )

/** What a request touching paths is about: one task, or one project. */
export const pathScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task'), taskId: id }),
  z.object({ kind: z.literal('project'), projectId: id })
])
export type PathScope = z.infer<typeof pathScopeSchema>

/**
 * The `task-path` hand-off value, as of `at` (hub ms): the fields a write set (absent
 * = unchanged; null clears), or `inheritFrom` — a subtask takes that parent's paths
 * as this computer holds them.
 */
export const taskPathValueSchema = z.object({
  projectId: id.nullable(),
  worktreePath: computerPathSchema.nullable().optional(),
  baseDir: computerPathSchema.nullable().optional(),
  inheritFrom: id.optional(),
  at: ts
})
export type TaskPathValue = z.infer<typeof taskPathValueSchema>

/**
 * One write or read. Every write carries `at` (when the hub accepted it); the
 * computer keeps the newest, so a late or repeated delivery never rolls a path back.
 */
export const taskPathsRequestSchema = z.discriminatedUnion('op', [
  /** Set the task's project and, when given, its worktree path / base dir (null clears one). */
  z.object({
    op: z.literal('set'),
    taskId: id,
    projectId: id.nullable(),
    worktreePath: computerPathSchema.nullable().optional(),
    baseDir: computerPathSchema.nullable().optional(),
    at: ts
  }),
  /** A subtask takes its parent's paths, as this computer holds them. */
  z.object({
    op: z.literal('inherit'),
    taskId: id,
    parentTaskId: id,
    projectId: id.nullable(),
    at: ts
  }),
  /** The task was archived: its checkout is gone, both paths clear. */
  z.object({ op: z.literal('clear'), taskId: id, at: ts }),
  /** The rows of these tasks (absent ones are left out). */
  z.object({ op: z.literal('get'), taskIds: z.array(id).max(5000) }),
  /**
   * The task's checkout is about to be removed (archive, purge, erasure): its worktree
   * path here (also of a task already purged here) and whether a task in
   * `liveTaskIds` still names the same worktree (then it stays).
   */
  z.object({
    op: z.literal('release'),
    taskId: id,
    liveTaskIds: z.array(id).max(20_000)
  }),
  /** The hub is done with a purged task's checkout: forget its worktree path. */
  z.object({ op: z.literal('forget'), taskId: id })
])

/** A `release` answer: the worktree to remove, or null; `shared`: a live task keeps it. */
export interface TaskPathRelease {
  worktreePath: string | null
  shared: boolean
}
export type TaskPathsRequest = z.infer<typeof taskPathsRequestSchema>

/** One task's paths on this computer. */
export interface TaskPathRow {
  taskId: string
  projectId: string | null
  worktreePath: string | null
  baseDir: string | null
  at: number
}
