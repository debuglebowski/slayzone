import { render, screen, userEvent, waitFor, within } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { mutatingTrpcTest } from '../hubs/testing'
import { FolderPicker } from './FolderPicker'

const TARGET = { computerId: 'mini', projectId: 'p' }

interface Dir {
  parent: string | null
  entries: Array<{ name: string; isGitRepo?: boolean }>
}

/** A computer whose allowed roots are `roots`, with the folders of `tree`. */
function computer(
  tree: Record<string, Dir>,
  { roots = ['/Users/me'], home = '/Users/me' }: { roots?: string[]; home?: string | null } = {}
) {
  const calls: Array<{ path: string; input: unknown }> = []
  const test = mutatingTrpcTest({
    procedures: {
      'workspace.listRoots': (input) => {
        calls.push({ path: 'listRoots', input })
        return { computerId: 'mini', isLocal: false, roots, home, platform: 'darwin', sep: '/' }
      },
      'workspace.listDir': (input: { path: string }) => {
        calls.push({ path: 'listDir', input })
        const dir = tree[input.path]
        if (!dir) throw new Error(`ENOENT: no such folder ${input.path}`)
        return {
          computerId: 'mini',
          path: input.path,
          parent: dir.parent,
          entries: dir.entries.map((e) => ({
            name: e.name,
            path: `${input.path}/${e.name}`,
            type: 'directory',
            ...(e.isGitRepo ? { isGitRepo: true } : {})
          }))
        }
      },
      'workspace.mkdir': (input: { path: string }) => {
        calls.push({ path: 'mkdir', input })
        const at = input.path.lastIndexOf('/')
        const parent = input.path.slice(0, at)
        tree[parent]?.entries.push({ name: input.path.slice(at + 1) })
        tree[input.path] = { parent, entries: [] }
        return { computerId: 'mini', path: input.path }
      }
    }
  })
  return { calls, wrapper: test.wrapper as (p: { children: ReactNode }) => ReactNode }
}

const TREE = (): Record<string, Dir> => ({
  '/Users/me': { parent: '/Users', entries: [{ name: 'code' }, { name: 'Documents' }] },
  '/Users/me/code': { parent: '/Users/me', entries: [{ name: 'app', isGitRepo: true }] },
  '/Users/me/code/app': { parent: '/Users/me/code', entries: [] }
})

function picker(defaultPath: string | null = null) {
  const onSelect = jest.fn()
  const onClose = jest.fn()
  const ui = (
    <FolderPicker
      visible
      target={TARGET}
      defaultPath={defaultPath}
      onSelect={onSelect}
      onClose={onClose}
    />
  )
  return { ui, onSelect, onClose }
}

const pathField = () => screen.getByTestId('folder-picker-path')

describe('FolderPicker', () => {
  it("browses the computer's own folders, starting at home, and marks repositories", async () => {
    const { calls, wrapper } = computer(TREE())
    const { ui } = picker()
    await render(ui, { wrapper })

    expect(await screen.findByText('code')).toBeOnTheScreen()
    expect(pathField().props.value).toBe('/Users/me')
    expect(calls[0]).toEqual({ path: 'listRoots', input: TARGET })
    expect(calls[1]).toEqual({
      path: 'listDir',
      input: { ...TARGET, path: '/Users/me', dirsOnly: true }
    })

    const user = userEvent.setup()
    await user.press(screen.getByText('code'))
    expect(await screen.findByText('app')).toBeOnTheScreen()
    expect(
      within(screen.getByTestId('folder-entry-/Users/me/code/app')).getByText('git')
    ).toBeOnTheScreen()
    expect(pathField().props.value).toBe('/Users/me/code')
  })

  it("opens at the project's current folder when the computer allows it", async () => {
    const { wrapper } = computer(TREE())
    const { ui } = picker('/Users/me/code/app')
    await render(ui, { wrapper })
    expect(await screen.findByText('No sub-folders here.')).toBeOnTheScreen()
    expect(pathField().props.value).toBe('/Users/me/code/app')
  })

  it('goes up, never above what the computer allows', async () => {
    const { wrapper } = computer({
      ...TREE(),
      '/Users/me': { parent: null, entries: [{ name: 'code' }] }
    })
    const { ui } = picker('/Users/me/code')
    await render(ui, { wrapper })
    const user = userEvent.setup()
    expect(await screen.findByText('app')).toBeOnTheScreen()

    await user.press(screen.getByLabelText('Up one folder'))
    await waitFor(() => expect(pathField().props.value).toBe('/Users/me'))
    expect(await screen.findByText('code')).toBeOnTheScreen()
    expect(screen.getByLabelText('Up one folder')).toBeDisabled()
  })

  it('goes to a typed path', async () => {
    const { wrapper } = computer(TREE())
    const { ui } = picker()
    await render(ui, { wrapper })
    const user = userEvent.setup()
    await screen.findByText('code')

    await user.clear(pathField())
    await user.type(pathField(), '/Users/me/code', { submitEditing: true })
    expect(await screen.findByText('app')).toBeOnTheScreen()
  })

  it('chooses the folder it shows, or a path typed and not yet opened', async () => {
    const { wrapper } = computer(TREE())
    const { ui, onSelect, onClose } = picker('/Users/me/code/app')
    const view = await render(ui, { wrapper })
    const user = userEvent.setup()
    await screen.findByText('No sub-folders here.')
    await user.press(screen.getByText('Select'))
    expect(onSelect).toHaveBeenCalledWith('/Users/me/code/app')
    expect(onClose).toHaveBeenCalled()

    const second = picker()
    await view.rerender(second.ui)
    await screen.findByText('code')
    await user.clear(pathField())
    await user.type(pathField(), '/Users/me/elsewhere ')
    await user.press(screen.getByText('Select'))
    expect(second.onSelect).toHaveBeenCalledWith('/Users/me/elsewhere')
  })

  it('creates a folder there and opens it', async () => {
    const { calls, wrapper } = computer(TREE())
    const { ui } = picker('/Users/me/code')
    await render(ui, { wrapper })
    const user = userEvent.setup()
    await screen.findByText('app')

    await user.press(screen.getByText('New folder'))
    await user.type(screen.getByPlaceholderText('New folder name'), 'site')
    await user.press(screen.getByText('Create'))
    await waitFor(() => expect(pathField().props.value).toBe('/Users/me/code/site'))
    expect(calls.find((c) => c.path === 'mkdir')?.input).toEqual({
      ...TARGET,
      path: '/Users/me/code/site'
    })
  })

  it('says so when the computer allows no folder at all', async () => {
    const { wrapper } = computer(TREE(), { roots: [] })
    const { ui } = picker()
    await render(ui, { wrapper })
    expect(
      await screen.findByText(/This computer has no allowed folders configured/)
    ).toBeOnTheScreen()
  })

  it("says why it can't read a folder", async () => {
    const { wrapper } = computer(TREE())
    const { ui } = picker()
    await render(ui, { wrapper })
    const user = userEvent.setup()
    await screen.findByText('code')
    await user.clear(pathField())
    await user.type(pathField(), '/Users/me/gone', { submitEditing: true })
    expect(await screen.findByText(/ENOENT: no such folder \/Users\/me\/gone/)).toBeOnTheScreen()
  })

  it('offers each root when the computer allows several', async () => {
    const { wrapper } = computer(
      { ...TREE(), '/Volumes/data': { parent: null, entries: [{ name: 'big' }] } },
      { roots: ['/Users/me', '/Volumes/data'] }
    )
    const { ui } = picker()
    await render(ui, { wrapper })
    const user = userEvent.setup()
    await screen.findByText('code')
    await user.press(screen.getByText('/Volumes/data'))
    expect(await screen.findByText('big')).toBeOnTheScreen()
  })
})
