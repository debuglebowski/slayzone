// @vitest-environment jsdom
// Debounced artifact search. Task tabs live in <Activity>: re-showing the tab
// re-runs the search (as before), but the results on screen are not flagged
// "Searching..." again — nothing about the query changed — and the result groups
// collapsed by hand stay collapsed (so do they when a refreshed artifact list re-runs
// it). Results for a new query or changed options still land with every group open.
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
const readFromContents = async (id: string) => contents[id] ?? null
const readContent = vi.fn(readFromContents)

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
/** A file's result group: its header button, then one button per match line. */
const groupHeader = (path: string) => screen.getByText(path).closest('button') as HTMLElement
const toggle = (path: string) => fireEvent.click(groupHeader(path))
const expanded = (path: string) =>
  (groupHeader(path).parentElement as HTMLElement).querySelectorAll('button').length > 1
/** Past the 300 ms debounce, then let the reads and the search settle. */
const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(300)
  })

beforeEach(() => {
  vi.useFakeTimers()
  contents = { a1: 'hello world', a2: 'nothing here' }
  readContent.mockClear()
  readContent.mockImplementation(readFromContents)
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

  it('a run overtaken by a newer one never replaces its results (nor sticks "Searching...")', async () => {
    // Run 1 waits on b.md's read; b.md is deleted meanwhile, so run 2 (without it)
    // finishes first. Run 1 landing later must not put back the deleted file.
    contents.a2 = 'hello there'
    let releaseB!: () => void
    readContent.mockImplementation(async (id: string) => {
      if (id === 'a2') await new Promise<void>((r) => (releaseB = r))
      return contents[id] ?? null
    })
    const List = ({ artifacts }: { artifacts: TaskArtifact[] }) => (
      <ArtifactSearchPanel
        artifacts={artifacts}
        readContent={readContent}
        getArtifactPath={getArtifactPath}
        onSelectResult={onSelectResult}
      />
    )
    const view = render(<List artifacts={ARTIFACTS} />)
    type('hello')
    await settle() // run 1 starts: a.md read, b.md pending

    view.rerender(<List artifacts={[ARTIFACTS[0]]} />)
    await settle() // run 2: a.md only
    expect(searching()).toBe(false)
    expect(files()).toEqual(['a.md'])

    await act(async () => releaseB()) // run 1 lands last
    expect(searching()).toBe(false)
    expect(summary()).toBe('1 result in 1 file')
    expect(files()).toEqual(['a.md'])
  })

  it('a new query resets the collapsed groups when its results land', async () => {
    render(<Tab mode="visible" />)
    type('hello')
    await settle()
    toggle('a.md')
    expect(expanded('a.md')).toBe(false)

    type('hell')
    // The previous results stay on screen, as they were, until the new ones land.
    expect(searching()).toBe(true)
    expect(expanded('a.md')).toBe(false)
    await settle()
    expect(searching()).toBe(false)
    expect(expanded('a.md')).toBe(true)

    // Back to the earlier query: a new search too, not a restore of its groups.
    toggle('a.md')
    type('hello')
    await settle()
    expect(expanded('a.md')).toBe(true)
  })

  it('a changed option resets the collapsed groups when its results land', async () => {
    render(<Tab mode="visible" />)
    type('hello')
    await settle()
    toggle('a.md')

    fireEvent.click(screen.getByTitle('Match Case')) // 'hello' still matches a.md
    expect(expanded('a.md')).toBe(false)
    await settle()
    expect(files()).toEqual(['a.md'])
    expect(expanded('a.md')).toBe(true)
  })

  it('clearing and retyping the query resets the collapsed groups', async () => {
    render(<Tab mode="visible" />)
    type('hello')
    await settle()
    toggle('a.md')

    type('')
    type('hello')
    await settle()
    expect(expanded('a.md')).toBe(true)
  })

  it('a collapsed group stays collapsed when the search re-runs on show', async () => {
    contents.a2 = null // not readable yet: read (and matched) by the re-run on show
    const view = render(<Tab mode="visible" />)
    type('hello')
    await settle()
    toggle('a.md')
    expect(files()).toEqual(['a.md'])
    expect(expanded('a.md')).toBe(false)

    view.rerender(<Tab mode="hidden" />)
    contents.a2 = 'hello there'
    view.rerender(<Tab mode="visible" />)
    await settle()
    expect(files()).toEqual(['a.md', 'b.md']) // the re-run landed
    expect(expanded('a.md')).toBe(false)
    expect(expanded('b.md')).toBe(true)
  })

  it('a collapsed group stays collapsed when the artifact list is refreshed', async () => {
    contents.a2 = 'hello there'
    const List = ({ artifacts }: { artifacts: TaskArtifact[] }) => (
      <ArtifactSearchPanel
        artifacts={artifacts}
        readContent={readContent}
        getArtifactPath={getArtifactPath}
        onSelectResult={onSelectResult}
      />
    )
    const view = render(<List artifacts={ARTIFACTS} />)
    type('hello')
    await settle()
    toggle('a.md')

    // A refetch hands over the same rows as new objects: the search re-runs.
    view.rerender(<List artifacts={ARTIFACTS.map((a) => ({ ...a }))} />)
    expect(searching()).toBe(true)
    await settle()
    expect(searching()).toBe(false)
    expect(files()).toEqual(['a.md', 'b.md'])
    expect(expanded('a.md')).toBe(false)
    expect(expanded('b.md')).toBe(true)
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
