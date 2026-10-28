import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import { useDepsChanged } from '@slayzone/ui'
import type { Task } from '@slayzone/task-contracts'
import type { Tag } from '@slayzone/tags/shared'
import { ProjectStatusCard } from './ProjectStatusCard'
import { ComputerCard } from './ComputerCard'
import { PriorityDueDateCard } from './PriorityDueDateCard'
import { SnoozeProgressCard } from './SnoozeProgressCard'
import { TagsCard } from './TagsCard'
import { BlockedBySection } from './BlockedBySection'

export { BlockerStatusIcon } from './BlockerStatusIcon'

interface TaskMetadataSidebarProps {
  task: Task
  tags: Tag[]
  taskTagIds: string[]
  onUpdate: (task: Task) => void
  onTagsChange: (tagIds: string[]) => void
  onTagCreated?: (tag: Tag) => void
}

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

  // Current blockers and projects. The blocker picker's list of every task is read
  // inside the picker (BlockedBySection), only while it is open.
  const blockersQuery = useQuery(trpc.task.getBlockers.queryOptions({ taskId: task.id }))
  const projectsQuery = useQuery(trpc.projects.list.queryOptions())

  const projects = projectsQuery.data ?? []

  // Mirror fetched blockers into local state so BlockedBySection can optimistically
  // add/remove via setBlockers. Reset the search box on task change (while rendering,
  // so no commit shows the previous task's search).
  const [searchTaskId, setSearchTaskId] = useState(task.id)
  if (searchTaskId !== task.id) {
    setSearchTaskId(task.id)
    setAddBlockerSearch('')
  }
  // Re-mirror only when the query hands over NEW data, adjusted while rendering. An
  // effect also re-ran on every tab re-show (<Activity>) and reverted an add/remove
  // made here to the older cached list.
  const blockersDataChanged = useDepsChanged([blockersQuery.data], true)
  if (blockersDataChanged && blockersQuery.data) setBlockers(blockersQuery.data)

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
        columnsByProject={columnsByProject}
        addBlockerSearch={addBlockerSearch}
        setAddBlockerSearch={setAddBlockerSearch}
      />
    </div>
  )
}
