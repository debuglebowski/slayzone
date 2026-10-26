// @vitest-environment jsdom
// Pins TerminalSearchBar's result counter: live counts from the addon, reset to
// nothing when the query is cleared, so retyping never shows the old counts.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SearchAddon } from '@xterm/addon-search'
import { TerminalSearchBar } from './TerminalSearchBar'

type Results = { resultIndex: number; resultCount: number } | undefined

function fakeAddon() {
  const listeners = new Set<(r: Results) => void>()
  const addon = {
    findNext: vi.fn(),
    findPrevious: vi.fn(),
    clearDecorations: vi.fn(),
    onDidChangeResults: (cb: (r: Results) => void) => {
      listeners.add(cb)
      return { dispose: () => listeners.delete(cb) }
    }
  }
  const emit = (r: Results): void => act(() => listeners.forEach((cb) => cb(r)))
  return { addon: addon as unknown as SearchAddon, raw: addon, emit }
}

const counter = (): string => {
  const input = screen.getByPlaceholderText('Find...')
  return input.nextElementSibling?.textContent ?? ''
}

afterEach(cleanup)

describe('TerminalSearchBar', () => {
  it('shows live counts and resets them when the query is cleared', () => {
    const { addon, raw, emit } = fakeAddon()
    render(<TerminalSearchBar searchAddon={addon} onClose={vi.fn()} />)
    const input = screen.getByPlaceholderText('Find...')
    expect(counter()).toBe('')

    fireEvent.change(input, { target: { value: 'foo' } })
    expect(raw.findNext).toHaveBeenLastCalledWith(
      'foo',
      expect.objectContaining({ incremental: true })
    )
    expect(counter()).toBe('0/0')
    emit({ resultIndex: 1, resultCount: 5 })
    expect(counter()).toBe('2/5')

    fireEvent.change(input, { target: { value: '' } })
    expect(raw.clearDecorations).toHaveBeenCalledTimes(2) // mount (empty query) + clear
    expect(counter()).toBe('')

    // Retyping before the addon reports must not resurrect the old 2/5.
    fireEvent.change(input, { target: { value: 'b' } })
    expect(counter()).toBe('0/0')
  })

  it('keeps counts when only case-sensitivity flips with a non-empty query', () => {
    const { addon, raw, emit } = fakeAddon()
    render(<TerminalSearchBar searchAddon={addon} onClose={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('Find...'), { target: { value: 'foo' } })
    emit({ resultIndex: 0, resultCount: 3 })
    fireEvent.click(screen.getByTitle('Case Sensitive'))
    expect(raw.findNext).toHaveBeenLastCalledWith(
      'foo',
      expect.objectContaining({ caseSensitive: true, incremental: true })
    )
    expect(counter()).toBe('1/3')
  })

  it('resets counts reported while the query is empty when a new addon arrives', () => {
    const first = fakeAddon()
    const { rerender } = render(<TerminalSearchBar searchAddon={first.addon} onClose={vi.fn()} />)
    // A stray report while the query is empty is kept in state, not shown.
    first.emit({ resultIndex: 2, resultCount: 4 })
    expect(counter()).toBe('')

    const second = fakeAddon()
    rerender(<TerminalSearchBar searchAddon={second.addon} onClose={vi.fn()} />)
    expect(second.raw.clearDecorations).toHaveBeenCalledTimes(1)
    fireEvent.change(screen.getByPlaceholderText('Find...'), { target: { value: 'x' } })
    expect(counter()).toBe('0/0')
  })
})
