// @vitest-environment jsdom
// Pins CopyFilesDialog: folder expansion resets on every open, the preset list (and
// selected preset) is applied from settings whenever the open state or the persisted
// presets change, and the selection follows the preset. The tree is LAZY: it opens an
// index (`worktrees.openIgnoredTree`), a folder's children load when it is expanded
// (page by page), and a preset's selection is matched by the index — never one whole
// tree in the renderer.
import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { IGNORED_TREE_EXPIRED } from '../shared/ignored-tree'
import { IgnoredIndex, IGNORED_TREE_PAGE_ITEMS } from '../server/ignored-index'

type Children = { children?: React.ReactNode }
vi.mock('@slayzone/ui', async (importOriginal) => ({
  useDepsChanged: (await importOriginal<typeof import('@slayzone/ui')>()).useDepsChanged,
  Dialog: ({ children }: Children) => <div>{children}</div>,
  DialogContent: ({ children }: Children) => <div>{children}</div>,
  DialogHeader: ({ children }: Children) => <div>{children}</div>,
  DialogTitle: ({ children }: Children) => <div>{children}</div>,
  DialogDescription: ({ children }: Children) => <div>{children}</div>,
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
  Checkbox: ({ onCheckedChange, checked }: { onCheckedChange: () => void; checked: unknown }) => (
    <input
      type="checkbox"
      data-state={checked === 'indeterminate' ? 'indeterminate' : checked ? 'checked' : 'unchecked'}
      onChange={onCheckedChange}
    />
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

/** The repo's ignored files: .env, cache.bin, docs/a.md, docs/b.md. */
let PATHS = ['.env', 'cache.bin', 'docs/a.md', 'docs/b.md']

const queries: Record<string, { data: unknown; isFetched: boolean }> = {}
function setPresets(data: string | null): void {
  queries.presets = { data, isFetched: true }
}

/** The index host: answers the three ops like the computer does. */
let openMode: 'success' | 'error' | 'pending' = 'success'
let releaseOpen: (() => void) | null = null
const held = new Map<string, IgnoredIndex>()
const calls: string[] = []
let ids = 0
/** The next preset matches that fail (a transient host error). */
let matchFailures = 0
const get = (id: string) => {
  const i = held.get(id)
  if (!i) throw new Error(`${IGNORED_TREE_EXPIRED}: gone`)
  return i
}
const client = {
  worktrees: {
    openIgnoredTree: {
      query: async () => {
        calls.push('open')
        if (openMode === 'error') throw new Error('not a repo')
        if (openMode === 'pending') await new Promise<void>((r) => (releaseOpen = r))
        const index = IgnoredIndex.build([...PATHS])
        const treeId = `t${++ids}`
        held.set(treeId, index)
        return { treeId, totalFiles: index.totalFiles, root: index.page('', null) }
      }
    },
    listIgnoredTree: {
      query: async (i: { treeId: string; dir: string; cursor: string | null }) => {
        calls.push(`list ${i.dir}`)
        return get(i.treeId).page(i.dir, i.cursor)
      }
    },
    matchIgnoredTree: {
      query: async (i: { treeId: string; globs: string[]; cursor: string | null }) => {
        if (matchFailures > 0) {
          matchFailures--
          throw new Error('computer reconnecting')
        }
        return get(i.treeId).matchPage(i.globs, i.cursor)
      }
    }
  }
}
vi.mock('./trpc', () => ({
  useTRPC: () => ({
    settings: {
      get: { queryOptions: (_i: unknown, o: { enabled: boolean }) => ({ k: 'presets', ...o }) }
    }
  }),
  useTRPCClient: () => client
}))
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => queries.presets ?? { data: undefined, isFetched: false }
}))

const { CopyFilesDialog } = await import('./CopyFilesDialog')

const preset = (): string => (screen.getByTestId('preset') as HTMLSelectElement).value
const copyLabel = (): string => screen.getByText(/^Copy \d+ files?$/).textContent ?? ''
const expectCopy = (label: string) => waitFor(() => expect(copyLabel()).toBe(label))

function renderDialog(open: boolean, onConfirm = vi.fn()) {
  const el = (o: boolean) => (
    <CopyFilesDialog open={o} onOpenChange={vi.fn()} repoPath="/repo" onConfirm={onConfirm} />
  )
  const r = render(el(open))
  return (o: boolean) => r.rerender(el(o))
}

afterEach(() => {
  cleanup()
  delete queries.presets
  openMode = 'success'
  releaseOpen = null
  held.clear()
  calls.length = 0
  matchFailures = 0
  PATHS = ['.env', 'cache.bin', 'docs/a.md', 'docs/b.md']
})

describe('CopyFilesDialog', () => {
  it('applies the persisted presets on open and selects by the first preset', async () => {
    setPresets(
      JSON.stringify([
        { id: 'env', name: 'Env', pathGlobs: ['.env*'] },
        { id: 'all', name: 'All', pathGlobs: [] }
      ])
    )
    renderDialog(true)
    expect(preset()).toBe('env')
    await expectCopy('Copy 1 file')
  })

  it('falls back to the default presets for missing or invalid settings', async () => {
    setPresets('not json')
    renderDialog(true)
    expect(preset()).toBe('all-ignored')
    await expectCopy('Copy 4 files')
  })

  it('a user-picked preset sticks across re-renders; reopening resets to the first', async () => {
    setPresets(null)
    const rerender = renderDialog(true)
    await expectCopy('Copy 4 files')
    fireEvent.change(screen.getByTestId('preset'), { target: { value: 'env-only' } })
    expect(preset()).toBe('env-only')
    await expectCopy('Copy 1 file')

    rerender(true)
    expect(preset()).toBe('env-only')

    rerender(false)
    rerender(true)
    expect(preset()).toBe('all-ignored')
    await expectCopy('Copy 4 files')
  })

  it('re-applies when the persisted presets change while open', async () => {
    setPresets(null)
    const rerender = renderDialog(true)
    fireEvent.change(screen.getByTestId('preset'), { target: { value: 'docs-and-env' } })
    setPresets(JSON.stringify([{ id: 'only-cache', name: 'Cache', pathGlobs: ['*.bin'] }]))
    rerender(true)
    expect(preset()).toBe('only-cache')
    await expectCopy('Copy 1 file')
  })

  it('loads a folder’s children when it is expanded; collapses folders on every open', async () => {
    setPresets(null)
    const rerender = renderDialog(true)
    await screen.findByText('docs/')
    expect(calls).toEqual(['open'])
    expect(screen.queryByText('a.md')).toBeNull()
    fireEvent.click(screen.getByText('docs/'))
    expect(await screen.findByText('a.md')).toBeDefined()
    expect(calls).toEqual(['open', 'list docs'])

    rerender(true)
    expect(screen.getByText('a.md')).toBeDefined()

    rerender(false)
    rerender(true)
    await screen.findByText('docs/')
    expect(screen.queryByText('a.md')).toBeNull()
  })

  it('a failed ignored-file scan settles on the empty state', async () => {
    setPresets(null)
    openMode = 'error'
    renderDialog(true)
    expect(await screen.findByText('No ignored files found.')).toBeDefined()
    expect(preset()).toBe('all-ignored')
    expect(copyLabel()).toBe('Copy 0 files')
    fireEvent.change(screen.getByTestId('preset'), { target: { value: 'env-only' } })
    expect(preset()).toBe('env-only')
    expect(copyLabel()).toBe('Copy 0 files')
  })

  it('applies the preset selection once the scan lands', async () => {
    setPresets(JSON.stringify([{ id: 'env', name: 'Env', pathGlobs: ['.env*'] }]))
    openMode = 'pending'
    renderDialog(true)
    expect(screen.getByText('Scanning ignored files…')).toBeDefined()
    expect(copyLabel()).toBe('Copy 0 files')
    await waitFor(() => expect(releaseOpen).not.toBeNull())
    await act(async () => releaseOpen?.())
    expect(preset()).toBe('env')
    await expectCopy('Copy 1 file')
  })

  it('a preset match that fails shows a retry instead of silently copying 0 files', async () => {
    setPresets(JSON.stringify([{ id: 'env', name: 'Env', pathGlobs: ['.env*'] }]))
    matchFailures = 1
    renderDialog(true)
    const retry = await screen.findByRole('button', { name: /could not apply the preset/i })
    expect(copyLabel()).toBe('Copy 0 files')
    fireEvent.click(retry)
    await expectCopy('Copy 1 file')
    expect(screen.queryByRole('button', { name: /could not apply the preset/i })).toBeNull()
  })

  it('a manual toggle switches to Custom and the selection sticks', async () => {
    setPresets(null)
    const rerender = renderDialog(true)
    await expectCopy('Copy 4 files')
    // Rows: docs/, .env, cache.bin — uncheck cache.bin.
    fireEvent.click(screen.getAllByRole('checkbox')[2])
    expect(preset()).toBe('custom')
    await expectCopy('Copy 3 files')
    rerender(true)
    expect(preset()).toBe('custom')
    expect(copyLabel()).toBe('Copy 3 files')
    // Picking a preset again re-applies its selection.
    fireEvent.change(screen.getByTestId('preset'), { target: { value: 'all-ignored' } })
    await expectCopy('Copy 4 files')
  })

  it('reopening re-applies the first preset over a manual selection', async () => {
    setPresets(null)
    const rerender = renderDialog(true)
    await expectCopy('Copy 4 files')
    fireEvent.click(screen.getAllByRole('checkbox')[2])
    await expectCopy('Copy 3 files')
    rerender(false)
    rerender(true)
    expect(preset()).toBe('all-ignored')
    await expectCopy('Copy 4 files')
  })

  it('unchecking a file inside a selected folder keeps its siblings (loading every page first)', async () => {
    PATHS = [
      'wide/x',
      ...Array.from({ length: IGNORED_TREE_PAGE_ITEMS + 2 }, (_, n) => `wide/f${n}`)
    ]
    setPresets(null)
    const onConfirm = vi.fn()
    renderDialog(true, onConfirm)
    await expectCopy(`Copy ${PATHS.length} files`)
    fireEvent.click(screen.getByText('wide/'))
    // One page of the wide folder, plus a way to the rest.
    expect(await screen.findByText('Load more')).toBeDefined()
    // Rows: wide/, then its first page (sorted: f0, f1, f10, …).
    fireEvent.click(screen.getAllByRole('checkbox')[1])
    await expectCopy(`Copy ${PATHS.length - 1} files`)
    fireEvent.click(screen.getByText(`Copy ${PATHS.length - 1} files`))
    const choice = onConfirm.mock.calls[0][0] as { mode: string; paths: string[] }
    expect(choice.mode).toBe('custom')
    expect(choice.paths.length).toBe(PATHS.length - 1)
    expect(choice.paths).not.toContain('wide')
    expect(choice.paths).toContain('wide/x')
  })

  it('Load more appends the next page of a folder', async () => {
    PATHS = Array.from(
      { length: IGNORED_TREE_PAGE_ITEMS + 2 },
      (_, n) => `wide/f${String(n).padStart(5, '0')}`
    )
    setPresets(null)
    renderDialog(true)
    fireEvent.click(await screen.findByText('wide/'))
    fireEvent.click(await screen.findByText('Load more'))
    expect(
      await screen.findByText(`f${String(IGNORED_TREE_PAGE_ITEMS + 1).padStart(5, '0')}`)
    ).toBeDefined()
    expect(screen.queryByText('Load more')).toBeNull()
  })

  it('an index that expired is reopened and the folder still loads', async () => {
    setPresets(null)
    renderDialog(true)
    await screen.findByText('docs/')
    held.clear()
    fireEvent.click(screen.getByText('docs/'))
    expect(await screen.findByText('a.md')).toBeDefined()
    expect(calls.filter((c) => c === 'open').length).toBe(2)
  })
})
