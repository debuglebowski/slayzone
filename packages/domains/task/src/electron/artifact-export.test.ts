import { expect, test, vi } from 'vitest'

// The offscreen renderers need Electron; the HTML builders under test do not.
vi.mock('electron', () => ({ BrowserWindow: class {}, screen: {} }))
const { buildPdfHtml } = await import('./artifact-export')

test('a diff exports as line-numbered source, exactly as it did when it was code', () => {
  const patch = '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-const a = 1\n+const a = 2'
  const html = buildPdfHtml(patch, 'diff', 'fix.diff')
  expect(html).toBe(buildPdfHtml(patch, 'code', 'fix.diff'))
  expect(html).toContain('class="line-numbers"')
})
