import type { Task } from '@slayzone/task/shared'
import { getTrpcVanillaClient } from '@slayzone/transport/client'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@slayzone/ui'

interface DeleteTaskDialogProps {
  task: Task | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeleted: () => void
  onDeleteTask?: (taskId: string) => Promise<void>
}

export function DeleteTaskDialog({
  task,
  open,
  onOpenChange,
  onDeleted,
  onDeleteTask
}: DeleteTaskDialogProps): React.JSX.Element {
  const handleDelete = async (): Promise<void> => {
    if (!task) return
    if (onDeleteTask) {
      await onDeleteTask(task.id)
    } else {
      await getTrpcVanillaClient().task.delete.mutate({ id: task.id })
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
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
