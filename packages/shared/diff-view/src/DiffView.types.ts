import type { FileDiff, DiffLine as DiffLineType } from './parse-diff'
import type { HlSpan } from './highlight'

export type ContextLines = '0' | '3' | '5' | 'all'

export interface DiffViewProps {
  diff: FileDiff
  sideBySide?: boolean
  wrap?: boolean
  contextLines?: ContextLines
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
