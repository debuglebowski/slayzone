import { expect, test } from 'vitest'
import { PINNED_MESSAGE_EXCERPT_MAX, pinnedMessageExcerpt } from './chat-pinned-message.js'

test('excerpt is the first non-blank line', () => {
  expect(pinnedMessageExcerpt('\n\n  first line  \nsecond')).toBe('first line')
})

test('markdown markers and fences are dropped', () => {
  expect(pinnedMessageExcerpt('## Heading\nbody')).toBe('Heading')
  expect(pinnedMessageExcerpt('> quoted')).toBe('quoted')
  expect(pinnedMessageExcerpt('- item')).toBe('item')
  expect(pinnedMessageExcerpt('1. step')).toBe('step')
  expect(pinnedMessageExcerpt('```ts\nconst a = 1')).toBe('const a = 1')
})

test('a long line is capped with an ellipsis', () => {
  const out = pinnedMessageExcerpt('x'.repeat(500))
  expect(out).toHaveLength(PINNED_MESSAGE_EXCERPT_MAX)
  expect(out.endsWith('…')).toBe(true)
})

test('blank text gives an empty excerpt', () => {
  expect(pinnedMessageExcerpt('  \n ')).toBe('')
})
