import type { Project } from '@slayzone/projects-contracts'
import type { OtherHubProjects } from '@slayzone/task/client'
import { useFederationOrNull, useHubOwnershipStore } from '@slayzone/transport/client'
import { startCrossHubMove } from './cross-hub-moves'

/**
 * What the move dialog offers beyond the tasks' own hub: the other hubs' projects
 * (grouped, labelled) and how to start a move there. Nothing when the app has one
 * hub, or the tasks' hub is not known yet.
 */
export function useCrossHubMoveTargets(
  projects: readonly Project[],
  taskIds: readonly string[]
): {
  otherHubProjects: OtherHubProjects[]
  onMoveToOtherHub?: (input: {
    targetHubId: string
    targetProjectId: string
    includeSubtasks: boolean
  }) => Promise<void>
} {
  const federation = useFederationOrNull()
  const taskHub = useHubOwnershipStore((s) => s.hubIdByTask.get(taskIds[0] ?? ''))
  const hubIdByProject = useHubOwnershipStore((s) => s.hubIdByProject)
  if (!taskHub || !federation || federation.hubs.length < 2) return { otherHubProjects: [] }
  const otherHubProjects = federation.hubs
    .filter((h) => h.id !== taskHub)
    .map((h) => ({
      hubId: h.id,
      hubLabel: h.label,
      projects: projects
        .filter((p) => hubIdByProject.get(p.id) === h.id)
        .map((p) => ({ id: p.id, name: p.name, color: p.color }))
    }))
    .filter((h) => h.projects.length > 0)
  return {
    otherHubProjects,
    onMoveToOtherHub: async (input) => {
      await startCrossHubMove({ sourceHubId: taskHub, taskIds: [...taskIds], ...input })
    }
  }
}
