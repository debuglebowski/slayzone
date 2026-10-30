import { describe, it, expect, beforeEach } from 'vitest'
import { usePaletteCommandStore, type PaletteCommand } from './palette-commands'

const cmd = (id: string): PaletteCommand => ({ id, label: id, run: () => {} })

beforeEach(() => {
  usePaletteCommandStore.setState({
    scope: null,
    owner: null,
    base: null,
    contributions: new Map()
  })
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

describe('contributions (a pane inside the task adds its own commands)', () => {
  const task = { key: 't1', title: 'Task one', commands: [cmd('rename')] }

  it("come first in the task's scope while its key is the current one", () => {
    const { publish, contribute } = usePaletteCommandStore.getState()
    publish(Symbol('task'), task)
    contribute(Symbol('chat'), 't1', [cmd('chat')])
    const scope = usePaletteCommandStore.getState().scope
    expect(scope?.title).toBe('Task one')
    expect(scope?.commands.map((c) => c.id)).toEqual(['chat', 'rename'])
  })

  it("another task's pane adds nothing here", () => {
    const { publish, contribute } = usePaletteCommandStore.getState()
    contribute(Symbol('chat'), 't2', [cmd('other-chat')])
    publish(Symbol('task'), task)
    expect(usePaletteCommandStore.getState().scope?.commands.map((c) => c.id)).toEqual(['rename'])
  })

  it('two panes of one task: the one that claimed last wins; withdrawing hands back', () => {
    const { publish, contribute, claim, withdraw } = usePaletteCommandStore.getState()
    const a = Symbol('a')
    const b = Symbol('b')
    publish(Symbol('task'), task)
    contribute(a, 't1', [cmd('a')])
    contribute(b, 't1', [cmd('b')])
    const ids = () => usePaletteCommandStore.getState().scope?.commands.map((c) => c.id)
    expect(ids()).toEqual(['b', 'rename'])
    claim(a)
    expect(ids()).toEqual(['a', 'rename'])
    withdraw(a)
    expect(ids()).toEqual(['b', 'rename'])
    withdraw(b)
    expect(ids()).toEqual(['rename'])
  })

  it('without contributions the published scope is the very object (no needless renders)', () => {
    const { publish } = usePaletteCommandStore.getState()
    publish(Symbol('task'), task)
    expect(usePaletteCommandStore.getState().scope).toBe(task)
  })
})
