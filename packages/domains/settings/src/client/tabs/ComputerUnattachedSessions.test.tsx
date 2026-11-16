// @vitest-environment jsdom
import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

interface UnattachedSession {
  computerId: string
  sessionId: string
  taskId: string | null
  tabId: string | null
  spawnId?: string
  pid?: number
  detection: boolean
  mode?: string
  startedAt?: number
  status: 'adopting' | 'unattached'
  reason?: string
  detail?: string
}

const attachSpy = vi.fn(async (_input: unknown) => ({ ok: true }))
const killSpy = vi.fn(async (_input: unknown) => ({ ok: true }))
let sessions: UnattachedSession[] = []

vi.mock('../trpc', () => ({
  useTRPC: () => ({
    pty: {
      unattachedList: {
        queryOptions: () => ({ queryKey: ['unattachedList'], queryFn: async () => sessions }),
        queryKey: () => ['unattachedList'],
        queryFilter: () => ({ queryKey: ['unattachedList'] })
      },
      onUnattachedChange: { subscriptionOptions: () => ({}) },
      unattachedAttach: { mutationOptions: () => ({ mutationFn: attachSpy }) },
      unattachedKill: { mutationOptions: () => ({ mutationFn: killSpy }) }
    }
  })
}))
vi.mock('@slayzone/transport/client', async (load) => ({
  ...(await load<typeof import('@slayzone/transport/client')>()),
  useSubscription: () => undefined
}))
vi.mock('@slayzone/ui', async (load) => ({
  ...(await load<typeof import('@slayzone/ui')>()),
  toast: { success: () => undefined, error: () => undefined }
}))

import { ComputerUnattachedSessions } from './ComputerUnattachedSessions'

afterEach(() => {
  cleanup()
  attachSpy.mockClear()
  killSpy.mockClear()
})

const session = (over: Partial<UnattachedSession>): UnattachedSession => ({
  computerId: 'pc',
  sessionId: 'task-1:tab-1',
  taskId: 'task-1',
  tabId: 'tab-1',
  spawnId: 'run-1',
  pid: 4242,
  detection: true,
  mode: 'codex',
  startedAt: Date.now() - 2 * 3_600_000,
  status: 'unattached',
  reason: 'mode-mismatch',
  ...over
})

function renderIt() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ComputerUnattachedSessions computerId="pc" />
    </QueryClientProvider>
  )
}

it('renders nothing when every session is attached', async () => {
  sessions = [session({ computerId: 'other' })]
  const { container } = renderIt()
  await new Promise((r) => setTimeout(r, 20))
  expect(container.textContent).toBe('')
})

it("lists this computer's unattached sessions; Attach at once, Stop only after confirming", async () => {
  sessions = [
    session({}),
    session({ sessionId: 'task-2:tab-2', taskId: 'task-2', reason: 'launch-unresolved' }),
    session({ sessionId: 'elsewhere:x', computerId: 'other' })
  ]
  renderIt()
  fireEvent.click(await screen.findByTestId('computer-unattached-toggle'))
  expect(screen.getByText('Running, not attached (2)')).toBeTruthy()
  expect(screen.getAllByTestId('computer-unattached-session')).toHaveLength(2)
  expect(screen.getByText(/runs another agent/)).toBeTruthy()

  // Attach is offered only where trying again can help.
  const attach = screen.getAllByTestId('computer-unattached-attach')
  expect(attach).toHaveLength(1)
  fireEvent.click(attach[0]!)
  await waitFor(() => expect(attachSpy).toHaveBeenCalledOnce())
  expect(attachSpy.mock.calls[0]![0]).toEqual({ computerId: 'pc', sessionId: 'task-2:tab-2' })

  fireEvent.click(screen.getAllByTestId('computer-unattached-stop')[0]!)
  expect(killSpy).not.toHaveBeenCalled()
  fireEvent.click(await screen.findByTestId('computer-unattached-stop-confirm'))
  await waitFor(() => expect(killSpy).toHaveBeenCalledOnce())
  expect(killSpy.mock.calls[0]![0]).toEqual({ computerId: 'pc', sessionId: 'task-1:tab-1' })
})
