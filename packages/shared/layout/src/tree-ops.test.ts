import { describe, expect, it } from 'vitest'
import {
  collectTileTypes,
  findPaneOfTile,
  insertTile,
  makePane,
  makeSplit,
  removeTile,
  setActiveTile
} from './tree-ops'
import { isPane, isSplit } from './types'
import type { LayoutTree, Tile } from './types'

const tile = (id: string, type: Tile['type'] = 'editor'): Tile => ({
  id,
  type,
  title: id,
  renderKind: 'dom'
})

describe('insertTile', () => {
  it('creates a root pane when empty', () => {
    const out = insertTile({ root: null }, null, tile('a'))
    expect(out.root && isPane(out.root)).toBe(true)
  })

  it('appends a new pane (column) to the root when targetPaneId is null', () => {
    const root = makePane([tile('a')])
    const out = insertTile({ root }, null, tile('b', 'browser'))
    expect(out.root && isSplit(out.root)).toBe(true)
    if (out.root && isSplit(out.root)) {
      expect(out.root.direction).toBe('row')
      expect(out.root.children).toHaveLength(2)
      expect(out.root.fractions).toEqual([0.5, 0.5])
    }
  })

  it('adds a tile as a tab into a target pane and activates it', () => {
    const root = makePane([tile('a')])
    const out = insertTile({ root }, root.id, tile('b'))
    const pane = out.root && isPane(out.root) ? out.root : null
    expect(pane?.tiles.map((t) => t.id)).toEqual(['a', 'b'])
    expect(pane?.activeTileId).toBe('b')
  })
})

describe('removeTile', () => {
  it('keeps a multi-tile pane and reselects the active tile', () => {
    const root = makePane([tile('a'), tile('b')])
    root.activeTileId = 'b'
    const out = removeTile({ root }, 'b')
    const pane = out.root && isPane(out.root) ? out.root : null
    expect(pane?.tiles.map((t) => t.id)).toEqual(['a'])
    expect(pane?.activeTileId).toBe('a')
  })

  it('collapses an emptied pane and its parent split down to the surviving sibling', () => {
    const a = makePane([tile('a')])
    const b = makePane([tile('b')])
    const root = makeSplit('row', [a, b])
    const out = removeTile({ root }, 'a')
    // split collapses to the single remaining pane
    expect(out.root && isPane(out.root)).toBe(true)
    if (out.root && isPane(out.root)) expect(out.root.tiles[0].id).toBe('b')
  })

  it('preserves survivor proportions when removing one of three', () => {
    const root = makeSplit('row', [makePane([tile('a')]), makePane([tile('b')]), makePane([tile('c')])])
    root.fractions = [0.2, 0.3, 0.5]
    const out = removeTile({ root }, 'b')
    if (out.root && isSplit(out.root)) {
      // remaining [0.2, 0.5] renormalized
      expect(out.root.fractions[0]).toBeCloseTo(0.2 / 0.7)
      expect(out.root.fractions[1]).toBeCloseTo(0.5 / 0.7)
    }
  })
})

describe('setActiveTile + lookups', () => {
  it('sets active tab and finds the owning pane', () => {
    const root = makePane([tile('a'), tile('b')])
    const out: LayoutTree = setActiveTile({ root }, root.id, 'b')
    expect(findPaneOfTile(out.root, 'b')?.activeTileId).toBe('b')
  })

  it('collects distinct tile types', () => {
    const root = makeSplit('row', [makePane([tile('a', 'terminal')]), makePane([tile('b', 'browser')])])
    expect(collectTileTypes(root)).toEqual(new Set(['terminal', 'browser']))
  })
})
