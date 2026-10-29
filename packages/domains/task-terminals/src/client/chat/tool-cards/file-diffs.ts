import { structuredPatch } from 'diff'
import type { FileDiff } from '@slayzone/diff-view'
import { claudeEditResultToFileDiff } from '../claude-patch-to-filediff'

/**
 * A whole file as one hunk of unchanged lines: DiffView highlights it by the
 * path's extension, so it reads as a syntax-highlighted code view. No old line
 * numbers, so only one number column shows.
 */
export function codeViewDiff(path: string, text: string): FileDiff {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  const lines = body.split('\n')
  return {
    path,
    oldPath: null,
    hunks: [
      {
        header: `@@ -1,${lines.length} +1,${lines.length} @@`,
        oldStart: 1,
        oldLen: lines.length,
        newStart: 1,
        newLen: lines.length,
        label: '',
        lines: lines.map((content, i) => ({
          type: 'context' as const,
          content,
          oldLineNo: null,
          newLineNo: i + 1
        }))
      }
    ],
    isBinary: false,
    isNew: false,
    isDeleted: false,
    additions: 0,
    deletions: 0
  }
}

/** Line diff of two texts, in the shape DiffView takes. */
export function textChangeDiff(path: string, oldText: string, newText: string): FileDiff | null {
  const patch = structuredPatch(path, path, oldText, newText, '', '', { context: 3 })
  return claudeEditResultToFileDiff({
    filePath: path,
    // jsdiff marks a missing final newline with a `\ No newline at end of file` line.
    structuredPatch: patch.hunks.map((h) => ({
      ...h,
      lines: h.lines.filter((l) => !l.startsWith('\\'))
    }))
  })
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** File extension DiffView highlights a notebook cell with. */
const LANGUAGE_EXT: Record<string, string> = {
  python: 'py',
  javascript: 'js',
  typescript: 'ts',
  r: 'r',
  julia: 'jl',
  ruby: 'rb',
  scala: 'scala',
  sql: 'sql',
  bash: 'sh',
  markdown: 'md'
}

/** A cell's source in a notebook's JSON, by id (or `cell-N` index), else undefined. */
function cellSource(
  notebookJson: string | undefined,
  cellId: string | undefined
): string | undefined {
  if (!notebookJson || !cellId) return undefined
  try {
    const nb = JSON.parse(notebookJson) as { cells?: Array<{ id?: string; source?: unknown }> }
    const cells = Array.isArray(nb.cells) ? nb.cells : []
    const index = /^cell-(\d+)$/.exec(cellId)
    const cell = cells.find((c) => c.id === cellId) ?? (index ? cells[Number(index[1])] : undefined)
    if (!cell) return undefined
    if (Array.isArray(cell.source)) return cell.source.join('')
    return typeof cell.source === 'string' ? cell.source : undefined
  } catch {
    return undefined
  }
}

/**
 * Diff of the cell a NotebookEdit changed. Old source: the result's `old_source`,
 * else the cell in `original_file`; an inserted cell has none. Null when the old
 * source is unknown (the card then shows the new source).
 */
export function notebookEditDiff(input: unknown, structured: unknown): FileDiff | null {
  const inp = isRecord(input) ? input : {}
  const res = isRecord(structured) ? structured : {}
  const notebookPath = str(res.notebook_path) ?? str(inp.notebook_path) ?? 'notebook.ipynb'
  const cellId = str(res.cell_id) ?? str(inp.cell_id)
  const mode = str(res.edit_mode) ?? str(inp.edit_mode) ?? 'replace'
  const cellType = str(res.cell_type) ?? str(inp.cell_type)
  const language = cellType === 'markdown' ? 'markdown' : (str(res.language) ?? 'python')
  const newText = mode === 'delete' ? '' : (str(res.new_source) ?? str(inp.new_source) ?? '')
  const oldText =
    mode === 'insert' ? '' : (str(res.old_source) ?? cellSource(str(res.original_file), cellId))
  if (oldText === undefined) return null
  const ext = LANGUAGE_EXT[language.toLowerCase()] ?? 'txt'
  return textChangeDiff(`${notebookPath}#${cellId ?? 'new'}.${ext}`, oldText, newText)
}
