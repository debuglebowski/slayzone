import { execSync, spawnSync, spawn } from 'child_process'
import { platform } from 'os'
import { existsSync, readFileSync, writeFileSync, chmodSync, constants as fsConstants, accessSync } from 'fs'
import path from 'path'
import { recordDiagnosticEvent } from '@slayzone/diagnostics/main'
import type { ConflictFileContent, DetectedWorktree, GitDiffSnapshot, MergeResult, RebaseProgress, RebaseCommitInfo, CommitInfo, AheadBehind, StatusSummary } from '../shared/types'
import type { MergeContext } from '@slayzone/task/shared'

function trimOutput(value: unknown, maxLength = 1200): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!normalized) return null
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength)}...[trimmed:${normalized.length - maxLength}]`
}

function extractExecErrorDetails(error: unknown): {
  message: string
  exitCode: number | null
  stderr: string | null
  stdout: string | null
} {
  const raw = error as {
    message?: string
    status?: number
    stderr?: unknown
    stdout?: unknown
  }

  const stderr = Buffer.isBuffer(raw.stderr)
    ? trimOutput(raw.stderr.toString('utf8'))
    : trimOutput(raw.stderr)
  const stdout = Buffer.isBuffer(raw.stdout)
    ? trimOutput(raw.stdout.toString('utf8'))
    : trimOutput(raw.stdout)

  return {
    message: raw.message ?? String(error),
    exitCode: typeof raw.status === 'number' ? raw.status : null,
    stderr,
    stdout
  }
}

function execGit(command: string, options: Parameters<typeof execSync>[1] & { cwd: string }): string | Buffer {
  const startedAt = Date.now()
  try {
    const result = execSync(command, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options
    })
    recordDiagnosticEvent({
      level: 'info',
      source: 'git',
      event: 'git.command',
      message: command,
      payload: {
        command,
        cwd: options.cwd,
        durationMs: Date.now() - startedAt,
        success: true
      }
    })
    return result
  } catch (error) {
    const details = extractExecErrorDetails(error)
    recordDiagnosticEvent({
      level: 'error',
      source: 'git',
      event: 'git.command_failed',
      message: details.message,
      payload: {
        command,
        cwd: options.cwd,
        durationMs: Date.now() - startedAt,
        success: false,
        exitCode: details.exitCode,
        stderr: details.stderr,
        stdout: details.stdout
      }
    })
    // Strip "Command failed: git ..." prefix, keep only stderr
    if (error instanceof Error) {
      const stderr = (error as { stderr?: Buffer | string }).stderr?.toString().trim()
      if (stderr) error.message = stderr
    }
    throw error
  }
}

/** Safe git execution with argument array — prevents shell injection */
function spawnGit(args: string[], options: { cwd: string }): string {
  const startedAt = Date.now()
  const command = `git ${args.join(' ')}`
  const result = spawnSync('git', args, {
    cwd: options.cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    const error = new Error(result.stderr?.trim() || `git command failed: ${command}`) as Error & {
      status: number | null; stderr: string; stdout: string
    }
    error.status = result.status
    error.stderr = result.stderr ?? ''
    error.stdout = result.stdout ?? ''
    recordDiagnosticEvent({
      level: 'error',
      source: 'git',
      event: 'git.command_failed',
      message: error.message,
      payload: {
        command,
        cwd: options.cwd,
        durationMs: Date.now() - startedAt,
        success: false,
        exitCode: result.status,
        stderr: trimOutput(result.stderr),
        stdout: trimOutput(result.stdout)
      }
    })
    throw error
  }
  recordDiagnosticEvent({
    level: 'info',
    source: 'git',
    event: 'git.command',
    message: command,
    payload: {
      command,
      cwd: options.cwd,
      durationMs: Date.now() - startedAt,
      success: true
    }
  })
  return result.stdout
}

export function isGitRepo(path: string): boolean {
  try {
    execGit('git rev-parse --git-dir', { cwd: path })
    return true
  } catch {
    return false
  }
}

export function detectWorktrees(repoPath: string): DetectedWorktree[] {
  try {
    const output = execGit('git worktree list --porcelain', {
      cwd: repoPath,
      encoding: 'utf-8'
    }) as string

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

export function createWorktree(repoPath: string, targetPath: string, branch?: string, sourceBranch?: string): void {
  const args = ['worktree', 'add', targetPath]
  if (branch) args.push('-b', branch)
  if (sourceBranch) args.push(sourceBranch)
  spawnGit(args, { cwd: repoPath })
}

function getWorktreeBranchFromRepo(repoPath: string, worktreePath: string): string | null {
  try {
    const output = execGit('git worktree list --porcelain', {
      cwd: repoPath,
      encoding: 'utf-8'
    }) as string

    const targetPath = resolveWorktreePath(repoPath, worktreePath)
    let currentPath: string | null = null
    let currentBranch: string | null = null

    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        currentPath = path.resolve(line.slice(9))
        currentBranch = null
      } else if (line.startsWith('branch refs/heads/')) {
        currentBranch = line.slice(18)
      } else if (line === '') {
        if (currentPath === targetPath) {
          return currentBranch
        }
        currentPath = null
        currentBranch = null
      }
    }

    if (currentPath === targetPath) {
      return currentBranch
    }

    return null
  } catch {
    return null
  }
}

function resolveWorktreePath(repoPath: string, worktreePath: string): string {
  return path.isAbsolute(worktreePath)
    ? path.resolve(worktreePath)
    : path.resolve(repoPath, worktreePath)
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

export function removeWorktree(repoPath: string, worktreePath: string, branchHint?: string | null): void {
  const resolvedWorktreePath = resolveWorktreePath(repoPath, worktreePath)
  const metadataBranch = getWorktreeBranchFromRepo(repoPath, resolvedWorktreePath)
  const liveBranch = getCurrentBranch(resolvedWorktreePath)
  const branchGuess = path.basename(resolvedWorktreePath)

  const candidateBranches = [metadataBranch, branchHint, liveBranch]
    .map(value => value?.replace(/^refs\/heads\//, '').trim())
    .filter((value): value is string => Boolean(value))

  const allBranches = listBranches(repoPath)
  if (branchGuess && allBranches.includes(branchGuess)) {
    candidateBranches.push(branchGuess)
  }

  spawnGit(['worktree', 'remove', resolvedWorktreePath, '--force'], { cwd: repoPath })

  const repoBranch = getCurrentBranch(repoPath)
  for (const branch of [...new Set(candidateBranches)]) {
    if (repoBranch === branch) continue
    try {
      spawnGit(['branch', '-D', branch], { cwd: repoPath })
      return
    } catch (error) {
      const details = extractExecErrorDetails(error)
      recordDiagnosticEvent({
        level: 'error',
        source: 'git',
        event: 'git.branch_delete_failed',
        message: details.message,
        payload: {
          repoPath,
          worktreePath,
          branch,
          candidates: candidateBranches,
          exitCode: details.exitCode,
          stderr: details.stderr,
          stdout: details.stdout
        }
      })
    }
  }
}

export function initRepo(path: string): void {
  execGit('git init', { cwd: path })
}

export function getCurrentBranch(path: string): string | null {
  try {
    const output = execGit('git branch --show-current', {
      cwd: path,
      encoding: 'utf-8'
    }) as string
    return output.trim() || null
  } catch {
    return null
  }
}

export function listBranches(path: string): string[] {
  try {
    const output = execGit('git branch --list --no-color', {
      cwd: path,
      encoding: 'utf-8'
    }) as string
    return output
      .split('\n')
      .map(line => line.replace(/^(?:[*+]\s+|\s+)/, '').trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

export function checkoutBranch(path: string, branch: string): void {
  spawnGit(['checkout', branch], { cwd: path })
}

export function createBranch(path: string, branch: string): void {
  spawnGit(['checkout', '-b', branch], { cwd: path })
}

export function hasUncommittedChanges(path: string): boolean {
  try {
    // -uno: ignore untracked files — they don't block git merge
    const output = execGit('git status --porcelain -uno', {
      cwd: path,
      encoding: 'utf-8'
    }) as string
    return output.trim().length > 0
  } catch {
    return false
  }
}

export function mergeIntoParent(
  projectPath: string,
  parentBranch: string,
  sourceBranch: string
): MergeResult {
  try {
    // Check if we're on parent branch, if not checkout
    const currentBranch = getCurrentBranch(projectPath)
    if (currentBranch !== parentBranch) {
      spawnGit(['checkout', parentBranch], { cwd: projectPath })
    }

    // Attempt merge
    try {
      spawnGit(['merge', sourceBranch, '--no-ff', '--no-edit'], { cwd: projectPath })
      return { success: true, merged: true, conflicted: false }
    } catch {
      // Check for merge conflicts
      const status = execGit('git status --porcelain', {
        cwd: projectPath,
        encoding: 'utf-8'
      }) as string
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

export function abortMerge(path: string): void {
  execGit('git merge --abort', { cwd: path })
}

export function getConflictedFiles(path: string): string[] {
  try {
    const output = execGit('git diff --name-only --diff-filter=U', {
      cwd: path,
      encoding: 'utf-8'
    }) as string
    return output.trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

export function startMergeNoCommit(
  projectPath: string,
  parentBranch: string,
  sourceBranch: string
): { clean: boolean; conflictedFiles: string[] } {
  // Checkout parent branch
  const currentBranch = getCurrentBranch(projectPath)
  if (currentBranch !== parentBranch) {
    try {
      spawnGit(['checkout', parentBranch], { cwd: projectPath })
    } catch (err) {
      const msg = err instanceof Error && 'stderr' in err ? String((err as { stderr: unknown }).stderr) : String(err)
      throw new Error(`Cannot checkout ${parentBranch}: ${msg.trim()}`)
    }
  }

  // Attempt merge with --no-commit
  try {
    spawnGit(['merge', sourceBranch, '--no-commit', '--no-ff'], { cwd: projectPath })
    // Clean merge - commit it
    execGit(`git commit --no-edit`, { cwd: projectPath })
    return { clean: true, conflictedFiles: [] }
  } catch (err) {
    // Check for conflicts
    const conflictedFiles = getConflictedFiles(projectPath)
    if (conflictedFiles.length > 0) {
      return { clean: false, conflictedFiles }
    }
    // Some other error - include the actual message
    const msg = err instanceof Error && 'stderr' in err ? String((err as { stderr: unknown }).stderr) : String(err)
    throw new Error(`Merge failed: ${msg.trim()}`)
  }
}

export function isMergeInProgress(path: string): boolean {
  try {
    execGit('git rev-parse --verify MERGE_HEAD', { cwd: path })
    return true
  } catch {
    return false
  }
}

export function stageFile(path: string, filePath: string): void {
  spawnGit(['add', '--', filePath], { cwd: path })
}

export function unstageFile(path: string, filePath: string): void {
  spawnGit(['reset', 'HEAD', '--', filePath], { cwd: path })
}

export function discardFile(path: string, filePath: string, untracked?: boolean): void {
  if (untracked) {
    spawnGit(['clean', '-f', '--', filePath], { cwd: path })
  } else {
    spawnGit(['checkout', '--', filePath], { cwd: path })
  }
}

export function stageAll(path: string): void {
  execGit('git add -A', { cwd: path })
}

export function unstageAll(path: string): void {
  execGit('git reset HEAD', { cwd: path })
}

export function getUntrackedFileDiff(repoPath: string, filePath: string): string {
  try {
    const devNull = platform() === 'win32' ? 'NUL' : '/dev/null'
    return spawnGit(['diff', '--no-index', '--no-ext-diff', '--', devNull, filePath], { cwd: repoPath })
  } catch (err: unknown) {
    // git diff --no-index exits with code 1 when files differ — expected
    const e = err as { stdout?: string }
    if (e.stdout) return e.stdout
    throw err
  }
}

export function getWorkingDiff(path: string, opts?: { contextLines?: string; ignoreWhitespace?: boolean }): GitDiffSnapshot {
  try {
    execGit('git rev-parse --git-dir', { cwd: path })
  } catch {
    throw new Error(`Not a git repository: ${path}`)
  }

  // Build extra flags from diff settings
  const extraFlags: string[] = []
  const validContextLines = ['0', '3', '5']
  if (opts?.contextLines && opts.contextLines !== 'all' && validContextLines.includes(opts.contextLines)) {
    extraFlags.push(`-U${opts.contextLines}`)
  }
  if (opts?.ignoreWhitespace) {
    extraFlags.push('-w')
  }
  const extra = extraFlags.length > 0 ? ' ' + extraFlags.join(' ') : ''

  const unstagedFilesRaw = execGit('git diff --name-only', {
    cwd: path,
    encoding: 'utf-8'
  }) as string
  const stagedFilesRaw = execGit('git diff --cached --name-only', {
    cwd: path,
    encoding: 'utf-8'
  }) as string
  const untrackedFilesRaw = execGit('git ls-files --others --exclude-standard', {
    cwd: path,
    encoding: 'utf-8'
  }) as string
  const unstagedPatch = execGit(`git diff --no-ext-diff${extra}`, {
    cwd: path,
    encoding: 'utf-8'
  }) as string
  const stagedPatch = execGit(`git diff --cached --no-ext-diff${extra}`, {
    cwd: path,
    encoding: 'utf-8'
  }) as string

  const unstagedFiles = unstagedFilesRaw.trim().split('\n').filter(Boolean)
  const stagedFiles = stagedFilesRaw.trim().split('\n').filter(Boolean)
  const untrackedFiles = untrackedFilesRaw.trim().split('\n').filter(Boolean)

  return {
    targetPath: path,
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

export function getConflictContent(repoPath: string, filePath: string): ConflictFileContent {
  const gitShow = (stage: string): string | null => {
    try {
      return spawnGit(['show', `${stage}:${filePath}`], { cwd: repoPath })
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

  return {
    path: filePath,
    base: gitShow(':1'),
    ours: gitShow(':2'),
    theirs: gitShow(':3'),
    merged
  }
}

export function writeResolvedFile(repoPath: string, filePath: string, content: string): void {
  writeFileSync(path.join(repoPath, filePath), content, 'utf-8')
}

export function commitFiles(repoPath: string, message: string): void {
  spawnGit(['commit', '-m', message], { cwd: repoPath })
}

// --- General tab operations ---

export function getRecentCommits(repoPath: string, count = 5): CommitInfo[] {
  try {
    const output = execGit(`git log -${count} --format=%H%n%h%n%s%n%an%n%ar`, {
      cwd: repoPath,
      encoding: 'utf-8'
    }) as string
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
  } catch {
    return []
  }
}

export function getAheadBehind(repoPath: string, branch: string, upstream: string): AheadBehind {
  try {
    const output = spawnGit(['rev-list', '--left-right', '--count', `${upstream}...${branch}`], { cwd: repoPath })
    const [behind, ahead] = output.trim().split(/\s+/).map(Number)
    return { ahead: ahead || 0, behind: behind || 0 }
  } catch {
    return { ahead: 0, behind: 0 }
  }
}

export function getStatusSummary(repoPath: string): StatusSummary {
  try {
    const output = execGit('git status --porcelain', {
      cwd: repoPath,
      encoding: 'utf-8'
    }) as string
    const lines = output.trim().split('\n').filter(Boolean)
    let staged = 0, unstaged = 0, untracked = 0
    for (const line of lines) {
      const x = line[0], y = line[1]
      if (x === '?') { untracked++; continue }
      if (x !== ' ' && x !== '?') staged++
      if (y !== ' ' && y !== '?') unstaged++
    }
    return { staged, unstaged, untracked }
  } catch {
    return { staged: 0, unstaged: 0, untracked: 0 }
  }
}

// --- Rebase operations ---

function getGitDir(repoPath: string): string {
  const output = execGit('git rev-parse --git-dir', {
    cwd: repoPath,
    encoding: 'utf-8'
  }) as string
  const dir = output.trim()
  return path.isAbsolute(dir) ? dir : path.join(repoPath, dir)
}

export function isRebaseInProgress(repoPath: string): boolean {
  try {
    const gitDir = getGitDir(repoPath)
    return existsSync(path.join(gitDir, 'rebase-merge')) ||
           existsSync(path.join(gitDir, 'rebase-apply'))
  } catch {
    return false
  }
}

export function getRebaseProgress(repoPath: string): RebaseProgress | null {
  try {
    const gitDir = getGitDir(repoPath)
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

export function abortRebase(repoPath: string): void {
  execGit('git rebase --abort', { cwd: repoPath })
}

export function continueRebase(repoPath: string): { done: boolean; conflictedFiles: string[] } {
  try {
    execGit('git rebase --continue', { cwd: repoPath })
    // Check if rebase is still in progress
    if (isRebaseInProgress(repoPath)) {
      const files = getConflictedFiles(repoPath)
      return { done: false, conflictedFiles: files }
    }
    return { done: true, conflictedFiles: [] }
  } catch {
    const files = getConflictedFiles(repoPath)
    return { done: false, conflictedFiles: files }
  }
}

export function skipRebaseCommit(repoPath: string): { done: boolean; conflictedFiles: string[] } {
  try {
    execGit('git rebase --skip', { cwd: repoPath })
    if (isRebaseInProgress(repoPath)) {
      const files = getConflictedFiles(repoPath)
      return { done: false, conflictedFiles: files }
    }
    return { done: true, conflictedFiles: [] }
  } catch {
    const files = getConflictedFiles(repoPath)
    return { done: false, conflictedFiles: files }
  }
}

export function getMergeContext(repoPath: string): MergeContext | null {
  try {
    const gitDir = getGitDir(repoPath)

    // Check for rebase
    const mergeDir = path.join(gitDir, 'rebase-merge')
    const applyDir = path.join(gitDir, 'rebase-apply')
    if (existsSync(mergeDir) || existsSync(applyDir)) {
      const dir = existsSync(mergeDir) ? mergeDir : applyDir
      // head-name = the branch being rebased (source)
      // onto = the commit being rebased onto (target)
      let sourceBranch = 'unknown'
      let targetBranch = 'unknown'
      try {
        sourceBranch = readFileSync(path.join(dir, 'head-name'), 'utf-8').trim().replace('refs/heads/', '')
      } catch { /* fallback */ }
      try {
        const ontoHash = readFileSync(path.join(dir, 'onto'), 'utf-8').trim()
        // Resolve hash to branch name
        const name = spawnGit(['name-rev', '--name-only', ontoHash], { cwd: repoPath })
        targetBranch = name.trim().replace(/~\d+$/, '')
      } catch { /* fallback */ }
      return { type: 'rebase', sourceBranch, targetBranch }
    }

    // Check for merge
    if (isMergeInProgress(repoPath)) {
      const targetBranch = getCurrentBranch(repoPath) ?? 'unknown'
      let sourceBranch = 'unknown'
      try {
        const name = spawnGit(['name-rev', '--name-only', 'MERGE_HEAD'], { cwd: repoPath })
        sourceBranch = name.trim().replace(/~\d+$/, '')
      } catch { /* fallback */ }
      return { type: 'merge', sourceBranch, targetBranch }
    }

    return null
  } catch {
    return null
  }
}
