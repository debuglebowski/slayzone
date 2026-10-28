// @vitest-environment jsdom
// Pins useHomePanelState: each project's home panels load from its own settings key,
// edits are saved on a 500ms debounce and flushed on a project switch; and a project
// never shows another project's panels — not for one render, not from a late reply,
// and a load never overwrites an edit made while it was in flight.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'

type Deferred = { promise: Promise<string | null>; resolve: (v: string | null) => void }
let gets: Array<{ key: string } & Deferred> = []
let sets: Array<{ key: string; value: string }> = []

// One stable client: a new object per render would change the hook's callbacks.
const client = {
  settings: {
    get: {
      query: ({ key }: { key: string }) => {
        let resolve!: (v: string | null) => void
        const promise = new Promise<string | null>((r) => {
          resolve = r
        })
        gets.push({ key, promise, resolve })
        return promise
      }
    },
    set: {
      mutate: async (input: { key: string; value: string }) => {
        sets.push(input)
      }
    }
  }
}
vi.mock('@slayzone/transport/client', () => ({ useTRPCClient: () => client }))

const { useHomePanelState } = await import('./useHomePanelVisibility')

const saved = (visibility: Record<string, boolean>, gitTab = 'general'): string =>
  JSON.stringify({ visibility, gitTab })
const gitOpen = { kanban: true, git: true }
const editorOpen = { kanban: true, editor: true }

async function answer(i: number, value: string | null): Promise<void> {
  await act(async () => {
    gets[i].resolve(value)
    await gets[i].promise
  })
}

// Every render a caller would draw, as [projectId, open panels].
function setup(projectId: string) {
  const seen: Array<[string, string[]]> = []
  const hook = renderHook(
    (p: { projectId: string }) => {
      const r = useHomePanelState(p.projectId)
      const open = Object.entries(r[0].visibility)
        .filter(([, v]) => v)
        .map(([k]) => k)
      seen.push([p.projectId, open])
      return r
    },
    { initialProps: { projectId } }
  )
  return { ...hook, seen }
}

beforeEach(() => {
  gets = []
  sets = []
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useHomePanelState', () => {
  it('starts on the defaults and loads the project’s saved panels', async () => {
    const { result } = setup('A')
    expect(result.current[0].visibility.kanban).toBe(true)
    expect(result.current[0].visibility.git).toBe(false)
    expect(gets.map((g) => g.key)).toEqual(['home-panels:A'])
    await answer(0, saved(gitOpen, 'history'))
    expect(result.current[0].visibility.git).toBe(true)
    expect(result.current[0].gitTab).toBe('history')
  })

  it('keeps the defaults when nothing is saved or the value is corrupt', async () => {
    const { result, rerender } = setup('A')
    await answer(0, null)
    expect(result.current[0].visibility.git).toBe(false)
    rerender({ projectId: 'B' })
    await answer(1, '{not json')
    expect(result.current[0].visibility.git).toBe(false)
    expect(result.current[0].visibility.kanban).toBe(true)
  })

  it('saves an edit after 500ms, chaining back-to-back edits', async () => {
    vi.useFakeTimers()
    const { result } = setup('A')
    await answer(0, null)
    act(() => {
      result.current[1]((s) => ({ ...s, visibility: { ...s.visibility, git: true } }))
      result.current[1]((s) => ({ ...s, visibility: { ...s.visibility, editor: true } }))
    })
    expect(result.current[0].visibility).toMatchObject({ git: true, editor: true })
    act(() => vi.advanceTimersByTime(499))
    expect(sets).toEqual([])
    act(() => vi.advanceTimersByTime(1))
    expect(sets).toHaveLength(1)
    expect(sets[0].key).toBe('home-panels:A')
    expect(JSON.parse(sets[0].value).visibility).toMatchObject({ git: true, editor: true })
  })

  it('a project switch flushes the pending save under the old project’s key', async () => {
    const { result, rerender } = setup('A')
    await answer(0, null)
    act(() => result.current[1]((s) => ({ ...s, visibility: { ...s.visibility, git: true } })))
    rerender({ projectId: 'B' })
    expect(sets.map((s) => s.key)).toEqual(['home-panels:A'])
    expect(gets.map((g) => g.key)).toEqual(['home-panels:A', 'home-panels:B'])
  })

  it('switching project never draws the new project with the old one’s panels', async () => {
    const { rerender, seen } = setup('A')
    await answer(0, saved(gitOpen))
    seen.length = 0
    rerender({ projectId: 'B' })
    expect(seen.filter(([id, open]) => id === 'B' && open.includes('git'))).toEqual([])
    await answer(1, saved(editorOpen))
    expect(seen.at(-1)).toEqual(['B', ['kanban', 'editor']])
  })

  it('a late reply for the previous project is dropped', async () => {
    const { result, rerender } = setup('A')
    rerender({ projectId: 'B' })
    await answer(1, saved(editorOpen))
    await answer(0, saved(gitOpen))
    expect(result.current[0].visibility).toMatchObject({ editor: true, git: false })
  })

  it('an edit made while the saved panels load is not overwritten by the load', async () => {
    const { result } = setup('A')
    act(() => result.current[1]((s) => ({ ...s, visibility: { ...s.visibility, tests: true } })))
    await answer(0, saved(gitOpen))
    expect(result.current[0].visibility).toMatchObject({ tests: true, git: false })
  })
})
