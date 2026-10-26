// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { createTrpcTest } from '@slayzone/transport/testing'

vi.mock('@slayzone/telemetry/client', () => ({ track: vi.fn() }))

import { SearchPanel } from './SearchPanel'

interface SearchInput {
  rootPath: string
  query: string
  options: { matchCase?: boolean; regex?: boolean }
}

let search: ReturnType<typeof vi.fn<(input: SearchInput) => unknown>>
let wrapper: (props: { children: ReactNode }) => ReactNode

beforeEach(() => {
  vi.useFakeTimers()
  search = vi.fn((input: SearchInput) => ({
    results:
      input.query === 'none'
        ? []
        : [
            {
              path: 'src/a.ts',
              matches: [
                { line: 3, col: 1, lineText: `const ${input.query} = 1` },
                { line: 9, col: 1, lineText: `use(${input.query})` }
              ]
            }
          ]
  }))
  wrapper = createTrpcTest({
    procedures: { 'fileEditor.searchFiles': (input) => search(input as SearchInput) }
  }).wrapper
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
    for (let i = 0; i < 10; i++) await Promise.resolve()
    await vi.advanceTimersByTimeAsync(0)
  })
}

function status(): string | null {
  const el = screen.queryByText(/Searching\.\.\.|result/)
  return el?.textContent ?? null
}

function renderPanel() {
  const Wrapper = wrapper
  return render(
    <Wrapper>
      <SearchPanel projectPath="/proj" onOpenFile={vi.fn()} />
    </Wrapper>
  )
}

describe('SearchPanel', () => {
  it('shows the spinner right away, debounces, then shows the result count', async () => {
    renderPanel()
    expect(status()).toBeNull()

    fireEvent.change(screen.getByPlaceholderText('Search files...'), { target: { value: 'f' } })
    expect(status()).toBe(' Searching...')
    await settle(100)
    fireEvent.change(screen.getByPlaceholderText('Search files...'), { target: { value: 'fo' } })
    expect(status()).toBe(' Searching...')
    await settle(299)
    expect(search).not.toHaveBeenCalled()

    await settle(1)
    expect(search).toHaveBeenCalledTimes(1)
    expect(search.mock.calls[0][0]).toMatchObject({
      rootPath: '/proj',
      query: 'fo',
      options: { matchCase: false, regex: false }
    })
    expect(status()).toBe('2 results in 1 file')
    expect(screen.getByText('a.ts')).toBeTruthy()
  })

  it('an option toggle re-searches; clearing the query clears results and status', async () => {
    renderPanel()
    fireEvent.change(screen.getByPlaceholderText('Search files...'), { target: { value: 'foo' } })
    await settle(300)
    expect(status()).toBe('2 results in 1 file')

    fireEvent.click(screen.getByTitle('Match Case'))
    expect(status()).toBe(' Searching...')
    await settle(300)
    expect(search).toHaveBeenCalledTimes(2)
    expect(search.mock.calls[1][0]).toMatchObject({ options: { matchCase: true, regex: false } })
    expect(status()).toBe('2 results in 1 file')

    fireEvent.change(screen.getByPlaceholderText('Search files...'), { target: { value: '  ' } })
    expect(status()).toBeNull()
    expect(screen.queryByText('a.ts')).toBeNull()
    await settle(1000)
    expect(search).toHaveBeenCalledTimes(2)

    // Toggling an option with an empty query neither searches nor shows a status.
    fireEvent.click(screen.getByTitle('Use Regex'))
    await settle(1000)
    expect(search).toHaveBeenCalledTimes(2)
    expect(status()).toBeNull()
  })

  it('zero matches reports 0 results', async () => {
    renderPanel()
    fireEvent.change(screen.getByPlaceholderText('Search files...'), { target: { value: 'none' } })
    await settle(300)
    expect(status()).toBe('0 results in 0 files')
  })
})
