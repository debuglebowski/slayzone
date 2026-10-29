import { expect, test } from 'vitest'
import { isCliVersionBelow } from './cli-version'

test('numeric per part, not lexical', () => {
  expect(isCliVersionBelow('2.1.99', '2.1.312')).toBe(true)
  expect(isCliVersionBelow('2.1.312', '2.1.312')).toBe(false)
  expect(isCliVersionBelow('2.1.400', '2.1.312')).toBe(false)
  expect(isCliVersionBelow('2.2.0', '2.1.312')).toBe(false)
  expect(isCliVersionBelow('1.9.999', '2.1.312')).toBe(true)
})

test('tolerates the CLI’s own suffixes; a pre-release is below its release', () => {
  expect(isCliVersionBelow('2.1.312 (Claude Code)', '2.1.312')).toBe(false)
  expect(isCliVersionBelow('2.1.312-beta.1', '2.1.312')).toBe(true)
})

test('unparseable never counts as old', () => {
  expect(isCliVersionBelow('unknown', '2.1.312')).toBe(false)
})
