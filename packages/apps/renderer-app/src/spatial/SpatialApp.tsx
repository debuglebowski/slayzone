// Spatial (visionOS POC) panel surface.
//
// Each spatial window renders exactly ONE of these panels — no sidebar, tabs
// or app chrome. Navigation never happens in place: opening a board or a task
// asks the host for a new window (spatial-bridge), so the user can place every
// panel freely in 3D. The board and task views are the same canonical
// components HomeView embeds.
import { useTasksData } from '@slayzone/tasks/client'
import { HomeContainer } from '@slayzone/home/client'
import { TaskDetailView } from '../TaskDetailView'
import { spatialBridge } from './spatial-bridge'
import type { SpatialRoute } from './spatial-route'

function Centered({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex h-svh items-center justify-center bg-background px-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}

export function SpatialApp({ route }: { route: SpatialRoute }): React.JSX.Element {
  const data = useTasksData()
  const bridge = spatialBridge()

  if (data.boardStatus === 'error') {
    return (
      <Centered>Couldn’t load SlayZone: {data.boardError?.message ?? 'unknown error'}</Centered>
    )
  }
  if (data.boardStatus === 'pending') return <Centered>Connecting…</Centered>

  const openTask = (taskId: string): void => {
    const task = data.tasks.find((t) => t.id === taskId)
    bridge.open({ panel: 'task', taskId }, task?.title ?? 'Task')
  }

  if (route.panel === 'board') {
    if (!data.projects.some((p) => p.id === route.projectId)) {
      return <Centered>Project not found.</Centered>
    }
    return (
      <div className="h-svh bg-background text-foreground">
        <HomeContainer
          data={data}
          selectedProjectId={route.projectId}
          isActive
          onTaskClick={(task) => openTask(task.id)}
        />
      </div>
    )
  }

  if (route.panel === 'task') {
    return (
      <div className="h-svh bg-background text-foreground">
        <TaskDetailView
          data={data}
          taskId={route.taskId}
          onClose={bridge.close}
          onNavigateToTask={openTask}
        />
      </div>
    )
  }

  return (
    <div className="flex h-svh flex-col gap-4 overflow-auto bg-background p-8 text-foreground">
      <h1 className="text-2xl font-semibold">Projects</h1>
      {data.projects.length === 0 ? (
        <p className="text-muted-foreground">No projects yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {data.projects.map((project) => (
            <li key={project.id}>
              <button
                type="button"
                className="w-full rounded-xl border border-border bg-card px-6 py-5 text-left text-lg hover:bg-accent"
                onClick={() => bridge.open({ panel: 'board', projectId: project.id }, project.name)}
              >
                {project.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
