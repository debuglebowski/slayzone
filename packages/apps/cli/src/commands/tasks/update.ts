import path from 'path'
import { existsSync } from 'fs'
import { apiGet, apiPatch } from '../../api'
import { findSourceRepo, getCurrentBranch, isGitRepo } from '../../git'
import { resolveId } from './_shared'

export interface UpdateOpts {
  title?: string
  description?: string
  appendDescription?: string
  status?: string
  priority?: string
  due?: string | false
  parent?: string | false
  permanent?: boolean
  worktreePath?: string
}

export async function updateAction(idPrefix: string | undefined, opts: UpdateOpts): Promise<void> {
  idPrefix = await resolveId(idPrefix)
  if (opts.description !== undefined && opts.appendDescription !== undefined) {
    console.error('Cannot use both --description and --append-description.')
    process.exit(1)
  }
  if (
    opts.title === undefined &&
    opts.description === undefined &&
    opts.appendDescription === undefined &&
    opts.status === undefined &&
    opts.priority === undefined &&
    opts.due === undefined &&
    opts.parent === undefined &&
    !opts.permanent &&
    opts.worktreePath === undefined
  ) {
    console.error(
      'Provide at least one of --title, --description, --append-description, --status, --priority, --due, --no-due, --parent, --no-parent, --permanent, --worktree-path'
    )
    process.exit(1)
  }

  if (opts.priority) {
    const p = parseInt(opts.priority, 10)
    if (isNaN(p) || p < 1 || p > 5) {
      console.error('Priority must be 1-5.')
      process.exit(1)
    }
  }

  // PATCH /api/tasks/:id owns id-prefix resolution for BOTH the task and
  // --parent (404 not-found / 400 ambiguous, same messages), status-alias
  // resolution against the task's project columns, --append-description's read of
  // the stored description, and reparent validation (via updateTaskOp). So the
  // prefix goes straight to the hub — no local DB read, which is what let a
  // remote hub work.
  const body: Record<string, unknown> = {}
  if (opts.title !== undefined) body.title = opts.title
  if (opts.description !== undefined) body.description = opts.description || null
  if (opts.appendDescription !== undefined) body.appendDescription = opts.appendDescription
  if (opts.status !== undefined) body.status = opts.status
  if (opts.priority) body.priority = parseInt(opts.priority, 10)
  if (typeof opts.due === 'string') body.dueDate = opts.due
  else if (opts.due === false) body.dueDate = null
  if (opts.parent === false) body.parentId = null
  else if (typeof opts.parent === 'string') body.parentId = opts.parent
  if (opts.permanent) body.isTemporary = false

  if (opts.worktreePath !== undefined) {
    // Worktree linking stays CLIENT-side: the git checks and the branch read are
    // filesystem-local to the machine that owns the worktree, which is this one —
    // not necessarily the hub's. Only the project PATH comes from the hub.
    const abs = path.resolve(opts.worktreePath)
    if (!existsSync(abs)) {
      console.error(`Worktree path does not exist: ${abs}`)
      process.exit(1)
    }
    if (!isGitRepo(abs)) {
      console.error(`Not a git worktree: ${abs}`)
      process.exit(1)
    }
    // GET /api/tasks/:id resolves the prefix (same 404/400) and carries
    // project_path, so the owning repo is derivable without a DB read.
    const { data: task } = await apiGet<{
      ok: true
      data: { id: string; project_path: string | null }
    }>(`/api/tasks/${encodeURIComponent(idPrefix)}`)
    const projectPath = task.project_path
    if (!projectPath) {
      console.error(`Project path is not set; cannot resolve worktree owner.`)
      process.exit(1)
    }
    const sourceRepo = findSourceRepo(projectPath, abs)
    if (!sourceRepo) {
      console.error(`Worktree ${abs} does not belong to any repo under project ${projectPath}.`)
      process.exit(1)
    }
    const parentBranch = getCurrentBranch(sourceRepo)
    if (!parentBranch) {
      console.error(`Could not determine current branch of source repo: ${sourceRepo}`)
      process.exit(1)
    }
    body.worktreePath = abs
    body.worktreeParentBranch = parentBranch
    body.repoName = sourceRepo === projectPath ? null : path.relative(projectPath, sourceRepo)
  }

  const { data: updated } = await apiPatch<{ ok: true; data: { id: string; title: string } }>(
    `/api/tasks/${encodeURIComponent(idPrefix)}`,
    body
  )
  console.log(`Updated: ${updated.id.slice(0, 8)}  ${updated.title}`)
}
