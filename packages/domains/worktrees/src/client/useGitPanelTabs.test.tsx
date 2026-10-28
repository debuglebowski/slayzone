// @vitest-environment jsdom
// Pins useGitPanelTabs: which git tab the panel shows, and which tab changes reach
// the parent's onTabChange (TaskDetailPage saves each one to the task as
// git_active_tab; Home keeps it in its panel state). Task tabs live in <Activity>:
// hiding one unmounts its effects, showing it again re-runs them.
import { Activity, createRef, type RefObject } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { GitTabId, Task } from '@slayzone/task/shared'
import type { UnifiedGitPanelHandle } from './UnifiedGitPanel.types'

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

// What each procedure answers. A promise holds the query loading until it settles.
let answers: Record<string, (input: { key?: string }) => unknown>
const defaultAnswers = (): typeof answers => ({
  'settings.get': () => null,
  'worktrees.hasGithubRemote': () => false,
  'worktrees.getCurrentBranch': () => 'feature',
  'worktrees.getPrForCheckout': () => null
})
const query = (name: string) => ({
  queryOptions: (input: { key?: string }, opts?: object) => ({
    queryKey: [name, input],
    queryFn: async () => answers[name](input),
    ...opts
  })
})
// One object for every render: the hook's query refetchers and callbacks stay stable.
const trpc = {
  settings: { get: query('settings.get') },
  worktrees: {
    hasGithubRemote: query('worktrees.hasGithubRemote'),
    getCurrentBranch: query('worktrees.getCurrentBranch'),
    getPrForCheckout: query('worktrees.getPrForCheckout')
  }
}
vi.mock('@slayzone/transport/client', () => ({ useTRPC: () => trpc }))

const { useGitPanelTabs } = await import('./useGitPanelTabs')

const makeTask = (patch: Partial<Task> = {}): Task =>
  ({
    id: 't1',
    project_id: 'p1',
    title: 'Task',
    worktree_path: '/wt',
    base_dir: null,
    pr_url: null,
    merge_state: null,
    ...patch
  }) as unknown as Task

let latest: ReturnType<typeof useGitPanelTabs>

type ProbeProps = {
  panelRef: RefObject<UnifiedGitPanelHandle | null>
  task: Task | null
  defaultTab: GitTabId
  onTabChange: (tab: GitTabId) => void
  projectPath: string | null
}
function Probe({ panelRef, task, defaultTab, onTabChange, projectPath }: ProbeProps) {
  latest = useGitPanelTabs(panelRef, { task, defaultTab, onTabChange, projectPath, visible: true })
  return null
}

type PanelState = {
  mode: 'visible' | 'hidden'
  task: Task | null
  defaultTab: GitTabId
  projectPath: string | null
  onTabChange: (tab: GitTabId) => void
}

/** Mounts the hook the way the task page does (inside <Activity>); `update` re-renders. */
function mount(initial: Partial<PanelState> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const saves: GitTabId[] = []
  const panelRef = createRef<UnifiedGitPanelHandle>()
  let state: PanelState = {
    mode: 'visible',
    task: null,
    defaultTab: 'general',
    projectPath: '/repo',
    onTabChange: (tab) => {
      saves.push(tab)
    },
    ...initial
  }
  const element = () => (
    <QueryClientProvider client={client}>
      <Activity mode={state.mode}>
        <Probe
          panelRef={panelRef}
          task={state.task}
          defaultTab={state.defaultTab}
          onTabChange={state.onTabChange}
          projectPath={state.projectPath}
        />
      </Activity>
    </QueryClientProvider>
  )
  const view = render(element())
  const update = (patch: Partial<PanelState>) => {
    state = { ...state, ...patch }
    view.rerender(element())
  }
  /** Hide the task tab, then show it again. */
  const reshow = () => {
    update({ mode: 'hidden' })
    update({ mode: 'visible' })
  }
  /** Every query answered and rendered. */
  const settled = () => waitFor(() => expect(client.isFetching()).toBe(0))
  return { saves, panelRef, update, reshow, settled }
}

/** A tab-bar click. */
const select = (tab: GitTabId) => act(() => latest.setActiveTab(tab))

beforeEach(() => {
  answers = defaultAnswers()
})
afterEach(() => {
  cleanup()
})

describe('merge auto-switch', () => {
  it.each(['conflicts', 'rebase-conflicts'] as const)(
    'opens on Conflicts when mounted during a merge with %s, and saves it',
    async (mergeState) => {
      const p = mount({ task: makeTask({ merge_state: mergeState }) })
      await p.settled()
      expect(latest.activeTab).toBe('conflicts')
      expect(p.saves).toEqual(['conflicts'])
    }
  )

  it('opens on Changes when mounted during an uncommitted merge, and saves it', async () => {
    const p = mount({ task: makeTask({ merge_state: 'uncommitted' }) })
    await p.settled()
    expect(latest.activeTab).toBe('changes')
    expect(p.saves).toEqual(['changes'])
  })

  it('switches to Conflicts when conflicts start, and saves it once', async () => {
    const p = mount({ task: makeTask(), defaultTab: 'stash' })
    await p.settled()
    expect(latest.activeTab).toBe('stash')
    p.update({ task: makeTask({ merge_state: 'conflicts' }) })
    await p.settled()
    expect(latest.activeTab).toBe('conflicts')
    expect(p.saves).toEqual(['conflicts'])
  })

  it('switches to Changes when an uncommitted merge starts, and saves it once', async () => {
    const p = mount({ task: makeTask(), defaultTab: 'stash' })
    await p.settled()
    p.update({ task: makeTask({ merge_state: 'uncommitted' }) })
    await p.settled()
    expect(latest.activeTab).toBe('changes')
    expect(p.saves).toEqual(['changes'])
  })

  it("keeps the user's tab while the merge state lasts", async () => {
    const p = mount({ task: makeTask({ merge_state: 'conflicts' }) })
    await p.settled()
    select('changes')
    // A task update that leaves the merge state as it was.
    p.update({ task: makeTask({ merge_state: 'conflicts', title: 'Renamed' }) })
    await p.settled()
    expect(latest.activeTab).toBe('changes')
    expect(p.saves).toEqual(['conflicts', 'changes'])
  })

  it('a new onTabChange identity re-saves nothing', async () => {
    const p = mount({ task: makeTask({ merge_state: 'conflicts' }) })
    await p.settled()
    const saves2: GitTabId[] = []
    p.update({ onTabChange: (tab) => saves2.push(tab) })
    await p.settled()
    expect(p.saves).toEqual(['conflicts'])
    expect(saves2).toEqual([])
  })

  // Bug: the switch ran in an effect, which <Activity> re-runs on every show.
  it("re-showing the task tab keeps the user's tab over Conflicts, and saves nothing", async () => {
    const p = mount({ task: makeTask({ merge_state: 'conflicts' }) })
    await p.settled()
    select('changes')
    p.reshow()
    await p.settled()
    expect(latest.activeTab).toBe('changes')
    expect(p.saves).toEqual(['conflicts', 'changes'])
  })

  it("re-showing the task tab keeps the user's tab over Changes, and saves nothing", async () => {
    const p = mount({ task: makeTask({ merge_state: 'uncommitted' }) })
    await p.settled()
    select('general')
    p.reshow()
    await p.settled()
    expect(latest.activeTab).toBe('general')
    expect(p.saves).toEqual(['changes', 'general'])
  })
})

describe('saved tab', () => {
  it('opens on the saved tab (defaultTab) without saving it again', async () => {
    const p = mount({ task: makeTask(), defaultTab: 'stash' })
    await p.settled()
    expect(latest.activeTab).toBe('stash')
    expect(p.saves).toEqual([])
  })

  it('a click and switchToTab each save their tab once; getActiveTab reports it', async () => {
    const p = mount({ task: makeTask() })
    await p.settled()
    select('stash')
    await p.settled()
    expect(p.saves).toEqual(['stash'])
    expect(p.panelRef.current?.getActiveTab()).toBe('stash')
    act(() => p.panelRef.current?.switchToTab('changes'))
    await p.settled()
    expect(latest.activeTab).toBe('changes')
    expect(p.panelRef.current?.getActiveTab()).toBe('changes')
    expect(p.saves).toEqual(['stash', 'changes'])
  })
})
