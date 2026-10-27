// @vitest-environment jsdom
// Pins ProjectPrTab's persisted-filter seeding: the editable filter is (re)seeded
// from the persisted value whenever the key / load state / value changes, and a
// local edit survives re-renders that change none of those.
import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { GhPullRequest } from '../shared/types'

vi.mock('@slayzone/ui', () => ({
  cn: (...c: unknown[]) => c.filter(Boolean).join(' '),
  PulseGrid: () => <div>loading</div>
}))

const PRS: GhPullRequest[] = [
  {
    number: 1,
    title: 'Alpha',
    body: '',
    url: 'https://gh/1',
    state: 'OPEN',
    headRefName: 'a',
    baseRefName: 'main',
    isCrossRepository: false,
    isDraft: false,
    author: 'ann',
    createdAt: new Date().toISOString(),
    reviewDecision: '',
    statusCheckRollup: ''
  }
]

let filterQuery: { isSuccess: boolean; data: string | null | undefined } = {
  isSuccess: false,
  data: undefined
}
const filterKeys: string[] = []
vi.mock('@slayzone/transport/client', () => ({
  useTRPC: () => ({
    app: { shell: { openExternal: { mutationOptions: () => ({}) } } },
    settings: {
      get: { queryOptions: (input: { key: string }) => ({ k: 'filter', key: input.key }) },
      set: { mutationOptions: () => ({}) }
    },
    worktrees: {
      listOpenPrs: { queryOptions: () => ({ k: 'prs' }) },
      detectWorktrees: { queryOptions: () => ({ k: 'worktrees' }) }
    }
  })
}))
vi.mock('@tanstack/react-query', () => ({
  useQuery: (o: { k: string; key?: string }) => {
    if (o.k === 'prs') return { data: PRS, isPending: false, error: null }
    if (o.k === 'worktrees') return { data: [] }
    filterKeys.push(o.key ?? '')
    return filterQuery
  },
  useMutation: () => ({ mutate: vi.fn() })
}))

const { ProjectPrTab } = await import('./ProjectPrTab')

const sortSelect = (): HTMLSelectElement => screen.getAllByRole('combobox')[0] as HTMLSelectElement
const reviewSelect = (): HTMLSelectElement =>
  screen.getAllByRole('combobox')[1] as HTMLSelectElement

function renderTab(projectPath: string) {
  const el = (p: string): React.ReactElement => <ProjectPrTab projectPath={p} visible tasks={[]} />
  const r = render(el(projectPath))
  return (p: string) => r.rerender(el(p))
}

afterEach(() => {
  cleanup()
  filterQuery = { isSuccess: false, data: undefined }
  filterKeys.length = 0
})

describe('ProjectPrTab filter seeding', () => {
  it('seeds from the persisted value (merged over defaults) once loaded', () => {
    filterQuery = { isSuccess: true, data: JSON.stringify({ sortBy: 'title' }) }
    renderTab('/repo')
    expect(filterKeys.at(-1)).toBe('pr-filter:/repo')
    expect(sortSelect().value).toBe('title')
    expect(reviewSelect().value).toBe('')
  })

  it('keeps defaults until loaded, then seeds; a local edit survives plain re-renders', () => {
    const rerender = renderTab('/repo')
    expect(sortSelect().value).toBe('newest')

    filterQuery = { isSuccess: true, data: JSON.stringify({ filterReview: 'APPROVED' }) }
    rerender('/repo')
    expect(reviewSelect().value).toBe('APPROVED')

    fireEvent.change(sortSelect(), { target: { value: 'oldest' } })
    rerender('/repo')
    expect(sortSelect().value).toBe('oldest')
    expect(reviewSelect().value).toBe('APPROVED')

    // A new persisted value re-seeds (overwrites the local edit).
    filterQuery = { isSuccess: true, data: JSON.stringify({ sortBy: 'title' }) }
    rerender('/repo')
    expect(sortSelect().value).toBe('title')
    expect(reviewSelect().value).toBe('')
  })

  it('ignores empty or invalid persisted values (keeps the current filter)', () => {
    filterQuery = { isSuccess: true, data: JSON.stringify({ sortBy: 'title' }) }
    const rerender = renderTab('/repo')
    filterQuery = { isSuccess: true, data: 'not json' }
    rerender('/repo')
    expect(sortSelect().value).toBe('title')
    filterQuery = { isSuccess: true, data: null }
    rerender('/repo')
    expect(sortSelect().value).toBe('title')
  })

  it('a project switch keeps the filter until the new project value arrives', () => {
    filterQuery = { isSuccess: true, data: JSON.stringify({ sortBy: 'title' }) }
    const rerender = renderTab('/repo-a')
    filterQuery = { isSuccess: false, data: undefined }
    rerender('/repo-b')
    expect(filterKeys.at(-1)).toBe('pr-filter:/repo-b')
    expect(sortSelect().value).toBe('title')

    filterQuery = { isSuccess: true, data: JSON.stringify({ sortBy: 'oldest' }) }
    rerender('/repo-b')
    expect(sortSelect().value).toBe('oldest')
  })
})
