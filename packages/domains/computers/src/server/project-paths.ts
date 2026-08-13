/**
 * The hub's MIRROR of where each computer keeps each project.
 *
 * Built on `project_placements` (v149), which already modelled exactly this
 * — "where each computer has each project checked out, one row per pair" — and had
 * never been wired to anything. This is the change that starts using it.
 *
 * The COMPUTER is the author. It owns the mapping because it owns the disk, and
 * nothing here ever invents a row — a hub-authored path is precisely what made
 * `projects.path` wrong.
 *
 * The mirror exists because the hub needs the one direction a computer cannot
 * answer alone: `GET /api/projects/resolve-by-path` turns "the directory `slay`
 * is running in" into a project, and polling every connected computer for that
 * would be both slow and ambiguous.
 *
 * @module computers/server/project-paths
 */

import type { SlayzoneDb } from '@slayzone/platform'

/**
 * Replace everything recorded for one computer with what it just reported.
 *
 * Wholesale and in one transaction, because the report IS that computer's complete
 * state: a project it no longer holds must vanish from the mirror. Merging would
 * leave a stale row that reverse lookup then trusts, which is the same class of
 * lie the single hub-side column told.
 */
export async function recordComputerProjectPaths(
  db: SlayzoneDb,
  computerId: string,
  entries: ReadonlyArray<{ projectId: string; path: string }>
): Promise<void> {
  const now = Date.now()
  await db.batchTxn([
    {
      type: 'run',
      sql: 'DELETE FROM project_placements WHERE computer_id = ?',
      params: [computerId]
    },
    ...entries.map((e) => ({
      type: 'run' as const,
      // No FK on this table (v149 declared none), so a report for a project the
      // hub has since deleted is stored rather than rejected. Harmless: every
      // reader JOINs `projects`, so an orphan row is invisible and the computer's
      // next report clears it. Rejecting instead would mean one deleted project
      // could fail a whole computer's report.
      sql: `INSERT INTO project_placements
              (computer_id, project_id, root_path, status, updated_at)
            VALUES (?, ?, ?, 'ready', ?)`,
      params: [computerId, e.projectId, e.path, now]
    }))
  ])
}

/**
 * Which project contains `dirPath`? Deepest match wins.
 *
 * Searches the mirror first, then falls back to the legacy `projects.path`
 * column. The fallback is not vestigial: on the boot right after upgrade the
 * mirror is empty until a computer connects and reports, and without it `slay`
 * would stop resolving its own working directory in exactly that window.
 *
 * Compared as strings, as the old hub-side lookup was. A mirror row from a
 * Windows computer will not match a POSIX query and vice versa — which is correct,
 * since those are different machines' directories.
 */
export async function resolveProjectByPath(
  db: SlayzoneDb,
  dirPath: string
): Promise<{ id: string; name: string; path: string } | null> {
  const normalized = dirPath.replace(/[/\\]+$/, '')

  const mirrored = await db.all<{ id: string; name: string; path: string }>(
    `SELECT p.id AS id, p.name AS name, c.root_path AS path
       FROM project_placements c
       JOIN projects p ON p.id = c.project_id`
  )
  const legacy = await db.all<{ id: string; name: string; path: string }>(
    `SELECT id, name, path FROM projects WHERE path IS NOT NULL`
  )

  let best: { id: string; name: string; path: string } | null = null
  let bestLen = -1
  // Mirror first, so at equal depth a re-pointed checkout wins over the stale
  // legacy value; the legacy row only decides when nothing mirrored matches.
  for (const candidate of [...mirrored, ...legacy]) {
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
