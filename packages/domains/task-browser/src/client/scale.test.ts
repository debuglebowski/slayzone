/**
 * Tests for scale-to-fit computation
 */
import { expect, test } from 'vitest'
import { computeScale } from './scale'

// --- No scaling needed ---

test('mobile device fits in large container → scale 1', () => {
  // 375x667 needs container > 415x707 (with 40px pad)
  expect(computeScale({ width: 900, height: 800 }, { width: 375, height: 667 })).toBe(1)
})

test('device exactly fills available space → scale 1', () => {
  // container 415x707 minus 40px pad = 375x667 available
  expect(computeScale({ width: 415, height: 707 }, { width: 375, height: 667 })).toBe(1)
})

// --- Width-constrained ---

test('desktop 1080p in 800x600 container → width-constrained', () => {
  // avail: 760x560, scale = min(1, 760/1920, 560/1080) = min(1, 0.3958, 0.5185) = 0.3958
  const s = computeScale({ width: 800, height: 600 }, { width: 1920, height: 1080 })
  expect(s).toBeCloseTo(760 / 1920, 4)
})

test('wide device in narrow container → width-constrained', () => {
  const s = computeScale({ width: 500, height: 800 }, { width: 1920, height: 1080 })
  expect(s).toBeCloseTo(460 / 1920, 4)
})

// --- Height-constrained ---

test('tall device in short container → height-constrained', () => {
  const s = computeScale({ width: 800, height: 400 }, { width: 1024, height: 1366 })
  expect(s).toBeCloseTo(360 / 1366, 4)
})

test('iPad Pro in 600x500 container → height-constrained', () => {
  const s = computeScale({ width: 600, height: 500 }, { width: 1024, height: 1366 })
  // avail: 560x460, scale = min(1, 560/1024, 460/1366) = min(1, 0.5468, 0.3367) = 0.3367
  expect(s).toBeCloseTo(460 / 1366, 4)
})

// --- Edge cases ---

test('null container → 1', () => {
  expect(computeScale(null, { width: 1920, height: 1080 })).toBe(1)
})

test('null device → 1', () => {
  expect(computeScale({ width: 800, height: 600 }, null)).toBe(1)
})

test('zero device width → 1', () => {
  expect(computeScale({ width: 800, height: 600 }, { width: 0, height: 1080 })).toBe(1)
})

test('zero device height → 1', () => {
  expect(computeScale({ width: 800, height: 600 }, { width: 1920, height: 0 })).toBe(1)
})

test('container smaller than handle pad → 1', () => {
  expect(computeScale({ width: 30, height: 30 }, { width: 375, height: 667 })).toBe(1)
})

test('custom handle padding', () => {
  // container 400x300, pad 0 → avail 400x300, device 800x600 → scale 0.5
  expect(computeScale({ width: 400, height: 300 }, { width: 800, height: 600 }, 0)).toBe(0.5)
})

test('never exceeds 1 even with tiny device', () => {
  expect(computeScale({ width: 2000, height: 2000 }, { width: 100, height: 100 })).toBe(1)
})

// --- Desktop presets (the failing case) ---

test('1920x1080 in typical 700x500 panel', () => {
  const s = computeScale({ width: 700, height: 500 }, { width: 1920, height: 1080 })
  // avail: 660x460, width-constrained: 660/1920 ≈ 0.3437
  expect(s).toBeCloseTo(660 / 1920, 4)
})

test('2560x1440 in typical 700x500 panel', () => {
  const s = computeScale({ width: 700, height: 500 }, { width: 2560, height: 1440 })
  // avail: 660x460, width-constrained: 660/2560 ≈ 0.2578
  expect(s).toBeCloseTo(660 / 2560, 4)
})
