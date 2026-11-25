import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { resolveCommand } from '@slayzone/platform'
import { forEachIsolated } from '@slayzone/platform/isolation'
import {
  workspaceMoveRequestSchema,
  type WorkspaceMoveInspection
} from '@slayzone/computer-transport/shared'
import { execCapture } from './exec'
import { createWorkspaceMove } from './workspace-move'
import { judgePath, judgePathIn } from '../path-jail'
import type { HandlerContext } from './types'

export function createWorkspaceMoveHandlers(opts: {
  ctx: HandlerContext
  stateDir: string
  hubScope: string
  paths(taskId: string): Promise<{ worktreePath: string | null; baseDir: string | null }>
  project(projectId: string): { path: string } | undefined
  stop(taskId: string): Promise<void>
  history(taskId: string): Promise<string[]>
  hasWork(taskId: string): boolean
  setPaths(
    taskId: string,
    projectId: string,
    paths: { worktreePath: string | null; baseDir: string | null }
  ): Promise<void>
}) {
  const stateDir = join(
    opts.stateDir,
    'computer-runtime',
    'workspace-transfer',
    createHash('sha256').update(opts.hubScope).digest('hex')
  )
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const lockFile = join(stateDir, 'locks.json')
  const locks: Record<string, string> = Object.assign(
    Object.create(null),
    existsSync(lockFile) ? JSON.parse(readFileSync(lockFile, 'utf8')) : {}
  )
  const save = () => {
    writeFileSync(`${lockFile}.tmp`, JSON.stringify(locks), { mode: 0o600 })
    renameSync(`${lockFile}.tmp`, lockFile)
  }
  const mover = createWorkspaceMove({ stateDir, roots: () => opts.ctx.config.allowedRoots })
  const assertAvailable = (taskId: string) => {
    if (locks[taskId])
      throw new Error(
        'Task is moving to another computer. Retry or cancel the move before starting work.'
      )
  }
  /** Where the task's repository lives on this computer: the project folder, or
   *  `repoName` inside it (judged against the allowed roots). */
  const repoPathOf = (project: { path: string } | undefined, repoName?: string | null) =>
    project && repoName
      ? judgePathIn(project.path, repoName, opts.ctx.config.allowedRoots).path
      : project?.path
  const originOf = async (repo: string): Promise<string | null> => {
    const result = await execCapture('git', ['-C', repo, 'remote', 'get-url', 'origin'])
    return result.status === 0 ? result.stdout.trim() || null : null
  }
  const request = async (raw: unknown): Promise<unknown> => {
    const input = workspaceMoveRequestSchema.parse(raw)
    switch (input.op) {
      case 'lock':
        if (locks[input.taskId] && locks[input.taskId] !== input.id)
          throw new Error('Task is already locked by another computer move')
        locks[input.taskId] = input.id
        save()
        await opts.stop(input.taskId)
        return { ok: true }
      case 'unlock':
        if (locks[input.taskId] === input.id) {
          delete locks[input.taskId]
          save()
        }
        return { ok: true }
      case 'inspect': {
        const project = opts.project(input.projectId)
        const repo = repoPathOf(project, input.repoName)
        const ownPaths = await opts.paths(input.taskId)
        const env = {
          ...process.env,
          PATH: opts.ctx.config.binOverrideDir
            ? `${opts.ctx.config.binOverrideDir}${delimiter}${process.env.PATH ?? ''}`
            : process.env.PATH
        } as Record<string, string>
        const repoReady = !!repo && existsSync(join(repo, '.git'))
        const inspection: WorkspaceMoveInspection = {
          projectReady: !!project && existsSync(project.path),
          repoReady,
          worktreeGit: !!ownPaths.worktreePath && existsSync(join(ownPaths.worktreePath, '.git')),
          hasWork: opts.hasWork(input.taskId),
          sessionModes: await opts.history(input.taskId),
          commands: Object.fromEntries(
            (input.commands ?? []).map((command) => [
              command,
              !!resolveCommand(command, env, undefined)
            ])
          ),
          agents: {
            claude: !!resolveCommand('claude', env, undefined),
            codex: !!resolveCommand('codex', env, undefined)
          },
          folder: project?.path ?? null,
          repoPath: repo ?? null,
          remoteUrl: repoReady && repo ? await originOf(repo) : null
        }
        return inspection
      }
      case 'clone': {
        const project = opts.project(input.projectId)
        if (!project)
          throw new Error('Choose this project’s folder on the destination computer first.')
        const place = repoPathOf(project, input.repoName)
        if (!place) throw new Error('The repository has no place in this project’s folder.')
        const target = judgePath(place, opts.ctx.config.allowedRoots)
        if (existsSync(target) && (await readdir(target)).length > 0)
          throw new Error(
            `${target} is not empty. Choose an empty folder, or check the repository out there yourself.`
          )
        const parent = dirname(target)
        mkdirSync(parent, { recursive: true })
        const result = await execCapture(
          'git',
          ['-c', 'protocol.ext.allow=never', 'clone', '--', input.url, target],
          {
            cwd: parent,
            timeoutMs: 30 * 60 * 1000,
            // Never wait on a credential prompt nobody can answer.
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' }
          }
        )
        if (result.status !== 0)
          throw new Error(
            `Could not clone ${input.url}: ${result.stderr.trim() || 'git clone failed'}`
          )
        return { path: target }
      }
      case 'snapshot':
        return mover.snapshot({ ...input, ...(await opts.paths(input.taskId)) })
      case 'begin':
        return mover.begin(input)
      case 'read':
        return mover.read(input.id, input.path, input.offset, input.length)
      case 'offset':
        return mover.offset(input.id, input.path)
      case 'write':
        return mover.write(input.id, input.path, input.offset, input.data)
      case 'verify':
        return mover.verify(input.id)
      case 'verifySource':
        return mover.verifySource(input.id)
      case 'verifyDestination':
        return mover.verifyDestination(input.id)
      case 'activate': {
        const project = opts.project(input.projectId)
        if (!project)
          throw new Error('Configure this project’s folder on the destination computer first.')
        const repo = repoPathOf(project, input.repoName) ?? project.path
        const paths = await mover.activate(input.id, repo)
        await opts.setPaths(input.taskId, input.projectId, paths)
        return { hasWorktree: !!paths.worktreePath, hasBaseDir: !!paths.baseDir }
      }
      case 'discard':
        return mover.discard(input.id)
    }
  }
  return {
    request,
    assertAvailable,
    async eraseTask(taskId: string) {
      const moveIds = new Set<string>()
      if (locks[taskId]) moveIds.add(locks[taskId])
      const snapshots = join(stateDir, 'workspace-moves')
      // Every record is read and every move discarded, even past a bad one; the erasure
      // only succeeds (and drops the lock) once none failed, so a retry finds the rest.
      const scanned = existsSync(snapshots)
        ? await forEachIsolated(
            await readdir(snapshots),
            { pass: 'computer.workspace-move-erasure-scan', key: (id) => id },
            (id) => {
              const file = join(snapshots, id, 'record.json')
              if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).taskId === taskId)
                moveIds.add(id)
            }
          )
        : null
      const discarded = await forEachIsolated(
        moveIds,
        { pass: 'computer.workspace-move-erasure', key: (id) => id, taskId: () => taskId },
        (id) => mover.discard(id)
      )
      const failed = [...(scanned?.failed ?? []), ...discarded.failed]
      if (failed.length)
        throw new AggregateError(
          failed.map((f) => f.error),
          `Workspace moves of task ${taskId} could not all be erased: ${failed.map((f) => f.key).join(', ')}`
        )
      delete locks[taskId]
      save()
    }
  }
}
