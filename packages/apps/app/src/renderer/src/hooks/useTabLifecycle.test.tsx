// @vitest-environment jsdom
// A task tab closes when its task is gone — never because the task's hub has not
// answered yet. With two hubs, each hub's task list arrives on its own: the one
// that answers first used to count as "everything loaded", closing every open tab
// of the other hub (2026-10-30: 43 tabs of the local hub, closed when a remote hub
// answered first after a slow boot).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import type { Task } from '@slayzone/task-contracts'
import type { Tab } from '@slayzone/tabs-state'

vi.mock('@slayzone/telemetry/client', () => ({ track: () => {} }))

const { useTabStore } = await import('@slayzone/tabs-state')
const { useTabLifecycle } = await import('./useTabLifecycle')

type Props = Parameters<typeof useTabLifecycle>[0]

const LOCAL = 'local-hub'
const REMOTE = 'remote-hub'

const task = (id: string): Task => ({ id, title: id, status: 'todo', parent_id: null }) as Task

function taskTab(taskId: string, hubId?: string): Tab {
  return { type: 'task', taskId, title: taskId, ...(hubId ? { hubId } : {}) } as Tab
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
      loadedHubIds: new Set(state.loaded)
    }
  }
  const view = renderHook((p: Props) => useTabLifecycle(p), { initialProps: propsFor(initial) })
  return { rerender: (next: typeof initial) => view.rerender(propsFor(next)) }
}

let registered: ReadonlySet<string>

beforeEach(() => {
  registered = new Set([LOCAL, REMOTE])
  useTabStore.setState({ tabs: [{ type: 'home' }], activeTabIndex: 0, closedTabs: [] })
})
afterEach(cleanup)

describe('useTabLifecycle — closing tabs of tasks that are gone', () => {
  it('keeps the local tabs when the remote hub answers first (saved tabs, hub not recorded)', () => {
    useTabStore.setState({ tabs: [{ type: 'home' }, taskTab('l1'), taskTab('l2'), taskTab('r1')] })

    const view = render({ tasks: { [REMOTE]: ['r1'] }, loaded: [REMOTE] })
    expect(openTaskIds()).toEqual(['l1', 'l2', 'r1'])

    view.rerender({ tasks: { [REMOTE]: ['r1'], [LOCAL]: ['l1', 'l2'] }, loaded: [REMOTE, LOCAL] })
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
    useTabStore.setState({ tabs: [{ type: 'home' }, taskTab('l1', LOCAL), taskTab('r1', REMOTE)] })

    const view = render({ tasks: { [LOCAL]: ['l1'] }, loaded: [LOCAL] })
    view.rerender({ tasks: { [LOCAL]: ['l1', 'l2'] }, loaded: [LOCAL] })
    expect(openTaskIds()).toEqual(['l1', 'r1'])
  })

  it('closes a tab once its own hub has answered without the task', () => {
    useTabStore.setState({ tabs: [{ type: 'home' }, taskTab('l1', LOCAL), taskTab('gone', LOCAL)] })

    render({ tasks: { [LOCAL]: ['l1'] }, loaded: [LOCAL] })
    expect(openTaskIds()).toEqual(['l1'])
    expect(useTabStore.getState().closedTabs.map((t) => t.taskId)).toEqual(['gone'])
  })

  it('closes a tab with no hub recorded once every hub has answered without it', () => {
    useTabStore.setState({ tabs: [{ type: 'home' }, taskTab('l1'), taskTab('gone')] })

    const view = render({ tasks: { [LOCAL]: ['l1'] }, loaded: [LOCAL] })
    expect(openTaskIds()).toEqual(['gone', 'l1'])

    view.rerender({ tasks: { [LOCAL]: ['l1'], [REMOTE]: [] }, loaded: [LOCAL, REMOTE] })
    expect(openTaskIds()).toEqual(['l1'])
  })

  it('closes the tabs of a hub that was removed', () => {
    useTabStore.setState({ tabs: [{ type: 'home' }, taskTab('l1', LOCAL), taskTab('r1', REMOTE)] })
    registered = new Set([LOCAL])

    render({ tasks: { [LOCAL]: ['l1'] }, loaded: [LOCAL] })
    expect(openTaskIds()).toEqual(['l1'])
  })

  it('records which hub owns each open tab, so a later boot knows whom to wait for', () => {
    useTabStore.setState({ tabs: [{ type: 'home' }, taskTab('l1'), taskTab('r1')] })

    render({ tasks: { [LOCAL]: ['l1'], [REMOTE]: ['r1'] }, loaded: [LOCAL, REMOTE] })

    const hubs = Object.fromEntries(
      useTabStore.getState().tabs.flatMap((t) => (t.type === 'task' ? [[t.taskId, t.hubId]] : []))
    )
    expect(hubs).toEqual({ l1: LOCAL, r1: REMOTE })
  })
})
