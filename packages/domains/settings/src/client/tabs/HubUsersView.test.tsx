// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { TooltipProvider } from '@slayzone/ui'
import { HubUsersView, type HubUserManagement, type ManagedHubUser } from './HubUsersView'

afterEach(cleanup)
const users: ManagedHubUser[] = [
  {
    id: 'me',
    name: 'Me Admin',
    email: 'me@example.com',
    role: 'admin',
    disabledAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    breakGlass: false
  },
  {
    id: 'alice',
    name: 'Alice',
    email: 'alice@example.com',
    role: 'user',
    disabledAt: null,
    createdAt: '2026-02-01T00:00:00.000Z',
    breakGlass: false
  },
  {
    id: 'carol',
    name: 'Carol',
    email: 'carol@example.com',
    role: 'admin',
    disabledAt: null,
    createdAt: '2026-02-02T00:00:00.000Z',
    breakGlass: false
  },
  {
    id: 'bob',
    name: 'Bob',
    email: 'bob@example.com',
    role: 'user',
    disabledAt: '2026-11-09T00:00:00.000Z',
    createdAt: '2026-03-01T00:00:00.000Z',
    breakGlass: false
  },
  {
    id: 'bg',
    name: 'Break glass',
    email: 'break-glass@hub.slayzone.local',
    role: 'user',
    disabledAt: null,
    createdAt: '2026-04-01T00:00:00.000Z',
    breakGlass: true
  }
]
const report = {
  id: 'job',
  state: 'incomplete' as const,
  counts: { projects: 1, tasks: 2, artifacts: 3, versions: 4 },
  computers: [{ id: 'pc', name: 'Bob laptop', deleted: false }],
  failures: [],
  retainedSharedBlobs: 0,
  retainedBackupBlobs: 0
}
function setup(
  management: HubUserManagement | null = { roleAuthority: 'hub', passwordEnabled: true }
) {
  const handlers = {
    onDisable: vi.fn(async () => undefined),
    onEnable: vi.fn(async () => undefined),
    onSetRole: vi.fn(async () => undefined),
    onErase: vi.fn(async () => report),
    onCreate: vi.fn(async (input: { email: string; name?: string; role?: 'admin' | 'user' }) => ({
      email: input.email,
      name: input.name ?? 'new',
      role: input.role ?? ('user' as const),
      password: 'generated-secret'
    }))
  }
  render(
    <TooltipProvider>
      <HubUsersView
        users={users}
        selfUserId="me"
        management={management}
        hubUrl="https://hub.example.com"
        reports={[]}
        statusUserId={null}
        onShowReports={() => {}}
        onRetry={async () => report}
        onPreview={async () => ({ counts: report.counts })}
        {...handlers}
      />
    </TooltipProvider>
  )
  return handlers
}
function openMenu(name: string) {
  fireEvent.keyDown(screen.getByRole('button', { name: `Actions for ${name}` }), { key: 'Enter' })
}
const item = (name: string) => screen.getByRole('menuitem', { name })

test('Disable requires its own confirmation modal and never erases content', async () => {
  const { onDisable, onErase } = setup()
  openMenu('Alice')
  fireEvent.click(item('Disable…'))
  expect(onDisable).not.toHaveBeenCalled()
  const dialog = screen.getByRole('alertdialog')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Disable user' }))
  await waitFor(() => expect(onDisable).toHaveBeenCalledWith('alice@example.com'))
  expect(onErase).not.toHaveBeenCalled()
})

test('only disabled users get erasure; confirming the wrong identity never submits', async () => {
  setup()
  openMenu('Alice')
  expect(screen.queryByRole('menuitem', { name: 'Erase all content…' })).toBeNull()
  cleanup()
  const { onErase } = setup()
  openMenu('Bob')
  fireEvent.click(item('Erase all content…'))
  await screen.findByText('1 project · 2 tasks · 3 files · 4 saved versions')
  const button = screen.getByRole('button', { name: 'Erase all content' }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Confirm user email'), {
    target: { value: 'alice@example.com' }
  })
  expect(button.disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Confirm user email'), {
    target: { value: 'bob@example.com' }
  })
  expect(button.disabled).toBe(false)
  fireEvent.click(button)
  await waitFor(() => expect(onErase).toHaveBeenCalledWith('bob', 'bob@example.com'))
})

test('a disabled user can be enabled again from the row menu', async () => {
  const { onEnable } = setup()
  openMenu('Bob')
  fireEvent.click(item('Enable'))
  await waitFor(() => expect(onEnable).toHaveBeenCalledWith('bob@example.com'))
})

test('granting admin is confirmed; demoting someone else is not; demoting yourself is', async () => {
  const { onSetRole } = setup()
  openMenu('Alice')
  fireEvent.click(item('Make admin'))
  expect(onSetRole).not.toHaveBeenCalled()
  fireEvent.click(
    within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Make admin' })
  )
  await waitFor(() => expect(onSetRole).toHaveBeenCalledWith('alice@example.com', 'admin'))

  openMenu('Carol')
  fireEvent.click(item('Remove admin'))
  await waitFor(() => expect(onSetRole).toHaveBeenCalledWith('carol@example.com', 'user'))

  onSetRole.mockClear()
  openMenu('Me Admin')
  fireEvent.click(item('Remove admin'))
  expect(screen.getByRole('alertdialog').textContent).toContain('Remove your own admin access?')
  expect(onSetRole).not.toHaveBeenCalled()
})

test('where an identity provider owns roles: no role actions, and the source is named', () => {
  setup({ roleAuthority: 'entra-app-roles', passwordEnabled: true })
  expect(screen.getByTestId('hub-users-role-source').textContent).toContain('Entra ID')
  openMenu('Alice')
  expect(screen.queryByRole('menuitem', { name: 'Make admin' })).toBeNull()
  expect(item('Disable…')).toBeTruthy()
})

test('Add user shows the generated password once, with sign-in details to copy', async () => {
  const { onCreate } = setup()
  fireEvent.click(screen.getByTestId('hub-user-add-open'))
  const create = screen.getByRole('button', { name: 'Create account' }) as HTMLButtonElement
  expect(create.disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'dan@example.com' } })
  fireEvent.click(screen.getByRole('radio', { name: /Admin/ }))
  fireEvent.click(create)
  await waitFor(() =>
    expect(onCreate).toHaveBeenCalledWith({ email: 'dan@example.com', role: 'admin' })
  )
  expect((await screen.findByTestId('hub-user-created-password')).textContent).toBe(
    'generated-secret'
  )
  expect(screen.getByRole('button', { name: /Copy sign-in details/ })).toBeTruthy()
})

test('Add user sends no role where the hub does not own roles, and is off without passwords', async () => {
  const { onCreate } = setup({ roleAuthority: 'idp', passwordEnabled: true })
  fireEvent.click(screen.getByTestId('hub-user-add-open'))
  expect(screen.queryByRole('radiogroup')).toBeNull()
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'dan@example.com' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
  await waitFor(() => expect(onCreate).toHaveBeenCalledWith({ email: 'dan@example.com' }))
  cleanup()
  setup({ roleAuthority: 'idp', passwordEnabled: false })
  expect((screen.getByTestId('hub-user-add-open') as HTMLButtonElement).disabled).toBe(true)
})

test('a hub too old to describe itself offers no add, enable or role actions', () => {
  setup(null)
  expect((screen.getByTestId('hub-user-add-open') as HTMLButtonElement).disabled).toBe(true)
  openMenu('Bob')
  expect(screen.queryByRole('menuitem', { name: 'Enable' })).toBeNull()
  expect(item('Erase all content…')).toBeTruthy()
})

test('search and status filter narrow the list; the break-glass account has no actions', () => {
  setup()
  const rows = () => screen.getAllByTestId(/^hub-user-row-/).map((r) => r.dataset.testid)
  fireEvent.change(screen.getByLabelText('Search users'), { target: { value: 'ali' } })
  expect(rows()).toEqual(['hub-user-row-alice@example.com'])
  fireEvent.change(screen.getByLabelText('Search users'), { target: { value: '' } })
  fireEvent.click(screen.getByRole('tab', { name: /Disabled/ }))
  expect(rows()).toEqual(['hub-user-row-bob@example.com'])
  fireEvent.click(screen.getByRole('tab', { name: /All/ }))
  expect(screen.queryByRole('button', { name: 'Actions for Break glass' })).toBeNull()
  expect(screen.getByText('You')).toBeTruthy()
})
