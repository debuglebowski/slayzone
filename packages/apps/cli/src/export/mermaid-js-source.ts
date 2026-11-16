/**
 * Reads mermaid's standalone browser build (`mermaid/dist/mermaid.min.js`, ~5.5 MB).
 *
 * THIS implementation serves runs from source only (tests, tsx): it resolves the file
 * in the workspace's node_modules. build.mjs replaces the whole module when it bundles
 * `dist/slay.js` (plugin `inlineMermaid`) with one that carries the file inline,
 * brotli-compressed + base64, and decodes it here on demand — so the shipped CLI stays
 * ONE self-contained file (it is copied alone into the desktop app's resources, the
 * npm package, and Windows' PATH dir). Compressed because a plain 5.5 MB string
 * literal is parsed on EVERY `slay` start (+~36 ms measured, vs ~7 ms for the ~1.8 MB
 * base64 form); decoding (~20 ms) is paid only by a mermaid export.
 *
 * Keep the export's name and signature in sync with the replacement in build.mjs.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

export function readMermaidJs(): string {
  // Anchored like service.ts (the entry script, then the cwd): `import.meta` does not
  // exist under the package's CommonJS typecheck.
  const anchors = [process.argv[1], path.join(process.cwd(), 'x')].filter(
    (a): a is string => typeof a === 'string'
  )
  for (const anchor of anchors) {
    try {
      return readFileSync(createRequire(anchor).resolve('mermaid/dist/mermaid.min.js'), 'utf8')
    } catch {
      // next anchor
    }
  }
  throw new Error('mermaid/dist/mermaid.min.js not found (run from the workspace)')
}
