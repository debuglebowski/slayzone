// @vitest-environment jsdom
/**
 * A virtualized row unmounts when scrolled away: what the user expanded must
 * come back with it, and "Collapse all" must also close rows that were not
 * mounted when it ran (plan 4.1).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatViewContext, type ChatViewState } from './ChatViewContext'
import {
  RowUiStateContext,
  RowUiStateStore,
  TimelineRowKeyContext,
  nestedRowKey,
  useRowUiState
} from './row-ui-state'

function Disclosure({ name, initial }: { name: string; initial: boolean }) {
  const [open, setOpen] = useRowUiState(name, initial, false)
  return (
    <button data-testid={name} onClick={() => setOpen(!open)}>
      {open ? 'open' : 'closed'}
    </button>
  )
}

const view = (collapseSignal: number): ChatViewState => ({
  collapseSignal,
  finalOnly: false,
  fileEditsOpenByDefault: true,
  showMessageMeta: true,
  search: { query: '', caseSensitive: false },
  timeline: [],
  childIndex: new Map()
})

function Rows({
  store,
  mounted,
  signal = 0
}: {
  store: RowUiStateStore
  mounted: string[]
  signal?: number
}) {
  return (
    <ChatViewContext.Provider value={view(signal)}>
      <RowUiStateContext.Provider value={store}>
        {mounted.map((key) => (
          <TimelineRowKeyContext.Provider key={key} value={key}>
            <Disclosure name={`${key}-card`} initial={key === 'err'} />
          </TimelineRowKeyContext.Provider>
        ))}
      </RowUiStateContext.Provider>
    </ChatViewContext.Provider>
  )
}

const label = (id: string) => screen.getByTestId(id).textContent

describe('row UI state', () => {
  afterEach(cleanup)

  it('an expanded row is still expanded after it unmounts and mounts again', () => {
    const store = new RowUiStateStore()
    const { rerender } = render(<Rows store={store} mounted={['a', 'b']} />)
    fireEvent.click(screen.getByTestId('a-card'))
    expect(label('a-card')).toBe('open')
    rerender(<Rows store={store} mounted={['b']} />)
    rerender(<Rows store={store} mounted={['a', 'b']} />)
    expect(label('a-card')).toBe('open')
    expect(label('b-card')).toBe('closed')
  })

  it('"Collapse all" closes mounted rows and rows that were off screen; a later row keeps its default', () => {
    const store = new RowUiStateStore()
    const { rerender } = render(<Rows store={store} mounted={['a', 'err']} />)
    fireEvent.click(screen.getByTestId('a-card'))
    expect(label('err-card')).toBe('open')
    // `err` scrolls away (it starts open: errors show what failed).
    rerender(<Rows store={store} mounted={['a']} />)
    act(() => store.collapseAll(['a', 'err']))
    rerender(<Rows store={store} mounted={['a']} signal={1} />)
    expect(label('a-card')).toBe('closed')
    rerender(<Rows store={store} mounted={['a', 'err']} signal={1} />)
    expect(label('err-card')).toBe('closed')
    // A row that did not exist yet when the user collapsed keeps its own default.
    rerender(<Rows store={store} mounted={['a', 'err', 'new']} signal={1} />)
    expect(label('new-card')).toBe('closed')
    store.collapseAll(['a', 'err'])
    rerender(
      <ChatViewContext.Provider value={view(1)}>
        <RowUiStateContext.Provider value={store}>
          <TimelineRowKeyContext.Provider value="err2">
            <Disclosure name="err2-card" initial />
          </TimelineRowKeyContext.Provider>
        </RowUiStateContext.Provider>
      </ChatViewContext.Provider>
    )
    expect(label('err2-card')).toBe('open')
  })

  it('a nested row (inside a sub-agent) is collapsed with its root row', () => {
    const store = new RowUiStateStore()
    const child = nestedRowKey('agent', 'tool:t1')
    render(
      <ChatViewContext.Provider value={view(0)}>
        <RowUiStateContext.Provider value={store}>
          <TimelineRowKeyContext.Provider value={child}>
            <Disclosure name="child" initial />
          </TimelineRowKeyContext.Provider>
        </RowUiStateContext.Provider>
      </ChatViewContext.Provider>
    )
    expect(store.read(child, 'child', true, false)).toBe(true)
    store.collapseAll(['agent'])
    expect(store.read(child, 'child', true, false)).toBe(false)
  })

  it('outside a timeline row it is plain state that "Collapse all" closes', () => {
    const { rerender } = render(
      <ChatViewContext.Provider value={view(0)}>
        <Disclosure name="loose" initial />
      </ChatViewContext.Provider>
    )
    expect(label('loose')).toBe('open')
    rerender(
      <ChatViewContext.Provider value={view(1)}>
        <Disclosure name="loose" initial />
      </ChatViewContext.Provider>
    )
    expect(label('loose')).toBe('closed')
  })
})
