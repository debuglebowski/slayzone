// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { GhMarkdown } from '@slayzone/markdown/client'
import {
  codexFileCitationLabel,
  parseCodexFileCitation,
  renderCodexFileCitations,
  resolveCitedPath
} from './codex-file-citations'

afterEach(cleanup)

const DOC = 'https://docs.google.com/document/d/1RWS8Uuw6lAD5F99ry3tIric3JtUPAWdKZFwMzF6PwFo'
const SHEET =
  'https://docs.google.com/spreadsheets/d/165_49fgp3AagbXJXyp6QXXSWagYuZK7KelbHyq_ePCc/edit'

describe('parseCodexFileCitation', () => {
  it('reads path + purpose', () => {
    expect(parseCodexFileCitation(`path="${DOC}" purpose="output"`)).toEqual({
      path: DOC,
      purpose: 'output'
    })
  })
  it('null purpose when unknown, null citation when no path', () => {
    expect(parseCodexFileCitation('path="/a/b.pdf" purpose="x"')?.purpose).toBeNull()
    expect(parseCodexFileCitation('purpose="source"')).toBeNull()
  })
})

describe('codexFileCitationLabel', () => {
  it('names Google file kinds', () => {
    expect(codexFileCitationLabel(DOC)).toBe('Google Doc')
    expect(codexFileCitationLabel(SHEET)).toBe('Google Sheet')
    expect(codexFileCitationLabel('https://docs.google.com/presentation/d/x')).toBe('Google Slides')
  })
  it('uses file name for local paths and other urls', () => {
    expect(codexFileCitationLabel('/Users/me/out/report.pdf')).toBe('report.pdf')
    expect(codexFileCitationLabel('https://example.com/files/My%20Deck.pptx')).toBe('My Deck.pptx')
    expect(codexFileCitationLabel('https://example.com/')).toBe('example.com')
  })
})

describe('renderCodexFileCitations', () => {
  it('leaves text without directives untouched', () => {
    const md = 'plain `code` text'
    expect(renderCodexFileCitations(md)).toBe(md)
  })

  it('skips fenced and inline code', () => {
    const md = [
      '```text',
      `:codex-file-citation{path="${DOC}" purpose="output"}`,
      '```',
      `\`:codex-file-citation{path="${DOC}"}\``
    ].join('\n')
    expect(renderCodexFileCitations(md)).toBe(md)
  })

  it('escapes attribute + label html', () => {
    const out = renderCodexFileCitations(':codex-file-citation{path="/tmp/<b>&x.txt"}')
    expect(out).toContain('&lt;b&gt;&amp;x.txt')
    expect(out).not.toContain('<b>')
  })

  it('renders chips through GhMarkdown (standalone + inline + wrapped attrs)', () => {
    const md = [
      'Next: verify cookie masking.',
      '',
      `:codex-file-citation{path="${DOC}" purpose="output"}`,
      '',
      `:codex-file-citation{path="${SHEET}"`,
      'purpose="output"}',
      '',
      'The review of :codex-file-citation{path="/repo/notes.md" purpose="source"} is due.'
    ].join('\n')
    const { container } = render(<GhMarkdown>{renderCodexFileCitations(md)}</GhMarkdown>)
    expect(container.textContent).not.toContain('codex-file-citation')
    const chips = [...container.querySelectorAll<HTMLAnchorElement>('a[data-file-citation-path]')]
    expect(
      chips.map((a) => [a.textContent, a.dataset.fileCitationPath, a.dataset.fileCitation])
    ).toEqual([
      ['Google Doc', DOC, 'output'],
      ['Google Sheet', SHEET, 'output'],
      ['notes.md', '/repo/notes.md', 'source']
    ])
    expect(chips[2].closest('p')?.textContent).toBe('The review of notes.md is due.')
  })
})

describe('resolveCitedPath', () => {
  it('keeps absolute, resolves relative against cwd, strips file://', () => {
    expect(resolveCitedPath('/a/b.md', '/repo')).toBe('/a/b.md')
    expect(resolveCitedPath('./docs/x.md', '/repo/')).toBe('/repo/docs/x.md')
    expect(resolveCitedPath('file:///tmp/My%20File.pdf', '/repo')).toBe('/tmp/My File.pdf')
  })
})
