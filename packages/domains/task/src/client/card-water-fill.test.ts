import { waterLevel } from './card-water-fill'

let failures = 0
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log('  ok:', msg)
  } else {
    console.error('  FAIL:', msg)
    failures += 1
  }
}
const approx = (a: number, b: number): boolean => Math.abs(a - b) < 0.001

// --- no cap needed (everything hugs) ---
assert(waterLevel([], 600, 144) === Infinity, 'empty → Infinity')
assert(waterLevel([100, 100], 600, 144) === Infinity, 'sum < available → Infinity (all hug)')
assert(waterLevel([100, 100], 200, 144) === Infinity, 'sum == available → Infinity (exact fit, no cap)')

// --- single tall card ---
assert(waterLevel([1000], 600, 144) === 600, 'one tall card → capped at all available')
assert(waterLevel([1000], 600, 144) >= 144, 'single-card cap respects floor')

// --- redistribution: short cards keep content, tall card takes the rest ---
assert(
  approx(waterLevel([50, 50, 1000], 600, 144), 500),
  'two short (50,50) + one tall → tall capped at leftover 500, not 1/3'
)

// --- two equally-tall cards split evenly ---
assert(approx(waterLevel([1000, 1000], 600, 144), 300), 'two tall, avail 600 → each 300')

// --- floor clamp under heavy pressure (grid will scroll) ---
assert(
  waterLevel([1000, 1000, 1000], 200, 144) === 144,
  'fair share (66) below floor → clamped to 144 (panel scrolls)'
)
assert(
  waterLevel([30, 1000], 150, 144) === 144,
  'mixed: short below floor stays, tall clamped to floor 144'
)

// --- ordering does not matter ---
assert(
  approx(waterLevel([1000, 50, 50], 600, 144), waterLevel([50, 1000, 50], 600, 144)),
  'result independent of input order'
)

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\ncard-water-fill: all assertions passed')
