// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Project } from '@slayzone/projects-contracts'

let projects: Project[] = []
let roots: string[] = []
const setAllowedRoots = vi.fn(async ({ roots: next }: { roots: string[] }) => ({
  roots: next,
  rejected: []
}))
const setDefault = vi.fn(async (_input: unknown) => undefined)
const setFolder = vi.fn(async (_p: Project, _c: string, _path: string) => projects[0]!)

vi.mock('../trpc', () => ({
  useTRPC: () => ({
    projects: {
      list: {
        queryOptions: () => ({ queryKey: ['projects.list'], queryFn: async () => projects }),
        queryFilter: () => ({ queryKey: ['projects.list'] })
      }
    },
    computers: {
      setProjectDefaultComputer: { mutationOptions: () => ({ mutationFn: setDefault }) }
    }
  }),
  useTRPCClient: () => ({
    workspace: {
      listRoots: { query: async () => ({ roots, home: null }) },
      setAllowedRoots: { mutate: setAllowedRoots }
    }
  })
}))

// The row and its editor are projects' (tested there, ComputersTab.test.tsx); here
// only what this page hands them matters.
vi.mock('@slayzone/projects', () => ({
  RelocateProjectDialog: () => null,
  useProjectFolderEditor: () => ({ setFolder, forgetFolder: vi.fn() }),
  ProjectFolderRow: (props: {
    testId: string
    placement: { path: string } | null
    browse: unknown
    actions: React.ReactNode
    onSetFolder: (path: string) => Promise<unknown>
  }) => (
    <div data-testid={props.testId} data-path={props.placement?.path ?? ''}>
      <button type="button" onClick={() => void props.onSetFolder('/picked')}>
        set
      </button>
      {props.actions}
    </div>
  )
}))

vi.mock('@slayzone/ui', async (load) => ({
  ...(await load<typeof import('@slayzone/ui')>()),
  toast: { success: () => undefined, error: () => undefined, warning: () => undefined }
}))

import { ComputerFolders } from './ComputerFolders'

const project = (id: string, placements: Project['placements'], resolved = 'other') =>
  ({
    id,
    name: id,
    color: '#000000',
    placements,
    default_computer_id: resolved,
    resolved_computer_id: resolved
  }) as Project

function renderPage(computer = { id: 'box', name: 'Box', disabledAt: null as number | null }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ComputerFolders computer={computer} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  roots = ['/Users/me']
  projects = [
    project('elsewhere', [{ computer_id: 'other', path: '/o', status: 'ready' }]),
    project('here', [{ computer_id: 'box', path: '/Users/me/here', status: 'ready' }], 'box')
  ]
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ComputerFolders', () => {
  it('lists every project of the hub, those with a folder on this computer first', async () => {
    renderPage()
    await screen.findByTestId('computer-project-here')
    const rows = screen.getAllByTestId(/^computer-project-[a-z]+$/)
    expect(rows.map((r) => r.dataset.testid)).toEqual([
      'computer-project-here',
      'computer-project-elsewhere'
    ])
    // The folder ON THIS computer — not the project's folder elsewhere.
    expect(rows[0]!.dataset.path).toBe('/Users/me/here')
    expect(rows[1]!.dataset.path).toBe('')
  })

  it('sets a folder on this computer', async () => {
    renderPage()
    const row = await screen.findByTestId('computer-project-elsewhere')
    fireEvent.click(row.querySelector('button')!)
    await waitFor(() => expect(setFolder).toHaveBeenCalled())
    expect(setFolder.mock.calls[0]!.slice(1)).toEqual(['box', '/picked'])
  })

  it('Make default binds the project to this computer, unless it already runs here', async () => {
    renderPage()
    await screen.findByTestId('computer-project-here')
    expect(screen.queryByTestId('computer-project-here-make-default')).toBeNull()
    fireEvent.click(screen.getByTestId('computer-project-elsewhere-make-default'))
    await waitFor(() => expect(setDefault).toHaveBeenCalled())
    expect(setDefault.mock.calls[0]![0]).toEqual({ projectId: 'elsewhere', computerId: 'box' })
  })

  it('a disabled computer takes no new work: no Make default', async () => {
    renderPage({ id: 'box', name: 'Box', disabledAt: 1 })
    await screen.findByTestId('computer-project-elsewhere')
    expect(screen.queryByTestId('computer-project-elsewhere-make-default')).toBeNull()
  })

  it('edits the allowed folders in place, saving only a change', async () => {
    renderPage()
    expect(await screen.findByText('/Users/me')).toBeTruthy()
    const save = screen.getByTestId('computer-roots-save') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByTestId('computer-roots-input'), { target: { value: '/srv' } })
    fireEvent.click(screen.getByRole('button', { name: /Add/ }))
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() =>
      expect(setAllowedRoots).toHaveBeenCalledWith({
        computerId: 'box',
        roots: ['/Users/me', '/srv']
      })
    )
    // Stays on the page, list as saved.
    expect(screen.getByText('/srv')).toBeTruthy()
  })
})
