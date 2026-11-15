// @vitest-environment jsdom
// The control under a diff that was read by its first page only (a file whose
// patch is over the page budget): it says how much is left and loads all of it on
// request — every byte stays reachable, none is fetched unasked.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DiffRestButton } from './DiffRestButton'

afterEach(cleanup)

describe('DiffRestButton', () => {
  it('names the remaining size and loads on click', () => {
    const onLoad = vi.fn()
    render(
      <DiffRestButton
        rest={{ remainingBytes: 12.5 * 1024 * 1024, loading: false, failed: false }}
        onLoad={onLoad}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Load rest of diff (12.5 MB)' }))
    expect(onLoad).toHaveBeenCalledTimes(1)
  })

  it('is disabled while loading, and offers a retry after a failure', () => {
    const { rerender } = render(
      <DiffRestButton
        rest={{ remainingBytes: 2048, loading: true, failed: false }}
        onLoad={() => {}}
      />
    )
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('button').textContent).toBe('Loading rest of diff (2.0 KB)…')
    rerender(
      <DiffRestButton
        rest={{ remainingBytes: 2048, loading: false, failed: true }}
        onLoad={() => {}}
      />
    )
    expect(screen.getByRole('button').textContent).toBe(
      'Could not load the rest of the diff. Retry'
    )
  })

  it('renders nothing without a rest', () => {
    const { container } = render(<DiffRestButton rest={null} onLoad={() => {}} />)
    expect(container.innerHTML).toBe('')
  })
})
