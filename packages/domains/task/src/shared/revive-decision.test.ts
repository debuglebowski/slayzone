import { describe, expect, test } from 'vitest'
import { decideReviveMode, COLD_RESPAWN_MS } from './types'

const NOW = 1_000_000_000_000

describe('decideReviveMode', () => {
  // RC2 regression (the bug): unknown kill time must RESUME, never go fresh.
  // Defaulting null→fresh is what clobbered live conversations into phantoms.
  test('null killedAt must resume, never fresh', () => {
    expect(decideReviveMode(null, NOW)).toBe('resume')
  })

  // Hot bounce: recently killed → resume.
  test('recent kill resumes', () => {
    expect(decideReviveMode(NOW - 1000, NOW)).toBe('resume')
  })

  test('just under threshold resumes', () => {
    expect(decideReviveMode(NOW - (COLD_RESPAWN_MS - 1), NOW)).toBe('resume')
  })

  // Boundary: exactly at threshold → resume (strictly-greater goes fresh).
  test('exactly threshold resumes', () => {
    expect(decideReviveMode(NOW - COLD_RESPAWN_MS, NOW)).toBe('resume')
  })

  // Cold bounce: sat past the threshold → fresh.
  test('past threshold starts fresh', () => {
    expect(decideReviveMode(NOW - (COLD_RESPAWN_MS + 1), NOW)).toBe('fresh')
  })
})
