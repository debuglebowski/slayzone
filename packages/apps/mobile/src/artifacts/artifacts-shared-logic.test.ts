/**
 * The desktop logic the artifact screens reuse — imported the way the app imports it,
 * through the packages' DOM-free subpaths — plus the artifact modules that use it, in
 * React Native's test environment. A module that touches the DOM at import time fails
 * here, and so does any runtime import of a desktop-only package or of a Node built-in
 * (the app's bundler resolves no `node:` module): each is mocked to throw when loaded.
 * Same guard as `../shared-logic.test.ts`, for the artifacts' set.
 */
import { mermaidInitOptions } from '@slayzone/markdown/mermaid-config'
import { injectForcedHtmlTheme } from '@slayzone/platform/forced-html-theme'
import { parseHtmlPreviewLinkMessage } from '@slayzone/platform/html-preview-links'
import { groupArtifactTree } from '@slayzone/task-artifacts/shared'
import { getEffectiveRenderMode } from '@slayzone/task-contracts/types'
import { searchArtifacts } from './search'
import { uploadArtifact } from './upload'
import { downloadArtifactFile } from './files'
import { markdownPage } from './pages/markdown-page'
import { htmlReportPage } from './pages/html-report-page'
import { testPageTheme } from './testing'

jest.mock('node:crypto', () => {
  throw new Error('node:crypto (a Node built-in) loaded')
})
jest.mock('node:fs', () => {
  throw new Error('node:fs (a Node built-in) loaded')
})
jest.mock('node:path', () => {
  throw new Error('node:path (a Node built-in) loaded')
})
jest.mock('node:os', () => {
  throw new Error('node:os (a Node built-in) loaded')
})
jest.mock('@slayzone/ui', () => {
  throw new Error('@slayzone/ui (desktop UI kit) loaded')
})
jest.mock('react-dom', () => {
  throw new Error('react-dom loaded')
})
jest.mock('lucide-react', () => {
  throw new Error('lucide-react (DOM icons) loaded')
})
jest.mock('mermaid', () => {
  throw new Error('mermaid loaded into the app bundle (it belongs in the web view only)')
})
jest.mock('react-markdown', () => {
  throw new Error('react-markdown (desktop markdown) loaded')
})

describe('artifact logic shared with desktop', () => {
  it('loads without the DOM, Node, or desktop UI, and works', () => {
    expect(getEffectiveRenderMode('a.md', null)).toBe('markdown')
    expect(groupArtifactTree([], []).childFolders.size).toBe(0)
    expect(mermaidInitOptions('dark').securityLevel).toBe('strict')
    expect(injectForcedHtmlTheme('<p>x</p>', 'dark')).toContain('color-scheme:dark')
    expect(parseHtmlPreviewLinkMessage(null)).toBeNull()
    expect(
      markdownPage('# x', { theme: testPageTheme('dark'), mermaidScript: null }).html
    ).toContain('<h1>x</h1>')
    expect(htmlReportPage('<p>x</p>', { forcedTheme: null })).toContain('sandbox="allow-scripts"')
    expect(typeof searchArtifacts).toBe('function')
    expect(typeof uploadArtifact).toBe('function')
    expect(typeof downloadArtifactFile).toBe('function')
  })
})
