/**
 * Where a project's folder gets recorded when one is chosen: on a computer.
 *
 * The hub injects the host (it alone knows the connected computers and talks to
 * them). Every write of a project's folder — `projects.create`, `projects.update`,
 * REST, the CLI — goes through it, so none of them can write the hub's
 * `projects.path` column again.
 *
 * Unwired = a process with no computers at all (the fork sidecar, a unit-test
 * harness). There, and only there, the folder still goes into `projects.path`:
 * there is no computer to hold it, and dropping it would lose it.
 *
 * @module projects/server/project-folders
 */

import type { PlacementStatus } from '@slayzone/computers/shared'

export interface ProjectFolderHost {
  /** The computer for a new project when the request names none (the caller's
   *  default). Null = no computer at all. */
  computerForNewProject(): Promise<string | null>
  /** The computer the hub uses for this project now (its default, else the
   *  connected default). Null = none. */
  computerForProject(projectId: string): Promise<string | null>
  /** Record the folder on that computer. Throws when the computer refuses it. */
  setFolder(
    computerId: string,
    projectId: string,
    path: string
  ): Promise<{ path: string; status: PlacementStatus }>
  /** Forget the folder on that computer (the folder itself is left alone). */
  forgetFolder(computerId: string, projectId: string): Promise<void>
}

let host: ProjectFolderHost | null = null

export function setProjectFolderHost(next: ProjectFolderHost | null): void {
  host = next
}

export function getProjectFolderHost(): ProjectFolderHost | null {
  return host
}

/** Thrown when a folder is given but there is no computer to record it on. */
export class NoComputerForFolderError extends Error {
  constructor() {
    super(
      'No computer is connected, so the project folder has nowhere to live. ' +
        'Start the local computer (Settings → Connections) or enroll one, then try again.'
    )
    this.name = 'NoComputerForFolderError'
  }
}
