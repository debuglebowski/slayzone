import { useEffect, useState } from 'react'
import type { Task } from '@slayzone/task/shared'
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

interface DeleteTaskDialogProps {
  task: Task | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeleted: () => void
  onDeleteTask?: (taskId: string, options?: { deleteFeatureDir?: boolean }) => Promise<void>
}

export function DeleteTaskDialog({
  task,
  open,
  onOpenChange,
  onDeleted,
  onDeleteTask
}: DeleteTaskDialogProps): React.JSX.Element {
  const [featureDirPath, setFeatureDirPath] = useState<string | null>(null)
  const [deleteFeatureDir, setDeleteFeatureDir] = useState(false)

  useEffect(() => {
    if (!open || !task) {
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
  }, [open, task?.id])

  const handleDelete = async (): Promise<void> => {
    if (!task) return
    const deleteOptions = featureDirPath ? { deleteFeatureDir } : undefined
    if (onDeleteTask) {
      await onDeleteTask(task.id, deleteOptions)
    } else {
      await window.api.db.deleteTask(task.id, deleteOptions)
    }
    onDeleted()
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Task</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete "{task?.title}"? This action cannot be undone.
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
          <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
