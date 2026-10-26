// @vitest-environment jsdom
import type React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { Project } from '@slayzone/projects/shared'

// Per-project, per-provider mapping the lock check reads.
let mappings: Record<string, { status_setup_complete?: boolean } | null> = {}
let fetchFails = false
let isPlaywright = false
const fetchQuery = vi.fn((opts: { input: { projectId: string; provider: string } }) =>
  fetchFails
    ? Promise.reject(new Error('offline'))
    : Promise.resolve(mappings[`${opts.input.projectId}:${opts.input.provider}`] ?? null)
)

// Like the real hooks (context values), both return the SAME object every render.
vi.mock('@slayzone/transport/client', () => {
  const trpc = {
    integrations: {
      getProjectMapping: { queryOptions: (input: unknown) => ({ input }) }
    }
  }
  return {
    electronBootstrap: { isPlaywright: () => isPlaywright },
    useTRPC: () => trpc
  }
})

vi.mock('@tanstack/react-query', () => {
  const queryClient = {
    fetchQuery: (opts: { input: { projectId: string; provider: string } }) => fetchQuery(opts)
  }
  return { useQueryClient: () => queryClient }
})

type Kids = { children?: React.ReactNode }
vi.mock('@slayzone/ui', () => ({
  Dialog: ({ open, children }: Kids & { open: boolean }) => (open ? <>{children}</> : null),
  DialogContent: ({ children }: Kids) => <>{children}</>,
  DialogHeader: ({ children }: Kids) => <>{children}</>,
  DialogTitle: ({ children }: Kids) => <>{children}</>,
  SettingsLayout: ({ children }: Kids) => <>{children}</>
}))

vi.mock('@slayzone/telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./useDetectedRepos', () => ({ useDetectedRepos: () => [] }))
vi.mock('./ColumnsTab', () => ({
  ColumnsTab: ({ lockedByProvider }: { lockedByProvider: string | null }) => (
    <div data-testid="columns-lock">{lockedByProvider ?? 'unlocked'}</div>
  )
}))
vi.mock('./GeneralTab', () => ({ GeneralTab: () => null }))
vi.mock('./EnvironmentTab', () => ({ EnvironmentTab: () => null }))
vi.mock('./IntegrationsTab', () => ({ IntegrationsTab: () => null }))
vi.mock('./WorktreesTab', () => ({ WorktreesTab: () => null }))
vi.mock('./ReposTab', () => ({ ReposTab: () => null }))
vi.mock('./TasksGeneralTab', () => ({ TasksGeneralTab: () => null }))
vi.mock('@slayzone/test-panel/client', () => ({ TestsTab: () => null }))
vi.mock('@slayzone/settings/client/tabs/TagsSettingsTab', () => ({ TagsSettingsTab: () => null }))

import { ProjectSettingsDialog } from './ProjectSettingsDialog'

const project = (id: string) => ({ id, path: `/tmp/${id}` }) as unknown as Project
const ui = (p: Project | null, open = true) => (
  <ProjectSettingsDialog
    project={p}
    open={open}
    onOpenChange={vi.fn()}
    initialTab="tasks/statuses"
    onUpdated={vi.fn()}
  />
)
const lockText = () => screen.getByTestId('columns-lock').textContent

beforeEach(() => {
  mappings = {}
  fetchFails = false
  isPlaywright = false
  fetchQuery.mockClear()
})

afterEach(cleanup)

describe('ProjectSettingsDialog status lock', () => {
  it('reports the provider whose status sync is set up', async () => {
    mappings = { 'p1:github': { status_setup_complete: true } }
    render(ui(project('p1')))
    await waitFor(() => expect(lockText()).toBe('GitHub'))
  })

  it('prefers Linear when both are set up', async () => {
    mappings = {
      'p1:linear': { status_setup_complete: true },
      'p1:github': { status_setup_complete: true }
    }
    render(ui(project('p1')))
    await waitFor(() => expect(lockText()).toBe('Linear'))
  })

  it('re-checks when the project changes while open', async () => {
    mappings = { 'p1:linear': { status_setup_complete: true } }
    const { rerender } = render(ui(project('p1')))
    await waitFor(() => expect(lockText()).toBe('Linear'))

    rerender(ui(project('p2')))
    await waitFor(() => expect(lockText()).toBe('unlocked'))
    expect(fetchQuery).toHaveBeenCalledWith({ input: { projectId: 'p2', provider: 'linear' } })
  })

  it('treats a failed lookup as unlocked', async () => {
    fetchFails = true
    render(ui(project('p1')))
    await waitFor(() => expect(fetchQuery).toHaveBeenCalled())
    expect(lockText()).toBe('unlocked')
  })

  it('does not look anything up while closed', () => {
    render(ui(project('p1'), false))
    expect(fetchQuery).not.toHaveBeenCalled()
  })

  it('skips the lookup under Playwright', async () => {
    isPlaywright = true
    mappings = { 'p1:linear': { status_setup_complete: true } }
    render(ui(project('p1')))
    await waitFor(() => expect(lockText()).toBe('unlocked'))
    expect(fetchQuery).not.toHaveBeenCalled()
  })
})
