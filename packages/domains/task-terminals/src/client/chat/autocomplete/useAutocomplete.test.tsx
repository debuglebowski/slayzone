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

// ---- Native slash commands (Claude chat): Enter policy, shadowing, suppression ----

interface Cmd {
  name: string
  description: string
}
const slashDetect: AutocompleteSource['detect'] = (draft, cursorPos) => {
  if (!draft.startsWith('/')) return null
  const rest = draft.slice(1, cursorPos)
  if (/\s/.test(rest)) return null
  return { query: rest, tokenStart: 0, tokenEnd: cursorPos }
}
function cmdSource(
  id: string,
  items: Cmd[],
  extra: Partial<AutocompleteSource<Cmd>> = {}
): AutocompleteSource<Cmd> {
  return {
    id,
    commandTrigger: true,
    detect: slashDetect,
    fetch: () => Promise.resolve(items),
    filter: (all) => all,
    getKey: (c) => `${id}:${c.name}`,
    render: (c) => c.name,
    getName: (c) => c.name,
    getDescription: (c) => c.description,
    accept: vi.fn(),
    ...extra
  }
}

const enter = () =>
  ({
    key: 'Enter',
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    preventDefault: () => {}
  }) as unknown as React.KeyboardEvent<HTMLTextAreaElement>

async function setupNative(
  srcs: AutocompleteSource[],
  draft: string,
  opts: Partial<UseAutocompleteOptions> = {}
) {
  const submit = vi.fn()
  const hook = renderHook(
    (props: { draft: string; cursorPos: number; suppressed?: boolean }) =>
      useAutocomplete({
        sources: srcs,
        setDraft: () => {},
        acceptCtx,
        fetchCtx,
        enterPolicy: 'native-commands',
        submit,
        ...opts,
        ...props
      }),
    { initialProps: { draft, cursorPos: draft.length, suppressed: false } }
  )
  await waitFor(() => expect(hook.result.current.show).toBe(true))
  return { ...hook, submit }
}

const CLI: Cmd[] = [
  { name: 'compact', description: 'Summarize the conversation to free up context' },
  { name: 'context', description: 'Show what fills the context window' }
]
const cliSrc = () =>
  cmdSource('cli-commands', CLI, {
    shadowedBy: ['builtins'],
    submitText: (c) => `/${c.name}`
  })

describe('useAutocomplete — native slash commands', () => {
  it('Enter on an exactly typed command sends that command, not the highlighted fuzzy pick', async () => {
    const other = cmdSource('skills', [{ name: 'compact-notes', description: '' }])
    const { result, submit } = await setupNative(
      [other, cliSrc()] as AutocompleteSource[],
      '/context'
    )
    act(() => {
      result.current.handleKeyDown(enter())
    })
    expect(submit).toHaveBeenCalledWith('/context')
  })

  it('Enter on an unknown command passes the draft through as typed', async () => {
    // `free` only matches a description, so the menu shows but no name fits.
    const { result, submit } = await setupNative([cliSrc()] as AutocompleteSource[], '/free')
    act(() => {
      result.current.handleKeyDown(enter())
    })
    expect(submit).toHaveBeenCalledWith('/free')
  })

  it('Enter after arrowing to an entry submits that entry', async () => {
    const { result, submit } = await setupNative([cliSrc()] as AutocompleteSource[], '/co')
    act(() => {
      result.current.handleKeyDown(key('ArrowDown'))
    })
    const second = (result.current.active!.entries[1].item as Cmd).name
    act(() => {
      result.current.handleKeyDown(enter())
    })
    expect(submit).toHaveBeenCalledWith(`/${second}`)
  })

  it('an entry without submitText (builtin) is accepted on Enter', async () => {
    const builtin = cmdSource('builtins', [{ name: 'clear', description: 'Clear the chat' }])
    const { result, submit } = await setupNative([builtin] as AutocompleteSource[], '/clear')
    act(() => {
      result.current.handleKeyDown(enter())
    })
    expect(builtin.accept).toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

  it('shadowedBy hides a name another source already lists', async () => {
    const builtin = cmdSource('builtins', [{ name: 'compact', description: 'app version' }])
    const { result } = await setupNative([builtin, cliSrc()] as AutocompleteSource[], '/')
    const listed = result.current.active!.entries.map(
      (e) => `${e.source.id}:${(e.item as Cmd).name}`
    )
    expect(listed).toContain('builtins:compact')
    expect(listed).not.toContain('cli-commands:compact')
    expect(listed).toContain('cli-commands:context')
  })

  it('suppressed hides the menu', async () => {
    const { result, rerender } = await setupNative([cliSrc()] as AutocompleteSource[], '/co')
    rerender({ draft: '/co', cursorPos: 3, suppressed: true })
    expect(result.current.show).toBe(false)
  })

  it('accept-selected policy (Codex) keeps accepting the highlighted entry', async () => {
    const src = cliSrc()
    const { result, submit } = await setupNative([src] as AutocompleteSource[], '/free', {
      enterPolicy: 'accept-selected'
    })
    act(() => {
      result.current.handleKeyDown(enter())
    })
    expect(src.accept).toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })
})
