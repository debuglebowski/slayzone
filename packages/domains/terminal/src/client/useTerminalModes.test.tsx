// @vitest-environment jsdom
// Pins useTerminalModes' load lifecycle: one modes fetch per mount and per tRPC
// client, `loading` held true until that fetch settles, and a refetch after each
// mutation.
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'

type Mode = { id: string; label: string }

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function makeClient(): { client: unknown; modesList: ReturnType<typeof vi.fn> } {
  const modesList = vi.fn()
  return { client: { pty: { modesList: { query: modesList } } }, modesList }
}

let currentClient: unknown
const mutateAsync = vi.fn()

vi.mock('@slayzone/transport/client', () => ({
  useTRPC: () =>
    new Proxy({}, { get: () => new Proxy({}, { get: () => ({ mutationOptions: () => ({}) }) }) }),
  useTRPCClient: () => currentClient
}))
vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutateAsync })
}))

const { useTerminalModes } = await import('./useTerminalModes')

beforeEach(() => {
  mutateAsync.mockReset()
})
afterEach(cleanup)

describe('useTerminalModes', () => {
  it('loads the modes once on mount, loading until the fetch settles', async () => {
    const a = makeClient()
    const list = deferred<Mode[]>()
    a.modesList.mockReturnValue(list.promise)
    currentClient = a.client
    const { result } = renderHook(() => useTerminalModes())
    expect(result.current.loading).toBe(true)
    expect(result.current.modes).toEqual([])
    expect(a.modesList).toHaveBeenCalledTimes(1)
    await act(async () => list.resolve([{ id: 'claude-code', label: 'Claude' }]))
    expect(result.current.loading).toBe(false)
    expect(result.current.modes).toEqual([{ id: 'claude-code', label: 'Claude' }])
    expect(a.modesList).toHaveBeenCalledTimes(1)
  })

  it('StrictMode replays the mount effect: two fetches, as before', async () => {
    const a = makeClient()
    a.modesList.mockResolvedValue([])
    currentClient = a.client
    const { result } = renderHook(() => useTerminalModes(), { reactStrictMode: true })
    await act(async () => {})
    expect(a.modesList).toHaveBeenCalledTimes(2)
    expect(result.current.loading).toBe(false)
  })

  it('a new tRPC client refetches once through it, loading until it settles', async () => {
    const a = makeClient()
    a.modesList.mockResolvedValue([{ id: 'a', label: 'A' }])
    currentClient = a.client
    const { result, rerender } = renderHook(() => useTerminalModes())
    await act(async () => {})
    expect(result.current.loading).toBe(false)

    const b = makeClient()
    const list = deferred<Mode[]>()
    b.modesList.mockReturnValue(list.promise)
    currentClient = b.client
    rerender()
    await act(async () => {})
    expect(b.modesList).toHaveBeenCalledTimes(1)
    expect(a.modesList).toHaveBeenCalledTimes(1)
    expect(result.current.loading).toBe(true)
    expect(result.current.modes).toEqual([{ id: 'a', label: 'A' }])

    await act(async () => list.resolve([{ id: 'b', label: 'B' }]))
    expect(result.current.loading).toBe(false)
    expect(result.current.modes).toEqual([{ id: 'b', label: 'B' }])
    expect(b.modesList).toHaveBeenCalledTimes(1)
  })

  // Flagged change (lint pass 2): `loading` turns true in the same commit that first
  // renders the new client, not one commit later. Nothing reads `loading` today.
  it('a new tRPC client commits loading=true right away', async () => {
    const a = makeClient()
    a.modesList.mockResolvedValue([])
    currentClient = a.client
    const committed: boolean[] = []
    const { rerender } = renderHook(() => {
      const r = useTerminalModes()
      useEffect(() => {
        committed.push(r.loading)
      })
      return r
    })
    await act(async () => {})
    const b = makeClient()
    b.modesList.mockResolvedValue([])
    currentClient = b.client
    committed.length = 0
    rerender()
    await act(async () => {})
    expect(committed).toEqual([true, false])
  })

  it('re-renders with the same client do not refetch', async () => {
    const a = makeClient()
    a.modesList.mockResolvedValue([])
    currentClient = a.client
    const { rerender } = renderHook(() => useTerminalModes())
    await act(async () => {})
    rerender()
    rerender()
    await act(async () => {})
    expect(a.modesList).toHaveBeenCalledTimes(1)
  })

  it('a mutation refetches the list, loading while it runs', async () => {
    const a = makeClient()
    a.modesList.mockResolvedValue([])
    currentClient = a.client
    const { result } = renderHook(() => useTerminalModes())
    await act(async () => {})

    mutateAsync.mockResolvedValue({ id: 'new', label: 'New' })
    const list = deferred<Mode[]>()
    a.modesList.mockReturnValue(list.promise)
    let created: Promise<unknown> | undefined
    await act(async () => {
      created = result.current.createMode({ id: 'new' } as never)
    })
    expect(result.current.loading).toBe(true)
    await act(async () => {
      list.resolve([{ id: 'new', label: 'New' }])
      await created
    })
    expect(await created).toEqual({ id: 'new', label: 'New' })
    expect(result.current.loading).toBe(false)
    expect(result.current.modes).toEqual([{ id: 'new', label: 'New' }])
    expect(a.modesList).toHaveBeenCalledTimes(2)
  })
})
