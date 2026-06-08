import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { BrowserWindow } from 'electron'
import type { SlayzoneDb } from '@slayzone/platform'
import {
  withResultDedup as withResultDedupBase,
  type SenderLifecycle
} from '@slayzone/platform/ipc'

// Renderer-scoped dedup. Without this, main's cache survives renderer reloads
// while preload's wipes — main returns IPC_UNCHANGED_SENTINEL to a preload
// that has no cached value, leaking `undefined` to callers.
const senderLifecycle: SenderLifecycle<IpcMainInvokeEvent> = {
  getKey: (event) => event.sender.id,
  subscribe: (event, onClear) => {
    event.sender.once('did-start-loading', onClear)
    event.sender.once('destroyed', onClear)
  }
}

function withResultDedup<A extends unknown[], R>(
  handler: (event: IpcMainInvokeEvent, ...args: A) => R | Promise<R>,
  options?: { maxEntries?: number; hashFn?: (result: R) => string }
) {
  return withResultDedupBase(handler, { ...options, sender: senderLifecycle })
}
import { getGitWatcher } from '../server/git-watcher'
import {
  isGitRepo,
  removeWorktree,
  initRepo,
  getCurrentBranch,
  listBranches,
  checkoutBranch,
  createBranch,
  hasUncommittedChanges,
  mergeIntoParent,
  abortMerge,
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
  getResolvedRecentCommits,
  listStashes,
  createStash,
  applyStash,
  popStash,
  dropStash,
  branchFromStash,
  getStashDiff
} from '../server/git-worktree'
import { listProjectRepos } from '../server/list-project-repos'
import {
  detectChildRepos,
  detectWorktreesWithColors,
  resolveCopyBehavior,
  createWorktreeWithSetup,
  mergeWithAI,
  analyzeConflict
} from '../server/composite-ops'
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
} from '../server/gh-cli'
import type {
  CreateWorktreeOpts,
  CreatePrInput,
  MergePrInput,
  EditPrCommentInput,
  CreateWorktreePhase,
  CreateWorktreePhaseEvent,
  ResolvedGraph,
  ForkGraphResult
} from '../shared/types'

/**
 * Module-scope flag so we wire the watcher → IPC broadcast bridge exactly once,
 * even if registerWorktreeHandlers is called twice (it is, during hot reload in
 * dev — the PTY block guards against this with `removeHandler`, but the watcher
 * is a singleton EventEmitter and would otherwise accumulate listeners).
 */
let watcherBridgeAttached = false

function attachWatcherBridge(): void {
  if (watcherBridgeAttached) return
  watcherBridgeAttached = true
  const watcher = getGitWatcher()
  watcher.on('git:diff-changed', (payload) => {
    // Broadcast to all renderer windows — each window's store entries
    // self-filter by worktreePath.
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      try {
        win.webContents.send('git:diff-changed', payload)
      } catch {
        /* window closing — ignore */
      }
    }
  })
  watcher.on('git:diff-watch-failed', (payload) => {
    // Fan out the failure so each renderer can flip `watcherActive = false`
    // for that path and retighten its poll timer. Same broadcast shape as
    // diff-changed — store self-filters by worktreePath.
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      try {
        win.webContents.send('git:diff-watch-failed', payload)
      } catch {
        /* window closing — ignore */
      }
    }
  })
}

export function registerWorktreeHandlers(ipcMain: IpcMain, db: SlayzoneDb): void {
  attachWatcherBridge()

  // Push-update fs watcher for git state (replaces renderer polling).
  // Renderer calls watch-start on mount, watch-stop on unmount. Refcounted
  // per worktreePath in the main process, so multiple windows / panels share
  // one watcher. Throws via IPC on failure → renderer falls back to poll.
  ipcMain.handle('git:watch-start', (_, worktreePath: string): void => {
    getGitWatcher().subscribe(worktreePath)
  })

  ipcMain.handle('git:watch-stop', (_, worktreePath: string): void => {
    getGitWatcher().unsubscribe(worktreePath)
  })

  // Git operations
  ipcMain.handle('git:isGitRepo', (_, p: string) => {
    return isGitRepo(p)
  })

  ipcMain.handle(
    'git:listProjectRepos',
    (_, projectPath: string, opts?: { taskBoundPath?: string | null }) => {
      return listProjectRepos(projectPath, opts ?? {})
    }
  )

  ipcMain.handle('git:detectChildRepos', (_, projectPath: string) =>
    detectChildRepos(projectPath)
  )

  ipcMain.handle(
    'git:detectWorktrees',
    withResultDedup((_, repoPath: string) => detectWorktreesWithColors(repoPath))
  )

  ipcMain.handle('git:createWorktree', (event, opts: CreateWorktreeOpts) => {
    const { requestId } = opts
    const onPhase = requestId
      ? (phase: CreateWorktreePhase): void => {
          const payload: CreateWorktreePhaseEvent = { requestId, phase }
          event.sender.send('git:createWorktree:phase', payload)
        }
      : undefined
    return createWorktreeWithSetup(db, opts, onPhase)
  })

  ipcMain.handle(
    'git:removeWorktree',
    (_, repoPath: string, worktreePath: string, branchHint?: string) => {
      return removeWorktree(repoPath, worktreePath, branchHint)
    }
  )

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

  ipcMain.handle(
    'git:mergeIntoParent',
    (_, projectPath: string, parentBranch: string, sourceBranch: string) => {
      return mergeIntoParent(projectPath, parentBranch, sourceBranch)
    }
  )

  ipcMain.handle('git:abortMerge', (_, path: string) => {
    return abortMerge(path)
  })

  ipcMain.handle(
    'git:mergeWithAI',
    (_, projectPath: string, worktreePath: string, parentBranch: string, sourceBranch: string) =>
      mergeWithAI({ projectPath, worktreePath, parentBranch, sourceBranch })
  )

  ipcMain.handle('git:isMergeInProgress', (_, path: string) => {
    return isMergeInProgress(path)
  })

  ipcMain.handle('git:getConflictedFiles', (_, path: string) => {
    return getConflictedFiles(path)
  })

  ipcMain.handle(
    'git:getWorkingDiff',
    (
      _,
      path: string,
      opts?: { contextLines?: string; ignoreWhitespace?: boolean; fromSha?: string; toSha?: string }
    ) => {
      return getWorkingDiff(path, opts)
    }
  )

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

  ipcMain.handle(
    'git:getFileDiff',
    (
      _,
      repoPath: string,
      filePath: string,
      staged: boolean,
      opts?: { contextLines?: string; ignoreWhitespace?: boolean }
    ) => {
      return getFileDiff(repoPath, filePath, staged, opts)
    }
  )

  ipcMain.handle('git:getUntrackedFileDiff', (_, repoPath: string, filePath: string) => {
    return getUntrackedFileDiff(repoPath, filePath)
  })

  ipcMain.handle('git:getConflictContent', (_, repoPath: string, filePath: string) => {
    return getConflictContent(repoPath, filePath)
  })

  ipcMain.handle(
    'git:writeResolvedFile',
    (_, repoPath: string, filePath: string, content: string) => {
      writeResolvedFile(repoPath, filePath, content)
    }
  )

  ipcMain.handle('git:commitFiles', (_, repoPath: string, message: string) => {
    return commitFiles(repoPath, message)
  })

  ipcMain.handle(
    'git:analyzeConflict',
    (_, mode: string, filePath: string, base: string | null, ours: string | null, theirs: string | null) =>
      analyzeConflict(mode, filePath, base, ours, theirs)
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
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { shell } = require('electron')
    shell.openPath(path)
  })

  ipcMain.handle('git:isDirty', async (_, path: string) => {
    const summary = await getStatusSummary(path)
    return summary.staged + summary.unstaged + summary.untracked > 0
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

  ipcMain.handle(
    'git:getDiffStats',
    withResultDedup((_, path: string, ref: string) => {
      return getDiffStats(path, ref)
    })
  )

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

  ipcMain.handle(
    'git:copyIgnoredFiles',
    (_, repoPath: string, worktreePath: string, paths: string[], mode?: 'all' | 'custom') => {
      return copyIgnoredFiles(
        repoPath,
        worktreePath,
        mode ?? (paths.length > 0 ? 'custom' : 'all'),
        paths
      )
    }
  )

  // Stable hash that excludes time-sensitive fields (relativeDate strings drift
  // over time even when commits are identical — would defeat dedup).
  const hashResolvedGraph = (g: ResolvedGraph | null): string => {
    if (!g) return 'null'
    return JSON.stringify({
      baseBranch: g.baseBranch,
      branches: g.branches,
      commits: g.commits.map((c) => ({
        h: c.hash,
        p: c.parents,
        b: c.branch,
        r: c.branchRefs,
        t: c.tags,
        bt: c.isBranchTip,
        hd: c.isHead,
        m: c.mergedFrom ?? null
      }))
    })
  }
  const hashForkGraph = (r: ForkGraphResult | null): string => {
    if (!r) return 'null'
    return JSON.stringify({
      forkPoint: r.forkPoint,
      featureCount: r.featureCount,
      baseCount: r.baseCount,
      graph: hashResolvedGraph(r.graph)
    })
  }

  ipcMain.handle(
    'git:getResolvedCommitDag',
    withResultDedup(
      (_, path: string, limit: number, branches: string[] | undefined, baseBranch: string) =>
        getResolvedCommitDag(path, limit, branches, baseBranch),
      { hashFn: hashResolvedGraph }
    )
  )

  ipcMain.handle(
    'git:getResolvedForkGraph',
    withResultDedup(
      (
        _,
        targetPath: string,
        repoPath: string,
        activeBranch: string,
        compareBranch: string,
        activeBranchLabel: string,
        compareBranchLabel: string
      ) =>
        getResolvedForkGraph(
          targetPath,
          repoPath,
          activeBranch,
          compareBranch,
          activeBranchLabel,
          compareBranchLabel
        ),
      { hashFn: hashForkGraph }
    )
  )

  ipcMain.handle('git:getResolvedUpstreamGraph', (_, repoPath: string, branch: string) => {
    return getResolvedUpstreamGraph(repoPath, branch)
  })

  ipcMain.handle(
    'git:getResolvedRecentCommits',
    (_, path: string, count: number, branchName: string) => {
      return getResolvedRecentCommits(path, count, branchName)
    }
  )

  // Stash operations
  ipcMain.handle('git:listStashes', (_, repoPath: string) => {
    return listStashes(repoPath)
  })

  ipcMain.handle(
    'git:createStash',
    (_, repoPath: string, message: string, includeUntracked: boolean, keepIndex: boolean) => {
      return createStash(repoPath, message, includeUntracked, keepIndex)
    }
  )

  ipcMain.handle('git:applyStash', (_, repoPath: string, index: number) => {
    return applyStash(repoPath, index)
  })

  ipcMain.handle('git:popStash', (_, repoPath: string, index: number) => {
    return popStash(repoPath, index)
  })

  ipcMain.handle('git:dropStash', (_, repoPath: string, index: number) => {
    return dropStash(repoPath, index)
  })

  ipcMain.handle(
    'git:branchFromStash',
    (_, repoPath: string, index: number, branchName: string) => {
      return branchFromStash(repoPath, index, branchName)
    }
  )

  ipcMain.handle('git:getStashDiff', (_, repoPath: string, index: number) => {
    return getStashDiff(repoPath, index)
  })

  // GitHub CLI (gh) operations
  ipcMain.handle('git:checkGhInstalled', () => {
    return checkGhInstalled()
  })

  ipcMain.handle('git:hasGithubRemote', (_, repoPath: string) => {
    return hasGithubRemote(repoPath)
  })

  ipcMain.handle(
    'git:listOpenPrs',
    withResultDedup((_, repoPath: string) => {
      return listOpenPrs(repoPath)
    })
  )

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
