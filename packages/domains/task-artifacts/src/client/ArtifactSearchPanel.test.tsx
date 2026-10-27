// @vitest-environment jsdom
// Debounced artifact search. Task tabs live in <Activity>: re-showing the tab
// re-runs the search (as before), but the results on screen are not flagged
// "Searching..." again — nothing about the query changed.
import { Activity } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TaskArtifact } from '@slayzone/task/shared'
import { ArtifactSearchPanel } from './ArtifactSearchPanel'

const artifact = (id: string, title: string): TaskArtifact =>
  ({ id, task_id: 't1', title, folder_id: null, render_mode: null }) as unknown as TaskArtifact
const ARTIFACTS = [artifact('a1', 'a.md'), artifact('a2', 'b.md')]
const getArtifactPath = (a: TaskArtifact): string => a.title
const onSelectResult = vi.fn()

let contents: Record<string, string | null>
const readContent = vi.fn(async (id: string) => contents[id] ?? null)

function Tab({ mode }: { mode: 'visible' | 'hidden' }) {
  return (
    <Activity mode={mode}>
      <ArtifactSearchPanel
        artifacts={ARTIFACTS}
        readContent={readContent}
        getArtifactPath={getArtifactPath}
        onSelectResult={onSelectResult}
      />
    </Activity>
  )
}

const searching = () => screen.queryByText('Searching...') !== null
const summary = () => screen.queryByText(/ results? in \d+ files?$/)?.textContent ?? null
const files = () => screen.queryAllByText(/^[ab]\.md$/).map((el) => el.textContent)
const type = (value: string) =>
  fireEvent.change(screen.getByPlaceholderText('Search artifacts...'), { target: { value } })
/** Past the 300 ms debounce, then let the reads and the search settle. */
const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(300)
  })

beforeEach(() => {
  vi.useFakeTimers()
  contents = { a1: 'hello world', a2: 'nothing here' }
  readContent.mockClear()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('ArtifactSearchPanel', () => {
  it('searches after the debounce: "Searching..." until the results land', async () => {
    render(<Tab mode="visible" />)
    type('hello')
    expect(searching()).toBe(true)
    expect(summary()).toBeNull()
    await settle()
    expect(searching()).toBe(false)
    expect(summary()).toBe('1 result in 1 file')
    expect(files()).toEqual(['a.md'])
  })

  it('a changed option re-searches, flagged "Searching..." until it lands', async () => {
    render(<Tab mode="visible" />)
    type('Hello')
    await settle()
    expect(summary()).toBe('1 result in 1 file')

    fireEvent.click(screen.getByTitle('Match Case'))
    expect(searching()).toBe(true)
    await settle()
    expect(searching()).toBe(false)
    expect(summary()).toBe('0 results in 0 files')
    expect(files()).toEqual([])
  })

  it('clearing the query clears the results and the status line', async () => {
    render(<Tab mode="visible" />)
    type('hello')
    await settle()
    expect(files()).toEqual(['a.md'])

    type('')
    expect(files()).toEqual([])
    expect(summary()).toBeNull()
    expect(searching()).toBe(false)

    // The next query starts from no results, not the previous query's.
    type('nothing')
    expect(searching()).toBe(true)
    expect(files()).toEqual([])
    await settle()
    expect(files()).toEqual(['b.md'])
  })

  it('re-runs the search when the tab is shown again', async () => {
    contents.a2 = null // not readable yet: not cached, so re-read on the next run
    const view = render(<Tab mode="visible" />)
    type('hello')
    await settle()
    expect(files()).toEqual(['a.md'])
    const reads = readContent.mock.calls.length

    view.rerender(<Tab mode="hidden" />)
    contents.a2 = 'hello there'
    view.rerender(<Tab mode="visible" />)
    await settle()
    expect(readContent.mock.calls.length).toBe(reads + 1)
    expect(files()).toEqual(['a.md', 'b.md'])
    expect(summary()).toBe('2 results in 2 files')
  })

  it('keeps the results (not "Searching...") while the search re-runs on show', async () => {
    const view = render(<Tab mode="visible" />)
    type('hello')
    await settle()

    view.rerender(<Tab mode="hidden" />)
    view.rerender(<Tab mode="visible" />)
    expect(searching()).toBe(false)
    expect(summary()).toBe('1 result in 1 file')
    expect(files()).toEqual(['a.md'])
    await settle()
    expect(searching()).toBe(false)
    expect(summary()).toBe('1 result in 1 file')
  })
})
