// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ArtifactPicker, type ArtifactPickerItem } from './ArtifactPicker'

const items: ArtifactPickerItem[] = [
  { id: '1', title: 'alpha notes', type: 'md' },
  { id: '2', title: 'alpha plan', type: 'md' },
  { id: '3', title: 'beta', type: 'md' },
  { id: '4', title: 'alpha report', type: 'html' }
]
const coords = { top: 0, left: 0, bottom: 0 }

afterEach(() => {
  cleanup()
})

function highlighted(): string | undefined {
  return (
    screen
      .getAllByRole('button')
      .find((b) => b.className.includes('bg-muted text-foreground'))
      ?.querySelector('span')?.textContent ?? undefined
  )
}

function key(k: string): void {
  act(() => {
    fireEvent.keyDown(document, { key: k })
  })
}

describe('ArtifactPicker', () => {
  it('moves the highlight with arrows and resets it when the query changes', () => {
    const onSelect = vi.fn()
    const { rerender } = render(
      <ArtifactPicker
        items={items}
        query=""
        coords={coords}
        onSelect={onSelect}
        onClose={vi.fn()}
      />
    )
    expect(highlighted()).toBe('alpha notes')
    key('ArrowDown')
    key('ArrowDown')
    expect(highlighted()).toBe('beta')

    rerender(
      <ArtifactPicker
        items={items}
        query="alpha"
        coords={coords}
        onSelect={onSelect}
        onClose={vi.fn()}
      />
    )
    expect(highlighted()).toBe('alpha notes')
    key('Enter')
    expect(onSelect).toHaveBeenCalledWith(items[0])
  })

  it('keeps the highlight when re-rendered with the same query', () => {
    const { rerender } = render(
      <ArtifactPicker
        items={items}
        query="a"
        coords={coords}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    )
    key('ArrowDown')
    expect(highlighted()).toBe('alpha plan')
    rerender(
      <ArtifactPicker
        items={[...items]}
        query="a"
        coords={coords}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(highlighted()).toBe('alpha plan')
  })

  it('hover sets the highlight; Escape closes', () => {
    const onClose = vi.fn()
    render(
      <ArtifactPicker items={items} query="" coords={coords} onSelect={vi.fn()} onClose={onClose} />
    )
    act(() => {
      fireEvent.mouseEnter(screen.getByText('alpha report').closest('button') as HTMLElement)
    })
    expect(highlighted()).toBe('alpha report')
    key('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
