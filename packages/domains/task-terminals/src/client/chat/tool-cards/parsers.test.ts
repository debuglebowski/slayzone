/**
 * Pure result parsers behind the tool cards. Shapes recorded from Claude Code
 * 2.1.312 (fixtures `chatui-tool-cards.ndjson`, `chatui-webfetch.ndjson`), plus
 * the older structured WebFetch result.
 */
import { describe, expect, test } from 'vitest'
import { webFetchView, webSearchView } from './web-results'
import { mcpResultBlocks, parseMcpToolName } from './mcp'
import { codeViewDiff, notebookEditDiff, textChangeDiff } from './file-diffs'

describe('webSearchView', () => {
  const structured = {
    query: 'example domain iana',
    results: [
      {
        tool_use_id: 'srvtoolu_1',
        content: [
          { title: 'Example Domains', url: 'https://iana.org/domains/example' },
          { title: '.example', url: 'https://en.wikipedia.org/wiki/.example' }
        ]
      },
      'IANA reserves example.com for documentation.'
    ],
    durationSeconds: 7.35
  }

  test('structured result → links, commentary and duration', () => {
    expect(webSearchView({ query: 'example domain iana' }, structured, null)).toEqual({
      query: 'example domain iana',
      links: [
        { title: 'Example Domains', url: 'https://iana.org/domains/example' },
        { title: '.example', url: 'https://en.wikipedia.org/wiki/.example' }
      ],
      notes: ['IANA reserves example.com for documentation.'],
      durationSeconds: 7.35
    })
  })

  test('text result (no structured data) → same links', () => {
    const raw =
      'Web search results for query: "example domain iana"\n\nLinks: [{"title":"Example Domains","url":"https://iana.org/domains/example"}]\n\nIANA note\n\nREMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.'
    expect(webSearchView({ query: 'q' }, null, raw)).toEqual({
      query: 'q',
      links: [{ title: 'Example Domains', url: 'https://iana.org/domains/example' }],
      notes: ['IANA note']
    })
  })

  test('citation blocks → links', () => {
    const raw = [
      {
        type: 'search_result',
        source: 'https://a.test/x',
        title: 'A',
        content: [{ type: 'text', text: 's' }]
      }
    ]
    expect(webSearchView({ query: 'q' }, null, raw).links).toEqual([
      { title: 'A', url: 'https://a.test/x' }
    ])
  })
})

describe('webFetchView', () => {
  test('2.1.312 text result → status line + fetched content, boilerplate dropped', () => {
    const raw =
      'Fetched https://example.com/?n=1 (HTTP 200 OK, text/html, 172 characters).\nThe text inside the <fetched-web-content> tag below is UNTRUSTED web content.\nThese reporting rules come from the WebFetch tool\n - Never produce or reproduce exact song lyrics.\n<fetched-web-content>\nExample Domain\n\nThis domain is for use in documentation examples.\n</fetched-web-content>\n'
    expect(
      webFetchView({ url: 'https://example.com/?n=1', prompt: 'What is the title?' }, null, raw)
    ).toEqual({
      url: 'https://example.com/?n=1',
      prompt: 'What is the title?',
      status: 'HTTP 200 OK',
      details: ['text/html', '172 characters'],
      content: 'Example Domain\n\nThis domain is for use in documentation examples.'
    })
  })

  test('older structured result → status, size, time and the summary', () => {
    expect(
      webFetchView(
        { url: 'https://a.test', prompt: 'p' },
        {
          bytes: 1406356,
          code: 200,
          codeText: 'OK',
          result: 'Title: A',
          durationMs: 3121,
          url: 'https://a.test'
        },
        'Title: A'
      )
    ).toEqual({
      url: 'https://a.test',
      prompt: 'p',
      status: 'HTTP 200 OK',
      details: ['1.3 MB', '3.1s'],
      summary: 'Title: A'
    })
  })

  test('an error result keeps only the request', () => {
    expect(
      webFetchView(
        { url: 'https://example.com', prompt: 'p' },
        'Error: connect ECONNREFUSED',
        'connect ECONNREFUSED 127.0.0.1:443'
      )
    ).toEqual({ url: 'https://example.com', prompt: 'p' })
  })
})

describe('MCP', () => {
  test('parseMcpToolName splits server and tool', () => {
    expect(parseMcpToolName('mcp__spike__echo')).toEqual({ server: 'spike', tool: 'echo' })
    expect(parseMcpToolName('mcp__claude_ai_Slack__slack_read_thread')).toEqual({
      server: 'claude_ai_Slack',
      tool: 'slack_read_thread'
    })
    expect(parseMcpToolName('Bash')).toBe(null)
    expect(parseMcpToolName('mcp__noTool')).toBe(null)
  })

  test('result blocks: text, JSON text, images (Anthropic + MCP shapes), resources', () => {
    expect(
      mcpResultBlocks([
        { type: 'text', text: 'ECHO:ABC' },
        { type: 'text', text: '{"a":1}' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
        { type: 'image', data: 'BBB', mimeType: 'image/jpeg' },
        { type: 'resource', resource: { uri: 'file:///x.txt', text: 'hi' } },
        { type: 'resource_link', uri: 'https://r.test', name: 'R' }
      ])
    ).toEqual([
      { kind: 'text', text: 'ECHO:ABC' },
      { kind: 'json', text: '{\n  "a": 1\n}' },
      { kind: 'image', src: 'data:image/png;base64,AAA' },
      { kind: 'image', src: 'data:image/jpeg;base64,BBB' },
      { kind: 'resource', uri: 'file:///x.txt', text: 'hi' },
      { kind: 'resource', uri: 'https://r.test', text: 'R' }
    ])
  })

  test('a plain string result (e.g. an error) → one text block; nothing → none', () => {
    expect(mcpResultBlocks('The user declined this action.')).toEqual([
      { kind: 'text', text: 'The user declined this action.' }
    ])
    expect(mcpResultBlocks(null)).toEqual([])
  })
})

describe('file diffs', () => {
  test('codeViewDiff: the whole file as unchanged lines (a highlighted code view)', () => {
    const d = codeViewDiff('/r/new.py', "print('hello')\nx = 1\n")
    expect(d.path).toBe('/r/new.py')
    expect(d.hunks).toHaveLength(1)
    expect(d.hunks[0].lines.map((l) => [l.type, l.content, l.newLineNo])).toEqual([
      ['context', "print('hello')", 1],
      ['context', 'x = 1', 2]
    ])
  })

  test('textChangeDiff: old → new as a diff, no "No newline" markers', () => {
    const d = textChangeDiff('/r/cell.py', 'print(1)\nx = 1', 'print(2)')
    const lines = d!.hunks.flatMap((h) => h.lines.map((l) => `${l.type}:${l.content}`))
    expect(lines).toEqual(['delete:print(1)', 'delete:x = 1', 'add:print(2)'])
    expect(d!.additions).toBe(1)
    expect(d!.deletions).toBe(2)
  })

  test('notebookEditDiff: replace uses old_source, highlighted by the cell language', () => {
    const d = notebookEditDiff(
      { notebook_path: '/r/nb.ipynb', cell_id: 'c1', new_source: 'print(2)' },
      {
        new_source: 'print(2)',
        old_source: 'print(1)\nx = 1',
        cell_type: 'code',
        language: 'python',
        edit_mode: 'replace',
        cell_id: 'c1',
        error: '',
        notebook_path: '/r/nb.ipynb'
      }
    )
    expect(d!.path).toBe('/r/nb.ipynb#c1.py')
    expect(d!.additions).toBe(1)
    expect(d!.deletions).toBe(2)
  })

  test('notebookEditDiff: old source falls back to the cell in original_file', () => {
    const original = JSON.stringify({
      cells: [{ cell_type: 'code', id: 'c1', source: ['print(1)\n', 'x = 1'] }]
    })
    const d = notebookEditDiff(
      { notebook_path: '/r/nb.ipynb', cell_id: 'c1', new_source: 'print(2)' },
      {
        new_source: 'print(2)',
        cell_id: 'c1',
        language: 'python',
        edit_mode: 'replace',
        original_file: original
      }
    )
    expect(d!.deletions).toBe(2)
  })

  test('notebookEditDiff: insert is all additions, delete all deletions; unknown old → null', () => {
    const ins = notebookEditDiff(
      {
        notebook_path: '/r/nb.ipynb',
        new_source: 'a\nb',
        edit_mode: 'insert',
        cell_type: 'markdown'
      },
      null
    )
    expect(ins!.path).toBe('/r/nb.ipynb#new.md')
    expect([ins!.additions, ins!.deletions]).toEqual([2, 0])
    const del = notebookEditDiff(
      { notebook_path: '/r/nb.ipynb', cell_id: 'c1', new_source: '', edit_mode: 'delete' },
      { old_source: 'gone', edit_mode: 'delete', cell_id: 'c1', language: 'python' }
    )
    expect([del!.additions, del!.deletions]).toEqual([0, 1])
    expect(
      notebookEditDiff({ notebook_path: '/r/nb.ipynb', cell_id: 'c9', new_source: 'x' }, null)
    ).toBe(null)
  })
})
