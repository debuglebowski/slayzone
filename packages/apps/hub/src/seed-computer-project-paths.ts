/**
 * Hand the hub's legacy `projects.path` values to a computer, once.
 *
 * `projects.path` is being deleted: one column cannot describe two machines, and
 * the hub cannot see any of them. But every existing install has real paths in
 * it, and dropping the column cold would blank every project the user has. So on
 * the first connect after upgrade, offer those paths to the computer to adopt.
 *
 * Scoped to the **supervised local computer**, and only for paths that actually
 * exist there. A remote computer's disk is a different machine: handing it the
 * hub's paths would record mappings that are wrong by construction — exactly the
 * assumption this whole change exists to remove. Remote computers adopt through the
 * picker, or provision from a repo URL.
 *
 * Idempotent by construction: a project the computer already has a mapping for is
 * skipped, so a reconnect never overwrites a path the user has since re-pointed.
 *
 * @module hub/seed-computer-project-paths
 */

export interface SeedableProject {
  id: string
  /** The legacy hub-side path. Null projects are skipped. */
  path: string | null
}

export interface SeedTarget {
  /** Existing mapping on the computer, or null. */
  resolve: (projectId: string) => Promise<{ path: string | null }>
  /** Does this path exist on the computer? */
  exists: (path: string) => Promise<boolean>
  adopt: (projectId: string, path: string) => Promise<unknown>
}

export interface SeedOutcome {
  adopted: string[]
  /** Already mapped on the computer — left exactly as the user had it. */
  skippedExisting: string[]
  /** The legacy path is not on this machine. Not an error; just not ours. */
  skippedMissing: string[]
}

/**
 * Adopt every legacy path the computer does not already have a mapping for and
 * that is really present on its disk.
 *
 * Failures for one project never abort the rest — a seed is best-effort by
 * nature, and one bad row must not leave the remaining projects unmapped.
 */
export async function seedProjectPaths(
  projects: readonly SeedableProject[],
  target: SeedTarget
): Promise<SeedOutcome> {
  const out: SeedOutcome = { adopted: [], skippedExisting: [], skippedMissing: [] }

  for (const project of projects) {
    if (!project.path) continue
    try {
      const current = await target.resolve(project.id)
      if (current.path) {
        out.skippedExisting.push(project.id)
        continue
      }
      if (!(await target.exists(project.path))) {
        out.skippedMissing.push(project.id)
        continue
      }
      await target.adopt(project.id, project.path)
      out.adopted.push(project.id)
    } catch {
      // Treat any per-project failure as "not seeded" and carry on. The user can
      // still adopt it by hand, which is strictly better than aborting the batch.
      out.skippedMissing.push(project.id)
    }
  }
  return out
}
