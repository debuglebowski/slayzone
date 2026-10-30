import type { ReactNode } from 'react'
import type { FileDiff, DiffLine as DiffLineType } from './parse-diff'
import type { HlSpan } from './highlight'

export type ContextLines = '0' | '3' | '5' | 'all'

export interface DiffViewProps {
  diff: FileDiff
  sideBySide?: boolean
  wrap?: boolean
  contextLines?: ContextLines
  /**
   * An action on a line (e.g. "comment on this line"), shown over the line's
   * +/- column while the line is hovered or the action has focus. Pass a stable
   * function: the rows are memoized on it.
   */
  renderLineAction?: (line: DiffLineType) => ReactNode
}

export interface FlatLine {
  line: DiffLineType
  spans?: HlSpan[]
}

export interface LineRef {
  side: 'old' | 'new'
  idx: number
}

export interface FlattenResult {
  flat: FlatLine[]
  oldContent: string
  newContent: string
  refs: LineRef[]
}

export interface DisplayChunk {
  kind: 'visible'
  lines: FlatLine[]
  /** Absolute index of first line in this chunk within the flat sequence */
  firstIdx: number
}
export interface GapChunk {
  kind: 'gap'
  count: number
}

export interface SideRow {
  left: FlatLine | null
  right: FlatLine | null
}

export type UnifiedRow =
  | { kind: 'gap'; count: number; key: string }
  | { kind: 'line'; item: FlatLine; key: string }

export type SbsRow =
  | { kind: 'gap'; count: number; key: string }
  | { kind: 'row'; row: SideRow; key: string }
