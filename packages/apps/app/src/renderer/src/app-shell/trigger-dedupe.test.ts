import { describe, expect, it } from 'vitest'
import { createTriggerDedupe } from './trigger-dedupe'

describe('createTriggerDedupe (one press, two delivery paths)', () => {
  it('runs the first delivery of a press and drops the other path within the window', () => {
    const gate = createTriggerDedupe(300)
    expect(gate.accept('keydown', 1000)).toBe(true)
    expect(gate.accept('menu', 1040)).toBe(false)
  })

  it('either path may arrive first', () => {
    const gate = createTriggerDedupe(300)
    expect(gate.accept('menu', 1000)).toBe(true)
    expect(gate.accept('keydown', 1010)).toBe(false)
  })

  it('a second press on the SAME path is a new press, never dropped', () => {
    const gate = createTriggerDedupe(300)
    expect(gate.accept('keydown', 1000)).toBe(true)
    expect(gate.accept('keydown', 1050)).toBe(true)
  })

  it('the other path outside the window is a new press', () => {
    const gate = createTriggerDedupe(300)
    expect(gate.accept('keydown', 1000)).toBe(true)
    expect(gate.accept('menu', 1301)).toBe(true)
  })

  it('a dropped delivery is consumed: it pairs with exactly one press', () => {
    const gate = createTriggerDedupe(300)
    expect(gate.accept('keydown', 1000)).toBe(true)
    expect(gate.accept('menu', 1020)).toBe(false)
    expect(gate.accept('menu', 1040)).toBe(true)
  })
})
