/**
 * chat-effort unit tests
 * Run with: pnpm tsx packages/domains/terminal/src/shared/chat-effort.test.ts
 */
import {
  chatEffortToFlags,
  isChatEffort,
  CHAT_EFFORTS,
  modelSupportsEffort
} from './chat-effort.js'

let passed = 0
let failed = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e}`)
    failed++
  }
}
function expect<T>(v: T) {
  return {
    toBe(e: T) {
      if (v !== e) throw new Error(`expected ${JSON.stringify(e)}, got ${JSON.stringify(v)}`)
    },
    toEqual(e: unknown) {
      if (JSON.stringify(v) !== JSON.stringify(e))
        throw new Error(`expected ${JSON.stringify(e)}, got ${JSON.stringify(v)}`)
    }
  }
}

console.log('\nchat-effort\n')

test('null emits no flags (CLI/account default)', () => {
  expect(chatEffortToFlags(null)).toEqual([])
})

test('undefined emits no flags', () => {
  expect(chatEffortToFlags(undefined)).toEqual([])
})

test('low emits --effort low', () => {
  expect(chatEffortToFlags('low')).toEqual(['--effort', 'low'])
})

test('medium emits --effort medium', () => {
  expect(chatEffortToFlags('medium')).toEqual(['--effort', 'medium'])
})

test('high emits --effort high', () => {
  expect(chatEffortToFlags('high')).toEqual(['--effort', 'high'])
})

test('xhigh emits --effort xhigh', () => {
  expect(chatEffortToFlags('xhigh')).toEqual(['--effort', 'xhigh'])
})

test('max emits --effort max', () => {
  expect(chatEffortToFlags('max')).toEqual(['--effort', 'max'])
})

test('isChatEffort accepts all known levels', () => {
  for (const e of CHAT_EFFORTS) expect(isChatEffort(e)).toBe(true)
})

test('isChatEffort rejects unknown strings', () => {
  expect(isChatEffort('extreme')).toBe(false)
  expect(isChatEffort('')).toBe(false)
  expect(isChatEffort('LOW')).toBe(false)
})

test('isChatEffort rejects non-strings', () => {
  expect(isChatEffort(null)).toBe(false)
  expect(isChatEffort(undefined)).toBe(false)
  expect(isChatEffort(42)).toBe(false)
  expect(isChatEffort({})).toBe(false)
})

test('modelSupportsEffort hides for haiku', () => {
  expect(modelSupportsEffort('haiku')).toBe(false)
})

test('modelSupportsEffort shows for sonnet/opus', () => {
  expect(modelSupportsEffort('sonnet')).toBe(true)
  expect(modelSupportsEffort('opus')).toBe(true)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
