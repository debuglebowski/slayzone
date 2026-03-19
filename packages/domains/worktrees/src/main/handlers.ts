import type { IpcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import { recordDiagnosticEvent } from '@slayzone/diagnostics/main'
import {
  isGitRepo,
  detectWorktrees,
  createWorktree,
  removeWorktree,
  runWorktreeSetupScript,
  initRepo,
  getCurrentBranch,
  listBranches,
  checkoutBranch,
  createBranch,
  hasUncommittedChanges,
  mergeIntoParent,
  abortMerge,
  startMergeNoCommit,
  isMergeInProgress,
  getConflictedFiles,
  getConflictContent,
  writeResolvedFile,
  commitFiles,
  getWorkingDiff,
  stageFile,
  unstageFile,
  discardFile,
  stageAll,
  unstageAll,
  getFileDiff,
  getUntrackedFileDiff,
  isRebaseInProgress,
  getRebaseProgress,
  abortRebase,
  continueRebase,
  skipRebaseCommit,
  getMergeContext,
  getRecentCommits,
  getAheadBehind,
  getAheadBehindUpstream,
  getStatusSummary,
  getRemoteUrl,
  gitFetch,
  gitPush,
  gitPull,
  getDefaultBranch,
  listBranchesDetailed,
  listRemoteBranches,
  getMergeBase,
  getCommitsSince,
  getCommitsBeforeRef,
  deleteBranch,
  pruneRemote,
  rebaseOnto,
  mergeFrom,
  getDiffStats,
  getWorktreeMetadata,
  getCommitDag,
  resolveChildBranches,
  copyIgnoredFiles,
  getIgnoredFileTree,
  getResolvedCommitDag,
  getResolvedForkGraph,
  getResolvedUpstreamGraph,
  getResolvedRecentCommits
} from './git-worktree'
import { runAiCommand } from './merge-ai'
import {
  checkGhInstalled,
  hasGithubRemote,
  listOpenPrs,
  getPrByUrl,
  createPr,
  getPrComments,
  addPrComment,
  mergePr,
  getPrDiff,
  getGhUser,
  editPrComment
} from './gh-cli'
import type { CreateWorktreeOpts, MergeWithAIResult, ConflictAnalysis, CreatePrInput, MergePrInput, EditPrCommentInput } from '../shared/types'

import { readdir, stat as fsStat } from 'fs/promises'
import path from 'path'
import type { WorktreeCopyBehavior } from '@slayzone/projects/shared'

// Cache for detectChildRepos — avoids repeated readdir + git rev-parse on every tab switch
const CHILD_REPO_CACHE_MAX = 50
const childRepoCache = new Map<string, { repos: { name: string; path: string }[]; timestamp: number }>()
const CHILD_REPO_CACHE_TTL = 30_000 // 30s

function evictStaleRepoCache(): void {
  if (childRepoCache.size <= CHILD_REPO_CACHE_MAX) return
  const now = Date.now()
  for (const [key, entry] of childRepoCache) {
    if (now - entry.timestamp > CHILD_REPO_CACHE_TTL) childRepoCache.delete(key)
  }
  // If still over limit, drop oldest entries
  if (childRepoCache.size > CHILD_REPO_CACHE_MAX) {
    const sorted = [...childRepoCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)
    for (let i = 0; i < sorted.length - CHILD_REPO_CACHE_MAX; i++) {
      childRepoCache.delete(sorted[i][0])
    }
  }
}

export function resolveCopyBehavior(db: Database, projectId?: string): { behavior: WorktreeCopyBehavior; customPaths: string[] } {
  // Check project-level override first (null = inherit from global)
  if (projectId) {
    const row = db.prepare('SELECT worktree_copy_behavior, worktree_copy_paths FROM projects WHERE id = ?')
      .get(projectId) as { worktree_copy_behavior: string | null; worktree_copy_paths: string | null } | undefined
    if (row?.worktree_copy_behavior) {
      const behavior = row.worktree_copy_behavior as WorktreeCopyBehavior
      const customPaths = behavior === 'custom' && row.worktree_copy_paths
        ? row.worktree_copy_paths.split(',').map(p => p.trim()).filter(Boolean)
        : []
      return { behavior, customPaths }
    }
  }

  // Fall back to global setting
  const settingRow = db.prepare("SELECT value FROM settings WHERE key = 'worktree_copy_behavior'")
    .get() as { value: string } | undefined
  const behavior = (settingRow?.value as WorktreeCopyBehavior) || 'ask'
  let customPaths: string[] = []
  if (behavior === 'custom') {
    const pathsRow = db.prepare("SELECT value FROM settings WHERE key = 'worktree_copy_paths'")
      .get() as { value: string } | undefined
    customPaths = pathsRow?.value ? pathsRow.value.split(',').map(p => p.trim()).filter(Boolean) : []
  }

  return { behavior, customPaths }
}

export function registerWorktreeHandlers(ipcMain: IpcMain, db: Database): void {
  // Git operations
  ipcMain.handle('git:isGitRepo', (_, p: string) => {
    return isGitRepo(p)
  })

  const pendingDetections = new Map<string, Promise<{ name: string; path: string }[]>>()

  ipcMain.handle('git:detectChildRepos', (_, projectPath: string) => {
    // Return cached result if fresh
    const cached = childRepoCache.get(projectPath)
    if (cached && Date.now() - cached.timestamp < CHILD_REPO_CACHE_TTL) {
      return cached.repos
    }

    // Deduplicate concurrent calls for the same path
    const pending = pendingDetections.get(projectPath)
    if (pending) return pending

    const detection = (async () => {
      // If root is itself a git repo, no multi-repo mode
      if (await isGitRepo(projectPath)) {
        childRepoCache.set(projectPath, { repos: [], timestamp: Date.now() })
        return []
      }

      try {
        const entries = await readdir(projectPath)
        const repos: { name: string; path: string }[] = []

        await Promise.all(entries.map(async (entry) => {
          const fullPath = path.join(projectPath, entry)
          try {
            const s = await fsStat(fullPath)
            if (s.isDirectory() && await isGitRepo(fullPath)) {
              repos.push({ name: entry, path: fullPath })
            }
          } catch {
            // Skip inaccessible entries
          }
        }))

        repos.sort((a, b) => a.name.localeCompare(b.name))
        childRepoCache.set(projectPath, { repos, timestamp: Date.now() })
        evictStaleRepoCache()
        return repos
      } catch {
        return []
      }
    })()

    pendingDetections.set(projectPath, detection)
    detection.finally(() => pendingDetections.delete(projectPath))
    return detection
  })

  ipcMain.handle('git:detectWorktrees', (_, repoPath: string) => {
    return detectWorktrees(repoPath)
  })

  ipcMain.handle('git:createWorktree', async (_, opts: CreateWorktreeOpts) => {
    const { repoPath, targetPath, branch, sourceBranch, projectId } = opts
    await createWorktree(repoPath, targetPath, branch, sourceBranch)

    // Copy ignored files based on settings ('ask' is handled client-side)
    const { behavior, customPaths } = resolveCopyBehavior(db, projectId)
    if (behavior === 'all' || behavior === 'custom') {
      await copyIgnoredFiles(repoPath, targetPath, behavior, customPaths)
    }

    const setupResult = await runWorktreeSetupScript(targetPath, repoPath, sourceBranch)
    return { setupResult }
  })

  ipcMain.handle('git:removeWorktree', (_, repoPath: string, worktreePath: string, branchToDelete?: string) => {
    return removeWorktree(repoPath, worktreePath, branchToDelete)
  })

  ipcMain.handle('git:init', (_, path: string) => {
    return initRepo(path)
  })

  ipcMain.handle('git:getCurrentBranch', (_, path: string) => {
    return getCurrentBranch(path)
  })

  ipcMain.handle('git:listBranches', (_, path: string) => {
    return listBranches(path)
  })

  ipcMain.handle('git:checkoutBranch', (_, path: string, branch: string) => {
    return checkoutBranch(path, branch)
  })

  ipcMain.handle('git:createBranch', (_, path: string, branch: string) => {
    return createBranch(path, branch)
  })

  ipcMain.handle('git:hasUncommittedChanges', (_, path: string) => {
    return hasUncommittedChanges(path)
  })

  ipcMain.handle('git:mergeIntoParent', (_, projectPath: string, parentBranch: string, sourceBranch: string) => {
    return mergeIntoParent(projectPath, parentBranch, sourceBranch)
  })

  ipcMain.handle('git:abortMerge', (_, path: string) => {
    return abortMerge(path)
  })

  ipcMain.handle(
    'git:mergeWithAI',
    async (_, projectPath: string, worktreePath: string, parentBranch: string, sourceBranch: string): Promise<MergeWithAIResult> => {
      try {
        // Check for uncommitted changes in worktree
        const hasChanges = await hasUncommittedChanges(worktreePath)

        // Start merge
        const result = await startMergeNoCommit(projectPath, parentBranch, sourceBranch)

        // If clean merge and no uncommitted changes, we're done
        if (result.clean && !hasChanges) {
          return { success: true }
        }

        // Build dynamic prompt based on what needs to be done
        const steps: string[] = []

        if (hasChanges) {
          steps.push(`Step 1: Commit uncommitted changes in this worktree
- git add -A
- git commit -m "WIP: changes before merge"`)
        }

        if (result.conflictedFiles.length > 0) {
          const stepNum = hasChanges ? 2 : 1
          steps.push(`Step ${stepNum}: Resolve merge conflicts in ${projectPath}
Conflicted files:
${result.conflictedFiles.map(f => `- ${f}`).join('\n')}

- cd "${projectPath}"
- Read each conflicted file
- Resolve conflicts (prefer source branch when unclear)
- git add <resolved files>
- git commit -m "Merge ${sourceBranch} into ${parentBranch}"`)
        } else if (hasChanges) {
          // No conflicts but has uncommitted changes - after committing, merge should work
          steps.push(`Step 2: Complete the merge
- cd "${projectPath}"
- git merge "${sourceBranch}" --no-ff
- If conflicts occur, resolve them`)
        }

        const prompt = `Complete this merge: "${sourceBranch}" → "${parentBranch}"

${steps.join('\n\n')}`

        return {
          resolving: true,
          conflictedFiles: result.conflictedFiles,
          prompt
        }
      } catch (err) {
        recordDiagnosticEvent({
          level: 'error',
          source: 'git',
          event: 'git.merge_with_ai_failed',
          message: err instanceof Error ? err.message : String(err),
          payload: {
            projectPath,
            worktreePath,
            parentBranch,
            sourceBranch
          }
        })
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle('git:isMergeInProgress', (_, path: string) => {
    return isMergeInProgress(path)
  })

  ipcMain.handle('git:getConflictedFiles', (_, path: string) => {
    return getConflictedFiles(path)
  })

  ipcMain.handle('git:getWorkingDiff', (_, path: string, opts?: { contextLines?: string; ignoreWhitespace?: boolean }) => {
    return getWorkingDiff(path, opts)
  })

  ipcMain.handle('git:stageFile', (_, path: string, filePath: string) => {
    return stageFile(path, filePath)
  })

  ipcMain.handle('git:unstageFile', (_, path: string, filePath: string) => {
    return unstageFile(path, filePath)
  })

  ipcMain.handle('git:discardFile', (_, path: string, filePath: string, untracked?: boolean) => {
    return discardFile(path, filePath, untracked)
  })

  ipcMain.handle('git:stageAll', (_, path: string) => {
    return stageAll(path)
  })

  ipcMain.handle('git:unstageAll', (_, path: string) => {
    return unstageAll(path)
  })

  ipcMain.handle('git:getFileDiff', (_, repoPath: string, filePath: string, staged: boolean, opts?: { contextLines?: string; ignoreWhitespace?: boolean }) => {
    return getFileDiff(repoPath, filePath, staged, opts)
  })

  ipcMain.handle('git:getUntrackedFileDiff', (_, repoPath: string, filePath: string) => {
    return getUntrackedFileDiff(repoPath, filePath)
  })

  ipcMain.handle('git:getConflictContent', (_, repoPath: string, filePath: string) => {
    return getConflictContent(repoPath, filePath)
  })

  ipcMain.handle('git:writeResolvedFile', (_, repoPath: string, filePath: string, content: string) => {
    writeResolvedFile(repoPath, filePath, content)
  })

  ipcMain.handle('git:commitFiles', (_, repoPath: string, message: string) => {
    return commitFiles(repoPath, message)
  })

  ipcMain.handle(
    'git:analyzeConflict',
    async (_, mode: string, filePath: string, base: string | null, ours: string | null, theirs: string | null): Promise<ConflictAnalysis> => {
      const prompt = `Analyze this merge conflict for file "${filePath}".

BASE (common ancestor):
\`\`\`
${base ?? '(file did not exist)'}
\`\`\`

OURS (current branch):
\`\`\`
${ours ?? '(file did not exist)'}
\`\`\`

THEIRS (incoming branch):
\`\`\`
${theirs ?? '(file did not exist)'}
\`\`\`

Respond in this exact format (no extra text):
SUMMARY: <2-3 sentences explaining what each branch changed and why they conflict>
---RESOLUTION---
<the complete resolved file content, picking the best combination of both sides>`

      const result = await runAiCommand(mode as 'claude-code' | 'codex', prompt)

      // Parse the structured response
      const sepIdx = result.indexOf('---RESOLUTION---')
      if (sepIdx === -1) {
        return { summary: result, suggestion: '' }
      }
      const summary = result.slice(0, sepIdx).replace(/^SUMMARY:\s*/i, '').trim()
      const suggestion = result.slice(sepIdx + '---RESOLUTION---'.length).trim()
      return { summary, suggestion }
    }
  )

  // Rebase operations
  ipcMain.handle('git:isRebaseInProgress', (_, path: string) => {
    return isRebaseInProgress(path)
  })

  ipcMain.handle('git:getRebaseProgress', (_, repoPath: string) => {
    return getRebaseProgress(repoPath)
  })

  ipcMain.handle('git:abortRebase', (_, path: string) => {
    return abortRebase(path)
  })

  ipcMain.handle('git:continueRebase', (_, path: string) => {
    return continueRebase(path)
  })

  ipcMain.handle('git:skipRebaseCommit', (_, path: string) => {
    return skipRebaseCommit(path)
  })

  ipcMain.handle('git:getMergeContext', (_, repoPath: string) => {
    return getMergeContext(repoPath)
  })

  ipcMain.handle('git:getRecentCommits', (_, repoPath: string, count?: number) => {
    return getRecentCommits(repoPath, count)
  })

  ipcMain.handle('git:getAheadBehind', (_, repoPath: string, branch: string, upstream: string) => {
    return getAheadBehind(repoPath, branch, upstream)
  })

  ipcMain.handle('git:getStatusSummary', (_, repoPath: string) => {
    return getStatusSummary(repoPath)
  })

  ipcMain.handle('git:revealInFinder', (_, path: string) => {
    const { shell } = require('electron')
    shell.openPath(path)
  })

  ipcMain.handle('git:isDirty', async (_, path: string) => {
    const summary = await getStatusSummary(path)
    return (summary.staged + summary.unstaged + summary.untracked) > 0
  })

  ipcMain.handle('git:getRemoteUrl', (_, path: string) => {
    return getRemoteUrl(path)
  })

  ipcMain.handle('git:getAheadBehindUpstream', (_, path: string, branch: string) => {
    return getAheadBehindUpstream(path, branch)
  })

  ipcMain.handle('git:fetch', (_, path: string) => {
    return gitFetch(path)
  })

  ipcMain.handle('git:push', (_, path: string, branch?: string, force?: boolean) => {
    return gitPush(path, branch, force)
  })

  ipcMain.handle('git:pull', (_, path: string) => {
    return gitPull(path)
  })

  // Branch tab operations
  ipcMain.handle('git:getDefaultBranch', (_, path: string) => {
    return getDefaultBranch(path)
  })

  ipcMain.handle('git:listBranchesDetailed', (_, path: string) => {
    return listBranchesDetailed(path)
  })

  ipcMain.handle('git:listRemoteBranches', (_, path: string) => {
    return listRemoteBranches(path)
  })

  ipcMain.handle('git:getMergeBase', (_, path: string, branch1: string, branch2: string) => {
    return getMergeBase(path, branch1, branch2)
  })

  ipcMain.handle('git:getCommitsSince', (_, path: string, sinceRef: string, branch: string) => {
    return getCommitsSince(path, sinceRef, branch)
  })

  ipcMain.handle('git:getCommitsBeforeRef', (_, path: string, ref: string, count?: number) => {
    return getCommitsBeforeRef(path, ref, count)
  })

  ipcMain.handle('git:deleteBranch', (_, path: string, branch: string, force?: boolean) => {
    return deleteBranch(path, branch, force)
  })

  ipcMain.handle('git:pruneRemote', (_, path: string) => {
    return pruneRemote(path)
  })

  // Worktree tab operations
  ipcMain.handle('git:rebaseOnto', (_, path: string, ontoBranch: string) => {
    return rebaseOnto(path, ontoBranch)
  })

  ipcMain.handle('git:mergeFrom', (_, path: string, branch: string) => {
    return mergeFrom(path, branch)
  })

  ipcMain.handle('git:getDiffStats', (_, path: string, ref: string) => {
    return getDiffStats(path, ref)
  })

  ipcMain.handle('git:getWorktreeMetadata', (_, path: string) => {
    return getWorktreeMetadata(path)
  })

  ipcMain.handle('git:getCommitDag', (_, path: string, limit: number, branches?: string[]) => {
    return getCommitDag(path, limit, branches)
  })

  ipcMain.handle('git:resolveChildBranches', (_, path: string, baseBranch: string) => {
    return resolveChildBranches(path, baseBranch)
  })

  ipcMain.handle('git:resolveCopyBehavior', (_, projectId?: string) => {
    return resolveCopyBehavior(db, projectId)
  })

  ipcMain.handle('git:getIgnoredFileTree', (_, repoPath: string) => {
    return getIgnoredFileTree(repoPath)
  })

  ipcMain.handle('git:copyIgnoredFiles', (_, repoPath: string, worktreePath: string, paths: string[], mode?: 'all' | 'custom') => {
    return copyIgnoredFiles(repoPath, worktreePath, mode ?? (paths.length > 0 ? 'custom' : 'all'), paths)
  })

  ipcMain.handle('git:getResolvedCommitDag', (_, path: string, limit: number, branches: string[] | undefined, baseBranch: string) => {
    return getResolvedCommitDag(path, limit, branches, baseBranch)
  })

  ipcMain.handle('git:getResolvedForkGraph', (_, targetPath: string, repoPath: string, activeBranch: string, compareBranch: string, activeBranchLabel: string, compareBranchLabel: string) => {
    return getResolvedForkGraph(targetPath, repoPath, activeBranch, compareBranch, activeBranchLabel, compareBranchLabel)
  })

  ipcMain.handle('git:getResolvedUpstreamGraph', (_, repoPath: string, branch: string) => {
    return getResolvedUpstreamGraph(repoPath, branch)
  })

  ipcMain.handle('git:getResolvedRecentCommits', (_, path: string, count: number, branchName: string) => {
    return getResolvedRecentCommits(path, count, branchName)
  })

  // GitHub CLI (gh) operations
  ipcMain.handle('git:checkGhInstalled', () => {
    return checkGhInstalled()
  })

  ipcMain.handle('git:hasGithubRemote', (_, repoPath: string) => {
    return hasGithubRemote(repoPath)
  })

  ipcMain.handle('git:listOpenPrs', (_, repoPath: string) => {
    return listOpenPrs(repoPath)
  })

  ipcMain.handle('git:getPrByUrl', (_, repoPath: string, url: string) => {
    return getPrByUrl(repoPath, url)
  })

  ipcMain.handle('git:createPr', (_, input: CreatePrInput) => {
    return createPr(input)
  })

  ipcMain.handle('git:getPrComments', (_, repoPath: string, prNumber: number) => {
    return getPrComments(repoPath, prNumber)
  })

  ipcMain.handle('git:addPrComment', (_, repoPath: string, prNumber: number, body: string) => {
    return addPrComment(repoPath, prNumber, body)
  })

  ipcMain.handle('git:mergePr', (_, input: MergePrInput) => {
    return mergePr(input)
  })

  ipcMain.handle('git:getPrDiff', (_, repoPath: string, prNumber: number) => {
    return getPrDiff(repoPath, prNumber)
  })

  ipcMain.handle('git:getGhUser', (_, repoPath: string) => {
    return getGhUser(repoPath)
  })

  ipcMain.handle('git:editPrComment', (_, input: EditPrCommentInput) => {
    return editPrComment(input)
  })
}
