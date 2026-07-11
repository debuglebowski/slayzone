import type { Express } from 'express'
import type { RestApiDeps } from '../types'
import { queryString } from '../resolve'

/**
 * GET /api/projects/resolve-by-path?path=<dir> — find the project whose
 * configured path contains the given directory (deepest match wins).
 * Mirrors the CLI's `resolveProjectByPath` (cli/src/db-helpers.mts), which
 * backs `slay tasks list`-style project inference from $PWD.
 */
export function registerProjectsResolveByPathRoute(app: Express, deps: RestApiDeps): void {
  app.get('/api/projects/resolve-by-path', async (req, res) => {
    const dirPath = queryString(req.query.path)
    if (!dirPath) {
      res.status(400).json({ ok: false, error: 'path required' })
      return
    }
    try {
      const normalized = dirPath.replace(/\/+$/, '')
      const projects = await deps.db.all<{ id: string; name: string; path: string }>(
        `SELECT id, name, path FROM projects WHERE path IS NOT NULL`
      )

      let best: { id: string; name: string; path: string } | null = null
      let bestLen = -1
      for (const p of projects) {
        const pPath = p.path.replace(/\/+$/, '')
        if (normalized === pPath || normalized.startsWith(pPath + '/')) {
          if (pPath.length > bestLen) {
            best = p
            bestLen = pPath.length
          }
        }
      }

      if (!best) {
        res.status(404).json({ ok: false, error: `No project found for directory: ${dirPath}` })
        return
      }
      res.json({ ok: true, data: best })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
