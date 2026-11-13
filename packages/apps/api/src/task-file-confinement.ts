/**
 * What the `files` scope means: a scoped (non-`full`) session — a browser signed in
 * to the hub — may use the file editor for ONE TASK, inside that task's own folders.
 *
 * The scope gate (`isPathAllowed`) only sees the procedure path, so this runs after
 * it and the owner gate (`owner-gate.ts`, which checks the task is the caller's), for
 * every `files`-classified call by a non-`full` principal: the input must name a
 * `taskId`, and must NOT name a `computerId` or `projectId` — the task alone is the
 * call's path scope and decides which machine it runs on (computer-placement).
 *
 * Its folders are the computer's to judge (§9 Phase 7c: the hub keeps no task
 * path): the file editor runs every call in that task's path scope, and the computer
 * confines `rootPath` and every path under it to the task's own folders there — its
 * worktree, else its base dir, plus its project's folder, other tasks' carved out
 * (`path-jail.ts` `judgeScope`; links resolved, `..` refused).
 *
 * Refusals are FORBIDDEN: they reveal nothing about anyone else's content, and name
 * the rule so the editor can show why. A `full` principal (desktop, CLI, co-located
 * `slay`) never reaches this.
 *
 * @module api/task-file-confinement
 */
import { TRPCError } from '@trpc/server'
import type { SlayzoneDb } from '@slayzone/platform'
import { securityEvent } from '@slayzone/platform/security-log'
import type { Scope } from '@slayzone/trpc-server'
import { requiredScope } from '@slayzone/transport/scopes'

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
}
