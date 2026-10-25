import { describe, it, expect, beforeEach } from 'vitest'
import { usePaletteCommandStore, type PaletteCommand } from './palette-commands'

const cmd = (id: string): PaletteCommand => ({ id, label: id, run: () => {} })

beforeEach(() => {
  usePaletteCommandStore.setState({ scope: null })
})

describe('usePaletteCommandStore', () => {
  it('publishes a scope for its owner', () => {
    const owner = Symbol('a')
    usePaletteCommandStore
      .getState()
      .publish(owner, { key: 't1', title: 'Task one', commands: [cmd('x')] })
    expect(usePaletteCommandStore.getState().scope?.key).toBe('t1')
    expect(usePaletteCommandStore.getState().scope?.commands.map((c) => c.id)).toEqual(['x'])
  })

  it('a stale owner cannot clear the scope that replaced it', () => {
    const a = Symbol('a')
    const b = Symbol('b')
    const { publish, retract } = usePaletteCommandStore.getState()
    publish(a, { key: 't1', title: 'one', commands: [] })
    // Tab switch: the new tab publishes before the old tab's cleanup runs.
    publish(b, { key: 't2', title: 'two', commands: [] })
    retract(a)
    expect(usePaletteCommandStore.getState().scope?.key).toBe('t2')
    retract(b)
    expect(usePaletteCommandStore.getState().scope).toBeNull()
  })
})
