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

// Agent idle, but it left background jobs running (dev server, watcher): the dot
// keeps its idle look and gains a spinning ring — work in flight, nothing needs you.
describe('TerminalProgressDot — background jobs', () => {
  const orbit = (c: HTMLElement): Element | null =>
    c.querySelector('[data-testid="background-jobs-orbit"]')

  it('an idle session with background jobs gets a spinning ring around the dot', () => {
    const { container } = render(<TerminalProgressDot state="idle" backgroundJobs={2} noTooltip />)
    expect(orbit(container)?.getAttribute('class')).toContain('animate-spin')
    expect(container.querySelector('[aria-label="Idle"]')).not.toBeNull()
  })

  it('no jobs → no ring', () => {
    const { container } = render(<TerminalProgressDot state="idle" noTooltip />)
    expect(orbit(container)).toBeNull()
  })

  it('a needs-attention dot still shows the ring (jobs keep running while it waits)', () => {
    const { container } = render(
      <TerminalProgressDot state="idle" needsAttention backgroundJobs={1} noTooltip />
    )
    expect(orbit(container)).not.toBeNull()
  })

  it('a spinner state already shows work in flight → no second ring', () => {
    for (const state of ['running', 'background', 'starting'] as const) {
      const { container } = render(
        <TerminalProgressDot state={state} backgroundJobs={1} noTooltip />
      )
      expect(orbit(container)).toBeNull()
      cleanup()
    }
  })
})
