// @vitest-environment jsdom
import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ItemFaultView } from '@slayzone/computers/shared'

const retrySpy = vi.fn(async (_ref: unknown) => ({ ok: true }))
const discardSpy = vi.fn(async (_ref: unknown) => ({ ok: true }))
let faults: ItemFaultView[] = []

vi.mock('../trpc', () => ({
  useTRPC: () => ({
    computers: {
      listFaults: {
        queryOptions: (input: { computerId: string | null }) => ({
          queryKey: ['listFaults', input.computerId],
          queryFn: async () => faults
        }),
        queryFilter: () => ({ queryKey: ['listFaults'] })
      },
      faultedTasks: { queryFilter: () => ({ queryKey: ['faultedTasks'] }) },
      retryFault: { mutationOptions: () => ({ mutationFn: retrySpy }) },
      discardFault: { mutationOptions: () => ({ mutationFn: discardSpy }) }
    }
  })
}))
vi.mock('@slayzone/ui', async (load) => ({
  ...(await load<typeof import('@slayzone/ui')>()),
  toast: { success: () => undefined, error: () => undefined }
}))

import { ComputerFaults } from './ComputerFaults'

afterEach(() => {
  cleanup()
  retrySpy.mockClear()
  discardSpy.mockClear()
})

const fault = (over: Partial<ItemFaultView>): ItemFaultView => ({
  computerId: 'pc',
  origin: 'computer',
  source: 'quarantine',
  pass: 'chat-archive',
  key: 'store:abc',
  taskId: 'task-1234567890',
  kind: 'structural',
  message: 'manifest torn',
  attempts: 1,
  firstAt: 0,
  lastAt: 0,
  retryable: false,
  discardable: true,
  ...over
})

function renderFaults() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ComputerFaults computerId="pc" />
    </QueryClientProvider>
  )
}

it('renders nothing when nothing needs attention', async () => {
  faults = []
  const { container } = renderFaults()
  await new Promise((r) => setTimeout(r, 20))
  expect(container.textContent).toBe('')
})

it('lists faults; Retry runs at once, Discard deletes only after confirmation', async () => {
  faults = [
    fault({}),
    fault({
      source: 'ledger',
      pass: 'computer.chat-retention',
      key: 'c1',
      retryable: true,
      discardable: false
    })
  ]
  renderFaults()
  fireEvent.click(await screen.findByTestId('computer-faults-toggle'))
  expect(screen.getByText('Needs attention (2)')).toBeTruthy()
  expect(screen.getByText('Restored chat archive cannot be read')).toBeTruthy()

  fireEvent.click(screen.getByTestId('computer-fault-retry'))
  await waitFor(() => expect(retrySpy).toHaveBeenCalledOnce())
  expect(retrySpy.mock.calls[0][0]).toEqual({
    computerId: 'pc',
    origin: 'computer',
    source: 'ledger',
    pass: 'computer.chat-retention',
    key: 'c1'
  })

  fireEvent.click(screen.getByTestId('computer-fault-discard'))
  expect(discardSpy).not.toHaveBeenCalled()
  fireEvent.click(await screen.findByTestId('computer-fault-discard-confirm'))
  await waitFor(() => expect(discardSpy).toHaveBeenCalledOnce())
  expect(discardSpy.mock.calls[0][0]).toMatchObject({ source: 'quarantine', key: 'store:abc' })
})
