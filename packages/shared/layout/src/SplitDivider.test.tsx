// @vitest-environment jsdom
// A divider unmounted mid-drag drops its document listeners and clears the
// engine's drag flag, so the occlusion policy never sticks in "dragging".
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SplitDivider } from './SplitDivider'

afterEach(cleanup)

describe('SplitDivider', () => {
  it('unmounted mid-drag clears the drag flag and stops resizing', () => {
    const onDragChange = vi.fn()
    const onResize = vi.fn()
    const ui = render(
      <SplitDivider
        splitId="s1"
        index={0}
        rect={{ x: 0, y: 0, w: 4, h: 100 }}
        direction="row"
        childMinsPx={[10, 10]}
        totalContentPx={200}
        getFractions={() => [0.5, 0.5]}
        onResize={onResize}
        onDragChange={onDragChange}
      />
    )
    fireEvent.mouseDown(screen.getByTestId('split-divider'), { clientX: 100 })
    expect(onDragChange.mock.calls).toEqual([['s1']])

    ui.unmount()
    expect(onDragChange.mock.calls).toEqual([['s1'], [null]])
    fireEvent.mouseMove(document, { clientX: 150 })
    expect(onResize).not.toHaveBeenCalled()
  })
})
