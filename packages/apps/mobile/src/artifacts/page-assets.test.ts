import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { inlineScript } from './pages/page-style'
import { MERMAID_BUNDLE_FILE, loadMermaidScript } from './page-assets'

jest.mock('expo-file-system', () => {
  class FakeFile {
    uri: string
    constructor(dir: { uri: string }, name: string) {
      this.uri = `${dir.uri}${name}`
    }
    text() {
      return mockText(this.uri)
    }
  }
  return { File: FakeFile, Paths: { bundle: { uri: 'file:///app/' } } }
})
const mockText = jest.fn()

describe('page assets', () => {
  beforeEach(() => mockText.mockReset())

  it('names the bundled mermaid file as the config plugin ships it', () => {
    const plugin = require('../../plugins/with-artifact-page-assets') as {
      MERMAID_BUNDLE_FILE: string
    }
    expect(MERMAID_BUNDLE_FILE).toBe(plugin.MERMAID_BUNDLE_FILE)
  })

  it('reads mermaid from the app bundle once, and only when a page asks', async () => {
    mockText.mockResolvedValue('globalThis.mermaid={}')
    const first = await loadMermaidScript()
    const second = await loadMermaidScript()
    expect(first).toBe('globalThis.mermaid={}')
    expect(second).toBe(first)
    expect(mockText).toHaveBeenCalledTimes(1)
    expect(mockText).toHaveBeenCalledWith(`file:///app/${MERMAID_BUNDLE_FILE}`)
  })

  it("ships desktop's mermaid build, which embeds inline safely", () => {
    const buildPath = require.resolve('mermaid/dist/mermaid.min.js', { paths: [__dirname] })
    const build = readFileSync(buildPath, 'utf8')
    expect(build).toContain('globalThis["mermaid"]')
    expect(() => inlineScript('n', build)).not.toThrow()
    // Desktop's renderer package: the same range, so the workspace resolves one mermaid.
    const markdownDir = dirname(dirname(require.resolve('@slayzone/markdown/mermaid-config')))
    const desktop = JSON.parse(readFileSync(join(markdownDir, 'package.json'), 'utf8')) as {
      dependencies: { mermaid: string }
    }
    const mobile = require('../../package.json') as { dependencies: { mermaid: string } }
    expect(mobile.dependencies.mermaid).toBe(desktop.dependencies.mermaid)
  })
})
