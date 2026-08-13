import type { Express } from 'express'
import { resolveProjectByPath } from '@slayzone/computers/server'
import type { RestApiDeps } from '../types'
import { queryString } from '../resolve'

/**
 * GET /api/projects/resolve-by-path?path=<dir> — which project contains this
 * directory? Deepest match wins. Backs `slay`'s project inference from $PWD.
 *
 * This is the ONE direction the hub genuinely needs paths for, and why the
 * computer-reported mirror (`project_placements`) exists: asking every
 * connected computer in turn would be slow and ambiguous. Forward resolution —
 * "where does this project live for that agent" — is the computer's job and no
 * longer happens here at all.
 */
export function registerProjectsResolveByPathRoute(app: Express, deps: RestApiDeps): void {
  app.get('/api/projects/resolve-by-path', async (req, res) => {
    const dirPath = queryString(req.query.path)
    if (!dirPath) {
      res.status(400).json({ ok: false, error: 'path required' })
      return
    }
    try {
      const best = await resolveProjectByPath(deps.db, dirPath)
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
