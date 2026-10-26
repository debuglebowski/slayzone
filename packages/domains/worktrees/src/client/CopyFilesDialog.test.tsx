// @vitest-environment jsdom
// Pins CopyFilesDialog's open-time resets: folder expansion resets on every open,
// the preset list (and selected preset) is applied from settings whenever the
// open state or the persisted presets change, and the selection follows the preset.
import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { IgnoredFileNode } from '../shared/types'

type Children = { children?: React.ReactNode }
vi.mock('@slayzone/ui', () => ({
  Dialog: ({ children }: Children) => <div>{children}</div>,
  DialogContent: ({ children }: Children) => <div>{children}</div>,
  DialogHeader: ({ children }: Children) => <div>{children}</div>,
  DialogTitle: ({ children }: Children) => <div>{children}</div>,
  DialogDescription: ({ children }: Children) => <div>{children}</div>,
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
  Checkbox: ({ onCheckedChange }: { onCheckedChange: () => void }) => (
    <input type="checkbox" onChange={onCheckedChange} />
  ),
  Select: ({
    value,
    onValueChange,
    children
  }: Children & { value: string; onValueChange: (v: string) => void }) => (
    <select data-testid="preset" value={value} onChange={(e) => onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  SelectContent: ({ children }: Children) => <>{children}</>,
  SelectItem: ({ value, children }: Children & { value: string }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  cn: (...c: unknown[]) => c.filter(Boolean).join(' ')
}))

const file = (path: string): IgnoredFileNode => ({
  name: path.split('/').pop() ?? path,
  path,
  isDirectory: false,
  size: 1,
  fileCount: 1,
  children: []
})
const TREE: IgnoredFileNode[] = [
  file('.env'),
  {
    name: 'docs',
    path: 'docs',
    isDirectory: true,
    size: 0,
    fileCount: 2,
    children: [file('docs/a.md'), file('docs/b.md')]
  },
  file('cache.bin')
]

const queries: Record<string, { data: unknown; isFetched: boolean }> = {}
function setPresets(data: string | null): void {
  queries.presets = { data, isFetched: true }
}
vi.mock('@slayzone/transport/client', () => ({
  useTRPC: () => ({
    settings: {
      get: { queryOptions: (_i: unknown, o: { enabled: boolean }) => ({ k: 'presets', ...o }) }
    },
    worktrees: {
      getIgnoredFileTree: {
        queryOptions: (_i: unknown, o: { enabled: boolean }) => ({ k: 'tree', ...o })
      }
    }
  })
}))
vi.mock('@tanstack/react-query', () => ({
  useQuery: (o: { k: string; enabled: boolean }) => {
    if (o.k === 'tree') {
      return o.enabled
        ? { data: TREE, isFetching: false, isSuccess: true, isError: false }
        : { data: undefined, isFetching: false, isSuccess: false, isError: false }
    }
    return queries.presets ?? { data: undefined, isFetched: false }
  }
}))

const { CopyFilesDialog } = await import('./CopyFilesDialog')

const preset = (): string => (screen.getByTestId('preset') as HTMLSelectElement).value
const copyLabel = (): string => screen.getByText(/^Copy \d+ files?$/).textContent ?? ''

function renderDialog(open: boolean) {
  const el = (o: boolean) => (
    <CopyFilesDialog open={o} onOpenChange={vi.fn()} repoPath="/repo" onConfirm={vi.fn()} />
  )
  const r = render(el(open))
  return (o: boolean) => r.rerender(el(o))
}

afterEach(() => {
  cleanup()
  delete queries.presets
})

describe('CopyFilesDialog', () => {
  it('applies the persisted presets on open and selects by the first preset', () => {
    setPresets(
      JSON.stringify([
        { id: 'env', name: 'Env', pathGlobs: ['.env*'] },
        { id: 'all', name: 'All', pathGlobs: [] }
      ])
    )
    renderDialog(true)
    expect(preset()).toBe('env')
    expect(copyLabel()).toBe('Copy 1 file')
  })

  it('falls back to the default presets for missing or invalid settings', () => {
    setPresets('not json')
    renderDialog(true)
    expect(preset()).toBe('all-ignored')
    expect(copyLabel()).toBe('Copy 4 files')
  })

  it('a user-picked preset sticks across re-renders; reopening resets to the first', () => {
    setPresets(null)
    const rerender = renderDialog(true)
    fireEvent.change(screen.getByTestId('preset'), { target: { value: 'env-only' } })
    expect(preset()).toBe('env-only')
    expect(copyLabel()).toBe('Copy 1 file')

    rerender(true)
    expect(preset()).toBe('env-only')

    rerender(false)
    rerender(true)
    expect(preset()).toBe('all-ignored')
    expect(copyLabel()).toBe('Copy 4 files')
  })

  it('re-applies when the persisted presets change while open', () => {
    setPresets(null)
    const rerender = renderDialog(true)
    fireEvent.change(screen.getByTestId('preset'), { target: { value: 'docs-and-env' } })
    setPresets(JSON.stringify([{ id: 'only-cache', name: 'Cache', pathGlobs: ['*.bin'] }]))
    rerender(true)
    expect(preset()).toBe('only-cache')
    expect(copyLabel()).toBe('Copy 1 file')
  })

  it('collapses expanded folders on every open', () => {
    setPresets(null)
    const rerender = renderDialog(true)
    expect(screen.queryByText('a.md')).toBeNull()
    fireEvent.click(screen.getByText('docs/'))
    expect(screen.getByText('a.md')).toBeDefined()

    rerender(true)
    expect(screen.getByText('a.md')).toBeDefined()

    rerender(false)
    rerender(true)
    expect(screen.queryByText('a.md')).toBeNull()
  })
})
