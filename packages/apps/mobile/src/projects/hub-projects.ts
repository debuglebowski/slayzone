/**
 * Every signed-in hub's projects, as plain data: grouped by hub (a project lives on one
 * hub; there is no cross-hub project), from the boards the app already loads
 * (`task.loadBoardData` carries each project with its folders per computer, and reloads
 * when the hub says anything changed). The React side is `use-hub-projects.ts`.
 *
 * Rows are keyed by hub AND project id, like task rows (`hub-board.ts` says why).
 */
import type { HubEntry } from '@slayzone/platform/hub-registry'
import {
  type BoardProject,
  type HubFeed,
  type HubProblem,
  hubProblem,
  rowKey,
  type TaskRow
} from '../hub-board'

/** One project in the merged list. */
export interface ProjectRow {
  /** Unique across hubs. */
  key: string
  hubId: string
  hubLabel: string
  project: BoardProject
}

/** One hub's projects. */
export interface HubProjects {
  hub: HubEntry
  projects: ProjectRow[]
  /** No board yet and nothing wrong: still loading. */
  loading: boolean
  /** What is wrong with the hub (`hubProblem`), null = nothing. */
  problem: HubProblem | null
}

/** A project of a hub, picked: what the project picker hands back. */
export interface ProjectRef {
  hubId: string
  projectId: string
}

function rowOf(hub: HubEntry, project: BoardProject): ProjectRow {
  return { key: rowKey(hub.id, project.id), hubId: hub.id, hubLabel: hub.label, project }
}

/** Every hub's projects, hubs in the order given (sign-in order), projects in board order. */
export function mergeHubProjects(feeds: readonly HubFeed[]): HubProjects[] {
  return feeds.map((feed) => {
    const problem = hubProblem(feed)
    const projects: ProjectRow[] = []
    for (const p of feed.board.data?.projects ?? []) if (p) projects.push(rowOf(feed.hub, p))
    return {
      hub: feed.hub,
      projects,
      loading: feed.board.data === undefined && feed.board.pending && problem === null,
      problem
    }
  })
}

/** One hub's project by id; null = not on that hub (or its board not loaded yet). */
export function findProjectRow(feed: HubFeed, projectId: string): ProjectRow | null {
  const project = feed.board.data?.projects.find((p) => p?.id === projectId)
  return project ? rowOf(feed.hub, project) : null
}

/** A project's top-level tasks, in board order, as rows of its hub. */
export function projectTasks(feed: HubFeed, projectId: string): TaskRow[] {
  const data = feed.board.data
  const project = data?.projects.find((p) => p?.id === projectId) ?? undefined
  if (!data || !project) return []
  return data.tasks
    .filter((task) => task.project_id === projectId && task.parent_id === null)
    .map((task) => ({
      key: rowKey(feed.hub.id, task.id),
      hubId: feed.hub.id,
      hubLabel: feed.hub.label,
      task,
      project
    }))
}
