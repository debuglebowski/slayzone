import type { Express } from 'express'
import { defaultProviderFromMode, filterConfigurableCliProviders } from '@slayzone/ai-config/shared'
import type { CliProvider } from '@slayzone/ai-config/shared'
import type { RestApiDeps } from '../types'
import { isResolveFailure, resolveProjectRef } from '../resolve'

/**
 * The provider set `slay init` writes instruction/skill files for. Mirrors the
 * CLI's former `loadProviders` exactly: the per-project `ai_providers:<id>`
 * setting when it holds a non-empty array, else the single provider implied by
 * `default_terminal_mode`.
 */
async function loadProjectProviders(
  db: RestApiDeps['db'],
  projectId: string
): Promise<CliProvider[]> {
  const row = await db.get<{ value: string }>(`SELECT value FROM settings WHERE key = ? LIMIT 1`, [
    `ai_providers:${projectId}`
  ])
  if (row) {
    try {
      const parsed: unknown = JSON.parse(row.value)
      if (Array.isArray(parsed) && parsed.length > 0) {
        // Unlike the CLI (which trusted the stored array verbatim), drop values
        // that are not configurable providers — the response drives on-disk path
        // lookups in PROVIDER_PATHS, and an unknown kind has no mapping.
        const filtered = filterConfigurableCliProviders(parsed.map(String))
        if (filtered.length > 0) return filtered
      }
    } catch {
      /* fall through to the terminal-mode default */
    }
  }

  const modeRow = await db.get<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'default_terminal_mode' LIMIT 1`
  )
  return [defaultProviderFromMode(modeRow?.value)]
}

/**
 * POST /api/projects/:id/skills — install/refresh the built-in slay skills for a
 * project (CLI `slay init` and `slay init skills`).
 *
 * This is the HUB-STATE half of `slay init`. The CLI used to do all of it against
 * the hub's SQLite file directly (`openDb()` + INSERT/UPDATE on `ai_config_items`),
 * so `slay init` was local-only. Everything that touches hub rows now happens
 * here:
 *
 * - `:id` is a project id OR a case-insensitive name substring (shared
 *   `resolveProjectRef`, the CLI's `--project` semantics and messages).
 * - the provider set is read from `ai_providers:<projectId>` / `default_terminal_mode`.
 * - the skill rows are written by the `install-builtin-project-skills` named txn,
 *   which owns the `installedVersion` CONTENT-HASH comparison. That comparison
 *   moved with the write on purpose: left in the CLI it would be hashing against
 *   rows a remote CLI can no longer read.
 *
 * The response carries what the CLI needs to finish its LOCAL half without a DB
 * read: the resolved project (name for the summary line, path to decide whether
 * this machine even owns a checkout), the provider list (which files to write),
 * the install/update/skip counts (the summary line), and the CHANGED skills'
 * content (what to mirror to `<skillsDir>/<slug>/SKILL.md`).
 */
export function registerProjectSkillsRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/projects/:id/skills', async (req, res) => {
    try {
      const resolved = await resolveProjectRef(deps.db, req.params.id)
      if (isResolveFailure(resolved)) {
        res.status(resolved.status).json({ ok: false, error: resolved.error })
        return
      }
      const project = resolved.row

      const providers = await loadProjectProviders(deps.db, project.id)
      const result = await deps.db.namedTxn(
        'ai-config:marketplace:install-builtin-project-skills',
        { projectId: project.id }
      )

      // Same gate as the CLI's: only ping when something actually changed.
      if (result.installed + result.updated > 0) deps.notifyRenderer()

      res.json({
        ok: true,
        data: {
          project: { id: project.id, name: project.name, path: project.path },
          providers,
          stats: {
            installed: result.installed,
            updated: result.updated,
            skipped: result.skipped
          },
          skills: result.synced
        }
      })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
