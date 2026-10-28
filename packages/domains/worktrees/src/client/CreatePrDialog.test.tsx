// @vitest-environment jsdom
// Pins CreatePrDialog's base-branch resolution: the task's parent branch wins;
// otherwise, while open, the resolved default branch (or 'main' on failure).
import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { Task } from '@slayzone/task-contracts'

type Children = { children?: React.ReactNode }
vi.mock('@slayzone/ui', () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Checkbox: () => null,
  Dialog: ({ children }: Children) => <div>{children}</div>,
  DialogContent: ({ children }: Children) => <div>{children}</div>,
  DialogHeader: ({ children }: Children) => <div>{children}</div>,
  DialogTitle: ({ children }: Children) => <div>{children}</div>,
  DialogDescription: ({ children }: Children) => <div data-testid="into">{children}</div>
}))
vi.mock('./pr-badges', () => ({ PrStateIcon: () => null }))

let branchQuery: { isSuccess: boolean; isError: boolean; data: string | null | undefined } = {
  isSuccess: false,
  isError: false,
  data: undefined
}
const queryEnabled = vi.fn()
vi.mock('@slayzone/transport/client', () => ({
  useTRPC: () => ({
    worktrees: {
      getDefaultBranch: {
        queryOptions: (_input: unknown, opts: { enabled: boolean }) => opts
      },
      createPr: { mutationOptions: () => ({}) }
    }
  })
}))
vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts: { enabled: boolean }) => {
    queryEnabled(opts.enabled)
    return branchQuery
  },
  useMutation: () => ({ mutateAsync: vi.fn() })
}))

const { CreatePrDialog } = await import('./pr-dialogs')

const task = (parent: string | null): Task =>
  ({ id: 't1', title: 'Feature', worktree_path: '/wt', worktree_parent_branch: parent }) as Task

const into = (): string => screen.getByTestId('into').textContent ?? ''

function renderDialog(p: { open: boolean; parent: string | null }) {
  const el = (q: typeof p) => (
    <CreatePrDialog
      open={q.open}
      onOpenChange={vi.fn()}
      task={task(q.parent)}
      projectPath="/repo"
      onCreated={vi.fn()}
    />
  )
  const r = render(el(p))
  return (q: typeof p) => r.rerender(el(q))
}

afterEach(() => {
  cleanup()
  branchQuery = { isSuccess: false, isError: false, data: undefined }
  queryEnabled.mockReset()
})

describe('CreatePrDialog base branch', () => {
  it('uses the task parent branch and ignores the default-branch query', () => {
    branchQuery = { isSuccess: true, isError: false, data: 'develop' }
    renderDialog({ open: true, parent: 'release' })
    expect(into()).toBe('Into release')
    expect(queryEnabled).toHaveBeenLastCalledWith(false)
  })

  it('applies the resolved default branch once it loads (cached on mount too)', () => {
    branchQuery = { isSuccess: true, isError: false, data: 'trunk' }
    renderDialog({ open: true, parent: null })
    expect(into()).toBe('Into trunk')
  })

  it('follows the query while open: pending → data → error falls back to main', () => {
    const rerender = renderDialog({ open: true, parent: null })
    expect(into()).toBe('Into ')

    branchQuery = { isSuccess: true, isError: false, data: 'develop' }
    rerender({ open: true, parent: null })
    expect(into()).toBe('Into develop')

    branchQuery = { isSuccess: false, isError: true, data: undefined }
    rerender({ open: true, parent: null })
    expect(into()).toBe('Into main')

    branchQuery = { isSuccess: true, isError: false, data: null }
    rerender({ open: true, parent: null })
    expect(into()).toBe('Into main')
  })

  it('does not apply while closed; applies on open', () => {
    const rerender = renderDialog({ open: false, parent: null })
    branchQuery = { isSuccess: true, isError: false, data: 'develop' }
    rerender({ open: false, parent: null })
    expect(into()).toBe('Into ')
    rerender({ open: true, parent: null })
    expect(into()).toBe('Into develop')
  })
})
