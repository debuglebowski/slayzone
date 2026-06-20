import type { SearchItem } from './SearchDialog.types'

export function selectorForItem(item: SearchItem): string {
  if (item.kind === 'file') return item.filePath
  return item.label
}

export function offsetPositions(positions: Set<number>, offset: number): Set<number> {
  const out = new Set<number>()
  for (const p of positions) {
    const adj = p - offset
    if (adj >= 0) out.add(adj)
  }
  return out
}

export function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms) || ms < 0) return ''
  const s = Math.floor(ms / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  const w = Math.floor(d / 7)
  if (w < 4) return `${w}w ago`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo ago`
  const y = Math.floor(d / 365)
  return `${y}y ago`
}
