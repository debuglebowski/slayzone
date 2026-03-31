import { buildStatusOptions } from '@slayzone/ui'
import type { Project } from '@slayzone/projects/shared'
import type { AttentionTask } from './useAttentionTasks'

export interface GroupedAttentionTasks {
  label: string
  tasks: AttentionTask[]
}

export function groupAttentionTasksByStatus(
  attentionTasks: AttentionTask[],
  projects: Project[],
  filterCurrentProject: boolean,
  selectedProjectId: string
): GroupedAttentionTasks[] {
  const groups = new Map<string, {
    tasks: AttentionTask[]
    minOrder: number
    labelCounts: Map<string, number>
  }>()
  const projectStatusOptionsById = new Map(
    projects.map((project) => [project.id, buildStatusOptions(project.columns_config)])
  )
  const currentProjectOptions = selectedProjectId
    ? (projectStatusOptionsById.get(selectedProjectId) ?? buildStatusOptions(null))
    : buildStatusOptions(null)

  for (const item of attentionTasks) {
    const status = item.task.status
    const options = filterCurrentProject
      ? currentProjectOptions
      : (projectStatusOptionsById.get(item.task.project_id) ?? buildStatusOptions(null))
    const optionIndex = options.findIndex((option) => option.value === status)
    const label = optionIndex >= 0 ? options[optionIndex].label : status
    const order = optionIndex >= 0 ? optionIndex : Number.MAX_SAFE_INTEGER
    // Group by label so custom columns with the same name but different IDs
    // across projects are merged into a single group
    const existing = groups.get(label) ?? {
      tasks: [],
      minOrder: Number.MAX_SAFE_INTEGER,
      labelCounts: new Map<string, number>()
    }
    existing.tasks.push(item)
    existing.minOrder = Math.min(existing.minOrder, order)
    existing.labelCounts.set(label, (existing.labelCounts.get(label) ?? 0) + 1)
    groups.set(label, existing)
  }

  return [...groups.entries()]
    .map(([label, group]) => {
      return {
        label,
        tasks: group.tasks,
        order: group.minOrder
      }
    })
    .sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order
      return a.label.localeCompare(b.label)
    })
}
