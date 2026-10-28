// @vitest-environment jsdom
// The project settings Tests tab: categories (glob patterns) and labels, read from
// tRPC. A category edit goes out only for a category the tab still lists — an
// effect keeps the listed ids in a ref for the async edit handlers to check.
// That effect runs when the category list changes, not on every render: while the
// categories query has no data (loading, error), the fallback list must keep one
// identity, or the effect re-runs on every render.
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TestCategory } from '../shared/types'

/** Query data by procedure name; a missing entry is a query with no data yet. */
const state = vi.hoisted(() => ({
  queryData: {} as Record<string, unknown>,
  updateCategorySpy: vi.fn(async (_input: unknown) => undefined)
}))

vi.mock('./trpc', () => {
  const proc = (name: string) => ({
    queryOptions: () => ({ name }),
    queryFilter: () => ({ name }),
    mutationOptions: () => ({ name })
  })
  // Stable: the tab keys callbacks on `trpc`.
  const trpc = {
    testPanel: new Proxy({} as Record<string, ReturnType<typeof proc>>, {
      get: (cache, name: string) => (cache[name] ??= proc(name))
    })
  }
  return { useTRPC: () => trpc }
})
vi.mock('@tanstack/react-query', () => {
  const queryClient = { invalidateQueries: () => Promise.resolve() }
  const noop = { mutate: () => {}, mutateAsync: async () => undefined }
  const update = { mutate: () => {}, mutateAsync: state.updateCategorySpy }
  return {
    useQuery: (opts: { name: string }) => ({ data: state.queryData[opts.name] }),
    useMutation: (opts: { name: string }) => (opts.name === 'updateCategory' ? update : noop),
    useQueryClient: () => queryClient
  }
})
vi.mock('@slayzone/ui', () => {
  type P = { children?: React.ReactNode }
  const Box = ({ children }: P) => <div>{children}</div>
  return {
    Input: (p: React.InputHTMLAttributes<HTMLInputElement>) => <input {...p} />,
    Button: ({ children, onClick, title }: P & { onClick?: () => void; title?: string }) => (
      <button type="button" onClick={onClick} title={title}>
        {children}
      </button>
    ),
    Separator: () => <hr />,
    Card: Box,
    CardAction: Box,
    CardContent: Box,
    CardHeader: Box,
    CardTitle: Box,
    CardDescription: Box,
    Select: Box,
    SelectContent: Box,
    SelectItem: Box,
    SelectTrigger: Box,
    SelectValue: Box,
    Tooltip: Box,
    TooltipContent: Box,
    TooltipTrigger: Box,
    Popover: Box,
    PopoverContent: Box,
    PopoverTrigger: Box,
    safeRandomUUID: () => 'uuid'
  }
})

/**
 * Counts the tab's effect runs. With @slayzone/ui and react-query stubbed above,
 * the tab's own `useEffect` is the only one in the tree.
 */
const effectRuns = vi.hoisted(() => ({ count: 0 }))
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  const useEffect: typeof actual.useEffect = (effect, deps) =>
    actual.useEffect(() => {
      effectRuns.count++
      return effect()
    }, deps)
  return { ...actual, default: { ...actual, useEffect }, useEffect }
})

import { TestsTab } from './TestsTab'

const category = (id: string, color = '#ef4444'): TestCategory => ({
  id,
  project_id: 'p1',
  name: id,
  pattern: `**/${id}.test.ts`,
  color,
  sort_order: 0
})

const renderTab = () =>
  render(<TestsTab projectId="p1" groupBy="none" onGroupByChange={() => {}} />)

beforeEach(() => {
  state.queryData = {}
  effectRuns.count = 0
  state.updateCategorySpy.mockClear()
})
afterEach(cleanup)

describe('TestsTab', () => {
  it('lists the categories and edits a listed one', () => {
    state.queryData = { getCategories: [category('unit')], getLabels: [], getProfiles: [] }
    renderTab()
    expect(screen.getByDisplayValue('unit')).toBeTruthy()

    // The swatch cycles the category's color.
    fireEvent.click(screen.getByDisplayValue('unit').previousElementSibling!)
    expect(state.updateCategorySpy).toHaveBeenCalledWith({ id: 'unit', color: '#f97316' })
  })

  it('does not re-run the category-ids effect on every render while categories load', () => {
    const view = renderTab()
    const afterMount = effectRuns.count
    for (let i = 0; i < 5; i++) {
      view.rerender(<TestsTab projectId="p1" groupBy="none" onGroupByChange={() => {}} />)
    }
    expect(effectRuns.count).toBe(afterMount)
  })

  it('re-runs the category-ids effect when the categories arrive', () => {
    const view = renderTab()
    const afterMount = effectRuns.count
    state.queryData = { getCategories: [category('unit')] }
    view.rerender(<TestsTab projectId="p1" groupBy="none" onGroupByChange={() => {}} />)
    expect(effectRuns.count).toBe(afterMount + 1)
  })
})
