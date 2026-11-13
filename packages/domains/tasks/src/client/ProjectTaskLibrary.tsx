import { useState } from 'react'
import { Terminal } from 'lucide-react'
import { getHubIdForProject } from '@slayzone/transport/client'
import { getStatusByCategory, getDefaultStatus, type Project } from '@slayzone/projects-contracts'
import type { Task } from '@slayzone/task-contracts'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@slayzone/ui'
import { getClientForHub, useTRPCClient } from './trpc'

interface ProjectTaskLibraryProps {
  project: Project
  tasks: Task[]
  onOpen: (task: Task) => void
  onUpdate: (task: Task) => void
  onDelete: (taskId: string) => Promise<void>
}

/** Persistent scratch terminals, scoped to their project's hub. Delete has no undo. */
export function ProjectTaskLibrary({
  project,
  tasks,
  onOpen,
  onUpdate,
  onDelete
}: ProjectTaskLibraryProps) {
  const ambientClient = useTRPCClient()
  const client = getClientForHub(getHubIdForProject(project.id), ambientClient)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<Task | null>(null)
  const scratch = tasks.filter((task) => task.project_id === project.id && task.is_temporary)
  const run = (id: string, action: () => Promise<void>): Promise<void> => {
    setPending(id)
    setError(null)
    return Promise.resolve()
      .then(action)
      .catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure))
      })
      .finally(() => setPending(null))
  }
  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs">
            <Terminal className="size-3.5" />
            Scratch terminals{scratch.length > 0 ? ` (${scratch.length})` : ''}
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{project.name}</DialogTitle>
            <DialogDescription>
              Scratch terminals stay saved when you close their tabs.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {scratch.map((task) => (
              <div
                key={task.id}
                className="flex items-center justify-between gap-3 rounded-md border p-3"
              >
                <p className="min-w-0 truncate text-sm font-medium">{task.title}</p>
                <div className="flex shrink-0 gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending !== null}
                    onClick={() => {
                      onOpen(task)
                      setOpen(false)
                    }}
                  >
                    Open
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending !== null}
                    onClick={() =>
                      void run(task.id, async () => {
                        const updated = await client.task.update.mutate({
                          id: task.id,
                          isTemporary: false,
                          status:
                            getStatusByCategory('started', project.columns_config) ??
                            getDefaultStatus(project.columns_config)
                        })
                        onUpdate(updated)
                      })
                    }
                  >
                    Save as task
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending !== null}
                    onClick={() => {
                      setError(null)
                      setDeleting(task)
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            ))}
            {scratch.length === 0 ? (
              <p className="text-sm text-muted-foreground">No saved scratch terminals.</p>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next && pending === null) setDeleting(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete terminal permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently erases “{deleting?.title}” and its SlayZone files and history. This
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending !== null}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending !== null}
              onClick={(event) => {
                event.preventDefault()
                if (deleting)
                  void run(deleting.id, async () => {
                    await onDelete(deleting.id)
                    setDeleting(null)
                  })
              }}
            >
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
