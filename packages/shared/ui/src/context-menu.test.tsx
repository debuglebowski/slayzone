import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from './context-menu'

afterEach(cleanup)

function openMenu(onSelect: () => void) {
  render(
    <ContextMenu>
      <ContextMenuTrigger>Task</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onSelect}>Duplicate</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
  fireEvent.contextMenu(screen.getByText('Task'), { clientX: 200, clientY: 200 })
  return screen.getByRole('menuitem', { name: 'Duplicate' })
}

function pointer(type: string, init: MouseEventInit & { movementX?: number; movementY?: number }) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init })
  Object.defineProperties(event, {
    pointerType: { value: 'mouse' },
    movementX: { value: init.movementX ?? 0 },
    movementY: { value: init.movementY ?? 0 }
  })
  return event
}

describe('ContextMenu pointer release', () => {
  it('does not select an item appearing under the opening right-click release', () => {
    const onSelect = vi.fn()
    const item = openMenu(onSelect)
    // A tall menu is shifted up to fit the viewport, placing an item under
    // the original pointer before the opening right-button release arrives.
    fireEvent(item, pointer('pointerup', { button: 2 }))
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('preserves deliberate right-button drag selection', () => {
    const onSelect = vi.fn()
    const item = openMenu(onSelect)
    fireEvent(item, pointer('pointermove', { buttons: 2, movementX: 10, movementY: 10 }))
    fireEvent(item, pointer('pointerup', { button: 2 }))
    expect(onSelect).toHaveBeenCalledOnce()
  })

  it('preserves primary clicks and keyboard selection', () => {
    const onSelect = vi.fn()
    fireEvent.click(openMenu(onSelect))
    expect(onSelect).toHaveBeenCalledOnce()
    cleanup()
    fireEvent.keyDown(openMenu(onSelect), { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledTimes(2)
  })
})
