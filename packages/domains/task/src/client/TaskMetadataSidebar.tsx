import { useState, useEffect } from 'react'
import type { Task } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'
import type { Tag } from '@slayzone/tags/shared'
import { ProjectStatusCard } from './ProjectStatusCard'
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

export function TaskMetadataSidebar({
  task,
  tags,
  taskTagIds,
  onUpdate,
  onTagsChange,
  onTagCreated
}: TaskMetadataSidebarProps): React.JSX.Element {
  const [allTasks, setAllTasks] = useState<Task[]>([])
  const [blockers, setBlockers] = useState<Task[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [addBlockerSearch, setAddBlockerSearch] = useState('')

  // Load all tasks and current blockers
  useEffect(() => {
    const loadData = async () => {
      const [tasks, currentBlockers, allProjects] = await Promise.all([
        window.api.db.getTasks(),
        window.api.taskDependencies.getBlockers(task.id),
        window.api.db.getProjects()
      ])
      setAllTasks(tasks.filter((t) => t.id !== task.id))
      setBlockers(currentBlockers)
      setProjects(allProjects)
      setAddBlockerSearch('')
    }
    loadData()
  }, [task.id])

  const columnsByProject = new Map(projects.map((project) => [project.id, project.columns_config]))
  const selectedProject = projects.find((project) => project.id === task.project_id)
  const columnsConfig = selectedProject?.columns_config

  return (
    <div className="space-y-2">
      <ProjectStatusCard task={task} onUpdate={onUpdate} columnsConfig={columnsConfig} />
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
