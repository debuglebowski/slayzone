import { describe, expect, it } from 'vitest'
import { createBootStepRecorder } from './boot-steps'

describe('createBootStepRecorder', () => {
  it('records t/delta per step and summarizes the largest gaps', () => {
    let clock = 100
    const rec = createBootStepRecorder(() => clock)
    clock = 110
    rec.step('db opened')
    clock = 410
    rec.step('migrations applied')
    clock = 420
    rec.step('window shown')
    expect(rec.all()).toEqual([
      { step: 'db opened', t: 10, delta: 10 },
      { step: 'migrations applied', t: 310, delta: 300 },
      { step: 'window shown', t: 320, delta: 10 }
    ])
    const s = rec.summary(2)
    expect(s.totalMs).toBe(320)
    expect(s.steps).toBe(3)
    expect(s.top).toEqual([
      ['migrations applied', 300, 310],
      ['db opened', 10, 10]
    ])
  })

  it('caps label length so the payload stays small', () => {
    let clock = 0
    const rec = createBootStepRecorder(() => clock)
    clock = 5
    rec.step('x'.repeat(500))
    expect(rec.summary().top[0][0]).toHaveLength(80)
  })

  it('stops storing past the cap but still returns timings', () => {
    let clock = 0
    const rec = createBootStepRecorder(() => clock)
    for (let i = 0; i < 600; i++) {
      clock++
      rec.step(`s${i}`)
    }
    expect(rec.all()).toHaveLength(500)
    clock = 1000
    expect(rec.step('late')).toEqual({ step: 'late', t: 1000, delta: 400 })
  })

  it('empty recorder summarizes to zeros', () => {
    expect(createBootStepRecorder(() => 0).summary()).toEqual({ totalMs: 0, steps: 0, top: [] })
  })
})
