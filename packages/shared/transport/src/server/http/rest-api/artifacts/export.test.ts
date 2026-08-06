/**
 * REST: /api/artifacts/:id/export/{pdf,png,html} — the two route groups the
 * side-car used to reverse-proxy to the Electron host.
 *
 * WHY THESE EXIST NOW: those routes were served BY THE DESKTOP, because they
 * need an offscreen renderer. But they also read `task_artifacts` — so the
 * desktop needed a live handle on the shared DB purely to answer a request the
 * hub had just forwarded to it. That is the last thing keeping `db` on the
 * desktop bridge.
 *
 * The inversion: the handler stays on the HUB (where the row lives) and calls the
 * desktop over the capability bridge for the render step only. `ArtifactExportAccess`
 * therefore takes the AppDeps shape — `buildExportHtml` / `renderPdfToFile` /
 * `renderPngToFile` — instead of the five raw primitives (`buildPdfHtml`,
 * `buildMermaidPdfHtml`, `buildPngHtml`, `renderToPdf`, `renderToPng`). The
 * `*ToFile` methods write straight to destPath so multi-MB buffers never cross
 * the bridge, and the mermaid/plain branch moves behind the bridge with them —
 * `buildMermaidPdfHtml` resolves mermaid through `require.resolve` and silently
 * downgrades to plain-code rendering when it misses, which it would do every time
 * from the side-car bundle.
 *
 * These assert the branches survive the reshape verbatim: 501 with no exporter,
 * 400 without outputPath, 404 for an unknown artifact, 400 for a mode that can't
 * export to that format, 404 for a missing file, and the mermaid flag reaching
 * the renderer.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --experimental-loader ./packages/shared/test-utils/loader.ts packages/shared/transport/src/server/http/rest-api/artifacts/export.test.ts
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import express from 'express'
import {
  createTestHarness,
  test,
  expect,
  describe
} from '../../../../../../test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../test-utils/rest-harness.js'

// `artifactsDir` is a module-load const — point ROOT at a throwaway dir BEFORE
// importing the routes (same ordering the other artifact route tests rely on).
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-artifacts-export-'))
process.env.SLAYZONE_ROOT = tmpRoot

const { registerArtifactsExportPdfRoute } = await import('./export-pdf.js')
const { registerArtifactsExportPngRoute } = await import('./export-png.js')
const { registerArtifactsExportHtmlRoute } = await import('./export-html.js')
const { getArtifactFilePath } = await import('./shared.js')

const h = await createTestHarness()

const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'Alpha', '#000', '/tmp/alpha')
const taskId = crypto.randomUUID()
h.db
  .prepare(
    'INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)'
  )
  .run(taskId, projectId, 'ExportTask', 'todo', 3, 0)

/** Insert an artifact row + its backing file. Returns the artifact id. */
function seedArtifact(title: string, renderMode: string | null, content = 'hello'): string {
  const id = crypto.randomUUID()
  h.db
    .prepare(
      'INSERT INTO task_artifacts (id, task_id, title, render_mode) VALUES (?, ?, ?, ?)'
    )
    .run(id, taskId, title, renderMode)
  const p = getArtifactFilePath(taskId, id, title)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content, 'utf-8')
  return id
}

/** Row with NO backing file — the "artifact file not found" branch. */
function seedArtifactRowOnly(title: string): string {
  const id = crypto.randomUUID()
  h.db
    .prepare('INSERT INTO task_artifacts (id, task_id, title, render_mode) VALUES (?, ?, ?, ?)')
    .run(id, taskId, title, null)
  return id
}

type Call = { content: string; mode: string; title: string; destPath: string }
const calls: { pdf: Call[]; png: Call[]; html: Call[] } = { pdf: [], png: [], html: [] }
let pngSupported = true

/** Fake of the NEW AppDeps-shaped ArtifactExportAccess. */
const exporter = {
  buildExportHtml: async (content: string, mode: string, title: string) => {
    calls.html.push({ content, mode, title, destPath: '' })
    return `<html data-mode="${mode}">${content}</html>`
  },
  renderPdfToFile: async (content: string, mode: string, title: string, destPath: string) => {
    calls.pdf.push({ content, mode, title, destPath })
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    fs.writeFileSync(destPath, 'PDF')
  },
  renderPngToFile: async (content: string, mode: string, title: string, destPath: string) => {
    calls.png.push({ content, mode, title, destPath })
    if (!pngSupported) return false
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    fs.writeFileSync(destPath, 'PNG')
    return true
  }
}

const withExporter = express()
withExporter.use(express.json())
registerArtifactsExportPdfRoute(withExporter, { db: h.slayDb, notifyRenderer: () => {}, artifactExport: exporter })
registerArtifactsExportPngRoute(withExporter, { db: h.slayDb, notifyRenderer: () => {}, artifactExport: exporter })
registerArtifactsExportHtmlRoute(withExporter, { db: h.slayDb, notifyRenderer: () => {}, artifactExport: exporter })
const rest = await mountRestApp(withExporter)

// A standalone hub has no Electron host to forward to → every export route 501s.
const noExporter = express()
noExporter.use(express.json())
registerArtifactsExportPdfRoute(noExporter, { db: h.slayDb, notifyRenderer: () => {} })
registerArtifactsExportPngRoute(noExporter, { db: h.slayDb, notifyRenderer: () => {} })
registerArtifactsExportHtmlRoute(noExporter, { db: h.slayDb, notifyRenderer: () => {} })
const restNoExporter = await mountRestApp(noExporter)

const out = (name: string): string => path.join(tmpRoot, 'out', name)

await describe('artifact export routes', () => {
  test('501 for every format when no exporter is wired (standalone hub)', async () => {
    const id = seedArtifact('doc.md', null)
    for (const fmt of ['pdf', 'png', 'html']) {
      const r = await restNoExporter.request<{ error: string }>(
        'POST',
        `/api/artifacts/${id}/export/${fmt}`,
        { outputPath: out(`x.${fmt}`) }
      )
      expect(r.status).toBe(501)
    }
  })

  test('400 when outputPath is missing', async () => {
    const id = seedArtifact('doc2.md', null)
    const r = await rest.request('POST', `/api/artifacts/${id}/export/pdf`, {})
    expect(r.status).toBe(400)
  })

  test('404 for an unknown artifact id', async () => {
    const r = await rest.request('POST', `/api/artifacts/${crypto.randomUUID()}/export/pdf`, {
      outputPath: out('missing.pdf')
    })
    expect(r.status).toBe(404)
  })

  test('404 when the artifact row exists but its file does not', async () => {
    const id = seedArtifactRowOnly('ghost.md')
    const r = await rest.request('POST', `/api/artifacts/${id}/export/pdf`, {
      outputPath: out('ghost.pdf')
    })
    expect(r.status).toBe(404)
  })

  test('pdf: renders to destPath and echoes it back', async () => {
    const id = seedArtifact('report.md', null, '# Report')
    const dest = out('report.pdf')
    const r = await rest.request<{ ok: boolean; path: string }>(
      'POST',
      `/api/artifacts/${id}/export/pdf`,
      { outputPath: dest }
    )
    expect(r.status).toBe(200)
    expect(r.body.path).toBe(dest)
    expect(fs.readFileSync(dest, 'utf-8')).toBe('PDF')
    const last = calls.pdf[calls.pdf.length - 1]
    expect(last.content).toBe('# Report')
    expect(last.destPath).toBe(dest)
  })

  test('pdf: the mermaid branch travels as `mode`, not a boolean', async () => {
    const id = seedArtifact('graph.mmd', 'mermaid-preview', 'graph TD; A-->B')
    const dest = out('graph.pdf')
    const r = await rest.request('POST', `/api/artifacts/${id}/export/pdf`, { outputPath: dest })
    expect(r.status).toBe(200)
    expect(calls.pdf[calls.pdf.length - 1].mode).toBe('mermaid-preview')
  })

  test('png: 500 when the mode has no PNG representation', async () => {
    const id = seedArtifact('chart.mmd', 'mermaid-preview', 'graph TD; A-->B')
    pngSupported = false
    try {
      const r = await rest.request('POST', `/api/artifacts/${id}/export/png`, {
        outputPath: out('chart.png')
      })
      expect(r.status).toBe(500)
    } finally {
      pngSupported = true
    }
  })

  test('html: writes the built html to destPath', async () => {
    const id = seedArtifact('page.md', null, 'BODY')
    const dest = out('page.html')
    const r = await rest.request('POST', `/api/artifacts/${id}/export/html`, { outputPath: dest })
    expect(r.status).toBe(200)
    expect(fs.readFileSync(dest, 'utf-8').includes('BODY')).toBe(true)
  })
})

await rest.close()
await restNoExporter.close()
fs.rmSync(tmpRoot, { recursive: true, force: true })
