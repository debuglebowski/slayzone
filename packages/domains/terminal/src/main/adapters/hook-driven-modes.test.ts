/**
 * Parity guard for HOOK_DRIVEN_MODES — derived ONCE from each adapter's
 * `hookDriven` flag (single source of truth). Both `shouldFlipToRunningOnInput`
 * (skips the optimistic Enter→running flip) and the agent-hook route (drives
 * state from lifecycle hooks) read this set, so it must stay exactly the set of
 * providers flagged hook-driven. A new adapter silently gaining/losing the flag
 * trips this test.
 * Run with: npx tsx packages/domains/terminal/src/main/adapters/hook-driven-modes.test.ts
 */
import { HOOK_DRIVEN_MODES, isHookDrivenMode, getAdapter } from './index'

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`✓ ${name}`)
  } catch (e) {
    console.log(`✗ ${name}`)
    console.error(`  ${e}`)
    process.exitCode = 1
  }
}

function expect(actual: unknown) {
  return {
    toBe(expected: unknown) {
      if (actual !== expected)
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    }
  }
}

console.log('\nHOOK_DRIVEN_MODES (registry-derived single source of truth)\n')

test('derived set is exactly the three hook-driven providers', () => {
  expect([...HOOK_DRIVEN_MODES].sort().join(',')).toBe('antigravity,claude-code,codex')
})

test('isHookDrivenMode → true for hook-driven providers', () => {
  expect(isHookDrivenMode('claude-code')).toBe(true)
  expect(isHookDrivenMode('codex')).toBe(true)
  expect(isHookDrivenMode('antigravity')).toBe(true)
})

test('isHookDrivenMode → false for detection/timeout providers', () => {
  expect(isHookDrivenMode('gemini')).toBe(false)
  expect(isHookDrivenMode('opencode')).toBe(false)
  expect(isHookDrivenMode('cursor-agent')).toBe(false)
  expect(isHookDrivenMode('copilot')).toBe(false)
  expect(isHookDrivenMode('qwen-code')).toBe(false)
  expect(isHookDrivenMode('terminal')).toBe(false)
})

test('isHookDrivenMode → false for unknown mode', () => {
  expect(isHookDrivenMode('nonexistent')).toBe(false)
})

test('every hook-driven adapter disables the silence timer (hookDriven ⟹ idleTimeoutMs=Infinity)', () => {
  // Invariant: a hook-driven adapter must have NO silence-timer fallback. A
  // finite timeout would flip running→idle mid-turn when a long tool run emits
  // no hook — the exact misfire Infinity exists to prevent. Catches a future
  // adapter that sets hookDriven=true but forgets idleTimeoutMs=Infinity.
  for (const mode of HOOK_DRIVEN_MODES) {
    expect(getAdapter({ mode }).idleTimeoutMs).toBe(Infinity)
  }
})

console.log('\nDone\n')
