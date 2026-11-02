import { getArtifactStorage } from '@slayzone/task-artifacts/server'
import { getArtifactsDataRoot } from './shared'
import type { Express } from 'express'
import { dirname } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { getEffectiveRenderMode, canExportAsHtml } from '@slayzone/task-contracts'
import type { RenderMode } from '@slayzone/task-contracts'
import type { RestApiDeps } from '../types'
import { NOT_AVAILABLE_STANDALONE } from '../types'

export function registerArtifactsExportHtmlRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/artifacts/:id/export/html', async (req, res) => {
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
    // Raw sqlite column: any stray value falls through getEffectiveRenderMode's
    // `override in RENDER_MODE_INFO` check and lands on the title-derived mode.
    const mode = getEffectiveRenderMode(title, existing.render_mode as RenderMode | null)
    if (!canExportAsHtml(mode)) {
      res.status(400).json({ error: `Cannot export ${mode} as html` })
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

    // Same builder the pdf route's renderer uses internally; the mermaid-vs-plain
    // branch is resolved on the desktop side of the bridge (see
    // ArtifactExportAccess). Unlike pdf/png this one keeps the HTML in hand — it
    // is a string, not a multi-MB buffer — and writes it here.
    const html = await exporter.buildExportHtml(content, mode, title)
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, html, 'utf-8')
    res.json({ ok: true, path: outputPath })
  })
}
