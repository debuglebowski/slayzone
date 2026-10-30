import type { DiffLine } from '@slayzone/diff-view'
import { relativeToCwd } from '../files-changed/relative-path'

/** Longest quoted line; the rest is cut (the path:line finds it). */
const MAX_QUOTED = 160

export interface DiffLineComment {
  /** The file the diff is of. */
  path: string
  line: DiffLine
  comment: string
}

/**
 * The text a comment on a diff line puts into the composer:
 *
 *     > src/app.ts:42
 *     > const x = 1
 *
 *     Rename this to y.
 *
 * A removed line is named by its old line number. Plain markdown, so the user
 * can edit or delete it before sending, and Claude reads where and what.
 */
export function formatDiffComment(c: DiffLineComment, cwd: string | undefined): string {
  const removed = c.line.type === 'delete'
  const lineNo = removed ? c.line.oldLineNo : (c.line.newLineNo ?? c.line.oldLineNo)
  const where = `${relativeToCwd(c.path, cwd)}${lineNo != null ? `:${lineNo}` : ''}`
  const text = c.line.content.trim()
  const quoted = !text
    ? '(empty line)'
    : text.length > MAX_QUOTED
      ? `${text.slice(0, MAX_QUOTED)}…`
      : text
  return `> ${where}${removed ? ' (removed line)' : ''}\n> ${quoted}\n\n${c.comment.trim()}`
}

/** The draft with `block` added at its end, a blank line before and after it. */
export function appendToDraft(draft: string, block: string): string {
  const head = draft.trimEnd()
  return `${head ? `${head}\n\n` : ''}${block}\n\n`
}
