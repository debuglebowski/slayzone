export { DiffView } from './DiffView'
export type { DiffViewProps, ContextLines } from './DiffView.types'
export {
  parseUnifiedDiff,
  computeInlineHighlights,
  ensureInlineHighlights,
  type FileDiff,
  type DiffHunk,
  type DiffLine,
  type InlineHighlight
} from './parse-diff'
