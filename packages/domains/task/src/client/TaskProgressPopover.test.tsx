// @vitest-environment jsdom
// Pins TaskProgressPopover's draft (`local`) sync: while closed it follows `value`;
// while open it is the user's draft and ignores `value`; closing re-syncs it.
import React, { createContext, useContext } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

type Children = { children?: React.ReactNode }
const OpenCtx = createContext<{ open: boolean; onOpenChange: (o: boolean) => void }>({
  open: false,
  onOpenChange: () => {}
})

vi.mock('@slayzone/ui', () => ({
  Popover: ({
    open,
    onOpenChange,
    children
  }: Children & { open: boolean; onOpenChange: (o: boolean) => void }) => (
    <OpenCtx.Provider value={{ open, onOpenChange }}>
      <button type="button" data-testid="toggle" onClick={() => onOpenChange(!open)} />
      {children}
    </OpenCtx.Provider>
  ),
  PopoverTrigger: ({ children }: Children) => <>{children}</>,
  PopoverContent: ({ children }: Children) => {
    const { open } = useContext(OpenCtx)
    return open ? <div data-testid="content">{children}</div> : null
  },
  ProgressRing: ({ value }: { value: number }) => <span data-testid="ring">{value}</span>,
  Slider: ({
    value,
    onValueChange,
    onValueCommit
  }: {
    value: number[]
    onValueChange: (v: number[]) => void
    onValueCommit: (v: number[]) => void
  }) => (
    <input
      data-testid="slider"
      type="range"
      value={value[0]}
      onChange={(e) => onValueChange([Number(e.target.value)])}
      onBlur={(e) => onValueCommit([Number(e.target.value)])}
    />
  ),
  Tooltip: ({ children }: Children) => <>{children}</>,
  TooltipTrigger: ({ children }: Children) => <>{children}</>,
  TooltipContent: ({ children }: Children) => <>{children}</>,
  cn: (...c: unknown[]) => c.filter(Boolean).join(' ')
}))

const { TaskProgressPopover } = await import('./TaskProgressPopover')

afterEach(cleanup)

const ring = (): string => screen.getByTestId('ring').textContent ?? ''
const slider = (): string => (screen.getByTestId('slider') as HTMLInputElement).value
const toggle = (): void => {
  fireEvent.click(screen.getByTestId('toggle'))
}

describe('TaskProgressPopover', () => {
  it('follows value while closed and opens on the latest value', () => {
    const { rerender } = render(<TaskProgressPopover value={10} onCommit={vi.fn()} />)
    expect(ring()).toBe('10')
    rerender(<TaskProgressPopover value={40} onCommit={vi.fn()} />)
    expect(ring()).toBe('40')
    toggle()
    expect(slider()).toBe('40')
  })

  it('while open, keeps the draft over incoming values; closing re-syncs to value', () => {
    const onCommit = vi.fn()
    const { rerender } = render(<TaskProgressPopover value={10} onCommit={onCommit} />)
    toggle()
    fireEvent.change(screen.getByTestId('slider'), { target: { value: '65' } })
    expect(slider()).toBe('65')
    expect(ring()).toBe('65') // display = draft while open

    rerender(<TaskProgressPopover value={20} onCommit={onCommit} />)
    expect(slider()).toBe('65')

    toggle() // close without the parent ever applying 65
    expect(ring()).toBe('20')
    toggle()
    expect(slider()).toBe('20')
  })

  it('preset click commits and becomes the draft', () => {
    const onCommit = vi.fn()
    render(<TaskProgressPopover value={10} onCommit={onCommit} />)
    toggle()
    fireEvent.click(screen.getByRole('button', { name: '75' }))
    expect(onCommit).toHaveBeenCalledWith(75)
    expect(slider()).toBe('75')
    expect(screen.getByRole('button', { name: '75' }).getAttribute('aria-pressed')).toBe('true')
  })
})
