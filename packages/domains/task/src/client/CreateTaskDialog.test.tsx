// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Controller } from 'react-hook-form'

/**
 * A task row is FK-bound to its project (`tasks.project_id REFERENCES
 * projects(id)`), and under multi-hub federation that project lives in exactly
 * ONE hub's SQLite DB. The dialog therefore has to send `task.create` — and
 * every call that follows it — to the hub that OWNS the selected project, not
 * to the ambient (default-hub) client it happens to be mounted under. Sending
 * it to the default hub is what produced "FOREIGN KEY constraint failed" when
 * creating a task on a remote hub's project.
 */

// --- per-hub client spies -------------------------------------------------

const ambient = {
  task: { create: { mutate: vi.fn() } },
  tags: { setForTask: { mutate: vi.fn(() => Promise.resolve({ ok: true })) } },
  settings: { get: { query: vi.fn(() => Promise.resolve('0')) } },
  projects: { list: { query: vi.fn(() => Promise.resolve([])) } },
  template: { getByProject: { query: vi.fn(() => Promise.resolve([])) } }
}
const remote = {
  task: { create: { mutate: vi.fn() } },
  tags: { setForTask: { mutate: vi.fn(() => Promise.resolve({ ok: true })) } },
  settings: { get: { query: vi.fn(() => Promise.resolve('0')) } },
  projects: { list: { query: vi.fn(() => Promise.resolve([])) } },
  template: { getByProject: { query: vi.fn(() => Promise.resolve([])) } }
}

/** Ownership: `p-remote` lives on hub `remote-a`, everything else on the default. */
const hubIdFor = (projectId?: string): string | undefined =>
  projectId === 'p-remote' ? 'remote-a' : projectId ? 'local' : undefined

const noteTaskHub = vi.fn()

vi.mock('@slayzone/transport/client', () => ({
  useTRPC: () => ({
    projects: { list: { queryOptions: () => ({ __data: [] }) } }
  }),
  useTRPCClient: () => ambient,
  // The seam under test: the dialog must resolve its client from the selected
  // project, and the real implementation of this hook is covered by
  // hubOwnershipStore.test.ts.
  useClientForProject: (projectId?: string) => (hubIdFor(projectId) === 'remote-a' ? remote : ambient),
  useHubIdForProject: (projectId?: string) => hubIdFor(projectId),
  useHubOwnershipStore: { getState: () => ({ noteTaskHub }) }
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts: { __data?: unknown }) => ({ data: opts?.__data ?? [], isSuccess: true }),
  useMutation: (opts: { mutationFn: (input: unknown) => Promise<unknown> }) => ({
    mutateAsync: opts.mutationFn
  })
}))

vi.mock('@slayzone/projects', () => ({
  ProjectSelect: ({ value }: { value?: string }) => <div data-testid="project-select">{value}</div>
}))
vi.mock('@slayzone/projects/shared', () => ({ getDefaultStatus: () => 'inbox' }))
vi.mock('@slayzone/tags/client', () => ({ CreateTagDialog: () => null }))
vi.mock('@slayzone/telemetry/client', () => ({ track: vi.fn() }))

vi.mock('@slayzone/ui', () => {
  const pass = ({ children }: { children?: React.ReactNode }) => <>{children}</>
  return {
    Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
      open ? <div>{children}</div> : null,
    DialogContent: pass,
    DialogHeader: pass,
    DialogTitle: pass,
    Form: pass,
    FormItem: pass,
    FormLabel: pass,
    FormControl: pass,
    FormMessage: () => null,
    FormField: ({ control, name, render }: any) => (
      <Controller control={control} name={name} render={render} />
    ),
    Input: (props: any) => <input {...props} />,
    Textarea: (props: any) => <textarea {...props} />,
    Button: ({ children, variant, size, ...rest }: any) => <button {...rest}>{children}</button>,
    Select: pass,
    SelectContent: pass,
    SelectItem: pass,
    SelectTrigger: pass,
    SelectValue: () => null,
    Popover: pass,
    PopoverTrigger: pass,
    PopoverContent: pass,
    Calendar: () => null,
    Checkbox: () => null,
    buildStatusOptions: () => [{ value: 'inbox', label: 'Inbox' }],
    cn: (...a: unknown[]) => a.filter(Boolean).join(' '),
    toast: { success: vi.fn(), error: vi.fn() }
  }
})

const { CreateTaskDialog } = await import('./CreateTaskDialog')

function renderDialog(projectId: string) {
  return render(
    <CreateTaskDialog
      open
      onOpenChange={() => {}}
      onCreated={() => {}}
      draft={{ projectId, title: 'Task on the VPS hub' }}
      tags={[]}
    />
  )
}

/** Submit the form (the title is pre-filled by the draft). */
function submit(): void {
  const create = screen.getAllByRole('button').find((b) => b.textContent?.startsWith('Create'))
  fireEvent.click(create as HTMLElement)
}

describe('CreateTaskDialog — hub routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ambient.task.create.mutate.mockResolvedValue({ id: 't-1', title: 'Task on the VPS hub' })
    remote.task.create.mutate.mockResolvedValue({ id: 't-1', title: 'Task on the VPS hub' })
  })
  afterEach(cleanup)

  it('creates on the hub that owns the project, never the ambient one', async () => {
    renderDialog('p-remote')
    submit()
    await waitFor(() => expect(remote.task.create.mutate).toHaveBeenCalledTimes(1))
    expect(remote.task.create.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p-remote', title: 'Task on the VPS hub' })
    )
    expect(ambient.task.create.mutate).not.toHaveBeenCalled()
  })

  it('reads the auto-worktree decision from the owning hub too', async () => {
    renderDialog('p-remote')
    submit()
    await waitFor(() => expect(remote.task.create.mutate).toHaveBeenCalled())
    expect(remote.settings.get.query).toHaveBeenCalledWith({
      key: 'auto_create_worktree_on_task_create'
    })
    expect(ambient.settings.get.query).not.toHaveBeenCalled()
  })

  it('notes the new task id against its hub so its tab opens on the right hub', async () => {
    renderDialog('p-remote')
    submit()
    await waitFor(() => expect(noteTaskHub).toHaveBeenCalledWith('t-1', 'remote-a'))
  })

  it('a default-hub project still goes through the ambient client (single-hub unchanged)', async () => {
    renderDialog('p-local')
    submit()
    await waitFor(() => expect(ambient.task.create.mutate).toHaveBeenCalledTimes(1))
    expect(remote.task.create.mutate).not.toHaveBeenCalled()
  })
})
