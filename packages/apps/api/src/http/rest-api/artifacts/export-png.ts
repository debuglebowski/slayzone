import { getArtifactStorage } from '@slayzone/task-artifacts/server'
import { getArtifactsDataRoot } from './shared'
import type { Express } from 'express'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { getEffectiveRenderMode, canExportAsPng, type RenderMode } from '@slayzone/task-contracts'
import type { RestApiDeps } from '../types'
import { NOT_AVAILABLE_STANDALONE } from '../types'

export function registerArtifactsExportPngRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/artifacts/:id/export/png', async (req, res) => {
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
    // `render_mode` is a free-form TEXT column; getEffectiveRenderMode already
    // falls back to the title's extension for anything it doesn't recognise, so
    // the raw column value can be handed over as-is.
    const mode = getEffectiveRenderMode(title, existing.render_mode as RenderMode | null)
    if (!canExportAsPng(mode)) {
      res.status(400).json({ error: `Cannot export ${mode} as png` })
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
      // The renderer writes destPath itself; only the mkdir stays here. `false`
      // means buildPngHtml declined the mode (mermaid unavailable) — same 500 the
      // pre-inversion null-html branch produced.
      mkdirSync(dirname(outputPath), { recursive: true })
      const rendered = await exporter.renderPngToFile(content, mode, title, outputPath)
      if (!rendered) {
        res.status(500).json({ error: 'Failed to build PNG HTML (mermaid not available)' })
        return
      }
      res.json({ ok: true, path: outputPath })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })
}
