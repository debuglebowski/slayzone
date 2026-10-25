import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { TerminalProgressDot } from './terminal-progress-dot'

afterEach(cleanup)

// A starting agent (queued for a start slot, or booting) must be visibly
// different from a stopped one: both used to be the same grey dot.
describe('TerminalProgressDot — starting', () => {
  it('a starting session spins, unlike a stopped one', () => {
    const { container: starting } = render(<TerminalProgressDot state="starting" noTooltip />)
    const { container: stopped } = render(<TerminalProgressDot state="dead" noTooltip />)
    expect(starting.querySelector('[aria-label="Starting"]')?.getAttribute('class')).toContain(
      'animate-spin'
    )
    expect(stopped.querySelector('[aria-label="Stopped"]')?.getAttribute('class')).not.toContain(
      'animate-spin'
    )
  })

  it('a task with no session is a still muted dot, not "Starting"', () => {
    const { container } = render(<TerminalProgressDot state={undefined} alwaysShow noTooltip />)
    const el = container.querySelector('[aria-label="No session"]')
    expect(el).not.toBeNull()
    expect(el?.getAttribute('class')).not.toContain('animate-spin')
  })
})
