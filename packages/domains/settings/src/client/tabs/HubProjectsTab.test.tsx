// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Project } from '@slayzone/projects-contracts'

let projects: Project[] = []
let computers: Array<{ id: string; name: string }> = []
const navigate = vi.fn()
const openCreateProject = vi.fn()

vi.mock('../trpc', () => ({
  useTRPC: () => ({
    projects: {
      list: { queryOptions: () => ({ queryKey: ['projects.list'], queryFn: async () => projects }) }
    },
    computers: {
      list: {
        queryOptions: () => ({ queryKey: ['computers.list'], queryFn: async () => computers })
      }
    }
  })
}))
vi.mock('../settings-view-store', () => ({
  useSettingsViewStore: (pick: (s: { navigate: typeof navigate }) => unknown) => pick({ navigate })
}))
vi.mock('@slayzone/projects', () => ({
  openCreateProject: (hubId: string | null) => openCreateProject(hubId)
}))

import { HubProjectsTab } from './HubProjectsTab'

const project = (id: string, name: string, path: string | null, computer = 'laptop') =>
  ({
    id,
    name,
    color: '#123456',
    icon_letters: null,
    resolved_computer_id: computer,
    default_computer_id: computer,
    placements: path ? [{ computer_id: computer, path, status: 'ready' }] : []
  }) as unknown as Project

function renderTab(hubId: string | null = 'hub-2') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <HubProjectsTab hubId={hubId} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  computers = [{ id: 'laptop', name: 'Laptop' }]
  projects = [project('p1', 'Alpha', '/work/alpha'), project('p2', 'Beta', null)]
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('HubProjectsTab', () => {
  it('lists every project of the hub with its folder', async () => {
    renderTab()
    const rows = await screen.findAllByTestId('hub-projects-row')
    expect(rows.map((r) => r.dataset.projectId)).toEqual(['p1', 'p2'])
    expect(within(rows[0]!).getByText('/work/alpha')).toBeTruthy()
    expect(within(rows[1]!).getByText('No folder')).toBeTruthy()
    expect(screen.getByText('2 projects on this hub.')).toBeTruthy()
  })

  it('opens a project’s settings', async () => {
    renderTab()
    fireEvent.click((await screen.findAllByTestId('hub-projects-row'))[1]!)
    expect(navigate).toHaveBeenCalledWith({ kind: 'project', projectId: 'p2', tab: 'general' })
  })

  it('New project opens the Create Project dialog on THIS hub', async () => {
    renderTab('hub-2')
    await screen.findAllByTestId('hub-projects-row')
    fireEvent.click(screen.getByTestId('hub-projects-new'))
    expect(openCreateProject).toHaveBeenCalledWith('hub-2')
  })

  it('an empty hub offers to create the first project', async () => {
    projects = []
    renderTab(null)
    expect(await screen.findByTestId('hub-projects-empty')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Create the first one/ }))
    expect(openCreateProject).toHaveBeenCalledWith(null)
  })

  it('names the computer only when the hub has more than one', async () => {
    renderTab()
    await screen.findAllByTestId('hub-projects-row')
    expect(screen.queryByText('Laptop')).toBeNull()
    cleanup()
    computers = [...computers, { id: 'server', name: 'Server' }]
    projects = [project('p1', 'Alpha', '/srv/alpha', 'server')]
    renderTab()
    const row = await screen.findByTestId('hub-projects-row')
    expect(within(row).getByText('Server')).toBeTruthy()
  })

  it('filters once the list is long enough to need it', async () => {
    renderTab()
    await screen.findAllByTestId('hub-projects-row')
    expect(screen.queryByTestId('hub-projects-filter')).toBeNull()
    cleanup()
    projects = Array.from({ length: 9 }, (_, i) => project(`p${i}`, `Project ${i}`, null))
    projects.push(project('gamma', 'Gamma', null))
    renderTab()
    fireEvent.change(await screen.findByTestId('hub-projects-filter'), {
      target: { value: 'gam' }
    })
    expect(screen.getAllByTestId('hub-projects-row').map((r) => r.dataset.projectId)).toEqual([
      'gamma'
    ])
  })

  it('keeps the way to the cross-project settings comparison', async () => {
    renderTab()
    fireEvent.click(await screen.findByTestId('hub-projects-compare'))
    expect(navigate).toHaveBeenCalledWith({ kind: 'projects' })
  })
})
