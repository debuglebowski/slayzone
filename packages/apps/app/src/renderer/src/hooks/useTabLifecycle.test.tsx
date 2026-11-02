// @vitest-environment jsdom
// A task tab closes when its task is gone — never because the task's hub has not
// answered yet. With two hubs, each hub's task list arrives on its own: the one
// that answers first used to count as "everything loaded", closing every open tab
// of the other hub (2026-10-30: 43 tabs of the local hub, closed when a remote hub
// answered first after a slow boot).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { Task } from '@slayzone/task-contracts'
import type { Tab } from '@slayzone/tabs-state'

const { getTask, resolveHub } = vi.hoisted(() => ({
  getTask: vi.fn(),
  resolveHub: vi.fn()
}))
vi.mock('../trpc', () => ({
  getClientForHub: resolveHub
}))
const { recordTimeline } = vi.hoisted(() => ({ recordTimeline: vi.fn() }))
vi.mock('@/lib/diagnosticsClient', () => ({ recordDiagnosticsTimeline: recordTimeline }))
const recoveredTask = vi.fn()

vi.mock('@slayzone/telemetry/client', () => {
  const tracker = {
    track: vi.fn(),
    trackTask: vi.fn(),
    trackProject: vi.fn(),
    trackShortcut: vi.fn()
  }
  return { useTrack: () => tracker }
})

const { useTabStore } = await import('@slayzone/tabs-state')
const { useTabLifecycle } = await import('./useTabLifecycle')

type Props = Parameters<typeof useTabLifecycle>[0]

const LOCAL = 'local-hub'
const REMOTE = 'remote-hub'

const task = (id: string): Task => ({ id, title: id, status: 'todo', parent_id: null }) as Task

function taskTab(taskId: string, hubId?: string): Tab {
  return {
    type: 'task',
    taskId,
    title: taskId,
    ...(hubId ? { hubId } : {})
  } as Tab
}

const openTaskIds = (): string[] =>
  useTabStore
    .getState()
    .tabs.flatMap((t) => (t.type === 'task' ? [t.taskId] : []))
    .sort()

/** The hook, fed the board as it stands: which hubs answered, and their tasks. */
function render(initial: { tasks: Record<string, string[]>; loaded: string[] }) {
  const propsFor = (state: { tasks: Record<string, string[]>; loaded: string[] }): Props => {
    const hubIdByTask = new Map<string, string>()
    const tasks: Task[] = []
    for (const [hub, ids] of Object.entries(state.tasks)) {
      for (const id of ids) {
        tasks.push(task(id))
        hubIdByTask.set(id, hub)
      }
    }
    return {
      tasks,
      projects: [],
      tabs: useTabStore.getState().tabs,
      setTerminalFocusRequests: () => {},
      hubIdByProject: new Map(),
      hubIdByTask,
      defaultHubId: LOCAL,
      registeredHubIds: registered,
      loadedHubIds: new Set(state.loaded),
      onTaskRecovered: recoveredTask
    }
  }
  const view = renderHook((p: Props) => useTabLifecycle(p), {
    initialProps: propsFor(initial)
  })
  return { rerender: (next: typeof initial) => view.rerender(propsFor(next)) }
}

let registered: ReadonlySet<string>

beforeEach(() => {
  getTask.mockReset().mockResolvedValue(null)
  recordTimeline.mockReset()
  recoveredTask.mockReset()
  resolveHub.mockReset().mockReturnValue({ task: { get: { query: getTask } } })
  registered = new Set([LOCAL, REMOTE])
  useTabStore.setState({
    tabs: [{ type: 'home' }],
    activeTabIndex: 0,
    closedTabs: []
  })
})
afterEach(cleanup)

describe('useTabLifecycle — closing tabs of tasks that are gone', () => {
  it('keeps an existing task tab when an older board snapshot omits its row', async () => {
    useTabStore.setState({ tabs: [{ type: 'home' }, taskTab('r1', REMOTE)] })
    getTask.mockResolvedValue(task('r1'))

    const view = render({
      tasks: { [LOCAL]: [], [REMOTE]: [] },
      loaded: [LOCAL, REMOTE]
    })
    await waitFor(() => expect(getTask).toHaveBeenCalledWith({ id: 'r1' }))
    expect(resolveHub).toHaveBeenCalledWith(REMOTE)
    expect(openTaskIds()).toEqual(['r1'])
    expect(useTabStore.getState().closedTabs).toEqual([])
    expect(recoveredTask).toHaveBeenCalledWith(task('r1'))

    view.rerender({
      tasks: { [LOCAL]: [], [REMOTE]: ['r1'] },
      loaded: [LOCAL, REMOTE]
    })
    expect(openTaskIds()).toEqual(['r1'])
  })

  it('keeps a missing tab when its hub cannot confirm deletion', async () => {
    useTabStore.setState({ tabs: [{ type: 'home' }, taskTab('r1', REMOTE)] })
    getTask.mockRejectedValue(new Error('Connection closed'))

    render({ tasks: { [LOCAL]: [], [REMOTE]: [] }, loaded: [LOCAL, REMOTE] })
    await waitFor(() => expect(getTask).toHaveBeenCalled())
    expect(openTaskIds()).toEqual(['r1'])
  })

  it('waits for all hubs for a legacy tab and keeps it if any hub still has it', async () => {
    useTabStore.setState({ tabs: [{ type: 'home' }, taskTab('r1')] })
    getTask.mockRejectedValueOnce({ data: { code: 'NOT_FOUND' } }).mockResolvedValueOnce(task('r1'))

    render({ tasks: { [LOCAL]: [], [REMOTE]: [] }, loaded: [LOCAL, REMOTE] })
    await act(async () => {})
    expect(resolveHub.mock.calls).toEqual([[LOCAL], [REMOTE]])
    expect(openTaskIds()).toEqual(['r1'])
  })

  it.each([
    {
      row: { ...task('gone'), deleted_at: '2026-11-02 00:00:00' },
      error: null
    },
    { row: null, error: { data: { code: 'NOT_FOUND' } } }
  ])(
    'closes confirmed deleted tasks without switching a surviving active tab (%j)',
    async ({ row, error }) => {
      useTabStore.setState({
        tabs: [{ type: 'home' }, taskTab('gone', REMOTE), taskTab('l1', LOCAL)],
        activeTabIndex: 2
      })
      if (error) getTask.mockRejectedValue(error)
      else getTask.mockResolvedValue(row)

      render({
        tasks: { [LOCAL]: ['l1'], [REMOTE]: [] },
        loaded: [LOCAL, REMOTE]
      })
      await waitFor(() => expect(openTaskIds()).toEqual(['l1']))
      const state = useTabStore.getState()
      expect(state.tabs[state.activeTabIndex]).toMatchObject({ taskId: 'l1' })
    }
  )

  it('ignores a pending deletion check once the board has restored the row', async () => {
    let answer!: (value: null) => void
    getTask.mockReturnValue(
      new Promise<null>((resolve) => {
        answer = resolve
      })
    )
    useTabStore.setState({ tabs: [{ type: 'home' }, taskTab('r1', REMOTE)] })

    const view = render({
      tasks: { [LOCAL]: [], [REMOTE]: [] },
      loaded: [LOCAL, REMOTE]
    })
    view.rerender({
      tasks: { [LOCAL]: [], [REMOTE]: ['r1'] },
      loaded: [LOCAL, REMOTE]
    })
    await act(async () => {
      answer(null)
    })
    expect(openTaskIds()).toEqual(['r1'])
  })

  it('does not close a tab reopened while its previous instance was being checked', async () => {
    let answer!: (value: null) => void
    getTask.mockReturnValue(
      new Promise<null>((resolve) => {
        answer = resolve
      })
    )
    useTabStore.setState({ tabs: [{ type: 'home' }, taskTab('r1', REMOTE)] })

    render({ tasks: { [LOCAL]: [], [REMOTE]: [] }, loaded: [LOCAL, REMOTE] })
    act(() => {
      useTabStore.getState().closeTab(1)
      useTabStore.getState().openTask('r1')
    })
    await act(async () => {
      answer(null)
    })
    expect(openTaskIds()).toEqual(['r1'])
  })
  it('keeps the local tabs when the remote hub answers first (saved tabs, hub not recorded)', () => {
    useTabStore.setState({
      tabs: [{ type: 'home' }, taskTab('l1'), taskTab('l2'), taskTab('r1')]
    })

    const view = render({ tasks: { [REMOTE]: ['r1'] }, loaded: [REMOTE] })
    expect(openTaskIds()).toEqual(['l1', 'l2', 'r1'])

    view.rerender({
      tasks: { [REMOTE]: ['r1'], [LOCAL]: ['l1', 'l2'] },
      loaded: [REMOTE, LOCAL]
    })
    expect(openTaskIds()).toEqual(['l1', 'l2', 'r1'])
    expect(useTabStore.getState().closedTabs).toEqual([])
  })

  it('keeps the remote tabs when the local hub answers first', () => {
    useTabStore.setState({
      tabs: [{ type: 'home' }, taskTab('l1', LOCAL), taskTab('r1', REMOTE)]
    })

    render({ tasks: { [LOCAL]: ['l1'] }, loaded: [LOCAL] })
    expect(openTaskIds()).toEqual(['l1', 'r1'])
  })

  it('never closes the tabs of a hub that is offline', () => {
    useTabStore.setState({
      tabs: [{ type: 'home' }, taskTab('l1', LOCAL), taskTab('r1', REMOTE)]
    })

    const view = render({ tasks: { [LOCAL]: ['l1'] }, loaded: [LOCAL] })
    view.rerender({ tasks: { [LOCAL]: ['l1', 'l2'] }, loaded: [LOCAL] })
    expect(openTaskIds()).toEqual(['l1', 'r1'])
  })

  it('closes a tab once its own hub confirms the task is gone', async () => {
    useTabStore.setState({
      tabs: [{ type: 'home' }, taskTab('l1', LOCAL), taskTab('gone', LOCAL)]
    })

    render({ tasks: { [LOCAL]: ['l1'] }, loaded: [LOCAL] })
    await waitFor(() => expect(openTaskIds()).toEqual(['l1']))
    expect(useTabStore.getState().closedTabs.map((t) => t.taskId)).toEqual(['gone'])
  })

  it('closes a tab with no hub recorded once every hub confirms it is gone', async () => {
    useTabStore.setState({
      tabs: [{ type: 'home' }, taskTab('l1'), taskTab('gone')]
    })

    const view = render({ tasks: { [LOCAL]: ['l1'] }, loaded: [LOCAL] })
    expect(openTaskIds()).toEqual(['gone', 'l1'])

    view.rerender({
      tasks: { [LOCAL]: ['l1'], [REMOTE]: [] },
      loaded: [LOCAL, REMOTE]
    })
    await waitFor(() => expect(openTaskIds()).toEqual(['l1']))
  })

  it('keeps a tab tagged with the wrong hub when another hub still has the task', async () => {
    useTabStore.setState({ tabs: [{ type: 'home' }, taskTab('l1', REMOTE)] })
    const local = vi.fn().mockResolvedValue(task('l1'))
    const remote = vi.fn().mockRejectedValue({ data: { code: 'NOT_FOUND' } })
    resolveHub.mockImplementation((hubId: string) => ({
      task: { get: { query: hubId === LOCAL ? local : remote } }
    }))

    render({ tasks: { [LOCAL]: [], [REMOTE]: [] }, loaded: [LOCAL, REMOTE] })
    await waitFor(() => expect(recoveredTask).toHaveBeenCalledWith(task('l1')))
    expect(openTaskIds()).toEqual(['l1'])
    expect(useTabStore.getState().closedTabs).toEqual([])
  })

  it('closes the tabs of a hub that was removed', () => {
    useTabStore.setState({
      tabs: [{ type: 'home' }, taskTab('l1', LOCAL), taskTab('r1', REMOTE)]
    })
    registered = new Set([LOCAL])

    render({ tasks: { [LOCAL]: ['l1'] }, loaded: [LOCAL] })
    expect(openTaskIds()).toEqual(['l1'])
  })

  it('records which hub owns each open tab, so a later boot knows whom to wait for', () => {
    useTabStore.setState({
      tabs: [{ type: 'home' }, taskTab('l1'), taskTab('r1')]
    })

    render({
      tasks: { [LOCAL]: ['l1'], [REMOTE]: ['r1'] },
      loaded: [LOCAL, REMOTE]
    })

    const hubs = Object.fromEntries(
      useTabStore.getState().tabs.flatMap((t) => (t.type === 'task' ? [[t.taskId, t.hubId]] : []))
    )
    expect(hubs).toEqual({ l1: LOCAL, r1: REMOTE })
  })
})

// The 2026-10-31 wipe could not be explained afterwards: diagnostics recorded tab
// switches, not closes, and only the merged task count. Every automatic close and
// every sharp drop in one hub's task count is recorded now, with per-hub counts.
describe('useTabLifecycle — diagnostics', () => {
  it('records each automatic close with its reason and the hubs asked', async () => {
    useTabStore.setState({
      tabs: [{ type: 'home' }, taskTab('l1', LOCAL), taskTab('gone', LOCAL), taskTab('r1', REMOTE)]
    })
    registered = new Set([LOCAL])

    render({ tasks: { [LOCAL]: ['l1'] }, loaded: [LOCAL] })
    await waitFor(() => expect(openTaskIds()).toEqual(['l1']))
    expect(recordTimeline).toHaveBeenCalledWith('tab_auto_closed', {
      taskId: 'r1',
      hubId: REMOTE,
      reason: 'hub_removed'
    })
    expect(recordTimeline).toHaveBeenCalledWith('tab_auto_closed', {
      taskId: 'gone',
      hubId: LOCAL,
      reason: 'confirmed_gone',
      askedHubs: [LOCAL]
    })
  })

  it("records a sharp drop in a loaded hub's task count, with every hub's counts", () => {
    const many = Array.from({ length: 40 }, (_, i) => `l${i}`)
    const view = render({ tasks: { [LOCAL]: many, [REMOTE]: ['r1'] }, loaded: [LOCAL, REMOTE] })
    expect(recordTimeline).not.toHaveBeenCalledWith('task_list_shrank', expect.anything())

    view.rerender({ tasks: { [LOCAL]: [], [REMOTE]: ['r1'] }, loaded: [LOCAL, REMOTE] })
    expect(recordTimeline).toHaveBeenCalledWith('task_list_shrank', {
      before: { [LOCAL]: 40, [REMOTE]: 1 },
      after: { [LOCAL]: 0, [REMOTE]: 1 },
      loaded: [LOCAL, REMOTE],
      registered: [LOCAL, REMOTE]
    })
  })

  it('records a hub with many tasks dropping out of the answered hubs', () => {
    const many = Array.from({ length: 40 }, (_, i) => `l${i}`)
    const view = render({ tasks: { [LOCAL]: many, [REMOTE]: ['r1'] }, loaded: [LOCAL, REMOTE] })
    view.rerender({ tasks: { [REMOTE]: ['r1'] }, loaded: [REMOTE] })
    expect(recordTimeline).toHaveBeenCalledWith('task_list_shrank', {
      before: { [LOCAL]: 40, [REMOTE]: 1 },
      after: { [REMOTE]: 1 },
      loaded: [REMOTE],
      registered: [LOCAL, REMOTE]
    })
  })

  it('does not record small changes or a hub that has not answered', () => {
    const many = Array.from({ length: 40 }, (_, i) => `l${i}`)
    const view = render({ tasks: { [LOCAL]: many }, loaded: [LOCAL] })
    view.rerender({ tasks: { [LOCAL]: many.slice(5) }, loaded: [LOCAL] })
    view.rerender({ tasks: { [LOCAL]: many.slice(5), [REMOTE]: [] }, loaded: [LOCAL] })
    expect(recordTimeline).not.toHaveBeenCalledWith('task_list_shrank', expect.anything())
  })
})
