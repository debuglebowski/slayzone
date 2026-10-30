/**
 * The hub's copy of where each computer keeps each project (`project_placements`).
 *
 * The COMPUTER is the authority — it owns the disk, and its own
 * `computer.projects.json` is what it spawns from. The hub keeps a copy because
 * it needs answers a computer cannot give alone:
 *
 *  - which folder an agent starts in, decided BEFORE the spawn reaches a computer
 *    (the conversation healer, session detection and warm-agent matching all key
 *    off it);
 *  - every computer's folder for one project, for the UI;
 *  - `GET /api/projects/resolve-by-path`, which turns "the directory `slay` is
 *    running in" into a project — polling every computer for that would be slow
 *    and ambiguous.
 *
 * Unlike a pure mirror, a row can also be something the hub knows and the
 * computer has not confirmed yet (`pending`), or a folder the computer turned
 * down (`missing` / `refused`) — see {@link PlacementStatus}.
 *
 * Every write is one upsert on the `(computer_id, project_id)` key, and lands only
 * when BOTH the project and the computer still exist. The table has no foreign
 * keys (v149), so without that guard a write racing a delete would resurrect a
 * row for something that is gone.
 *
 * @module computers/server/project-paths
 */

import type { SlayzoneDb } from '@slayzone/platform'
import { DEFAULT_LOCAL_COMPUTER_NAME } from '../shared'
import { deterministicLocalComputerId } from './store'
import {
  USABLE_PLACEMENT_STATUSES,
  type PlacementStatus,
  type ProjectPlacement
} from '../shared/types'

const USABLE_SQL = USABLE_PLACEMENT_STATUSES.map((s) => `'${s}'`).join(', ')

/** One row, keyed by project. */
export interface PlacementRow extends ProjectPlacement {
  project_id: string
}

/**
 * Write one row: insert, or replace the row for this (computer, project).
 *
 * Returns false when nothing was written because the project or the computer no
 * longer exists.
 */
export async function setPlacement(
  db: SlayzoneDb,
  placement: { computerId: string; projectId: string; path: string; status: PlacementStatus }
): Promise<boolean> {
  const res = (await db.run(
    // `WHERE` on the SELECT is also what lets SQLite parse the upsert clause after
    // an INSERT … SELECT.
    `INSERT INTO project_placements (computer_id, project_id, root_path, status, updated_at)
       SELECT ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM projects WHERE id = ?)
         AND EXISTS (SELECT 1 FROM computers WHERE id = ?)
     ON CONFLICT(computer_id, project_id) DO UPDATE SET
       root_path = excluded.root_path,
       status = excluded.status,
       updated_at = excluded.updated_at`,
    [
      placement.computerId,
      placement.projectId,
      placement.path,
      placement.status,
      Date.now(),
      placement.projectId,
      placement.computerId
    ]
  )) as { changes: number }
  return res.changes > 0
}

/**
 * Record a computer's own report of the folders it holds.
 *
 * The report is that computer's state, so a reported folder becomes `ready`, also
 * over a `missing` or `refused` row for the same project. A `ready` row the
 * computer no longer reports is deleted — keeping it would let reverse lookup
 * trust a folder the computer dropped.
 *
 * Two kinds of row are the user's newer intent, not yet delivered, and a report
 * never overrides them: `pending` (a folder chosen while the computer was offline
 * — its report still names the OLD folder) and `forgotten` (a folder cleared while
 * it was offline). The connect sequence delivers both right after.
 */
export async function recordComputerProjectPaths(
  db: SlayzoneDb,
  computerId: string,
  entries: ReadonlyArray<{ projectId: string; path: string }>
): Promise<void> {
  const now = Date.now()
  const reported = entries.map((e) => e.projectId)
  await db.batchTxn([
    {
      type: 'run',
      sql: `DELETE FROM project_placements
             WHERE computer_id = ? AND status = 'ready'
               AND project_id NOT IN (${reported.map(() => '?').join(', ') || "''"})`,
      params: [computerId, ...reported]
    },
    ...entries.map((e) => ({
      type: 'run' as const,
      sql: `INSERT INTO project_placements (computer_id, project_id, root_path, status, updated_at)
              SELECT ?, ?, ?, 'ready', ?
              WHERE EXISTS (SELECT 1 FROM projects WHERE id = ?)
                AND EXISTS (SELECT 1 FROM computers WHERE id = ?)
            ON CONFLICT(computer_id, project_id) DO UPDATE SET
              root_path = excluded.root_path,
              status = 'ready',
              updated_at = excluded.updated_at
            WHERE project_placements.status NOT IN ('pending', 'forgotten')`,
      params: [computerId, e.projectId, e.path, now, e.projectId, computerId]
    }))
  ])
}

/** Every row for these projects (all projects when omitted), any status. */
export async function listPlacements(
  db: SlayzoneDb,
  projectIds?: readonly string[]
): Promise<PlacementRow[]> {
  if (projectIds && projectIds.length === 0) return []
  const rows = await db.all<{
    computer_id: string
    project_id: string
    root_path: string
    status: PlacementStatus
  }>(
    `SELECT computer_id, project_id, root_path, status FROM project_placements
      ${projectIds ? `WHERE project_id IN (${projectIds.map(() => '?').join(', ')})` : ''}
      ORDER BY project_id, computer_id`,
    projectIds ? [...projectIds] : []
  )
  return rows.map((r) => ({
    computer_id: r.computer_id,
    project_id: r.project_id,
    path: r.root_path,
    status: r.status
  }))
}

/** The row for one (project, computer), or null. */
export async function getPlacement(
  db: SlayzoneDb,
  projectId: string,
  computerId: string
): Promise<PlacementRow | null> {
  const row = await db.get<{ root_path: string; status: PlacementStatus }>(
    `SELECT root_path, status FROM project_placements WHERE project_id = ? AND computer_id = ?`,
    [projectId, computerId]
  )
  return row
    ? { computer_id: computerId, project_id: projectId, path: row.root_path, status: row.status }
    : null
}

/**
 * The folder an agent for this project starts in on this computer, or null when
 * the hub knows none it could use there.
 */
export async function recordedProjectRoot(
  db: SlayzoneDb,
  projectId: string,
  computerId: string
): Promise<string | null> {
  const row = await getPlacement(db, projectId, computerId)
  return row && USABLE_PLACEMENT_STATUSES.includes(row.status) ? row.path : null
}

/**
 * The project's folder on the LOCAL computer — the one that shares this hub's
 * machine. For work the hub runs on its own disk (project processes, automation
 * commands, git snapshots): only the local computer's folder is a folder here.
 * Null when the local computer holds none.
 */
export async function localProjectRoot(db: SlayzoneDb, projectId: string): Promise<string | null> {
  return recordedProjectRoot(
    db,
    projectId,
    deterministicLocalComputerId(DEFAULT_LOCAL_COMPUTER_NAME)
  )
}

/** Drop one (computer, project) row. */
export async function deletePlacement(
  db: SlayzoneDb,
  computerId: string,
  projectId: string
): Promise<void> {
  await db.run(`DELETE FROM project_placements WHERE computer_id = ? AND project_id = ?`, [
    computerId,
    projectId
  ])
}

/** Drop every computer's row for a project (the project is being deleted). */
export async function deleteProjectPlacements(db: SlayzoneDb, projectId: string): Promise<void> {
  await db.run(`DELETE FROM project_placements WHERE project_id = ?`, [projectId])
}

/**
 * Which project contains `dirPath`? Deepest match wins.
 *
 * Searches the hub's copy first (only folders an agent could use — a `missing`
 * or `refused` row names a folder that is not there), then the legacy
 * `projects.path` column. The fallback is not vestigial: on the boot right after
 * upgrade the copy is empty until the local computer connects, and without it
 * `slay` would stop resolving its own working directory in exactly that window.
 *
 * Compared as strings, as the old hub-side lookup was. A row from a Windows
 * computer will not match a POSIX query and vice versa — which is correct, since
 * those are different machines' directories.
 */
export async function resolveProjectByPath(
  db: SlayzoneDb,
  dirPath: string
): Promise<{ id: string; name: string; path: string } | null> {
  const normalized = dirPath.replace(/[/\\]+$/, '')

  const placed = await db.all<{ id: string; name: string; path: string }>(
    `SELECT p.id AS id, p.name AS name, c.root_path AS path
       FROM project_placements c
       JOIN projects p ON p.id = c.project_id
      WHERE c.status IN (${USABLE_SQL})`
  )
  const legacy = await db.all<{ id: string; name: string; path: string }>(
    `SELECT id, name, path FROM projects WHERE path IS NOT NULL AND path <> ''`
  )

  let best: { id: string; name: string; path: string } | null = null
  let bestLen = -1
  // The copy first, so at equal depth a re-pointed folder wins over the stale
  // legacy value; the legacy row only decides when nothing placed matches.
  for (const candidate of [...placed, ...legacy]) {
    const candidatePath = candidate.path.replace(/[/\\]+$/, '')
    const contained =
      normalized === candidatePath ||
      normalized.startsWith(`${candidatePath}/`) ||
      normalized.startsWith(`${candidatePath}\\`)
    if (!contained) continue
    if (candidatePath.length > bestLen) {
      best = candidate
      bestLen = candidatePath.length
    }
  }
  return best
}
