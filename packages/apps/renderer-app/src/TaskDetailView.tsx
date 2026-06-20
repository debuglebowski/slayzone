// Chromium-fork Task Detail — the real canonical @slayzone/task TaskDetailPage,
// fed the SAME lifted useTasksData() instance the sidebar + Home share (passed
// as `data`, never a duplicate query). TaskDetailDataLoader suspends on the
// taskDetailCache until task data resolves, so the caller wraps it in Suspense.
//
// Archive / delete / convert ride the shared board-data instance: archive/delete
// are useTasksData's own optimistic + tRPC mutations; convert mirrors the Electron
// App.tsx handleConvertTask (promote a temporary task to a real one). Every task
// tRPC mutation also fires notify.onTasksChanged, so the board self-refreshes
// across consumers — the optimistic data.* writes just make it snappy. Remaining
// app-chrome callbacks (terminal-focus / panel-visibility lift) aren't ported yet.
// Navigation (back / close / open sibling task) is driven by the fork's
// selected-task router in HomeView.
import { Suspense, useCallback } from 'react'
import type { useTasksData } from '@slayzone/tasks/client'
import type { Task } from '@slayzone/task/shared'
import { TaskShell } from '@slayzone/task/client/TaskShell'
import { TaskDetailDataLoader } from '@slayzone/task/client/TaskDetailDataLoader'
import { useTRPCClient } from '@slayzone/transport/client'
import { getDefaultStatus, getStatusByCategory } from '@slayzone/projects/shared'

interface TaskDetailViewProps {
  /** The ONE shared board-data instance, lifted in HomeView. */
  data: ReturnType<typeof useTasksData>
  taskId: string
  /** Whether this tab is the focused one — drives terminal focus / live panels.
   *  Inactive tabs stay mounted (state preserved) but dormant. */
  isActive?: boolean
  /** Owns keyboard shortcuts. Defaults to `isActive`. In explode mode every tile
   *  is active but only the focused cell has this true. */
  hasShortcutFocus?: boolean
  /** Tight layout for an explode-grid cell. */
  compact?: boolean
  /** Zen mode — the canonical page hides its own surplus chrome. */
  zenMode?: boolean
  /** Clear the fork's open-task selection (back / close the task). */
  onClose: () => void
  /** Open a sibling task (e.g. a blocker / parent link). */
  onNavigateToTask: (taskId: string) => void
}

export function TaskDetailView({
  data,
  taskId,
  isActive = true,
  hasShortcutFocus,
  compact,
  zenMode,
  onClose,
  onNavigateToTask
}: TaskDetailViewProps): React.JSX.Element {
  // Live task/project from the shared board data (source of truth); the loader's
  // initialData fills the cold-load window.
  const task: Task | null = data.tasks.find((t) => t.id === taskId) ?? null
  const project = data.projects.find((p) => p.id === task?.project_id) ?? null

  const trpcClient = useTRPCClient()
  const { projects, updateTask } = data

  // Promote a temporary task to a real one — mirrors Electron App.tsx
  // handleConvertTask: reset the title, move it into a "started" status, clear
  // the temporary flag, then patch the shared board state.
  const handleConvertTask = useCallback(
    async (t: Task): Promise<Task> => {
      const proj = projects.find((p) => p.id === t.project_id)
      const converted = await trpcClient.task.update.mutate({
        id: t.id,
        title: 'Untitled task',
        status:
          getStatusByCategory('started', proj?.columns_config) ??
          getDefaultStatus(proj?.columns_config),
        isTemporary: false
      })
      updateTask(converted)
      return converted
    },
    [projects, updateTask, trpcClient]
  )

  return (
    <Suspense fallback={<TaskShell />}>
      <TaskDetailDataLoader
        taskId={taskId}
        task={task}
        project={project}
        isActive={isActive}
        hasShortcutFocus={hasShortcutFocus}
        compact={compact}
        zenMode={zenMode}
        onBack={onClose}
        onCloseTab={onClose}
        onTaskUpdated={data.updateTask}
        onNavigateToTask={onNavigateToTask}
        onArchiveTask={data.archiveTask}
        onDeleteTask={data.deleteTask}
        onConvertTask={handleConvertTask}
      />
    </Suspense>
  )
}
