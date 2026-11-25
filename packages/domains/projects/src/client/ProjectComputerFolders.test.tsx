// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Project } from '@slayzone/projects-contracts'

const setProjectPath = vi.fn()
const forgetProjectPath = vi.fn()
const cloneFolder = vi.fn()

vi.mock('./trpc', () => ({
  useTRPCClient: () => ({
    workspace: {
      setProjectPath: { mutate: setProjectPath },
      forgetProjectPath: { mutate: forgetProjectPath }
    },
    projects: { cloneFolder: { mutate: cloneFolder } }
  })
}))

// The picker browses a computer; here it hands back one path per computer.
vi.mock('@slayzone/file-editor/client/WorkspaceDirPicker', () => ({
  WorkspaceDirPicker: ({
    open,
    onSelect,
    target,
    title
  }: {
    open: boolean
    onSelect: (path: string) => void
    target: { computerId?: string | null; projectId?: string }
    title: string
  }) =>
    open ? (
      <button onClick={() => onSelect(`/picked/${target.computerId}`)}>
        {title} · {target.projectId}
      </button>
    ) : null
}))

vi.mock('@slayzone/ui', () => ({
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => (
    <button {...props}>{children}</button>
  )
}))

import { ProjectComputerFolders } from './ProjectComputerFolders'

const computers = [
  { id: 'mac', name: 'mac-studio' },
  { id: 'box', name: 'golden-comet' },
  { id: 'old', name: 'old-laptop', disabledAt: 1 }
]
const project = (placements: Project['placements']) =>
  ({ id: 'p1', placements }) as unknown as Project

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  setProjectPath.mockResolvedValue({ path: '/x', status: 'ready' })
  cloneFolder.mockResolvedValue({ path: '/x', status: 'ready' })
  forgetProjectPath.mockResolvedValue(undefined)
})

const row = (name: string) => within(screen.getByTestId(`computer-folder-${name}`))

describe('ProjectComputerFolders', () => {
  it('lists each computer with its folder and state', () => {
    render(
      <ProjectComputerFolders
        project={project([
          { computer_id: 'mac', path: '/Users/me/app', status: 'ready' },
          { computer_id: 'box', path: '/home/u/app', status: 'missing' }
        ])}
        computers={computers}
      />
    )
    expect(row('mac').getByText('/Users/me/app')).toBeDefined()
    expect(row('box').getByText('/home/u/app')).toBeDefined()
    expect(row('box').getByText('not found')).toBeDefined()
    expect(row('old').getByText('No folder')).toBeDefined()
  })

  it('chooses a folder on that computer', async () => {
    render(<ProjectComputerFolders project={project([])} computers={computers} />)
    fireEvent.click(row('box').getByText('Choose…'))
    fireEvent.click(screen.getByText('Folder on golden-comet · p1'))
    await waitFor(() =>
      expect(setProjectPath).toHaveBeenCalledWith({
        computerId: 'box',
        projectId: 'p1',
        path: '/picked/box'
      })
    )
  })

  it('offers clone only where the folder is not ready and another computer holds it', async () => {
    render(
      <ProjectComputerFolders
        project={project([{ computer_id: 'mac', path: '/Users/me/app', status: 'ready' }])}
        computers={computers}
      />
    )
    expect(row('mac').queryByText('Clone…')).toBeNull()
    fireEvent.click(row('box').getByText('Clone…'))
    fireEvent.click(screen.getByText('Clone into a folder on golden-comet · p1'))
    await waitFor(() =>
      expect(cloneFolder).toHaveBeenCalledWith({ id: 'p1', computerId: 'box', path: '/picked/box' })
    )
  })

  it('no clone when no computer holds the project', () => {
    render(<ProjectComputerFolders project={project([])} computers={computers} />)
    expect(screen.queryByText('Clone…')).toBeNull()
  })

  it('forgets a folder', async () => {
    render(
      <ProjectComputerFolders
        project={project([{ computer_id: 'box', path: '/home/u/app', status: 'missing' }])}
        computers={computers}
      />
    )
    fireEvent.click(row('box').getByText('Forget'))
    await waitFor(() =>
      expect(forgetProjectPath).toHaveBeenCalledWith({ computerId: 'box', projectId: 'p1' })
    )
  })

  it('shows a failure on its row', async () => {
    cloneFolder.mockRejectedValueOnce(new Error('/picked/box is not empty.'))
    render(
      <ProjectComputerFolders
        project={project([{ computer_id: 'mac', path: '/Users/me/app', status: 'ready' }])}
        computers={computers}
      />
    )
    fireEvent.click(row('box').getByText('Clone…'))
    fireEvent.click(screen.getByText('Clone into a folder on golden-comet · p1'))
    expect(await row('box').findByText('/picked/box is not empty.')).toBeDefined()
  })
})
