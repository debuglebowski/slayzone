// @vitest-environment jsdom
// Pins ProcessesPanel's list load: it loads for the current task/project, and a
// response for a previous task/project landing late never replaces the newer list.
// Task tabs live in <Activity>: re-showing a tab reloads the list again, but
// keeps the current one on screen while it does (no spinner). A failed load
// shows an error with Retry instead of spinning forever.
import { Activity } from 'react'
import type React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ProcessEntry } from './ProcessesPanel.types'

type Children = { children?: React.ReactNode }
vi.mock('@slayzone/ui', async (importOriginal) => ({
  Tooltip: ({ children }: Children) => <>{children}</>,
  TooltipTrigger: ({ children }: Children) => <>{children}</>,
  TooltipContent: () => null,
  useDepsChanged: (await importOriginal<typeof import('@slayzone/ui')>()).useDepsChanged,
  toast: { error: (message: string) => toastErrors.push(message) }
}))
let toastErrors: string[] = []

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

let listCalls: Array<{ input: unknown; d: Deferred<ProcessEntry[]> }> = []
// Every trpc.processes.<proc> exposes the option builders (mutations, subscriptions);
// a mutation's options carry its procedure name, so `useMutation` can route on it.
const trpc = {
  processes: new Proxy(
    {},
    {
      get: (_target, name) => ({
        mutationOptions: () => ({ name }),
        subscriptionOptions: () => ({})
      })
    }
  )
}
/** `mutateAsync` per procedure name (kill/stop/restart); unset ones resolve. */
let mutations: Record<string, (input: unknown) => Promise<unknown>> = {}
const trpcClient = {
  processes: {
    listForTask: {
      query: (input: unknown) => {
        const d = deferred<ProcessEntry[]>()
        listCalls.push({ input, d })
        return d.promise
      }
    }
  }
}
// The domain's typed view (`./trpc`) re-exports the runtime; point it at this mock.
vi.mock('./trpc', async () => await import('@slayzone/transport/client'))
vi.mock('@slayzone/transport/client', () => ({
  useTRPC: () => trpc,
  useTRPCClient: () => trpcClient,
  useSubscription: () => undefined
}))
vi.mock('@tanstack/react-query', () => ({
  useMutation: (opts: { name: string }) => ({
    mutateAsync: (input: unknown) => (mutations[opts.name] ?? (async () => undefined))(input)
  })
}))
// The dialog's two outcomes, as buttons: a save, and a spawn of process "new".
vi.mock('./ProcessDialog', () => ({
  ProcessDialog: ({
    onSaved,
    onSpawned
  }: {
    onSaved: () => void
    onSpawned: (id: string) => void
  }) => (
    <>
      <button type="button" onClick={onSaved}>
        dialog-saved
      </button>
      <button type="button" onClick={() => onSpawned('new')}>
        dialog-spawned
      </button>
    </>
  )
}))
vi.mock('./ProcessRow', () => ({
  ProcessRow: ({
    proc,
    expanded,
    onKill,
    onStop,
    onRestart
  }: {
    proc: ProcessEntry
    expanded: boolean
    onKill: () => void
    onStop: () => void
    onRestart: () => void
  }) => (
    <>
      <div data-testid="proc" data-expanded={String(expanded)}>
        {proc.label}
      </div>
      <button type="button" onClick={onKill}>{`kill-${proc.id}`}</button>
      <button type="button" onClick={onStop}>{`stop-${proc.id}`}</button>
      <button type="button" onClick={onRestart}>{`restart-${proc.id}`}</button>
    </>
  )
}))

const { ProcessesPanel } = await import('./ProcessesPanel')

const proc = (id: string, taskId: string, label: string): ProcessEntry => ({
  id,
  taskId,
  projectId: 'proj',
  label,
  command: 'run',
  cwd: '/repo',
  autoRestart: false,
  status: 'stopped',
  pid: null,
  exitCode: null,
  logBuffer: [],
  startedAt: '',
  restartCount: 0,
  spawnedAt: null,
  processTitle: null
})

beforeEach(() => {
  listCalls = []
  mutations = {}
  toastErrors = []
})
afterEach(cleanup)

const labels = () => screen.queryAllByTestId('proc').map((el) => el.textContent)

function TabPanel({
  mode,
  taskId = 't1'
}: {
  mode: 'visible' | 'hidden'
  taskId?: string
}): React.JSX.Element {
  return (
    <Activity mode={mode}>
      <ProcessesPanel taskId={taskId} projectId="proj" />
    </Activity>
  )
}

describe('ProcessesPanel list load', () => {
  it("a late response for the previous task never replaces the current task's list", async () => {
    const { rerender } = render(<ProcessesPanel taskId="t1" projectId="proj" />)
    rerender(<ProcessesPanel taskId="t2" projectId="proj" />)
    expect(listCalls.map((c) => c.input)).toEqual([
      { taskId: 't1', projectId: 'proj' },
      { taskId: 't2', projectId: 'proj' }
    ])

    await act(async () => listCalls[1].d.resolve([proc('b', 't2', 'Task two')]))
    expect(labels()).toEqual(['Task two'])

    // t1's response arrives after t2's: dropped.
    await act(async () => listCalls[0].d.resolve([proc('a', 't1', 'Task one')]))
    expect(labels()).toEqual(['Task two'])
  })

  it("an out-of-date response doesn't end the current load early", async () => {
    const { container, rerender } = render(<ProcessesPanel taskId="t1" projectId="proj" />)
    rerender(<ProcessesPanel taskId="t2" projectId="proj" />)
    const spinner = () => container.querySelector('.animate-spin')

    // t1 had no processes, but t2's list is still loading: keep the spinner.
    await act(async () => listCalls[0].d.resolve([]))
    expect(spinner()).not.toBeNull()
    expect(screen.queryByText('No processes')).toBeNull()

    await act(async () => listCalls[1].d.resolve([proc('b', 't2', 'Task two')]))
    expect(spinner()).toBeNull()
    expect(labels()).toEqual(['Task two'])
  })
})

describe('ProcessesPanel across a tab switch', () => {
  it('reloads the list when the tab is shown again', async () => {
    const { rerender } = render(<TabPanel mode="visible" />)
    await act(async () => listCalls[0].d.resolve([proc('a', 't1', 'One')]))
    expect(labels()).toEqual(['One'])

    rerender(<TabPanel mode="hidden" />)
    rerender(<TabPanel mode="visible" />)
    expect(listCalls).toHaveLength(2)
    expect(listCalls[1].input).toEqual({ taskId: 't1', projectId: 'proj' })

    await act(async () => listCalls[1].d.resolve([proc('a', 't1', 'One'), proc('b', 't1', 'Two')]))
    expect(labels()).toEqual(['One', 'Two'])
  })

  it('a load cut off by hiding the tab never ends the spinner; the reload on show does', async () => {
    const { container, rerender } = render(<TabPanel mode="visible" />)
    const spinner = () => container.querySelector('.animate-spin')
    rerender(<TabPanel mode="hidden" />)
    rerender(<TabPanel mode="visible" />)
    expect(listCalls).toHaveLength(2)

    await act(async () => listCalls[0].d.resolve([proc('a', 't1', 'Stale')]))
    expect(spinner()).not.toBeNull()
    expect(labels()).toEqual([])

    await act(async () => listCalls[1].d.resolve([proc('a', 't1', 'Fresh')]))
    expect(spinner()).toBeNull()
    expect(labels()).toEqual(['Fresh'])
  })

  it('keeps the list on screen while it reloads on show (no spinner)', async () => {
    const { container, rerender } = render(<TabPanel mode="visible" />)
    const spinner = () => container.querySelector('.animate-spin')
    await act(async () => listCalls[0].d.resolve([proc('a', 't1', 'One')]))

    rerender(<TabPanel mode="hidden" />)
    rerender(<TabPanel mode="visible" />)
    expect(listCalls).toHaveLength(2)
    expect(spinner()).toBeNull()
    expect(labels()).toEqual(['One'])
  })

  it('still shows the spinner when the task changes', async () => {
    const { container, rerender } = render(<TabPanel mode="visible" />)
    const spinner = () => container.querySelector('.animate-spin')
    await act(async () => listCalls[0].d.resolve([proc('a', 't1', 'One')]))
    expect(spinner()).toBeNull()

    rerender(<TabPanel mode="visible" taskId="t2" />)
    expect(spinner()).not.toBeNull()
    expect(labels()).toEqual([])
    await act(async () => listCalls[1].d.resolve([proc('b', 't2', 'Two')]))
    expect(spinner()).toBeNull()
    expect(labels()).toEqual(['Two'])
  })
})

// A failed load (hub briefly unreachable, server error) used to leave the spinner
// on forever: the list load had no `.catch`.
describe('ProcessesPanel when the list load fails', () => {
  const fail = (i: number) => act(async () => listCalls[i].d.reject(new Error('hub unreachable')))
  const errorShown = () => screen.queryByText("Couldn't load processes.") !== null
  const retry = () => fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

  it('a failed first load shows the error, not an endless spinner; Retry loads the list', async () => {
    const { container } = render(<TabPanel mode="visible" />)
    const spinner = () => container.querySelector('.animate-spin')
    await fail(0)
    expect(spinner()).toBeNull()
    expect(errorShown()).toBe(true)
    expect(screen.queryByText('No processes')).toBeNull()

    retry()
    expect(spinner()).not.toBeNull()
    expect(errorShown()).toBe(false)
    expect(listCalls).toHaveLength(2)
    expect(listCalls[1].input).toEqual({ taskId: 't1', projectId: 'proj' })
    await act(async () => listCalls[1].d.resolve([proc('a', 't1', 'One')]))
    expect(spinner()).toBeNull()
    expect(labels()).toEqual(['One'])
  })

  it('a failed Retry shows the error again', async () => {
    render(<TabPanel mode="visible" />)
    await fail(0)
    retry()
    await fail(1)
    expect(errorShown()).toBe(true)
  })

  it('the error clears when the tab is shown again and that reload succeeds', async () => {
    const { rerender } = render(<TabPanel mode="visible" />)
    await fail(0)
    expect(errorShown()).toBe(true)

    rerender(<TabPanel mode="hidden" />)
    rerender(<TabPanel mode="visible" />)
    await act(async () => listCalls[1].d.resolve([proc('a', 't1', 'One')]))
    expect(errorShown()).toBe(false)
    expect(labels()).toEqual(['One'])
  })

  it('a task change after a failed load shows the spinner, then its own list', async () => {
    const { container, rerender } = render(<TabPanel mode="visible" />)
    const spinner = () => container.querySelector('.animate-spin')
    await fail(0)

    rerender(<TabPanel mode="visible" taskId="t2" />)
    expect(errorShown()).toBe(false)
    expect(spinner()).not.toBeNull()
    await act(async () => listCalls[1].d.resolve([proc('b', 't2', 'Two')]))
    expect(labels()).toEqual(['Two'])
  })

  it("the previous task's failed load never lands on the new task", async () => {
    const { container, rerender } = render(<TabPanel mode="visible" />)
    const spinner = () => container.querySelector('.animate-spin')
    rerender(<TabPanel mode="visible" taskId="t2" />)

    // Before t2's list lands: the spinner stays.
    await fail(0)
    expect(errorShown()).toBe(false)
    expect(spinner()).not.toBeNull()

    await act(async () => listCalls[1].d.resolve([proc('b', 't2', 'Two')]))
    expect(labels()).toEqual(['Two'])
    expect(errorShown()).toBe(false)
  })

  it('a failed reload on tab show keeps the list on screen (no error, no spinner)', async () => {
    const { container, rerender } = render(<TabPanel mode="visible" />)
    const spinner = () => container.querySelector('.animate-spin')
    await act(async () => listCalls[0].d.resolve([proc('a', 't1', 'One')]))

    rerender(<TabPanel mode="hidden" />)
    rerender(<TabPanel mode="visible" />)
    await fail(1)
    expect(errorShown()).toBe(false)
    // Nor the error of a reload after a dialog save: none was asked.
    expect(screen.queryByTestId('processes-refresh-error')).toBeNull()
    expect(spinner()).toBeNull()
    expect(labels()).toEqual(['One'])
  })
})

// After the process dialog saves or spawns, the list reloads so the change shows.
// That reload used to be a separate, bare fetch: no `.catch` (a failure was an
// unhandled rejection and said nothing), and no stale guard (a reload for the previous
// task landed on the new one; an older load landing after it undid it). It now re-runs
// the list load above, with its guards.
describe('ProcessesPanel reload after the dialog saves or spawns', () => {
  const saved = () => fireEvent.click(screen.getByRole('button', { name: 'dialog-saved' }))
  const spawned = () => fireEvent.click(screen.getByRole('button', { name: 'dialog-spawned' }))
  const fail = (i: number) => act(async () => listCalls[i].d.reject(new Error('hub unreachable')))
  const loadErrorShown = () => screen.queryByText("Couldn't load processes.") !== null
  const refreshErrorShown = () => screen.queryByTestId('processes-refresh-error') !== null
  const retry = () => fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  const expanded = () =>
    screen.queryAllByTestId('proc').map((el) => [el.textContent, el.dataset.expanded])

  let unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }
  beforeEach(() => {
    unhandled = []
    process.on('unhandledRejection', onUnhandled)
  })
  afterEach(() => {
    process.off('unhandledRejection', onUnhandled)
  })
  // Node reports an unhandled rejection after the microtask queue drains.
  const unhandledRejections = async (): Promise<unknown[]> => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    return unhandled
  }

  /** Renders t1's tab with its list loaded. */
  async function loaded(list: ProcessEntry[]) {
    const view = render(<TabPanel mode="visible" />)
    await act(async () => listCalls[0].d.resolve(list))
    return view
  }

  // Pins (held on the old build too).
  it('a save reloads the list, keeping the current one on screen meanwhile', async () => {
    const { container } = await loaded([proc('a', 't1', 'One')])
    saved()
    expect(listCalls).toHaveLength(2)
    expect(listCalls[1].input).toEqual({ taskId: 't1', projectId: 'proj' })
    expect(container.querySelector('.animate-spin')).toBeNull()
    expect(labels()).toEqual(['One'])

    await act(async () => listCalls[1].d.resolve([proc('a', 't1', 'One'), proc('b', 't1', 'Two')]))
    expect(labels()).toEqual(['One', 'Two'])
  })

  it("a spawn reloads the list and expands the spawned process's log", async () => {
    await loaded([proc('a', 't1', 'One')])
    spawned()
    expect(listCalls).toHaveLength(2)
    await act(async () =>
      listCalls[1].d.resolve([proc('a', 't1', 'One'), proc('new', 't1', 'New')])
    )
    expect(expanded()).toEqual([
      ['One', 'false'],
      ['New', 'true']
    ])
  })

  // The bug.
  it('a failed reload keeps the list, says so with Retry, and throws nothing', async () => {
    const { container } = await loaded([proc('a', 't1', 'One')])
    saved()
    await fail(1)
    expect(await unhandledRejections()).toEqual([])
    expect(labels()).toEqual(['One'])
    expect(container.querySelector('.animate-spin')).toBeNull()
    expect(refreshErrorShown()).toBe(true)
    expect(screen.getByText("Couldn't refresh processes.")).toBeTruthy()
    expect(loadErrorShown()).toBe(false)

    retry()
    expect(refreshErrorShown()).toBe(false)
    expect(listCalls).toHaveLength(3)
    expect(listCalls[2].input).toEqual({ taskId: 't1', projectId: 'proj' })
    await act(async () => listCalls[2].d.resolve([proc('a', 't1', 'One'), proc('b', 't1', 'Two')]))
    expect(labels()).toEqual(['One', 'Two'])
    expect(refreshErrorShown()).toBe(false)
  })

  it('a failed reload after a spawn says so too', async () => {
    await loaded([])
    spawned()
    await fail(1)
    expect(await unhandledRejections()).toEqual([])
    expect(refreshErrorShown()).toBe(true)
  })

  it('a failed Retry of the reload says so again', async () => {
    await loaded([proc('a', 't1', 'One')])
    saved()
    await fail(1)
    retry()
    await fail(2)
    expect(await unhandledRejections()).toEqual([])
    expect(refreshErrorShown()).toBe(true)
    expect(labels()).toEqual(['One'])
  })

  it('the reload error clears when the tab is shown again and that reload succeeds', async () => {
    const { rerender } = await loaded([proc('a', 't1', 'One')])
    saved()
    await fail(1)
    expect(refreshErrorShown()).toBe(true)

    rerender(<TabPanel mode="hidden" />)
    rerender(<TabPanel mode="visible" />)
    await act(async () => listCalls[2].d.resolve([proc('a', 't1', 'One'), proc('b', 't1', 'Two')]))
    expect(refreshErrorShown()).toBe(false)
    expect(labels()).toEqual(['One', 'Two'])
  })

  it('the reload error does not follow to the next task', async () => {
    const { container, rerender } = await loaded([proc('a', 't1', 'One')])
    saved()
    await fail(1)
    expect(refreshErrorShown()).toBe(true)

    rerender(<TabPanel mode="visible" taskId="t2" />)
    expect(refreshErrorShown()).toBe(false)
    expect(container.querySelector('.animate-spin')).not.toBeNull()
    await act(async () => listCalls[2].d.resolve([proc('b', 't2', 'Two')]))
    expect(refreshErrorShown()).toBe(false)
    expect(labels()).toEqual(['Two'])
  })

  it("a reload for the previous task never lands on the new task's list", async () => {
    const { rerender } = await loaded([proc('a', 't1', 'One')])
    saved()
    rerender(<TabPanel mode="visible" taskId="t2" />)
    const t2Load = listCalls.findIndex((c) => (c.input as { taskId: string }).taskId === 't2')
    await act(async () => listCalls[t2Load].d.resolve([proc('b', 't2', 'Two')]))
    expect(labels()).toEqual(['Two'])

    // t1's reload answers after the switch: dropped.
    await act(async () =>
      listCalls[1].d.resolve([proc('a', 't1', 'One'), proc('c', 't1', 'Three')])
    )
    expect(labels()).toEqual(['Two'])
  })

  it("a failed reload for the previous task never lands on the new task's list", async () => {
    const { container, rerender } = await loaded([proc('a', 't1', 'One')])
    saved()
    rerender(<TabPanel mode="visible" taskId="t2" />)

    // t1's reload fails while t2's list is still loading: the spinner stays.
    await fail(1)
    expect(await unhandledRejections()).toEqual([])
    expect(container.querySelector('.animate-spin')).not.toBeNull()
    expect(loadErrorShown()).toBe(false)

    const t2Load = listCalls.findIndex((c) => (c.input as { taskId: string }).taskId === 't2')
    await act(async () => listCalls[t2Load].d.resolve([proc('b', 't2', 'Two')]))
    expect(refreshErrorShown()).toBe(false)
    expect(loadErrorShown()).toBe(false)
    expect(labels()).toEqual(['Two'])
  })

  it('an older load answering after the reload never undoes it', async () => {
    const { rerender } = await loaded([proc('a', 't1', 'One')])
    // A re-show reload is in flight (listCalls[1]) when the dialog saves.
    rerender(<TabPanel mode="hidden" />)
    rerender(<TabPanel mode="visible" />)
    saved()
    const last = listCalls.length - 1
    expect(last).toBeGreaterThan(1)
    await act(async () =>
      listCalls[last].d.resolve([proc('a', 't1', 'One'), proc('b', 't1', 'Two')])
    )
    expect(labels()).toEqual(['One', 'Two'])

    // The re-show reload was asked before the save: its answer is out of date.
    await act(async () => listCalls[1].d.resolve([proc('a', 't1', 'One')]))
    expect(labels()).toEqual(['One', 'Two'])
  })

  it("a save's reload answering after a later spawn's never undoes it", async () => {
    await loaded([proc('a', 't1', 'One')])
    saved()
    spawned()
    expect(listCalls).toHaveLength(3)
    await act(async () =>
      listCalls[2].d.resolve([
        proc('a', 't1', 'One'),
        proc('b', 't1', 'Two'),
        proc('new', 't1', 'New')
      ])
    )
    expect(labels()).toEqual(['One', 'Two', 'New'])

    await act(async () => listCalls[1].d.resolve([proc('a', 't1', 'One'), proc('b', 't1', 'Two')]))
    expect(labels()).toEqual(['One', 'Two', 'New'])
  })

  it('a reload after a failed first load shows the list instead of the error', async () => {
    render(<TabPanel mode="visible" />)
    await fail(0)
    expect(loadErrorShown()).toBe(true)

    saved()
    await act(async () => listCalls[1].d.resolve([proc('a', 't1', 'One')]))
    expect(loadErrorShown()).toBe(false)
    expect(labels()).toEqual(['One'])
  })

  it('a failed reload after a failed first load keeps the one load error (no second error)', async () => {
    render(<TabPanel mode="visible" />)
    await fail(0)
    saved()
    await fail(1)
    expect(await unhandledRejections()).toEqual([])
    expect(loadErrorShown()).toBe(true)
    expect(refreshErrorShown()).toBe(false)
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1)
  })
})

// Kill / Stop / Restart used to `await` the mutation with no `.catch`: a failure (the
// computer offline, the process already gone) was an unhandled rejection and the
// user saw nothing. A failed action now says so and leaves the list as it was.
describe('ProcessesPanel row actions', () => {
  const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }))

  let unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }
  beforeEach(() => {
    unhandled = []
    process.on('unhandledRejection', onUnhandled)
  })
  afterEach(() => {
    process.off('unhandledRejection', onUnhandled)
  })
  // Node reports an unhandled rejection after the microtask queue drains.
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

  async function loaded(list: ProcessEntry[]) {
    render(<ProcessesPanel taskId="t1" projectId="proj" />)
    await act(async () => listCalls[0].d.resolve(list))
  }

  it('a kill removes the process from the list', async () => {
    await loaded([proc('a', 't1', 'Dev server'), proc('b', 't1', 'Watcher')])
    click('kill-a')
    await settle()
    expect(labels()).toEqual(['Watcher'])
    expect(toastErrors).toEqual([])
  })

  for (const action of ['kill', 'stop', 'restart'] as const) {
    it(`a failed ${action} says so, keeps the list, and rejects nothing unhandled`, async () => {
      mutations[action] = async () => {
        throw new Error('computer offline')
      }
      await loaded([proc('a', 't1', 'Dev server')])
      click(`${action}-a`)
      await settle()
      expect(unhandled).toEqual([])
      expect(toastErrors).toEqual([`Couldn't ${action} Dev server: computer offline`])
      expect(labels()).toEqual(['Dev server'])
    })
  }
})
