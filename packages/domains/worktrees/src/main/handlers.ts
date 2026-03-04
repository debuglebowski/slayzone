import type { IpcMain } from 'electron'
import { recordDiagnosticEvent } from '@slayzone/diagnostics/main'
import {
  isGitRepo,
  detectWorktrees,
  createWorktree,
  copyFilesFromMainToWorktree,
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
  getUntrackedFileDiff,
  isRebaseInProgress,
  getRebaseProgress,
  abortRebase,
  continueRebase,
  skipRebaseCommit,
  getMergeContext,
  getRecentCommits,
  getAheadBehind,
  getStatusSummary,
  listIgnoredEnvLikeFiles
} from './git-worktree'
import { runAiCommand } from './merge-ai'
import type { MergeWithAIResult, ConflictAnalysis, WorktreeIncludeFilesOptions, WorktreeIncludeFilesResult } from '../shared/types'

export function registerWorktreeHandlers(ipcMain: IpcMain): void {
  // Git operations
  ipcMain.handle('git:isGitRepo', (_, path: string) => {
    return isGitRepo(path)
  })

  ipcMain.handle('git:detectWorktrees', (_, repoPath: string) => {
    return detectWorktrees(repoPath)
  })

  ipcMain.handle('git:createWorktree', async (
    _,
    repoPath: string,
    targetPath: string,
    branch?: string,
    sourceBranch?: string,
    includeFiles?: WorktreeIncludeFilesOptions
  ) => {
    createWorktree(repoPath, targetPath, branch, sourceBranch)
    const includeResult = includeFiles
      ? copyFilesFromMainToWorktree(repoPath, targetPath, includeFiles)
      : ({ copiedCount: 0, skippedLargeCount: 0, skippedBlockedCount: 0 } satisfies WorktreeIncludeFilesResult)
    const setupResult = await runWorktreeSetupScript(targetPath, repoPath, sourceBranch)
    return { setupResult, includeResult }
  })

  ipcMain.handle('git:removeWorktree', (_, repoPath: string, worktreePath: string) => {
    removeWorktree(repoPath, worktreePath)
  })

  ipcMain.handle('git:init', (_, path: string) => {
    initRepo(path)
  })

  ipcMain.handle('git:getCurrentBranch', (_, path: string) => {
    return getCurrentBranch(path)
  })

  ipcMain.handle('git:listBranches', (_, path: string) => {
    return listBranches(path)
  })

  ipcMain.handle('git:checkoutBranch', (_, path: string, branch: string) => {
    checkoutBranch(path, branch)
  })

  ipcMain.handle('git:createBranch', (_, path: string, branch: string) => {
    createBranch(path, branch)
  })

  ipcMain.handle('git:hasUncommittedChanges', (_, path: string) => {
    return hasUncommittedChanges(path)
  })

  ipcMain.handle('git:mergeIntoParent', (_, projectPath: string, parentBranch: string, sourceBranch: string) => {
    return mergeIntoParent(projectPath, parentBranch, sourceBranch)
  })

  ipcMain.handle('git:abortMerge', (_, path: string) => {
    abortMerge(path)
  })

  ipcMain.handle(
    'git:mergeWithAI',
    (_, projectPath: string, worktreePath: string, parentBranch: string, sourceBranch: string): MergeWithAIResult => {
      try {
        // Check for uncommitted changes in worktree
        const hasChanges = hasUncommittedChanges(worktreePath)

        // Start merge
        const result = startMergeNoCommit(projectPath, parentBranch, sourceBranch)

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
    stageFile(path, filePath)
  })

  ipcMain.handle('git:unstageFile', (_, path: string, filePath: string) => {
    unstageFile(path, filePath)
  })

  ipcMain.handle('git:discardFile', (_, path: string, filePath: string, untracked?: boolean) => {
    discardFile(path, filePath, untracked)
  })

  ipcMain.handle('git:stageAll', (_, path: string) => {
    stageAll(path)
  })

  ipcMain.handle('git:unstageAll', (_, path: string) => {
    unstageAll(path)
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
    commitFiles(repoPath, message)
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
    abortRebase(path)
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

  ipcMain.handle('git:listIgnoredEnvLikeFiles', (_, repoPath: string, limit?: number) => {
    return listIgnoredEnvLikeFiles(repoPath, limit)
  })
}
