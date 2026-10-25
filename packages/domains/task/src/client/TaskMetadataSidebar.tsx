import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import type { Task } from '@slayzone/task/shared'
import type { Tag } from '@slayzone/tags/shared'
import { ProjectStatusCard } from './ProjectStatusCard'
import { ComputerCard } from './ComputerCard'
import { PriorityDueDateCard } from './PriorityDueDateCard'
import { SnoozeProgressCard } from './SnoozeProgressCard'
import { TagsCard } from './TagsCard'
import { BlockedBySection } from './BlockedBySection'

export { BlockerStatusIcon } from './BlockerStatusIcon'
export { ExternalSyncCard, LinearCard } from './ExternalSyncCard'

interface TaskMetadataSidebarProps {
  task: Task
  tags: Tag[]
  taskTagIds: string[]
  onUpdate: (task: Task) => void
  onTagsChange: (tagIds: string[]) => void
  onTagCreated?: (tag: Tag) => void
}

const selectTasks = (board: { tasks: Task[] }): Task[] => board.tasks

export function TaskMetadataSidebar({
  task,
  tags,
  taskTagIds,
  onUpdate,
  onTagsChange,
  onTagCreated
}: TaskMetadataSidebarProps): React.JSX.Element {
  const trpc = useTRPC()
  const [blockers, setBlockers] = useState<Task[]>([])
  const [addBlockerSearch, setAddBlockerSearch] = useState('')

  // Every task (the blocker picker), current blockers, and projects. The task list
  // is read from the board query the app already holds (`task.loadBoardData` — the
  // same rows `task.getAll` returns) rather than a second multi-MB `getAll` cache
  // entry refetched on every mount and focus. Same staleTime as the app's board
  // observer; the board is kept fresh by the app's tasks-changed handling.
  const allTasksQuery = useQuery(
    trpc.task.loadBoardData.queryOptions(undefined, { staleTime: 30_000, select: selectTasks })
  )
  const blockersQuery = useQuery(trpc.task.getBlockers.queryOptions({ taskId: task.id }))
  const projectsQuery = useQuery(trpc.projects.list.queryOptions())

  const allTasks = (allTasksQuery.data ?? []).filter((t) => t.id !== task.id)
  const projects = projectsQuery.data ?? []

  // Mirror fetched blockers into local state so BlockedBySection can optimistically
  // add/remove via setBlockers. Reset the search box on task change.
  useEffect(() => {
    setAddBlockerSearch('')
  }, [task.id])
  useEffect(() => {
    if (blockersQuery.data) setBlockers(blockersQuery.data)
  }, [blockersQuery.data])

  const columnsByProject = new Map(projects.map((project) => [project.id, project.columns_config]))
  const selectedProject = projects.find((project) => project.id === task.project_id)
  const columnsConfig = selectedProject?.columns_config

  // Computer computer bindings (hub/computer split). `computer_id` / `default_computer_id`
  // are v149 columns present at runtime (parseTask/parseProject spread the row)
  // but not yet on the shared Task/Project types — read via a narrow local cast.
  const taskComputerId = (task as { computer_id?: string | null }).computer_id ?? null
  const projectDefaultComputerId =
    (selectedProject as { default_computer_id?: string | null } | undefined)?.default_computer_id ??
    null

  return (
    <div className="space-y-2">
      <ProjectStatusCard task={task} onUpdate={onUpdate} columnsConfig={columnsConfig} />
      <ComputerCard
        taskId={task.id}
        taskComputerId={taskComputerId}
        projectDefaultComputerId={projectDefaultComputerId}
      />
      <PriorityDueDateCard task={task} onUpdate={onUpdate} />
      <SnoozeProgressCard task={task} onUpdate={onUpdate} columnsConfig={columnsConfig} />
      <TagsCard
        taskId={task.id}
        projectId={task.project_id}
        tags={tags}
        taskTagIds={taskTagIds}
        onTagsChange={onTagsChange}
        onTagCreated={onTagCreated}
      />
      <BlockedBySection
        task={task}
        onUpdate={onUpdate}
        blockers={blockers}
        setBlockers={setBlockers}
        allTasks={allTasks}
        columnsByProject={columnsByProject}
        addBlockerSearch={addBlockerSearch}
        setAddBlockerSearch={setAddBlockerSearch}
      />
    </div>
  )
}
