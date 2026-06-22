import path from 'path'
import { existsSync } from 'fs'
import { openDb } from '../../db'
import { apiPatch } from '../../api'
import { findSourceRepo, getCurrentBranch, isGitRepo } from '../../git'
import { resolveStatusId } from '@slayzone/projects/shared'
import {
  validateReparent,
  reparentErrorMessage,
  type ReparentTaskRow
} from '@slayzone/task/shared/reparent-validation'
import { getProjectColumnsConfig, resolveId } from './_shared'

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

  const db = openDb()

  const tasks = db.query<{
    id: string
    title: string
    project_id: string
    description: string | null
  }>(`SELECT id, title, project_id, description FROM tasks WHERE id LIKE :prefix || '%' LIMIT 2`, {
    ':prefix': idPrefix
  })

  if (tasks.length === 0) {
    console.error(`Task not found: ${idPrefix}`)
    process.exit(1)
  }
  if (tasks.length > 1) {
    console.error(
      `Ambiguous id prefix "${idPrefix}". Matches: ${tasks.map((t) => t.id.slice(0, 8)).join(', ')}`
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

  const task = tasks[0]
  let resolvedStatus: string | undefined
  if (opts.status) {
    const taskColumns = getProjectColumnsConfig(db, task.project_id)
    resolvedStatus = resolveStatusId(opts.status, taskColumns) ?? undefined
    if (!resolvedStatus) {
      console.error(`Unknown status "${opts.status}" for this task's project.`)
      process.exit(1)
    }
  }

  let resolvedParentId: string | null | undefined
  if (opts.parent === false) {
    resolvedParentId = null
  } else if (typeof opts.parent === 'string') {
    const parentMatches = db.query<{ id: string }>(
      `SELECT id FROM tasks WHERE id LIKE :prefix || '%' LIMIT 2`,
      { ':prefix': opts.parent }
    )
    if (parentMatches.length === 0) {
      console.error(`Parent task not found: ${opts.parent}`)
      process.exit(1)
    }
    if (parentMatches.length > 1) {
      console.error(
        `Ambiguous parent id prefix "${opts.parent}". Matches: ${parentMatches.map((t) => t.id.slice(0, 8)).join(', ')}`
      )
      process.exit(1)
    }
    resolvedParentId = parentMatches[0].id
  }
  if (resolvedParentId !== undefined) {
    const result = validateReparent({
      taskId: task.id,
      parentId: resolvedParentId,
      lookup: (id: string) => {
        const rows = db.query<ReparentTaskRow>(
          `SELECT id, project_id, parent_id, archived_at, deleted_at FROM tasks WHERE id = :id LIMIT 1`,
          { ':id': id }
        )
        return rows[0] ?? null
      }
    })
    if (!result.ok) {
      console.error(
        reparentErrorMessage(result.error, { taskId: task.id, parentId: resolvedParentId })
      )
      process.exit(1)
    }
  }

  const body: Record<string, unknown> = {}
  if (opts.title !== undefined) body.title = opts.title
  if (opts.description !== undefined) body.description = opts.description || null
  if (opts.appendDescription !== undefined)
    body.description = (task.description ?? '') + '\n' + opts.appendDescription
  if (resolvedStatus) body.status = resolvedStatus
  if (opts.priority) body.priority = parseInt(opts.priority, 10)
  if (typeof opts.due === 'string') body.dueDate = opts.due
  else if (opts.due === false) body.dueDate = null
  if (resolvedParentId !== undefined) body.parentId = resolvedParentId
  if (opts.permanent) body.isTemporary = false

  if (opts.worktreePath !== undefined) {
    const abs = path.resolve(opts.worktreePath)
    if (!existsSync(abs)) {
      console.error(`Worktree path does not exist: ${abs}`)
      process.exit(1)
    }
    if (!isGitRepo(abs)) {
      console.error(`Not a git worktree: ${abs}`)
      process.exit(1)
    }
    const projRows = db.query<{ path: string | null }>(
      `SELECT path FROM projects WHERE id = :id LIMIT 1`,
      { ':id': task.project_id }
    )
    const projectPath = projRows[0]?.path
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

  db.close()
  await apiPatch<{ ok: boolean; data: { id: string; title: string } }>(
    `/api/tasks/${task.id}`,
    body
  )
  console.log(`Updated: ${task.id.slice(0, 8)}  ${opts.title ?? task.title}`)
}
