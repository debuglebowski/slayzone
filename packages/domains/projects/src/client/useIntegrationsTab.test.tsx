// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { Project } from '@slayzone/projects-contracts'
import type { IntegrationProvider } from '@slayzone/integrations/shared'

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const LINEAR_MAPPING = {
  connection_id: 'c1',
  external_team_id: 't1',
  external_project_id: 'p1',
  sync_mode: 'one_way',
  assigned_to_me: false
}

let linearTeams: Deferred<unknown>
let linearProjects: Deferred<unknown>
const listLinearTeams = vi.fn()
const listLinearProjects = vi.fn()
const client = {
  integrations: {
    listConnections: {
      query: ({ provider }: { provider: string }) =>
        Promise.resolve(provider === 'linear' ? [{ id: 'c1' }] : [])
    },
    getProjectMapping: {
      query: ({ provider }: { provider: string }) =>
        Promise.resolve(provider === 'linear' ? LINEAR_MAPPING : null)
    },
    getProjectConnection: {
      query: ({ provider }: { provider: string }) =>
        Promise.resolve(provider === 'linear' ? 'c1' : null)
    },
    listGithubRepositories: { query: () => Promise.resolve([]) },
    listGithubProjects: { query: () => Promise.resolve([]) },
    listLinearTeams: { query: listLinearTeams },
    listLinearProjects: { query: listLinearProjects }
  }
}

vi.mock('@slayzone/transport/client', () => ({
  useTRPCClient: () => client
}))

vi.mock('@slayzone/ui', async () => ({
  ...(await vi.importActual<object>('../../../../shared/ui/src/use-deps-changed')),
  toast: vi.fn()
}))

import { useIntegrationsTab } from './useIntegrationsTab'

const project = { id: 'proj-1', columns_config: null } as unknown as Project

type Props = {
  open: boolean
  provider?: IntegrationProvider | null
  onHandled?: () => void
}

function setup(initial: Props) {
  return renderHook(
    ({ open, provider, onHandled }: Props) =>
      useIntegrationsTab({
        project,
        open,
        onUpdated: () => {},
        integrationOnboardingProvider: provider ?? null,
        onIntegrationOnboardingHandled: onHandled
      }),
    { initialProps: initial }
  )
}

beforeEach(() => {
  linearTeams = deferred()
  linearProjects = deferred()
  listLinearTeams.mockReset().mockImplementation(() => linearTeams.promise)
  listLinearProjects.mockReset().mockImplementation(() => linearProjects.promise)
})

describe('useIntegrationsTab entry selection', () => {
  it('an onboarding request opens the provider setup and is acknowledged once', async () => {
    const onHandled = vi.fn()
    const { result, rerender } = setup({ open: true, provider: 'github', onHandled })

    expect(result.current.selectedIntegrationEntry).toBe('github_projects')
    expect(result.current.selectedIntegrationMode).toBe('continuous')
    expect(onHandled).toHaveBeenCalledTimes(1)

    // Host clears the request: the selection stays.
    rerender({ open: true, provider: null, onHandled })
    expect(result.current.selectedIntegrationEntry).toBe('github_projects')
    expect(onHandled).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(result.current.linearProjectConnectionId).toBe('c1'))
  })

  it('a linear onboarding request selects linear continuous sync', async () => {
    const { result } = setup({ open: true, provider: 'linear', onHandled: vi.fn() })
    expect(result.current.selectedIntegrationEntry).toBe('linear')
    expect(result.current.selectedIntegrationMode).toBe('continuous')
    await waitFor(() => expect(result.current.linearProjectConnectionId).toBe('c1'))
  })

  it('re-opening returns to the integration list', async () => {
    const { result, rerender } = setup({ open: true })
    expect(result.current.selectedIntegrationEntry).toBeNull()
    await waitFor(() => expect(result.current.linearProjectConnectionId).toBe('c1'))

    act(() => result.current.handleSelectIntegrationEntry('linear', { mode: 'import' }))
    expect(result.current.selectedIntegrationEntry).toBe('linear')

    rerender({ open: true })
    expect(result.current.selectedIntegrationEntry).toBe('linear')

    rerender({ open: false })
    expect(result.current.selectedIntegrationEntry).toBe('linear')
    rerender({ open: true })
    expect(result.current.selectedIntegrationEntry).toBeNull()
    expect(result.current.selectedIntegrationMode).toBeNull()
    await waitFor(() => expect(result.current.linearProjectConnectionId).toBe('c1'))
  })
})

describe('useIntegrationsTab linear sources', () => {
  it('flags loading while teams/projects load, then selects the mapped ones', async () => {
    const { result } = setup({ open: true })
    await waitFor(() => expect(result.current.linearProjectConnectionId).toBe('c1'))

    expect(result.current.loadingLinearSyncTeams).toBe(true)
    expect(result.current.loadingLinearImportTeams).toBe(true)
    expect(result.current.linearSyncTeamId).toBe('t1')
    expect(result.current.loadingLinearSyncProjects).toBe(true)
    expect(listLinearProjects).toHaveBeenCalledWith({ connectionId: 'c1', teamId: 't1' })

    await act(async () => {
      linearTeams.resolve([
        { id: 't1', key: 'T1', name: 'Team 1' },
        { id: 't2', key: 'T2', name: 'Team 2' }
      ])
      linearProjects.resolve([{ id: 'p1', name: 'Project 1' }])
    })

    await waitFor(() => expect(result.current.loadingLinearSyncTeams).toBe(false))
    expect(result.current.loadingLinearImportTeams).toBe(false)
    expect(result.current.linearSyncTeams.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(result.current.linearSyncTeamId).toBe('t1')
    expect(result.current.linearImportTeamId).toBe('t1')
    await waitFor(() => expect(result.current.loadingLinearSyncProjects).toBe(false))
    expect(result.current.linearSyncProjectId).toBe('p1')
  })

  it('clearing the connection clears every linear source', async () => {
    const { result } = setup({ open: true })
    await waitFor(() => expect(result.current.linearProjectConnectionId).toBe('c1'))
    await act(async () => {
      linearTeams.resolve([{ id: 't1', key: 'T1', name: 'Team 1' }])
      linearProjects.resolve([{ id: 'p1', name: 'Project 1' }])
    })
    await waitFor(() => expect(result.current.linearSyncProjectId).toBe('p1'))

    act(() => result.current.setLinearProjectConnectionId(''))

    expect(result.current.linearSyncTeams).toEqual([])
    expect(result.current.linearSyncTeamId).toBe('')
    expect(result.current.linearSyncProjects).toEqual([])
    expect(result.current.linearSyncProjectId).toBe('')
    expect(result.current.linearImportTeams).toEqual([])
    expect(result.current.linearImportTeamId).toBe('')
    expect(result.current.linearImportProjects).toEqual([])
    expect(result.current.linearImportProjectId).toBe('')
  })
})

describe('useIntegrationsTab GitHub repo issue import', () => {
  it('keeps the query while its source is unchanged, clears it when the entry changes', async () => {
    const { result, rerender } = setup({ open: true })
    await waitFor(() => expect(result.current.linearProjectConnectionId).toBe('c1'))

    act(() => result.current.setGithubRepoIssueQuery('bug'))
    rerender({ open: true })
    expect(result.current.githubRepoIssueQuery).toBe('bug')

    act(() => result.current.handleSelectIntegrationEntry('github_issues'))
    expect(result.current.githubRepoIssueQuery).toBe('')
  })
})
