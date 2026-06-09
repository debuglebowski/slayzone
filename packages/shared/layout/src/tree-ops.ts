// Pure tree mutations — every fn takes a tree and returns a NEW tree (the input
// is never mutated; we clone first). No React, no store. The store wraps these.
import type { LayoutNode, LayoutTree, PaneNode, SplitNode, Tile } from './types'
import { DEFAULT_MIN, isPane, isSplit, newId } from './types'
import { normalizeFractions } from './geometry'

// Tree nodes are pure JSON (no functions) → structural clone via JSON is safe.
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// ── builders (also used by consumers to seed an initial layout) ──────────────

export function makePane(tiles: Tile[]): PaneNode {
  return {
    kind: 'pane',
    id: newId('pane'),
    tiles,
    activeTileId: tiles[0]?.id ?? '',
    min: { ...DEFAULT_MIN }
  }
}

export function makeSplit(direction: 'row' | 'col', children: LayoutNode[]): SplitNode {
  return {
    kind: 'split',
    id: newId('split'),
    direction,
    children,
    fractions: new Array<number>(children.length).fill(1 / Math.max(1, children.length))
  }
}

// ── lookups ──────────────────────────────────────────────────────────────────

export function findNode(node: LayoutNode | null, id: string): LayoutNode | null {
  if (!node) return null
  if (node.id === id) return node
  if (isSplit(node)) {
    for (const child of node.children) {
      const found = findNode(child, id)
      if (found) return found
    }
  }
  return null
}

export function findTile(node: LayoutNode | null, tileId: string): Tile | null {
  if (!node) return null
  if (isPane(node)) return node.tiles.find((t) => t.id === tileId) ?? null
  for (const child of node.children) {
    const found = findTile(child, tileId)
    if (found) return found
  }
  return null
}

export function findPaneOfTile(node: LayoutNode | null, tileId: string): PaneNode | null {
  if (!node) return null
  if (isPane(node)) return node.tiles.some((t) => t.id === tileId) ? node : null
  for (const child of node.children) {
    const found = findPaneOfTile(child, tileId)
    if (found) return found
  }
  return null
}

/** All distinct tile types currently in the tree (for deriving toggle state). */
export function collectTileTypes(node: LayoutNode | null): Set<string> {
  const out = new Set<string>()
  const walk = (n: LayoutNode): void => {
    if (isPane(n)) n.tiles.forEach((t) => out.add(t.type))
    else n.children.forEach(walk)
  }
  if (node) walk(node)
  return out
}

// ── mutations ──────────────────────────────────────────────────────────────

function appendPaneToRoot(root: LayoutNode, pane: PaneNode): LayoutNode {
  if (isSplit(root) && root.direction === 'row') {
    root.children.push(pane)
    root.fractions = new Array<number>(root.children.length).fill(1 / root.children.length)
    return root
  }
  return makeSplit('row', [root, pane])
}

/**
 * Insert a tile. `targetPaneId === null` → add a new pane to the root (a new
 * column under a row split). Otherwise add as a tab into the target pane.
 */
export function insertTile(tree: LayoutTree, targetPaneId: string | null, tile: Tile): LayoutTree {
  if (!tree.root) return { root: makePane([tile]) }
  const root = clone(tree.root)

  if (targetPaneId !== null) {
    const target = findNode(root, targetPaneId)
    if (target && isPane(target)) {
      target.tiles.push(tile)
      target.activeTileId = tile.id
      return { root }
    }
  }
  return { root: appendPaneToRoot(root, makePane([tile])) }
}

function removeTileFromNode(node: LayoutNode, tileId: string): LayoutNode | null {
  if (isPane(node)) {
    const idx = node.tiles.findIndex((t) => t.id === tileId)
    if (idx === -1) return node
    node.tiles.splice(idx, 1)
    if (node.tiles.length === 0) return null
    if (node.activeTileId === tileId) {
      node.activeTileId = node.tiles[Math.max(0, idx - 1)].id
    }
    return node
  }
  const kept: LayoutNode[] = []
  const keptFractions: number[] = []
  node.children.forEach((child, i) => {
    const next = removeTileFromNode(child, tileId)
    if (next) {
      kept.push(next)
      keptFractions.push(node.fractions[i] ?? 0)
    }
  })
  if (kept.length === 0) return null
  if (kept.length === 1) return kept[0] // collapse single-child split into its child
  node.children = kept
  node.fractions = normalizeFractions(keptFractions, kept.length) // preserve survivors' proportions
  return node
}

/** Remove a tile; collapse emptied panes and single-child splits. */
export function removeTile(tree: LayoutTree, tileId: string): LayoutTree {
  if (!tree.root) return tree
  const root = clone(tree.root)
  return { root: removeTileFromNode(root, tileId) }
}

/** Move a tile into another pane (model-complete; no v1 UI). */
export function moveTileBetweenPanes(
  tree: LayoutTree,
  tileId: string,
  toPaneId: string,
  toIndex?: number
): LayoutTree {
  const tile = findTile(tree.root, tileId)
  if (!tile) return tree
  const removed = removeTile(tree, tileId)
  if (!removed.root) return { root: makePane([clone(tile)]) }
  const root = clone(removed.root)
  const target = findNode(root, toPaneId)
  if (target && isPane(target)) {
    const copy = clone(tile)
    const at = toIndex == null ? target.tiles.length : Math.max(0, Math.min(toIndex, target.tiles.length))
    target.tiles.splice(at, 0, copy)
    target.activeTileId = copy.id
    return { root }
  }
  return { root: appendPaneToRoot(root, makePane([clone(tile)])) }
}

/** Replace a split's fractions (resize commit). */
export function replaceFractions(tree: LayoutTree, splitId: string, fractions: number[]): LayoutTree {
  if (!tree.root) return tree
  const root = clone(tree.root)
  const node = findNode(root, splitId)
  if (node && isSplit(node)) node.fractions = fractions.slice()
  return { root }
}

/** Set the active tab of a pane. */
export function setActiveTile(tree: LayoutTree, paneId: string, tileId: string): LayoutTree {
  if (!tree.root) return tree
  const root = clone(tree.root)
  const node = findNode(root, paneId)
  if (node && isPane(node) && node.tiles.some((t) => t.id === tileId)) {
    node.activeTileId = tileId
  }
  return { root }
}
