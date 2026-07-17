/**
 * Runner-side git exec handlers. Reimplements the pure, path-parametrized git
 * worktree operations the hub delegates to a runner. The equivalent logic lives
 * in `@slayzone/worktrees/server` (git-worktree.ts), but that package drags in
 * the full electron/React/diagnostics tree, so the runner reimplements the
 * handful of operations it needs via child_process git to stay a lightweight
 * standalone bundle.
 *
 * The git.* frame method names + param shapes are OWNED by the parallel
 * Wave2-A2 unit and are not yet present in `@slayzone/runner-transport/shared`; the method
 * names and schemas below MIRROR the agreed contract and a later integration
 * reconciles them against the canonical frames.
 *
 * EVERY path argument passes the {@link assertPathAllowed} realpath containment
 * guard before any filesystem/git access.
 *
 * @module runner/handlers/git
 */

import { spawn } from 'node:child_process'
import { accessSync, chmodSync, constants as fsConstants, existsSync } from 'node:fs'
import { cp, mkdir } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { RunnerNotificationMethods } from '@slayzone/runner-transport/shared'
import { z } from 'zod'
import { assertPathAllowed } from '../config'
import { execCapture, execGit } from './exec'
import type { HandlerContext, HubMethodTable } from './types'

/**
 * git.* method names. Mirrors the Wave2-A2 frame contract (not yet in
 * `@slayzone/runner-transport/shared`).
 */
export const GitMethods = {
  isGitRepo: 'git.isGitRepo',
  getCurrentBranch: 'git.getCurrentBranch',
  createWorktree: 'git.createWorktree',
  removeWorktree: 'git.removeWorktree',
  runWorktreeSetupScript: 'git.runWorktreeSetupScript',
  copyIgnoredFiles: 'git.copyIgnoredFiles'
} as const

const isGitRepoParams = z.object({ path: z.string().min(1) })
const getCurrentBranchParams = z.object({ path: z.string().min(1) })
const createWorktreeParams = z.object({
  repoPath: z.string().min(1),
  worktreePath: z.string().min(1),
  branch: z.string().min(1).optional(),
  sourceBranch: z.string().min(1).optional()
})
const removeWorktreeParams = z.object({
  repoPath: z.string().min(1),
  worktreePath: z.string().min(1),
  branchHint: z.string().min(1).optional()
})
const runWorktreeSetupScriptParams = z.object({
  worktreePath: z.string().min(1),
  repoPath: z.string().min(1),
  sourceBranch: z.string().nullable().optional()
})
const copyIgnoredFilesParams = z.object({
  repoPath: z.string().min(1),
  worktreePath: z.string().min(1),
  behavior: z.enum(['all', 'custom']),
  customPaths: z.array(z.string()).optional()
})

const SETUP_SCRIPT = '.slay/worktree-setup.sh'
const SETUP_SCRIPT_TIMEOUT_MS = 5 * 60_000

export function createGitHandlers(ctx: HandlerContext): HubMethodTable {
  const roots = ctx.config.allowedRoots

  async function isGitRepo(rawParams: unknown): Promise<{ isRepo: boolean }> {
    const { path } = isGitRepoParams.parse(rawParams)
    const repoPath = assertPathAllowed(path, roots)
    try {
      await execGit(['rev-parse', '--git-dir'], repoPath)
      return { isRepo: true }
    } catch {
      return { isRepo: false }
    }
  }

  async function getCurrentBranch(rawParams: unknown): Promise<{ branch: string | null }> {
    const { path } = getCurrentBranchParams.parse(rawParams)
    const repoPath = assertPathAllowed(path, roots)
    try {
      const out = await execGit(['branch', '--show-current'], repoPath)
      return { branch: out.trim() || null }
    } catch {
      return { branch: null }
    }
  }

  async function createWorktree(rawParams: unknown): Promise<{ ok: true }> {
    const params = createWorktreeParams.parse(rawParams)
    const repoPath = assertPathAllowed(params.repoPath, roots)
    const targetPath = assertPathAllowed(params.worktreePath, roots)
    const args = ['worktree', 'add', targetPath]
    if (params.branch) args.push('-b', params.branch)
    if (params.sourceBranch) args.push(params.sourceBranch)
    await execGit(args, repoPath)
    return { ok: true }
  }

  async function removeWorktree(
    rawParams: unknown
  ): Promise<{ branchDeleted?: boolean; branchError?: string }> {
    const params = removeWorktreeParams.parse(rawParams)
    const repoPath = assertPathAllowed(params.repoPath, roots)
    const worktreePath = assertPathAllowed(params.worktreePath, roots)

    try {
      await execGit(['worktree', 'remove', worktreePath, '--force'], repoPath)
    } catch (err) {
      // If the directory is already gone, prune stale metadata; otherwise fail.
      if (!existsSync(worktreePath)) {
        await execGit(['worktree', 'prune'], repoPath)
      } else {
        throw err
      }
    }

    if (params.branchHint === undefined) return {}

    const branch = params.branchHint.replace(/^refs\/heads\//, '').trim()
    if (!branch) return {}
    const repoBranch = (await getCurrentBranch({ path: repoPath })).branch
    if (branch === repoBranch) {
      return { branchDeleted: false, branchError: `refusing to delete checked-out branch '${branch}'` }
    }
    const result = await execCapture('git', ['branch', '-D', branch], { cwd: repoPath })
    if (result.status === 0) return { branchDeleted: true }
    return {
      branchDeleted: false,
      branchError: result.stderr.trim() || `could not delete branch '${branch}'`
    }
  }

  function runWorktreeSetupScript(
    rawParams: unknown
  ): Promise<{ ran: boolean; success?: boolean; output?: string }> {
    const params = runWorktreeSetupScriptParams.parse(rawParams)
    const worktreePath = assertPathAllowed(params.worktreePath, roots)
    const repoPath = assertPathAllowed(params.repoPath, roots)

    const scriptPath = resolve(worktreePath, SETUP_SCRIPT)
    if (!existsSync(scriptPath)) return Promise.resolve({ ran: false })
    try {
      accessSync(scriptPath, fsConstants.X_OK)
    } catch {
      try {
        chmodSync(scriptPath, 0o755)
      } catch {
        return Promise.resolve({ ran: false })
      }
    }

    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') env[k] = v
    }
    env.WORKTREE_PATH = worktreePath
    env.REPO_PATH = repoPath
    env.SOURCE_BRANCH = params.sourceBranch ?? ''

    return new Promise((resolvePromise) => {
      const child = spawn(scriptPath, [], { cwd: worktreePath, stdio: ['ignore', 'pipe', 'pipe'], env })
      const chunks: string[] = []
      const onData = (data: Buffer): void => {
        const text = data.toString()
        chunks.push(text)
        // Stream progress to the hub over the generic runner event channel.
        ctx.dialer.notify(RunnerNotificationMethods.event, {
          name: 'git.worktreeSetupData',
          payload: { worktreePath, chunk: text }
        })
      }
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)

      const timeout = setTimeout(() => child.kill('SIGTERM'), SETUP_SCRIPT_TIMEOUT_MS)
      child.on('close', (code) => {
        clearTimeout(timeout)
        resolvePromise({ ran: true, success: code === 0, output: chunks.join('').trim() })
      })
      child.on('error', (err) => {
        clearTimeout(timeout)
        resolvePromise({ ran: true, success: false, output: err.message })
      })
    })
  }

  async function copyIgnoredFiles(rawParams: unknown): Promise<{ copied: number }> {
    const params = copyIgnoredFilesParams.parse(rawParams)
    const repoPath = assertPathAllowed(params.repoPath, roots)
    const worktreePath = assertPathAllowed(params.worktreePath, roots)

    let relPaths: string[]
    if (params.behavior === 'all') {
      const out = await execGit(
        ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'],
        repoPath
      )
      relPaths = out.split('\0').filter(Boolean)
    } else {
      relPaths = params.customPaths ?? []
    }

    const repoRoot = resolve(repoPath)
    const wtRoot = resolve(worktreePath)
    let copied = 0
    for (const rel of relPaths) {
      const src = resolve(repoPath, rel)
      const dest = resolve(worktreePath, rel)
      // Containment: never copy out of the repo or write outside the worktree.
      if (!isInside(src, repoRoot) || !isInside(dest, wtRoot)) {
        ctx.log('copyIgnoredFiles skipped traversal', { rel })
        continue
      }
      if (!existsSync(src)) continue
      try {
        await mkdir(dirname(dest), { recursive: true })
        await cp(src, dest, { recursive: true })
        copied += 1
      } catch (err) {
        ctx.log('copyIgnoredFiles copy failed', { rel, error: String(err) })
      }
    }
    return { copied }
  }

  return {
    [GitMethods.isGitRepo]: isGitRepo,
    [GitMethods.getCurrentBranch]: getCurrentBranch,
    [GitMethods.createWorktree]: createWorktree,
    [GitMethods.removeWorktree]: removeWorktree,
    [GitMethods.runWorktreeSetupScript]: runWorktreeSetupScript,
    [GitMethods.copyIgnoredFiles]: copyIgnoredFiles
  }
}

/** True when `child` is `root` itself or nested under it. */
function isInside(child: string, root: string): boolean {
  const c = resolve(child)
  return c === root || c.startsWith(root + sep)
}
