import { useCallback, useEffect, useState } from 'react'
import { Check, X } from 'lucide-react'
import { Button, Checkbox, cn } from '@slayzone/ui'
import type { Task, UpdateTaskInput, MergeContext } from '@slayzone/task/shared'
import { ConflictFileView } from './ConflictFileView'
import type { ConflictToolbarData } from './UnifiedGitPanel.types'

// --- Conflict phase (extracted from MergePanel) ---

export function ConflictPhaseContent({
  task,
  projectPath,
  completedStatus,
  isRebase,
  onUpdateTask,
  onTaskUpdated,
  onToolbarChange
}: {
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
      window.api.git.getMergeContext(projectPath).then((ctx) => {
        if (ctx) {
          setMergeContext(ctx)
          onUpdateTask({ id: task.id, mergeContext: ctx })
        }
      })
    }
  }, [projectPath, mergeContext])

  // Load conflicted files
  useEffect(() => {
    window.api.git.getConflictedFiles(projectPath).then((files) => {
      setConflictedFiles(files)
      if (files.length > 0 && !selectedFile) setSelectedFile(files[0])
    })
  }, [projectPath])

  const handleFileResolved = useCallback((filePath: string) => {
    setResolvedFiles((prev) => new Set(prev).add(filePath))
  }, [])

  const allResolved =
    conflictedFiles.length > 0 && conflictedFiles.every((f) => resolvedFiles.has(f))

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
    } catch {
      /* already aborted */
    }
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
  }, [
    resolvedFiles.size,
    conflictedFiles.length,
    isRebase,
    handleSkipCommit,
    handleAbort,
    onToolbarChange
  ])

  const fallbackContext: MergeContext = mergeContext ?? {
    type: isRebase ? 'rebase' : 'merge',
    sourceBranch: 'unknown',
    targetBranch: task.worktree_parent_branch ?? 'unknown'
  }

  return (
    <div className="h-full flex flex-col">
      {error && <div className="px-4 py-2 bg-destructive/10 text-destructive text-xs">{error}</div>}

      {/* Main content */}
      <div className="flex-1 min-h-0 flex">
        {/* File list */}
        <div className="w-56 shrink-0 overflow-y-auto border-r">
          {conflictedFiles.map((file) => (
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
            ? isRebase
              ? 'Continuing...'
              : 'Completing...'
            : isRebase
              ? 'Continue Rebase'
              : 'Complete Merge'}
        </Button>
      </div>
    </div>
  )
}
