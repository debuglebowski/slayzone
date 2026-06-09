import { useMemo } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import { useDialogStore } from '@slayzone/settings/client'
import {
  FolderGit2,
  GitBranch,
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
  cn
} from '@slayzone/ui'
import { useGitPanelContext } from './git-panel-context'
import type { WorktreeNode } from './WorktreesTab.types'
import { GroupedTaskList } from './GroupedTaskList'

export function WorktreeCard({
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
  const trpc = useTRPC()
  const revealInFinderMutation = useMutation(trpc.worktrees.revealInFinder.mutationOptions())
  const { tasks, activeTask } = useGitPanelContext()
  const displayTitle = node.isMain ? 'Main Repository' : node.branch || 'detached HEAD'
  const isActive =
    activeTask?.worktree_path === node.path ||
    (node.isMain && !activeTask?.worktree_path && activeTask)

  const associatedTasks = useMemo(() => {
    return tasks.filter((t) => {
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
          <svg
            width="20"
            height="20"
            viewBox="0 0 20 20"
            className="text-muted-foreground/30"
            fill="none"
          >
            <path
              d="M1 0 v6 c0 3 3 3 6 3 h2"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            <path d="M9 6.5 l4 2.5 l-4 2.5 Z" fill="currentColor" />
            <circle cx="1" cy="0" r="1.5" fill="currentColor" />
          </svg>
        </div>
      )}

      <div
        className={cn(
          'mb-1 rounded-lg border transition-all',
          isActive
            ? 'border-primary/50 bg-primary/10 shadow-md ring-1 ring-primary/20'
            : node.isMain
              ? 'border-primary/20 bg-primary/5 shadow-sm'
              : 'border-border bg-surface-1 hover:border-border/80 hover:shadow-sm'
        )}
        style={{
          marginLeft: node.depth * 20,
          ...(worktreeColor && {
            borderLeftWidth: 3,
            borderLeftColor: worktreeColor
          })
        }}
      >
        <div className="p-3 space-y-2">
          <div className="flex items-center gap-2">
            <div
              className={cn(
                'p-1.5 rounded-md border shrink-0 relative',
                isActive
                  ? 'bg-primary/20 border-primary/30'
                  : node.isMain
                    ? 'bg-primary/10 border-primary/20'
                    : 'bg-muted/50'
              )}
            >
              <FolderGit2
                className={cn(
                  'h-3.5 w-3.5',
                  isActive || node.isMain ? 'text-primary' : 'text-muted-foreground'
                )}
              />
              {node.isDirty && (
                <span
                  className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-orange-500 border-2 border-surface-1"
                  title="Uncommitted changes"
                />
              )}
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className={cn(
                    'text-xs font-semibold truncate max-w-[180px]',
                    isActive && 'text-primary'
                  )}
                >
                  {displayTitle}
                </span>
                {node.isMain && (
                  <>
                    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/20 text-primary font-bold uppercase shrink-0">
                      Main
                    </span>
                    <div className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground bg-muted/40 px-1.5 py-0.5 rounded border border-border/50 shrink-0">
                      <GitBranch className="h-2.5 w-2.5" />
                      <span>{node.branch}</span>
                    </div>
                  </>
                )}
                {isActive && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/20 text-primary font-bold uppercase shrink-0">
                    Active
                  </span>
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
                    'h-7 px-2 gap-1.5 text-[10px] font-medium transition-colors',
                    isExpanded
                      ? 'bg-primary/10 text-primary hover:bg-primary/20'
                      : 'text-muted-foreground hover:bg-muted'
                  )}
                  onClick={onToggleExpand}
                >
                  {associatedTasks.length} {associatedTasks.length === 1 ? 'task' : 'tasks'}
                  {isExpanded ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                </Button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton
                    aria-label="Worktree actions"
                    variant="ghost"
                    className="h-7 w-7 transition-opacity"
                  >
                    <MoreVertical className="h-3.5 w-3.5" />
                  </IconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem
                    onClick={() => revealInFinderMutation.mutate({ path: node.path })}
                  >
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
