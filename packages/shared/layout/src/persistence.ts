// localStorage persistence for the layout tree (renderer-only — no backend in
// the chromium-shell stub yet). The tree is pure JSON; overlays are never
// persisted (they hold render fns and live in the store, not the tree).
import type { LayoutNode, LayoutTree } from './types'

const VERSION = 1

function keyFor(taskId: string): string {
  return `slayzone.layout.v${VERSION}.${taskId}`
}

export function serialize(tree: LayoutTree): string {
  return JSON.stringify({ version: VERSION, tree })
}

function isValidNode(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const node = value as Partial<LayoutNode>
  if (node.kind === 'pane') return Array.isArray((node as { tiles?: unknown }).tiles)
  if (node.kind === 'split') {
    const children = (node as { children?: unknown }).children
    return Array.isArray(children) && children.every(isValidNode)
  }
  return false
}

/** Parse a persisted blob. Returns null on any malformation / version mismatch. */
export function deserialize(raw: string): LayoutTree | null {
  try {
    const parsed = JSON.parse(raw) as { version?: number; tree?: { root?: unknown } }
    if (!parsed || parsed.version !== VERSION || !parsed.tree) return null
    const root = parsed.tree.root
    if (root !== null && root !== undefined && !isValidNode(root)) return null
    return { root: (root as LayoutNode | null) ?? null }
  } catch {
    return null
  }
}

function hasStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
}

export function loadTree(taskId: string): LayoutTree | null {
  if (!hasStorage()) return null
  try {
    const raw = window.localStorage.getItem(keyFor(taskId))
    return raw ? deserialize(raw) : null
  } catch {
    return null
  }
}

export function saveTree(taskId: string, tree: LayoutTree): void {
  if (!hasStorage()) return
  try {
    window.localStorage.setItem(keyFor(taskId), serialize(tree))
  } catch {
    // ignore quota / serialization errors
  }
}
