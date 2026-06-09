import { useMutation } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
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
import type { Project } from '@slayzone/projects/shared'

interface DeleteProjectDialogProps {
  project: Project | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeleted: () => void
}

export function DeleteProjectDialog({
  project,
  open,
  onOpenChange,
  onDeleted
}: DeleteProjectDialogProps) {
  const trpc = useTRPC()
  const deleteProject = useMutation(trpc.projects.delete.mutationOptions())
  const handleDelete = async () => {
    if (!project) return
    await deleteProject.mutateAsync({ id: project.id })
    onDeleted()
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Project</AlertDialogTitle>
          <AlertDialogDescription>
            This will permanently delete "{project?.name}" and all its tasks. This action cannot be
            undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            className="bg-destructive text-white hover:bg-destructive/90"
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
