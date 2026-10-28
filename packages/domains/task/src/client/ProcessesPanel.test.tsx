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
  useDepsChanged: (await importOriginal<typeof import('@slayzone/ui')>()).useDepsChanged
}))

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
// Every trpc.processes.<proc> exposes the option builders (mutations, subscriptions).
const options = { mutationOptions: () => ({}), subscriptionOptions: () => ({}) }
const trpc = { processes: new Proxy({}, { get: () => options }) }
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
vi.mock('@slayzone/transport/client', () => ({
  useTRPC: () => trpc,
  useTRPCClient: () => trpcClient,
  useSubscription: () => undefined
}))
vi.mock('@tanstack/react-query', () => ({ useMutation: () => ({ mutateAsync: vi.fn() }) }))
vi.mock('./ProcessDialog', () => ({ ProcessDialog: () => null }))
vi.mock('./ProcessRow', () => ({
  ProcessRow: ({ proc }: { proc: ProcessEntry }) => <div data-testid="proc">{proc.label}</div>
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
    expect(spinner()).toBeNull()
    expect(labels()).toEqual(['One'])
  })
})
