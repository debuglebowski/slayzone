import { cn, Tooltip, TooltipTrigger, TooltipContent } from '@slayzone/ui'
import { Copy, Check } from 'lucide-react'
import { useState, useRef, useCallback, useMemo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { ResolvedCommit, ResolvedGraph } from '../shared/types'

// --- Public interface ---

interface CommitGraphProps {
  graph: ResolvedGraph
  filterQuery?: string
  tipsOnly?: boolean
  /** When tipsOnly, break collapse chain at tagged commits */
  includeTags?: boolean
  /** When tipsOnly, break collapse chain at merged PR commits (syntheticBranch) */
  breakOnMerges?: boolean
  /** Max rows to render (layout uses all commits for accurate topology) */
  renderLimit?: number
  className?: string
}

// --- Constants ---

const ROW_HEIGHT = 44
const COLUMN_WIDTH = 24
const DOT_RADIUS = 4
const MERGE_DOT_OUTER = 6
const MERGE_DOT_INNER = 3
const GUTTER_PAD = 12

/** Index 0 = base branch (white), rest are for other branches */
const COLUMN_COLORS = [
  '#e2e2e2', // white/light — base branch
  '#a78bfa', // violet
  '#f59e0b', // amber
  '#10b981', // emerald
  '#f472b6', // pink
  '#06b6d4', // cyan
  '#ef4444', // red
  '#8b5cf6', // purple
  '#14b8a6', // teal
  '#f97316', // orange
  '#22d3ee', // sky
]

function getColor(index: number): string {
  const len = COLUMN_COLORS.length
  return COLUMN_COLORS[((index % len) + len) % len]
}

/** Deterministic hash of a branch name to a color index (skips 0, reserved for base branch) */
function hashBranchColor(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) - h + name.charCodeAt(i)) | 0
  }
  // Map to 1..N (skip index 0 which is reserved for base branch)
  return (Math.abs(h) % (COLUMN_COLORS.length - 1)) + 1
}

/** Color index for the base/first branch — always white */
const BASE_BRANCH_COLOR_INDEX = 0

function colX(col: number): number {
  return col * COLUMN_WIDTH + COLUMN_WIDTH / 2 + GUTTER_PAD / 2
}

function rowY(row: number): number {
  return row * ROW_HEIGHT + ROW_HEIGHT / 2
}

// --- Simple fork layout (≤2 branches) ---

function computeTipsLayout(commits: ResolvedCommit[], baseBranch: string): DagLayout {
  if (commits.length === 0) return { nodes: [], edges: [], maxColumn: 0 }

  // Feature branch → column 0 (left), base branch → column 1 (right)
  const branchToCol = new Map<string, number>()
  let nextCol = 0

  const nodes: LayoutNode[] = []
  const edges: LayoutEdge[] = []
  const lastRowInCol = new Map<number, number>()

  for (let row = 0; row < commits.length; row++) {
    const commit = commits[row]
    let col = branchToCol.get(commit.branch)
    if (col === undefined) {
      if (commit.branch === baseBranch) {
        // Base always gets the highest column (rightmost)
        col = branchToCol.size > 0 ? Math.max(...branchToCol.values()) + 1 : 1
      } else {
        col = nextCol++
        // If we assigned col 0, bump nextCol past any future base col
      }
      branchToCol.set(commit.branch, col)
    }

    const colorIndex = commit.branch === baseBranch ? BASE_BRANCH_COLOR_INDEX : hashBranchColor(commit.branch)

    nodes.push({
      commit, column: col, row,
      isMerge: false,
      isBranchTip: commit.isBranchTip,
      colorIndex
    })

    // Straight edge from previous commit in same column (may not be the previous row)
    const prevRow = lastRowInCol.get(col)
    if (prevRow !== undefined) {
      edges.push({
        fromRow: prevRow, fromCol: col, toRow: row, toCol: col,
        color: getColor(colorIndex), type: 'straight'
      })
    }
    lastRowInCol.set(col, row)
  }

  // Cross-column edge at fork point (where base and feature meet)
  const cols = new Set(nodes.map(n => n.column))
  if (cols.size === 2) {
    const lastByCol = new Map<number, LayoutNode>()
    for (const n of nodes) lastByCol.set(n.column, n)
    const entries = [...lastByCol.entries()]
    if (entries.length === 2) {
      const [, a] = entries[0]
      const [, b] = entries[1]
      const bottom = a.row > b.row ? a : b
      const other = a.row > b.row ? b : a
      edges.push({
        fromRow: other.row, fromCol: other.column,
        toRow: bottom.row, toCol: bottom.column,
        color: getColor(other.colorIndex), type: 'curve'
      })
    }
  }

  const maxColumn = Math.max(0, ...nodes.map(n => n.column))
  return { nodes, edges, maxColumn }
}

// --- Full DAG topology algorithm ---

export interface LayoutNode {
  commit: ResolvedCommit
  column: number
  row: number
  isMerge: boolean
  isBranchTip: boolean
  colorIndex: number
  /** Synthetic branch indicator — extra dot on a side column */
  syntheticBranch?: { column: number; colorIndex: number; branchName: string }
  /** Behind-branch indicator — small dot to upper-right, no main dot displacement */
  behindBranch?: { colorIndex: number; branchName: string }
}

export interface LayoutEdge {
  fromRow: number
  fromCol: number
  toRow: number
  toCol: number
  color: string
  type: 'straight' | 'curve'
  targetHash?: string
  dashed?: boolean
}

export interface DagLayout {
  nodes: LayoutNode[]
  edges: LayoutEdge[]
  maxColumn: number
}

export function computeDagLayout(commits: ResolvedCommit[], baseBranch: string): DagLayout {
  if (commits.length === 0) return { nodes: [], edges: [], maxColumn: 0 }

  // --- Pre-compute fixed column per branch ---
  // Each branch gets its own unique column. Children are always right of parents.
  const hashToBranch = new Map<string, string>()
  for (const c of commits) hashToBranch.set(c.hash, c.branch)

  // Find parent branch for each branch: the branch of the first-parent at the fork point
  const branchParent = new Map<string, string>()
  for (const c of commits) {
    if (c.parents.length === 0) continue
    const parentBranch = hashToBranch.get(c.parents[0])
    if (parentBranch && parentBranch !== c.branch) {
      branchParent.set(c.branch, parentBranch) // last write wins = deepest fork point
    }
  }

  // Order children by first appearance in commits (topo order)
  const branchFirstRow = new Map<string, number>()
  for (let i = 0; i < commits.length; i++) {
    if (!branchFirstRow.has(commits[i].branch)) {
      branchFirstRow.set(commits[i].branch, i)
    }
  }

  // Compute row range per branch (for overlap detection)
  const branchRowRange = new Map<string, { min: number; max: number }>()
  for (let i = 0; i < commits.length; i++) {
    const range = branchRowRange.get(commits[i].branch)
    if (!range) {
      branchRowRange.set(commits[i].branch, { min: i, max: i })
    } else {
      range.max = i
    }
  }

  // Detect "behind" branches: their tip sits on the base branch's first-parent chain
  const baseFirstParentChain = new Set<string>()
  const hashToCommit = new Map<string, ResolvedCommit>()
  for (const c of commits) hashToCommit.set(c.hash, c)
  {
    let current = commits.find(c => c.branch === baseBranch && c.isBranchTip)
    while (current) {
      baseFirstParentChain.add(current.hash)
      current = current.parents.length > 0 ? hashToCommit.get(current.parents[0]) : undefined
    }
  }
  const branchTipHash = new Map<string, string>()
  for (const c of commits) {
    if (c.isBranchTip && !branchTipHash.has(c.branch)) {
      branchTipHash.set(c.branch, c.hash)
    }
  }

  // Track occupied row ranges per column for overlap detection
  const columnOccupied: Array<Array<{ min: number; max: number }>> = [[]]
  function isColumnFree(col: number, range: { min: number; max: number }): boolean {
    const ranges = columnOccupied[col]
    if (!ranges) return true
    return !ranges.some(r => r.min <= range.max + 1 && r.max >= range.min - 1)
  }
  function occupyColumn(col: number, range: { min: number; max: number }) {
    while (columnOccupied.length <= col) columnOccupied.push([])
    columnOccupied[col].push(range)
  }

  // BFS from base branch to assign columns (lowest free column > parent)
  const behindBranches = new Set<string>()
  const branchCol = new Map<string, number>()
  branchCol.set(baseBranch, 0)
  const baseRange = branchRowRange.get(baseBranch)
  if (baseRange) occupyColumn(0, baseRange)
  const queue = [baseBranch]
  while (queue.length > 0) {
    const parent = queue.shift()!
    const parentCol = branchCol.get(parent)!
    const children: string[] = []
    for (const [child, p] of branchParent) {
      if (p === parent && !branchCol.has(child)) children.push(child)
    }
    children.sort((a, b) => (branchFirstRow.get(a) ?? 0) - (branchFirstRow.get(b) ?? 0))
    for (const child of children) {
      // Behind branches (tip is on base branch's first-parent chain) share base column
      const childTip = branchTipHash.get(child)
      if (childTip && baseFirstParentChain.has(childTip)) {
        branchCol.set(child, 0)
        behindBranches.add(child)
      } else {
        const range = branchRowRange.get(child)!
        let col = parentCol + 1
        while (!isColumnFree(col, range)) col++
        branchCol.set(child, col)
        occupyColumn(col, range)
      }
      queue.push(child)
    }
  }

  const hashToRow = new Map<string, number>()
  const hashToCol = new Map<string, number>()
  const nodes: LayoutNode[] = []
  const edges: LayoutEdge[] = []

  // Pre-reserve column 0 for the base branch so feature branches never claim it.
  // '__base_reserved__' is a sentinel — treated as free only by base branch lookups.
  const BASE_RESERVED = '__base_reserved__'
  const activeColumns: (string | null | typeof BASE_RESERVED)[] = [BASE_RESERVED]
  const columnColorIndex: number[] = [BASE_BRANCH_COLOR_INDEX]
  const columnBranch: (string | null)[] = [baseBranch]
  let nextFallbackColor = 0

  // Branch ownership is already resolved — just read commit.branch
  function getCommitColorIndex(commit: ResolvedCommit): number {
    if (commit.branch === baseBranch) return BASE_BRANCH_COLOR_INDEX
    if (commit.branch) return hashBranchColor(commit.branch)
    return nextFallbackColor++
  }

  function findFreeColumn(forBase = false, minCol = 0): number {
    const start = Math.max(forBase ? 0 : 1, minCol) // non-base branches skip column 0
    for (let i = start; i < activeColumns.length; i++) {
      if (activeColumns[i] === null || (forBase && activeColumns[i] === BASE_RESERVED)) return i
    }
    // Expand to at least `start` columns, then add one free column
    while (activeColumns.length <= start) {
      activeColumns.push(null)
      columnColorIndex.push(0)
      columnBranch.push(null)
    }
    if (activeColumns[start] === null || (forBase && activeColumns[start] === BASE_RESERVED)) return start
    activeColumns.push(null)
    columnColorIndex.push(0)
    columnBranch.push(null)
    return activeColumns.length - 1
  }

  function findColumnReservedFor(hash: string): number | null {
    for (let i = 0; i < activeColumns.length; i++) {
      if (activeColumns[i] === hash) return i
    }
    return null
  }

  const hashToColorIndex = new Map<string, number>()

  for (let row = 0; row < commits.length; row++) {
    const commit = commits[row]
    hashToRow.set(commit.hash, row)

    // Force commit into its branch's pre-assigned column
    const targetCol = branchCol.get(commit.branch) ?? findFreeColumn(false, 1)
    // Ensure columns exist up to targetCol
    while (activeColumns.length <= targetCol) {
      activeColumns.push(null)
      columnColorIndex.push(0)
      columnBranch.push(null)
    }

    // Clear any reservations for this commit in other columns
    for (let i = 0; i < activeColumns.length; i++) {
      if (activeColumns[i] === commit.hash && i !== targetCol) {
        activeColumns[i] = null
      }
    }

    // If targetCol is occupied by a different commit's reservation, relocate it
    if (activeColumns[targetCol] !== null && activeColumns[targetCol] !== commit.hash && activeColumns[targetCol] !== BASE_RESERVED) {
      const displaced = activeColumns[targetCol]!
      // Find a free column for the displaced reservation
      const displacedBranch = hashToBranch.get(displaced)
      const displacedTarget = displacedBranch ? branchCol.get(displacedBranch) : null
      if (displacedTarget !== null && displacedTarget !== undefined && displacedTarget !== targetCol) {
        while (activeColumns.length <= displacedTarget) {
          activeColumns.push(null)
          columnColorIndex.push(0)
          columnBranch.push(null)
        }
        activeColumns[displacedTarget] = displaced
      } else {
        const freeCol = findFreeColumn(false, 1)
        activeColumns[freeCol] = displaced
      }
    }

    const col = targetCol

    const ci = getCommitColorIndex(commit)
    columnColorIndex[col] = ci
    columnBranch[col] = commit.branch

    hashToCol.set(commit.hash, col)
    hashToColorIndex.set(commit.hash, ci)

    const isMerge = commit.parents.length >= 2
    const isBranchTip = commit.isBranchTip

    const node: LayoutNode = { commit, column: col, row, isMerge, isBranchTip, colorIndex: ci }
    if (isBranchTip && behindBranches.has(commit.branch)) {
      node.behindBranch = { colorIndex: hashBranchColor(commit.branch), branchName: commit.branch }
    }
    nodes.push(node)

    if (commit.parents.length === 0) {
      activeColumns[col] = null
    } else {
      const firstParent = commit.parents[0]
      // Reserve first parent in its branch's assigned column
      const parentBranch = hashToBranch.get(firstParent)
      const parentTargetCol = parentBranch ? (branchCol.get(parentBranch) ?? col) : col
      const existingCol = findColumnReservedFor(firstParent)

      if (existingCol !== null) {
        // Already reserved — leave it (will be moved to correct col when processed)
        if (col !== existingCol) {
          activeColumns[col] = null
        }
      } else {
        // Reserve in parent's target column
        while (activeColumns.length <= parentTargetCol) {
          activeColumns.push(null)
          columnColorIndex.push(0)
          columnBranch.push(null)
        }
        if (parentTargetCol === col) {
          activeColumns[col] = firstParent
        } else {
          activeColumns[col] = null
          // If parent's column is occupied, put reservation there anyway (will be resolved)
          activeColumns[parentTargetCol] = firstParent
        }
      }

      for (let p = 1; p < commit.parents.length; p++) {
        const parentHash = commit.parents[p]
        const pExisting = findColumnReservedFor(parentHash)
        if (pExisting === null) {
          const pBranch = hashToBranch.get(parentHash)
          const pTargetCol = pBranch ? (branchCol.get(pBranch) ?? null) : null
          let pCol: number
          if (pTargetCol !== null) {
            while (activeColumns.length <= pTargetCol) {
              activeColumns.push(null)
              columnColorIndex.push(0)
              columnBranch.push(null)
            }
            pCol = pTargetCol
          } else {
            pCol = findFreeColumn()
          }
          const parentCommit = commits.find(c => c.hash === parentHash)
          const pci = parentCommit ? getCommitColorIndex(parentCommit) : (nextFallbackColor++)
          columnColorIndex[pCol] = pci
          activeColumns[pCol] = parentHash
        }
      }
    }
  }

  // Resolve deferred edges
  for (const edge of edges) {
    if (edge.toRow === -1 && edge.targetHash) {
      const targetRow = hashToRow.get(edge.targetHash)
      if (targetRow !== undefined) {
        edge.toRow = targetRow
        const targetCol = hashToCol.get(edge.targetHash)
        if (targetCol !== undefined) edge.toCol = targetCol
      }
    }
  }

  // Guarantee: every parent link has an edge (straight if same column, curve otherwise)
  for (let row = 0; row < commits.length; row++) {
    const commit = commits[row]
    const col = hashToCol.get(commit.hash)!
    const color = getColor(hashToColorIndex.get(commit.hash) ?? col)
    for (const parentHash of commit.parents) {
      const parentRow = hashToRow.get(parentHash)
      if (parentRow === undefined) continue
      const parentCol = hashToCol.get(parentHash)!
      // Skip if an edge already exists for this link
      const hasEdge = edges.some(e =>
        (e.fromRow === row && e.fromCol === col && e.toRow === parentRow && e.toCol === parentCol) ||
        (e.fromRow === row && e.fromCol === col && e.targetHash === parentHash)
      )
      if (hasEdge) continue
      edges.push({
        fromRow: row, fromCol: col, toRow: parentRow, toCol: parentCol,
        color, type: parentCol === col ? 'straight' : 'curve'
      })
    }
  }

  // Add synthetic branch indicators for mergedFrom commits.
  // Add synthetic branch indicators for mergedFrom commits.
  // These are on col 0 (main) but get a decorative side dot rendered in-row.
  const synthCol = Math.max(1, ...nodes.map(n => n.column)) + 1
  for (const node of nodes) {
    if (!node.commit.mergedFrom) continue
    const sci = hashBranchColor(node.commit.mergedFrom)
    node.syntheticBranch = { column: synthCol, colorIndex: sci, branchName: node.commit.mergedFrom }
  }

  // Mark edges from local-only commits as dashed.
  // A commit is "local only" if it's above the origin/ ref on its column.
  const originRowByCol = new Map<number, number>()
  for (const node of nodes) {
    if (node.commit.branchRefs.some(r => r.startsWith('origin/'))) {
      const prev = originRowByCol.get(node.column)
      if (prev === undefined || node.row < prev) originRowByCol.set(node.column, node.row)
    }
  }
  const isLocalOnly = (row: number, col: number) => {
    const originRow = originRowByCol.get(col)
    return originRow !== undefined && row < originRow
  }
  for (const edge of edges) {
    if (isLocalOnly(edge.fromRow, edge.fromCol)) {
      edge.dashed = true
    }
  }

  const maxColumn = Math.max(0, ...nodes.map(n => n.syntheticBranch?.column ?? n.column))
  return { nodes, edges, maxColumn }
}

// --- Collapsed DAG: same graph topology, non-head commits grouped ---

interface CollapsedGroup {
  row: number
  count: number
  columns: Array<{ col: number; colorIndex: number }>
}

interface CollapsedDag {
  nodes: LayoutNode[]
  edges: LayoutEdge[]
  groups: CollapsedGroup[]
  maxColumn: number
  totalRows: number
  rowOffsets: Map<number, number>
}

function computeCollapsedDag(fullLayout: DagLayout, baseBranch: string, includeTags = true, breakOnMerges = true): CollapsedDag {
  const { nodes, edges, maxColumn } = fullLayout
  if (nodes.length === 0) return { nodes: [], edges: [], groups: [], maxColumn: 0, totalRows: 0, rowOffsets: new Map() }

  // Identify head rows (nodes with branchRefs, optionally synthetic branches and tags)
  const headRows = new Set<number>()
  for (const n of nodes) {
    if (n.commit.branchRefs.length > 0 || (breakOnMerges && n.syntheticBranch) || (includeTags && n.commit.tags.length > 0)) headRows.add(n.row)
  }

  // Always show first and last commit of the base branch
  let baseFirst = Infinity, baseLast = -1
  for (const n of nodes) {
    if (n.commit.branch === baseBranch) {
      if (n.row < baseFirst) baseFirst = n.row
      if (n.row > baseLast) baseLast = n.row
    }
  }
  if (baseFirst !== Infinity) headRows.add(baseFirst)
  if (baseLast !== -1) headRows.add(baseLast)

  // Build segments: consecutive head or non-head rows
  type Segment = { type: 'head'; row: number } | { type: 'group'; rows: number[] }
  const segments: Segment[] = []
  let currentGroup: number[] = []

  const maxRow = Math.max(...nodes.map(n => n.row))
  for (let row = 0; row <= maxRow; row++) {
    if (headRows.has(row)) {
      if (currentGroup.length > 0) {
        segments.push({ type: 'group', rows: [...currentGroup] })
        currentGroup = []
      }
      segments.push({ type: 'head', row })
    } else {
      currentGroup.push(row)
    }
  }
  if (currentGroup.length > 0) {
    segments.push({ type: 'group', rows: currentGroup })
  }

  // Build row mapping: original row → collapsed row
  const rowMap = new Map<number, number>()
  let collapsedRow = 0
  const resultNodes: LayoutNode[] = []
  const groups: CollapsedGroup[] = []

  for (const seg of segments) {
    if (seg.type === 'head') {
      rowMap.set(seg.row, collapsedRow)
      const node = nodes.find(n => n.row === seg.row)!
      resultNodes.push({ ...node, row: collapsedRow })
      collapsedRow++
    } else {
      for (const r of seg.rows) {
        rowMap.set(r, collapsedRow)
      }
      // Gather columns present in this group
      const columns: CollapsedGroup['columns'] = []
      const seenCols = new Set<number>()
      for (const r of seg.rows) {
        const node = nodes.find(n => n.row === r)
        if (node && !seenCols.has(node.column)) {
          seenCols.add(node.column)
          columns.push({ col: node.column, colorIndex: node.colorIndex })
        }
      }
      groups.push({ row: collapsedRow, count: seg.rows.length, columns })
      collapsedRow++
    }
  }

  // Remap edges, dedup
  const resultEdges: LayoutEdge[] = []
  const edgeKeys = new Set<string>()
  for (const edge of edges) {
    const fromRow = rowMap.get(edge.fromRow)
    const toRow = rowMap.get(edge.toRow)
    if (fromRow === undefined || toRow === undefined) continue
    if (fromRow === toRow) continue // collapsed into same row
    const key = `${fromRow},${edge.fromCol},${toRow},${edge.toCol}`
    if (edgeKeys.has(key)) continue
    edgeKeys.add(key)
    resultEdges.push({ ...edge, fromRow, toRow })
  }

  // Carry over rowOffsets (for synthetic branch x-shifts)
  const newRowOffsets = new Map<number, number>()
  for (const node of resultNodes) {
    if (node.syntheticBranch) {
      newRowOffsets.set(node.row, MERGED_DOT_OFFSET)
    }
  }

  return { nodes: resultNodes, edges: resultEdges, groups, maxColumn, totalRows: collapsedRow, rowOffsets: newRowOffsets }
}

// --- Copy hash hook ---

function useCopyHash() {
  const [copiedHash, setCopiedHash] = useState<string | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const handleCopy = useCallback((hash: string) => {
    navigator.clipboard.writeText(hash)
    setCopiedHash(hash)
    clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopiedHash(null), 1500)
  }, [])

  return { copiedHash, handleCopy }
}

// --- SVG rendering helpers ---

const MERGED_DOT_OFFSET = 12

function SvgStraightEdge({ edge, rowOffsets }: { edge: LayoutEdge; rowOffsets?: Map<number, number> }) {
  const x1 = colX(edge.fromCol) + (edge.fromCol === 0 ? (rowOffsets?.get(edge.fromRow) ?? 0) : 0)
  const x2 = colX(edge.toCol) + (edge.toCol === 0 ? (rowOffsets?.get(edge.toRow) ?? 0) : 0)
  const y1 = rowY(edge.fromRow), y2 = rowY(edge.toRow)
  const dash = edge.dashed ? '4 3' : undefined
  if (x1 !== x2) {
    // Smooth bezier jog between shifted and unshifted positions
    const dy = y2 - y1
    const d = `M${x1},${y1} C${x1},${y1 + dy * 0.4} ${x2},${y2 - dy * 0.4} ${x2},${y2}`
    return <path d={d} stroke={edge.color} strokeWidth={2} fill="none" opacity={0.35} strokeDasharray={dash} />
  }
  return (
    <line x1={x1} y1={y1} x2={x2} y2={y2}
      stroke={edge.color} strokeWidth={2} opacity={0.35} strokeDasharray={dash} />
  )
}

function SvgCurveEdge({ edge, rowOffsets }: { edge: LayoutEdge; rowOffsets?: Map<number, number> }) {
  const x1 = colX(edge.fromCol) + (edge.fromCol === 0 ? (rowOffsets?.get(edge.fromRow) ?? 0) : 0)
  const y1 = rowY(edge.fromRow)
  const x2 = colX(edge.toCol) + (edge.toCol === 0 ? (rowOffsets?.get(edge.toRow) ?? 0) : 0)
  const y2 = rowY(edge.toRow)
  const dash = edge.dashed ? '4 3' : undefined

  if (edge.fromRow === edge.toRow) {
    return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={edge.color} strokeWidth={2} opacity={0.35} strokeDasharray={dash} />
  }

  const dy = y2 - y1
  const d = `M${x1},${y1} C${x1},${y1 + dy * 0.4} ${x2},${y2 - dy * 0.4} ${x2},${y2}`
  return <path d={d} stroke={edge.color} strokeWidth={2} fill="none" opacity={0.35} strokeDasharray={dash} />
}

function SvgDot({ cx, cy, color, type, dimmed }: { cx: number; cy: number; color: string; type: 'merge' | 'regular'; dimmed?: boolean }) {
  const opacity = dimmed ? 0.2 : undefined
  if (type === 'merge') {
    return (
      <g opacity={opacity}>
        <circle cx={cx} cy={cy} r={MERGE_DOT_OUTER} fill="none" stroke={color} strokeWidth={2} />
        <circle cx={cx} cy={cy} r={MERGE_DOT_INNER} fill="var(--background, #1a1a1a)" />
      </g>
    )
  }
  return <circle cx={cx} cy={cy} r={DOT_RADIUS} fill={color} opacity={opacity} />
}

// --- Dot tooltip overlay ---

const DOT_HIT_SIZE = 18

function DotOverlays({ items }: { items: Array<{ key: string; row: number; column: number; color: string; branchName?: string; xOffset?: number; yOffset?: number; isSynthetic?: boolean }> }) {
  return (
    <>
      {items.map(({ key, row, column, color, branchName, xOffset, yOffset, isSynthetic }) => {
        if (!branchName) return null
        const cx = colX(column) + (xOffset ?? 0)
        const cy = rowY(row) + (yOffset ?? 0)
        return (
          <Tooltip key={key}>
            <TooltipTrigger asChild>
              <div className="absolute transition-shadow duration-150" style={{
                left: cx - DOT_HIT_SIZE / 2,
                top: cy - DOT_HIT_SIZE / 2,
                width: DOT_HIT_SIZE,
                height: DOT_HIT_SIZE,
                borderRadius: '50%',
                zIndex: 1,
                boxShadow: `0 0 0 0px ${color}50`,
              }}
              onMouseEnter={e => { e.currentTarget.style.boxShadow = `0 0 0 2px ${color}50` }}
              onMouseLeave={e => { e.currentTarget.style.boxShadow = `0 0 0 0px ${color}50` }}
              />
            </TooltipTrigger>
            <TooltipContent side="top" className={isSynthetic ? 'max-w-none' : undefined}>
              {isSynthetic ? (
                <div className="text-left whitespace-nowrap">
                  <div>{branchName}</div>
                  <div className="text-muted-foreground text-[10px]">Merged branch (deleted). See info (i) in toolbar.</div>
                </div>
              ) : branchName}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </>
  )
}

// --- Row renderers ---

function CommitRow({
  shortHash, message, author, relativeDate, refs, mergedFrom, color, gutterWidth, copiedHash, onCopy, dimmed
}: {
  shortHash: string; message: string; author: string; relativeDate: string
  refs?: string[]; mergedFrom?: string; color: string; gutterWidth: number
  copiedHash: string | null; onCopy: (hash: string) => void; dimmed?: boolean
}) {
  return (
    <div
      className={cn('flex items-center cursor-pointer', dimmed && 'opacity-20')}
      style={{ height: ROW_HEIGHT, paddingLeft: gutterWidth, paddingTop: 3, paddingBottom: 3 }}
      onClick={() => onCopy(shortHash)}
    >
      <div className="flex-1 min-w-0 flex items-center gap-2 pr-3 h-full rounded group transition-colors px-2"
        style={{ backgroundColor: `${color}12` }}>
        <div className="flex-1 min-w-0">
          <div className="text-xs truncate">
            {message}
          </div>
          <div className="text-[10px] text-muted-foreground">
            <span className="font-mono">{shortHash}</span>{' · '}{author}{' · '}{relativeDate}
          </div>
        </div>
        {refs && refs.map(ref => (
          <span key={ref} className="shrink-0 px-1.5 py-0 rounded text-[10px] font-medium"
            style={{ backgroundColor: `${color}20`, color }}>{ref}</span>
        ))}
        {mergedFrom && (
          <span className="shrink-0 px-1.5 py-0 rounded text-[10px] font-medium opacity-60 border border-current"
            style={{ color: 'var(--color-muted-foreground)' }}>{mergedFrom}</span>
        )}
        {copiedHash === shortHash
          ? <Check className="h-3 w-3 text-green-500 shrink-0" />
          : <Copy className="h-3 w-3 text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
        }
      </div>
    </div>
  )
}


function CommitGroupRow({ count, color, gutterWidth }: {
  count: number; color: string; gutterWidth: number
}) {
  return (
    <div className="flex items-center" style={{ height: ROW_HEIGHT, paddingLeft: gutterWidth }}>
      <span className="text-[10px] px-2 py-0.5 rounded border"
        style={{ borderColor: `${color}30`, color: `${color}aa`, backgroundColor: `${color}08` }}>
        {count} commit{count > 1 ? 's' : ''}
      </span>
    </div>
  )
}

// --- Main component ---

const OVERSCAN = 10

export function CommitGraph({ graph, filterQuery, tipsOnly, includeTags, breakOnMerges, renderLimit, className }: CommitGraphProps) {
  const { copiedHash, handleCopy } = useCopyHash()
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  const hasTopology = useMemo(() => graph.commits.some(c => c.parents.length > 0), [graph])
  const fullLayout = useMemo(
    () => hasTopology
      ? computeDagLayout(graph.commits, graph.baseBranch)
      : computeTipsLayout(graph.commits, graph.baseBranch),
    [graph, hasTopology]
  )
  const collapsed = useMemo(
    () => tipsOnly ? computeCollapsedDag(fullLayout, graph.baseBranch, includeTags, breakOnMerges) : null,
    [fullLayout, graph.baseBranch, tipsOnly, includeTags, breakOnMerges]
  )

  // Map colorIndex → branch name for tooltip overlays
  const colorBranch = useMemo(() => {
    const map = new Map<number, string>()
    for (const node of fullLayout.nodes) {
      if (map.has(node.colorIndex)) continue
      if (node.commit.branch) {
        map.set(node.colorIndex, node.commit.branch)
      }
    }
    return map
  }, [fullLayout])

  // Filter dimming
  const matchSet = useMemo(() => {
    if (!filterQuery) return null
    const q = filterQuery.toLowerCase()
    const set = new Set<string>()
    for (const c of graph.commits) {
      if (c.message.toLowerCase().includes(q) || c.author.toLowerCase().includes(q) ||
        c.branchRefs.some(r => r.toLowerCase().includes(q)) ||
        c.tags.some(t => t.toLowerCase().includes(q))) {
        set.add(c.hash)
      }
    }
    return set
  }, [graph.commits, filterQuery])

  // Build row x-offsets for merged commits (shift main dot right)
  const rowOffsets = useMemo(() => {
    const map = new Map<number, number>()
    for (const node of fullLayout.nodes) {
      if (node.syntheticBranch) map.set(node.row, MERGED_DOT_OFFSET)
    }
    return map
  }, [fullLayout])

  // Choose layout: collapsed or full
  const layout = collapsed ?? fullLayout
  const activeRowOffsets = collapsed ? collapsed.rowOffsets : rowOffsets
  const groups = collapsed?.groups ?? []
  const maxRow = renderLimit != null ? renderLimit : layout.nodes.length + groups.length

  const gutterWidth = (layout.maxColumn + 1) * COLUMN_WIDTH + GUTTER_PAD
  const totalRowCount = Math.min(
    collapsed ? collapsed.totalRows : layout.nodes.length,
    maxRow
  )
  const totalHeight = totalRowCount * ROW_HEIGHT

  // Build ordered list of rows for rendering content (commits + groups interleaved)
  const rowItems = useMemo(() => {
    const allNodes = layout.nodes.filter(n => n.row < maxRow)
    const allGroups = groups.filter(g => g.row < maxRow)
    const items: Array<{ type: 'commit'; node: LayoutNode } | { type: 'group'; group: CollapsedGroup }> = []
    const nodesByRow = new Map<number, LayoutNode>()
    for (const n of allNodes) nodesByRow.set(n.row, n)
    const groupsByRow = new Map<number, CollapsedGroup>()
    for (const g of allGroups) groupsByRow.set(g.row, g)
    for (let r = 0; r < totalRowCount; r++) {
      const node = nodesByRow.get(r)
      const group = groupsByRow.get(r)
      if (node) items.push({ type: 'commit', node })
      else if (group) items.push({ type: 'group', group })
    }
    return items
  }, [layout.nodes, groups, totalRowCount, maxRow])

  // Virtualizer — only render visible rows + overscan buffer
  const virtualizer = useVirtualizer({
    count: rowItems.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  })

  const virtualItems = virtualizer.getVirtualItems()

  // Compute visible row range for filtering SVG/overlays
  function itemRow(item: (typeof rowItems)[number]): number {
    return item.type === 'commit' ? item.node.row : item.group.row
  }
  const startRow = virtualItems.length > 0 && rowItems[virtualItems[0].index]
    ? itemRow(rowItems[virtualItems[0].index])
    : 0
  const endRow = virtualItems.length > 0 && rowItems[virtualItems[virtualItems.length - 1].index]
    ? itemRow(rowItems[virtualItems[virtualItems.length - 1].index])
    : totalRowCount

  // Expand range for edge visibility (edges can span many rows)
  const edgeBufferRows = 5
  const visStartRow = Math.max(0, startRow - edgeBufferRows)
  const visEndRow = Math.min(totalRowCount, endRow + edgeBufferRows)

  // Filter nodes, groups, edges to visible range
  const visibleNodes = useMemo(() =>
    layout.nodes.filter(n => n.row >= visStartRow && n.row <= visEndRow && n.row < maxRow),
    [layout.nodes, visStartRow, visEndRow, maxRow]
  )
  const visibleGroups = useMemo(() =>
    groups.filter(g => g.row >= visStartRow && g.row <= visEndRow && g.row < maxRow),
    [groups, visStartRow, visEndRow, maxRow]
  )
  const visibleEdges = useMemo(() =>
    layout.edges.filter(e => {
      if (e.toRow === -1 || e.fromRow >= maxRow) return false
      const eMin = Math.min(e.fromRow, e.toRow)
      const eMax = Math.max(e.fromRow, e.toRow)
      return eMax >= visStartRow && eMin <= visEndRow
    }),
    [layout.edges, visStartRow, visEndRow, maxRow]
  )

  const noMatches = matchSet !== null && matchSet.size === 0

  return (
    <div ref={scrollContainerRef} className={cn('h-full overflow-y-auto', className)}>
      {noMatches && (
        <div className="flex items-center justify-center h-16 text-xs text-muted-foreground">No matches</div>
      )}
      <div style={{ height: totalHeight, position: 'relative' }}>
        <svg className="absolute top-0 left-0 pointer-events-none" width={gutterWidth} height={totalHeight} style={{ zIndex: 0 }}>
          {visibleEdges.map((edge, i) => {
            const clampedEdge = edge.toRow >= maxRow
              ? { ...edge, toRow: maxRow - 1 }
              : edge
            return clampedEdge.type === 'straight'
              ? <SvgStraightEdge key={`e-${i}`} edge={clampedEdge} rowOffsets={activeRowOffsets} />
              : <SvgCurveEdge key={`e-${i}`} edge={clampedEdge} rowOffsets={activeRowOffsets} />
          })}
          {visibleNodes.map((node) => {
            const offset = activeRowOffsets.get(node.row) ?? 0
            const cx = colX(node.column) + (node.column === 0 ? offset : 0)
            const cy = rowY(node.row)
            const color = getColor(node.colorIndex)
            const dotType = node.isMerge ? 'merge' : 'regular'
            const dimmed = matchSet !== null && !matchSet.has(node.commit.hash)
            return <g key={node.commit.hash}>
              <SvgDot cx={cx} cy={cy} color={color} type={dotType} dimmed={dimmed} />
              {node.syntheticBranch && (() => {
                const bx = cx + MERGED_DOT_OFFSET + 12
                const sc = getColor(node.syntheticBranch.colorIndex)
                return <g opacity={dimmed ? 0.2 : undefined}>
                  <line x1={bx} y1={cy} x2={cx + DOT_RADIUS} y2={cy} stroke={sc} strokeWidth={2} opacity={0.35} />
                  <circle cx={bx} cy={cy} r={DOT_RADIUS} fill={sc} />
                </g>
              })()}
              {node.behindBranch && (() => {
                const bx = cx + DOT_RADIUS + 6
                const by = cy - 6
                const sc = getColor(node.behindBranch.colorIndex)
                return <g opacity={dimmed ? 0.2 : undefined}>
                  <circle cx={bx} cy={by} r={3} fill={sc} />
                </g>
              })()}
            </g>
          })}
          {visibleGroups.map((group) => {
            const cy = rowY(group.row)
            return <g key={`grp-${group.row}`}>
              {group.columns.map(({ col, colorIndex }) => (
                <SvgDot key={col} cx={colX(col)} cy={cy} color={getColor(colorIndex)} type="regular" dimmed />
              ))}
            </g>
          })}
        </svg>
        <DotOverlays items={[
          ...visibleNodes.map(node => ({
            key: node.commit.hash, row: node.row, column: node.column,
            color: getColor(node.colorIndex), branchName: colorBranch.get(node.colorIndex),
            xOffset: node.column === 0 ? (activeRowOffsets.get(node.row) ?? 0) : 0
          })),
          ...visibleNodes.filter(n => n.syntheticBranch).map(node => ({
            key: `${node.commit.hash}-synth`, row: node.row, column: node.column,
            color: getColor(node.syntheticBranch!.colorIndex), branchName: node.syntheticBranch!.branchName,
            xOffset: (activeRowOffsets.get(node.row) ?? 0) + MERGED_DOT_OFFSET + 12,
            isSynthetic: true
          })),
          ...visibleNodes.filter(n => n.behindBranch).map(node => ({
            key: `${node.commit.hash}-behind`, row: node.row, column: node.column,
            color: getColor(node.behindBranch!.colorIndex), branchName: node.behindBranch!.branchName,
            xOffset: DOT_RADIUS + 6,
            yOffset: -6
          }))
        ]} />
        {virtualItems.map((virtualRow) => {
          const item = rowItems[virtualRow.index]
          if (!item) return null
          if (item.type === 'commit') {
            const node = item.node
            const dimmed = matchSet !== null && !matchSet.has(node.commit.hash)
            const refs = [...node.commit.branchRefs, ...node.commit.tags.map(t => `🏷 ${t}`)]
            return (
              <div key={virtualRow.key} style={{
                position: 'absolute', top: 0, left: 0, width: '100%',
                height: ROW_HEIGHT, transform: `translateY(${virtualRow.start}px)`,
              }}>
                <CommitRow
                  shortHash={node.commit.shortHash} message={node.commit.message}
                  author={node.commit.author} relativeDate={node.commit.relativeDate}
                  refs={refs.length > 0 ? refs : undefined}
                  mergedFrom={node.commit.mergedFrom}
                  color={getColor(node.colorIndex)} gutterWidth={gutterWidth}
                  copiedHash={copiedHash} onCopy={handleCopy} dimmed={dimmed} />
              </div>
            )
          }
          const group = item.group
          const primaryColor = group.columns[0] ? getColor(group.columns[0].colorIndex) : getColor(0)
          return (
            <div key={virtualRow.key} style={{
              position: 'absolute', top: 0, left: 0, width: '100%',
              height: ROW_HEIGHT, transform: `translateY(${virtualRow.start}px)`,
            }}>
              <CommitGroupRow count={group.count} color={primaryColor} gutterWidth={gutterWidth} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

