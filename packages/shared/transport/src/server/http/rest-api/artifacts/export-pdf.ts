import type { Express } from 'express'
import { dirname } from 'node:path'
import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { getEffectiveRenderMode, canExportAsPdf } from '@slayzone/task/shared'
import { getArtifactFilePath } from './shared'
import type { RestApiDeps } from '../types'
import { NOT_AVAILABLE_STANDALONE } from '../types'

export function registerArtifactsExportPdfRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/artifacts/:id/export/pdf', async (req, res) => {
    const exporter = deps.artifactExport
    if (!exporter) {
      res.status(501).json({ error: NOT_AVAILABLE_STANDALONE })
      return
    }
    const { outputPath } = req.body ?? {}
    if (!outputPath) {
      res.status(400).json({ error: 'outputPath required' })
      return
    }

    const existing = (await deps.db
      .prepare('SELECT * FROM task_artifacts WHERE id = ?')
      .get(req.params.id)) as Record<string, unknown> | undefined
    if (!existing) {
      res.status(404).json({ error: 'Artifact not found' })
      return
    }

    const title = existing.title as string
    const mode = getEffectiveRenderMode(title, existing.render_mode as string | null as any)
    if (!canExportAsPdf(mode)) {
      res.status(400).json({ error: `Cannot export ${mode} as pdf` })
      return
    }

    const srcPath = getArtifactFilePath(existing.task_id as string, req.params.id, title)
    if (!existsSync(srcPath)) {
      res.status(404).json({ error: 'Artifact file not found' })
      return
    }
    const content = readFileSync(srcPath, 'utf-8')

    try {
      // The mermaid-vs-plain branch travels as `mode` and is resolved on the
      // desktop side of the bridge — see ArtifactExportAccess. The renderer
      // writes destPath itself, so only the mkdir stays here.
      mkdirSync(dirname(outputPath), { recursive: true })
      await exporter.renderPdfToFile(content, mode, title, outputPath)
      res.json({ ok: true, path: outputPath })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })
}
