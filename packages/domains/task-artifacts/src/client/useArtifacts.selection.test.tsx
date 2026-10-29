// @vitest-environment jsdom
// The selected artifact vs the task's saved one (`active_artifact_id`, passed in as
// `initialSelectedId`). The panel saves each selection 500 ms after it is made
// (usePersistenceSaves), so the saved value trails the selection; the only other
// writers are other app windows / clients of the same task (and anything PATCHing
// /api/tasks/:id). Task tabs live in <Activity>: hiding and re-showing a tab re-runs
// its effects. Pins, with the multi-select (useArtifactClipboard) wired as in the panel:
// - the saved selection is adopted on mount and on a task change;
// - one saved from outside is adopted when the tab is next shown (whether it changed
//   while hidden or while on screen), as before;
// - a re-show never puts back a saved value older than the selection made here, so
//   the selection and the multi-select survive a tab switch inside the save window.
import { Activity } from 'react'
import type React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('./trpc', () => {
  const rows: Record<string, unknown[]> = {
    'artifacts.getByTask:t1': ['a1', 'a2', 'a3'].map((id) => ({
      id,
      task_id: 't1',
      title: `${id}.md`,
      folder_id: null
    })),
    'artifacts.getByTask:t2': [{ id: 'b1', task_id: 't2', title: 'b1.md', folder_id: null }]
  }
  const procedure = (path: string) => ({
    queryOptions: (input: { taskId: string }, opts?: { enabled?: boolean }) => ({
      queryKey: [path.split('.'), { input, type: 'query' }],
      queryFn: async () =>
        (rows[`${path}:${input.taskId}`] ?? []).map((r) => ({ ...(r as object) })),
      ...opts
    }),
    mutationOptions: () => ({ mutationFn: async () => null })
  })
  const namespace = (ns: string) =>
    new Proxy({}, { get: (_t, proc: string) => procedure(`${ns}.${proc}`) })
  // One client object for the app's lifetime, like the real provider's.
  const trpc = { artifacts: namespace('artifacts'), app: { clipboard: namespace('app.clipboard') } }
  return { useTRPC: () => trpc }
})
vi.mock('@slayzone/telemetry/client', () => ({ track: vi.fn() }))

const { useArtifacts } = await import('./useArtifacts')
const { useArtifactClipboard } = await import('./useArtifactClipboard')

const FLAT_IDS = ['a1', 'a2', 'a3']
let latest: {
  selectedId: string | null
  selectedIds: string[]
  select: (id: string | null) => void
  click: (e: React.MouseEvent, id: string) => void
}

function Probe({ taskId, saved }: { taskId: string; saved: string | null }) {
  const a = useArtifacts(taskId, saved)
  const c = useArtifactClipboard({
    taskId,
    artifacts: a.artifacts,
    selectedId: a.selectedId,
    setSelectedId: a.setSelectedId,
    deleteArtifact: a.deleteArtifact,
    getFilePath: a.getFilePath,
    flatArtifactIds: FLAT_IDS
  })
  latest = {
    selectedId: a.selectedId,
    selectedIds: [...c.selectedIds].sort(),
    select: a.setSelectedId,
    click: c.handleArtifactClick
  }
  return null
}

let client: QueryClient
/** `saved` = the task's `active_artifact_id` as the page currently has it. */
function Tab({
  mode,
  taskId = 't1',
  saved
}: {
  mode: 'visible' | 'hidden'
  taskId?: string
  saved: string | null
}) {
  return (
    <QueryClientProvider client={client}>
      <Activity mode={mode}>
        <Probe taskId={taskId} saved={saved} />
      </Activity>
    </QueryClientProvider>
  )
}

const click = (id: string, mods: Partial<React.MouseEvent> = {}) =>
  act(() => latest.click({ ...mods } as React.MouseEvent, id))
const select = (id: string) => act(() => latest.select(id))

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: false } } })
})
afterEach(() => {
  cleanup()
  client.clear()
})

describe('useArtifacts selection: the saved artifact is adopted', () => {
  it('on mount', () => {
    render(<Tab mode="visible" saved="a2" />)
    expect(latest.selectedId).toBe('a2')
    expect(latest.selectedIds).toEqual(['a2'])
  })

  it('on a task change, over the selection made for the previous task', () => {
    const view = render(<Tab mode="visible" saved="a1" />)
    select('a3')
    view.rerender(<Tab mode="visible" taskId="t2" saved="b1" />)
    expect(latest.selectedId).toBe('b1')
    expect(latest.selectedIds).toEqual(['b1'])

    // A task with nothing saved selects nothing.
    view.rerender(<Tab mode="visible" taskId="t3" saved={null} />)
    expect(latest.selectedId).toBeNull()
  })

  it('on a task change made while the tab was hidden: on show', () => {
    const view = render(<Tab mode="visible" saved="a1" />)
    select('a3')
    view.rerender(<Tab mode="hidden" saved="a1" />)
    view.rerender(<Tab mode="hidden" taskId="t2" saved="b1" />)
    view.rerender(<Tab mode="visible" taskId="t2" saved="b1" />)
    expect(latest.selectedId).toBe('b1')
    expect(latest.selectedIds).toEqual(['b1'])
  })

  it('when saved from outside while the tab was hidden: on show', () => {
    const view = render(<Tab mode="visible" saved="a1" />)
    view.rerender(<Tab mode="hidden" saved="a1" />)
    // Another window (or client) of this task selected a2; the task list refetched.
    view.rerender(<Tab mode="hidden" saved="a2" />)
    view.rerender(<Tab mode="visible" saved="a2" />)
    expect(latest.selectedId).toBe('a2')
    expect(latest.selectedIds).toEqual(['a2'])
  })

  it('when saved from outside while on screen: at the next show, not mid-view (as before)', () => {
    const view = render(<Tab mode="visible" saved="a1" />)
    view.rerender(<Tab mode="visible" saved="a2" />)
    expect(latest.selectedId).toBe('a1')

    view.rerender(<Tab mode="hidden" saved="a2" />)
    view.rerender(<Tab mode="visible" saved="a2" />)
    expect(latest.selectedId).toBe('a2')
  })
})

describe('useArtifacts selection: a tab re-show keeps the selection made here', () => {
  it('a selection not saved yet (inside the 500 ms save window)', () => {
    const view = render(<Tab mode="visible" saved="a1" />)
    select('a2')

    view.rerender(<Tab mode="hidden" saved="a1" />)
    view.rerender(<Tab mode="visible" saved="a1" />)
    expect(latest.selectedId).toBe('a2')
    expect(latest.selectedIds).toEqual(['a2'])
  })

  it('a multi-select not containing the saved artifact', async () => {
    const view = render(<Tab mode="visible" saved="a1" />)
    await click('a2')
    await click('a3', { metaKey: true })
    expect(latest.selectedIds).toEqual(['a2', 'a3'])
    expect(latest.selectedId).toBe('a3')

    view.rerender(<Tab mode="hidden" saved="a1" />)
    view.rerender(<Tab mode="visible" saved="a1" />)
    expect(latest.selectedIds).toEqual(['a2', 'a3'])
    expect(latest.selectedId).toBe('a3')
  })

  it('a selection made after the previous one was saved', () => {
    const view = render(<Tab mode="visible" saved="a1" />)
    select('a2')
    view.rerender(<Tab mode="visible" saved="a2" />) // a2's save landed
    select('a3')

    view.rerender(<Tab mode="hidden" saved="a2" />)
    view.rerender(<Tab mode="visible" saved="a2" />)
    expect(latest.selectedId).toBe('a3')
  })

  it('a selection made after one saved from outside', () => {
    const view = render(<Tab mode="visible" saved="a1" />)
    view.rerender(<Tab mode="visible" saved="a2" />) // saved from outside
    select('a3')

    view.rerender(<Tab mode="hidden" saved="a2" />)
    view.rerender(<Tab mode="visible" saved="a2" />)
    expect(latest.selectedId).toBe('a3')
  })
})
