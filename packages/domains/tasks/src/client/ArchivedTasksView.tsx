import { useState, useEffect } from 'react'
import { ArrowLeft, Undo2 } from 'lucide-react'
import type { Task } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'
import { Button } from '@slayzone/ui'

interface ArchivedTasksViewProps {
  onBack: () => void
  onTaskClick: (taskId: string) => void
}

export function ArchivedTasksView({
  onBack,
  onTaskClick
}: ArchivedTasksViewProps): React.JSX.Element {
  const [tasks, setTasks] = useState<Task[]>([])
  const [projects, setProjects] = useState<Map<string, Project>>(new Map())
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const loadData = async (): Promise<void> => {
      const [archivedTasks, allProjects] = await Promise.all([
        window.api.db.getArchivedTasks(),
        window.api.db.getProjects()
      ])
      setTasks(archivedTasks)
      setProjects(new Map(allProjects.map((p) => [p.id, p])))
      setLoading(false)
    }
    loadData()
  }, [])

  const handleUnarchive = async (taskId: string): Promise<void> => {
    await window.api.db.unarchiveTask(taskId)
    setTasks(tasks.filter((t) => t.id !== taskId))
  }

  if (loading) {
    return <div className="flex h-screen items-center justify-center">Loading...</div>
  }

  return (
    <div className="min-h-screen">
      {/* Draggable region for window movement - clears traffic lights */}
      <div className="h-10 window-drag-region" />
      {/* Header */}
      <header className="sticky top-10 z-10 border-b bg-background p-4">
        <div className="flex items-center gap-4 window-no-drag">
          <Button variant="ghost" size="icon" onClick={onBack} aria-label="Go back">
            <ArrowLeft className="size-5" />
          </Button>
          <h1 className="text-2xl font-bold">Archived Tasks</h1>
        </div>
      </header>

      {/* Content */}
      <main className="mx-auto max-w-4xl p-6">
        {tasks.length === 0 ? (
          <div className="text-center text-muted-foreground py-12">No archived tasks</div>
        ) : (
          <div className="space-y-2">
            {tasks.map((task) => {
              const project = projects.get(task.project_id)
              return (
                <div
                  key={task.id}
                  className="group flex items-center gap-3 rounded-lg border p-3 hover:bg-muted/50"
                >
                  {/* Project color dot */}
                  {project && (
                    <div
                      className="size-3 rounded-full shrink-0"
                      style={{ backgroundColor: project.color }}
                      title={project.name}
                    />
                  )}

                  {/* Task title - clickable */}
                  <button
                    className="flex-1 text-left truncate hover:underline"
                    onClick={() => onTaskClick(task.id)}
                  >
                    {task.title}
                  </button>

                  {/* Archived date */}
                  {task.archived_at && (
                    <span className="text-sm text-muted-foreground shrink-0">
                      {new Date(task.archived_at).toLocaleDateString()}
                    </span>
                  )}

                  {/* Unarchive button */}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="opacity-0 group-hover:opacity-100 shrink-0"
                    onClick={() => handleUnarchive(task.id)}
                    title="Restore task"
                    aria-label="Restore task"
                  >
                    <Undo2 className="size-4" />
                  </Button>
                </div>
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}
