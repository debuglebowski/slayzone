import { useMutation } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import type { Task } from '@slayzone/task/shared'
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
  const trpc = useTRPC()
  const deleteTask = useMutation(trpc.task.delete.mutationOptions())

  const handleDelete = async (): Promise<void> => {
    if (!task) return
    if (onDeleteTask) {
      await onDeleteTask(task.id)
    } else {
      await deleteTask.mutateAsync({ id: task.id })
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
