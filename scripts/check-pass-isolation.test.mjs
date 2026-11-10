import { expect, test } from 'vitest'
import { strictStartupReads, violationsInSource } from './check-pass-isolation.mjs'

const v = (src) => violationsInSource('x.ts', src).map((x) => `${x.fn}#${x.ordinal}`)

test('a pass loop that awaits, touches files or parses JSON is flagged', () => {
  expect(v('async function recoverAll(xs) { for (const x of xs) await x.run() }')).toEqual([
    'recoverAll#1'
  ])
  expect(v('function cleanupAll(ps) { for (const p of ps) rmSync(p) }')).toEqual(['cleanupAll#1'])
  expect(v('const syncThings = (rows) => rows.forEach((r) => JSON.parse(r))')).toEqual([
    'syncThings#1'
  ])
  expect(v('/** @pass */ function deliver(xs) { for (const x of xs) readFileSync(x) }')).toEqual([
    'deliver#1'
  ])
})

test('isolated, wrapped or explicitly fatal loops pass; non-pass functions are ignored', () => {
  expect(
    v('async function recoverAll(xs) { await forEachIsolated(xs, o, (x) => x.run()) }')
  ).toEqual([])
  expect(
    v('async function recoverAll(xs) { for (const x of xs) { try { await x() } catch {} } }')
  ).toEqual([])
  expect(
    v(`async function eraseAll(xs) {
      // isolation: fatal — all-or-nothing erasure receipt
      for (const x of xs) await x()
    }`)
  ).toEqual([])
  expect(v('async function render(xs) { for (const x of xs) await x() }')).toEqual([])
  expect(v('function cleanupAll(xs) { for (const x of xs) total += x }')).toEqual([])
})

test('startup files: a bare JSON read is flagged unless marked strict', () => {
  expect(strictStartupReads("const x = JSON.parse(readFileSync(p, 'utf8'))")).toEqual([1])
  expect(
    strictStartupReads(
      '// startup-json: strict — admin input\nconst x = JSON.parse(readFileSync(p))'
    )
  ).toEqual([])
})
