// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { BackgroundSubAgent } from '@slayzone/terminal/client'
import { ComposerSubAgents } from './ComposerSubAgents'

const START = 1_000_000

const agent = (toolUseId: string, description?: string): BackgroundSubAgent => ({
  toolUseId,
  ...(description ? { description } : {}),
  timestamp: START - 65_000,
  row: 3
})

describe('ComposerSubAgents', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(START)
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('renders nothing without sub-agents', () => {
    const { container } = render(<ComposerSubAgents agents={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('the same pill as a turn’s Sub-agents: collapsed, says how many run', () => {
    render(<ComposerSubAgents agents={[agent('a', 'scan repo'), agent('b')]} />)
    const toggle = screen.getByTestId('composer-sub-agents-toggle')
    expect(toggle.textContent).toContain('Sub-agents')
    expect(toggle.textContent).toContain('2 running')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('scan repo')).toBeNull()
  })

  it('expanded: each runs for its age; its name opens its row', () => {
    const open = vi.fn()
    const a = agent('a', 'scan repo')
    render(<ComposerSubAgents agents={[a]} onOpen={open} />)
    fireEvent.click(screen.getByTestId('composer-sub-agents-toggle'))
    expect(screen.getByText('1m 5s')).toBeTruthy()
    act(() => vi.advanceTimersByTime(2_000))
    expect(screen.getByText('1m 7s')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show sub-agent scan repo' }))
    expect(open).toHaveBeenCalledWith(a)
  })

  it('each has its own Stop; none when the agent cannot stop one', () => {
    const stop = vi.fn()
    const a = agent('a', 'scan repo')
    const { rerender } = render(
      <ComposerSubAgents agents={[a, agent('b', 'write docs')]} onStop={stop} defaultExpanded />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Stop sub-agent scan repo' }))
    expect(stop).toHaveBeenCalledWith(a)
    expect(screen.getAllByRole('button', { name: /Stop sub-agent/ })).toHaveLength(2)
    rerender(<ComposerSubAgents agents={[a]} defaultExpanded />)
    expect(screen.queryByRole('button', { name: /Stop sub-agent/ })).toBeNull()
  })

  it('Stop once: it reads as stopping until it ends', () => {
    const stop = vi.fn()
    render(<ComposerSubAgents agents={[agent('a', 'scan repo')]} onStop={stop} defaultExpanded />)
    const button = screen.getByRole('button', { name: 'Stop sub-agent scan repo' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(button.textContent).toBe('Stopping…')
  })

  it('a Stop that failed can be pressed again', async () => {
    const stop = vi.fn(() => Promise.reject(new Error('no')))
    render(<ComposerSubAgents agents={[agent('a', 'scan repo')]} onStop={stop} defaultExpanded />)
    const button = screen.getByRole('button', { name: 'Stop sub-agent scan repo' })
    fireEvent.click(button)
    await act(async () => {})
    expect(button.hasAttribute('disabled')).toBe(false)
    expect(button.textContent).toBe('Stop')
  })

  it('no age while its row is not loaded', () => {
    render(<ComposerSubAgents agents={[{ toolUseId: 'a', row: 1 }]} defaultExpanded />)
    expect(screen.queryByText(/\d+s$|NaN/)).toBeNull()
  })

  it('an unnamed one reads as a sub-agent', () => {
    render(<ComposerSubAgents agents={[agent('a')]} onStop={() => {}} defaultExpanded />)
    expect(screen.getByRole('button', { name: 'Show sub-agent' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Stop sub-agent' })).toBeTruthy()
  })
})
