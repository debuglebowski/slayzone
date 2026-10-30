// @vitest-environment jsdom
// useArtifacts mirrors the getByTask / foldersGetByTask queries into local state,
// which its mutations update optimistically. Task tabs live in <Activity>: hiding
// and re-showing a tab re-runs its effects. Pins, over a real QueryClient:
// - a local edit is not reverted to the (older) cached query data by a tab switch;
// - new query data still replaces the mirror: a refetch while visible, data that
//   changed while the tab was hidden, and the refetch the app runs on reveal for
//   a `tasks-changed` event deferred while hidden (refreshTaskScopedQueries).
import { Activity } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ArtifactFolder, TaskArtifact } from '@slayzone/task-contracts'

type Row = Record<string, unknown> & { id: string }
// The hub: rows per procedure, keyed by task.
const server: { artifacts: Row[]; folders: Row[] } = { artifacts: [], folders: [] }

function query(proc: string, input: { taskId: string }): unknown {
  // A fresh array/objects per read, like a real response.
  if (proc === 'getByTask')
    return server.artifacts.filter((a) => a.task_id === input.taskId).map((a) => ({ ...a }))
  if (proc === 'foldersGetByTask')
    return server.folders.filter((f) => f.task_id === input.taskId).map((f) => ({ ...f }))
  throw new Error(`unexpected query ${proc}`)
}

function mutate(proc: string, input: Record<string, unknown>): unknown {
  const patch = (rows: Row[], fields: Record<string, unknown>): Row => {
    const i = rows.findIndex((r) => r.id === input.id)
    rows[i] = { ...rows[i], ...fields }
    return { ...rows[i] }
  }
  if (proc === 'update') {
    const fields: Record<string, unknown> = {}
    if ('title' in input) fields.title = input.title
    if ('folderId' in input) fields.folder_id = input.folderId
    return patch(server.artifacts, fields)
  }
  if (proc === 'foldersUpdate') return patch(server.folders, { name: input.name })
  throw new Error(`unexpected mutation ${proc}`)
}

vi.mock('./trpc', () => {
  const procedure = (proc: string) => ({
    queryOptions: (input: { taskId: string }, opts?: { enabled?: boolean }) => ({
      queryKey: [['artifacts', proc], { input, type: 'query' }],
      queryFn: async () => query(proc, input),
      ...opts
    }),
    mutationOptions: () => ({
      mutationFn: async (input: Record<string, unknown>) => mutate(proc, input)
    })
  })
  const artifacts = new Proxy({}, { get: (_t, proc: string) => procedure(proc) })
  return { useTRPC: () => ({ artifacts }) }
})
vi.mock('@slayzone/telemetry/client', () => {
  const tracker = {
    track: vi.fn(),
    trackTask: vi.fn(),
    trackProject: vi.fn(),
    trackShortcut: vi.fn()
  }
  return { useTrack: () => tracker }
})

const { useArtifacts } = await import('./useArtifacts')

let latest: ReturnType<typeof useArtifacts>
function Probe({ taskId }: { taskId: string }) {
  latest = useArtifacts(taskId)
  return null
}

let client: QueryClient
function Tab({ mode }: { mode: 'visible' | 'hidden' }) {
  return (
    <QueryClientProvider client={client}>
      <Activity mode={mode}>
        <Probe taskId="t1" />
      </Activity>
    </QueryClientProvider>
  )
}

const titles = () => latest.artifacts.map((a: TaskArtifact) => a.title)
const folderNames = () => latest.folders.map((f: ArtifactFolder) => f.name)

async function mountLoaded() {
  const view = render(<Tab mode="visible" />)
  await waitFor(() => expect(titles()).toEqual(['one.md']))
  expect(folderNames()).toEqual(['docs'])
  return view
}

function switchAwayAndBack(view: ReturnType<typeof render>) {
  view.rerender(<Tab mode="hidden" />)
  view.rerender(<Tab mode="visible" />)
}

beforeEach(() => {
  server.artifacts = [{ id: 'a1', task_id: 't1', title: 'one.md', folder_id: null }]
  server.folders = [{ id: 'f1', task_id: 't1', name: 'docs', parent_id: null }]
  // The app's defaults (makeQueryClient): 5s staleTime, no retry.
  client = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: false } } })
})
afterEach(() => {
  cleanup()
  client.clear()
})

describe('useArtifacts across a tab switch', () => {
  it('a rename made here survives hiding and re-showing the tab', async () => {
    const view = await mountLoaded()
    await act(() => latest.renameArtifact('a1', 'renamed.md'))
    expect(titles()).toEqual(['renamed.md'])

    switchAwayAndBack(view)
    expect(titles()).toEqual(['renamed.md'])
  })

  it('a folder rename made here survives hiding and re-showing the tab', async () => {
    const view = await mountLoaded()
    await act(() => latest.renameFolder('f1', 'notes'))
    expect(folderNames()).toEqual(['notes'])

    switchAwayAndBack(view)
    expect(folderNames()).toEqual(['notes'])
  })

  it('a refetch while visible replaces the mirror', async () => {
    await mountLoaded()
    server.artifacts[0] = { ...server.artifacts[0], title: 'external.md' }
    await act(() => client.invalidateQueries({ queryKey: [['artifacts', 'getByTask']] }))
    await waitFor(() => expect(titles()).toEqual(['external.md']))
  })

  it('data that changed while the tab was hidden lands when it is shown', async () => {
    const view = await mountLoaded()
    view.rerender(<Tab mode="hidden" />)
    server.artifacts[0] = { ...server.artifacts[0], title: 'while-hidden.md' }
    server.folders[0] = { ...server.folders[0], name: 'renamed-folder' }
    // Another view of the same task refetched the shared cache entry meanwhile.
    await act(() => client.refetchQueries({ queryKey: [['artifacts']] }))
    view.rerender(<Tab mode="visible" />)
    await waitFor(() => expect(titles()).toEqual(['while-hidden.md']))
    expect(folderNames()).toEqual(['renamed-folder'])
  })

  it('a tasks-changed refresh deferred while hidden lands on reveal', async () => {
    const view = await mountLoaded()
    view.rerender(<Tab mode="hidden" />)
    server.artifacts[0] = { ...server.artifacts[0], title: 'deferred.md' }
    // refreshTaskScopedQueries for a hidden tab: mark stale, don't refetch...
    await act(() => client.invalidateQueries({ queryKey: [['artifacts']], refetchType: 'none' }))
    expect(titles()).toEqual(['one.md'])
    // ...then useTaskScopedQueriesFreshOnReveal refetches once the tab is shown.
    view.rerender(<Tab mode="visible" />)
    await act(() => client.refetchQueries({ queryKey: [['artifacts']], type: 'active' }))
    await waitFor(() => expect(titles()).toEqual(['deferred.md']))
  })
})
