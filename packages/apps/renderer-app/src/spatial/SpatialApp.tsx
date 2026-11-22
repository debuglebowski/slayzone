import { useCallback, useMemo, useState } from 'react'
import { useTasksData } from '@slayzone/tasks/client'
import { HomeContainer } from '@slayzone/home/client'
import { TaskDetailView } from '../TaskDetailView'
import { SpatialLauncher } from './SpatialLauncher'
import { SpatialPanelControl } from './SpatialPanelControl'
import { spatialBridge, type SpatialBridge } from './spatial-bridge'
import { spatialTaskPanels, type SpatialRoute, type SpatialTaskPanel } from './spatial-route'
import { supportsSpatialHandoff, useSpatialPanel } from './useSpatialPanel'

const panelLabels: Record<SpatialTaskPanel, string> = {
  terminal: 'Terminal',
  settings: 'Task details'
}

function Centered({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}

function SpatialTask({
  route,
  data,
  bridge,
  openTask
}: {
  route: Extract<SpatialRoute, { panel: 'task' | 'panel' }>
  data: ReturnType<typeof useTasksData>
  bridge: SpatialBridge
  openTask: (taskId: string) => void
}): React.JSX.Element {
  const [handoffFailed, setHandoffFailed] = useState(false)
  const onHandoffError = useCallback(() => setHandoffFailed(true), [])
  const only = route.panel === 'panel' ? route.view : undefined
  const supported = supportsSpatialHandoff()
  const hasTerminal = useSpatialPanel(
    route.taskId,
    'terminal',
    !only ? 'docked' : only === 'terminal' ? 'detached' : 'inactive',
    onHandoffError
  )
  const hasDetails = useSpatialPanel(
    route.taskId,
    'settings',
    !only ? 'docked' : only === 'settings' ? 'detached' : 'inactive',
    onHandoffError
  )
  const layout = useMemo(
    () =>
      only
        ? { only }
        : {
            hide: spatialTaskPanels.filter((panel) =>
              panel === 'terminal' ? !hasTerminal : !hasDetails
            )
          },
    [only, hasTerminal, hasDetails]
  )
  const taskTitle = data.tasks.find((task) => task.id === route.taskId)?.title ?? 'Task'
  const waiting = only && !(only === 'terminal' ? hasTerminal : hasDetails)

  return (
    <div className="flex h-full flex-col">
      <div className="relative z-10 flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-background px-4 py-2">
        {route.group && (
          <span className="text-sm font-medium text-muted-foreground">{route.group.name}</span>
        )}
        {only ? (
          <>
            <h1 className="min-w-0 flex-1 truncate text-sm font-medium">
              {taskTitle} · {panelLabels[only]}
            </h1>
            <button
              type="button"
              className="min-h-11 rounded-lg border border-border px-3 text-sm hover:bg-accent"
              onClick={() => {
                if (bridge.isNative) openTask(route.taskId)
                bridge.close()
              }}
            >
              Return panel to task
            </button>
          </>
        ) : supported && !handoffFailed ? (
          spatialTaskPanels.map((panel) => (
            <SpatialPanelControl
              key={panel}
              label={panelLabels[panel]}
              onDetach={() =>
                bridge.open(
                  { panel: 'panel', taskId: route.taskId, view: panel, group: route.group },
                  `${taskTitle} · ${panelLabels[panel]}`
                )
              }
            />
          ))
        ) : (
          <span className="text-sm text-muted-foreground" role="status">
            {handoffFailed
              ? 'Panel handoff is unavailable.'
              : 'Detaching panels requires a secure connection.'}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {waiting ? (
          <Centered>
            {handoffFailed || !supported
              ? 'Could not attach this panel.'
              : 'Waiting for the panel…'}
          </Centered>
        ) : (
          <TaskDetailView
            data={data}
            taskId={route.taskId}
            onClose={bridge.close}
            onNavigateToTask={openTask}
            zenMode={!!only}
            hasShortcutFocus={!only}
            windowLayout={layout}
          />
        )}
      </div>
    </div>
  )
}

export function SpatialApp({ route }: { route: SpatialRoute }): React.JSX.Element {
  const data = useTasksData()
  const bridge = spatialBridge()

  if (route.panel === 'launcher' && data.boardStatus === 'success') {
    return <SpatialLauncher projects={data.projects} bridge={bridge} />
  }

  const group = route.panel === 'launcher' ? undefined : route.group
  const openTask = (taskId: string): void => {
    const task = data.tasks.find((item) => item.id === taskId)
    const route: SpatialRoute = group ? { panel: 'task', taskId, group } : { panel: 'task', taskId }
    bridge.open(route, task?.title ?? 'Task')
  }

  const content = (): React.JSX.Element => {
    if (data.boardStatus === 'error') {
      return (
        <Centered>Couldn’t load SlayZone: {data.boardError?.message ?? 'unknown error'}</Centered>
      )
    }
    if (data.boardStatus === 'pending') return <Centered>Connecting…</Centered>
    if (route.panel === 'board') {
      if (!data.projects.some((project) => project.id === route.projectId)) {
        return <Centered>Project not found.</Centered>
      }
      return (
        <>
          {group && (
            <p className="shrink-0 border-b border-border px-4 py-2 text-sm text-muted-foreground">
              {group.name}
            </p>
          )}
          <div className="min-h-0 flex-1">
            <HomeContainer
              data={data}
              selectedProjectId={route.projectId}
              isActive
              onTaskClick={(task) => openTask(task.id)}
            />
          </div>
        </>
      )
    }
    if (route.panel === 'task' || route.panel === 'panel') {
      return <SpatialTask route={route} data={data} bridge={bridge} openTask={openTask} />
    }
    return <SpatialLauncher projects={data.projects} bridge={bridge} />
  }

  return <div className="flex h-svh flex-col bg-background text-foreground">{content()}</div>
}
