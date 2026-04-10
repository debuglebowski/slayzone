/**
 * Tests for WebLinkProvider (clickable URL detection in terminal)
 * Run with: npx tsx packages/domains/terminal/src/client/web-link-provider.test.ts
 */
import { URL_REGEX, FILE_REGEX, getWindowedLineStrings, mapStringIndex } from './web-link-provider'
import type { Terminal, IBufferLine, ILink } from '@xterm/xterm'

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${e}`)
    failed++
  }
}

function assert(actual: unknown, expected: unknown, label?: string) {
  if (actual !== expected) {
    throw new Error(`${label ? label + ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function assertDeep(actual: unknown, expected: unknown, label?: string) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) {
    throw new Error(`${label ? label + ': ' : ''}expected ${b}, got ${a}`)
  }
}

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
console.log('\nURL_REGEX matching')
console.log('─'.repeat(40))

test('matches https URL', () => {
  assert(matchUrl('visit https://example.com today'), 'https://example.com')
})

test('matches http URL', () => {
  assert(matchUrl('visit http://example.com today'), 'http://example.com')
})

test('matches URL with path', () => {
  assert(matchUrl('see https://github.com/xtermjs/xterm.js/issues/123'), 'https://github.com/xtermjs/xterm.js/issues/123')
})

test('matches URL with query string', () => {
  assert(matchUrl('go to https://example.com/search?q=test&page=1'), 'https://example.com/search?q=test&page=1')
})

test('matches URL with fragment', () => {
  assert(matchUrl('see https://example.com/docs#section'), 'https://example.com/docs#section')
})

test('matches URL with port', () => {
  assert(matchUrl('running at http://localhost:3000/api'), 'http://localhost:3000/api')
})

test('excludes trailing period', () => {
  assert(matchUrl('Visit https://example.com.'), 'https://example.com')
})

test('excludes trailing comma', () => {
  assert(matchUrl('See https://example.com, then'), 'https://example.com')
})

test('excludes trailing exclamation', () => {
  assert(matchUrl('Check https://example.com!'), 'https://example.com')
})

test('excludes trailing question mark', () => {
  assert(matchUrl('Is it https://example.com?'), 'https://example.com')
})

test('excludes trailing colon', () => {
  assert(matchUrl('Source: https://example.com:'), 'https://example.com')
})

test('excludes surrounding parens', () => {
  assert(matchUrl('(https://example.com)'), 'https://example.com')
})

test('excludes surrounding angle brackets', () => {
  assert(matchUrl('<https://example.com>'), 'https://example.com')
})

test('excludes surrounding square brackets', () => {
  assert(matchUrl('[https://example.com]'), 'https://example.com')
})

test('does not match ftp', () => {
  assert(matchUrl('ftp://example.com'), null)
})

test('does not match bare domain', () => {
  assert(matchUrl('example.com'), null)
})

test('does not match mailto', () => {
  assert(matchUrl('mailto:test@example.com'), null)
})

test('matches multiple URLs', () => {
  const urls = matchAllUrls('see https://a.com and http://b.com/path for details')
  assert(urls.length, 2)
  assert(urls[0], 'https://a.com')
  assert(urls[1], 'http://b.com/path')
})

test('matches URL in Claude Code output', () => {
  assert(matchUrl('  Created PR: https://github.com/org/repo/pull/42'), 'https://github.com/org/repo/pull/42')
})

test('matches URL in npm output', () => {
  assert(matchUrl('npm warn deprecated https://registry.npmjs.org/pkg'), 'https://registry.npmjs.org/pkg')
})

test('matches HTTPS (uppercase)', () => {
  assert(matchUrl('HTTPS://EXAMPLE.COM/PATH'), 'HTTPS://EXAMPLE.COM/PATH')
})

// ─────────────────────────────────────
// getWindowedLineStrings
// ─────────────────────────────────────
console.log('\ngetWindowedLineStrings')
console.log('─'.repeat(40))

test('single non-wrapped line', () => {
  const term = mockTerminal([{ text: 'hello world', isWrapped: false }])
  const [lines, topIdx] = getWindowedLineStrings(0, term)
  assertDeep(lines, ['hello world'])
  assert(topIdx, 0)
})

test('joins wrapped lines downward', () => {
  const term = mockTerminal([
    { text: 'https://example.com/very/lo', isWrapped: false },
    { text: 'ng/path/that/wraps', isWrapped: true }
  ])
  const [lines, topIdx] = getWindowedLineStrings(0, term)
  assertDeep(lines, ['https://example.com/very/lo', 'ng/path/that/wraps'])
  assert(topIdx, 0)
})

test('joins wrapped lines upward', () => {
  const term = mockTerminal([
    { text: 'https://example.com/very/lo', isWrapped: false },
    { text: 'ng/path/that/wraps', isWrapped: true }
  ])
  const [lines, topIdx] = getWindowedLineStrings(1, term)
  assertDeep(lines, ['https://example.com/very/lo', 'ng/path/that/wraps'])
  assert(topIdx, 0)
})

test('stops upward expansion at whitespace (includes stop line)', () => {
  const term = mockTerminal([
    { text: 'some text ', isWrapped: false },
    { text: 'https://example.com/lo', isWrapped: true },
    { text: 'ng/path', isWrapped: true }
  ])
  // Expands up through wrapped lines, stops at line with space but includes it (same as xterm)
  const [lines, topIdx] = getWindowedLineStrings(2, term)
  assertDeep(lines, ['some text ', 'https://example.com/lo', 'ng/path'])
  assert(topIdx, 0)
})

test('stops downward expansion at non-wrapped line', () => {
  const term = mockTerminal([
    { text: 'https://a.com/pa', isWrapped: false },
    { text: 'th', isWrapped: true },
    { text: 'next line', isWrapped: false }
  ])
  const [lines, topIdx] = getWindowedLineStrings(0, term)
  assertDeep(lines, ['https://a.com/pa', 'th'])
  assert(topIdx, 0)
})

test('three wrapped lines', () => {
  const term = mockTerminal([
    { text: 'https://example.', isWrapped: false },
    { text: 'com/a/b/c/d/e/f/', isWrapped: true },
    { text: 'g/h/i/j', isWrapped: true }
  ])
  const [lines, topIdx] = getWindowedLineStrings(1, term)
  assertDeep(lines, ['https://example.', 'com/a/b/c/d/e/f/', 'g/h/i/j'])
  assert(topIdx, 0)
})

// ─────────────────────────────────────
// mapStringIndex
// ─────────────────────────────────────
console.log('\nmapStringIndex')
console.log('─'.repeat(40))

test('maps index within first line', () => {
  const term = mockTerminal([
    { text: 'hello world', isWrapped: false }
  ])
  assertDeep(mapStringIndex(term, 0, 0, 5), [0, 5])
})

test('maps index that crosses to second line', () => {
  const term = mockTerminal([
    { text: '0123456789', isWrapped: false },
    { text: 'abcdef', isWrapped: true }
  ])
  // String index 12 = 10 chars into line 0, then 2 into line 1
  assertDeep(mapStringIndex(term, 0, 0, 12), [1, 2])
})

test('maps index at line boundary', () => {
  const term = mockTerminal([
    { text: '01234', isWrapped: false },
    { text: 'abcde', isWrapped: true }
  ])
  assertDeep(mapStringIndex(term, 0, 0, 5), [1, 0])
})

test('maps with startCol offset', () => {
  const term = mockTerminal([
    { text: '0123456789', isWrapped: false }
  ])
  assertDeep(mapStringIndex(term, 0, 3, 4), [0, 7])
})

test('returns [-1, -1] for out-of-bounds line', () => {
  const term = mockTerminal([
    { text: 'short', isWrapped: false }
  ])
  assertDeep(mapStringIndex(term, 0, 0, 100), [-1, -1])
})

test('maps across three lines', () => {
  const term = mockTerminal([
    { text: '12345', isWrapped: false },
    { text: '67890', isWrapped: true },
    { text: 'abcde', isWrapped: true }
  ])
  // Index 12 = 5 + 5 + 2 → line 2, col 2
  assertDeep(mapStringIndex(term, 0, 0, 12), [2, 2])
})

// ─────────────────────────────────────
// FILE_REGEX
// ─────────────────────────────────────
console.log('\nFILE_REGEX matching')
console.log('─'.repeat(40))

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
  assert(matchFile('error in src/index.ts here'), 'src/index.ts')
})

test('matches dotslash relative path', () => {
  assert(matchFile('see ./src/main.tsx for details'), './src/main.tsx')
})

test('matches dot-dot relative path', () => {
  assert(matchFile('from ../utils/helper.js:'), '../utils/helper.js')
})

// With line:col
test('matches file:line', () => {
  assert(matchFile('src/index.ts:42'), 'src/index.ts:42')
})

test('matches file:line:col', () => {
  assert(matchFile('src/index.ts:42:10'), 'src/index.ts:42:10')
})

// Absolute paths
test('matches absolute path', () => {
  assert(matchFile('reading /Users/foo/project/main.rs'), '/Users/foo/project/main.rs')
})

test('matches absolute path with line:col', () => {
  assert(matchFile('/home/user/app.py:100:5'), '/home/user/app.py:100:5')
})

// Nested paths
test('matches deeply nested path', () => {
  assert(matchFile('packages/domains/terminal/src/client/Terminal.tsx'), 'packages/domains/terminal/src/client/Terminal.tsx')
})

// Real terminal output patterns
test('matches TypeScript error output', () => {
  assert(matchFile('src/App.tsx(89,7): error TS6133'), 'src/App.tsx')
})

test('matches Rust compiler output', () => {
  assert(matchFile('error[E0308]: src/lib.rs:15:5'), 'src/lib.rs:15:5')
})

test('matches go vet output', () => {
  assert(matchFile('pkg/server/handler.go:42:15: undefined'), 'pkg/server/handler.go:42:15')
})

// Non-matches
test('does not match plain words', () => {
  assert(matchFile('hello world'), null)
})

test('does not match URL (handled by WebLinkProvider)', () => {
  assert(matchFile('https://example.com/path.html'), null)
})

test('does not match path without extension', () => {
  assert(matchFile('src/utils/helpers'), null)
})

// Multiple files in one line
test('matches multiple files', () => {
  const files = matchAllFiles('diff src/a.ts src/b.ts')
  assert(files.length, 2)
  assert(files[0], 'src/a.ts')
  assert(files[1], 'src/b.ts')
})

// Bare filenames in parentheses (CLI tool output)
test('matches bare filename in Write()', () => {
  assert(matchFile('Write(test.tf)'), 'test.tf')
})

test('matches bare filename in Read()', () => {
  assert(matchFile('Read(config.yaml)'), 'config.yaml')
})

test('matches bare filename with single-char ext in parens', () => {
  assert(matchFile('Edit(main.c)'), 'main.c')
})

test('matches dotted bare filename in parens', () => {
  assert(matchFile('Write(jquery.min.js)'), 'jquery.min.js')
})

test('matches bare filename with line:col in parens', () => {
  assert(matchFile('Edit(test.tf:42:10)'), 'test.tf:42:10')
})

test('does not match bare filename without parens', () => {
  assert(matchFile('test.tf is here'), null)
})

// ─────────────────────────────────────
// WebLinkProvider.provideLinks (soft-continuation)
// ─────────────────────────────────────
console.log('\nWebLinkProvider soft-continuation')
console.log('─'.repeat(40))

import { WebLinkProvider } from './web-link-provider'

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
    { text: '  &scope=read+write&state=xyz123', isWrapped: false },
  ])
  const links = await getLinks(term, 1)
  assert(links.length, 1, 'should find 1 link')
  assert(
    links[0].text,
    'https://example.com/auth?client_id=abc&response_type=code&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&scope=read+write&state=xyz123',
    'should assemble full URL'
  )
})

test('resolves URL from continuation line (middle line)', async () => {
  const term = mockTerminal([
    { text: '  https://example.com/auth?client_id=abc&response_type=', isWrapped: false },
    { text: '  code&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback', isWrapped: false },
    { text: '  &scope=read+write&state=xyz123', isWrapped: false },
  ])
  const links = await getLinks(term, 2)
  assert(links.length, 1, 'should find 1 link')
  assert(
    links[0].text,
    'https://example.com/auth?client_id=abc&response_type=code&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&scope=read+write&state=xyz123',
    'should assemble full URL from context'
  )
})

test('resolves URL from continuation line (last line)', async () => {
  const term = mockTerminal([
    { text: '  https://example.com/auth?client_id=abc&response_type=', isWrapped: false },
    { text: '  code&redirect_uri=callback', isWrapped: false },
    { text: '  &state=xyz123', isWrapped: false },
  ])
  const links = await getLinks(term, 3)
  assert(links.length, 1, 'should find 1 link')
  assert(links[0].text.endsWith('&state=xyz123'), true, 'URL should include last fragment')
})

test('does not false-positive on indented non-URL text', async () => {
  const term = mockTerminal([
    { text: '  some random text here', isWrapped: false },
    { text: '  abcdef123456', isWrapped: false },
  ])
  const links = await getLinks(term, 2)
  assert(links.length, 0, 'should not create link without URL above')
})

test('stops soft-continuation at line with whitespace', async () => {
  const term = mockTerminal([
    { text: '  https://example.com/path?q=', isWrapped: false },
    { text: '  value one two', isWrapped: false },
  ])
  const links = await getLinks(term, 1)
  assert(links.length, 1, 'should find 1 link')
  // Should NOT extend through line with internal whitespace
  assert(links[0].text, 'https://example.com/path?q=', 'should not extend through whitespace line')
})

test('does not resolve non-indented continuation line', async () => {
  const term = mockTerminal([
    { text: '  https://example.com/path?q=', isWrapped: false },
    { text: 'continuation_no_indent', isWrapped: false },
  ])
  // Line 2 is not indented, so _resolveUrlFromContext should reject it
  const links = await getLinks(term, 2)
  assert(links.length, 0, 'non-indented line should not resolve as continuation')
})

test('Claude Code OAuth URL pattern', async () => {
  const term = mockTerminal([
    { text: '                                                                                                ', isWrapped: false },
    { text: '  https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=', isWrapped: false },
    { text: '  code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+', isWrapped: false },
    { text: '  user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload&code_', isWrapped: false },
    { text: '  challenge=O44F0Xd8JqqCj_xNOrBLO88VYMQ-PdpZZooZ4_g63Bk&code_challenge_method=S256&state=AYImunry9UZ6y_JIYR', isWrapped: false },
    { text: '  ziVxJESlTyNu4t-tYKiNqy2Wg', isWrapped: false },
    { text: '                                                                                                ', isWrapped: false },
  ])
  // Test from the first URL line
  const links1 = await getLinks(term, 2)
  assert(links1.length, 1, 'first URL line should have link')
  assert(links1[0].text.startsWith('https://claude.ai/oauth/authorize'), true, 'should start with scheme')
  assert(links1[0].text.endsWith('ziVxJESlTyNu4t-tYKiNqy2Wg'), true, 'should include last fragment')

  // Test from a middle continuation line
  const links3 = await getLinks(term, 4)
  assert(links3.length, 1, 'middle continuation should have link')
  assert(links3[0].text, links1[0].text, 'should resolve same full URL')

  // Test from the last continuation line
  const links5 = await getLinks(term, 6)
  assert(links5.length, 1, 'last continuation should have link')
  assert(links5[0].text, links1[0].text, 'should resolve same full URL')

  // Blank lines above/below should not get links
  const linksAbove = await getLinks(term, 1)
  assert(linksAbove.length, 0, 'blank line above should have no links')
  const linksBelow = await getLinks(term, 7)
  assert(linksBelow.length, 0, 'blank line below should have no links')
})

// Synchronous helper — provideLinks calls callback synchronously
function getLinksSync(term: Terminal, bufferLineNumber: number): ILink[] {
  const provider = new WebLinkProvider(term, () => {})
  let result: ILink[] = []
  provider.provideLinks(bufferLineNumber, (links) => { result = links ?? [] })
  return result
}

test('first-line link range extends through soft-continuation lines', () => {
  const term = mockTerminal([
    { text: '  https://example.com/auth?client_id=abc&response_type=', isWrapped: false },
    { text: '  code&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback', isWrapped: false },
    { text: '  &scope=read+write&state=xyz123', isWrapped: false },
  ])
  const links = getLinksSync(term, 1)
  assert(links.length, 1, 'should find 1 link')
  // Range should start on line 1 after indent
  assert(links[0].range.start.y, 1, 'start.y')
  assert(links[0].range.start.x, 3, 'start.x')
  // Range should END on the last continuation line (line 3), not line 1
  assert(links[0].range.end.y, 3, 'end.y should be last continuation line')
})

test('OAuth URL first-line range spans all continuation lines', () => {
  const term = mockTerminal([
    { text: '                                                                                                ', isWrapped: false },
    { text: '  https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=', isWrapped: false },
    { text: '  code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+', isWrapped: false },
    { text: '  user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload&code_', isWrapped: false },
    { text: '  challenge=O44F0Xd8JqqCj_xNOrBLO88VYMQ-PdpZZooZ4_g63Bk&code_challenge_method=S256&state=AYImunry9UZ6y_JIYR', isWrapped: false },
    { text: '  ziVxJESlTyNu4t-tYKiNqy2Wg', isWrapped: false },
    { text: '                                                                                                ', isWrapped: false },
  ])
  const links = getLinksSync(term, 2) // first URL line
  assert(links.length, 1, 'should find 1 link')
  assert(links[0].range.start.y, 2, 'start on first URL line')
  assert(links[0].range.end.y, 6, 'end on last continuation line')
})

// ─────────────────────────────────────
// FileLinkProvider wrapped lines
// ─────────────────────────────────────
console.log('\nFileLinkProvider wrapped lines')
console.log('─'.repeat(40))

import { FileLinkProvider } from './web-link-provider'

function getFileLinksSync(term: Terminal, bufferLineNumber: number): ILink[] {
  const provider = new FileLinkProvider(term, () => {})
  let result: ILink[] = []
  provider.provideLinks(bufferLineNumber, (links) => { result = links ?? [] })
  return result
}

test('detects file path split across wrapped lines (first line)', () => {
  // Simulates: ⏺ Update(packages/domains/ai-config/src/shared/skill-marketplace-registry.ts)
  // wrapped at col 60
  const term = mockTerminal([
    { text: '⏺ Update(packages/domains/ai-config/src/shared/skill-market', isWrapped: false },
    { text: 'place-registry.ts)', isWrapped: true },
  ])
  const links = getFileLinksSync(term, 1)
  assert(links.length, 1, 'should find 1 file link on first line')
  assert(links[0].text, 'packages/domains/ai-config/src/shared/skill-marketplace-registry.ts', 'full path')
})

test('detects file path split across wrapped lines (continuation line)', () => {
  const term = mockTerminal([
    { text: '⏺ Update(packages/domains/ai-config/src/shared/skill-market', isWrapped: false },
    { text: 'place-registry.ts)', isWrapped: true },
  ])
  const links = getFileLinksSync(term, 2)
  assert(links.length, 1, 'should find 1 file link on continuation line')
  assert(links[0].text, 'packages/domains/ai-config/src/shared/skill-marketplace-registry.ts', 'full path')
})

test('non-wrapped file path still works', () => {
  const term = mockTerminal([
    { text: '⏺ Update(packages/domains/ai-config/src/shared/skill-marketplace-registry.ts)', isWrapped: false },
  ])
  const links = getFileLinksSync(term, 1)
  assert(links.length, 1, 'should find 1 file link')
  assert(links[0].text, 'packages/domains/ai-config/src/shared/skill-marketplace-registry.ts', 'full path')
})

console.log('─'.repeat(40))
console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)
