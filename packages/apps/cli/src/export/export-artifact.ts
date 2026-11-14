/**
 * `slay tasks artifacts download --type pdf|png|html`, from the artifact's content on:
 * the CLI renders exports ITSELF, on the machine it runs on. (The hub used to render
 * them and write the file to the HUB's disk — wrong for a remote hub, impossible for a
 * standalone one.)
 *
 * The document is the shared one every client builds (`@slayzone/task-artifacts/
 * export-html`), so only the engine differs:
 *   html → the document itself; no browser.
 *   pdf / png → a local headless Chrome-family browser: `--browser <path>`, else an
 *     installed Chrome/Chromium/Edge/Brave, else a headless shell cached by an earlier
 *     `--install-browser`; with none, `--install-browser` downloads one, and without
 *     that flag the export is refused with how to proceed.
 *
 * Engines are injected (`ExportDeps`), so the branching is tested without a browser.
 */
import {
  type ArtifactExportFormat,
  buildDocumentHtml,
  buildPngHtml,
  needsMermaidScript,
  needsReadyWait
} from '@slayzone/task-artifacts/export-html'

export { exportBaseName } from '@slayzone/task-artifacts/export-html'
import { defaultBrowserEnv, findBrowser } from './browser'
import { installHeadlessShell } from './browser-install'
import { loadMermaidJs } from './mermaid-js'
import { type RenderOptions, renderPdf, renderPng } from './render'

export class ExportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExportError'
  }
}

export interface ExportInput {
  type: ArtifactExportFormat
  content: string
  /** Effective render mode (`getEffectiveRenderMode`). */
  mode: string
  title: string
  /** `--browser <path>` */
  browser?: string
  /** `--install-browser` */
  installBrowser?: boolean
}

type Renderer = (browser: string, html: string, opts: RenderOptions) => Promise<Buffer>

export interface ExportDeps {
  loadMermaidJs: () => string
  /** Discovery steps after `--browser`: installed browser, then the cache. */
  findBrowser: () => string | null
  isExecutable: (p: string) => boolean
  /** Download the headless shell into the cache; its executable path. */
  installBrowser: () => Promise<string>
  renderPdf: Renderer
  renderPng: Renderer
  /** Progress / warnings (stderr: stdout carries the output path). */
  log: (line: string) => void
}

export function defaultExportDeps(): ExportDeps {
  const ctx = defaultBrowserEnv()
  const log = (line: string) => console.error(line)
  return {
    loadMermaidJs,
    findBrowser: () => findBrowser(ctx),
    isExecutable: ctx.isExecutable,
    installBrowser: () => installHeadlessShell({ ctx, log }),
    renderPdf,
    renderPng,
    log
  }
}

export function noBrowserMessage(type: 'pdf' | 'png'): string {
  return (
    `No browser found to render ${type.toUpperCase()}.\n` +
    'Run again with --install-browser (downloads Chromium, ~100 MB, once),\n' +
    'or use --type html.'
  )
}

async function resolveBrowser(input: ExportInput, deps: ExportDeps): Promise<string> {
  if (input.browser) {
    if (!deps.isExecutable(input.browser)) {
      throw new ExportError(`Browser not found or not executable: ${input.browser}`)
    }
    return input.browser
  }
  const found = deps.findBrowser()
  if (found) return found
  if (!input.installBrowser) throw new ExportError(noBrowserMessage(input.type as 'pdf' | 'png'))
  return deps.installBrowser()
}

/** The export file's bytes. Throws `ExportError` (and install/launch errors) with a user-facing message. */
export async function exportArtifact(
  input: ExportInput,
  deps: ExportDeps = defaultExportDeps()
): Promise<Buffer> {
  const { type, content, mode, title } = input
  const mermaidJs = needsMermaidScript(mode) ? deps.loadMermaidJs() : null

  if (type === 'html') {
    return Buffer.from(
      buildDocumentHtml(content, mode, title, mermaidJs, { standalone: true }),
      'utf8'
    )
  }

  const html =
    type === 'pdf'
      ? buildDocumentHtml(content, mode, title, mermaidJs)
      : buildPngHtml(content, mode, title, mermaidJs)
  if (html === null) throw new ExportError(`Cannot export "${title}" (${mode}) as ${type}.`)

  const browser = await resolveBrowser(input, deps)
  const opts: RenderOptions = { waitReady: needsReadyWait(mode), warn: deps.log }
  return type === 'pdf' ? deps.renderPdf(browser, html, opts) : deps.renderPng(browser, html, opts)
}
