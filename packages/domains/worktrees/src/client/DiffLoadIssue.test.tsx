// @vitest-environment jsdom
// The panel's signs that a deferred diff could not be read: an outdated diff (its
// last good text, kept while the new one failed) and the files the continuous flow
// cannot show. Each offers a retry.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DiffFailedFiles, DiffNoChanges, DiffOutdatedBar } from './DiffLoadIssue'

afterEach(cleanup)

describe('DiffOutdatedBar', () => {
  it('says the diff is outdated and retries on click', () => {
    const onRetry = vi.fn()
    render(<DiffOutdatedBar onRetry={onRetry} />)
    fireEvent.click(screen.getByRole('button', { name: /outdated.*retry/i }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})

describe('DiffFailedFiles', () => {
  it('names how many files could not load and retries them; nothing when none', () => {
    const onRetry = vi.fn()
    const { rerender, container } = render(<DiffFailedFiles count={2} onRetry={onRetry} />)
    fireEvent.click(screen.getByRole('button', { name: 'Could not load 2 files. Retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    rerender(<DiffFailedFiles count={1} onRetry={onRetry} />)
    expect(screen.getByRole('button').textContent).toBe('Could not load 1 file. Retry')
    rerender(<DiffFailedFiles count={0} onRetry={onRetry} />)
    expect(container.textContent).toBe('')
  })
})

describe('DiffNoChanges', () => {
  it('says "No changes" only when no file failed to load', () => {
    const { rerender, container } = render(<DiffNoChanges failedCount={0} />)
    expect(screen.getByText('No changes')).toBeDefined()
    rerender(<DiffNoChanges failedCount={3} />)
    expect(container.textContent).toBe('')
  })
})
