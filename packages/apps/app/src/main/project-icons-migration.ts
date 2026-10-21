import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mergeMissingFiles } from './copy-utils'

/**
 * One-time COPY of `project-icons/` into the channel-scoped hub root.
 *
 * `storage-migration.ts` and `channel-storage-migration.ts` copy an explicit
 * allow-list (DB, blobs, artifacts, recent backups) that never included icons, so
 * a migrated DB kept `projects.icon_image_path` pointing into the legacy dir —
 * icons rendered only while that dir existed. This copies the files; the hub
 * repoints the DB rows afterwards (`relocateProjectIcons`).
 *
 * Same invariants as the other migrations: COPY-ONLY (sources are strictly
 * read-only — see `storage-migration.ts`'s header), merge-missing (an icon already
 * in the hub root wins).
 *
 * Own sentinel, deliberately NOT the `.storage-migrated.*` / `.channel-migrated`
 * ones: users a beta already migrated have those set, and would never get their
 * icons otherwise.
 *
 * NON-FATAL: icons are cosmetic and the old paths keep working, so a failure logs
 * and leaves the sentinel unwritten (retried next boot) instead of blocking boot
 * like the DB copies do.
 *
 * `sources` are legacy roots (each holding a `project-icons/`), NEWEST FIRST — the
 * first copy of a file wins a name collision, mirroring the DB-copy ordering.
 */
export function ensureProjectIcons(opts: { sources: string[]; hubRoot: string }): void {
  const sentinel = join(opts.hubRoot, '.project-icons-migrated')
  if (existsSync(sentinel)) return
  try {
    mkdirSync(opts.hubRoot, { recursive: true })
    let complete = true
    for (const source of opts.sources) {
      const src = join(source, 'project-icons')
      if (!existsSync(src)) continue
      if (!mergeMissingFiles(src, join(opts.hubRoot, 'project-icons'))) complete = false
    }
    if (complete) writeFileSync(sentinel, new Date().toISOString())
  } catch (err) {
    console.error(
      `[project-icons-migration] copy failed, will retry next boot: ` +
        `${err instanceof Error ? err.message : String(err)}`
    )
  }
}
