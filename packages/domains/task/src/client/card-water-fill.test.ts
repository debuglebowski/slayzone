import { describe, expect, test } from 'vitest'
import { waterLevel } from './card-water-fill'

/** Numeric equality within the old `approx` helper's 0.001 tolerance. */
const approx = (a: number, b: number): void => {
  expect(a).toBeCloseTo(b, 3)
}

describe('waterLevel', () => {
  // --- no cap needed (everything hugs) ---
  test('empty → Infinity', () => {
    expect(waterLevel([], 600, 144)).toBe(Infinity)
  })
  test('sum < available → Infinity (all hug)', () => {
    expect(waterLevel([100, 100], 600, 144)).toBe(Infinity)
  })
  test('sum == available → Infinity (exact fit, no cap)', () => {
    expect(waterLevel([100, 100], 200, 144)).toBe(Infinity)
  })

  // --- single tall card ---
  test('one tall card → capped at all available', () => {
    expect(waterLevel([1000], 600, 144)).toBe(600)
  })
  test('single-card cap respects floor', () => {
    expect(waterLevel([1000], 600, 144)).toBeGreaterThanOrEqual(144)
  })

  // --- redistribution: short cards keep content, tall card takes the rest ---
  test('two short (50,50) + one tall → tall capped at leftover 500, not 1/3', () => {
    approx(waterLevel([50, 50, 1000], 600, 144), 500)
  })

  // --- two equally-tall cards split evenly ---
  test('two tall, avail 600 → each 300', () => {
    approx(waterLevel([1000, 1000], 600, 144), 300)
  })

  // --- floor clamp under heavy pressure (grid will scroll) ---
  test('fair share (66) below floor → clamped to 144 (panel scrolls)', () => {
    expect(waterLevel([1000, 1000, 1000], 200, 144)).toBe(144)
  })
  test('mixed: short below floor stays, tall clamped to floor 144', () => {
    expect(waterLevel([30, 1000], 150, 144)).toBe(144)
  })

  // --- ordering does not matter ---
  test('result independent of input order', () => {
    approx(waterLevel([1000, 50, 50], 600, 144), waterLevel([50, 1000, 50], 600, 144))
  })
})
