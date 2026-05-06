import type { Express } from 'express'
import { dirname } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { buildPdfHtml, buildMermaidPdfHtml } from '@slayzone/task/electron'
import { getEffectiveRenderMode, canExportAsHtml } from '@slayzone/task/shared'
import { getArtifactFilePath } from './shared'
import type { RestApiDeps } from '../types'

export function registerArtifactsExportHtmlRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/artifacts/:id/export/html', async (req, res) => {
    const { outputPath } = req.body ?? {}
    if (!outputPath) { res.status(400).json({ error: 'outputPath required' }); return }

    const existing = deps.db.prepare('SELECT * FROM task_artifacts WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined
    if (!existing) { res.status(404).json({ error: 'Artifact not found' }); return }

    const title = existing.title as string
    const mode = getEffectiveRenderMode(title, (existing.render_mode as string | null) as any)
    if (!canExportAsHtml(mode)) { res.status(400).json({ error: `Cannot export ${mode} as html` }); return }

    const srcPath = getArtifactFilePath(existing.task_id as string, req.params.id, title)
    if (!existsSync(srcPath)) { res.status(404).json({ error: 'Artifact file not found' }); return }
    const content = readFileSync(srcPath, 'utf-8')

    const isMermaid = mode === 'mermaid-preview'
    const html = isMermaid ? buildMermaidPdfHtml(content, title) : buildPdfHtml(content, mode, title)

    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, html, 'utf-8')
    res.json({ ok: true, path: outputPath })
  })
}
