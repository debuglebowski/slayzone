import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useImperativeHandle,
  forwardRef
} from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import { FolderGit2 } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  toast,
  Input,
  PulseGrid,
  useStablePoll
} from '@slayzone/ui'
import type { DetectedWorktree } from '../shared/types'
import { CreateWorktreeDialog } from './CreateWorktreeDialog'
import { useGitPanelContext } from './git-panel-context'
import { WorktreeCard } from './WorktreeCard'
import { GroupedTaskList } from './GroupedTaskList'
import { buildWorktreeTree, renderTree } from './WorktreesTab.tree'

interface WorktreesTabProps {
  visible: boolean
  pollIntervalMs?: number
}

export interface WorktreesTabHandle {
  openCreateDialog: () => void
}

export const WorktreesTab = forwardRef<WorktreesTabHandle, WorktreesTabProps>(function WorktreesTab(
  { visible, pollIntervalMs = 5000 },
  ref
) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const removeWorktreeMutation = useMutation(trpc.worktrees.removeWorktree.mutationOptions())
  const { projectPath, tasks, activeTask, onUpdateTask } = useGitPanelContext()

  const [worktrees, setWorktrees] = useState<DetectedWorktree[]>([])
  const [dirtyStatuses, setDirtyStatuses] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(false)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState<string | null>(null)
  const [assigningWorktree, setAssigningWorktree] = useState<DetectedWorktree | null>(null)
  const [assignSearch, setAssignSearch] = useState('')
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())

  useImperativeHandle(ref, () => ({
    openCreateDialog: () => setCreateDialogOpen(true)
  }))

  const toggleExpand = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const lastWorktreesHashRef = useRef<string>('')

  const fetchWorktrees = useCallback(async () => {
    if (!projectPath) return null
    try {
      const detected = await queryClient.fetchQuery(
        trpc.worktrees.detectWorktrees.queryOptions({ repoPath: projectPath })
      )
      const hash = JSON.stringify(detected)
      if (hash !== lastWorktreesHashRef.current) {
        lastWorktreesHashRef.current = hash
        setWorktrees(detected)
      }
      setLoading(false)
      return hash
    } catch {
      setLoading(false)
      return null
    }
  }, [projectPath, queryClient, trpc])

  useEffect(() => {
    if (visible && projectPath && worktrees.length === 0) setLoading(true)
  }, [visible, projectPath, worktrees.length])

  useStablePoll(fetchWorktrees, { enabled: visible && !!projectPath, baseDelayMs: pollIntervalMs })

  // Optimized dirty-status polling — already dedups setState via prev[path] check.
  // Wrap in stable poll for backoff timing; the per-call fetch returns a string
  // hash so the hook can detect identical results across ticks.
  const pollDirty = useCallback(async () => {
    if (worktrees.length === 0) return null
    const activePath = activeTask?.worktree_path || worktrees.find((wt) => wt.isMain)?.path
    let activeDirty: boolean | null = null
    if (activePath) {
      activeDirty = await queryClient.fetchQuery(
        trpc.worktrees.isDirty.queryOptions({ path: activePath })
      )
      setDirtyStatuses((prev) => {
        if (prev[activePath] === activeDirty) return prev
        return { ...prev, [activePath]: activeDirty as boolean }
      })
    }
    const backgroundWts = worktrees.filter((wt) => wt.path !== activePath)
    let bgKey: string | null = null
    let bgDirty: boolean | null = null
    if (backgroundWts.length > 0) {
      const randomWt = backgroundWts[Math.floor(Math.random() * backgroundWts.length)]
      bgKey = randomWt.path
      bgDirty = await queryClient.fetchQuery(
        trpc.worktrees.isDirty.queryOptions({ path: randomWt.path })
      )
      setDirtyStatuses((prev) => {
        if (prev[randomWt.path] === bgDirty) return prev
        return { ...prev, [randomWt.path]: bgDirty as boolean }
      })
    }
    return JSON.stringify({ activePath, activeDirty, bgKey, bgDirty })
  }, [worktrees, activeTask?.worktree_path, queryClient, trpc])

  useStablePoll(pollDirty, { enabled: visible && worktrees.length > 0, baseDelayMs: 10_000 })

  // Build hierarchical tree structure
  const tree = useMemo(() => buildWorktreeTree(worktrees, tasks), [worktrees, tasks])

  const handleRemoveWorktree = async (path: string) => {
    if (!projectPath) return
    try {
      await removeWorktreeMutation.mutateAsync({ repoPath: projectPath, worktreePath: path })
      const task = tasks.find((t) => t.worktree_path === path)
      if (task && onUpdateTask) {
        await onUpdateTask({ id: task.id, worktreePath: null })
      }
      fetchWorktrees()
      toast('Worktree removed')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to remove worktree')
    }
  }

  const handleAssignToTask = async (taskId: string) => {
    if (!assigningWorktree || !onUpdateTask) return
    try {
      await onUpdateTask({ id: taskId, worktreePath: assigningWorktree.path })
      setAssigningWorktree(null)
      setAssignSearch('')
      toast('Worktree assigned to task')
    } catch (err) {
      toast('Failed to assign worktree')
    }
  }

  if (!projectPath) {
    return (
      <div className="p-4 text-xs text-muted-foreground">Set a project path to see worktrees</div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-y-auto p-4 space-y-1">
        {loading && worktrees.length === 0 ? (
          <PulseGrid />
        ) : worktrees.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center space-y-3">
            <div className="p-3 rounded-full bg-muted/30">
              <FolderGit2 className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="text-xs text-muted-foreground max-w-[200px]">
              No worktrees detected. Use "Add Worktree" to create one.
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {renderTree(tree, expandedPaths, (node) => (
              <WorktreeCard
                key={node.path}
                node={{ ...node, isDirty: dirtyStatuses[node.path] ?? false }}
                worktreeColor={node.color}
                isExpanded={expandedPaths.has(node.path)}
                onToggleExpand={() => toggleExpand(node.path)}
                onRemove={() => setDeleteConfirmOpen(node.path)}
                onAssign={() => setAssigningWorktree(node)}
              />
            ))}
          </div>
        )}
      </div>

      <CreateWorktreeDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        projectPath={projectPath}
        onCreated={() => {
          fetchWorktrees()
          setCreateDialogOpen(false)
        }}
      />

      <AlertDialog
        open={!!deleteConfirmOpen}
        onOpenChange={(open) => !open && setDeleteConfirmOpen(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Worktree</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the worktree directory from disk. Uncommitted changes will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteConfirmOpen && handleRemoveWorktree(deleteConfirmOpen)}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Task Assignment Dialog */}
      <AlertDialog
        open={!!assigningWorktree}
        onOpenChange={(open) => {
          if (!open) {
            setAssigningWorktree(null)
            setAssignSearch('')
          }
        }}
      >
        <AlertDialogContent className="max-w-md max-h-[80vh] flex flex-col">
          <AlertDialogHeader className="shrink-0">
            <AlertDialogTitle>Assign Worktree to Task</AlertDialogTitle>
            <AlertDialogDescription>
              Select an active task to link with worktree: <br />
              <code className="text-[10px] bg-muted px-1 rounded">{assigningWorktree?.path}</code>
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="shrink-0 py-2">
            <Input
              placeholder="Search tasks..."
              value={assignSearch}
              onChange={(e) => setAssignSearch(e.target.value)}
              className="h-9"
              autoFocus
            />
          </div>

          <div className="flex-1 overflow-y-auto py-2 space-y-2 pr-1 min-h-0">
            <GroupedTaskList
              tasks={tasks
                .filter((t) => !t.archived_at && !t.worktree_path)
                .filter((t) => t.title.toLowerCase().includes(assignSearch.toLowerCase()))}
              onTaskClick={(task) => {
                void handleAssignToTask(task.id)
              }}
              tooltip="Assign to this task"
            />
            {tasks.filter((t) => !t.archived_at && !t.worktree_path).length > 0 &&
              tasks
                .filter((t) => !t.archived_at && !t.worktree_path)
                .filter((t) => t.title.toLowerCase().includes(assignSearch.toLowerCase()))
                .length === 0 && (
                <p className="text-sm text-muted-foreground italic text-center py-8">
                  No matching tasks found.
                </p>
              )}
            {tasks.filter((t) => !t.archived_at && !t.worktree_path).length === 0 && (
              <div className="flex flex-col items-center justify-center py-8 text-center space-y-2">
                <p className="text-sm text-muted-foreground italic">No available tasks to link.</p>
                <p className="text-xs text-muted-foreground/60">
                  All active tasks already have a worktree assigned.
                </p>
              </div>
            )}
          </div>
          <AlertDialogFooter className="shrink-0 pt-2 border-t">
            <AlertDialogCancel>Cancel</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
})
