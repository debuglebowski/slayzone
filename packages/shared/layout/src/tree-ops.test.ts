import { describe, expect, it } from 'vitest'
import {
  collectTileTypes,
  findPaneOfTile,
  insertTile,
  makePane,
  makeSplit,
  removeTile,
  setActiveTile,
  splitPane
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

describe('splitPane', () => {
  it('splits a root pane east → row split, new pane second', () => {
    const a = makePane([tile('a')])
    const out = splitPane({ root: a }, a.id, 'east', tile('b'))
    expect(out.root && isSplit(out.root)).toBe(true)
    if (out.root && isSplit(out.root)) {
      expect(out.root.direction).toBe('row')
      const [first, second] = out.root.children
      expect(isPane(first) && first.tiles[0].id).toBe('a')
      expect(isPane(second) && second.tiles[0].id).toBe('b')
      expect(out.root.fractions).toEqual([0.5, 0.5])
    }
  })

  it('splits north → col split, new pane first', () => {
    const a = makePane([tile('a')])
    const out = splitPane({ root: a }, a.id, 'north', tile('b'))
    if (out.root && isSplit(out.root)) {
      expect(out.root.direction).toBe('col')
      const [first] = out.root.children
      expect(isPane(first) && first.tiles[0].id).toBe('b')
    }
  })

  it('nests: splitting a child pane of a row split', () => {
    const a = makePane([tile('a')])
    const b = makePane([tile('b')])
    const root = makeSplit('row', [a, b])
    const out = splitPane({ root }, b.id, 'south', tile('c'))
    if (out.root && isSplit(out.root)) {
      const second = out.root.children[1]
      expect(isSplit(second) && second.direction).toBe('col')
      if (isSplit(second)) {
        expect(isPane(second.children[0]) && (second.children[0] as ReturnType<typeof makePane>).tiles[0].id).toBe('b')
      }
    }
  })

  it('MOVES an existing tile when its id is already in the tree', () => {
    const a = makePane([tile('a'), tile('x')])
    const b = makePane([tile('b')])
    const root = makeSplit('row', [a, b])
    const moving = a.tiles[1]
    const out = splitPane({ root }, b.id, 'west', moving)
    // x removed from pane a, now in a new pane west of b
    const types = collectTileTypes(out.root)
    expect(types.has('editor')).toBe(true)
    expect(findPaneOfTile(out.root, 'x')?.tiles).toHaveLength(1)
    expect(findPaneOfTile(out.root, 'a')?.tiles.map((t) => t.id)).toEqual(['a'])
  })

  it("no-ops when dropping a pane's only tile on its own edge", () => {
    const a = makePane([tile('a')])
    const b = makePane([tile('b')])
    const root = makeSplit('row', [a, b])
    const out = splitPane({ root }, a.id, 'west', a.tiles[0])
    expect(out).toEqual({ root })
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
