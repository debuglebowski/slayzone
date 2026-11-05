// @vitest-environment jsdom
// Opening a task clears its unread flag on the hub that OWNS the task. A task on a
// federated (remote) hub must not have its clear sent to the default hub — that
// write no-ops there and the dot never goes away.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { Task } from '@slayzone/task-contracts'

const defaultMutate = vi.fn(async () => undefined)
const remoteMutate = vi.fn(async () => undefined)
const defaultClient = {
  task: { update: { mutate: defaultMutate } },
  app: {
    taskWindows: { setPrimaryActive: { mutate: vi.fn(async () => undefined) } },
  },
}
const remoteClient = { task: { update: { mutate: remoteMutate } } }

vi.mock('../trpc', () => ({
  useTRPCClient: () => defaultClient,
  getClientForHub: (hubId: string | undefined, fallback: unknown) =>
    hubId === 'hub-remote' ? remoteClient : fallback,
}))
vi.mock('@/hooks/useDiagnosticsSync', () => ({
  useDiagnosticsSync: () => undefined,
}))
vi.mock('@/hooks/useTabLifecycle', () => ({
  useTabPageViews: () => undefined,
}))

const { useTabStore } = await import('@slayzone/tabs-state')
const { useHubOwnershipStore } = await import('@slayzone/transport/client')
const { ActiveTabSync } = await import('./ActiveTabSync')

function renderFor(taskId: string): void {
  const tabs = [
    { type: 'home' },
    { type: 'task', taskId, title: 't' },
  ] as never
  useTabStore.setState({ activeTabIndex: 1 })
  const task = { id: taskId, needs_attention: true, project_id: 'p1' } as Task
  render(
    <ActiveTabSync
      tabs={tabs}
      tasksMap={new Map([[taskId, task]])}
      selectedProjectId='p1'
      activeView='tabs'
      projects={[]}
      taskCount={1}
      displayTaskCount={1}
      selectedProjectPathMissing={null}
    />,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ActiveTabSync read-clear', () => {
  it('clears a remote-hub task on its own hub', () => {
    useHubOwnershipStore.getState().noteTaskHub('t-remote', 'hub-remote')
    renderFor('t-remote')
    expect(remoteMutate).toHaveBeenCalledWith({
      id: 't-remote',
      needsAttention: false,
    })
    expect(defaultMutate).not.toHaveBeenCalled()
  })

  it('clears a default-hub task on the default hub', () => {
    renderFor('t-local')
    expect(defaultMutate).toHaveBeenCalledWith({
      id: 't-local',
      needsAttention: false,
    })
    expect(remoteMutate).not.toHaveBeenCalled()
  })
})
