import { getArtifactStorage } from '@slayzone/task-artifacts/server'
import { getArtifactsDataRoot } from './shared'
import type { Express } from 'express'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { getEffectiveRenderMode, canExportAsPdf } from '@slayzone/task-contracts'
import type { RenderMode } from '@slayzone/task-contracts'
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

    const storage = getArtifactStorage(getArtifactsDataRoot()),
      existing = await storage.getArtifact(deps.db, req.params.id)
    if (!existing) {
      res.status(404).json({ error: 'Artifact not found' })
      return
    }

    const title = existing.title as string
    const mode = getEffectiveRenderMode(title, existing.render_mode as RenderMode | null)
    if (!canExportAsPdf(mode)) {
      res.status(400).json({ error: `Cannot export ${mode} as pdf` })
      return
    }

    const localPath = existing.storage
      ? null
      : await storage.getArtifactPath(deps.db, req.params.id)
    if (!existing.storage && (!localPath || !existsSync(localPath))) {
      res.status(404).json({ error: 'Artifact file not found' })
      return
    }
    const content = await storage.readArtifactContent(deps.db, req.params.id)
    if (content === null) {
      res.status(404).json({ error: 'Artifact file not found' })
      return
    }

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
