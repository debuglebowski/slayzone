/**
 * Scripts the artifact pages run, shipped inside the app bundle (never in the app's JS
 * bundle): put there at prebuild by `plugins/with-artifact-page-assets.js`, read here
 * when a page first needs one, then kept for the app's lifetime.
 */
import { File, Paths } from 'expo-file-system'

/** mermaid's browser build, desktop's version (`MERMAID_BUNDLE_FILE` in the plugin). */
export const MERMAID_BUNDLE_FILE = 'mermaid.min.js'

/** html2canvas's browser build (`HTML2CANVAS_BUNDLE_FILE` in the plugin). */
export const HTML2CANVAS_BUNDLE_FILE = 'html2canvas-pro.min.js'

const loaded = new Map<string, Promise<string>>()

/** A bundled script's source, read once; a failed read is retried by the next caller. */
function bundledScript(name: string): Promise<string> {
  let script = loaded.get(name)
  if (!script) {
    script = new File(Paths.bundle, name).text().catch((err: unknown) => {
      loaded.delete(name)
      throw err
    })
    loaded.set(name, script)
  }
  return script
}

/** The mermaid build's source, for a page that draws diagrams. */
export function loadMermaidScript(): Promise<string> {
  return bundledScript(MERMAID_BUNDLE_FILE)
}

/** The html2canvas build's source, for the export's html page (it draws the pages). */
export function loadHtml2canvasScript(): Promise<string> {
  return bundledScript(HTML2CANVAS_BUNDLE_FILE)
}
