// @vitest-environment jsdom
import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// Two hubs: the default one ('local') and a remote one. Which hub the form talks to
// shows as the scope it renders in.
vi.mock('@slayzone/transport/client', () => ({
  useFederationOrNull: () => ({
    defaultHubId: 'local',
    hubs: [
      { id: 'local', label: 'This Mac' },
      { id: 'hub-2', label: 'Team hub' }
    ]
  }),
  HubScope: ({ hubId, children }: { hubId: string; children: React.ReactNode }) => (
    <div data-testid="hub-scope" data-hub={hubId}>
      {children}
    </div>
  )
}))
vi.mock('./trpc', () => ({
  useTRPC: () => ({
    computers: {
      list: { queryOptions: () => ({ queryKey: ['computers.list'], queryFn: async () => [] }) }
    },
    projects: { list: { queryFilter: () => ({ queryKey: ['projects.list'] }) } }
  }),
  useTRPCClient: () => ({})
}))
vi.mock('@slayzone/file-editor/client/WorkspaceDirPicker', () => ({
  WorkspaceDirPicker: () => null
}))

import { CreateProjectDialog } from './CreateProjectDialog'

const ui = (open: boolean, hubId?: string | null) => (
  <QueryClientProvider client={new QueryClient()}>
    <CreateProjectDialog
      open={open}
      hubId={hubId}
      onOpenChange={() => undefined}
      onCreated={() => undefined}
    />
  </QueryClientProvider>
)

afterEach(cleanup)

describe('CreateProjectDialog hub', () => {
  it('opens on the default hub when none is asked for', () => {
    render(ui(true))
    expect(screen.queryByTestId('hub-scope')).toBeNull()
  })

  it('opens on the hub it was opened for (a hub’s Settings → Projects)', () => {
    render(ui(true, 'hub-2'))
    expect(screen.getByTestId('hub-scope').dataset.hub).toBe('hub-2')
  })

  it('each open starts on the hub it was opened for', () => {
    const { rerender } = render(ui(true, 'hub-2'))
    rerender(ui(false, null))
    rerender(ui(true, null))
    expect(screen.queryByTestId('hub-scope')).toBeNull()
    rerender(ui(false, null))
    rerender(ui(true, 'hub-2'))
    expect(screen.getByTestId('hub-scope').dataset.hub).toBe('hub-2')
  })
})
