import type { Express } from 'express'
import { dirname } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { getEffectiveRenderMode, canExportAsPng } from '@slayzone/task/shared'
import { getArtifactFilePath } from './shared'
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

    const existing = (await deps.db
      .prepare('SELECT * FROM task_artifacts WHERE id = ?')
      .get(req.params.id)) as Record<string, unknown> | undefined
    if (!existing) {
      res.status(404).json({ error: 'Artifact not found' })
      return
    }

    const title = existing.title as string
    const mode = getEffectiveRenderMode(title, existing.render_mode as string | null as any)
    if (!canExportAsPng(mode)) {
      res.status(400).json({ error: `Cannot export ${mode} as png` })
      return
    }

    const srcPath = getArtifactFilePath(existing.task_id as string, req.params.id, title)
    if (!existsSync(srcPath)) {
      res.status(404).json({ error: 'Artifact file not found' })
      return
    }
    const content = readFileSync(srcPath, 'utf-8')

    const html = exporter.buildPngHtml(content, mode, title)
    if (!html) {
      res.status(500).json({ error: 'Failed to build PNG HTML (mermaid not available)' })
      return
    }

    try {
      const pngBuffer = await exporter.renderToPng(html)
      mkdirSync(dirname(outputPath), { recursive: true })
      writeFileSync(outputPath, pngBuffer)
      res.json({ ok: true, path: outputPath })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })
}
