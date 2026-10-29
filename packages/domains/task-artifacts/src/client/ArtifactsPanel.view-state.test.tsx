// @vitest-environment jsdom
// The artifact viewer's view state: the view mode (preview / split / raw) and the find
// bar (open, query). Selecting an artifact resets both (to that artifact's saved view
// mode, else the appearance default; find bar closed). Task tabs live in <Activity>,
// which tears effects down on hide and re-runs them on show — and the reset rode on an
// effect, so a plain tab switch also closed the find bar and put back the saved view
// mode over one picked since (from a search hit, or with its save still in flight).
// The same reset, a commit after a search hit in another artifact, wiped the hit's
// query and raw view; and it read the saved view mode only as of the selection, so
// with the artifacts still loading then, the default showed until the next tab show.
// Pins: the reset on a selection change, the saved view mode on mount.
import { Activity, createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { TaskArtifact } from '@slayzone/task-contracts'
import type { ArtifactsPanelHandle } from './ArtifactsPanel.types'

type Row = Pick<TaskArtifact, 'id' | 'task_id' | 'title' | 'folder_id' | 'render_mode'> & {
  view_mode: string | null
}

// The server: t1's artifacts. `updateGate`, when set, holds every update in flight.
const server: { rows: Row[]; updateGate: Promise<void> | null } = { rows: [], updateGate: null }

// A stable tRPC view, like the real provider's: one proxy object per path.
vi.mock('./trpc', () => {
  const nodes = new Map<string, unknown>()
  const queryFn = (path: string, input: { taskId?: string } | undefined) => async () => {
    if (path === 'artifacts.getByTask')
      return server.rows.filter((r) => r.task_id === input?.taskId).map((r) => ({ ...r }))
    if (path === 'artifacts.foldersGetByTask') return []
    if (path === 'app.clipboard.hasFiles') return false
    return null
  }
  const mutationFn = (path: string) => async (input: { id?: string; viewMode?: string }) => {
    if (path !== 'artifacts.update') return null
    if (server.updateGate) await server.updateGate
    const row = server.rows.find((r) => r.id === input.id)
    if (!row) return null
    if (input.viewMode !== undefined) row.view_mode = input.viewMode
    return { ...row }
  }
  const node = (path: string[]): unknown => {
    const key = path.join('.')
    const existing = nodes.get(key)
    if (existing) return existing
    const leaf: Record<string, unknown> = {
      queryOptions: (input: { taskId?: string } | undefined, opts?: object) => ({
        queryKey: [path, { input, type: 'query' }],
        queryFn: queryFn(key, input),
        ...opts
      }),
      mutationOptions: () => ({ mutationFn: mutationFn(key) })
    }
    const proxy = new Proxy(leaf, {
      get: (target, prop: string) => (prop in target ? target[prop] : node([...path, prop]))
    })
    nodes.set(key, proxy)
    return proxy
  }
  const trpc = node([])
  return { useTRPC: () => trpc, useTRPCClient: () => trpc }
})
vi.mock('@slayzone/telemetry/client', () => ({ track: vi.fn() }))
vi.mock('@slayzone/transport/client', () => ({ electronBootstrap: { getDropPaths: () => [] } }))
const appearance = {
  editorMarkdownViewMode: 'rich',
  notesReadability: 'normal',
  notesWidth: 'narrow',
  notesFontFamily: 'sans',
  editorMinimapEnabled: false,
  editorTocEnabled: false
}
vi.mock('@slayzone/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@slayzone/ui')>()),
  useAppearance: () => appearance
}))
// The Display popover, always open: its view-mode buttons are what's clicked.
vi.mock('@slayzone/editor', () => ({
  MarkdownSettingsPopover: ({
    trigger,
    children
  }: {
    trigger: React.ReactNode
    children: React.ReactNode
  }) => (
    <div>
      {trigger}
      {children}
    </div>
  )
}))
// The viewer, reduced to the props under test.
vi.mock('./ArtifactContentEditor', () => ({
  ArtifactContentEditor: ({
    artifact,
    viewMode,
    searchQuery
  }: {
    artifact: TaskArtifact
    viewMode: string
    searchQuery: string
  }) => (
    <div
      data-testid="viewer"
      data-artifact={artifact.id}
      data-view-mode={viewMode}
      data-search={searchQuery}
    />
  )
}))
// The search sidebar, reduced to one hit per artifact (a "needle" match).
vi.mock('./ArtifactSearchPanel', () => ({
  ArtifactSearchPanel: ({
    artifacts,
    onSelectResult
  }: {
    artifacts: TaskArtifact[]
    onSelectResult: (
      id: string,
      payload: { query: string; matchCase: boolean; useRegex: boolean; matchIndex: number }
    ) => void
  }) => (
    <div>
      {artifacts.map((a) => (
        <button
          key={a.id}
          data-testid={`hit-${a.id}`}
          onClick={() =>
            onSelectResult(a.id, {
              query: 'needle',
              matchCase: true,
              useRegex: false,
              matchIndex: 0
            })
          }
        />
      ))}
    </div>
  )
}))
vi.mock('./VersionsPanel', () => ({ VersionsPanel: () => null }))

const { ArtifactsPanel } = await import('./ArtifactsPanel')

const row = (id: string, viewMode: string | null = null): Row => ({
  id,
  task_id: 't1',
  title: `${id}.md`,
  folder_id: null,
  render_mode: null,
  view_mode: viewMode
})

let client: QueryClient
const handle = createRef<ArtifactsPanelHandle>()

function Tab({ mode, saved = 'a1' }: { mode: 'visible' | 'hidden'; saved?: string | null }) {
  return (
    <QueryClientProvider client={client}>
      <Activity mode={mode}>
        <ArtifactsPanel ref={handle} taskId="t1" initialActiveArtifactId={saved} />
      </Activity>
    </QueryClientProvider>
  )
}

const viewer = () => screen.getByTestId('viewer')
const findInput = () => screen.queryByPlaceholderText<HTMLInputElement>('Find...')
/** Let pending timers up to `ms` fire, and the renders they cause land. */
const settle = (ms = 0) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
/** Every query (and, unless held, mutation) finished, and its result rendered. */
async function idle({ mutations = true } = {}) {
  await waitFor(() => expect(client.isFetching()).toBe(0))
  if (mutations) await waitFor(() => expect(client.isMutating()).toBe(0))
  await settle(10)
}

async function mountLoaded(saved = 'a1') {
  const view = render(<Tab mode="visible" saved={saved} />)
  await waitFor(() => expect(viewer().dataset.artifact).toBe(saved))
  await idle()
  return view
}
const select = (id: string) => act(() => handle.current?.selectArtifact(id))
function openFind(query: string) {
  fireEvent.keyDown(viewer(), { key: 'f', metaKey: true })
  const input = findInput()
  if (!input) throw new Error('find bar did not open')
  fireEvent.change(input, { target: { value: query } })
}
async function switchAwayAndBack(view: ReturnType<typeof render>, saved = 'a1') {
  view.rerender(<Tab mode="hidden" saved={saved} />)
  view.rerender(<Tab mode="visible" saved={saved} />)
  await idle({ mutations: false })
}

beforeEach(() => {
  server.rows = [row('a1'), row('a2', 'raw'), row('a3')]
  server.updateGate = null
  client = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: false } } })
})
afterEach(() => {
  cleanup()
  client.clear()
})

describe('ArtifactsPanel view state across a tab switch', () => {
  it('an open find bar keeps its query', async () => {
    const view = await mountLoaded()
    openFind('needle')
    expect(viewer().dataset.search).toBe('needle')

    await switchAwayAndBack(view)
    expect(findInput()?.value).toBe('needle')
    expect(viewer().dataset.search).toBe('needle')
  })

  it('the raw view and find bar opened from a search hit stay', async () => {
    const view = await mountLoaded()
    act(() => handle.current?.toggleSearch())
    fireEvent.click(screen.getByTestId('hit-a1'))
    await waitFor(() => expect(findInput()?.value).toBe('needle')) // opened 50 ms later
    expect(viewer().dataset.viewMode).toBe('raw')
    expect(findInput()?.value).toBe('needle')

    await switchAwayAndBack(view)
    expect(viewer().dataset.viewMode).toBe('raw')
    expect(findInput()?.value).toBe('needle')
  })

  it('a view mode picked while its save is still in flight stays', async () => {
    const view = await mountLoaded()
    let release = () => {}
    server.updateGate = new Promise<void>((r) => {
      release = r
    })
    fireEvent.click(screen.getByRole('button', { name: 'Split' }))
    expect(viewer().dataset.viewMode).toBe('split')

    await switchAwayAndBack(view)
    expect(viewer().dataset.viewMode).toBe('split')
    release()
    await idle()
    expect(viewer().dataset.viewMode).toBe('split')
  })
})

describe('ArtifactsPanel search hit in another artifact', () => {
  it("opens it in the raw view with the find bar on the hit's query", async () => {
    await mountLoaded()
    act(() => handle.current?.toggleSearch())
    fireEvent.click(screen.getByTestId('hit-a3'))
    await waitFor(() => expect(findInput()).not.toBeNull()) // opened 50 ms later
    expect(viewer().dataset.artifact).toBe('a3')
    expect(viewer().dataset.viewMode).toBe('raw')
    expect(findInput()?.value).toBe('needle')
    expect(viewer().dataset.search).toBe('needle')
  })
})

describe('ArtifactsPanel view state on a selection change (pins)', () => {
  it('resets to the newly selected artifact: its saved view mode, find bar closed', async () => {
    await mountLoaded()
    openFind('needle')

    select('a2')
    expect(viewer().dataset.artifact).toBe('a2')
    expect(viewer().dataset.viewMode).toBe('raw')
    expect(findInput()).toBeNull()
    expect(viewer().dataset.search).toBe('')

    // No saved mode: the appearance default ('rich' → preview).
    select('a1')
    expect(viewer().dataset.viewMode).toBe('preview')
  })

  it('a view mode picked in Display is saved per artifact and comes back on reselect', async () => {
    await mountLoaded()
    fireEvent.click(screen.getByRole('button', { name: 'Split' }))
    await idle()
    select('a2')
    expect(viewer().dataset.viewMode).toBe('raw')
    select('a1')
    expect(viewer().dataset.viewMode).toBe('split')
  })

  it('reselecting the same artifact keeps the view state', async () => {
    await mountLoaded()
    openFind('needle')
    select('a1')
    expect(findInput()?.value).toBe('needle')
  })
})

describe('ArtifactsPanel saved view mode of the artifact selected at mount', () => {
  it('with the artifacts already loaded (pin)', async () => {
    await client.prefetchQuery({
      queryKey: [['artifacts', 'getByTask'], { input: { taskId: 't1' }, type: 'query' }],
      queryFn: async () => server.rows.map((r) => ({ ...r }))
    })
    render(<Tab mode="visible" saved="a2" />)
    expect(viewer().dataset.viewMode).toBe('raw')
  })

  it('with the artifacts loading after mount: applied by the next tab show at the latest (pin)', async () => {
    const view = await mountLoaded('a2')
    await switchAwayAndBack(view, 'a2')
    expect(viewer().dataset.viewMode).toBe('raw')
  })

  it('with the artifacts loading after mount: applied as they arrive', async () => {
    await mountLoaded('a2')
    expect(viewer().dataset.viewMode).toBe('raw')
  })
})
