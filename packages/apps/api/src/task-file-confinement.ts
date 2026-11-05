/**
 * What the `files` scope means: a scoped (non-`full`) session — a browser signed in
 * to the hub — may use the file editor for ONE TASK, inside that task's own folders.
 *
 * The scope gate (`isPathAllowed`) only sees the procedure path, and the owner gate
 * (`owner-gate.ts`) deliberately lets a path inside nobody's project through
 * (`HUB_WIDE`: e.g. `~/.ssh`). Neither is enough for a weaker, internet-reachable
 * credential, so this runs after both, for every `files`-classified call by a
 * non-`full` principal:
 *
 *   - the input must name a `taskId`, and must NOT name a `computerId` or `projectId`
 *     (the task alone decides which machine the call runs on — computer-placement);
 *   - its `rootPath` must lie under one of that task's folders: its worktree, its
 *     base dir, its project's path, or a computer placement of its project.
 *
 * Every file op already keeps its relative path(s) under `rootPath`
 * (`assertWithinRoot` in file-editor's `file-ops.ts`), so pinning `rootPath` pins
 * the whole call. Refusals are FORBIDDEN: they reveal nothing about anyone else's
 * content, and name the rule so the editor can show why.
 *
 * A `full` principal (desktop, CLI, co-located `slay`) never reaches this.
 *
 * @module api/task-file-confinement
 */
import { TRPCError } from '@trpc/server'
import type { SlayzoneDb } from '@slayzone/platform'
import { securityEvent } from '@slayzone/platform/security-log'
import type { Scope } from '@slayzone/trpc-server'
import { requiredScope } from '@slayzone/transport/scopes'
import { pathIsWithin } from './access'

const TASK_ROOTS_SQL = `
  SELECT t.worktree_path AS root FROM tasks t WHERE t.id = ?
  UNION ALL SELECT t.base_dir FROM tasks t WHERE t.id = ?
  UNION ALL SELECT p.path FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?
  UNION ALL SELECT pp.root_path FROM tasks t
    JOIN project_placements pp ON pp.project_id = t.project_id WHERE t.id = ?`

/** `rawPath` lies under one of the task's folders (see the module doc). */
export async function taskRootsContain(
  db: SlayzoneDb,
  taskId: string,
  rawPath: string
): Promise<boolean> {
  if (!rawPath) return false
  const rows = await db.all<{ root: string | null }>(TASK_ROOTS_SQL, [
    taskId,
    taskId,
    taskId,
    taskId
  ])
  return rows.some((r) => !!r.root && pathIsWithin(rawPath, r.root))
}

function refuse(path: string, reason: string): TRPCError {
  securityEvent({
    event: 'authz.denied',
    outcome: 'denied',
    targetKind: 'procedure',
    targetId: path,
    detail: { reason: 'files_scope', rule: reason }
  })
  return new TRPCError({
    code: 'FORBIDDEN',
    message: `${path}: a browser session may only open files inside its task's folders (${reason})`
  })
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** Throws the refusal; resolves when the call may proceed (or is not a `files` call). */
export async function confineTaskFileCall(opts: {
  db: SlayzoneDb
  scopes: readonly Scope[]
  path: string
  getRawInput: () => Promise<unknown>
}): Promise<void> {
  if (opts.scopes.includes('full')) return
  if (requiredScope(opts.path) !== 'files') return
  const raw = (await opts.getRawInput()) as Record<string, unknown> | null | undefined
  const input = raw && typeof raw === 'object' ? raw : {}
  const taskId = str(input.taskId)
  if (!taskId) throw refuse(opts.path, 'no task')
  if (input.computerId != null || input.projectId != null) {
    throw refuse(opts.path, 'names a computer or project')
  }
  const rootPath = str(input.rootPath)
  if (!rootPath || !(await taskRootsContain(opts.db, taskId, rootPath))) {
    throw refuse(opts.path, 'outside the task')
  }
}
