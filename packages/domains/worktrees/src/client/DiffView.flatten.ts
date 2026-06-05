import type { FileDiff } from './parse-diff'
import type { HlSpan } from './highlight'
import type { FlatLine, LineRef, FlattenResult } from './DiffView.types'

export function flattenDiff(diff: FileDiff): FlattenResult {
  const oldLines: string[] = []
  const newLines: string[] = []
  const refs: LineRef[] = []
  const flat: FlatLine[] = []

  for (const hunk of diff.hunks) {
    for (const l of hunk.lines) {
      let ref: LineRef
      if (l.type === 'context') {
        ref = { side: 'new', idx: newLines.length }
        oldLines.push(l.content)
        newLines.push(l.content)
      } else if (l.type === 'delete') {
        ref = { side: 'old', idx: oldLines.length }
        oldLines.push(l.content)
      } else {
        ref = { side: 'new', idx: newLines.length }
        newLines.push(l.content)
      }
      refs.push(ref)
      flat.push({ line: l })
    }
  }

  return {
    flat,
    oldContent: oldLines.join('\n'),
    newContent: newLines.join('\n'),
    refs
  }
}

export function applySpans(
  flat: FlatLine[],
  refs: LineRef[],
  oldSpans: HlSpan[][],
  newSpans: HlSpan[][]
): FlatLine[] {
  const out: FlatLine[] = new Array(flat.length)
  for (let i = 0; i < flat.length; i++) {
    const ref = refs[i]
    const arr = ref.side === 'old' ? oldSpans : newSpans
    out[i] = { line: flat[i].line, spans: arr[ref.idx] }
  }
  return out
}
