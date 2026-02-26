import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Check, X, SkipForward, AlertTriangle, RefreshCw } from 'lucide-react'
import { Button, Checkbox, cn } from '@slayzone/ui'
import type { Task, UpdateTaskInput, MergeContext } from '@slayzone/task/shared'
import type { RebaseProgress } from '../shared/types'
import { GitDiffPanel, type GitDiffPanelHandle } from './GitDiffPanel'
import { ConflictFileView } from './ConflictFileView'
import { CommitTimeline } from './CommitTimeline'
import { GeneralTabContent } from './GeneralTabContent'
import { ProjectGeneralTab } from './ProjectGeneralTab'

export type GitTabId = 'general' | 'changes' | 'conflicts'
const isMac = navigator.platform.startsWith('Mac')
const gitGeneralShortcut = isMac ? '⌘G' : 'Ctrl+G'
const gitDiffShortcut = isMac ? '⌘⇧G' : 'Ctrl+Shift+G'

type UnifiedGitPanelProps = {
  projectPath: string | null
  /** When set, new worktrees branch from this; when empty, use current branch. */
  worktreeSourceBranch?: string | null
  visible: boolean
  pollIntervalMs?: number
  defaultTab?: GitTabId
} & (
  | { task: Task; onUpdateTask: (data: UpdateTaskInput) => Promise<Task>; onTaskUpdated: (task: Task) => void }
  | { task?: null; onUpdateTask?: never; onTaskUpdated?: never }
)

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

export const UnifiedGitPanel = forwardRef<UnifiedGitPanelHandle, UnifiedGitPanelProps>(function UnifiedGitPanel({
  task,
  projectPath,
  worktreeSourceBranch,
  visible,
  pollIntervalMs,
  defaultTab = 'general',
  onUpdateTask,
  onTaskUpdated
}, ref) {
  const [activeTab, setActiveTab] = useState<GitTabId>(defaultTab)

  useImperativeHandle(ref, () => ({
    switchToTab: setActiveTab,
    getActiveTab: () => activeTab
  }), [activeTab])
  const hasConflicts = !!task && (task.merge_state === 'conflicts' || task.merge_state === 'rebase-conflicts')
  const isUncommitted = !!task && task.merge_state === 'uncommitted'
  const isRebase = !!task && task.merge_state === 'rebase-conflicts'
  const diffRef = useRef<GitDiffPanelHandle>(null)
  const [conflictToolbar, setConflictToolbar] = useState<ConflictToolbarData | null>(null)

  // Auto-switch to conflicts tab when conflicts detected
  useEffect(() => {
    if (hasConflicts) setActiveTab('conflicts')
  }, [hasConflicts])

  // Auto-switch to changes tab when uncommitted
  useEffect(() => {
    if (isUncommitted) setActiveTab('changes')
  }, [isUncommitted])

  // Merge-mode: commit and continue merge
  const handleCommitAndContinueMerge = useCallback(async () => {
    if (!task) return
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
      const updated = await onUpdateTask({ id: task.id, status: 'done', mergeState: null, mergeContext: null })
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
  }, [task, projectPath, onUpdateTask, onTaskUpdated])

  const handleAbortMerge = useCallback(async () => {
    if (!task) return
    if (projectPath) {
      try { await window.api.git.abortMerge(projectPath) } catch { /* already aborted */ }
    }
    const updated = await onUpdateTask({ id: task.id, mergeState: null, mergeContext: null })
    onTaskUpdated(updated)
  }, [task, projectPath, onUpdateTask, onTaskUpdated])

  return (
    <div className="h-full flex flex-col">
      {/* Unified header: tabs left, actions right */}
      <div className="shrink-0 h-10 px-2 border-b border-border flex items-center gap-1">
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
        {hasConflicts && (
          <TabButton
            active={activeTab === 'conflicts'}
            onClick={() => setActiveTab('conflicts')}
            badge
          >
            Conflicts
          </TabButton>
        )}

        {/* Right-aligned actions */}
        <div className="flex-1" />
        {activeTab === 'changes' && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="Refresh"
            onClick={() => diffRef.current?.refresh()}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
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
        <div className={cn('absolute inset-0 overflow-y-auto', activeTab !== 'general' && 'hidden')}>
          {task ? (
            <GeneralTabContent
              task={task}
              projectPath={projectPath}
              worktreeSourceBranch={worktreeSourceBranch}
              visible={visible && activeTab === 'general'}
              pollIntervalMs={pollIntervalMs}
              onUpdateTask={onUpdateTask}
              onTaskUpdated={onTaskUpdated}
              onSwitchTab={setActiveTab}
            />
          ) : (
            <ProjectGeneralTab
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
        {hasConflicts && task && (
          <div className={cn('absolute inset-0', activeTab !== 'conflicts' && 'hidden')}>
            <ConflictPhaseContent
              task={task}
              projectPath={projectPath!}
              isRebase={isRebase}
              onUpdateTask={onUpdateTask}
              onTaskUpdated={onTaskUpdated}
              onToolbarChange={setConflictToolbar}
            />
          </div>
        )}
      </div>
    </div>
  )
})

// --- Tab button ---

function TabButton({ active, onClick, children, shortcut, badge }: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  shortcut?: string
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

function ConflictPhaseContent({ task, projectPath, isRebase, onUpdateTask, onTaskUpdated, onToolbarChange }: {
  task: Task
  projectPath: string
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
  const [rebaseProgress, setRebaseProgress] = useState<RebaseProgress | null>(null)

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

  // Load rebase progress
  useEffect(() => {
    if (!isRebase) return
    window.api.git.getRebaseProgress(projectPath).then(setRebaseProgress)
  }, [projectPath, isRebase])

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
      if (markDone) updates.status = 'done'
      const updated = await onUpdateTask(updates)
      onTaskUpdated(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCompleting(false)
    }
  }, [task, projectPath, markDone, onUpdateTask, onTaskUpdated])

  const handleContinueRebase = useCallback(async () => {
    setCompleting(true)
    setError(null)
    try {
      const result = await window.api.git.continueRebase(projectPath)
      if (result.done) {
        const updates: UpdateTaskInput = { id: task.id, mergeState: null, mergeContext: null }
        if (markDone) updates.status = 'done'
        const updated = await onUpdateTask(updates)
        onTaskUpdated(updated)
      } else {
        setConflictedFiles(result.conflictedFiles)
        setResolvedFiles(new Set())
        setSelectedFile(result.conflictedFiles[0] ?? null)
        const progress = await window.api.git.getRebaseProgress(projectPath)
        setRebaseProgress(progress)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCompleting(false)
    }
  }, [task, projectPath, markDone, onUpdateTask, onTaskUpdated])

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
        const progress = await window.api.git.getRebaseProgress(projectPath)
        setRebaseProgress(progress)
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
      {/* Commit timeline */}
      <CommitTimeline context={fallbackContext} rebaseProgress={rebaseProgress} />

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
          Mark task as done
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
