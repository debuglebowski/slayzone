import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { MountWhenOpened } from './mount-when-opened'
import { Dialog, DialogContent, DialogTitle } from './dialog'

let mounts = 0
function Probe({ open }: { open: boolean }) {
  const [count, setCount] = useState(0)
  useState(() => {
    mounts++
  })
  return (
    <Dialog open={open}>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle>Probe dialog</DialogTitle>
        <button onClick={() => setCount((c) => c + 1)}>clicks {count}</button>
      </DialogContent>
    </Dialog>
  )
}

function Host({ open }: { open: boolean }) {
  return (
    <MountWhenOpened open={open}>
      <Probe open={open} />
    </MountWhenOpened>
  )
}

describe('MountWhenOpened', () => {
  afterEach(cleanup)

  it('mounts nothing while never opened', () => {
    mounts = 0
    const { container, rerender } = render(<Host open={false} />)
    rerender(<Host open={false} />)
    expect(mounts).toBe(0)
    expect(container.innerHTML).toBe('')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the dialog in the same commit that opens it', () => {
    mounts = 0
    const { rerender } = render(<Host open={false} />)
    rerender(<Host open={true} />)
    expect(mounts).toBe(1)
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('mounts open when initially open', () => {
    mounts = 0
    render(<Host open={true} />)
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('stays mounted after close: dialog hides, state survives reopen', () => {
    mounts = 0
    const { rerender } = render(<Host open={true} />)
    act(() => screen.getByRole('button', { name: 'clicks 0' }).click())
    rerender(<Host open={false} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    rerender(<Host open={true} />)
    expect(screen.getByRole('button', { name: 'clicks 1' })).toBeTruthy()
    expect(mounts).toBe(1)
  })
})
