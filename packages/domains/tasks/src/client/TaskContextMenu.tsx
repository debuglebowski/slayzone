import { useEffect, useState } from 'react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  buildStatusOptions
} from '@slayzone/ui'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Checkbox
} from '@slayzone/ui'
import type { Task, TaskStatus } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'
import type { ColumnConfig } from '@slayzone/projects/shared'

interface TaskContextMenuProps {
  task: Task
  projects: Project[]
  columns?: ColumnConfig[] | null
  onUpdateTask: (taskId: string, updates: Partial<Task>) => void
  onArchiveTask: (taskId: string) => void
  onDeleteTask: (taskId: string, options?: { deleteFeatureDir?: boolean }) => void
  children: React.ReactNode
}

const PRIORITY_LABELS: Record<number, string> = {
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low',
  5: 'Someday'
}

export function TaskContextMenu({
  task,
  projects,
  columns,
  onUpdateTask,
  onArchiveTask,
  onDeleteTask,
  children
}: TaskContextMenuProps): React.JSX.Element {
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [featureDirPath, setFeatureDirPath] = useState<string | null>(null)
  const [deleteFeatureDir, setDeleteFeatureDir] = useState(false)
  const statusOptions = buildStatusOptions(columns)

  useEffect(() => {
    if (!deleteDialogOpen) {
      setFeatureDirPath(null)
      setDeleteFeatureDir(false)
      return
    }

    let cancelled = false
    void window.api.db.getTaskFeatureDetails(task.id)
      .then((details) => {
        if (cancelled) return
        const linkedDir = details?.featureDirPath ?? null
        setFeatureDirPath(linkedDir)
        setDeleteFeatureDir(false)
      })
      .catch(() => {
        if (cancelled) return
        setFeatureDirPath(null)
        setDeleteFeatureDir(false)
      })

    return () => {
      cancelled = true
    }
  }, [deleteDialogOpen, task.id])

  const handleStatusChange = (status: string): void => {
    onUpdateTask(task.id, { status: status as TaskStatus })
  }

  const handlePriorityChange = (priority: string): void => {
    onUpdateTask(task.id, { priority: parseInt(priority, 10) })
  }

  const handleProjectChange = (projectId: string): void => {
    onUpdateTask(task.id, { project_id: projectId })
  }

  const handleCopyTitle = async (): Promise<void> => {
    await navigator.clipboard.writeText(task.title)
  }

  const handleCopyLink = async (): Promise<void> => {
    await navigator.clipboard.writeText(`slayzone://task/${task.id}`)
  }

  const handleArchiveConfirm = (): void => {
    onArchiveTask(task.id)
    setArchiveDialogOpen(false)
  }

  const handleDeleteConfirm = (): void => {
    onDeleteTask(task.id, featureDirPath ? { deleteFeatureDir } : undefined)
    setDeleteDialogOpen(false)
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          {/* Status submenu */}
          <ContextMenuSub>
            <ContextMenuSubTrigger>Status</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuRadioGroup value={task.status} onValueChange={handleStatusChange}>
                {statusOptions.map((s) => (
                  <ContextMenuRadioItem key={s.value} value={s.value}>
                    {s.label}
                  </ContextMenuRadioItem>
                ))}
              </ContextMenuRadioGroup>
            </ContextMenuSubContent>
          </ContextMenuSub>

          {/* Priority submenu */}
          <ContextMenuSub>
            <ContextMenuSubTrigger>Priority</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuRadioGroup
                value={String(task.priority)}
                onValueChange={handlePriorityChange}
              >
                {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
                  <ContextMenuRadioItem key={value} value={value}>
                    {label}
                  </ContextMenuRadioItem>
                ))}
              </ContextMenuRadioGroup>
            </ContextMenuSubContent>
          </ContextMenuSub>

          <ContextMenuSeparator />

          {/* Move to project */}
          <ContextMenuSub>
            <ContextMenuSubTrigger>Move to</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuRadioGroup
                value={task.project_id}
                onValueChange={handleProjectChange}
              >
                {projects.map((p) => (
                  <ContextMenuRadioItem key={p.id} value={p.id}>
                    <span
                      className="inline-block w-2 h-2 rounded-full mr-2"
                      style={{ backgroundColor: p.color }}
                    />
                    {p.name}
                  </ContextMenuRadioItem>
                ))}
              </ContextMenuRadioGroup>
            </ContextMenuSubContent>
          </ContextMenuSub>

          {/* Copy submenu */}
          <ContextMenuSub>
            <ContextMenuSubTrigger>Copy</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem onSelect={handleCopyTitle}>Title</ContextMenuItem>
              <ContextMenuItem onSelect={handleCopyLink}>Link</ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>

          <ContextMenuSeparator />

          {/* Archive */}
          <ContextMenuItem onSelect={() => setArchiveDialogOpen(true)}>Archive</ContextMenuItem>

          {/* Delete */}
          <ContextMenuItem variant="destructive" onSelect={() => setDeleteDialogOpen(true)}>
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* Archive confirmation dialog */}
      <AlertDialog open={archiveDialogOpen} onOpenChange={setArchiveDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive Task</AlertDialogTitle>
            <AlertDialogDescription>
              Archive "{task.title}"? You can restore it later from the archive.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleArchiveConfirm}>Archive</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirmation dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Task</AlertDialogTitle>
            <AlertDialogDescription>
              Delete "{task.title}"? This cannot be undone.
            </AlertDialogDescription>
            {featureDirPath && (
              <label className="mt-3 flex items-start gap-2 text-sm text-foreground">
                <Checkbox
                  checked={deleteFeatureDir}
                  onCheckedChange={(checked) => setDeleteFeatureDir(checked === true)}
                />
                <span>
                  Also delete linked feature directory ({featureDirPath})
                </span>
              </label>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteConfirm}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
