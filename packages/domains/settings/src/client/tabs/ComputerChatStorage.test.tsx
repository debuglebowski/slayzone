// @vitest-environment jsdom
import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type {
  ComputerChatStorageState,
  ComputerChatStorageStatus
} from '@slayzone/terminal-contracts'

const compactSpy = vi.fn(async (_input: { computerId: string }) => ({}))
const cancelSpy = vi.fn(async (_input: { computerId: string }) => null)
let status: ComputerChatStorageStatus = { supported: false }

vi.mock('../trpc', () => ({
  useTRPC: () => ({
    chat: {
      storage: {
        status: {
          queryOptions: (input: { computerId: string }, opts: object = {}) => ({
            ...opts,
            queryKey: ['storageStatus', input.computerId],
            queryFn: async () => status
          }),
          queryFilter: () => ({ queryKey: ['storageStatus'] })
        },
        compact: { mutationOptions: () => ({ mutationFn: compactSpy }) },
        cancel: { mutationOptions: () => ({ mutationFn: cancelSpy }) }
      }
    }
  })
}))
vi.mock('@slayzone/ui', async (load) => ({
  ...(await load<typeof import('@slayzone/ui')>()),
  toast: { success: () => undefined, error: () => undefined }
}))

import { ComputerChatStorage } from './ComputerChatStorage'

afterEach(() => {
  cleanup()
  compactSpy.mockClear()
  cancelSpy.mockClear()
})

const GB = 1024 ** 3
const state = (over: Partial<ComputerChatStorageState>): ComputerChatStorageState => ({
  supported: true,
  fileBytes: 5.6 * GB,
  walBytes: 0,
  liveBytes: 0.6 * GB,
  reclaimableBytes: 5 * GB,
  autoVacuum: 'none',
  worthIt: true,
  backfillDone: true,
  freeDiskBytes: 100 * GB,
  requiredDiskBytes: 1.7 * GB,
  job: null,
  last: null,
  ...over
})
function renderStorage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ComputerChatStorage computerId="pc" />
    </QueryClientProvider>
  )
}

it('an older computer: asks to update it, offers nothing', async () => {
  status = { supported: false }
  renderStorage()
  expect(await screen.findByText(/update this computer/i)).toBeTruthy()
  expect(screen.queryByRole('button', { name: /reclaim/i })).toBeNull()
})

it('shows the sizes; offers nothing when not worth it', async () => {
  status = state({ worthIt: false, reclaimableBytes: 20 * 1024 * 1024, fileBytes: 0.7 * GB })
  renderStorage()
  expect(await screen.findByText(/nothing worth reclaiming/i)).toBeTruthy()
  expect(screen.getByText(/700\.0 MB|716\.8 MB|0\.70 GB/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: /reclaim/i })).toBeNull()
})

it('offers the reclaimable size and starts a compaction', async () => {
  status = state({})
  renderStorage()
  const button = await screen.findByRole('button', { name: /reclaim 5\.0 GB/i })
  fireEvent.click(button)
  await waitFor(() => expect(compactSpy).toHaveBeenCalled())
  expect(compactSpy.mock.calls[0][0]).toEqual({ computerId: 'pc' })
})

it('waits for the image backfill before a rebuild', async () => {
  status = state({ backfillDone: false })
  renderStorage()
  expect(await screen.findByText(/backfill/i)).toBeTruthy()
  expect((screen.getByRole('button', { name: /reclaim/i }) as HTMLButtonElement).disabled).toBe(
    true
  )
})

it('refuses up front when the disk is short', async () => {
  status = state({ freeDiskBytes: 1 * GB })
  renderStorage()
  expect(await screen.findByText(/needs 1\.7 GB free/i)).toBeTruthy()
  expect((screen.getByRole('button', { name: /reclaim/i }) as HTMLButtonElement).disabled).toBe(
    true
  )
})

it('a running job shows its phase and progress and can be cancelled', async () => {
  status = state({
    job: {
      id: 'j',
      kind: 'rebuild',
      automatic: false,
      phase: 'copying',
      startedAt: 0,
      progress: 0.42,
      message: null,
      result: null
    }
  })
  renderStorage()
  const bar = await screen.findByRole('progressbar')
  expect(bar.getAttribute('aria-valuenow')).toBe('42')
  expect(screen.getByText(/copying/i)).toBeTruthy()
  expect(screen.queryByRole('button', { name: /reclaim/i })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
  await waitFor(() => expect(cancelSpy).toHaveBeenCalled())
})

it('shows a finished result and a failure reason', async () => {
  status = state({
    worthIt: false,
    reclaimableBytes: 0,
    fileBytes: 0.7 * GB,
    autoVacuum: 'incremental',
    job: {
      id: 'j',
      kind: 'rebuild',
      automatic: false,
      phase: 'done',
      startedAt: 0,
      progress: 1,
      message: null,
      result: {
        at: 0,
        kind: 'rebuild',
        beforeBytes: 5.6 * GB,
        afterBytes: 0.7 * GB,
        reclaimedBytes: 4.9 * GB,
        durationMs: 60_000,
        holdMs: 180
      }
    }
  })
  renderStorage()
  expect(await screen.findByText(/reclaimed 4\.9 GB/i)).toBeTruthy()
  cleanup()
  status = state({
    job: {
      id: 'j',
      kind: 'rebuild',
      automatic: false,
      phase: 'failed',
      startedAt: 0,
      progress: 0.9,
      message: 'The computer is too busy writing chat history; try again later',
      result: null
    }
  })
  renderStorage()
  expect(await screen.findByText(/too busy/i)).toBeTruthy()
})
