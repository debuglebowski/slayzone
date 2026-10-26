import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { UndoProvider, useUndo } from './use-undo'

afterEach(() => {
  cleanup()
})

function Probe({ id }: { id: string }) {
  const { push, canUndo, undoLabel } = useUndo()
  return (
    <button type="button" onClick={() => push({ label: `act-${id}`, undo: () => {} })}>
      {id}:{canUndo ? undoLabel : 'empty'}
    </button>
  )
}

function Rerenderer({ children }: { children: ReactNode }) {
  const [n, setN] = useState(0)
  return (
    <>
      <button type="button" onClick={() => setN((x) => x + 1)}>
        rerender {n}
      </button>
      {children}
    </>
  )
}

describe('UndoProvider', () => {
  it('keeps one stack across provider re-renders', () => {
    function Host() {
      const [n, setN] = useState(0)
      return (
        <>
          <button type="button" onClick={() => setN((x) => x + 1)}>
            host {n}
          </button>
          <UndoProvider>
            <Probe id="a" />
          </UndoProvider>
        </>
      )
    }
    render(<Host />)
    act(() => {
      screen.getByText('a:empty').click()
    })
    expect(screen.getByText('a:act-a')).toBeTruthy()
    act(() => {
      screen.getByText('host 0').click()
    })
    expect(screen.getByText('a:act-a')).toBeTruthy()
  })

  it('gives each provider its own stack', () => {
    render(
      <Rerenderer>
        <UndoProvider>
          <Probe id="a" />
        </UndoProvider>
        <UndoProvider>
          <Probe id="b" />
        </UndoProvider>
      </Rerenderer>
    )
    act(() => {
      screen.getByText('a:empty').click()
    })
    expect(screen.getByText('a:act-a')).toBeTruthy()
    expect(screen.getByText('b:empty')).toBeTruthy()
  })
})
