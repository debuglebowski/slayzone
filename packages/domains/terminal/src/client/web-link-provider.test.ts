/**
 * Tests for WebLinkProvider (clickable URL detection in terminal)
 */
import { describe, expect, test } from 'vitest'
import {
  URL_REGEX,
  FILE_REGEX,
  getWindowedLineStrings,
  mapStringIndex,
  WebLinkProvider,
  FileLinkProvider
} from './web-link-provider'
import type { Terminal, IBufferLine, ILink } from '@xterm/xterm'

function matchUrl(text: string): string | null {
  const m = text.match(URL_REGEX)
  return m ? m[0] : null
}

function matchAllUrls(text: string): string[] {
  const regex = new RegExp(URL_REGEX.source, 'g')
  const results: string[] = []
  let m: RegExpExecArray | null
  while ((m = regex.exec(text)) !== null) results.push(m[0])
  return results
}

// Mock terminal buffer for multi-line tests
function mockTerminal(lines: { text: string; isWrapped: boolean }[]): Terminal {
  const bufferLines = lines.map((l) => ({
    translateToString: () => l.text,
    isWrapped: l.isWrapped,
    length: l.text.length
  }))
  return {
    buffer: {
      active: {
        getLine: (i: number): IBufferLine | undefined =>
          i >= 0 && i < bufferLines.length ? (bufferLines[i] as unknown as IBufferLine) : undefined
      }
    }
  } as unknown as Terminal
}

// ─────────────────────────────────────
// URL_REGEX
// ─────────────────────────────────────
describe('URL_REGEX matching', () => {
  test('matches https URL', () => {
    expect(matchUrl('visit https://example.com today')).toBe('https://example.com')
  })

  test('matches http URL', () => {
    expect(matchUrl('visit http://example.com today')).toBe('http://example.com')
  })

  test('matches URL with path', () => {
    expect(matchUrl('see https://github.com/xtermjs/xterm.js/issues/123')).toBe(
      'https://github.com/xtermjs/xterm.js/issues/123'
    )
  })

  test('matches URL with query string', () => {
    expect(matchUrl('go to https://example.com/search?q=test&page=1')).toBe(
      'https://example.com/search?q=test&page=1'
    )
  })

  test('matches URL with fragment', () => {
    expect(matchUrl('see https://example.com/docs#section')).toBe(
      'https://example.com/docs#section'
    )
  })

  test('matches URL with port', () => {
    expect(matchUrl('running at http://localhost:3000/api')).toBe('http://localhost:3000/api')
  })

  test('excludes trailing period', () => {
    expect(matchUrl('Visit https://example.com.')).toBe('https://example.com')
  })

  test('excludes trailing comma', () => {
    expect(matchUrl('See https://example.com, then')).toBe('https://example.com')
  })

  test('excludes trailing exclamation', () => {
    expect(matchUrl('Check https://example.com!')).toBe('https://example.com')
  })

  test('excludes trailing question mark', () => {
    expect(matchUrl('Is it https://example.com?')).toBe('https://example.com')
  })

  test('excludes trailing colon', () => {
    expect(matchUrl('Source: https://example.com:')).toBe('https://example.com')
  })

  test('excludes surrounding parens', () => {
    expect(matchUrl('(https://example.com)')).toBe('https://example.com')
  })

  test('excludes surrounding angle brackets', () => {
    expect(matchUrl('<https://example.com>')).toBe('https://example.com')
  })

  test('excludes surrounding square brackets', () => {
    expect(matchUrl('[https://example.com]')).toBe('https://example.com')
  })

  test('does not match ftp', () => {
    expect(matchUrl('ftp://example.com')).toBe(null)
  })

  test('does not match bare domain', () => {
    expect(matchUrl('example.com')).toBe(null)
  })

  test('does not match mailto', () => {
    expect(matchUrl('mailto:test@example.com')).toBe(null)
  })

  test('matches multiple URLs', () => {
    const urls = matchAllUrls('see https://a.com and http://b.com/path for details')
    expect(urls.length).toBe(2)
    expect(urls[0]).toBe('https://a.com')
    expect(urls[1]).toBe('http://b.com/path')
  })

  test('matches URL in Claude Code output', () => {
    expect(matchUrl('  Created PR: https://github.com/org/repo/pull/42')).toBe(
      'https://github.com/org/repo/pull/42'
    )
  })

  test('matches URL in npm output', () => {
    expect(matchUrl('npm warn deprecated https://registry.npmjs.org/pkg')).toBe(
      'https://registry.npmjs.org/pkg'
    )
  })

  test('matches HTTPS (uppercase)', () => {
    expect(matchUrl('HTTPS://EXAMPLE.COM/PATH')).toBe('HTTPS://EXAMPLE.COM/PATH')
  })
})

// ─────────────────────────────────────
// getWindowedLineStrings
// ─────────────────────────────────────
describe('getWindowedLineStrings', () => {
  test('single non-wrapped line', () => {
    const term = mockTerminal([{ text: 'hello world', isWrapped: false }])
    const [lines, topIdx] = getWindowedLineStrings(0, term)
    expect(lines).toEqual(['hello world'])
    expect(topIdx).toBe(0)
  })

  test('joins wrapped lines downward', () => {
    const term = mockTerminal([
      { text: 'https://example.com/very/lo', isWrapped: false },
      { text: 'ng/path/that/wraps', isWrapped: true }
    ])
    const [lines, topIdx] = getWindowedLineStrings(0, term)
    expect(lines).toEqual(['https://example.com/very/lo', 'ng/path/that/wraps'])
    expect(topIdx).toBe(0)
  })

  test('joins wrapped lines upward', () => {
    const term = mockTerminal([
      { text: 'https://example.com/very/lo', isWrapped: false },
      { text: 'ng/path/that/wraps', isWrapped: true }
    ])
    const [lines, topIdx] = getWindowedLineStrings(1, term)
    expect(lines).toEqual(['https://example.com/very/lo', 'ng/path/that/wraps'])
    expect(topIdx).toBe(0)
  })

  test('stops upward expansion at whitespace (includes stop line)', () => {
    const term = mockTerminal([
      { text: 'some text ', isWrapped: false },
      { text: 'https://example.com/lo', isWrapped: true },
      { text: 'ng/path', isWrapped: true }
    ])
    // Expands up through wrapped lines, stops at line with space but includes it (same as xterm)
    const [lines, topIdx] = getWindowedLineStrings(2, term)
    expect(lines).toEqual(['some text ', 'https://example.com/lo', 'ng/path'])
    expect(topIdx).toBe(0)
  })

  test('stops downward expansion at non-wrapped line', () => {
    const term = mockTerminal([
      { text: 'https://a.com/pa', isWrapped: false },
      { text: 'th', isWrapped: true },
      { text: 'next line', isWrapped: false }
    ])
    const [lines, topIdx] = getWindowedLineStrings(0, term)
    expect(lines).toEqual(['https://a.com/pa', 'th'])
    expect(topIdx).toBe(0)
  })

  test('three wrapped lines', () => {
    const term = mockTerminal([
      { text: 'https://example.', isWrapped: false },
      { text: 'com/a/b/c/d/e/f/', isWrapped: true },
      { text: 'g/h/i/j', isWrapped: true }
    ])
    const [lines, topIdx] = getWindowedLineStrings(1, term)
    expect(lines).toEqual(['https://example.', 'com/a/b/c/d/e/f/', 'g/h/i/j'])
    expect(topIdx).toBe(0)
  })
})

// ─────────────────────────────────────
// mapStringIndex
// ─────────────────────────────────────
describe('mapStringIndex', () => {
  test('maps index within first line', () => {
    const term = mockTerminal([{ text: 'hello world', isWrapped: false }])
    expect(mapStringIndex(term, 0, 0, 5)).toEqual([0, 5])
  })

  test('maps index that crosses to second line', () => {
    const term = mockTerminal([
      { text: '0123456789', isWrapped: false },
      { text: 'abcdef', isWrapped: true }
    ])
    // String index 12 = 10 chars into line 0, then 2 into line 1
    expect(mapStringIndex(term, 0, 0, 12)).toEqual([1, 2])
  })

  test('maps index at line boundary', () => {
    const term = mockTerminal([
      { text: '01234', isWrapped: false },
      { text: 'abcde', isWrapped: true }
    ])
    expect(mapStringIndex(term, 0, 0, 5)).toEqual([1, 0])
  })

  test('maps with startCol offset', () => {
    const term = mockTerminal([{ text: '0123456789', isWrapped: false }])
    expect(mapStringIndex(term, 0, 3, 4)).toEqual([0, 7])
  })

  test('returns [-1, -1] for out-of-bounds line', () => {
    const term = mockTerminal([{ text: 'short', isWrapped: false }])
    expect(mapStringIndex(term, 0, 0, 100)).toEqual([-1, -1])
  })

  test('maps across three lines', () => {
    const term = mockTerminal([
      { text: '12345', isWrapped: false },
      { text: '67890', isWrapped: true },
      { text: 'abcde', isWrapped: true }
    ])
    // Index 12 = 5 + 5 + 2 → line 2, col 2
    expect(mapStringIndex(term, 0, 0, 12)).toEqual([2, 2])
  })
})

// ─────────────────────────────────────
// FILE_REGEX
// ─────────────────────────────────────
describe('FILE_REGEX matching', () => {
  function matchFile(text: string): string | null {
    const m = text.match(FILE_REGEX)
    return m ? m[0] : null
  }

  function matchAllFiles(text: string): string[] {
    const regex = new RegExp(FILE_REGEX.source, 'g')
    const results: string[] = []
    let m: RegExpExecArray | null
    while ((m = regex.exec(text)) !== null) results.push(m[0])
    return results
  }

  // Relative paths
  test('matches relative path with extension', () => {
    expect(matchFile('error in src/index.ts here')).toBe('src/index.ts')
  })

  test('matches dotslash relative path', () => {
    expect(matchFile('see ./src/main.tsx for details')).toBe('./src/main.tsx')
  })

  test('matches dot-dot relative path', () => {
    expect(matchFile('from ../utils/helper.js:')).toBe('../utils/helper.js')
  })

  // With line:col
  test('matches file:line', () => {
    expect(matchFile('src/index.ts:42')).toBe('src/index.ts:42')
  })

  test('matches file:line:col', () => {
    expect(matchFile('src/index.ts:42:10')).toBe('src/index.ts:42:10')
  })

  // Absolute paths
  test('matches absolute path', () => {
    expect(matchFile('reading /Users/foo/project/main.rs')).toBe('/Users/foo/project/main.rs')
  })

  test('matches absolute path with line:col', () => {
    expect(matchFile('/home/user/app.py:100:5')).toBe('/home/user/app.py:100:5')
  })

  // Nested paths
  test('matches deeply nested path', () => {
    expect(matchFile('packages/domains/terminal/src/client/Terminal.tsx')).toBe(
      'packages/domains/terminal/src/client/Terminal.tsx'
    )
  })

  // Real terminal output patterns
  test('matches TypeScript error output', () => {
    expect(matchFile('src/App.tsx(89,7): error TS6133')).toBe('src/App.tsx')
  })

  test('matches Rust compiler output', () => {
    expect(matchFile('error[E0308]: src/lib.rs:15:5')).toBe('src/lib.rs:15:5')
  })

  test('matches go vet output', () => {
    expect(matchFile('pkg/server/handler.go:42:15: undefined')).toBe('pkg/server/handler.go:42:15')
  })

  // Non-matches
  test('does not match plain words', () => {
    expect(matchFile('hello world')).toBe(null)
  })

  test('does not match URL (handled by WebLinkProvider)', () => {
    expect(matchFile('https://example.com/path.html')).toBe(null)
  })

  test('does not match path without extension', () => {
    expect(matchFile('src/utils/helpers')).toBe(null)
  })

  // Multiple files in one line
  test('matches multiple files', () => {
    const files = matchAllFiles('diff src/a.ts src/b.ts')
    expect(files.length).toBe(2)
    expect(files[0]).toBe('src/a.ts')
    expect(files[1]).toBe('src/b.ts')
  })

  // Bare filenames in parentheses (CLI tool output)
  test('matches bare filename in Write()', () => {
    expect(matchFile('Write(test.tf)')).toBe('test.tf')
  })

  test('matches bare filename in Read()', () => {
    expect(matchFile('Read(config.yaml)')).toBe('config.yaml')
  })

  test('matches bare filename with single-char ext in parens', () => {
    expect(matchFile('Edit(main.c)')).toBe('main.c')
  })

  test('matches dotted bare filename in parens', () => {
    expect(matchFile('Write(jquery.min.js)')).toBe('jquery.min.js')
  })

  test('matches bare filename with line:col in parens', () => {
    expect(matchFile('Edit(test.tf:42:10)')).toBe('test.tf:42:10')
  })

  test('does not match bare filename without parens', () => {
    expect(matchFile('test.tf is here')).toBe(null)
  })
})

// ─────────────────────────────────────
// WebLinkProvider.provideLinks (soft-continuation)
// ─────────────────────────────────────
describe('WebLinkProvider soft-continuation', () => {
  function getLinks(term: Terminal, bufferLineNumber: number): Promise<ILink[]> {
    const provider = new WebLinkProvider(term, () => {})
    return new Promise((resolve) => {
      provider.provideLinks(bufferLineNumber, (links) => resolve(links ?? []))
    })
  }

  test('extends URL through soft-continuation lines (first line)', async () => {
    const term = mockTerminal([
      { text: '  https://example.com/auth?client_id=abc&response_type=', isWrapped: false },
      { text: '  code&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback', isWrapped: false },
      { text: '  &scope=read+write&state=xyz123', isWrapped: false }
    ])
    const links = await getLinks(term, 1)
    expect(links.length, 'should find 1 link').toBe(1)
    expect(links[0].text, 'should assemble full URL').toBe(
      'https://example.com/auth?client_id=abc&response_type=code&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&scope=read+write&state=xyz123'
    )
  })

  test('resolves URL from continuation line (middle line)', async () => {
    const term = mockTerminal([
      { text: '  https://example.com/auth?client_id=abc&response_type=', isWrapped: false },
      { text: '  code&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback', isWrapped: false },
      { text: '  &scope=read+write&state=xyz123', isWrapped: false }
    ])
    const links = await getLinks(term, 2)
    expect(links.length, 'should find 1 link').toBe(1)
    expect(links[0].text, 'should assemble full URL from context').toBe(
      'https://example.com/auth?client_id=abc&response_type=code&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&scope=read+write&state=xyz123'
    )
  })

  test('resolves URL from continuation line (last line)', async () => {
    const term = mockTerminal([
      { text: '  https://example.com/auth?client_id=abc&response_type=', isWrapped: false },
      { text: '  code&redirect_uri=callback', isWrapped: false },
      { text: '  &state=xyz123', isWrapped: false }
    ])
    const links = await getLinks(term, 3)
    expect(links.length, 'should find 1 link').toBe(1)
    expect(links[0].text.endsWith('&state=xyz123'), 'URL should include last fragment').toBe(true)
  })

  test('does not false-positive on indented non-URL text', async () => {
    const term = mockTerminal([
      { text: '  some random text here', isWrapped: false },
      { text: '  abcdef123456', isWrapped: false }
    ])
    const links = await getLinks(term, 2)
    expect(links.length, 'should not create link without URL above').toBe(0)
  })

  test('stops soft-continuation at line with whitespace', async () => {
    const term = mockTerminal([
      { text: '  https://example.com/path?q=', isWrapped: false },
      { text: '  value one two', isWrapped: false }
    ])
    const links = await getLinks(term, 1)
    expect(links.length, 'should find 1 link').toBe(1)
    // Should NOT extend through line with internal whitespace
    expect(links[0].text, 'should not extend through whitespace line').toBe(
      'https://example.com/path?q='
    )
  })

  test('does not resolve non-indented continuation line', async () => {
    const term = mockTerminal([
      { text: '  https://example.com/path?q=', isWrapped: false },
      { text: 'continuation_no_indent', isWrapped: false }
    ])
    // Line 2 is not indented, so _resolveUrlFromContext should reject it
    const links = await getLinks(term, 2)
    expect(links.length, 'non-indented line should not resolve as continuation').toBe(0)
  })

  test('Claude Code OAuth URL pattern', async () => {
    const term = mockTerminal([
      {
        text: '                                                                                                ',
        isWrapped: false
      },
      {
        text: '  https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=',
        isWrapped: false
      },
      {
        text: '  code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+',
        isWrapped: false
      },
      {
        text: '  user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload&code_',
        isWrapped: false
      },
      {
        text: '  challenge=O44F0Xd8JqqCj_xNOrBLO88VYMQ-PdpZZooZ4_g63Bk&code_challenge_method=S256&state=AYImunry9UZ6y_JIYR',
        isWrapped: false
      },
      { text: '  ziVxJESlTyNu4t-tYKiNqy2Wg', isWrapped: false },
      {
        text: '                                                                                                ',
        isWrapped: false
      }
    ])
    // Test from the first URL line
    const links1 = await getLinks(term, 2)
    expect(links1.length, 'first URL line should have link').toBe(1)
    expect(
      links1[0].text.startsWith('https://claude.ai/oauth/authorize'),
      'should start with scheme'
    ).toBe(true)
    expect(
      links1[0].text.endsWith('ziVxJESlTyNu4t-tYKiNqy2Wg'),
      'should include last fragment'
    ).toBe(true)

    // Test from a middle continuation line
    const links3 = await getLinks(term, 4)
    expect(links3.length, 'middle continuation should have link').toBe(1)
    expect(links3[0].text, 'should resolve same full URL').toBe(links1[0].text)

    // Test from the last continuation line
    const links5 = await getLinks(term, 6)
    expect(links5.length, 'last continuation should have link').toBe(1)
    expect(links5[0].text, 'should resolve same full URL').toBe(links1[0].text)

    // Blank lines above/below should not get links
    const linksAbove = await getLinks(term, 1)
    expect(linksAbove.length, 'blank line above should have no links').toBe(0)
    const linksBelow = await getLinks(term, 7)
    expect(linksBelow.length, 'blank line below should have no links').toBe(0)
  })

  // Synchronous helper — provideLinks calls callback synchronously
  function getLinksSync(term: Terminal, bufferLineNumber: number): ILink[] {
    const provider = new WebLinkProvider(term, () => {})
    let result: ILink[] = []
    provider.provideLinks(bufferLineNumber, (links) => {
      result = links ?? []
    })
    return result
  }

  test('first-line link range extends through soft-continuation lines', () => {
    const term = mockTerminal([
      { text: '  https://example.com/auth?client_id=abc&response_type=', isWrapped: false },
      { text: '  code&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback', isWrapped: false },
      { text: '  &scope=read+write&state=xyz123', isWrapped: false }
    ])
    const links = getLinksSync(term, 1)
    expect(links.length, 'should find 1 link').toBe(1)
    // Range should start on line 1 after indent
    expect(links[0].range.start.y, 'start.y').toBe(1)
    expect(links[0].range.start.x, 'start.x').toBe(3)
    // Range should END on the last continuation line (line 3), not line 1
    expect(links[0].range.end.y, 'end.y should be last continuation line').toBe(3)
  })

  test('OAuth URL first-line range spans all continuation lines', () => {
    const term = mockTerminal([
      {
        text: '                                                                                                ',
        isWrapped: false
      },
      {
        text: '  https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=',
        isWrapped: false
      },
      {
        text: '  code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+',
        isWrapped: false
      },
      {
        text: '  user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload&code_',
        isWrapped: false
      },
      {
        text: '  challenge=O44F0Xd8JqqCj_xNOrBLO88VYMQ-PdpZZooZ4_g63Bk&code_challenge_method=S256&state=AYImunry9UZ6y_JIYR',
        isWrapped: false
      },
      { text: '  ziVxJESlTyNu4t-tYKiNqy2Wg', isWrapped: false },
      {
        text: '                                                                                                ',
        isWrapped: false
      }
    ])
    const links = getLinksSync(term, 2) // first URL line
    expect(links.length, 'should find 1 link').toBe(1)
    expect(links[0].range.start.y, 'start on first URL line').toBe(2)
    expect(links[0].range.end.y, 'end on last continuation line').toBe(6)
  })
})

// ─────────────────────────────────────
// FileLinkProvider wrapped lines
// ─────────────────────────────────────
describe('FileLinkProvider wrapped lines', () => {
  function getFileLinksSync(term: Terminal, bufferLineNumber: number): ILink[] {
    const provider = new FileLinkProvider(term, () => {})
    let result: ILink[] = []
    provider.provideLinks(bufferLineNumber, (links) => {
      result = links ?? []
    })
    return result
  }

  test('detects file path split across wrapped lines (first line)', () => {
    // Simulates: ⏺ Update(packages/domains/ai-config/src/shared/skill-marketplace-registry.ts)
    // wrapped at col 60
    const term = mockTerminal([
      { text: '⏺ Update(packages/domains/ai-config/src/shared/skill-market', isWrapped: false },
      { text: 'place-registry.ts)', isWrapped: true }
    ])
    const links = getFileLinksSync(term, 1)
    expect(links.length, 'should find 1 file link on first line').toBe(1)
    expect(links[0].text, 'full path').toBe(
      'packages/domains/ai-config/src/shared/skill-marketplace-registry.ts'
    )
  })

  test('detects file path split across wrapped lines (continuation line)', () => {
    const term = mockTerminal([
      { text: '⏺ Update(packages/domains/ai-config/src/shared/skill-market', isWrapped: false },
      { text: 'place-registry.ts)', isWrapped: true }
    ])
    const links = getFileLinksSync(term, 2)
    expect(links.length, 'should find 1 file link on continuation line').toBe(1)
    expect(links[0].text, 'full path').toBe(
      'packages/domains/ai-config/src/shared/skill-marketplace-registry.ts'
    )
  })

  test('non-wrapped file path still works', () => {
    const term = mockTerminal([
      {
        text: '⏺ Update(packages/domains/ai-config/src/shared/skill-marketplace-registry.ts)',
        isWrapped: false
      }
    ])
    const links = getFileLinksSync(term, 1)
    expect(links.length, 'should find 1 file link').toBe(1)
    expect(links[0].text, 'full path').toBe(
      'packages/domains/ai-config/src/shared/skill-marketplace-registry.ts'
    )
  })
})
