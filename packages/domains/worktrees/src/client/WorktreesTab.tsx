import { useState, useEffect, useCallback, useMemo, useImperativeHandle, forwardRef } from 'react'
import { useDialogStore } from '@slayzone/settings/client'
import {
  FolderGit2,
  GitBranch,
  TerminalSquare,
  Trash2,
  FolderSearch,
  Link,
  PlusCircle,
  MoreVertical,
  ChevronDown,
  ChevronRight
} from 'lucide-react'
import {
  Button,
  IconButton,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  cn,
  toast,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  Input,
  PriorityIcon
} from '@slayzone/ui'
import { type FilterState, groupTasksBy, getViewConfig, type Column } from '@slayzone/tasks'
import { resolveColumns } from '@slayzone/projects/shared'
import type { Task } from '@slayzone/task/shared'
import type { DetectedWorktree } from '../shared/types'
import { CreateWorktreeDialog } from './CreateWorktreeDialog'
import { useGitPanelContext } from './UnifiedGitPanel'

interface WorktreesTabProps {
  visible: boolean
  pollIntervalMs?: number
}

interface WorktreeNode extends DetectedWorktree {
  children: WorktreeNode[]
  task?: Task
  depth: number
}

export interface WorktreesTabHandle {
  openCreateDialog: () => void
}

export const WorktreesTab = forwardRef<WorktreesTabHandle, WorktreesTabProps>(function WorktreesTab({
  visible,
  pollIntervalMs = 5000
}, ref) {
  const {
    projectPath,
    tasks,
    activeTask,
    onUpdateTask
  } = useGitPanelContext()

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
    setExpandedPaths(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const fetchWorktrees = useCallback(async () => {
    if (!projectPath) return
    try {
      const detected = await window.api.git.detectWorktrees(projectPath)
      setWorktrees(detected)
    } catch { /* polling error */ }
  }, [projectPath])

  useEffect(() => {
    if (!visible || !projectPath) return
    setLoading(true)
    fetchWorktrees().finally(() => setLoading(false))
    const timer = setInterval(fetchWorktrees, pollIntervalMs)
    return () => clearInterval(timer)
  }, [visible, projectPath, pollIntervalMs, fetchWorktrees])

  // Optimized dirty status polling
  useEffect(() => {
    if (!visible || worktrees.length === 0) return

    const pollDirty = async () => {
      const activePath = activeTask?.worktree_path || (worktrees.find(wt => wt.isMain)?.path)
      
      // 1. Always prioritize active worktree
      if (activePath) {
        const isDirty = await window.api.git.isDirty(activePath)
        setDirtyStatuses(prev => {
          if (prev[activePath] === isDirty) return prev
          return { ...prev, [activePath]: isDirty }
        })
      }

      // 2. Stagger background worktrees (check one per poll)
      const backgroundWts = worktrees.filter(wt => wt.path !== activePath)
      if (backgroundWts.length > 0) {
        const randomWt = backgroundWts[Math.floor(Math.random() * backgroundWts.length)]
        const isDirty = await window.api.git.isDirty(randomWt.path)
        setDirtyStatuses(prev => {
          if (prev[randomWt.path] === isDirty) return prev
          return { ...prev, [randomWt.path]: isDirty }
        })
      }
    }

    pollDirty()
    const timer = setInterval(pollDirty, 10000) // Poll every 10s
    return () => clearInterval(timer)
  }, [visible, worktrees, activeTask?.worktree_path])

  // Build hierarchical tree structure
  const tree = useMemo(() => {
    const nodes: Map<string, WorktreeNode> = new Map()
    const activeTasks = tasks.filter(t => !t.archived_at)

    // Create initial nodes and map tasks
    worktrees.forEach(wt => {
      nodes.set(wt.branch || wt.path, {
        ...wt,
        children: [],
        depth: 0,
        task: activeTasks.find(t => t.worktree_path === wt.path)
      })
    })

    const rootNodes: WorktreeNode[] = []
    
    // Link nodes based on parent branch
    worktrees.forEach(wt => {
      const node = nodes.get(wt.branch || wt.path)!
      const parentBranch = node.task?.worktree_parent_branch
      
      let parentNode: WorktreeNode | undefined
      if (parentBranch) {
        // Try to find a worktree that has this branch checked out
        parentNode = Array.from(nodes.values()).find(n => n.branch === parentBranch)
      }

      if (parentNode && parentNode !== node) {
        parentNode.children.push(node)
      } else if (!wt.isMain) {
        // Find main repo to be the parent if no other parent found
        const main = Array.from(nodes.values()).find(n => n.isMain)
        if (main && main !== node) {
          main.children.push(node)
        } else {
          rootNodes.push(node)
        }
      } else {
        rootNodes.push(node)
      }
    })

    // Calculate depths
    const setDepth = (node: WorktreeNode, depth: number) => {
      node.depth = depth
      node.children.forEach(c => setDepth(c, depth + 1))
    }
    rootNodes.forEach(r => setDepth(r, 0))

    return rootNodes
  }, [worktrees, tasks])

  const handleRemoveWorktree = async (path: string) => {
    if (!projectPath) return
    try {
      await window.api.git.removeWorktree(projectPath, path)
      const task = tasks.find(t => t.worktree_path === path)
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
    return <div className="p-4 text-xs text-muted-foreground">Set a project path to see worktrees</div>
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-y-auto p-4 space-y-1">
        {loading && worktrees.length === 0 ? (
          <div className="text-xs text-muted-foreground py-4">Loading worktrees...</div>
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
        onCreated={() => { fetchWorktrees(); setCreateDialogOpen(false) }}
      />

      <AlertDialog open={!!deleteConfirmOpen} onOpenChange={(open) => !open && setDeleteConfirmOpen(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Worktree</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the worktree directory from disk. Uncommitted changes will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleteConfirmOpen && handleRemoveWorktree(deleteConfirmOpen)}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Task Assignment Dialog */}
      <AlertDialog open={!!assigningWorktree} onOpenChange={(open) => {
        if (!open) {
          setAssigningWorktree(null)
          setAssignSearch('')
        }
      }}>
        <AlertDialogContent className="max-w-md max-h-[80vh] flex flex-col">
          <AlertDialogHeader className="shrink-0">
            <AlertDialogTitle>Assign Worktree to Task</AlertDialogTitle>
            <AlertDialogDescription>
              Select an active task to link with worktree: <br/>
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
                .filter(t => !t.archived_at && !t.worktree_path)
                .filter(t => t.title.toLowerCase().includes(assignSearch.toLowerCase()))
              }
              onTaskClick={(task) => { void handleAssignToTask(task.id) }}
              tooltip="Assign to this task"
            />
            {tasks.filter(t => !t.archived_at && !t.worktree_path).length > 0 && 
             tasks.filter(t => !t.archived_at && !t.worktree_path).filter(t => t.title.toLowerCase().includes(assignSearch.toLowerCase())).length === 0 && (
              <p className="text-sm text-muted-foreground italic text-center py-8">No matching tasks found.</p>
            )}
            {tasks.filter(t => !t.archived_at && !t.worktree_path).length === 0 && (
              <div className="flex flex-col items-center justify-center py-8 text-center space-y-2">
                <p className="text-sm text-muted-foreground italic">No available tasks to link.</p>
                <p className="text-xs text-muted-foreground/60">All active tasks already have a worktree assigned.</p>
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

function GroupedTaskList({ 
  tasks, 
  tooltip,
  onTaskClick
}: { 
  tasks: Task[], 
  tooltip?: string
  onTaskClick?: (task: Task) => void | Promise<void>
}) {
  const { filter, projects, onTaskClick: contextOnTaskClick } = useGitPanelContext()
  const clickHandler = onTaskClick ?? contextOnTaskClick
  const groups = useMemo(() => {
    if (!filter) return [{ id: 'all', title: 'All Tasks', tasks }]
    const vc = getViewConfig(filter)
    // Find column config for current project
    const project = projects.find(p => tasks.some(t => t.project_id === p.id))
    return groupTasksBy(tasks, vc.groupBy, vc.sortBy, project?.columns_config)
  }, [tasks, filter, projects])

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => {
    const initial = new Set<string>()
    
    // Get column config to match categories
    const project = projects.find(p => tasks.some(t => t.project_id === p.id))
    const columns = resolveColumns(project?.columns_config)
    const vc = getViewConfig(filter || ({} as FilterState))

    groups.forEach(g => {
      // 1. If grouping by status, check workflow category
      if (!filter || vc.groupBy === 'status') {
        const col = columns.find(c => c.id === g.id)
        if (col && (col.category === 'started' || col.category === 'unstarted')) {
          initial.add(g.id)
          return
        }
      }

      // 2. Fallback to label matching for other group types (priority, etc)
      const title = g.title.toLowerCase()
      if (title.includes('started')) {
        initial.add(g.id)
      }
    })

    // If nothing matched, expand first non-empty group
    if (initial.size === 0 && groups.length > 0) {
      const firstWithTasks = groups.find(g => g.tasks.length > 0)
      if (firstWithTasks) initial.add(firstWithTasks.id)
    }
    return initial
  })

  const toggleGroup = useCallback((id: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // If only one group and it's "All Tasks" or similar, just render the list
  if (groups.length === 1 && (groups[0].id === 'all' || groups[0].id === 'active')) {
    return (
      <div className="space-y-2">
        {groups[0].tasks.map((task: Task) => (
          <TaskItem key={task.id} task={task} onClick={clickHandler} tooltip={tooltip} />
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {groups.filter((g: Column) => g.tasks.length > 0).map((group: Column) => {
        const isExpanded = expandedGroups.has(group.id)
        return (
          <div key={group.id} className="space-y-2">
            <button 
              onClick={() => toggleGroup(group.id)}
              className="flex items-center gap-2 w-full px-1 py-0.5 hover:bg-muted/30 rounded transition-colors group/group-header"
            >
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70 group-hover/group-header:text-foreground/80">
                {group.title}
              </span>
              <div className="h-px bg-border/30 flex-1" />
              <span className="text-[10px] font-medium text-muted-foreground/50">{group.tasks.length}</span>
              {isExpanded ? (
                <ChevronDown className="h-3 w-3 text-muted-foreground/50 group-hover/group-header:text-foreground/80" />
              ) : (
                <ChevronRight className="h-3 w-3 text-muted-foreground/50 group-hover/group-header:text-foreground/80" />
              )}
            </button>
            
            {isExpanded && (
              <div className="space-y-1.5 animate-in fade-in slide-in-from-top-1 duration-200">
                {group.tasks.map((task: Task) => (
                  <TaskItem key={task.id} task={task} onClick={clickHandler} tooltip={tooltip} />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function TaskItem({ 
  task, 
  onClick, 
  tooltip = 'Go to task'
}: { 
  task: Task
  onClick?: (task: Task) => void
  tooltip?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button 
          onClick={() => onClick?.(task)}
          className="flex items-center gap-2.5 w-full rounded-md border transition-all group/task px-2.5 py-2 bg-surface-3 text-sm text-foreground hover:border-primary/50 hover:bg-muted/50 shadow-sm"
        >
          <PriorityIcon priority={task.priority} className="h-3.5 w-3.5 shrink-0" />
          <TerminalSquare className="h-4 w-4 shrink-0 text-primary/70 group-hover/task:text-primary" />
          <span className="truncate flex-1 text-left font-medium">{task.title}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}

function renderTree(nodes: WorktreeNode[], expandedPaths: Set<string>, renderNode: (node: WorktreeNode) => React.ReactNode): React.ReactNode[] {
  return nodes.flatMap(node => [
    renderNode(node),
    ...renderTree(node.children, expandedPaths, renderNode)
  ])
}

function WorktreeCard({
  node,
  worktreeColor,
  isExpanded,
  onToggleExpand,
  onRemove,
  onAssign
}: {
  node: WorktreeNode
  worktreeColor?: string
  isExpanded: boolean
  onToggleExpand: () => void
  onRemove: () => void
  onAssign: () => void
}) {
  const { tasks, activeTask } = useGitPanelContext()
  const displayTitle = node.isMain ? 'Main Repository' : (node.branch || 'detached HEAD')
  const isActive = activeTask?.worktree_path === node.path || (node.isMain && !activeTask?.worktree_path && activeTask)

  const associatedTasks = useMemo(() => {
    return tasks.filter(t => {
      if (t.archived_at) return false
      if (node.isMain) return !t.worktree_path
      return t.worktree_path === node.path
    })
  }, [tasks, node.path, node.isMain])
  
  return (
    <div className="group relative">
      {/* Indentation arrow */}
      {node.depth > 0 && (
        <div 
          className="absolute top-0 bottom-0 left-0 flex items-start pt-[1.125rem]"
          style={{ transform: `translateX(${(node.depth - 1) * 20 + 6}px)` }}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" className="text-muted-foreground/30" fill="none">
            <path 
              d="M1 0 v6 c0 3 3 3 6 3 h2" 
              stroke="currentColor" 
              strokeWidth="1.5" 
              strokeLinecap="round" 
            />
            <path 
              d="M9 6.5 l4 2.5 l-4 2.5 Z" 
              fill="currentColor" 
            />
            <circle cx="1" cy="0" r="1.5" fill="currentColor" />
          </svg>
        </div>
      )}

      <div
        className={cn(
          "mb-1 rounded-lg border transition-all",
          isActive
            ? "border-primary/50 bg-primary/10 shadow-md ring-1 ring-primary/20"
            : node.isMain
              ? "border-primary/20 bg-primary/5 shadow-sm"
              : "border-border bg-surface-1 hover:border-border/80 hover:shadow-sm"
        )}
        style={{
          marginLeft: node.depth * 20,
          ...(worktreeColor && {
            borderLeftWidth: 3,
            borderLeftColor: worktreeColor,
          })
        }}
      >
        <div className="p-3 space-y-2">
          <div className="flex items-center gap-2">
            <div className={cn(
              "p-1.5 rounded-md border shrink-0 relative", 
              isActive ? "bg-primary/20 border-primary/30" : node.isMain ? "bg-primary/10 border-primary/20" : "bg-muted/50"
            )}>
              <FolderGit2 className={cn("h-3.5 w-3.5", (isActive || node.isMain) ? "text-primary" : "text-muted-foreground")} />
              {node.isDirty && (
                <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-orange-500 border-2 border-surface-1" title="Uncommitted changes" />
              )}
            </div>
            
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={cn("text-xs font-semibold truncate max-w-[180px]", isActive && "text-primary")}>{displayTitle}</span>
                {node.isMain && (
                  <>
                    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/20 text-primary font-bold uppercase shrink-0">Main</span>
                    <div className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground bg-muted/40 px-1.5 py-0.5 rounded border border-border/50 shrink-0">
                      <GitBranch className="h-2.5 w-2.5" />
                      <span>{node.branch}</span>
                    </div>
                  </>
                )}
                {isActive && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/20 text-primary font-bold uppercase shrink-0">Active</span>
                )}
              </div>
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground font-mono truncate">
                <span className="opacity-60">{node.path}</span>
              </div>
            </div>

            <div className="flex items-center gap-1">
              {associatedTasks.length > 0 && (
                <Button 
                  variant="ghost" 
                  size="sm" 
                  className={cn(
                    "h-7 px-2 gap-1.5 text-[10px] font-medium transition-colors",
                    isExpanded ? "bg-primary/10 text-primary hover:bg-primary/20" : "text-muted-foreground hover:bg-muted"
                  )}
                  onClick={onToggleExpand}
                >
                  {associatedTasks.length} {associatedTasks.length === 1 ? 'task' : 'tasks'}
                  {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                </Button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton aria-label="Worktree actions" variant="ghost" className="h-7 w-7 transition-opacity">
                    <MoreVertical className="h-3.5 w-3.5" />
                  </IconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem onClick={() => window.api.git.revealInFinder(node.path)}>
                    <FolderSearch className="h-3.5 w-3.5 mr-2" /> Reveal in Finder
                  </DropdownMenuItem>
                  {!node.task && (
                    <>
                      <DropdownMenuItem onClick={onAssign}>
                        <Link className="h-3.5 w-3.5 mr-2" /> Assign to Task
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => useDialogStore.getState().openCreateTask()}>
                        <PlusCircle className="h-3.5 w-3.5 mr-2" /> Create Task from here
                      </DropdownMenuItem>
                    </>
                  )}
                  {!node.isMain && (
                    <DropdownMenuItem className="text-destructive" onClick={onRemove}>
                      <Trash2 className="h-3.5 w-3.5 mr-2" /> Remove Worktree
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {isExpanded && associatedTasks.length > 0 && (
            <div className="mt-2 pl-[34px] space-y-2">
              <GroupedTaskList tasks={associatedTasks} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
