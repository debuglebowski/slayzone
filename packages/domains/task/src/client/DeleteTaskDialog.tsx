import { useMutation } from '@tanstack/react-query'
import { useTRPC } from './trpc'
import type { Task } from '@slayzone/task-contracts'
import { reportDeleteTaskError, settleDeleteTaskResult } from './deleteTaskResult'
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
  /** Runs only once the task is actually deleted. */
  onDeleted: () => void
  /**
   * Performs the delete, telling the user how it ended and rejecting when the
   * task was not deleted. Without it the dialog deletes and reports itself.
   */
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

  // Delete is permanent: a refusal or failure must reach the user, never vanish as
  // an unhandled rejection, and `onDeleted` must not run for a task that still exists.
  const deleteAndReport = async (taskId: string): Promise<void> => {
    if (onDeleteTask) await onDeleteTask(taskId)
    else settleDeleteTaskResult(await deleteTask.mutateAsync({ id: taskId }))
  }
  const handleDelete = (): void => {
    if (!task) return
    deleteAndReport(task.id).then(onDeleted, reportDeleteTaskError)
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Task</AlertDialogTitle>
          <AlertDialogDescription>
            Permanently delete "{task?.title}" and its SlayZone files and history? This cannot be
            undone.
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
