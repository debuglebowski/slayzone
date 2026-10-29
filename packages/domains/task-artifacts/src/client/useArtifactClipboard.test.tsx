// @vitest-environment jsdom
// Multi-select follows single-select changes made from outside (imperative
// handle, search panel): a new selection collapses it to that artifact, one
// already in the multi-select keeps it. Task tabs live in <Activity>: hiding and
// re-showing the tab is not a selection change and keeps the multi-select.
import { Activity, useState } from 'react'
import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'

vi.mock('./trpc', () => {
  const options = { mutationOptions: () => ({}), queryOptions: () => ({}) }
  const proxy = new Proxy({}, { get: () => options })
  return {
    useTRPC: () => ({ app: { clipboard: proxy }, artifacts: proxy })
  }
})
vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutateAsync: vi.fn() }),
  useQueryClient: () => ({ fetchQuery: vi.fn() })
}))

const { useArtifactClipboard } = await import('./useArtifactClipboard')

const IDS = ['a1', 'a2', 'a3']
let latest: {
  api: ReturnType<typeof useArtifactClipboard>
  selectedId: string | null
  setSelectedId: (id: string | null) => void
}

function Probe({ initialSelectedId }: { initialSelectedId: string | null }) {
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId)
  const api = useArtifactClipboard({
    taskId: 't1',
    artifacts: [],
    selectedId,
    setSelectedId,
    deleteArtifact: async () => undefined,
    getFilePath: async () => null,
    flatArtifactIds: IDS
  })
  latest = { api, selectedId, setSelectedId }
  return null
}

function Tab({
  mode,
  initialSelectedId = 'a1'
}: {
  mode: 'visible' | 'hidden'
  initialSelectedId?: string | null
}) {
  return (
    <Activity mode={mode}>
      <Probe initialSelectedId={initialSelectedId} />
    </Activity>
  )
}

afterEach(cleanup)

const selected = () => [...latest.api.selectedIds].sort()
const click = (id: string, mods: Partial<React.MouseEvent> = {}) =>
  act(() => latest.api.handleArtifactClick({ ...mods } as React.MouseEvent, id))

describe('useArtifactClipboard multi-select', () => {
  it('starts as the current selection', () => {
    render(<Tab mode="visible" />)
    expect(selected()).toEqual(['a1'])
  })

  it('starts empty without a selection', () => {
    render(<Tab mode="visible" initialSelectedId={null} />)
    expect(selected()).toEqual([])
  })

  it('an outside selection change collapses the multi-select to it', async () => {
    render(<Tab mode="visible" />)
    await click('a2', { metaKey: true })
    expect(selected()).toEqual(['a1', 'a2'])

    act(() => latest.setSelectedId('a3'))
    expect(selected()).toEqual(['a3'])
  })

  it('an outside selection of an artifact already in the multi-select keeps it', async () => {
    render(<Tab mode="visible" />)
    await click('a2', { metaKey: true })
    await click('a3', { metaKey: true })
    expect(selected()).toEqual(['a1', 'a2', 'a3'])

    act(() => latest.setSelectedId('a1'))
    expect(selected()).toEqual(['a1', 'a2', 'a3'])
  })

  it('a multi-select survives hiding and re-showing the tab', async () => {
    const view = render(<Tab mode="visible" />)
    await click('a2', { metaKey: true })
    await click('a3', { metaKey: true })
    // ⌘-click the current artifact again: it leaves the multi-select, stays current.
    await click('a3', { metaKey: true })
    expect(selected()).toEqual(['a1', 'a2'])
    expect(latest.selectedId).toBe('a3')

    view.rerender(<Tab mode="hidden" />)
    view.rerender(<Tab mode="visible" />)
    expect(selected()).toEqual(['a1', 'a2'])
  })
})
