import { createContext, forwardRef, useCallback, useContext, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Check, X, SkipForward, AlertTriangle, RefreshCw, Plus } from 'lucide-react'
import { Button, Checkbox, IconButton, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, cn, useShortcutDisplay } from '@slayzone/ui'
import type { Task, UpdateTaskInput, MergeContext } from '@slayzone/task/shared'
import type { FilterState } from '@slayzone/tasks'
import type { Project, DetectedRepo } from '@slayzone/projects/shared'
import { GitDiffPanel, type GitDiffPanelHandle } from './GitDiffPanel'
import { ConflictFileView } from './ConflictFileView'
import { GeneralTabContent } from './GeneralTabContent'
import { ProjectGeneralTab } from './ProjectGeneralTab'
import { WorktreesTab, type WorktreesTabHandle } from './WorktreesTab'
import { PullRequestTab } from './PullRequestTab'
import { ProjectPrTab } from './ProjectPrTab'
export type GitTabId = 'general' | 'changes' | 'conflicts' | 'worktrees' | 'pr'

type UnifiedGitPanelProps = {
  task?: Task | null
  projectId: string
  projectPath: string | null
  completedStatus?: string
  visible: boolean
  pollIntervalMs?: number
  defaultTab?: GitTabId
  onTabChange?: (tab: GitTabId) => void
  tasks?: Task[]
  filter?: FilterState
  projects?: Project[]
  onTaskClick?: (task: Task) => void
  onUpdateTask?: (data: UpdateTaskInput) => Promise<Task>
  onTaskUpdated?: (task: Task) => void
  detectedRepos?: DetectedRepo[]
  selectedRepoName?: string | null
  isRepoStale?: boolean
  onRepoChange?: (repoName: string) => void
}

interface ConflictToolbarData {
  resolvedCount: number
  totalCount: number
  isRebase: boolean
  onSkipCommit: () => void
  onAbort: () => void
}

export interface UnifiedGitPanelHandle {
  switchToTab: (tab: GitTabId) => void
  getActiveTab: () => GitTabId
}

interface GitPanelContextValue {
  tasks: Task[]
  filter?: FilterState
  projects: Project[]
  activeTask?: Task | null
  projectPath: string | null
  onTaskClick?: (task: Task) => void
  onUpdateTask?: (data: UpdateTaskInput) => Promise<Task>
  onTaskUpdated?: (task: Task) => void
}

const GitPanelContext = createContext<GitPanelContextValue | null>(null)

export function useGitPanelContext() {
  const context = useContext(GitPanelContext)
  if (!context) throw new Error('useGitPanelContext must be used within UnifiedGitPanel')
  return context
}

export const UnifiedGitPanel = forwardRef<UnifiedGitPanelHandle, UnifiedGitPanelProps>(function UnifiedGitPanel({
  task,
  projectId,
  projectPath,
  completedStatus = 'done',
  visible,
  pollIntervalMs,
  defaultTab = 'general',
  onTabChange,
  onUpdateTask,
  onTaskUpdated,
  tasks = [],
  filter,
  projects = [],
  onTaskClick,
  detectedRepos = [],
  selectedRepoName,
  isRepoStale,
  onRepoChange
}, ref) {
  const gitGeneralShortcut = useShortcutDisplay('panel-git')
  const gitDiffShortcut = useShortcutDisplay('panel-git-diff')

  const [activeTab, setActiveTabRaw] = useState<GitTabId>(defaultTab)
  const setActiveTab = useCallback((tab: GitTabId) => {
    setActiveTabRaw(tab)
    onTabChange?.(tab)
  }, [onTabChange])

  useImperativeHandle(ref, () => ({
    switchToTab: setActiveTab,
    getActiveTab: () => activeTab
  }), [activeTab, setActiveTab])
  const hasConflicts = !!task && (task.merge_state === 'conflicts' || task.merge_state === 'rebase-conflicts')
  const isUncommitted = !!task && task.merge_state === 'uncommitted'
  const isRebase = !!task && task.merge_state === 'rebase-conflicts'
  const diffRef = useRef<GitDiffPanelHandle>(null)
  const worktreesRef = useRef<WorktreesTabHandle>(null)
  const [conflictToolbar, setConflictToolbar] = useState<ConflictToolbarData | null>(null)

  const showWorktrees = !task
  const [hasGithubRemote, setHasGithubRemote] = useState(false)

  // Check if repo has a GitHub remote
  useEffect(() => {
    if (!projectPath) { setHasGithubRemote(false); return }
    window.api.git.hasGithubRemote(projectPath).then(setHasGithubRemote).catch(() => setHasGithubRemote(false))
  }, [projectPath])

  // Auto-switch to conflicts tab when conflicts detected
  useEffect(() => {
    if (hasConflicts) setActiveTab('conflicts')
  }, [hasConflicts])

  // Auto-switch to changes tab when uncommitted
  useEffect(() => {
    if (isUncommitted) setActiveTab('changes')
  }, [isUncommitted])

  // Reset active tab if worktrees/pr becomes hidden (or stale 'branches' from persisted state)
  useEffect(() => {
    if (!showWorktrees && activeTab === 'worktrees') {
      setActiveTab('general')
    }
    if (!hasGithubRemote && activeTab === 'pr') {
      setActiveTab('general')
    }
    if ((activeTab as string) === 'branches') {
      setActiveTab('general')
    }
  }, [showWorktrees, hasGithubRemote, activeTab])

  // Merge-mode: commit and continue merge
  const handleCommitAndContinueMerge = useCallback(async () => {
    if (!task || !onUpdateTask || !onTaskUpdated) return
    const targetPath = task.worktree_path ?? projectPath
    if (!targetPath) return

    await window.api.git.stageAll(targetPath)
    await window.api.git.commitFiles(targetPath, 'WIP: changes before merge')

    const sourceBranch = await window.api.git.getCurrentBranch(task.worktree_path!)
    if (!sourceBranch) throw new Error('Cannot merge: detached HEAD in worktree')

    const result = await window.api.git.mergeWithAI(
      projectPath!,
      task.worktree_path!,
      task.worktree_parent_branch!,
      sourceBranch
    )

    if (result.success) {
      const updated = await onUpdateTask({ id: task.id, status: completedStatus, mergeState: null, mergeContext: null })
      onTaskUpdated(updated)
    } else if (result.resolving) {
      const ctx = await window.api.git.getMergeContext(projectPath!)
      const updated = await onUpdateTask({
        id: task.id,
        mergeState: 'conflicts',
        mergeContext: ctx ?? { type: 'merge', sourceBranch, targetBranch: task.worktree_parent_branch! }
      })
      onTaskUpdated(updated)
    } else if (result.error) {
      throw new Error(result.error)
    }
  }, [task, projectPath, completedStatus, onUpdateTask, onTaskUpdated])

  const handleAbortMerge = useCallback(async () => {
    if (!task || !onUpdateTask || !onTaskUpdated) return
    if (projectPath) {
      try { await window.api.git.abortMerge(projectPath) } catch { /* already aborted */ }
    }
    const updated = await onUpdateTask({ id: task.id, mergeState: null, mergeContext: null })
    onTaskUpdated(updated)
  }, [task, projectPath, onUpdateTask, onTaskUpdated])

  return (
    <GitPanelContext.Provider value={{
      tasks,
      filter,
      projects,
      activeTask: task,
      projectPath,
      onTaskClick,
      onUpdateTask,
      onTaskUpdated
    }}>
      <div className="h-full flex flex-col">
      {/* Unified header: tabs left, actions right */}
      <div className="shrink-0 h-10 px-2 border-b border-border bg-surface-1 flex items-center gap-1">
        <TabButton
          active={activeTab === 'general'}
          onClick={() => setActiveTab('general')}
          shortcut={gitGeneralShortcut}
        >
          General
        </TabButton>
        <TabButton
          active={activeTab === 'changes'}
          onClick={() => setActiveTab('changes')}
          shortcut={gitDiffShortcut}
        >
          Diff
        </TabButton>
        {showWorktrees && (
          <TabButton
            active={activeTab === 'worktrees'}
            onClick={() => setActiveTab('worktrees')}
          >
            Worktrees
          </TabButton>
        )}
        {hasConflicts && (
          <TabButton
            active={activeTab === 'conflicts'}
            onClick={() => setActiveTab('conflicts')}
            badge
          >
            Conflicts
          </TabButton>
        )}
        {hasGithubRemote && (!task || task.pr_url) && (
          <TabButton
            active={activeTab === 'pr'}
            onClick={() => setActiveTab('pr')}
          >
            {task ? <>Pull request{task.pr_url && <span className="text-muted-foreground ml-1">#{task.pr_url.match(/\/pull\/(\d+)/)?.[1]}</span>}</> : 'Pull requests'}
          </TabButton>
        )}

        {/* Right-aligned actions */}
        <div className="flex-1" />
        {detectedRepos.length > 0 && onRepoChange && (
          <Select
            value={selectedRepoName ?? detectedRepos[0]?.name ?? ''}
            onValueChange={onRepoChange}
          >
            <SelectTrigger
              className={cn(
                'h-7 w-auto max-w-[160px] text-xs gap-1 px-2',
                isRepoStale && 'border-amber-500/60 text-amber-500'
              )}
              data-size="sm"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {detectedRepos.map((repo) => (
                <SelectItem key={repo.name} value={repo.name} className="text-xs">
                  {repo.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {activeTab === 'changes' && (
          <IconButton
            aria-label="Refresh"
            variant="ghost"
            className="h-7 w-7"
            title="Refresh"
            onClick={() => diffRef.current?.refresh()}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </IconButton>
        )}
        {activeTab === 'worktrees' && (
          <IconButton
            aria-label="Add Worktree"
            variant="ghost"
            className="h-7 w-7"
            title="Add Worktree"
            onClick={() => worktreesRef.current?.openCreateDialog()}
          >
            <Plus className="h-3.5 w-3.5" />
          </IconButton>
        )}
        {activeTab === 'conflicts' && conflictToolbar && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">
              {conflictToolbar.resolvedCount}/{conflictToolbar.totalCount}
            </span>
            {conflictToolbar.isRebase && (
              <Button variant="outline" size="sm" className="gap-1 h-7 text-xs" onClick={conflictToolbar.onSkipCommit}>
                <SkipForward className="h-3 w-3" /> Skip
              </Button>
            )}
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={conflictToolbar.onAbort}>
              Abort
            </Button>
          </div>
        )}
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0 relative">
        <div className={cn('absolute inset-0', activeTab !== 'general' && 'hidden')}>
          {task ? (
            <GeneralTabContent
              task={task}
              projectPath={projectPath}
              visible={visible && activeTab === 'general'}
              pollIntervalMs={pollIntervalMs}
              hasGithubRemote={hasGithubRemote}
              onUpdateTask={onUpdateTask!}
              onTaskUpdated={onTaskUpdated!}
              onSwitchTab={setActiveTab}
            />
          ) : (
            <ProjectGeneralTab
              projectId={projectId}
              projectPath={projectPath}
              visible={visible && activeTab === 'general'}
              onSwitchToDiff={() => setActiveTab('changes')}
            />
          )}
        </div>
        <div className={cn('absolute inset-0', activeTab !== 'changes' && 'hidden')}>
          <GitDiffPanel
            ref={diffRef}
            task={task ?? null}
            projectPath={projectPath}
            visible={visible && activeTab === 'changes'}
            pollIntervalMs={pollIntervalMs}
            mergeState={task?.merge_state}
            onCommitAndContinueMerge={task ? handleCommitAndContinueMerge : undefined}
            onAbortMerge={task ? handleAbortMerge : undefined}
          />
        </div>
        <div className={cn('absolute inset-0', activeTab !== 'worktrees' && 'hidden')}>
          <WorktreesTab
            ref={worktreesRef}
            visible={visible && activeTab === 'worktrees'}
          />
        </div>
        {hasConflicts && task && (
          <div className={cn('absolute inset-0', activeTab !== 'conflicts' && 'hidden')}>
            <ConflictPhaseContent
              task={task}
              projectPath={projectPath!}
              completedStatus={completedStatus}
              isRebase={isRebase}
              onUpdateTask={onUpdateTask!}
              onTaskUpdated={onTaskUpdated!}
              onToolbarChange={setConflictToolbar}
            />
          </div>
        )}
        {hasGithubRemote && (
          <div className={cn('absolute inset-0', activeTab !== 'pr' && 'hidden')}>
            {task ? (
              <PullRequestTab
                task={task}
                projectPath={projectPath}
                visible={visible && activeTab === 'pr'}
                onUpdateTask={onUpdateTask!}
                onTaskUpdated={onTaskUpdated!}
              />
            ) : (
              <ProjectPrTab
                projectPath={projectPath}
                visible={visible && activeTab === 'pr'}
                tasks={tasks}
                onTaskClick={onTaskClick}
              />
            )}
          </div>
        )}
      </div>
    </div>
    </GitPanelContext.Provider>
  )
})

// --- Tab button ---

function TabButton({ active, onClick, children, shortcut, badge }: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  shortcut?: string | null
  badge?: boolean
}) {
  return (
    <button
      className={cn(
        'flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-medium transition-colors',
        active
          ? 'bg-muted text-foreground border-border shadow-sm'
          : 'bg-muted/40 text-muted-foreground border-transparent hover:bg-muted/70 hover:text-foreground'
      )}
      onClick={onClick}
    >
      {children}
      {shortcut && (
        <span className={cn('text-[10px] leading-none', active ? 'text-foreground/70' : 'text-muted-foreground')}>
          {shortcut}
        </span>
      )}
      {badge && (
        <AlertTriangle className="h-3 w-3 text-yellow-500" />
      )}
    </button>
  )
}

// --- Conflict phase (extracted from MergePanel) ---

function ConflictPhaseContent({ task, projectPath, completedStatus, isRebase, onUpdateTask, onTaskUpdated, onToolbarChange }: {
  task: Task
  projectPath: string
  completedStatus: string
  isRebase: boolean
  onUpdateTask: (data: UpdateTaskInput) => Promise<Task>
  onTaskUpdated: (task: Task) => void
  onToolbarChange: (data: ConflictToolbarData) => void
}) {

  const [conflictedFiles, setConflictedFiles] = useState<string[]>([])
  const [resolvedFiles, setResolvedFiles] = useState<Set<string>>(new Set())
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [completing, setCompleting] = useState(false)
  const [markDone, setMarkDone] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [mergeContext, setMergeContext] = useState<MergeContext | null>(task.merge_context)

  // Load merge context if not on task
  useEffect(() => {
    if (!mergeContext) {
      window.api.git.getMergeContext(projectPath).then(ctx => {
        if (ctx) {
          setMergeContext(ctx)
          onUpdateTask({ id: task.id, mergeContext: ctx })
        }
      })
    }
  }, [projectPath, mergeContext])

  // Load conflicted files
  useEffect(() => {
    window.api.git.getConflictedFiles(projectPath).then(files => {
      setConflictedFiles(files)
      if (files.length > 0 && !selectedFile) setSelectedFile(files[0])
    })
  }, [projectPath])

  const handleFileResolved = useCallback((filePath: string) => {
    setResolvedFiles(prev => new Set(prev).add(filePath))
  }, [])

  const allResolved = conflictedFiles.length > 0 && conflictedFiles.every(f => resolvedFiles.has(f))

  const handleCompleteMerge = useCallback(async () => {
    setCompleting(true)
    setError(null)
    try {
      const sourceBranch = await window.api.git.getCurrentBranch(task.worktree_path!)
      await window.api.git.commitFiles(
        projectPath,
        `Merge ${sourceBranch ?? 'branch'} into ${task.worktree_parent_branch}`
      )
      const updates: UpdateTaskInput = { id: task.id, mergeState: null, mergeContext: null }
      if (markDone) updates.status = completedStatus
      const updated = await onUpdateTask(updates)
      onTaskUpdated(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCompleting(false)
    }
  }, [task, projectPath, completedStatus, markDone, onUpdateTask, onTaskUpdated])

  const handleContinueRebase = useCallback(async () => {
    setCompleting(true)
    setError(null)
    try {
      const result = await window.api.git.continueRebase(projectPath)
      if (result.done) {
        const updates: UpdateTaskInput = { id: task.id, mergeState: null, mergeContext: null }
        if (markDone) updates.status = completedStatus
        const updated = await onUpdateTask(updates)
        onTaskUpdated(updated)
      } else {
        setConflictedFiles(result.conflictedFiles)
        setResolvedFiles(new Set())
        setSelectedFile(result.conflictedFiles[0] ?? null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCompleting(false)
    }
  }, [task, projectPath, completedStatus, markDone, onUpdateTask, onTaskUpdated])

  const handleSkipCommit = useCallback(async () => {
    setError(null)
    try {
      const result = await window.api.git.skipRebaseCommit(projectPath)
      if (result.done) {
        const updates: UpdateTaskInput = { id: task.id, mergeState: null, mergeContext: null }
        const updated = await onUpdateTask(updates)
        onTaskUpdated(updated)
      } else {
        setConflictedFiles(result.conflictedFiles)
        setResolvedFiles(new Set())
        setSelectedFile(result.conflictedFiles[0] ?? null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [task, projectPath, onUpdateTask, onTaskUpdated])

  const handleAbort = useCallback(async () => {
    try {
      if (isRebase) {
        await window.api.git.abortRebase(projectPath)
      } else {
        await window.api.git.abortMerge(projectPath)
      }
    } catch { /* already aborted */ }
    const updated = await onUpdateTask({ id: task.id, mergeState: null, mergeContext: null })
    onTaskUpdated(updated)
  }, [task.id, projectPath, isRebase, onUpdateTask, onTaskUpdated])

  // Push toolbar data to parent for unified header
  useEffect(() => {
    onToolbarChange({
      resolvedCount: resolvedFiles.size,
      totalCount: conflictedFiles.length,
      isRebase,
      onSkipCommit: handleSkipCommit,
      onAbort: handleAbort
    })
  }, [resolvedFiles.size, conflictedFiles.length, isRebase, handleSkipCommit, handleAbort, onToolbarChange])

  const fallbackContext: MergeContext = mergeContext ?? {
    type: isRebase ? 'rebase' : 'merge',
    sourceBranch: 'unknown',
    targetBranch: task.worktree_parent_branch ?? 'unknown'
  }

  return (
    <div className="h-full flex flex-col">
      {error && (
        <div className="px-4 py-2 bg-destructive/10 text-destructive text-xs">{error}</div>
      )}

      {/* Main content */}
      <div className="flex-1 min-h-0 flex">
        {/* File list */}
        <div className="w-56 shrink-0 overflow-y-auto border-r">
          {conflictedFiles.map(file => (
            <div
              key={file}
              className={cn(
                'px-3 py-2 flex items-center gap-2 text-xs font-mono hover:bg-accent/50 cursor-pointer',
                selectedFile === file && 'bg-accent'
              )}
              onClick={() => setSelectedFile(file)}
            >
              {resolvedFiles.has(file) ? (
                <Check className="h-3 w-3 text-green-500 shrink-0" />
              ) : (
                <X className="h-3 w-3 text-red-500 shrink-0" />
              )}
              <span className="truncate">{file}</span>
            </div>
          ))}
        </div>

        {/* Conflict view */}
        <div className="flex-1 min-w-0 overflow-auto">
          {selectedFile ? (
            <ConflictFileView
              key={selectedFile}
              repoPath={projectPath}
              filePath={selectedFile}
              terminalMode={task.terminal_mode}
              onResolved={() => handleFileResolved(selectedFile)}
              branchContext={fallbackContext}
            />
          ) : (
            <div className="h-full flex items-center justify-center">
              <p className="text-xs text-muted-foreground">Select a file to resolve</p>
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="shrink-0 px-4 py-3 border-t flex items-center justify-between">
        <label className="flex items-center gap-2 text-xs">
          <Checkbox checked={markDone} onCheckedChange={(v) => setMarkDone(!!v)} />
          Mark task as complete
        </label>
        <Button
          size="sm"
          onClick={isRebase ? handleContinueRebase : handleCompleteMerge}
          disabled={!allResolved || completing}
        >
          {completing
            ? (isRebase ? 'Continuing...' : 'Completing...')
            : (isRebase ? 'Continue Rebase' : 'Complete Merge')}
        </Button>
      </div>
    </div>
  )
}
