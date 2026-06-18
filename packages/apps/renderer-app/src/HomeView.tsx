// Chromium-fork Home view — incremental slice 1: ticket renderer + filtering +
// display. No tab system, no side panels (git/editor/processes/tests/automations)
// yet — those land in later slices. Composes the shared, Electron-free
// @slayzone/tasks UI; data flows over tRPC to the standalone sidecar (the same
// transport the Electron app uses post server-mode cutover).
//
// Reimplements the discardable inner shell of the app's HomeDetail (the panel
// orchestration HomeDetail adds is exactly what this slice omits), so HomeDetail
// itself is intentionally NOT lifted into a shared package — the reusable parts
// already live in @slayzone/tasks.
import { useState } from 'react'
import {
  useTasksData,
  useFilterState,
  applyFilters,
  getViewConfig,
  FilterBar,
  KanbanBoard,
  KanbanListView
} from '@slayzone/tasks/client'

export function HomeView(): React.JSX.Element {
  const data = useTasksData()
  const { tasks, projects, tags, taskTags, blockedTaskIds } = data

  const [pickedProjectId, setPickedProjectId] = useState('')
  // Default to the first project until the user picks one (the fork has no tab
  // store / persisted selection yet).
  const projectId = pickedProjectId || projects[0]?.id || ''
  const project = projects.find((p) => p.id === projectId)

  const [filter, setFilter] = useFilterState(projectId)
  const viewConfig = getViewConfig(filter)

  const projectTasks = projectId ? tasks.filter((t) => t.project_id === projectId) : []
  const projectTags = projectId ? tags.filter((t) => t.project_id === projectId) : tags
  const displayTasks = applyFilters(projectTasks, filter, taskTags, project?.columns_config)

  const onTaskMove = (taskId: string, newColumnId: string, targetIndex: number): void =>
    data.moveTask(taskId, newColumnId, targetIndex, viewConfig.groupBy)
  const onTaskBulkMove = (taskIds: string[], newColumnId: string, targetIndex: number): void =>
    data.bulkMove(taskIds, newColumnId, targetIndex, viewConfig.groupBy)

  if (projects.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-background text-muted-foreground">
        No projects yet.
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
        <select
          value={projectId}
          onChange={(e) => setPickedProjectId(e.target.value)}
          className="rounded-md border border-border bg-surface-2 px-2 py-1 text-sm text-foreground"
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="min-w-0 flex-1">
          <FilterBar
            filter={filter}
            onChange={setFilter}
            tags={projectTags}
            columns={project?.columns_config}
          />
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-hidden p-3">
        {filter.viewMode === 'list' ? (
          <KanbanListView
            tasks={displayTasks}
            columns={project?.columns_config}
            viewConfig={viewConfig}
            onTaskMove={onTaskMove}
            onTaskReorder={data.reorderTasks}
            cardProperties={filter.cardProperties}
            blockedTaskIds={blockedTaskIds}
            allProjects={projects}
            onUpdateTask={data.contextMenuUpdate}
            onArchiveTask={data.archiveTask}
            onDeleteTask={data.deleteTask}
            tags={projectTags}
            taskTags={taskTags}
          />
        ) : (
          <KanbanBoard
            tasks={displayTasks}
            columns={project?.columns_config}
            viewConfig={viewConfig}
            onTaskMove={onTaskMove}
            onTaskBulkMove={onTaskBulkMove}
            onTaskReorder={data.reorderTasks}
            cardProperties={filter.cardProperties}
            taskTags={taskTags}
            tags={projectTags}
            blockedTaskIds={blockedTaskIds}
            allProjects={projects}
            onUpdateTask={data.contextMenuUpdate}
            onBulkUpdateTasks={data.bulkContextMenuUpdate}
            onClearBlockers={data.clearBlockers}
            onArchiveTask={data.archiveTask}
            onDeleteTask={data.deleteTask}
            onBulkDeleteTasks={data.bulkDelete}
            onArchiveAllTasks={data.archiveTasks}
            selectionResetKey={projectId}
          />
        )}
      </main>
    </div>
  )
}
