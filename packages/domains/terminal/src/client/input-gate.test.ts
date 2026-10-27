/**
 * Input typed into a terminal before its PTY exists (input-gate.ts).
 */
import { expect, test } from 'vitest'
import { createInputGate } from './input-gate'

test('holds input until open, then delivers it in order, then passes through', () => {
  const out: string[] = []
  const gate = createInputGate((d) => out.push(d))
  gate.input('a')
  gate.input('b')
  expect(out.length, 'nothing written while closed').toBe(0)
  gate.open()
  expect(out.join('|'), `held input flushed as one write in order: ${out.join('|')}`).toBe('ab')
  gate.input('c')
  expect(out.join('|'), `passes through once open: ${out.join('|')}`).toBe('ab|c')
})

test('open with nothing held writes nothing', () => {
  const out: string[] = []
  const gate = createInputGate((d) => out.push(d))
  gate.open()
  expect(out.length, 'no empty write').toBe(0)
})

test('drop discards held input and everything after (the PTY never came up)', () => {
  const out: string[] = []
  const gate = createInputGate((d) => out.push(d))
  gate.input('a')
  gate.drop()
  gate.input('b')
  gate.open()
  expect(out.length, `nothing written after drop: ${out.join('|')}`).toBe(0)
})

test('open is idempotent', () => {
  const out: string[] = []
  const gate = createInputGate((d) => out.push(d))
  gate.input('a')
  gate.open()
  gate.open()
  expect(out.join('|'), 'flushed once').toBe('a')
})
