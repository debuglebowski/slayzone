// @vitest-environment jsdom
// Pins panels surviving moves (docs/plans/panel-model.md step 7): a panel renders
// once, keyed by instance id, into a host node its target adopts. Moving its target
// to another group moves the DOM; the panel never remounts and keeps its state.
import { afterEach, describe, expect, it } from 'vitest'
import { useEffect, useState } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import type { PanelInstance } from '@slayzone/task-contracts'
import { PanelHosts, PanelNodePool, PanelNodePoolContext, PanelTarget } from './PanelHosts'
import type { PanelPlacement } from './strip'

let mounts = 0
let unmounts = 0

function Probe({ id }: { id: string }): React.JSX.Element {
  const [n, setN] = useState(0)
  useEffect(() => {
    mounts++
    return () => {
      unmounts++
    }
  }, [])
  return (
    <button type="button" data-probe={id} onClick={() => setN((v) => v + 1)}>
      {n}
    </button>
  )
}

const inst = (id: string): PanelInstance => ({ id, kind: 'editor', settings: {} })

/** Two groups; `where[id]` says which group renders the target of instance `id`. */
function Harness({
  pool,
  where
}: {
  pool: PanelNodePool
  where: Record<string, 'a' | 'b'>
}): React.JSX.Element {
  const ids = Object.keys(where)
  const placements: PanelPlacement[] = ids.map((id) => ({
    instance: inst(id),
    active: true,
    inCell: false,
    inStrip: false
  }))
  return (
    <PanelNodePoolContext value={pool}>
      {(['a', 'b'] as const).map((g) => (
        <section key={g} data-group={g}>
          {ids
            .filter((id) => where[id] === g)
            .map((id) => (
              <PanelTarget key={id} instanceId={id} />
            ))}
        </section>
      ))}
      <PanelHosts
        placements={placements}
        pool={pool}
        render={(p) => <Probe id={p.instance.id} />}
      />
    </PanelNodePoolContext>
  )
}

afterEach(() => {
  cleanup()
  mounts = 0
  unmounts = 0
})

describe('PanelHosts', () => {
  it('a panel moved to another group keeps its DOM node and state, never remounting', () => {
    const pool = new PanelNodePool()
    const { container, rerender } = render(<Harness pool={pool} where={{ x: 'a', y: 'b' }} />)
    const probe = container.querySelector<HTMLButtonElement>('[data-probe="x"]')!
    expect(probe.closest('[data-group]')?.getAttribute('data-group')).toBe('a')
    act(() => probe.click())
    expect(probe.textContent).toBe('1')

    rerender(<Harness pool={pool} where={{ x: 'b', y: 'b' }} />)
    const moved = container.querySelector<HTMLButtonElement>('[data-probe="x"]')!
    expect(moved).toBe(probe)
    expect(moved.closest('[data-group]')?.getAttribute('data-group')).toBe('b')
    expect(moved.textContent).toBe('1')
    expect(mounts).toBe(2)
    expect(unmounts).toBe(0)
  })

  it('a re-render that moves nothing leaves the host node where it is', () => {
    const pool = new PanelNodePool()
    const { container, rerender } = render(<Harness pool={pool} where={{ x: 'a' }} />)
    const host = container.querySelector('[data-panel-host="x"]')!
    const observed: MutationRecord[] = []
    const mo = new MutationObserver((records) => observed.push(...records))
    mo.observe(container, { childList: true, subtree: true })
    rerender(<Harness pool={pool} where={{ x: 'a' }} />)
    mo.disconnect()
    observed.push(...mo.takeRecords())
    expect(observed.filter((r) => [...r.removedNodes].includes(host))).toEqual([])
    expect(container.querySelector('[data-panel-host="x"]')).toBe(host)
  })

  it('a panel no longer placed unmounts, and retain drops its host node', () => {
    const pool = new PanelNodePool()
    const { container, rerender } = render(<Harness pool={pool} where={{ x: 'a', y: 'a' }} />)
    rerender(<Harness pool={pool} where={{ y: 'a' }} />)
    expect(unmounts).toBe(1)
    pool.retain(new Set(['y']))
    expect(container.querySelector('[data-panel-host="x"]')).toBeNull()
    expect(container.querySelector('[data-probe="y"]')).not.toBeNull()
  })
})
