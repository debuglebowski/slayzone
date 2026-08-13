/**
 * @vitest-environment jsdom
 *
 * The directory picker that replaced the native file dialog for workspace paths.
 *
 * What matters here is not the chrome but the claims it makes: it browses the
 * COMPUTER's filesystem (the native dialog browsed the desktop's, which is how a
 * remote task ended up with a path that existed nowhere), it stays inside that
 * computer's jail, and when the jail is empty it says so instead of rendering a
 * blank list that reads as "this machine has no folders".
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Entry = { name: string; path: string; type: 'directory' | 'file'; isGitRepo?: boolean }

let rootsResult: {
  computerId: string | null
  roots: string[]
  home: string | null
  platform: string
  sep: string
}
let rootsError: Error | null = null
let dirByPath: Record<string, { path: string; parent: string | null; entries: Entry[] }>
const listDirSpy = vi.fn((_input: { path: string; dirsOnly?: boolean }) => {})
const mkdirSpy = vi.fn((_input: { path: string; taskId?: string }) => {})

vi.mock('@slayzone/transport/client', () => ({
  useTRPC: () => ({
    workspace: {
      listRoots: { queryOptions: (input: unknown) => ({ __op: 'roots', input }) },
      listDir: {
        queryOptions: (input: unknown, opts: unknown) => ({ __op: 'dir', input, opts }),
        queryFilter: () => ({ __op: 'dir' })
      },
      mkdir: { mutationOptions: () => ({ __op: 'mkdir' }) }
    }
  })
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts: {
    __op: string
    input: Record<string, unknown>
    opts?: { enabled?: boolean }
  }) => {
    if (opts.__op === 'roots') {
      return {
        data: rootsError ? undefined : rootsResult,
        error: rootsError,
        isError: !!rootsError,
        isSuccess: !rootsError,
        isPending: false
      }
    }
    const path = String(opts.input.path ?? '')
    const enabled = opts.opts?.enabled !== false
    if (enabled && path) listDirSpy({ path, dirsOnly: opts.input.dirsOnly as boolean })
    const data = dirByPath[path]
    return {
      data,
      error: null,
      isError: false,
      isSuccess: !!data,
      isPending: enabled && !data
    }
  },
  useMutation: () => ({
    mutateAsync: async (input: { path: string }) => {
      mkdirSpy(input)
      dirByPath[input.path] = { path: input.path, parent: '/srv/work', entries: [] }
      return { path: input.path }
    },
    isPending: false
  }),
  useQueryClient: () => ({ invalidateQueries: async () => {} })
}))

import { WorkspaceDirPicker } from './WorkspaceDirPicker'

beforeEach(() => {
  rootsError = null
  rootsResult = {
    computerId: 'computer-1',
    roots: ['/srv/work'],
    home: '/home/deploy',
    platform: 'linux',
    sep: '/'
  }
  dirByPath = {
    '/srv/work': {
      path: '/srv/work',
      parent: null,
      entries: [
        { name: 'app', path: '/srv/work/app', type: 'directory', isGitRepo: true },
        { name: 'scratch', path: '/srv/work/scratch', type: 'directory' }
      ]
    },
    '/srv/work/app': { path: '/srv/work/app', parent: '/srv/work', entries: [] }
  }
  listDirSpy.mockClear()
  mkdirSpy.mockClear()
})

afterEach(cleanup)

function renderPicker(over: Partial<Parameters<typeof WorkspaceDirPicker>[0]> = {}) {
  const onSelect = vi.fn()
  render(
    <WorkspaceDirPicker
      open
      onOpenChange={() => {}}
      onSelect={onSelect}
      target={{ taskId: 'task-1' }}
      {...over}
    />
  )
  return { onSelect }
}

describe('WorkspaceDirPicker', () => {
  // The jail IS the browsable set. Opening anywhere else would offer paths the
  // computer then refuses, so the first listing must be a configured root.
  it('opens on a configured root and lists only directories', async () => {
    renderPicker()
    await waitFor(() => expect(listDirSpy).toHaveBeenCalled())
    expect(listDirSpy).toHaveBeenCalledWith({ path: '/srv/work', dirsOnly: true })
    expect(screen.getAllByTestId('workspace-dir-entry')).toHaveLength(2)
  })

  // Picking the folder ABOVE a repo instead of the repo itself is the easy
  // mistake this marker exists to prevent.
  it('marks directories that are git repositories', async () => {
    renderPicker()
    await waitFor(() => expect(screen.getAllByTestId('workspace-dir-entry')).toHaveLength(2))
    expect(screen.getAllByTestId('workspace-dir-entry')[0]!.textContent).toContain('git')
    expect(screen.getAllByTestId('workspace-dir-entry')[1]!.textContent).not.toContain('git')
  })

  it('descends into a folder and returns its path on select', async () => {
    const { onSelect } = renderPicker()
    await waitFor(() => expect(screen.getAllByTestId('workspace-dir-entry')).toHaveLength(2))
    await act(async () => {
      fireEvent.click(screen.getAllByTestId('workspace-dir-entry')[0]!)
    })
    await waitFor(() =>
      expect(screen.getByTestId('workspace-dir-picker-path')).toHaveProperty(
        'value',
        '/srv/work/app'
      )
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('workspace-dir-picker-select'))
    })
    expect(onSelect).toHaveBeenCalledWith('/srv/work/app')
  })

  // A caller's remembered path can belong to a different machine entirely. Opening
  // there would ask the computer to list something it will refuse.
  it('ignores a defaultPath that lies outside the target’s roots', async () => {
    renderPicker({ defaultPath: '/Users/kalle/dev/thing' })
    await waitFor(() => expect(listDirSpy).toHaveBeenCalled())
    expect(listDirSpy).toHaveBeenCalledWith({ path: '/srv/work', dirsOnly: true })
  })

  it('honours a defaultPath that is inside them', async () => {
    renderPicker({ defaultPath: '/srv/work/app' })
    await waitFor(() => expect(listDirSpy).toHaveBeenCalled())
    expect(listDirSpy).toHaveBeenCalledWith({ path: '/srv/work/app', dirsOnly: true })
  })

  // Typing an absolute path is the one affordance the native dialog had that a
  // browse-only list does not, and it is how you reach a deep path quickly.
  it('accepts a typed absolute path', async () => {
    const { onSelect } = renderPicker()
    await waitFor(() => expect(listDirSpy).toHaveBeenCalled())
    await act(async () => {
      fireEvent.change(screen.getByTestId('workspace-dir-picker-path'), {
        target: { value: '/srv/work/typed' }
      })
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('workspace-dir-picker-select'))
    })
    expect(onSelect).toHaveBeenCalledWith('/srv/work/typed')
  })

  it('creates a folder on the computer and moves into it', async () => {
    renderPicker({ allowCreate: true })
    await waitFor(() => expect(screen.getByTestId('workspace-dir-new-folder')).toBeDefined())
    await act(async () => {
      fireEvent.click(screen.getByTestId('workspace-dir-new-folder'))
    })
    await act(async () => {
      fireEvent.change(screen.getByTestId('workspace-dir-new-name'), {
        target: { value: 'fresh' }
      })
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    })
    // Carries the target: the folder has to be created on the SAME machine the
    // listing came from, not wherever a default resolution would land.
    expect(mkdirSpy).toHaveBeenCalledWith({ path: '/srv/work/fresh', taskId: 'task-1' })
  })

  it('offers no folder creation unless the caller asked for it', async () => {
    renderPicker()
    await waitFor(() => expect(listDirSpy).toHaveBeenCalled())
    expect(screen.queryByTestId('workspace-dir-new-folder')).toBeNull()
  })

  // A computer with no allowedRoots refuses every filesystem call. An empty list
  // would read as "this machine has no folders" — a different, wrong claim.
  it('explains an empty jail instead of rendering an empty list', async () => {
    rootsResult = { ...rootsResult, roots: [] }
    renderPicker()
    await waitFor(() => expect(screen.getByTestId('workspace-dir-picker-no-roots')).toBeDefined())
    expect(screen.queryByTestId('workspace-dir-picker-list')).toBeNull()
    expect(listDirSpy).not.toHaveBeenCalled()
  })

  it('surfaces an unreachable machine as an error, not as an empty folder', async () => {
    rootsError = new Error('computer offline')
    renderPicker()
    await waitFor(() => expect(screen.getByTestId('workspace-dir-picker-error')).toBeDefined())
    expect(screen.getByTestId('workspace-dir-picker-error').textContent).toContain(
      'computer offline'
    )
  })
})
