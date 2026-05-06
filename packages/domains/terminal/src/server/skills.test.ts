/**
 * Tests for SKILL.md frontmatter parser.
 * Run with: npx tsx packages/domains/terminal/src/main/skills.test.ts
 */
import { parseFrontmatter } from './skills'

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? e.message : e}`)
    failed++
  }
}

function assertEqual<T>(actual: T, expected: T, label?: string): void {
  if (actual !== expected) {
    throw new Error(`${label ?? 'values'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

console.log('\nparseFrontmatter')

test('returns empty for text without frontmatter', () => {
  assertEqual(parseFrontmatter('no frontmatter here').name, undefined)
  assertEqual(parseFrontmatter('').name, undefined)
})

test('returns empty when closing --- missing', () => {
  assertEqual(parseFrontmatter('---\nname: x\n').name, undefined)
})

test('parses inline scalar name and description', () => {
  const fm = parseFrontmatter('---\nname: caveman\ndescription: Brief mode\n---\n\nbody')
  assertEqual(fm.name, 'caveman')
  assertEqual(fm.description, 'Brief mode')
})

test('strips single and double quotes from scalars', () => {
  const fm = parseFrontmatter(`---\nname: "quoted"\ndescription: 'brief'\n---\n`)
  assertEqual(fm.name, 'quoted')
  assertEqual(fm.description, 'brief')
})

test('parses `|` block scalar for description', () => {
  const src = [
    '---',
    'name: caveman',
    'description: |',
    '  Ultra-compressed communication mode.',
    '  Cuts token usage ~75%.',
    '---',
    '',
    'body',
  ].join('\n')
  const fm = parseFrontmatter(src)
  assertEqual(fm.name, 'caveman')
  assertEqual(fm.description, 'Ultra-compressed communication mode.\nCuts token usage ~75%.')
})

test('parses `>` folded block scalar', () => {
  const src = '---\ndescription: >\n  line one\n  line two\n---\n'
  const fm = parseFrontmatter(src)
  assertEqual(fm.description, 'line one\nline two')
})

test('ignores unknown keys', () => {
  const fm = parseFrontmatter('---\nname: x\nallowed-tools: [Read]\nmodel: sonnet\n---\n')
  assertEqual(fm.name, 'x')
  assertEqual(fm.description, undefined)
})

test('CRLF line endings', () => {
  const fm = parseFrontmatter('---\r\nname: win\r\ndescription: crlf\r\n---\r\n')
  assertEqual(fm.name, 'win')
  assertEqual(fm.description, 'crlf')
})

test('block scalar terminates at `---`', () => {
  const src = '---\ndescription: |\n  one\n  two\n---\nbody\n'
  const fm = parseFrontmatter(src)
  assertEqual(fm.description, 'one\ntwo')
})

test('exposes markdown body after closing ---', () => {
  const src = '---\nname: x\n---\n\nHello **world**.\n'
  const fm = parseFrontmatter(src)
  assertEqual(fm.body.trim(), 'Hello **world**.')
})

test('body is whole text when no frontmatter', () => {
  const fm = parseFrontmatter('no fm here')
  assertEqual(fm.body, 'no fm here')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
