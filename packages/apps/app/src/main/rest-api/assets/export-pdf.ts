import type { Express } from 'express'
import { dirname } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { buildPdfHtml, buildMermaidPdfHtml, renderToPdf } from '@slayzone/task/main'
import { getEffectiveRenderMode, canExportAsPdf } from '@slayzone/task/shared'
import { getAssetFilePath } from './shared'
import type { RestApiDeps } from '../types'

export function registerAssetsExportPdfRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/assets/:id/export/pdf', async (req, res) => {
    const { outputPath } = req.body ?? {}
    if (!outputPath) { res.status(400).json({ error: 'outputPath required' }); return }

    const existing = deps.db.prepare('SELECT * FROM task_assets WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined
    if (!existing) { res.status(404).json({ error: 'Asset not found' }); return }

    const title = existing.title as string
    const mode = getEffectiveRenderMode(title, (existing.render_mode as string | null) as any)
    if (!canExportAsPdf(mode)) { res.status(400).json({ error: `Cannot export ${mode} as pdf` }); return }

    const srcPath = getAssetFilePath(existing.task_id as string, req.params.id, title)
    if (!existsSync(srcPath)) { res.status(404).json({ error: 'Asset file not found' }); return }
    const content = readFileSync(srcPath, 'utf-8')

    const isMermaid = mode === 'mermaid-preview'
    const html = isMermaid ? buildMermaidPdfHtml(content, title) : buildPdfHtml(content, mode, title)

    try {
      const pdfBuffer = await renderToPdf(html, isMermaid)
      mkdirSync(dirname(outputPath), { recursive: true })
      writeFileSync(outputPath, pdfBuffer)
      res.json({ ok: true, path: outputPath })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })
}
