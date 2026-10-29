// @vitest-environment jsdom
import type React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'

// The domain's typed view (`../../trpc`) re-types the transport client: serve
// it the transport mock below.
vi.mock('../../trpc', async () => await import('@slayzone/transport/client'))
vi.mock('@slayzone/transport/client', () => ({
  useTRPCClient: () => ({
    chat: {
      getAutocompleteUsage: { query: () => Promise.resolve({}) },
      bumpAutocompleteUsage: { mutate: () => Promise.resolve() }
    }
  })
}))

import { useAutocomplete, type UseAutocompleteOptions } from './useAutocomplete'
import type { AutocompleteSource } from './types'

/** `/word` at the cursor; items filtered by prefix. */
const slashSource: AutocompleteSource<string> = {
  id: 'slash',
  detect: (draft, cursorPos) => {
    const m = /(?:^|\s)\/(\w*)$/.exec(draft.slice(0, cursorPos))
    if (!m) return null
    return { query: m[1], tokenStart: cursorPos - m[1].length - 1, tokenEnd: cursorPos }
  },
  fetch: () => Promise.resolve(['alpha', 'alpine', 'alps', 'beta']),
  filter: (items, query) => items.filter((item) => item.startsWith(query)),
  getKey: (item) => item,
  render: (item) => item,
  accept: () => {}
}
const sources = [slashSource] as AutocompleteSource[]
const fetchCtx = { cwd: '/repo' }
const acceptCtx = {} as UseAutocompleteOptions['acceptCtx']

const key = (k: string) =>
  ({ key: k, preventDefault: () => {} }) as unknown as React.KeyboardEvent<HTMLTextAreaElement>

async function setup(draft: string, cursorPos = draft.length) {
  const hook = renderHook(
    (props: { draft: string; cursorPos: number }) =>
      useAutocomplete({ sources, setDraft: () => {}, acceptCtx, fetchCtx, ...props }),
    { initialProps: { draft, cursorPos } }
  )
  await waitFor(() => expect(hook.result.current.show).toBe(true))
  return hook
}

describe('useAutocomplete selection', () => {
  it('restarts the selection when the match query changes', async () => {
    const { result, rerender } = await setup('/a')
    act(() => {
      result.current.handleKeyDown(key('ArrowDown'))
    })
    act(() => {
      result.current.handleKeyDown(key('ArrowDown'))
    })
    expect(result.current.selectedIndex).toBe(2)

    rerender({ draft: '/al', cursorPos: 3 })
    expect(result.current.active?.match.query).toBe('al')
    expect(result.current.selectedIndex).toBe(0)
  })

  it('keeps the selection while the match is unchanged', async () => {
    const { result, rerender } = await setup('/a')
    act(() => {
      result.current.handleKeyDown(key('ArrowDown'))
    })
    expect(result.current.selectedIndex).toBe(1)

    rerender({ draft: '/a', cursorPos: 2 })
    expect(result.current.selectedIndex).toBe(1)
  })
})

describe('useAutocomplete dismissal', () => {
  it('Esc hides the menu until the draft or cursor changes', async () => {
    const { result, rerender } = await setup('/a')
    act(() => {
      result.current.handleKeyDown(key('Escape'))
    })
    expect(result.current.show).toBe(false)

    // Same draft + cursor: stays dismissed.
    rerender({ draft: '/a', cursorPos: 2 })
    expect(result.current.show).toBe(false)

    // Next keystroke reopens it, with a fresh selection.
    rerender({ draft: '/al', cursorPos: 3 })
    expect(result.current.show).toBe(true)
    expect(result.current.active?.match.query).toBe('al')
    expect(result.current.selectedIndex).toBe(0)
  })

  it('a cursor move alone also clears the dismissal', async () => {
    const { result, rerender } = await setup('/al x', 3)
    act(() => {
      result.current.handleKeyDown(key('Escape'))
    })
    expect(result.current.show).toBe(false)

    rerender({ draft: '/al x', cursorPos: 2 })
    expect(result.current.show).toBe(true)
    expect(result.current.active?.match.query).toBe('a')
  })
})
