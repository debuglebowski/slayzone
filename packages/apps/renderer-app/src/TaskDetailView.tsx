// Chromium-fork Task Detail — the real canonical @slayzone/task TaskDetailPage,
// fed the SAME lifted useTasksData() instance the sidebar + Home share (passed
// as `data`, never a duplicate query). TaskDetailDataLoader suspends on the
// taskDetailCache until task data resolves, so the caller wraps it in Suspense.
//
// App-chrome callbacks the Electron shell supplies but the fork doesn't have yet
// (archive/delete/convert/terminal-focus/panel-visibility lift) are stubbed as
// module-level NOOPs → referentially stable. Navigation (back / close / open
// sibling task) is driven by the fork's selected-task router in HomeView.
import { Suspense } from 'react'
import type { useTasksData } from '@slayzone/tasks/client'
import type { Task } from '@slayzone/task/shared'
import { TaskShell } from '@slayzone/task/client/TaskShell'
import { TaskDetailDataLoader } from '@slayzone/task/client/TaskDetailDataLoader'

const NOOP_ARCHIVE = async (): Promise<void> => {}
const NOOP_DELETE = async (): Promise<void> => {}
const NOOP_CONVERT = async (): Promise<void> => {}

interface TaskDetailViewProps {
  /** The ONE shared board-data instance, lifted in HomeView. */
  data: ReturnType<typeof useTasksData>
  taskId: string
  /** Clear the fork's open-task selection (back / close the task). */
  onClose: () => void
  /** Open a sibling task (e.g. a blocker / parent link). */
  onNavigateToTask: (taskId: string) => void
}

export function TaskDetailView({
  data,
  taskId,
  onClose,
  onNavigateToTask
}: TaskDetailViewProps): React.JSX.Element {
  // Live task/project from the shared board data (source of truth); the loader's
  // initialData fills the cold-load window.
  const task: Task | null = data.tasks.find((t) => t.id === taskId) ?? null
  const project = data.projects.find((p) => p.id === task?.project_id) ?? null

  return (
    <Suspense fallback={<TaskShell />}>
      <TaskDetailDataLoader
        taskId={taskId}
        task={task}
        project={project}
        isActive
        onBack={onClose}
        onCloseTab={onClose}
        onTaskUpdated={data.updateTask}
        onNavigateToTask={onNavigateToTask}
        onArchiveTask={NOOP_ARCHIVE}
        onDeleteTask={NOOP_DELETE}
        onConvertTask={NOOP_CONVERT}
      />
    </Suspense>
  )
}
