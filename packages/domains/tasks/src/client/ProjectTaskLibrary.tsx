import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Terminal, Trash2 } from 'lucide-react'
import { getHubIdForProject, useHubOwnershipStore } from '@slayzone/transport/client'
import { getStatusByCategory, getDefaultStatus, type Project } from '@slayzone/projects-contracts'
import type { Task } from '@slayzone/task-contracts'
import {
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

/** Persistent scratch terminals and recoverable deletions, scoped to their project's hub. */
export function ProjectTaskLibrary({
  project,
  tasks,
  onOpen,
  onUpdate,
  onDelete
}: ProjectTaskLibraryProps) {
  const ambientClient = useTRPCClient()
  const hubId = getHubIdForProject(project.id)
  const client = getClientForHub(hubId, ambientClient)
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'scratch' | 'trash'>('scratch')
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const scratch = tasks.filter((task) => task.project_id === project.id && task.is_temporary)
  const trash = useQuery({
    queryKey: ['project-task-trash', hubId, project.id],
    queryFn: () => client.task.getDeleted.query({ projectId: project.id }),
    enabled: open && view === 'trash',
    staleTime: 0
  })
  const refetchTrash = trash.refetch
  useEffect(() => {
    if (!open || view !== 'trash') return
    const sub = client.notify.onTasksChanged.subscribe(undefined, {
      onData: () => {
        void refetchTrash()
      }
    })
    return () => sub.unsubscribe()
  }, [client, open, view, refetchTrash])

  // Promise chain, not try/finally: the React Compiler skips functions with a `finally` clause.
  const run = (id: string, action: () => Promise<void>): Promise<void> => {
    setPending(id)
    setError(null)
    return Promise.resolve()
      .then(action)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setPending(null))
  }

  return (
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
            Scratch terminals stay saved when you close their tabs. Deleted tasks can be restored
            from Trash for 30 days.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2" role="group" aria-label="Task library view">
          <Button
            variant={view === 'scratch' ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={view === 'scratch'}
            onClick={() => setView('scratch')}
          >
            <Terminal className="mr-1.5 size-3.5" /> Scratch terminals
          </Button>
          <Button
            variant={view === 'trash' ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={view === 'trash'}
            onClick={() => setView('trash')}
          >
            <Trash2 className="mr-1.5 size-3.5" /> Trash
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {view === 'trash' && trash.isError && (
          <div role="alert" className="text-sm text-destructive">
            Couldn’t load Trash.{' '}
            <Button variant="ghost" size="sm" onClick={() => void trash.refetch()}>
              Retry
            </Button>
          </div>
        )}
        <div className="max-h-80 overflow-y-auto space-y-2">
          {view === 'trash' && trash.isPending ? (
            <p className="text-sm text-muted-foreground">Loading Trash…</p>
          ) : (
            (view === 'scratch' ? scratch : (trash.data ?? [])).map((task) => (
              <div key={task.id} className="flex items-center gap-2 rounded-md border p-2">
                <span className="min-w-0 flex-1 truncate text-sm" title={task.title}>
                  {task.title}
                </span>
                {view === 'scratch' ? (
                  <>
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
                      onClick={() =>
                        void run(task.id, async () => {
                          try {
                            await onDelete(task.id)
                          } catch (err) {
                            onUpdate(task)
                            throw err
                          }
                        })
                      }
                    >
                      Delete
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending !== null}
                    onClick={() =>
                      void run(task.id, async () => {
                        const restored = await client.task.restore.mutate({ id: task.id })
                        if (hubId) useHubOwnershipStore.getState().noteTaskHub(task.id, hubId)
                        onUpdate(restored)
                        await trash.refetch()
                      })
                    }
                  >
                    Restore
                  </Button>
                )}
              </div>
            ))
          )}
          {view === 'scratch' && scratch.length === 0 && (
            <p className="text-sm text-muted-foreground">No saved scratch terminals.</p>
          )}
          {view === 'trash' && trash.isSuccess && trash.data.length === 0 && (
            <p className="text-sm text-muted-foreground">Trash is empty.</p>
          )}
        </div>
        {pending && (
          <p role="status" className="text-sm text-muted-foreground">
            Saving…
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
