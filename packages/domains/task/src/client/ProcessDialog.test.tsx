// @vitest-environment jsdom
// Pins ProcessDialog's form reset: the form, error and saving flag reset whenever
// the edited process or the open state changes — and only then.
import type React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ProcessEntry } from './ProcessesPanel.types'

type Children = { children?: React.ReactNode }
// Content always rendered (open is exposed as an attribute) so the form state can
// be inspected across close/reopen.
vi.mock('@slayzone/ui', () => ({
  Dialog: ({ open, children }: Children & { open: boolean }) => (
    <div data-testid="dialog" data-open={String(open)}>
      {children}
    </div>
  ),
  DialogContent: ({ children }: Children) => <div>{children}</div>,
  DialogHeader: ({ children }: Children) => <div>{children}</div>,
  DialogTitle: ({ children }: Children) => <h2>{children}</h2>,
  DialogFooter: ({ children }: Children) => <div>{children}</div>,
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Label: ({ children }: Children) => <span>{children}</span>,
  Tooltip: ({ children }: Children) => <>{children}</>,
  TooltipTrigger: ({ children }: Children) => <>{children}</>,
  TooltipContent: () => null,
  cn: (...c: unknown[]) => c.filter(Boolean).join(' ')
}))

const update = vi.fn()
const create = vi.fn()
vi.mock('@slayzone/transport/client', () => ({
  useTRPC: () => ({
    processes: {
      update: { mutationOptions: () => ({ k: 'update' }) },
      create: { mutationOptions: () => ({ k: 'create' }) },
      spawn: { mutationOptions: () => ({ k: 'spawn' }) },
      restart: { mutationOptions: () => ({ k: 'restart' }) }
    }
  })
}))
vi.mock('@tanstack/react-query', () => ({
  useMutation: (o: { k: string }) => ({
    mutateAsync: o.k === 'update' ? update : o.k === 'create' ? create : vi.fn()
  })
}))

const { ProcessDialog } = await import('./ProcessDialog')

const proc = (over: Partial<ProcessEntry>): ProcessEntry =>
  ({
    id: 'p1',
    taskId: 't1',
    projectId: null,
    label: 'Frontend',
    command: 'npm run dev',
    autoRestart: true,
    ...over
  }) as ProcessEntry

beforeEach(() => {
  update.mockReset()
  create.mockReset()
})
afterEach(cleanup)

function renderDialog(props: { open: boolean; process: ProcessEntry | null }) {
  const onOpenChange = vi.fn()
  const onSaved = vi.fn()
  const el = (p: { open: boolean; process: ProcessEntry | null }) => (
    <ProcessDialog
      open={p.open}
      onOpenChange={onOpenChange}
      process={p.process}
      taskId="t1"
      projectId="proj"
      cwd="/repo"
      onSaved={onSaved}
      onSpawned={vi.fn()}
    />
  )
  const r = render(el(props))
  return { ...r, rerenderWith: (p: typeof props) => r.rerender(el(p)), onOpenChange, onSaved }
}

const labelInput = (): HTMLInputElement =>
  screen.getByPlaceholderText('e.g. Frontend') as HTMLInputElement
const commandInput = (): HTMLInputElement =>
  screen.getByPlaceholderText('e.g. npm run dev') as HTMLInputElement
const autoRestart = (): HTMLInputElement => screen.getByRole('checkbox') as HTMLInputElement
const scopeHint = (): string =>
  screen.getByText(/Stopped when this task|Shared across all tasks/).textContent ?? ''

describe('ProcessDialog', () => {
  it('mounts with the edited process loaded (task scope from taskId)', () => {
    const a = proc({})
    renderDialog({ open: true, process: a })
    expect(labelInput().value).toBe('Frontend')
    expect(commandInput().value).toBe('npm run dev')
    expect(autoRestart().checked).toBe(true)
    expect(scopeHint()).toMatch(/Stopped when this task/)
  })

  it('mounts empty (project scope) for a new process', () => {
    renderDialog({ open: false, process: null })
    expect(labelInput().value).toBe('')
    expect(commandInput().value).toBe('')
    expect(autoRestart().checked).toBe(false)
    expect(scopeHint()).toMatch(/Shared across all tasks/)
  })

  it('keeps edits across re-renders, resets on close and on process switch', () => {
    const a = proc({})
    const { rerenderWith } = renderDialog({ open: true, process: a })
    fireEvent.change(labelInput(), { target: { value: 'Edited' } })
    rerenderWith({ open: true, process: a })
    expect(labelInput().value).toBe('Edited')

    rerenderWith({ open: false, process: a })
    expect(labelInput().value).toBe('Frontend')

    fireEvent.change(labelInput(), { target: { value: 'Edited again' } })
    const b = proc({ id: 'p2', label: 'Backend', taskId: null, autoRestart: false })
    rerenderWith({ open: false, process: b })
    expect(labelInput().value).toBe('Backend')
    expect(autoRestart().checked).toBe(false)
    expect(scopeHint()).toMatch(/Shared across all tasks/)

    rerenderWith({ open: true, process: null })
    expect(labelInput().value).toBe('')
  })

  it('a failed save shows the error until the dialog is reopened', async () => {
    const a = proc({})
    update.mockRejectedValue(new Error('boom'))
    const { rerenderWith, onOpenChange } = renderDialog({ open: true, process: a })
    await act(async () => {
      fireEvent.click(screen.getByText('Update'))
    })
    expect(screen.getByText('boom')).toBeDefined()
    expect(onOpenChange).not.toHaveBeenCalled()

    rerenderWith({ open: true, process: a })
    expect(screen.queryByText('boom')).not.toBeNull()

    rerenderWith({ open: false, process: a })
    expect(screen.queryByText('boom')).toBeNull()
  })

  it('a successful save hands off and asks to close', async () => {
    const a = proc({})
    update.mockResolvedValue(undefined)
    const { onOpenChange, onSaved } = renderDialog({ open: true, process: a })
    fireEvent.change(labelInput(), { target: { value: ' Web ' } })
    await act(async () => {
      fireEvent.click(screen.getByText('Update'))
    })
    expect(update).toHaveBeenCalledWith({
      processId: 'p1',
      updates: {
        label: 'Web',
        command: 'npm run dev',
        autoRestart: true,
        taskId: 't1',
        projectId: null
      }
    })
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
