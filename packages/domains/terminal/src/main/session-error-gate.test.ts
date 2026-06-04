import { shouldHonorDetectedError } from './session-error-gate'

let passed = 0
let failed = 0
function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.log(`  ✗ ${name}\n    ${(err as Error).message}`)
  }
}
function expect(actual: unknown): { toBe: (e: unknown) => void } {
  return {
    toBe: (e: unknown) => {
      if (actual !== e) throw new Error(`expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`)
    }
  }
}

console.log('shouldHonorDetectedError')

// SESSION_NOT_FOUND is a stale-resume signal ONLY valid during the startup window.
test('SESSION_NOT_FOUND honored while startup window open', () => {
  expect(shouldHonorDetectedError('SESSION_NOT_FOUND', true)).toBe(true)
})

// The regression: a mid-session echo of the literal "No conversation found with
// session ID:" (e.g. an agent discussing the error) must NOT be honored once the
// window has closed — this is what froze task 753.
test('SESSION_NOT_FOUND IGNORED after startup window closes (the bug)', () => {
  expect(shouldHonorDetectedError('SESSION_NOT_FOUND', false)).toBe(false)
})

// Other error codes are not string-echo-prone — always honored, any time.
test('other error code honored after window closes', () => {
  expect(shouldHonorDetectedError('SOME_OTHER_ERROR', false)).toBe(true)
})
test('other error code honored while window open', () => {
  expect(shouldHonorDetectedError('SOME_OTHER_ERROR', true)).toBe(true)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
