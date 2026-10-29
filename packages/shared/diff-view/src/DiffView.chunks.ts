import type {
  ContextLines,
  FlatLine,
  DisplayChunk,
  GapChunk,
  SideRow,
  UnifiedRow,
  SbsRow
} from './DiffView.types'

export function computeChunks(
  flat: FlatLine[],
  contextLines: ContextLines
): (DisplayChunk | GapChunk)[] {
  const ctx = contextLines === 'all' ? Number.POSITIVE_INFINITY : parseInt(contextLines, 10)
  const visible = new Uint8Array(flat.length)

  if (ctx === Number.POSITIVE_INFINITY) {
    visible.fill(1)
  } else {
    for (let i = 0; i < flat.length; i++) {
      if (flat[i].line.type !== 'context') {
        const lo = Math.max(0, i - ctx)
        const hi = Math.min(flat.length - 1, i + ctx)
        for (let k = lo; k <= hi; k++) visible[k] = 1
      }
    }
  }

  const out: (DisplayChunk | GapChunk)[] = []
  let i = 0
  while (i < flat.length) {
    if (!visible[i]) {
      const start = i
      while (i < flat.length && !visible[i]) i++
      out.push({ kind: 'gap', count: i - start })
    } else {
      const start = i
      const lines: FlatLine[] = []
      while (i < flat.length && visible[i]) {
        lines.push(flat[i])
        i++
      }
      out.push({ kind: 'visible', lines, firstIdx: start })
    }
  }
  if (out.length && out[0].kind === 'gap') out.shift()
  if (out.length && out[out.length - 1].kind === 'gap') out.pop()
  return out
}

// ── buildSbsRows cache (H) ────────────────────────────────────────────
// Keyed on the `lines` array reference — chunk.lines is stable across renders
// as long as the upstream `chunks` memo hasn't rebuilt, so a WeakMap lets
// repeat calls (e.g. when unrelated state invalidates the enclosing memo
// chain) reuse the row list without re-pairing adds/deletes.
const sbsRowsCache = new WeakMap<FlatLine[], SideRow[]>()

function buildSbsRows(lines: FlatLine[]): SideRow[] {
  const cached = sbsRowsCache.get(lines)
  if (cached) return cached
  const rows: SideRow[] = []
  let i = 0
  while (i < lines.length) {
    if (lines[i].line.type === 'context') {
      rows.push({ left: lines[i], right: lines[i] })
      i++
      continue
    }
    const delStart = i
    while (i < lines.length && lines[i].line.type === 'delete') i++
    const delEnd = i
    const addStart = i
    while (i < lines.length && lines[i].line.type === 'add') i++
    const addEnd = i
    const delN = delEnd - delStart
    const addN = addEnd - addStart
    const max = Math.max(delN, addN)
    for (let j = 0; j < max; j++) {
      rows.push({
        left: j < delN ? lines[delStart + j] : null,
        right: j < addN ? lines[addStart + j] : null
      })
    }
  }
  sbsRowsCache.set(lines, rows)
  return rows
}

// ---- Flat row sequence (chunks + gaps → positionable list) ----

export function buildUnifiedRows(chunks: (DisplayChunk | GapChunk)[]): UnifiedRow[] {
  const rows: UnifiedRow[] = []
  chunks.forEach((c, ci) => {
    if (c.kind === 'gap') {
      rows.push({ kind: 'gap', count: c.count, key: `g${ci}` })
    } else {
      c.lines.forEach((item, li) => rows.push({ kind: 'line', item, key: `v${ci}-${li}` }))
    }
  })
  return rows
}

export function buildSbsRowList(chunks: (DisplayChunk | GapChunk)[]): SbsRow[] {
  const rows: SbsRow[] = []
  chunks.forEach((c, ci) => {
    if (c.kind === 'gap') {
      rows.push({ kind: 'gap', count: c.count, key: `g${ci}` })
    } else {
      buildSbsRows(c.lines).forEach((row, ri) =>
        rows.push({ kind: 'row', row, key: `v${ci}-${ri}` })
      )
    }
  })
  return rows
}
