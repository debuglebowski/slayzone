import { USABLE_PLACEMENT_STATUSES, type ProjectPlacement } from '@slayzone/computers/shared'
export type { PlacementStatus, ProjectPlacement } from '@slayzone/computers/shared'
import type { Project } from './types'

/**
 * Which computer a task's work runs on: the task's own choice, else the computer
 * the hub uses for its project. The same answer the hub reaches when it spawns the
 * task's agents, so the folder shown is the folder the agent gets.
 */
export function workComputerId(
  task: { computer_id?: string | null } | null | undefined,
  project: Pick<Project, 'resolved_computer_id'> | null | undefined
): string | null {
  return task?.computer_id ?? project?.resolved_computer_id ?? null
}

/** The hub's row for this project on this computer, any status. */
export function placementOn(
  project: Pick<Project, 'placements'> | null | undefined,
  computerId: string | null | undefined
): ProjectPlacement | null {
  if (!project) return null
  if (project.placements === undefined) {
    // A hub from before folders moved to computers (an older remote hub, a hub
    // process not yet restarted after an update) sends no placements, only its one
    // `path`: the folder it starts every agent in, whichever computer runs it.
    const { path } = project as { path?: unknown }
    return typeof path === 'string' && path !== ''
      ? { computer_id: computerId ?? '', path, status: 'ready' }
      : null
  }
  if (!computerId) return null
  return project.placements.find((p) => p.computer_id === computerId) ?? null
}

/**
 * The project's folder on this computer, or null when there is none an agent could
 * use there. A `pending` folder counts: the hub knows it and delivers it when the
 * computer connects — treating it as absent would ask the user to pick a folder
 * that is already chosen.
 */
export function projectRootOn(
  project: Pick<Project, 'placements'> | null | undefined,
  computerId: string | null | undefined
): string | null {
  const placement = placementOn(project, computerId)
  return placement && USABLE_PLACEMENT_STATUSES.includes(placement.status) ? placement.path : null
}

/** The project's folder on the computer the hub uses for it (project-wide views). */
export function defaultProjectRoot(
  project: Pick<Project, 'placements' | 'resolved_computer_id'> | null | undefined
): string | null {
  return projectRootOn(project, project?.resolved_computer_id)
}

/** The folder a task's work happens in, before any worktree or child repo. */
export function taskProjectRoot(
  task: { computer_id?: string | null } | null | undefined,
  project: Pick<Project, 'placements' | 'resolved_computer_id'> | null | undefined
): string | null {
  return projectRootOn(project, workComputerId(task, project))
}
