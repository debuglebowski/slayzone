import type { Express } from 'express'
import { dirname } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { getEffectiveRenderMode, canExportAsHtml } from '@slayzone/task/shared'
import { getArtifactFilePath } from './shared'
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

    const existing = (await deps.db
      .prepare('SELECT * FROM task_artifacts WHERE id = ?')
      .get(req.params.id)) as Record<string, unknown> | undefined
    if (!existing) {
      res.status(404).json({ error: 'Artifact not found' })
      return
    }

    const title = existing.title as string
    const mode = getEffectiveRenderMode(title, existing.render_mode as string | null as any)
    if (!canExportAsHtml(mode)) {
      res.status(400).json({ error: `Cannot export ${mode} as html` })
      return
    }

    const srcPath = getArtifactFilePath(existing.task_id as string, req.params.id, title)
    if (!existsSync(srcPath)) {
      res.status(404).json({ error: 'Artifact file not found' })
      return
    }
    const content = readFileSync(srcPath, 'utf-8')

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
