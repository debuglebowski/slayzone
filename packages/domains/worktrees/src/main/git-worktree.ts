import { spawnSync, spawn } from 'child_process'
import { platform } from 'os'
import { existsSync, readFileSync, writeFileSync, chmodSync, constants as fsConstants, accessSync, statSync } from 'fs'
import { cp, stat, mkdir } from 'fs/promises'
import path from 'path'
import { recordDiagnosticEvent } from '@slayzone/diagnostics/main'
import type { ConflictFileContent, DetectedWorktree, GitDiffSnapshot, GitSyncResult, MergeResult, RebaseProgress, RebaseCommitInfo, CommitInfo, AheadBehind, StatusSummary, BranchDetail, BranchListResult, DeleteBranchResult, PruneResult, DiffStatsSummary, WorktreeMetadata, RebaseOntoResult, DagCommit, IgnoredFileNode, ResolvedCommit, ResolvedGraph, ForkGraphResult } from '../shared/types'
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

/** OS/editor artifacts that should never be copied to worktrees. */
const ALWAYS_EXCLUDED = new Set(['.DS_Store', 'Thumbs.db', 'Desktop.ini'])
const ALWAYS_EXCLUDED_EXTENSIONS = ['.swp', '.swo']
function isAlwaysExcluded(name: string): boolean {
  if (ALWAYS_EXCLUDED.has(name)) return true
  if (name.endsWith('~')) return true
  return ALWAYS_EXCLUDED_EXTENSIONS.some(ext => name.endsWith(ext))
}

/** Build a tree of all git-ignored files. One git call, grouped server-side. */
export async function getIgnoredFileTree(repoPath: string): Promise<IgnoredFileNode[]> {
  try {
    const output = await execGit(
      ['ls-files', '--others', '--ignored', '--exclude-standard'],
      { cwd: repoPath }
    )
    const allFiles = output.trim().split('\n').filter(Boolean)
      .filter(f => !isAlwaysExcluded(f.split('/').pop()!))
    if (allFiles.length === 0) return []

    // Build nested tree
    const root: IgnoredFileNode = { name: '', path: '', isDirectory: true, size: 0, fileCount: 0, children: [] }

    for (const f of allFiles) {
      const parts = f.split('/')
      let current = root
      for (let i = 0; i < parts.length; i++) {
        const name = parts[i]
        const fullPath = parts.slice(0, i + 1).join('/')
        const isLast = i === parts.length - 1
        let child = current.children.find(c => c.name === name)
        if (!child) {
          child = { name, path: fullPath, isDirectory: !isLast, size: 0, fileCount: 0, children: [] }
          current.children.push(child)
        } else if (!isLast) {
          child.isDirectory = true
        }
        current = child
      }
    }

    // Aggregate fileCount + sort (bottom-up)
    function aggregate(node: IgnoredFileNode): void {
      if (node.children.length === 0) {
        node.fileCount = 1
        return
      }
      node.isDirectory = true
      let count = 0
      for (const child of node.children) {
        aggregate(child)
        count += child.fileCount
      }
      node.fileCount = count
      node.children.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name)
      })
    }
    aggregate(root)

    // Stat only root-level files for size
    for (const child of root.children) {
      if (!child.isDirectory) {
        try { child.size = statSync(path.join(repoPath, child.name)).size } catch { /* skip */ }
      }
    }

    return root.children
  } catch {
    return []
  }
}


function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\0/g, '.*')
  return new RegExp(`^${escaped}$`)
}

async function getIgnoredTopLevelEntries(repoPath: string): Promise<string[] | null> {
  try {
    const output = await execGit(
      ['ls-files', '--others', '--ignored', '--exclude-standard'],
      { cwd: repoPath }
    )
    const allFiles = output.trim().split('\n').filter(Boolean)
    const topLevel = new Set<string>()
    for (const f of allFiles) {
      if (isAlwaysExcluded(f.split('/').pop()!)) continue
      topLevel.add(f.split('/')[0])
    }
    return [...topLevel]
  } catch {
    return null
  }
}

/**
 * Copy ignored files from the source repo into a new worktree.
 * - 'all': copies every git-ignored file (via git ls-files)
 * - 'custom': copies only the specified paths (supports * and ? wildcards)
 */
export async function copyIgnoredFiles(
  repoPath: string,
  worktreePath: string,
  behavior: 'all' | 'custom',
  customPaths: string[]
): Promise<void> {
  let filesToCopy: string[] = []

  if (behavior === 'all') {
    const topLevel = await getIgnoredTopLevelEntries(repoPath)
    if (!topLevel) return
    filesToCopy = topLevel
  } else {
    const hasGlobs = customPaths.some(p => /[*?{[]/.test(p))
    if (hasGlobs) {
      const topLevel = await getIgnoredTopLevelEntries(repoPath)
      if (!topLevel) return
      const matchers = customPaths.map(globToRegex)
      filesToCopy = topLevel.filter(entry => matchers.some(re => re.test(entry)))
    } else {
      filesToCopy = customPaths
    }
  }

  for (const relPath of filesToCopy) {
    const sourcePath = path.resolve(repoPath, relPath)
    const destPath = path.resolve(worktreePath, relPath)

    // Path containment check — prevent traversal
    if (!sourcePath.startsWith(path.resolve(repoPath)) || !destPath.startsWith(path.resolve(worktreePath))) {
      recordDiagnosticEvent({
        level: 'warn',
        source: 'git',
        event: 'worktree.copy_skipped_traversal',
        message: `Skipped "${relPath}" - path escapes repo/worktree root`,
        payload: { repoPath, worktreePath, relPath }
      })
      continue
    }

    if (!existsSync(sourcePath)) continue

    try {
      const destDir = path.dirname(destPath)
      await mkdir(destDir, { recursive: true })

      const stats = await stat(sourcePath)
      await cp(sourcePath, destPath, {
        recursive: stats.isDirectory(),
        force: true
      })
    } catch (err) {
      recordDiagnosticEvent({
        level: 'warn',
        source: 'git',
        event: 'worktree.copy_failed',
        message: `Failed to copy "${relPath}": ${err instanceof Error ? err.message : String(err)}`,
        payload: { repoPath, worktreePath, relPath }
      })
    }
  }

  recordDiagnosticEvent({
    level: 'info',
    source: 'git',
    event: 'worktree.copy_done',
    message: `Copied ${filesToCopy.length} ignored file(s) to worktree`,
    payload: { repoPath, worktreePath, behavior, count: filesToCopy.length }
  })
}

/**
 * Look up the branch associated with a worktree path via `git worktree list --porcelain`.
 * Returns null if not found (e.g. detached HEAD or worktree already removed).
 */
async function getWorktreeBranchForPath(repoPath: string, worktreePath: string): Promise<string | null> {
  try {
    const resolved = path.resolve(repoPath, worktreePath)
    const worktrees = await detectWorktrees(repoPath)
    return worktrees.find(wt => path.resolve(wt.path) === resolved)?.branch ?? null
  } catch {
    return null
  }
}

export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  branchHint?: string
): Promise<{ branchDeleted?: boolean; branchError?: string }> {
  const resolvedPath = path.resolve(repoPath, worktreePath)

  // Only gather branch candidates when caller wants branch deletion.
  // Collect BEFORE removing — metadata disappears after removal.
  const wantsBranchDeletion = branchHint !== undefined
  let metadataBranch: string | null = null
  let liveBranch: string | null = null
  if (wantsBranchDeletion) {
    metadataBranch = await getWorktreeBranchForPath(repoPath, resolvedPath)
    liveBranch = await getCurrentBranch(resolvedPath)
  }

  try {
    await execGit(['worktree', 'remove', resolvedPath, '--force'], { cwd: repoPath })
  } catch (err) {
    if (!existsSync(resolvedPath)) {
      await execGit(['worktree', 'prune'], { cwd: repoPath })
    } else {
      throw err
    }
  }

  if (!wantsBranchDeletion) return {}

  // Build ordered candidate list: metadata (most reliable), caller hint, live branch, path basename
  const candidates = [metadataBranch, branchHint, liveBranch]
    .map(b => b?.replace(/^refs\/heads\//, '').trim())
    .filter((b): b is string => Boolean(b))

  const basename = path.basename(resolvedPath)
  const allBranches = await listBranches(repoPath)
  if (basename && allBranches.includes(basename) && !candidates.includes(basename)) {
    candidates.push(basename)
  }

  const uniqueCandidates = [...new Set(candidates)]
  if (uniqueCandidates.length === 0) return {}

  const repoBranch = await getCurrentBranch(repoPath)
  for (const branch of uniqueCandidates) {
    if (branch === repoBranch) continue
    const result = await deleteBranch(repoPath, branch, true)
    if (result.success) {
      return { branchDeleted: true }
    }
  }

  return { branchDeleted: false, branchError: `Could not delete branch (tried: ${uniqueCandidates.join(', ')})` }
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
      .map(line => line.replace(/^[*+]?\s+/, '').trim())
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

export async function getFileDiff(
  repoPath: string,
  filePath: string,
  staged: boolean,
  opts?: { contextLines?: string; ignoreWhitespace?: boolean }
): Promise<string> {
  const extraFlags: string[] = ['--no-ext-diff']
  if (opts?.contextLines === 'all') {
    extraFlags.push('-U99999')
  } else if (opts?.contextLines && ['0', '3', '5'].includes(opts.contextLines)) {
    extraFlags.push(`-U${opts.contextLines}`)
  }
  if (opts?.ignoreWhitespace) extraFlags.push('-w')

  const diffCmd = staged
    ? ['diff', '--cached', ...extraFlags, '--', filePath]
    : ['diff', ...extraFlags, '--', filePath]

  return execGit(diffCmd, { cwd: repoPath })
}

export async function getWorkingDiff(repoPath: string, opts?: { contextLines?: string; ignoreWhitespace?: boolean }): Promise<GitDiffSnapshot> {
  await execGit(['rev-parse', '--git-dir'], { cwd: repoPath }).catch(() => {
    throw new Error(`Not a git repository: ${repoPath}`)
  })

  // Build extra flags from diff settings
  const extraFlags: string[] = []
  const validContextLines = ['0', '3', '5']
  if (opts?.contextLines === 'all') {
    extraFlags.push('-U99999')
  } else if (opts?.contextLines && validContextLines.includes(opts.contextLines)) {
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

// --- DAG graph operations ---

export async function getCommitDag(repoPath: string, limit: number, branches?: string[]): Promise<DagCommit[]> {
  try {
    const args = ['log', '--topo-order', '--ignore-missing', `-${limit}`, '--decorate=full', '--format=%H%n%h%n%P%n%s%n%an%n%ar%n%D%x00']
    if (branches && branches.length > 0) {
      args.push(...branches)
    } else {
      args.push('--all')
    }
    const output = await execGit(
      args,
      { cwd: repoPath }
    )
    const commits: DagCommit[] = []
    for (const record of output.split('\x00')) {
      const lines = record.trim().split('\n')
      if (lines.length < 6 || !lines[0]) continue
      commits.push({
        hash: lines[0],
        shortHash: lines[1],
        parents: lines[2] ? lines[2].split(' ').filter(Boolean) : [],
        message: lines[3],
        author: lines[4],
        relativeDate: lines[5],
        refs: lines[6] ? lines[6].split(', ').map(r => r.trim()).filter(Boolean) : []
      })
    }
    return commits
  } catch {
    return []
  }
}

export interface ResolvedBranches {
  /** Branches that forked from baseBranch (direct children) */
  children: string[]
  /** Branches already merged into baseBranch */
  merged: string[]
}

export async function resolveChildBranches(repoPath: string, baseBranch: string): Promise<ResolvedBranches> {
  try {
    const [allBranches, mergedOutput] = await Promise.all([
      listBranches(repoPath),
      execGit(['branch', '--merged', baseBranch, '--no-color'], { cwd: repoPath })
    ])

    const mergedBranches = new Set(
      mergedOutput.split('\n').map(l => l.replace(/^[*+]?\s+/, '').trim()).filter(Boolean)
    )

    const otherBranches = allBranches.filter(b => b !== baseBranch)

    // For each non-merged branch, check if baseBranch is its nearest ancestor
    // Use merge-base --is-ancestor to check if baseBranch is in branch's history
    const children: string[] = []
    const results = await Promise.all(
      otherBranches
        .filter(b => !mergedBranches.has(b))
        .map(async (branch) => {
          try {
            // merge-base returns the common ancestor
            const base = await execGit(['merge-base', baseBranch, branch], { cwd: repoPath })
            // Check if the merge-base is the tip of baseBranch (meaning branch forked from baseBranch)
            // or somewhere in baseBranch's history (meaning branch forked from an ancestor of baseBranch)
            const baseTip = await execGit(['rev-parse', baseBranch], { cwd: repoPath })
            // A branch is a "child" if its merge-base with baseBranch is on baseBranch
            // (i.e., baseBranch contains the fork point)
            const isAncestor = await execGit(
              ['merge-base', '--is-ancestor', base.trim(), baseTip.trim()],
              { cwd: repoPath }
            ).then(() => true).catch(() => false)
            return { branch, isChild: isAncestor }
          } catch {
            return { branch, isChild: false }
          }
        })
    )

    for (const { branch, isChild } of results) {
      if (isChild) children.push(branch)
    }

    return {
      children,
      merged: [...mergedBranches].filter(b => b !== baseBranch)
    }
  } catch {
    return { children: [], merged: [] }
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

// ─── Commit graph normalization ─────────────────────────────────

/**
 * Parse a single ref from git's `%D` output with `--decorate=full`.
 * Full paths are unambiguous: refs/heads/ = local, refs/remotes/ = remote, refs/tags/ = tag.
 */
function parseRef(raw: string): { type: 'branch' | 'remote' | 'tag' | 'head'; name: string; isHead: boolean } {
  const trimmed = raw.trim()
  if (trimmed === 'HEAD') return { type: 'head', name: 'HEAD', isHead: true }
  if (trimmed.startsWith('HEAD -> ')) {
    const refPath = trimmed.slice(8) // e.g. 'refs/heads/main'
    const name = refPath.replace(/^refs\/heads\//, '')
    return { type: 'branch', name, isHead: true }
  }
  if (trimmed.startsWith('tag: ')) {
    const refPath = trimmed.slice(5) // e.g. 'refs/tags/v1.0'
    const name = refPath.replace(/^refs\/tags\//, '')
    return { type: 'tag', name, isHead: false }
  }
  if (trimmed.startsWith('refs/remotes/')) {
    const name = trimmed.slice(13) // e.g. 'origin/main'
    return { type: 'remote', name, isHead: false }
  }
  if (trimmed.startsWith('refs/heads/')) {
    const name = trimmed.slice(11) // e.g. 'feature/api-v2'
    return { type: 'branch', name, isHead: false }
  }
  // Fallback for bare names (shouldn't happen with --decorate=full)
  return { type: 'branch', name: trimmed, isHead: false }
}

/**
 * Resolve raw DagCommit[] into a ResolvedGraph with all git-ref semantics pre-processed.
 * Pure function — no git calls. When diverged, `localOnlyHashes` (from `git rev-list`)
 * enables accurate shared-commit detection that the truncated DAG alone can't provide.
 */
export function resolveCommitGraph(commits: DagCommit[], baseBranch: string, requestedBranches?: string[], localOnlyHashes?: Set<string>): ResolvedGraph {
  if (commits.length === 0) return { commits: [], baseBranch, branches: [] }

  // Collect all known local branch names (from refs)
  const localBranchNames = new Set<string>()
  for (const c of commits) {
    for (const raw of c.refs) {
      const parsed = parseRef(raw)
      if (parsed.type === 'branch') localBranchNames.add(parsed.name)
    }
  }

  // Parse refs for each commit
  const commitParsedRefs = new Map<string, { branchRefs: string[]; tags: string[]; isHead: boolean }>()
  for (const c of commits) {
    const branchRefs: string[] = []
    const tags: string[] = []
    let isHead = false
    for (const raw of c.refs) {
      const parsed = parseRef(raw)
      if (parsed.isHead) isHead = true
      if (parsed.type === 'branch') {
        branchRefs.push(parsed.name)
      } else if (parsed.type === 'remote') {
        const parts = parsed.name.split('/')
        const remoteName = parts[0]
        const localName = parts.slice(1).join('/')
        if (localName === 'HEAD') {
          // Skip origin/HEAD — it's not a real branch
        } else if (remoteName !== 'origin') {
          // Skip non-origin remotes (forks) — they clutter the graph
        } else if (!localBranchNames.has(localName)) {
          // No local branch — show as the local name
          branchRefs.push(localName)
        } else {
          // Local exists — show origin/X so user can see remote tip position
          branchRefs.push(`origin/${localName}`)
        }
      } else if (parsed.type === 'tag') {
        tags.push(parsed.name)
      }
    }
    // Deduplicate (multiple remotes can map to same display name)
    const uniqueRefs = [...new Set(branchRefs)]
    // Filter out branch refs not in the requested set (git %D shows ALL refs)
    const filteredRefs = requestedBranches
      ? uniqueRefs.filter(r => requestedBranches.includes(r) || requestedBranches.includes(r.replace(/^origin\//, '')))
      : uniqueRefs
    commitParsedRefs.set(c.hash, { branchRefs: filteredRefs, tags, isHead })
  }

  // --- 3-pass branch ownership ---
  const commitBranchName = new Map<string, string>()

  // Pass 1: map branch-tip commits to their branch name (skip origin/ display refs).
  // Prefer baseBranch when multiple refs point at the same commit.
  for (const c of commits) {
    const parsed = commitParsedRefs.get(c.hash)!
    const localRefs = parsed.branchRefs.filter(r => !r.startsWith('origin/'))
    if (localRefs.length === 0) continue
    const ownerRef = localRefs.includes(baseBranch) ? baseBranch : localRefs[0]
    commitBranchName.set(c.hash, ownerRef)
  }

  // Pass 1b: detect diverged local/remote — promote origin/X to a real branch.
  // For each origin/X display ref where local X exists: check if origin/X's commit
  // is reachable from local X's tip (or vice versa). If neither, they've diverged.
  const localTipHashes = new Map<string, string>()
  for (const c of commits) {
    const parsed = commitParsedRefs.get(c.hash)!
    for (const ref of parsed.branchRefs) {
      if (!ref.startsWith('origin/') && !localTipHashes.has(ref)) {
        localTipHashes.set(ref, c.hash)
      }
    }
  }
  const hashToCommit = new Map<string, DagCommit>()
  for (const c of commits) hashToCommit.set(c.hash, c)
  let originBaseDiverged = false
  for (const c of commits) {
    const parsed = commitParsedRefs.get(c.hash)!
    for (const ref of parsed.branchRefs) {
      if (!ref.startsWith('origin/')) continue
      const localName = ref.slice(7)
      const localTipHash = localTipHashes.get(localName)
      if (!localTipHash) continue
      let localReachesOrigin = false
      let walker: DagCommit | undefined = hashToCommit.get(localTipHash)
      while (walker) {
        if (walker.hash === c.hash) { localReachesOrigin = true; break }
        walker = walker.parents.length > 0 ? hashToCommit.get(walker.parents[0]) : undefined
      }
      let originReachesLocal = false
      walker = hashToCommit.get(c.hash)
      while (walker) {
        if (walker.hash === localTipHash) { originReachesLocal = true; break }
        walker = walker.parents.length > 0 ? hashToCommit.get(walker.parents[0]) : undefined
      }
      if (!localReachesOrigin && !originReachesLocal) {
        commitBranchName.set(c.hash, ref)
        if (localName === baseBranch) originBaseDiverged = true
      } else if (originReachesLocal && !localReachesOrigin) {
        if (!commitBranchName.has(c.hash)) {
          commitBranchName.set(c.hash, localName)
        }
      }
    }
  }

  // Pass 2: for merge commits, extract source branch name for display (mergedFrom).
  // These are NOT real branches — just metadata for the commit row label.
  // mergedFrom commits get their parents overridden to the merge's first parent
  // so they render as a simple bump (merge → side dot → back to main) with no long edges.
  const mergedFromMap = new Map<string, string>()
  const mergedFromParentOverride = new Map<string, string[]>()
  for (const c of commits) {
    if (c.parents.length < 2) continue
    const mergeMatch = c.message.match(/from\s+\S+\/(.+)$/) ?? c.message.match(/Merge branch '([^']+)'/)
    if (!mergeMatch) continue
    // Skip "merge main into feature" — reparenting a main-branch commit breaks the base chain
    if (mergeMatch[1] === baseBranch) continue
    for (let p = 1; p < c.parents.length; p++) {
      const parentHash = c.parents[p]
      if (!commitBranchName.has(parentHash)) {
        mergedFromMap.set(parentHash, mergeMatch[1])
        // mergedFrom commit → merge's first parent (stays on main track)
        mergedFromParentOverride.set(parentHash, [c.parents[0]])
        // merge commit → mergedFrom commit (no bypassing edge)
        mergedFromParentOverride.set(c.hash, [parentHash])
      }
    }
  }

  // Pass 3: propagate branch name down through first-parent chain
  // Base branch gets priority: it skips past other branch tips to claim shared ancestry.
  // When diverged, origin/<baseBranch> acts as the canonical trunk for shared commits.
  const originBaseName = `origin/${baseBranch}`
  for (const c of commits) {
    if (!commitBranchName.has(c.hash)) continue
    const name = commitBranchName.get(c.hash)!
    const isBase = name === baseBranch || (originBaseDiverged && name === originBaseName)
    let current = c
    while (current.parents.length > 0) {
      const parent = hashToCommit.get(current.parents[0])
      if (!parent) break
      const existing = commitBranchName.get(parent.hash)
      if (existing && existing !== name) {
        if (isBase) {
          // Base branch: skip explicit branch tips but keep claiming ancestors
          const parentParsed = commitParsedRefs.get(parent.hash)
          if (parentParsed && parentParsed.branchRefs.length > 0) {
            current = parent
            continue
          }
        } else {
          break
        }
      }
      commitBranchName.set(parent.hash, name)
      current = parent
    }
  }

  // Pass 4: when diverged and localOnlyHashes is available, reclaim shared commits.
  // Any commit owned by baseBranch that is NOT in localOnlyHashes is shared history
  // and should belong to origin/<baseBranch> (the trunk).
  if (originBaseDiverged && localOnlyHashes) {
    for (const c of commits) {
      const owner = commitBranchName.get(c.hash)
      if (owner !== baseBranch && owner !== undefined) continue
      if (localOnlyHashes.has(c.hash)) continue
      commitBranchName.set(c.hash, originBaseName)
    }
  }

  // Collect all unique branch names in priority order (base first)
  const branchOrder: string[] = []
  const branchSeen = new Set<string>()
  if (baseBranch) { branchOrder.push(baseBranch); branchSeen.add(baseBranch) }
  for (const c of commits) {
    const name = commitBranchName.get(c.hash)
    if (name && !branchSeen.has(name)) {
      branchOrder.push(name)
      branchSeen.add(name)
    }
  }

  // Build resolved commits
  const resolved: ResolvedCommit[] = commits.map(c => {
    const parsed = commitParsedRefs.get(c.hash)!
    const commitBranch = commitBranchName.get(c.hash) ?? baseBranch
    return {
      hash: c.hash,
      shortHash: c.shortHash,
      message: c.message,
      author: c.author,
      relativeDate: c.relativeDate,
      parents: mergedFromParentOverride.get(c.hash) ?? c.parents,
      branch: commitBranch,
      branchRefs: parsed.branchRefs,
      tags: parsed.tags,
      isBranchTip: parsed.branchRefs.some(r => !r.startsWith('origin/')) ||
        parsed.branchRefs.some(r => r.startsWith('origin/') && commitBranchName.get(c.hash) === r),
      isHead: parsed.isHead,
      ...(mergedFromMap.has(c.hash) ? { mergedFrom: mergedFromMap.get(c.hash) } : {})
    }
  })

  return { commits: resolved, baseBranch, branches: branchOrder }
}

/**
 * Build a ResolvedGraph from pre-separated fork data.
 * Fork graphs use simple sequential layout — no parent hashes needed.
 */
export function resolveForkGraph(opts: {
  baseBranchCommits: CommitInfo[]
  baseBranchName: string
  featureBranchCommits: CommitInfo[]
  featureBranchName: string
  forkPoint: string
  preForkCommits: CommitInfo[]
}): ResolvedGraph {
  const resolved: ResolvedCommit[] = []
  const baseBranch = opts.baseBranchName
  const featureBranch = opts.featureBranchName

  // Base branch commits
  for (let i = 0; i < opts.baseBranchCommits.length; i++) {
    const c = opts.baseBranchCommits[i]
    resolved.push({
      ...c,
      parents: [],
      branch: baseBranch,
      branchRefs: i === 0 ? [baseBranch] : [],
      tags: [],
      isBranchTip: i === 0,
      isHead: false
    })
  }

  // Feature branch commits
  for (let i = 0; i < opts.featureBranchCommits.length; i++) {
    const c = opts.featureBranchCommits[i]
    resolved.push({
      ...c,
      parents: [],
      branch: featureBranch,
      branchRefs: i === 0 ? [featureBranch] : [],
      tags: [],
      isBranchTip: i === 0,
      isHead: false
    })
  }

  // Fork point
  resolved.push({
    hash: opts.forkPoint,
    shortHash: opts.forkPoint.slice(0, 7),
    message: 'fork point',
    author: '',
    relativeDate: '',
    parents: [],
    branch: baseBranch,
    branchRefs: [],
    tags: [],
    isBranchTip: false,
    isHead: false
  })

  // Pre-fork context commits
  for (const c of opts.preForkCommits) {
    resolved.push({
      ...c,
      parents: [],
      branch: baseBranch,
      branchRefs: [],
      tags: [],
      isBranchTip: false,
      isHead: false
    })
  }

  const branches = opts.featureBranchCommits.length > 0
    ? [baseBranch, featureBranch]
    : [baseBranch]

  return { commits: resolved, baseBranch, branches }
}

/** IPC-ready: fetch DAG + resolve in one call */
export async function getResolvedCommitDag(
  repoPath: string, limit: number, branches: string[] | undefined, baseBranch: string
): Promise<ResolvedGraph> {
  // Include origin/ tracking refs so diverged remote commits appear in the DAG
  const expandedBranches = branches
    ? [...branches, ...branches.map(b => `origin/${b}`)]
    : undefined
  const raw = await getCommitDag(repoPath, limit, expandedBranches)

  // Detect local-only commits: commits on baseBranch that are NOT ancestors of origin/baseBranch.
  // This requires actual git calls — the DAG alone can't determine this with truncated history.
  let localOnlyHashes: Set<string> | undefined
  try {
    const output = await execGit(
      ['rev-list', baseBranch, '--not', `origin/${baseBranch}`],
      { cwd: repoPath }
    )
    localOnlyHashes = new Set(output.trim().split('\n').filter(Boolean))
  } catch { /* no upstream or other error — skip */ }

  return resolveCommitGraph(raw, baseBranch, branches, localOnlyHashes)
}

/** IPC-ready: fetch fork comparison data + resolve in one call */
export async function getResolvedForkGraph(
  targetPath: string,
  repoPath: string,
  activeBranch: string,
  compareBranch: string,
  activeBranchLabel: string,
  compareBranchLabel: string
): Promise<ForkGraphResult | null> {
  const mergeBase = await getMergeBase(repoPath, activeBranch, compareBranch)
  if (!mergeBase) return null

  const [baseCommits, featureCommits, preFork] = await Promise.all([
    getCommitsSince(repoPath, mergeBase, compareBranch),
    getCommitsSince(targetPath, mergeBase, activeBranch),
    getCommitsBeforeRef(repoPath, mergeBase, 3)
  ])

  const graph = resolveForkGraph({
    baseBranchCommits: baseCommits,
    baseBranchName: compareBranchLabel,
    featureBranchCommits: featureCommits,
    featureBranchName: activeBranchLabel,
    forkPoint: mergeBase,
    preForkCommits: preFork
  })

  return {
    graph,
    forkPoint: mergeBase,
    featureCount: featureCommits.length,
    baseCount: baseCommits.length
  }
}

/** IPC-ready: fetch upstream fork graph — resolves @{upstream} server-side */
export async function getResolvedUpstreamGraph(
  repoPath: string,
  branch: string
): Promise<ForkGraphResult | null> {
  const upstreamRef = `${branch}@{upstream}`
  return getResolvedForkGraph(
    repoPath, repoPath, branch, upstreamRef,
    branch, `origin/${branch}`
  )
}

/** IPC-ready: build a simple single-branch ResolvedGraph from recent commits */
export async function getResolvedRecentCommits(
  repoPath: string, count: number, branchName: string
): Promise<ResolvedGraph> {
  const commits = await getRecentCommits(repoPath, count)
  const resolved: ResolvedCommit[] = commits.map((c, i) => ({
    ...c,
    parents: [],
    branch: branchName,
    branchRefs: i === 0 ? [branchName] : [],
    tags: [],
    isBranchTip: i === 0,
    isHead: i === 0
  }))
  return { commits: resolved, baseBranch: branchName, branches: [branchName] }
}
