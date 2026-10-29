/**
 * Tests for SKILL.md frontmatter parser.
 */
import { expect, test } from 'vitest'
import { parseFrontmatter } from './skills'

test('returns empty for text without frontmatter', () => {
  expect(parseFrontmatter('no frontmatter here').name).toBe(undefined)
  expect(parseFrontmatter('').name).toBe(undefined)
})

test('returns empty when closing --- missing', () => {
  expect(parseFrontmatter('---\nname: x\n').name).toBe(undefined)
})

test('parses inline scalar name and description', () => {
  const fm = parseFrontmatter('---\nname: caveman\ndescription: Brief mode\n---\n\nbody')
  expect(fm.name).toBe('caveman')
  expect(fm.description).toBe('Brief mode')
})

test('strips single and double quotes from scalars', () => {
  const fm = parseFrontmatter(`---\nname: "quoted"\ndescription: 'brief'\n---\n`)
  expect(fm.name).toBe('quoted')
  expect(fm.description).toBe('brief')
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
    'body'
  ].join('\n')
  const fm = parseFrontmatter(src)
  expect(fm.name).toBe('caveman')
  expect(fm.description).toBe('Ultra-compressed communication mode.\nCuts token usage ~75%.')
})

test('parses `>` folded block scalar', () => {
  const src = '---\ndescription: >\n  line one\n  line two\n---\n'
  const fm = parseFrontmatter(src)
  expect(fm.description).toBe('line one\nline two')
})

test('ignores unknown keys', () => {
  const fm = parseFrontmatter('---\nname: x\nallowed-tools: [Read]\nmodel: sonnet\n---\n')
  expect(fm.name).toBe('x')
  expect(fm.description).toBe(undefined)
})

test('CRLF line endings', () => {
  const fm = parseFrontmatter('---\r\nname: win\r\ndescription: crlf\r\n---\r\n')
  expect(fm.name).toBe('win')
  expect(fm.description).toBe('crlf')
})

test('block scalar terminates at `---`', () => {
  const src = '---\ndescription: |\n  one\n  two\n---\nbody\n'
  const fm = parseFrontmatter(src)
  expect(fm.description).toBe('one\ntwo')
})

test('exposes markdown body after closing ---', () => {
  const src = '---\nname: x\n---\n\nHello **world**.\n'
  const fm = parseFrontmatter(src)
  expect(fm.body.trim()).toBe('Hello **world**.')
})

test('body is whole text when no frontmatter', () => {
  const fm = parseFrontmatter('no fm here')
  expect(fm.body).toBe('no fm here')
})

test('parses argument-hint (custom slash commands)', () => {
  const fm = parseFrontmatter('---\ndescription: d\nargument-hint: <fruit> [count]\n---\nbody')
  expect(fm.argumentHint).toBe('<fruit> [count]')
})
