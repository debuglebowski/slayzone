// @vitest-environment jsdom
// Pins usePanelOwnership's owner list: loaded per task, kept from the previous task until
// the next task's list lands, live-updated only for the current task, and cleared (with
// any late response dropped) once there is no task.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'

type Entry = { panelId: string; ownerWindowId: number }
type Pending = { taskId: string; resolve: (v: Entry[]) => void }
let pending: Pending[] = []
let onOwnershipChanged: ((p: { taskId: string; ownership: Entry[] }) => void) | null = null

const sub = (name: string) => ({
  subscriptionOptions: (_i: unknown, o: { onData: (p: never) => void }) => ({ name, ...o })
})
const trpc = {
  app: {
    taskWindows: {
      getWindowId: { queryOptions: () => ({}) },
      onOwnershipChanged: sub('changed'),
      onPanelsReleasedOnClose: sub('released')
    }
  }
}
const trpcClient = {
  app: {
    taskWindows: {
      getOwnership: {
        query: ({ taskId }: { taskId: string }) =>
          new Promise<Entry[]>((resolve) => pending.push({ taskId, resolve }))
      }
    }
  }
}
vi.mock('@slayzone/transport/client', () => ({
  useTRPC: () => trpc,
  useTRPCClient: () => trpcClient,
  useSubscription: (o: { name: string; onData: (p: never) => void }) => {
    if (o.name === 'changed') onOwnershipChanged = o.onData as typeof onOwnershipChanged
  }
}))
// This window is window 1.
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: 1 }) }))

const { usePanelOwnership } = await import('./usePanelOwnership')

beforeEach(() => {
  pending = []
  onOwnershipChanged = null
})
afterEach(cleanup)

function setup(taskId: string | undefined) {
  return renderHook((p: { taskId: string | undefined }) => usePanelOwnership(p.taskId), {
    initialProps: { taskId }
  })
}
const answer = (taskId: string, entries: Entry[]) =>
  act(async () => {
    pending.filter((p) => p.taskId === taskId).forEach((p) => p.resolve(entries))
  })
const OTHER: Entry[] = [{ panelId: 'terminal', ownerWindowId: 9 }]

describe('usePanelOwnership', () => {
  it('loads the owners for the task and clears them once there is no task', async () => {
    const { result, rerender } = setup('t1')
    await answer('t1', OTHER)
    expect(result.current.ownerOf('terminal')).toBe(9)
    expect(result.current.hasOtherOwner('terminal')).toBe(true)
    rerender({ taskId: undefined })
    expect(result.current.ownerOf('terminal')).toBe(null)
    expect(result.current.hasOtherOwner('terminal')).toBe(false)
  })

  it('drops a late response for the previous task once there is no task', async () => {
    const { result, rerender } = setup('t1')
    rerender({ taskId: undefined })
    await answer('t1', OTHER)
    expect(result.current.ownerOf('terminal')).toBe(null)
  })

  it("keeps the previous task's owners until the next task's list lands", async () => {
    const { result, rerender } = setup('t1')
    await answer('t1', OTHER)
    rerender({ taskId: 't2' })
    expect(result.current.ownerOf('terminal')).toBe(9)
    await answer('t2', [{ panelId: 'terminal', ownerWindowId: 1 }])
    expect(result.current.ownerOf('terminal')).toBe(1)
    expect(result.current.isOwnedByMe('terminal')).toBe(true)
    // A late answer for t1 is dropped.
    await answer('t1', OTHER)
    expect(result.current.ownerOf('terminal')).toBe(1)
  })

  it('applies live ownership changes for the current task only', async () => {
    const { result } = setup('t1')
    await answer('t1', [])
    act(() => onOwnershipChanged?.({ taskId: 't2', ownership: OTHER }))
    expect(result.current.ownerOf('terminal')).toBe(null)
    act(() => onOwnershipChanged?.({ taskId: 't1', ownership: OTHER }))
    expect(result.current.ownerOf('terminal')).toBe(9)
  })

  it('starts empty without a task', () => {
    const { result } = setup(undefined)
    expect(result.current.ownerOf('terminal')).toBe(null)
    expect(pending).toEqual([])
  })
})
