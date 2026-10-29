import type { FileDiff, DiffHunk, DiffLine } from '@slayzone/diff-view'

/**
 * Convert Claude Code's Edit tool `structuredPatch` into the FileDiff shape
 * expected by @slayzone/diff-view's DiffView.
 */

interface ClaudePatchHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

interface ClaudeEditStructured {
  filePath: string
  oldString?: string
  newString?: string
  structuredPatch?: ClaudePatchHunk[]
  originalFile?: string
  userModified?: boolean
  replaceAll?: boolean
}

export function claudeEditResultToFileDiff(structured: unknown): FileDiff | null {
  if (!structured || typeof structured !== 'object') return null
  const s = structured as ClaudeEditStructured
  if (!s.filePath || !Array.isArray(s.structuredPatch)) return null

  const hunks: DiffHunk[] = s.structuredPatch.map((h) => {
    let oldNo = h.oldStart
    let newNo = h.newStart
    const lines: DiffLine[] = []
    for (const raw of h.lines) {
      const prefix = raw.charAt(0)
      const content = raw.slice(1)
      if (prefix === '+') {
        lines.push({ type: 'add', content, oldLineNo: null, newLineNo: newNo++ })
      } else if (prefix === '-') {
        lines.push({ type: 'delete', content, oldLineNo: oldNo++, newLineNo: null })
      } else {
        lines.push({ type: 'context', content, oldLineNo: oldNo++, newLineNo: newNo++ })
      }
    }
    return {
      header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
      oldStart: h.oldStart,
      oldLen: h.oldLines,
      newStart: h.newStart,
      newLen: h.newLines,
      label: '',
      lines
    }
  })

  const additions = hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === 'add').length, 0)
  const deletions = hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === 'delete').length, 0)

  return {
    path: s.filePath,
    oldPath: null,
    hunks,
    isBinary: false,
    isNew: false,
    isDeleted: false,
    additions,
    deletions
  }
}
