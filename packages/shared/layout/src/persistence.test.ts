import { afterEach, describe, expect, it } from 'vitest'
import { deserialize, loadTree, saveTree, serialize } from './persistence'
import { makePane, makeSplit } from './tree-ops'
import type { Tile } from './types'

const tile = (id: string): Tile => ({ id, type: 'editor', title: id, renderKind: 'dom' })

afterEach(() => {
  if (typeof window !== 'undefined' && window.localStorage) window.localStorage.clear()
})

describe('serialize/deserialize', () => {
  it('round-trips a nested tree', () => {
    const tree = { root: makeSplit('row', [makePane([tile('a')]), makePane([tile('b')])]) }
    const back = deserialize(serialize(tree))
    expect(back).toEqual(tree)
  })

  it('round-trips a null root', () => {
    expect(deserialize(serialize({ root: null }))).toEqual({ root: null })
  })

  it('rejects garbage and version mismatch', () => {
    expect(deserialize('not json')).toBeNull()
    expect(deserialize(JSON.stringify({ version: 99, tree: { root: null } }))).toBeNull()
    expect(deserialize(JSON.stringify({ version: 1, tree: { root: { kind: 'bogus' } } }))).toBeNull()
  })
})

describe('loadTree/saveTree (jsdom localStorage)', () => {
  it('persists and restores per task id', () => {
    const tree = { root: makePane([tile('x')]) }
    saveTree('task-1', tree)
    expect(loadTree('task-1')).toEqual(tree)
    expect(loadTree('task-2')).toBeNull()
  })
})
