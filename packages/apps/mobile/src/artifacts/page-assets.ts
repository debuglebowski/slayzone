/**
 * Scripts the artifact pages run, shipped inside the app bundle (never in the app's JS
 * bundle): put there at prebuild by `plugins/with-artifact-page-assets.js`, read here
 * when a page first needs one, then kept for the app's lifetime.
 */
import { File, Paths } from 'expo-file-system'

/** mermaid's browser build, desktop's version (`MERMAID_BUNDLE_FILE` in the plugin). */
export const MERMAID_BUNDLE_FILE = 'mermaid.min.js'

let mermaid: Promise<string> | null = null

/** The mermaid build's source, for a page that draws diagrams. */
export function loadMermaidScript(): Promise<string> {
  mermaid ??= new File(Paths.bundle, MERMAID_BUNDLE_FILE).text().catch((err: unknown) => {
    // A failed read is retried by the next page that asks.
    mermaid = null
    throw err
  })
  return mermaid
}
