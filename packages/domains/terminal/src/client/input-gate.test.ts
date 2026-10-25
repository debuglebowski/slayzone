/**
 * Input typed into a terminal before its PTY exists (input-gate.ts).
 * Run with: pnpm exec tsx packages/domains/terminal/src/client/input-gate.test.ts
 */
import { createInputGate } from './input-gate'

let passed = 0
let failed = 0
function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? e.message : e}`)
    failed++
  }
}
function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}

test('holds input until open, then delivers it in order, then passes through', () => {
  const out: string[] = []
  const gate = createInputGate((d) => out.push(d))
  gate.input('a')
  gate.input('b')
  ok(out.length === 0, 'nothing written while closed')
  gate.open()
  ok(out.join('|') === 'ab', `held input flushed as one write in order: ${out.join('|')}`)
  gate.input('c')
  ok(out.join('|') === 'ab|c', `passes through once open: ${out.join('|')}`)
})

test('open with nothing held writes nothing', () => {
  const out: string[] = []
  const gate = createInputGate((d) => out.push(d))
  gate.open()
  ok(out.length === 0, 'no empty write')
})

test('drop discards held input and everything after (the PTY never came up)', () => {
  const out: string[] = []
  const gate = createInputGate((d) => out.push(d))
  gate.input('a')
  gate.drop()
  gate.input('b')
  gate.open()
  ok(out.length === 0, `nothing written after drop: ${out.join('|')}`)
})

test('open is idempotent', () => {
  const out: string[] = []
  const gate = createInputGate((d) => out.push(d))
  gate.input('a')
  gate.open()
  gate.open()
  ok(out.join('|') === 'a', 'flushed once')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)
