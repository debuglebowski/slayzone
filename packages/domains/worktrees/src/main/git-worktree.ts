import { spawnSync, spawn } from 'child_process'
import { platform } from 'os'
import { existsSync, readFileSync, writeFileSync, chmodSync, constants as fsConstants, accessSync } from 'fs'
import path from 'path'
import { recordDiagnosticEvent } from '@slayzone/diagnostics/main'
import type { ConflictFileContent, DetectedWorktree, GitDiffSnapshot, GitSyncResult, MergeResult, RebaseProgress, RebaseCommitInfo, CommitInfo, AheadBehind, StatusSummary, BranchDetail, BranchListResult, DeleteBranchResult, PruneResult, DiffStatsSummary, WorktreeMetadata, RebaseOntoResult } from '../shared/types'
import type { MergeContext } from '@slayzone/task/shared'
import { execAsync, execGit, trimOutput } from './exec-async'

export async function isGitRepo(repoPath: string): Promise<boolean> {
  try {
    await execGit(['rev-parse', '--git-dir'], { cwd: repoPath })
    return true
  } catch {
    return false
  }
}

export async function detectWorktrees(repoPath: string): Promise<DetectedWorktree[]> {
  try {
    const output = await execGit(['worktree', 'list', '--porcelain'], { cwd: repoPath })

    const worktrees: DetectedWorktree[] = []
    let current: Partial<DetectedWorktree> = {}

    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current.path) {
          worktrees.push(current as DetectedWorktree)
        }
        current = { path: line.slice(9), isMain: false }
      } else if (line.startsWith('branch refs/heads/')) {
        current.branch = line.slice(18)
      } else if (line === 'bare') {
        current.isMain = true
      } else if (line === '') {
        // Empty line marks end of worktree entry
        if (current.path) {
          // First worktree is typically the main one
          if (worktrees.length === 0) {
            current.isMain = true
          }
          worktrees.push({
            path: current.path,
            branch: current.branch ?? null,
            isMain: current.isMain ?? false
          })
          current = {}
        }
      }
    }

    // Handle last entry if no trailing newline
    if (current.path) {
      worktrees.push({
        path: current.path,
        branch: current.branch ?? null,
        isMain: current.isMain ?? false
      })
    }

    return worktrees
  } catch {
    return []
  }
}

export interface WorktreeSetupResult {
  ran: boolean
  success?: boolean
  output?: string
}

export async function createWorktree(repoPath: string, targetPath: string, branch?: string, sourceBranch?: string): Promise<void> {
  const args = ['worktree', 'add', targetPath]
  if (branch) args.push('-b', branch)
  if (sourceBranch) args.push(sourceBranch)
  await execGit(args, { cwd: repoPath })
}

const SETUP_SCRIPT = '.slay/worktree-setup.sh'

/** Check if setup script exists and ensure it's executable. Returns script path or null. */
function prepareSetupScript(worktreePath: string): string | null {
  const scriptPath = path.join(worktreePath, SETUP_SCRIPT)
  if (!existsSync(scriptPath)) return null
  try {
    accessSync(scriptPath, fsConstants.X_OK)
  } catch {
    chmodSync(scriptPath, 0o755)
  }
  return scriptPath
}

function setupScriptEnv(worktreePath: string, repoPath: string, sourceBranch?: string | null): Record<string, string> {
  return {
    ...process.env as Record<string, string>,
    WORKTREE_PATH: worktreePath,
    REPO_PATH: repoPath,
    SOURCE_BRANCH: sourceBranch ?? ''
  }
}

/**
 * Run .slay/worktree-setup.sh asynchronously.
 * Calls onData with stdout/stderr chunks for streaming to a terminal.
 * Returns a promise that resolves when the script completes.
 */
export function runWorktreeSetupScript(
  worktreePath: string,
  repoPath: string,
  sourceBranch?: string | null,
  onData?: (chunk: string) => void
): Promise<WorktreeSetupResult> {
  const scriptPath = prepareSetupScript(worktreePath)
  if (!scriptPath) return Promise.resolve({ ran: false })

  const startedAt = Date.now()
  const env = setupScriptEnv(worktreePath, repoPath, sourceBranch)

  return new Promise((resolve) => {
    const child = spawn(scriptPath, [], {
      cwd: worktreePath,
      stdio: ['pipe', 'pipe', 'pipe'],
      env
    })

    const chunks: string[] = []

    const handleData = (data: Buffer) => {
      const text = data.toString()
      chunks.push(text)
      onData?.(text)
    }

    child.stdout?.on('data', handleData)
    child.stderr?.on('data', handleData)

    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
    }, 5 * 60_000) // 5 min timeout

    child.on('close', (code) => {
      clearTimeout(timeout)
      const output = chunks.join('').trim()
      const success = code === 0

      recordDiagnosticEvent({
        level: success ? 'info' : 'error',
        source: 'git',
        event: success ? 'git.worktree_setup_ok' : 'git.worktree_setup_failed',
        message: success ? `Setup script completed in ${Date.now() - startedAt}ms` : `Setup script failed (exit ${code})`,
        payload: {
          worktreePath,
          repoPath,
          scriptPath,
          durationMs: Date.now() - startedAt,
          exitCode: code,
          output: trimOutput(output)
        }
      })

      resolve({ ran: true, success, output })
    })

    child.on('error', (err) => {
      clearTimeout(timeout)
      recordDiagnosticEvent({
        level: 'error',
        source: 'git',
        event: 'git.worktree_setup_failed',
        message: err.message,
        payload: { worktreePath, repoPath, scriptPath }
      })
      resolve({ ran: true, success: false, output: err.message })
    })
  })
}

/**
 * Synchronous version for tests. Same behavior, blocks the process.
 */
export function runWorktreeSetupScriptSync(
  worktreePath: string,
  repoPath: string,
  sourceBranch?: string | null
): WorktreeSetupResult {
  const scriptPath = prepareSetupScript(worktreePath)
  if (!scriptPath) return { ran: false }

  const startedAt = Date.now()
  const env = setupScriptEnv(worktreePath, repoPath, sourceBranch)

  const result = spawnSync(scriptPath, [], {
    cwd: worktreePath,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 60_000,
    env
  })

  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
  const success = result.status === 0

  recordDiagnosticEvent({
    level: success ? 'info' : 'error',
    source: 'git',
    event: success ? 'git.worktree_setup_ok' : 'git.worktree_setup_failed',
    message: success ? `Setup script completed in ${Date.now() - startedAt}ms` : `Setup script failed (exit ${result.status})`,
    payload: {
      worktreePath,
      repoPath,
      scriptPath,
      durationMs: Date.now() - startedAt,
      exitCode: result.status,
      output: trimOutput(output)
    }
  })

  return { ran: true, success, output }
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  try {
    await execGit(['worktree', 'remove', worktreePath, '--force'], { cwd: repoPath })
  } catch (err) {
    if (!existsSync(worktreePath)) {
      await execGit(['worktree', 'prune'], { cwd: repoPath })
      return
    }
    throw err
  }
}

export async function initRepo(repoPath: string): Promise<void> {
  await execGit(['init'], { cwd: repoPath })
}

export async function getCurrentBranch(repoPath: string): Promise<string | null> {
  try {
    const output = await execGit(['branch', '--show-current'], { cwd: repoPath })
    return output.trim() || null
  } catch {
    return null
  }
}

export async function listBranches(repoPath: string): Promise<string[]> {
  try {
    const output = await execGit(['branch', '--list', '--no-color'], { cwd: repoPath })
    return output
      .split('\n')
      .map(line => line.replace(/^\*?\s+/, '').trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

export async function checkoutBranch(repoPath: string, branch: string): Promise<void> {
  await execGit(['checkout', branch], { cwd: repoPath })
}

export async function createBranch(repoPath: string, branch: string): Promise<void> {
  await execGit(['checkout', '-b', branch], { cwd: repoPath })
}

export async function hasUncommittedChanges(repoPath: string): Promise<boolean> {
  try {
    // -uno: ignore untracked files — they don't block git merge
    const output = await execGit(['status', '--porcelain', '-uno'], { cwd: repoPath })
    return output.trim().length > 0
  } catch {
    return false
  }
}

export async function mergeIntoParent(
  projectPath: string,
  parentBranch: string,
  sourceBranch: string
): Promise<MergeResult> {
  try {
    // Check if we're on parent branch, if not checkout
    const currentBranch = await getCurrentBranch(projectPath)
    if (currentBranch !== parentBranch) {
      await execGit(['checkout', parentBranch], { cwd: projectPath })
    }

    // Attempt merge
    try {
      await execGit(['merge', sourceBranch, '--no-ff', '--no-edit'], { cwd: projectPath })
      return { success: true, merged: true, conflicted: false }
    } catch {
      // Check for merge conflicts
      const status = await execGit(['status', '--porcelain'], { cwd: projectPath })
      if (status.includes('UU') || status.includes('AA') || status.includes('DD')) {
        return { success: false, merged: false, conflicted: true, error: 'Merge conflicts detected' }
      }
      throw new Error('Merge failed')
    }
  } catch (err) {
    return {
      success: false,
      merged: false,
      conflicted: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

export async function abortMerge(repoPath: string): Promise<void> {
  await execGit(['merge', '--abort'], { cwd: repoPath })
}

export async function getConflictedFiles(repoPath: string): Promise<string[]> {
  try {
    const output = await execGit(['diff', '--name-only', '--diff-filter=U'], { cwd: repoPath })
    return output.trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

export async function startMergeNoCommit(
  projectPath: string,
  parentBranch: string,
  sourceBranch: string
): Promise<{ clean: boolean; conflictedFiles: string[] }> {
  // Checkout parent branch
  const currentBranch = await getCurrentBranch(projectPath)
  if (currentBranch !== parentBranch) {
    try {
      await execGit(['checkout', parentBranch], { cwd: projectPath })
    } catch (err) {
      const msg = err instanceof Error && 'stderr' in err ? String((err as { stderr: unknown }).stderr) : String(err)
      throw new Error(`Cannot checkout ${parentBranch}: ${msg.trim()}`)
    }
  }

  // Attempt merge with --no-commit
  try {
    await execGit(['merge', sourceBranch, '--no-commit', '--no-ff'], { cwd: projectPath })
    // Clean merge - commit it
    await execGit(['commit', '--no-edit'], { cwd: projectPath })
    return { clean: true, conflictedFiles: [] }
  } catch (err) {
    // Check for conflicts
    const conflictedFiles = await getConflictedFiles(projectPath)
    if (conflictedFiles.length > 0) {
      return { clean: false, conflictedFiles }
    }
    // Some other error - include the actual message
    const msg = err instanceof Error && 'stderr' in err ? String((err as { stderr: unknown }).stderr) : String(err)
    throw new Error(`Merge failed: ${msg.trim()}`)
  }
}

export async function isMergeInProgress(repoPath: string): Promise<boolean> {
  try {
    await execGit(['rev-parse', '--verify', 'MERGE_HEAD'], { cwd: repoPath })
    return true
  } catch {
    return false
  }
}

export async function stageFile(repoPath: string, filePath: string): Promise<void> {
  await execGit(['add', '--', filePath], { cwd: repoPath })
}

export async function unstageFile(repoPath: string, filePath: string): Promise<void> {
  await execGit(['reset', 'HEAD', '--', filePath], { cwd: repoPath })
}

export async function discardFile(repoPath: string, filePath: string, untracked?: boolean): Promise<void> {
  if (untracked) {
    await execGit(['clean', '-f', '--', filePath], { cwd: repoPath })
  } else {
    await execGit(['checkout', '--', filePath], { cwd: repoPath })
  }
}

export async function stageAll(repoPath: string): Promise<void> {
  await execGit(['add', '-A'], { cwd: repoPath })
}

export async function unstageAll(repoPath: string): Promise<void> {
  await execGit(['reset', 'HEAD'], { cwd: repoPath })
}

export async function getUntrackedFileDiff(repoPath: string, filePath: string): Promise<string> {
  try {
    const devNull = platform() === 'win32' ? 'NUL' : '/dev/null'
    return await execGit(['diff', '--no-index', '--no-ext-diff', '--', devNull, filePath], { cwd: repoPath })
  } catch (err: unknown) {
    // git diff --no-index exits with code 1 when files differ — expected
    const e = err as { stdout?: string }
    if (e.stdout) return e.stdout
    throw err
  }
}

export async function getWorkingDiff(repoPath: string, opts?: { contextLines?: string; ignoreWhitespace?: boolean }): Promise<GitDiffSnapshot> {
  await execGit(['rev-parse', '--git-dir'], { cwd: repoPath }).catch(() => {
    throw new Error(`Not a git repository: ${repoPath}`)
  })

  // Build extra flags from diff settings
  const extraFlags: string[] = []
  const validContextLines = ['0', '3', '5']
  if (opts?.contextLines && opts.contextLines !== 'all' && validContextLines.includes(opts.contextLines)) {
    extraFlags.push(`-U${opts.contextLines}`)
  }
  if (opts?.ignoreWhitespace) {
    extraFlags.push('-w')
  }

  // Run independent git queries in parallel
  const [unstagedFilesRaw, stagedFilesRaw, untrackedFilesRaw, unstagedPatch, stagedPatch] = await Promise.all([
    execGit(['diff', '--name-only'], { cwd: repoPath }),
    execGit(['diff', '--cached', '--name-only'], { cwd: repoPath }),
    execGit(['ls-files', '--others', '--exclude-standard'], { cwd: repoPath }),
    execGit(['diff', '--no-ext-diff', ...extraFlags], { cwd: repoPath }),
    execGit(['diff', '--cached', '--no-ext-diff', ...extraFlags], { cwd: repoPath }),
  ])

  const unstagedFiles = unstagedFilesRaw.trim().split('\n').filter(Boolean)
  const stagedFiles = stagedFilesRaw.trim().split('\n').filter(Boolean)
  const untrackedFiles = untrackedFilesRaw.trim().split('\n').filter(Boolean)

  return {
    targetPath: repoPath,
    files: [...new Set([...unstagedFiles, ...stagedFiles, ...untrackedFiles])].sort(),
    stagedFiles: stagedFiles.sort(),
    unstagedFiles: unstagedFiles.sort(),
    untrackedFiles: untrackedFiles.sort(),
    unstagedPatch,
    stagedPatch,
    generatedAt: new Date().toISOString(),
    isGitRepo: true
  }
}

export async function getConflictContent(repoPath: string, filePath: string): Promise<ConflictFileContent> {
  const gitShow = async (stage: string): Promise<string | null> => {
    try {
      return await execGit(['show', `${stage}:${filePath}`], { cwd: repoPath })
    } catch {
      return null
    }
  }

  let merged: string | null = null
  try {
    merged = readFileSync(path.join(repoPath, filePath), 'utf-8')
  } catch {
    // File may have been deleted
  }

  const [base, ours, theirs] = await Promise.all([
    gitShow(':1'),
    gitShow(':2'),
    gitShow(':3'),
  ])

  return { path: filePath, base, ours, theirs, merged }
}

export function writeResolvedFile(repoPath: string, filePath: string, content: string): void {
  writeFileSync(path.join(repoPath, filePath), content, 'utf-8')
}

export async function commitFiles(repoPath: string, message: string): Promise<void> {
  await execGit(['commit', '-m', message], { cwd: repoPath })
}

// --- General tab operations ---

function parseCommitOutput(output: string): CommitInfo[] {
  const lines = output.trim().split('\n')
  const commits: CommitInfo[] = []
  for (let i = 0; i + 4 < lines.length; i += 5) {
    commits.push({
      hash: lines[i],
      shortHash: lines[i + 1],
      message: lines[i + 2],
      author: lines[i + 3],
      relativeDate: lines[i + 4]
    })
  }
  return commits
}

export async function getRecentCommits(repoPath: string, count = 5): Promise<CommitInfo[]> {
  try {
    const output = await execGit(['log', `-${count}`, '--format=%H%n%h%n%s%n%an%n%ar'], { cwd: repoPath })
    return parseCommitOutput(output)
  } catch {
    return []
  }
}

export async function getAheadBehind(repoPath: string, branch: string, upstream: string): Promise<AheadBehind> {
  try {
    const output = await execGit(['rev-list', '--left-right', '--count', `${upstream}...${branch}`], { cwd: repoPath })
    const [behind, ahead] = output.trim().split(/\s+/).map(Number)
    return { ahead: ahead || 0, behind: behind || 0 }
  } catch {
    return { ahead: 0, behind: 0 }
  }
}

function parseStatusOutput(output: string): StatusSummary {
  const lines = output.trim().split('\n').filter(Boolean)
  let staged = 0, unstaged = 0, untracked = 0
  for (const line of lines) {
    const x = line[0], y = line[1]
    if (x === '?') { untracked++; continue }
    if (x !== ' ' && x !== '?') staged++
    if (y !== ' ' && y !== '?') unstaged++
  }
  return { staged, unstaged, untracked }
}

export async function getStatusSummary(repoPath: string): Promise<StatusSummary> {
  try {
    const output = await execGit(['status', '--porcelain'], { cwd: repoPath })
    return parseStatusOutput(output)
  } catch {
    return { staged: 0, unstaged: 0, untracked: 0 }
  }
}

// --- Rebase operations ---

async function getGitDir(repoPath: string): Promise<string> {
  const output = await execGit(['rev-parse', '--git-dir'], { cwd: repoPath })
  const dir = output.trim()
  return path.isAbsolute(dir) ? dir : path.join(repoPath, dir)
}

export async function isRebaseInProgress(repoPath: string): Promise<boolean> {
  try {
    const gitDir = await getGitDir(repoPath)
    return existsSync(path.join(gitDir, 'rebase-merge')) ||
           existsSync(path.join(gitDir, 'rebase-apply'))
  } catch {
    return false
  }
}

export async function getRebaseProgress(repoPath: string): Promise<RebaseProgress | null> {
  try {
    const gitDir = await getGitDir(repoPath)
    const mergeDir = path.join(gitDir, 'rebase-merge')
    const applyDir = path.join(gitDir, 'rebase-apply')
    const dir = existsSync(mergeDir) ? mergeDir : existsSync(applyDir) ? applyDir : null
    if (!dir) return null

    const current = parseInt(readFileSync(path.join(dir, 'msgnum'), 'utf-8').trim(), 10)
    const total = parseInt(readFileSync(path.join(dir, 'end'), 'utf-8').trim(), 10)

    // Parse done file (applied commits)
    const commits: RebaseCommitInfo[] = []
    try {
      const doneContent = readFileSync(path.join(dir, 'done'), 'utf-8').trim()
      for (const line of doneContent.split('\n').filter(Boolean)) {
        const match = line.match(/^(?:pick|reword|edit|squash|fixup|exec|drop)\s+([a-f0-9]+)\s+(.*)/)
        if (match) {
          const idx = commits.length + 1
          commits.push({
            hash: match[1],
            shortHash: match[1].slice(0, 7),
            message: match[2],
            status: idx < current ? 'applied' : 'current'
          })
        }
      }
    } catch { /* no done file yet */ }

    // Parse todo file (pending commits)
    try {
      const todoContent = readFileSync(path.join(dir, 'git-rebase-todo'), 'utf-8').trim()
      for (const line of todoContent.split('\n').filter(Boolean)) {
        if (line.startsWith('#')) continue
        const match = line.match(/^(?:pick|reword|edit|squash|fixup|exec|drop)\s+([a-f0-9]+)\s+(.*)/)
        if (match) {
          commits.push({
            hash: match[1],
            shortHash: match[1].slice(0, 7),
            message: match[2],
            status: 'pending'
          })
        }
      }
    } catch { /* no todo file */ }

    return { current, total, commits }
  } catch {
    return null
  }
}

export async function abortRebase(repoPath: string): Promise<void> {
  await execGit(['rebase', '--abort'], { cwd: repoPath })
}

export async function continueRebase(repoPath: string): Promise<{ done: boolean; conflictedFiles: string[] }> {
  try {
    await execGit(['rebase', '--continue'], { cwd: repoPath })
    // Check if rebase is still in progress
    if (await isRebaseInProgress(repoPath)) {
      const files = await getConflictedFiles(repoPath)
      return { done: false, conflictedFiles: files }
    }
    return { done: true, conflictedFiles: [] }
  } catch {
    const files = await getConflictedFiles(repoPath)
    return { done: false, conflictedFiles: files }
  }
}

export async function skipRebaseCommit(repoPath: string): Promise<{ done: boolean; conflictedFiles: string[] }> {
  try {
    await execGit(['rebase', '--skip'], { cwd: repoPath })
    if (await isRebaseInProgress(repoPath)) {
      const files = await getConflictedFiles(repoPath)
      return { done: false, conflictedFiles: files }
    }
    return { done: true, conflictedFiles: [] }
  } catch {
    const files = await getConflictedFiles(repoPath)
    return { done: false, conflictedFiles: files }
  }
}

export async function getMergeContext(repoPath: string): Promise<MergeContext | null> {
  try {
    const gitDir = await getGitDir(repoPath)

    // Check for rebase
    const mergeDir = path.join(gitDir, 'rebase-merge')
    const applyDir = path.join(gitDir, 'rebase-apply')
    if (existsSync(mergeDir) || existsSync(applyDir)) {
      const dir = existsSync(mergeDir) ? mergeDir : applyDir
      let sourceBranch = 'unknown'
      let targetBranch = 'unknown'
      try {
        sourceBranch = readFileSync(path.join(dir, 'head-name'), 'utf-8').trim().replace('refs/heads/', '')
      } catch { /* fallback */ }
      try {
        const ontoHash = readFileSync(path.join(dir, 'onto'), 'utf-8').trim()
        const name = await execGit(['name-rev', '--name-only', ontoHash], { cwd: repoPath })
        targetBranch = name.trim().replace(/~\d+$/, '')
      } catch { /* fallback */ }
      return { type: 'rebase', sourceBranch, targetBranch }
    }

    // Check for merge
    if (await isMergeInProgress(repoPath)) {
      const targetBranch = (await getCurrentBranch(repoPath)) ?? 'unknown'
      let sourceBranch = 'unknown'
      try {
        const name = await execGit(['name-rev', '--name-only', 'MERGE_HEAD'], { cwd: repoPath })
        sourceBranch = name.trim().replace(/~\d+$/, '')
      } catch { /* fallback */ }
      return { type: 'merge', sourceBranch, targetBranch }
    }

    return null
  } catch {
    return null
  }
}

// --- Remote operations ---

export async function getRemoteUrl(repoPath: string): Promise<string | null> {
  try {
    const output = await execGit(['remote', 'get-url', 'origin'], { cwd: repoPath })
    return output.trim() || null
  } catch {
    return null
  }
}

export async function getAheadBehindUpstream(repoPath: string, branch: string): Promise<AheadBehind | null> {
  try {
    const output = await execGit(['rev-list', '--left-right', '--count', `${branch}...${branch}@{upstream}`], { cwd: repoPath })
    const [ahead, behind] = output.trim().split(/\s+/).map(Number)
    return { ahead: ahead || 0, behind: behind || 0 }
  } catch {
    return null
  }
}

export async function gitFetch(repoPath: string): Promise<void> {
  await execGit(['fetch'], { cwd: repoPath })
}

export async function gitPush(repoPath: string, branch?: string, force?: boolean): Promise<GitSyncResult> {
  try {
    const args = ['push']
    if (force) args.push('--force-with-lease')
    if (branch) args.push('-u', 'origin', branch)
    await execGit(args, { cwd: repoPath })
    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function gitPull(repoPath: string): Promise<GitSyncResult> {
  try {
    await execGit(['pull'], { cwd: repoPath })
    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// --- Branch tab operations ---

export async function getDefaultBranch(repoPath: string, knownBranches?: string[]): Promise<string> {
  try {
    const output = await execGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], { cwd: repoPath })
    return output.trim().replace('refs/remotes/origin/', '')
  } catch {
    // Fallback: check for main/master using provided list (avoids extra spawn)
    const branches = knownBranches ?? await listBranches(repoPath)
    if (branches.includes('main')) return 'main'
    if (branches.includes('master')) return 'master'
    return branches[0] ?? 'main'
  }
}

export async function listBranchesDetailed(repoPath: string): Promise<BranchListResult> {
  try {
    const format = '%(refname:short)%00%(objectname:short)%00%(objectname)%00%(subject)%00%(authorname)%00%(committerdate:relative)%00%(upstream:short)'
    const [output, currentBranch] = await Promise.all([
      execGit(['for-each-ref', '--sort=-committerdate', `--format=${format}`, 'refs/heads/'], { cwd: repoPath }),
      getCurrentBranch(repoPath)
    ])

    const lines = output.trim().split('\n').filter(Boolean)
    const branches: BranchDetail[] = []

    // Parse all branches first
    const parsed = lines.map(line => {
      const [name, shortHash, hash, message, author, relativeDate, upstream] = line.split('\0')
      return { name, shortHash, hash, message, author, relativeDate, upstream: upstream || null }
    })

    // Resolve default branch using already-parsed names (avoids redundant spawn in fallback)
    const defaultBranch = await getDefaultBranch(repoPath, parsed.map(b => b.name))

    // Batch ahead/behind computations (cap at 10 to limit spawned processes)
    const toCompute = parsed.slice(0, 10)
    const results = await Promise.all(
      toCompute.map(async (b) => {
        const [abUpstream, abDefault] = await Promise.all([
          b.upstream ? getAheadBehindUpstream(repoPath, b.name).catch(() => null) : Promise.resolve(null),
          b.name !== defaultBranch ? getAheadBehind(repoPath, b.name, defaultBranch).catch(() => ({ ahead: 0, behind: 0 })) : Promise.resolve(null)
        ])
        return { abUpstream, abDefault }
      })
    )

    for (let i = 0; i < parsed.length; i++) {
      const b = parsed[i]
      const ab = i < results.length ? results[i] : { abUpstream: null, abDefault: null }
      branches.push({
        name: b.name,
        lastCommit: {
          hash: b.hash,
          shortHash: b.shortHash,
          message: b.message,
          author: b.author,
          relativeDate: b.relativeDate
        },
        upstream: b.upstream,
        aheadBehindUpstream: ab.abUpstream,
        aheadBehindDefault: ab.abDefault,
        isDefault: b.name === defaultBranch,
        isCurrent: b.name === currentBranch
      })
    }

    return { branches, defaultBranch }
  } catch {
    return { branches: [], defaultBranch: 'main' }
  }
}

export async function listRemoteBranches(repoPath: string): Promise<string[]> {
  try {
    const output = await execGit(['branch', '-r', '--list', '--no-color'], { cwd: repoPath })
    return output
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.includes(' -> '))
  } catch {
    return []
  }
}

export async function getMergeBase(repoPath: string, branch1: string, branch2: string): Promise<string | null> {
  try {
    const output = await execGit(['merge-base', branch1, branch2], { cwd: repoPath })
    return output.trim() || null
  } catch {
    return null
  }
}

export async function getCommitsSince(repoPath: string, sinceRef: string, branch: string): Promise<CommitInfo[]> {
  try {
    const output = await execGit(['log', `${sinceRef}..${branch}`, '--format=%H%n%h%n%s%n%an%n%ar'], { cwd: repoPath })
    return parseCommitOutput(output)
  } catch {
    return []
  }
}

export async function getCommitsBeforeRef(repoPath: string, ref: string, count = 3): Promise<CommitInfo[]> {
  try {
    // Use -n + --skip instead of ref~count range — works even when history is shorter than count
    const output = await execGit(['log', ref, '--skip=1', `-${count}`, '--format=%H%n%h%n%s%n%an%n%ar'], { cwd: repoPath })
    return parseCommitOutput(output)
  } catch {
    return []
  }
}

export async function deleteBranch(repoPath: string, branch: string, force?: boolean): Promise<DeleteBranchResult> {
  try {
    await execGit(['branch', force ? '-D' : '-d', branch], { cwd: repoPath })
    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function pruneRemote(repoPath: string): Promise<PruneResult> {
  try {
    const output = await execGit(['remote', 'prune', 'origin'], { cwd: repoPath })
    const pruned = output
      .split('\n')
      .filter(line => line.includes('[pruned]'))
      .map(line => line.replace(/.*\[pruned\]\s*/, '').trim())
    return { pruned }
  } catch {
    return { pruned: [] }
  }
}

// --- Worktree tab operations ---

export async function rebaseOnto(worktreePath: string, ontoBranch: string): Promise<RebaseOntoResult> {
  try {
    await execGit(['rebase', ontoBranch], { cwd: worktreePath })
    return { success: true }
  } catch (err) {
    const inProgress = await isRebaseInProgress(worktreePath)
    if (inProgress) {
      return { success: false, conflicted: true, error: 'Rebase has conflicts — resolve in terminal' }
    }
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function mergeFrom(worktreePath: string, branch: string): Promise<MergeResult> {
  try {
    await execGit(['merge', branch, '--no-edit'], { cwd: worktreePath })
    return { success: true, merged: true, conflicted: false }
  } catch (err) {
    const conflicted = await isMergeInProgress(worktreePath)
    if (conflicted) {
      const files = await getConflictedFiles(worktreePath)
      return { success: false, merged: false, conflicted: true, error: `Conflicts in ${files.length} file(s)` }
    }
    return { success: false, merged: false, conflicted: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function getDiffStats(repoPath: string, ref: string): Promise<DiffStatsSummary> {
  try {
    const output = await execGit(['diff', '--numstat', `${ref}...HEAD`], { cwd: repoPath })
    const lines = output.trim().split('\n').filter(Boolean)
    let filesChanged = 0, insertions = 0, deletions = 0
    for (const line of lines) {
      const [ins, del] = line.split('\t')
      filesChanged++
      if (ins !== '-') insertions += parseInt(ins, 10) || 0
      if (del !== '-') deletions += parseInt(del, 10) || 0
    }
    return { filesChanged, insertions, deletions }
  } catch {
    return { filesChanged: 0, insertions: 0, deletions: 0 }
  }
}

export async function getWorktreeMetadata(worktreePath: string): Promise<WorktreeMetadata> {
  const [diskResult, createdAt] = await Promise.all([
    execAsync('du', ['-sh', worktreePath])
      .then(r => r.stdout.trim().split(/\s+/)[0] || '?')
      .catch(() => '?'),
    // Use first commit date on this branch as proxy for worktree creation
    execGit(['log', '--reverse', '--format=%aI', '-1'], { cwd: worktreePath })
      .then(out => out.trim() || null)
      .catch(() => null)
  ])
  return { path: worktreePath, diskSize: diskResult, createdAt }
}
