/**
 * @vitest-environment jsdom
 *
 * Review 5, #3: the web shell draws a mermaid diagram for export with its own settings
 * as an init directive. Mermaid only takes frontmatter (`---\ntitle: …\n---`) at the
 * very start of the source, so a directive put before it made every diagram with
 * frontmatter fail ("Parse error on line 1"). Checked against the real mermaid parser.
 */
import mermaid from 'mermaid'
import { describe, expect, it } from 'vitest'
import { frontmatterLength, withExportDirective } from './mermaid-export-source'

const TITLED = '---\ntitle: Flow\n---\ngraph TD; A-->B'
const CONFIGURED =
  '---\ntitle: Flow\nconfig:\n  theme: forest\n  flowchart:\n    curve: linear\n---\ngraph TD; A-->B'

describe('frontmatterLength', () => {
  it.each([
    ['no frontmatter', 'graph TD; A-->B', 0],
    ['title', TITLED, '---\ntitle: Flow\n---\n'.length],
    [
      'blank lines after it are part of it',
      '---\ntitle: x\n---\n\n\ngraph TD',
      '---\ntitle: x\n---\n\n\n'.length
    ],
    ['indented', '  ---\n  title: x\n  ---\ngraph TD', '  ---\n  title: x\n  ---\n'.length],
    ['CRLF', '---\r\ntitle: x\r\n---\r\ngraph TD', '---\r\ntitle: x\r\n---\r\n'.length],
    ['not closed', '---\ntitle: x\ngraph TD', 0],
    ['closing fence with nothing after it', '---\ntitle: x\n---', 0],
    ['dashes not first', 'graph TD\n---\ntitle: x\n---\n', 0]
  ])('%s', (_label, code, length) => {
    expect(frontmatterLength(code)).toBe(length)
  })
})

describe('withExportDirective (real mermaid parser)', () => {
  it('a directive before frontmatter is what failed', async () => {
    await expect(mermaid.parse(`%%{init: {"theme": "default"}}%%\n${TITLED}`)).rejects.toThrow()
  })

  it('frontmatter with a title parses, title and look applied', async () => {
    const code = withExportDirective(TITLED, {}, { htmlLabels: true })
    expect(code.startsWith('---\ntitle: Flow\n---\n%%{init: ')).toBe(true)
    const parsed = await mermaid.parse(code)
    expect(parsed && parsed.config).toMatchObject({ theme: 'default', layout: 'dagre' })
  })

  it("the diagram's own config wins over the export's defaults, as on every other client", async () => {
    const own = (await mermaid.parse(CONFIGURED)) || { config: {} }
    const code = withExportDirective(CONFIGURED, own.config, { htmlLabels: true })
    const parsed = await mermaid.parse(code)
    expect(parsed && parsed.config).toMatchObject({
      theme: 'forest',
      layout: 'dagre',
      flowchart: { curve: 'linear' }
    })
  })

  it('plain-text labels (the tainting-browser fallback) are forced', async () => {
    const own = (await mermaid.parse(CONFIGURED)) || { config: {} }
    const parsed = await mermaid.parse(
      withExportDirective(CONFIGURED, own.config, { htmlLabels: false })
    )
    expect(parsed && parsed.config).toMatchObject({
      htmlLabels: false,
      flowchart: { htmlLabels: false, curve: 'linear' }
    })
  })

  it('no frontmatter: the directive goes first', async () => {
    const code = withExportDirective('graph TD; A-->B', {}, { htmlLabels: true })
    expect(code).toBe('%%{init: {"theme":"default","layout":"dagre"}}%%\ngraph TD; A-->B')
    await expect(mermaid.parse(code)).resolves.toBeTruthy()
  })
})
