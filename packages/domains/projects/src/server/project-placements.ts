/**
 * Turns stored project rows into the {@link Project}s the hub hands out: each row
 * plus where its folder is on every computer, and the computer the hub actually
 * uses for it.
 *
 * Every path that returns a Project goes through {@link attachPlacements}. A row
 * alone does not know its folder any more — the folder moved from the hub's
 * `projects.path` column to the computers — so returning a bare row would show
 * "no folder" for a project that has one.
 *
 * @module projects/server/project-placements
 */

import type { SlayzoneDb } from '@slayzone/platform'
import { listPlacements } from '@slayzone/computers/server'
import type { Project, ProjectRecord } from '@slayzone/projects-contracts'

/**
 * The computer the hub uses for a project's work: its default, else the connected
 * default. Injected by the hub, which alone knows which computers are connected;
 * unwired (fork sidecar, tests) it is the project's own default.
 */
export type ProjectComputerResolver = (project: ProjectRecord) => Promise<string | null>

const fromDefault: ProjectComputerResolver = async (project) => project.default_computer_id

let resolveComputer: ProjectComputerResolver = fromDefault

export function setProjectComputerResolver(next: ProjectComputerResolver | null): void {
  resolveComputer = next ?? fromDefault
}

/** Rows → Projects, in order. */
export async function attachPlacements(
  db: SlayzoneDb,
  records: readonly ProjectRecord[]
): Promise<Project[]> {
  if (records.length === 0) return []
  const rows = await listPlacements(
    db,
    records.map((r) => r.id)
  )
  const byProject = new Map<string, Project['placements']>()
  for (const row of rows) {
    // Cleared by the user; only the computer has yet to be told. Gone for clients.
    if (row.status === 'forgotten') continue
    const list = byProject.get(row.project_id) ?? []
    list.push({ computer_id: row.computer_id, path: row.path, status: row.status })
    byProject.set(row.project_id, list)
  }
  return Promise.all(
    records.map(async ({ path: _legacyPath, ...record }) => ({
      ...record,
      placements: byProject.get(record.id) ?? [],
      // A resolver failure (a computer the caller may not use, a gateway mid-restart)
      // must not fail the whole read: fall back to the stored default.
      resolved_computer_id: await resolveComputer({ ...record, path: _legacyPath }).catch(
        () => record.default_computer_id
      )
    }))
  )
}

/** One row → one Project. */
export async function attachPlacement(db: SlayzoneDb, record: ProjectRecord): Promise<Project> {
  return (await attachPlacements(db, [record]))[0]
}
