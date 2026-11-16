import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { inlineScript } from './pages/page-style'
import {
  HTML2CANVAS_BUNDLE_FILE,
  loadHtml2canvasScript,
  loadMermaidScript,
  MERMAID_BUNDLE_FILE
} from './page-assets'

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

  it('names the bundled files as the config plugin ships them', () => {
    const plugin = require('../../plugins/with-artifact-page-assets') as {
      MERMAID_BUNDLE_FILE: string
      HTML2CANVAS_BUNDLE_FILE: string
      PAGE_ASSETS: { file: string; build: (projectRoot: string) => string }[]
    }
    expect(MERMAID_BUNDLE_FILE).toBe(plugin.MERMAID_BUNDLE_FILE)
    expect(HTML2CANVAS_BUNDLE_FILE).toBe(plugin.HTML2CANVAS_BUNDLE_FILE)
    // Each build the plugin copies exists where it looks.
    const projectRoot = join(__dirname, '..', '..')
    expect(plugin.PAGE_ASSETS.map((a) => a.file)).toEqual([
      MERMAID_BUNDLE_FILE,
      HTML2CANVAS_BUNDLE_FILE
    ])
    for (const asset of plugin.PAGE_ASSETS) {
      expect(readFileSync(asset.build(projectRoot), 'utf8').length).toBeGreaterThan(1000)
    }
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

  it('reads html2canvas from the app bundle once, apart from mermaid', async () => {
    mockText.mockImplementation(async (uri: string) => `/* ${uri} */`)
    const first = await loadHtml2canvasScript()
    expect(await loadHtml2canvasScript()).toBe(first)
    expect(first).toBe(`/* file:///app/${HTML2CANVAS_BUNDLE_FILE} */`)
    expect(mockText).toHaveBeenCalledTimes(1)
  })

  it('a failed read is retried by the next caller', async () => {
    // A fresh module: nothing read yet.
    let load: () => Promise<string> = loadHtml2canvasScript
    jest.isolateModules(() => {
      load = (require('./page-assets') as typeof import('./page-assets')).loadHtml2canvasScript
    })
    mockText.mockRejectedValueOnce(new Error('missing')).mockResolvedValue('window.x=1')
    await expect(load()).rejects.toThrow('missing')
    await expect(load()).resolves.toBe('window.x=1')
  })

  it('ships a pinned html2canvas build that sets window.html2canvas and embeds inline safely', () => {
    const plugin = require('../../plugins/with-artifact-page-assets') as {
      PAGE_ASSETS: { file: string; build: (projectRoot: string) => string }[]
    }
    const asset = plugin.PAGE_ASSETS.find((a) => a.file === HTML2CANVAS_BUNDLE_FILE)
    const build = readFileSync(asset?.build(join(__dirname, '..', '..')) ?? '', 'utf8')
    expect(build).toContain('window.html2canvas=window.html2canvas.default')
    expect(build).not.toMatch(/<\/?script|<!--/i)
    // Pinned: a new build is a deliberate bump (the export draws every html PDF with it).
    const mobile = require('../../package.json') as { dependencies: Record<string, string> }
    expect(mobile.dependencies['html2canvas-pro']).toMatch(/^\d+\.\d+\.\d+$/)
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
