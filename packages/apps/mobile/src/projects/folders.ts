/**
 * A project's folders: one per computer (`placements`, kept by the hub in step with each
 * computer's own record), as the project screen lists them. Pure.
 *
 * Words for a folder's state follow desktop's (Home's path guard, the task page): a
 * folder outside the computer's allowed roots is "outside the folders this computer
 * allows", a gone one is "not found".
 */
import { computerName } from '@slayzone/computers/labels'
import {
  type PlacementStatus,
  type ProjectPlacement,
  placementOn
} from '@slayzone/projects-contracts/placements'
import type { HubComputer } from '../computers/hub-computers'
import type { BoardProject } from '../hub-board'

/** One computer's folder of the project. */
export interface FolderRow {
  computerId: string
  name: string
  /** The computer as the hub lists it; null = not listed (revoked, or not the user's). */
  computer: HubComputer | null
  /** The computer the hub uses for the project (`resolved_computer_id`). */
  isDefault: boolean
  /** Its folder there; null = none. */
  placement: ProjectPlacement | null
}

export type ProjectFolders =
  | { kind: 'per-computer'; rows: FolderRow[] }
  /** A hub from before folders moved to computers: one folder for every computer. */
  | { kind: 'legacy'; path: string | null }

/**
 * Every computer of the hub with the project's folder there (none = null): the one the
 * hub uses for the project first, then the hub's order; folders on computers the hub
 * no longer lists last. A `forgotten` folder (cleared while its computer was away,
 * awaiting delivery) is no folder.
 */
export function projectFolders(
  project: BoardProject,
  computers: readonly HubComputer[]
): ProjectFolders {
  if ((project as { placements?: unknown }).placements === undefined) {
    return { kind: 'legacy', path: placementOn(project, null)?.path ?? null }
  }
  const shown = project.placements.filter((p) => p.status !== 'forgotten')
  const rows: FolderRow[] = computers.map((computer) => ({
    computerId: computer.id,
    name: computer.name,
    computer,
    isDefault: computer.id === project.resolved_computer_id,
    placement: shown.find((p) => p.computer_id === computer.id) ?? null
  }))
  for (const placement of shown) {
    if (rows.some((r) => r.computerId === placement.computer_id)) continue
    rows.push({
      computerId: placement.computer_id,
      name: computerName(computers, placement.computer_id),
      computer: null,
      isDefault: placement.computer_id === project.resolved_computer_id,
      placement
    })
  }
  // Stable: the default first, everything else keeps its place.
  rows.sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
  return { kind: 'per-computer', rows }
}

/** What to say under a folder's path; null = nothing (confirmed by its computer). */
export function placementStatusText(status: PlacementStatus): string | null {
  switch (status) {
    case 'ready':
      return null
    case 'pending':
      return 'Waiting for this computer to confirm'
    case 'missing':
      return 'Folder not found on this computer'
    case 'refused':
      return 'Outside the folders this computer allows'
    case 'forgotten':
      return null
  }
}
