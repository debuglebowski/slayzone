/**
 * Visual test suite for commit graph rendering.
 * Generates ASCII art + SVG images for each topology, outputs an HTML report.
 *
 * Run with: npx tsx packages/domains/worktrees/src/main/resolve-graph.visual.test.ts
 * Output:   packages/domains/worktrees/graph-visual-report.html
 */
import type { ResolvedCommit, DagCommit } from '../shared/types'
import { resolveCommitGraph } from './git-worktree'
import { computeDagLayout, computeCollapsedDag } from '../client/CommitGraph'
import type { DagLayout, LayoutNode, LayoutEdge, CollapsedDag } from '../client/CommitGraph'
import { writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

// ─── Helpers ────────────────────────────────────────────────────

let counter = 0
function makeHash(): string {
  return (++counter).toString(16).padStart(40, '0')
}

function resolved(overrides: Partial<ResolvedCommit> & { hash: string; message: string; branch: string }): ResolvedCommit {
  return {
    shortHash: overrides.hash.slice(0, 7),
    author: 'test',
    relativeDate: '1 min ago',
    parents: [],
    branchRefs: [],
    tags: [],
    isBranchTip: false,
    isHead: false,
    ...overrides,
  }
}

function dag(overrides: Partial<DagCommit> & { message: string }): DagCommit {
  const hash = overrides.hash ?? makeHash()
  return {
    hash,
    shortHash: hash.slice(0, 7),
    author: 'test',
    relativeDate: '1 min ago',
    parents: [],
    refs: [],
    ...overrides,
  }
}

// ─── Color palette (matches CommitGraph.tsx) ────────────────────

const COLUMN_COLORS = [
  '#e2e2e2', '#a78bfa', '#f59e0b', '#10b981', '#f472b6',
  '#06b6d4', '#ef4444', '#8b5cf6', '#14b8a6', '#f97316', '#22d3ee',
]
function getColor(index: number): string {
  const len = COLUMN_COLORS.length
  return COLUMN_COLORS[((index % len) + len) % len]
}

// ─── ASCII renderer ─────────────────────────────────────────────
//
// Grid approach: each layout column maps to COL_W character positions.
// Between each pair of node rows, a routing line shows fork/merge curves.
//
// Pure ASCII characters:
//   *  commit    @  merge    o  synthetic branch dot
//   |  vertical  :  dashed vertical
//   -  horizontal  .  dashed horizontal
//   +  T-right/left/cross (vert continues + branch)
//   \  corner (arrives from left, continues down)
//   /  corner (arrives from right, continues down)

const COL_W = 2 // character positions per layout column

interface AsciiResult {
  lines: string[]
  legend: Map<string, number> // branch → colorIndex
}

function renderAscii(layout: DagLayout | CollapsedDag): AsciiResult {
  const { nodes, edges, maxColumn } = layout
  if (nodes.length === 0) return { lines: ['(empty)'], legend: new Map() }

  // Git log style renderer.
  // Each layout row produces a commit line. Cross-column edges insert a
  // merge/fork line (e.g. |/ or |\) between the commit above and the
  // target commit.

  const nodeByRow = new Map<number, LayoutNode>()
  for (const n of nodes) nodeByRow.set(n.row, n)
  const maxRow = Math.max(...nodes.map(n => n.row))
  const graphW = (maxColumn + 1) * COL_W

  // Pre-compute active columns at each row (which cols have a vertical line passing through)
  // A column is active on row Y if any edge has fromRow <= Y <= toRow on that column.
  const activeAtRow = new Map<number, Set<number>>()
  for (let y = 0; y <= maxRow; y++) activeAtRow.set(y, new Set())

  for (const edge of edges) {
    if (edge.fromCol === edge.toCol) {
      for (let y = edge.fromRow; y <= edge.toRow; y++) {
        activeAtRow.get(y)!.add(edge.fromCol)
      }
    } else {
      // Cross-col: source col is active from fromRow to toRow-1, target col from toRow onward (handled by other edges)
      for (let y = edge.fromRow; y < edge.toRow; y++) {
        activeAtRow.get(y)!.add(edge.fromCol)
      }
    }
  }

  // Pre-compute cross-column edges arriving at each row (for merge/fork lines)
  const crossEdgesAt = new Map<number, Array<{ fromCol: number; toCol: number; dashed?: boolean }>>()
  for (const edge of edges) {
    if (edge.fromCol === edge.toCol) continue
    const arr = crossEdgesAt.get(edge.toRow) ?? []
    arr.push({ fromCol: edge.fromCol, toCol: edge.toCol, dashed: edge.dashed })
    crossEdgesAt.set(edge.toRow, arr)
  }

  // Check if the edge BELOW a given row/col is dashed.
  // An edge from fromRow→toRow is dashed on rows fromRow to toRow-1 (the segment between those commits).
  const dashedBelow = new Map<string, boolean>()
  for (const edge of edges) {
    if (!edge.dashed) continue
    if (edge.fromCol === edge.toCol) {
      for (let y = edge.fromRow; y < edge.toRow; y++) {
        dashedBelow.set(`${y},${edge.fromCol}`, true)
      }
    } else {
      for (let y = edge.fromRow; y < edge.toRow; y++) {
        dashedBelow.set(`${y},${edge.fromCol}`, true)
      }
    }
  }

  const legend = new Map<string, number>()
  const lines: string[] = []

  function makeLine(graphW: number): string[] { return Array(graphW).fill(' ') }

  for (let row = 0; row <= maxRow; row++) {
    const node = nodeByRow.get(row)
    const active = activeAtRow.get(row)!
    const crossEdges = crossEdgesAt.get(row)

    // Insert merge/fork line before this commit if there are cross-column edges arriving
    if (crossEdges && crossEdges.length > 0) {
      // Insert one merge line per column step needed.
      // For adjacent columns (diff=1): single |/ or |\ line.
      // For wider gaps: multiple lines stepping one column at a time.
      const mergingAway = new Set<number>()
      for (const ce of crossEdges) mergingAway.add(ce.fromCol)

      // Find max steps needed
      const maxSteps = Math.max(...crossEdges.map(ce => Math.abs(ce.fromCol - ce.toCol)))

      for (let step = 0; step < maxSteps; step++) {
        const line = makeLine(graphW)
        // Draw active verticals (skip columns being merged)
        const prevActive = row > 0 ? activeAtRow.get(row - 1)! : new Set<number>()
        for (const col of prevActive) {
          if (mergingAway.has(col)) continue
          const x = col * COL_W
          const ch = dashedBelow.get(`${row - 1},${col}`) ? ':' : '|'
          if (line[x] === ' ') line[x] = ch
        }
        // Draw diagonal for each cross edge at this step
        for (const ce of crossEdges) {
          const totalSteps = Math.abs(ce.fromCol - ce.toCol)
          if (step >= totalSteps) continue
          const dir = ce.fromCol > ce.toCol ? -1 : 1
          const curCol = ce.fromCol + dir * step
          const nextCol = curCol + dir
          const curX = curCol * COL_W
          const nextX = nextCol * COL_W
          if (dir > 0) {
            line[curX + 1] = '\\'
          } else {
            line[nextX + 1] = '/'
          }
          // Also draw continuing vertical on columns not yet merged
          if (step < totalSteps - 1) {
            // intermediate: show vertical at current position
          }
        }
        const trimmed = line.join('').trimEnd()
        if (trimmed.trim()) lines.push(trimmed)
      }
    }

    // Commit line
    const line = makeLine(graphW)

    // Draw active verticals
    for (const col of active) {
      const x = col * COL_W
      const ch = dashedBelow.get(`${row},${col}`) ? ':' : '|'
      line[x] = ch
    }

    // Draw node
    if (node) {
      const x = node.column * COL_W
      line[x] = node.isMerge ? '@' : '*'
      legend.set(node.commit.branch, node.colorIndex)
      if (node.syntheticBranch) {
        line[node.syntheticBranch.column * COL_W] = 'o'
      }
    }

    // Build label
    const graphLine = line.join('').trimEnd()
    if (node) {
      const parts: string[] = [node.commit.shortHash]
      const behindName = node.behindBranch?.branchName
      const owningRefs = node.commit.branchRefs.filter(r => r !== behindName)
      if (owningRefs.length > 0) parts.push(`(${owningRefs.join(', ')})`)
      if (behindName) parts.push(`[<- ${behindName}]`)
      if (node.commit.tags.length > 0) parts.push(`[${node.commit.tags.join(', ')}]`)
      if (node.syntheticBranch) parts.push(`<- ${node.syntheticBranch.branchName}`)
      parts.push(node.commit.message.slice(0, 40))
      const trimmed = graphLine.trimEnd()
      lines.push(`${trimmed} ${parts.join(' ')}`)
    } else if (graphLine.trim()) {
      lines.push(graphLine)
    }

    // Continuation line: draw | for all active columns between this row and next
    if (row < maxRow) {
      const contLine = makeLine(graphW)
      for (const col of active) {
        const x = col * COL_W
        const ch = dashedBelow.get(`${row},${col}`) ? ':' : '|'
        contLine[x] = ch
      }
      const contStr = contLine.join('').trimEnd()
      if (contStr.trim()) lines.push(contStr)
    }
  }

  return { lines, legend }
}

// ─── SVG renderer ───────────────────────────────────────────────

const SVG_ROW_H = 44
const SVG_COL_W = 24
const SVG_DOT_R = 4
const SVG_MERGE_R = 6
const SVG_GUTTER = 12
const SVG_LABEL_OFFSET = 16

function svgColX(col: number): number { return col * SVG_COL_W + SVG_COL_W / 2 + SVG_GUTTER / 2 }
function svgRowY(row: number): number { return row * SVG_ROW_H + SVG_ROW_H / 2 }

function renderSvg(layout: DagLayout | CollapsedDag): string {
  const { nodes, edges, maxColumn } = layout
  if (nodes.length === 0) return '<svg width="100" height="30"><text x="10" y="20" fill="#888">(empty)</text></svg>'

  const maxRow = Math.max(...nodes.map(n => n.row))
  const graphWidth = (maxColumn + 1) * SVG_COL_W + SVG_GUTTER
  const labelWidth = 320
  const svgWidth = graphWidth + labelWidth
  const svgHeight = (maxRow + 1) * SVG_ROW_H + 10

  const parts: string[] = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" style="font-family: ui-monospace, monospace; font-size: 11px;">`)
  parts.push(`<rect width="100%" height="100%" fill="#1a1a1a" rx="6"/>`)

  // Edges
  for (const edge of edges) {
    const x1 = svgColX(edge.fromCol), y1 = svgRowY(edge.fromRow)
    const x2 = svgColX(edge.toCol), y2 = svgRowY(edge.toRow)
    const color = edge.color
    const dash = edge.dashed ? ' stroke-dasharray="4 3"' : ''

    if (edge.type === 'curve' || x1 !== x2) {
      const dy = y2 - y1
      parts.push(`<path d="M${x1},${y1} C${x1},${y1 + dy * 0.4} ${x2},${y2 - dy * 0.4} ${x2},${y2}" stroke="${color}" stroke-width="2" fill="none" opacity="0.45"${dash}/>`)
    } else {
      parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="2" opacity="0.45"${dash}/>`)
    }

    // Collapsed count badge
    if ('collapsedCount' in edge && edge.collapsedCount && edge.collapsedCount > 0) {
      const midX = (x1 + x2) / 2
      const midY = (y1 + y2) / 2
      parts.push(`<rect x="${midX - 10}" y="${midY - 7}" width="20" height="14" rx="3" fill="#333" stroke="#555" stroke-width="0.5"/>`)
      parts.push(`<text x="${midX}" y="${midY + 4}" fill="#888" text-anchor="middle" font-size="9">+${edge.collapsedCount}</text>`)
    }
  }

  // Nodes
  for (const node of nodes) {
    const cx = svgColX(node.column)
    const cy = svgRowY(node.row)
    const color = getColor(node.colorIndex)

    if (node.isMerge) {
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${SVG_MERGE_R}" fill="none" stroke="${color}" stroke-width="2"/>`)
      parts.push(`<circle cx="${cx}" cy="${cy}" r="3" fill="#1a1a1a"/>`)
    } else {
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${SVG_DOT_R}" fill="${color}"/>`)
    }

    // Synthetic branch dot (positioned relative to commit dot, like the real app)
    if (node.syntheticBranch) {
      const sx = cx + 18, sy = cy + 14
      const sc = getColor(node.syntheticBranch.colorIndex)
      parts.push(`<path d="M${sx},${sy} C${cx + 4},${sy} ${cx},${cy + 4} ${cx},${cy}" stroke="${sc}" stroke-width="1.5" fill="none" opacity="0.4"/>`)
      parts.push(`<circle cx="${sx}" cy="${sy}" r="3" fill="${sc}" opacity="0.7"/>`)
      parts.push(`<text x="${sx + 6}" y="${sy + 3}" fill="${sc}" font-size="9" font-style="italic" opacity="0.6">${escXml(node.syntheticBranch.branchName)}</text>`)
    }

    // Behind-branch indicator: small dot + curve on the graph, italic label above the commit text
    if (node.behindBranch) {
      const bx = cx + 14, by = cy - 14
      const bc = getColor(node.behindBranch.colorIndex)
      parts.push(`<path d="M${bx},${by} C${cx + 4},${by} ${cx},${cy - 4} ${cx},${cy}" stroke="${bc}" stroke-width="1.5" fill="none" opacity="0.4"/>`)
      parts.push(`<circle cx="${bx}" cy="${by}" r="2.5" fill="${bc}" opacity="0.7"/>`)
      // Label above the commit line
      const blx = graphWidth + 4
      parts.push(`<text x="${blx}" y="${cy - 10}" fill="${bc}" font-size="9" font-style="italic" opacity="0.6">${escXml(node.behindBranch.branchName)}</text>`)
    }

    // Label
    const lx = graphWidth + 4
    const ly = cy + 4
    const behindName = node.behindBranch?.branchName
    const refs = node.commit.branchRefs.filter(r => r !== behindName)
    const tags = node.commit.tags
    const msg = node.commit.message.slice(0, 36)
    let label = `<tspan fill="#888">${escXml(node.commit.shortHash)}</tspan>`
    if (refs.length > 0) label += ` <tspan fill="${color}" font-weight="bold">${escXml(refs.join(', '))}</tspan>`
    if (tags.length > 0) label += ` <tspan fill="#f59e0b">[${escXml(tags.join(', '))}]</tspan>`
    label += ` <tspan fill="#ccc">${escXml(msg)}</tspan>`
    parts.push(`<text x="${lx}" y="${ly}">${label}</text>`)
  }

  parts.push('</svg>')
  return parts.join('\n')
}

function escXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ─── Test cases ─────────────────────────────────────────────────

interface TestCase {
  name: string
  description: string
  commits: ResolvedCommit[]
  baseBranch: string
  /** If set, also generate collapsed view */
  collapsed?: { includeTags?: boolean; breakOnMerges?: boolean; recentRowThreshold?: number }
}

interface RawTestCase {
  name: string
  description: string
  rawCommits: DagCommit[]
  baseBranch: string
  requestedBranches?: string[]
  collapsed?: { includeTags?: boolean; breakOnMerges?: boolean; recentRowThreshold?: number }
}

const cases: (TestCase | RawTestCase)[] = []

// ── 1. Linear history ───────────────────────────────────────────
{
  const c1 = makeHash(), c2 = makeHash(), c3 = makeHash(), c4 = makeHash()
  cases.push({
    name: 'Linear history',
    description: '4 commits on main, no branches',
    commits: [
      resolved({ hash: c1, message: 'add dark mode', branch: 'main', parents: [c2], branchRefs: ['main'], isBranchTip: true, isHead: true }),
      resolved({ hash: c2, message: 'fix lint errors', branch: 'main', parents: [c3] }),
      resolved({ hash: c3, message: 'initial commit', branch: 'main', parents: [c4] }),
      resolved({ hash: c4, message: 'project setup', branch: 'main', parents: [] }),
    ],
    baseBranch: 'main',
  })
}

// ── 2. Single feature branch ────────────────────────────────────
{
  const m1 = makeHash(), m2 = makeHash(), f1 = makeHash(), f2 = makeHash(), base = makeHash()
  cases.push({
    name: 'Single feature branch',
    description: 'Feature branch diverges from main, both advance',
    commits: [
      resolved({ hash: f1, message: 'feat: add search', branch: 'feature/search', parents: [f2], branchRefs: ['feature/search'], isBranchTip: true }),
      resolved({ hash: m1, message: 'fix: typo in readme', branch: 'main', parents: [m2], branchRefs: ['main'], isBranchTip: true, isHead: true }),
      resolved({ hash: f2, message: 'feat: search index', branch: 'feature/search', parents: [base] }),
      resolved({ hash: m2, message: 'chore: update deps', branch: 'main', parents: [base] }),
      resolved({ hash: base, message: 'shared base', branch: 'main', parents: [] }),
    ],
    baseBranch: 'main',
  })
}

// ── 3. Multiple branches from main ──────────────────────────────
{
  const m1 = makeHash(), b1 = makeHash(), b2 = makeHash(), b3 = makeHash(), base = makeHash()
  cases.push({
    name: 'Three branches from main',
    description: 'Three feature branches fork from the same base commit',
    commits: [
      resolved({ hash: b1, message: 'auth: add OAuth', branch: 'auth', parents: [base], branchRefs: ['auth'], isBranchTip: true }),
      resolved({ hash: b2, message: 'ui: new sidebar', branch: 'ui-refresh', parents: [base], branchRefs: ['ui-refresh'], isBranchTip: true }),
      resolved({ hash: b3, message: 'perf: cache layer', branch: 'perf', parents: [base], branchRefs: ['perf'], isBranchTip: true }),
      resolved({ hash: m1, message: 'main tip', branch: 'main', parents: [base], branchRefs: ['main'], isBranchTip: true, isHead: true }),
      resolved({ hash: base, message: 'v1.0 release', branch: 'main', parents: [] }),
    ],
    baseBranch: 'main',
  })
}

// ── 4. Merge commit ─────────────────────────────────────────────
{
  const merge = makeHash(), m1 = makeHash(), f1 = makeHash(), base = makeHash()
  cases.push({
    name: 'Merge commit',
    description: 'Feature branch merged into main via merge commit',
    commits: [
      resolved({ hash: merge, message: 'Merge feature into main', branch: 'main', parents: [m1, f1], branchRefs: ['main'], isBranchTip: true, isHead: true }),
      resolved({ hash: f1, message: 'feat: add widget', branch: 'feature', parents: [base], branchRefs: ['feature'], isBranchTip: true }),
      resolved({ hash: m1, message: 'fix: button color', branch: 'main', parents: [base] }),
      resolved({ hash: base, message: 'initial', branch: 'main', parents: [] }),
    ],
    baseBranch: 'main',
  })
}

// ── 5. Nested branches ──────────────────────────────────────────
{
  const m = makeHash(), d1 = makeHash(), d2 = makeHash(), a1 = makeHash(), a2 = makeHash()
  cases.push({
    name: 'Nested branches',
    description: 'api forks from dashboard which forks from main',
    commits: [
      resolved({ hash: a1, message: 'api: endpoint', branch: 'api', parents: [a2], branchRefs: ['api'], isBranchTip: true }),
      resolved({ hash: a2, message: 'api: schema', branch: 'api', parents: [d1] }),
      resolved({ hash: d1, message: 'dash: layout', branch: 'dashboard', parents: [d2], branchRefs: ['dashboard'], isBranchTip: true }),
      resolved({ hash: d2, message: 'dash: routing', branch: 'dashboard', parents: [m] }),
      resolved({ hash: m, message: 'main base', branch: 'main', parents: [], branchRefs: ['main'], isBranchTip: true, isHead: true }),
    ],
    baseBranch: 'main',
  })
}

// ── 6. Behind branch (branch tip on main's first-parent chain) ──
{
  const m1 = makeHash(), m2 = makeHash(), m3 = makeHash()
  cases.push({
    name: 'Behind branch',
    description: 'worktree-test points at an ancestor of main tip (behind branch)',
    commits: [
      resolved({ hash: m1, message: 'latest main', branch: 'main', parents: [m2], branchRefs: ['main'], isBranchTip: true, isHead: true }),
      resolved({ hash: m2, message: 'middle commit', branch: 'main', parents: [m3], branchRefs: ['worktree-test'], isBranchTip: true }),
      resolved({ hash: m3, message: 'old commit', branch: 'main', parents: [] }),
    ],
    baseBranch: 'main',
  })
}

// ── 7. Diverged local/remote ────────────────────────────────────
{
  const local = makeHash(), remote = makeHash(), shared = makeHash(), base = makeHash()
  cases.push({
    name: 'Diverged local/remote',
    description: 'origin/main on col 0 (trunk), local main forks off as side branch',
    commits: [
      resolved({ hash: local, message: 'local-only work', branch: 'main', parents: [shared], branchRefs: ['main'], isBranchTip: true, isHead: true }),
      resolved({ hash: remote, message: 'remote-only commit', branch: 'origin/main', parents: [shared], branchRefs: ['origin/main'], isBranchTip: true }),
      resolved({ hash: shared, message: 'last push', branch: 'origin/main', parents: [base] }),
      resolved({ hash: base, message: 'initial', branch: 'origin/main', parents: [] }),
    ],
    baseBranch: 'main',
  })
}

// ── 8. Dashed edges (local-only ahead) ──────────────────────────
{
  const tip = makeHash(), ahead = makeHash(), origin = makeHash(), base = makeHash()
  cases.push({
    name: 'Dashed edges (unpushed)',
    description: 'Local commits ahead of origin/main shown with dashed edges',
    commits: [
      resolved({ hash: tip, message: 'wip: not pushed', branch: 'main', parents: [ahead], branchRefs: ['main'], isBranchTip: true, isHead: true }),
      resolved({ hash: ahead, message: 'also unpushed', branch: 'main', parents: [origin] }),
      resolved({ hash: origin, message: 'last pushed', branch: 'main', parents: [base], branchRefs: ['origin/main'] }),
      resolved({ hash: base, message: 'base', branch: 'main', parents: [] }),
    ],
    baseBranch: 'main',
  })
}

// ── 9. Real PR history (raw DagCommits → resolve → layout) ──────
{
  cases.push({
    name: 'Real PR merges (raw git data)',
    description: '3 merged PRs with second-parent squash commits, synthetic branch dots',
    rawCommits: [
      dag({ hash: '512265a', message: 'feat: double git panel commit count', refs: ['HEAD -> refs/heads/main'], parents: ['a4be17b'] }),
      dag({ hash: 'a4be17b', message: 'Merge pull request #30 from user/fix/worktree-remove', refs: [], parents: ['caa4377', '935968d'] }),
      dag({ hash: '935968d', message: 'fix(worktrees): handle deleted path', refs: [], parents: ['fd05813'] }),
      dag({ hash: 'caa4377', message: 'release: v0.2.6', refs: ['tag: refs/tags/v0.2.6'], parents: ['28ac5b8'] }),
      dag({ hash: '28ac5b8', message: 'chore(settings): rename theme labels', refs: [], parents: ['1eefed1'] }),
      dag({ hash: '1eefed1', message: 'fix(usage): add caching', refs: [], parents: ['b448b61'] }),
      dag({ hash: 'b448b61', message: 'feat(integrations): repo selector', refs: [], parents: ['d7eab12'] }),
      dag({ hash: 'd7eab12', message: 'docs: e2e test isolation notes', refs: [], parents: ['3037874'] }),
      dag({ hash: '3037874', message: 'Merge pull request #27 from user/fix/postinstall', refs: [], parents: ['ad1c3b7', '81eefa1'] }),
      dag({ hash: '81eefa1', message: 'fix: scoped electron-rebuild', refs: [], parents: ['fd05813'] }),
      dag({ hash: 'ad1c3b7', message: 'Merge pull request #31 from user/fix/terminal-copy', refs: [], parents: ['783008c', '7d1ff27'] }),
      dag({ hash: '7d1ff27', message: 'fix(terminal): Ctrl+Shift+C/V', refs: [], parents: ['363d1ea'] }),
      dag({ hash: '783008c', message: 'refactor(test-panel): stacked cards', refs: [], parents: ['8078e51'] }),
      dag({ hash: '8078e51', message: 'feat(integrations): bidirectional sync', refs: [], parents: ['5c141ab'] }),
      dag({ hash: '5c141ab', message: 'feat(test-panel): file notes', refs: [], parents: ['363d1ea'] }),
      dag({ hash: '363d1ea', message: 'fix(ci): merge multi-arch manifests', refs: [], parents: ['fd05813'] }),
      dag({ hash: 'fd05813', message: 'refactor(ai-config): unify context sync', refs: [], parents: [] }),
    ],
    baseBranch: 'main',
    requestedBranches: ['main'],
    collapsed: { includeTags: true, breakOnMerges: true },
  } satisfies RawTestCase)
}

// ── 10. Many interleaving branches ──────────────────────────────
{
  const m = makeHash()
  const base1 = makeHash(), base2 = makeHash()
  const a1 = makeHash(), a2 = makeHash()
  const b1 = makeHash(), b2 = makeHash()
  const c1 = makeHash(), c2 = makeHash()
  cases.push({
    name: 'Interleaving branches',
    description: 'Three branches with commits interleaved in topo order',
    commits: [
      resolved({ hash: a1, message: 'alpha tip', branch: 'alpha', parents: [a2], branchRefs: ['alpha'], isBranchTip: true }),
      resolved({ hash: b1, message: 'beta tip', branch: 'beta', parents: [b2], branchRefs: ['beta'], isBranchTip: true }),
      resolved({ hash: c1, message: 'gamma tip', branch: 'gamma', parents: [c2], branchRefs: ['gamma'], isBranchTip: true }),
      resolved({ hash: m, message: 'main tip', branch: 'main', parents: [base1], branchRefs: ['main'], isBranchTip: true, isHead: true }),
      resolved({ hash: a2, message: 'alpha work', branch: 'alpha', parents: [base1] }),
      resolved({ hash: b2, message: 'beta work', branch: 'beta', parents: [base1] }),
      resolved({ hash: c2, message: 'gamma work', branch: 'gamma', parents: [base2] }),
      resolved({ hash: base1, message: 'main mid', branch: 'main', parents: [base2] }),
      resolved({ hash: base2, message: 'main root', branch: 'main', parents: [] }),
    ],
    baseBranch: 'main',
    collapsed: {},
  })
}

// ── 11. Tags on linear history ──────────────────────────────────
{
  const c1 = makeHash(), c2 = makeHash(), c3 = makeHash(), c4 = makeHash(), c5 = makeHash()
  cases.push({
    name: 'Tags on linear history',
    description: 'Collapsed view should break at tagged commits',
    commits: [
      resolved({ hash: c1, message: 'latest', branch: 'main', parents: [c2], branchRefs: ['main'], isBranchTip: true, isHead: true }),
      resolved({ hash: c2, message: 'post-release fix', branch: 'main', parents: [c3] }),
      resolved({ hash: c3, message: 'release v2.0', branch: 'main', parents: [c4], tags: ['v2.0'] }),
      resolved({ hash: c4, message: 'pre-release work', branch: 'main', parents: [c5] }),
      resolved({ hash: c5, message: 'release v1.0', branch: 'main', parents: [], tags: ['v1.0'] }),
    ],
    baseBranch: 'main',
    collapsed: { includeTags: true },
  })
}

// ── 12. Column reuse ────────────────────────────────────────────
{
  const m1 = makeHash(), m2 = makeHash(), m3 = makeHash()
  const a1 = makeHash(), b1 = makeHash()
  cases.push({
    name: 'Column reuse',
    description: 'Branch A ends before B starts — B can reuse A\'s column',
    commits: [
      resolved({ hash: a1, message: 'alpha tip', branch: 'alpha', parents: [m1], branchRefs: ['alpha'], isBranchTip: true }),
      resolved({ hash: m1, message: 'main after alpha', branch: 'main', parents: [m2], branchRefs: ['main'], isBranchTip: true, isHead: true }),
      resolved({ hash: b1, message: 'beta tip', branch: 'beta', parents: [m3], branchRefs: ['beta'], isBranchTip: true }),
      resolved({ hash: m2, message: 'main mid', branch: 'main', parents: [m3] }),
      resolved({ hash: m3, message: 'main root', branch: 'main', parents: [] }),
    ],
    baseBranch: 'main',
  })
}

// ── 13. Merge commit with worktree branch (baseBranch preference) ─
{
  cases.push({
    name: 'Merge + worktree branches',
    description: 'main and add-funny-stuff both ref the merge commit. baseBranch=main gets col 0, move-to-convex on col 1. Cross-column edges use side branch color.',
    rawCommits: [
      dag({ hash: '5343284', message: "Merge branch 'move-to-convex'", refs: ['HEAD -> refs/heads/add-funny-stuff', 'refs/heads/main'], parents: ['0e3335b', 'bc87769'] }),
      dag({ hash: 'bc87769', message: 'migrate from Supabase to Convex', refs: ['refs/heads/move-to-convex'], parents: ['0e3335b'] }),
      dag({ hash: '0e3335b', message: 'switch to non-streaming Haiku 4.5', refs: [], parents: ['3cb615f'] }),
      dag({ hash: '3cb615f', message: 'feat: unified chat+preview builder', refs: [], parents: ['cece7da'] }),
      dag({ hash: 'cece7da', message: 'feat: add placeholder pages', refs: [], parents: ['4ab3c3a'] }),
      dag({ hash: '4ab3c3a', message: 'fix: remove footer flame effect', refs: [], parents: ['5016e6f'] }),
      dag({ hash: '5016e6f', message: 'init: Hatable', refs: [], parents: [] }),
    ],
    baseBranch: 'main',
    requestedBranches: ['main', 'add-funny-stuff', 'move-to-convex'],
  } satisfies RawTestCase)
}

// ── 14. Remote-only ahead (no divergence) ────────────────────────
{
  const base = makeHash(), localTip = makeHash(), r2 = makeHash(), r1 = makeHash()
  cases.push({
    name: 'Remote-only ahead',
    description: 'origin/main ahead of local — same column, origin/main as display ref',
    commits: [
      resolved({ hash: r1, message: 'remote commit 1', branch: 'main', parents: [r2], branchRefs: ['origin/main'] }),
      resolved({ hash: r2, message: 'remote commit 2', branch: 'main', parents: [localTip] }),
      resolved({ hash: localTip, message: 'local tip', branch: 'main', parents: [base], branchRefs: ['main'], isBranchTip: true, isHead: true }),
      resolved({ hash: base, message: 'shared base', branch: 'main', parents: [] }),
    ],
    baseBranch: 'main',
  })
}

// ── 15. Local and origin at same commit ──────────────────────────
{
  const tip = makeHash(), parent = makeHash()
  cases.push({
    name: 'Synced (no divergence)',
    description: 'Local and origin/main point at the same commit — no dashes, no split',
    commits: [
      resolved({ hash: tip, message: 'synced tip', branch: 'main', parents: [parent], branchRefs: ['main', 'origin/main'], isBranchTip: true, isHead: true }),
      resolved({ hash: parent, message: 'parent', branch: 'main', parents: [] }),
    ],
    baseBranch: 'main',
  })
}

// ── 16. Diverged with shared history (real-world PR merges) ──────
{
  cases.push({
    name: 'Diverged with shared history',
    description: 'Local has 1 new commit, origin has 1. Shared PR merge history below. Shared = col 0, local = col 1 dashed.',
    commits: [
      resolved({ hash: 'local1', message: 'local-only work', branch: 'main', parents: ['512265a'], branchRefs: ['main'], isBranchTip: true, isHead: true }),
      resolved({ hash: '512265a', message: 'feat: double git panel count', branch: 'origin/main', parents: ['a4be17b'] }),
      resolved({ hash: 'a4be17b', message: 'Merge PR #30 fix/worktree-remove', branch: 'origin/main', parents: ['caa4377'] }),
      resolved({ hash: '935968d', message: 'fix(worktrees): handle deleted path', branch: 'origin/main', parents: ['caa4377'], mergedFrom: 'worktree-remove' }),
      resolved({ hash: 'caa4377', message: 'release: v0.2.6', branch: 'origin/main', parents: ['548abbc'], tags: ['v0.2.6'] }),
      resolved({ hash: '548abbc', message: 'chore: remove noisy log', branch: 'origin/main', parents: ['61fb34c'] }),
      resolved({ hash: '4327416', message: 'chore(nix): update sources to 0.4.0', branch: 'origin/main', parents: ['61fb34c'], branchRefs: ['origin/main'], isBranchTip: true }),
      resolved({ hash: '61fb34c', message: 'release: v0.4.0', branch: 'origin/main', parents: [], tags: ['v0.4.0'] }),
    ],
    baseBranch: 'main',
  })
}

// ── 17. Diverged with behind branch on local chain ───────────────
{
  const fork = makeHash(), l3 = makeHash(), l2 = makeHash(), l1 = makeHash(), r1 = makeHash()
  cases.push({
    name: 'Diverged + behind branch',
    description: 'Behind branch (worktree-test) tip is on local main chain — should show indicator on local column, not trunk',
    commits: [
      resolved({ hash: l1, message: 'local work', branch: 'main', parents: [l2], branchRefs: ['main'], isBranchTip: true, isHead: true }),
      resolved({ hash: l2, message: 'also local', branch: 'change-title', parents: [l3], branchRefs: ['change-title'], isBranchTip: true }),
      resolved({ hash: l3, message: 'more local', branch: 'main', parents: [fork] }),
      resolved({ hash: r1, message: 'remote only', branch: 'origin/main', parents: [fork], branchRefs: ['origin/main'], isBranchTip: true }),
      resolved({ hash: fork, message: 'fork point', branch: 'origin/main', parents: [] }),
    ],
    baseBranch: 'main',
  })
}

// ── 18. Mixed: main diverged + feature ahead-only ────────────────
{
  const base = makeHash(), l1 = makeHash(), r1 = makeHash()
  const f1 = makeHash(), f2 = makeHash(), rf1 = makeHash()
  cases.push({
    name: 'Mixed diverged + ahead',
    description: 'main diverged (2 lanes), feature/api only ahead (origin/feature above local tip, same lane)',
    commits: [
      resolved({ hash: l1, message: 'local main', branch: 'main', parents: [base], branchRefs: ['main'], isBranchTip: true, isHead: true }),
      resolved({ hash: r1, message: 'remote main', branch: 'origin/main', parents: [base], branchRefs: ['origin/main'], isBranchTip: true }),
      resolved({ hash: rf1, message: 'remote feat ahead', branch: 'feature/api', parents: [f1], branchRefs: ['origin/feature/api'] }),
      resolved({ hash: f1, message: 'feat local tip', branch: 'feature/api', parents: [base], branchRefs: ['feature/api'], isBranchTip: true }),
      resolved({ hash: base, message: 'shared base', branch: 'origin/main', parents: [] }),
    ],
    baseBranch: 'main',
  })
}

// ── 19. Diverged feature branch ──────────────────────────────────
{
  const base = makeHash(), m1 = makeHash(), f1 = makeHash(), rf1 = makeHash()
  cases.push({
    name: 'Diverged feature branch',
    description: 'feature/search diverged from origin/feature/search — both get separate columns',
    commits: [
      resolved({ hash: m1, message: 'main tip', branch: 'main', parents: [base], branchRefs: ['main'], isBranchTip: true, isHead: true }),
      resolved({ hash: f1, message: 'local feat', branch: 'feature/search', parents: [base], branchRefs: ['feature/search'], isBranchTip: true }),
      resolved({ hash: rf1, message: 'remote feat', branch: 'origin/feature/search', parents: [base], branchRefs: ['origin/feature/search'], isBranchTip: true }),
      resolved({ hash: base, message: 'shared base', branch: 'main', parents: [] }),
    ],
    baseBranch: 'main',
  })
}

// ─── Generate report ────────────────────────────────────────────

interface RenderResult {
  name: string
  description: string
  ascii: AsciiResult
  svg: string
  collapsedAscii?: AsciiResult
  collapsedSvg?: string
}

const results: RenderResult[] = []

for (const tc of cases) {
  let commits: ResolvedCommit[]
  let baseBranch: string

  if ('rawCommits' in tc) {
    const g = resolveCommitGraph(tc.rawCommits, tc.baseBranch, tc.requestedBranches)
    commits = g.commits
    baseBranch = g.baseBranch
  } else {
    commits = tc.commits
    baseBranch = tc.baseBranch
  }

  const layout = computeDagLayout(commits, baseBranch)
  const ascii = renderAscii(layout)
  const svg = renderSvg(layout)

  let collapsedAscii: AsciiResult | undefined
  let collapsedSvg: string | undefined

  if (tc.collapsed) {
    const collapsed = computeCollapsedDag(layout, baseBranch, tc.collapsed.includeTags, tc.collapsed.breakOnMerges, tc.collapsed.recentRowThreshold)
    collapsedAscii = renderAscii(collapsed)
    collapsedSvg = renderSvg(collapsed)
  }

  results.push({ name: tc.name, description: tc.description, ascii, svg, collapsedAscii, collapsedSvg })

  // Console output
  console.log(`\n━━ ${tc.name} ━━`)
  console.log(`   ${tc.description}`)
  for (const line of ascii.lines) console.log(`   ${line}`)
  if (collapsedAscii) {
    console.log(`   ── collapsed ──`)
    for (const line of collapsedAscii.lines) console.log(`   ${line}`)
  }
}

// ─── HTML report ────────────────────────────────────────────────

function generateHtml(results: RenderResult[]): string {
  const sections = results.map(r => {
    const asciiBlock = escXml(r.ascii.lines.join('\n'))
    const collapsedSection = r.collapsedAscii && r.collapsedSvg ? `
      <h3>Collapsed View</h3>
      <div class="pair">
        <div class="ascii"><pre>${escXml(r.collapsedAscii.lines.join('\n'))}</pre></div>
        <div class="svg">${r.collapsedSvg}</div>
      </div>` : ''

    const slug = escXml(r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'))
    return `
    <section data-test="${slug}">
      <div class="header" onclick="toggleCollapse('${slug}')" style="cursor:pointer">
        <div style="display:flex;align-items:center;gap:8px">
          <span class="collapse-icon">▼</span>
          <div>
            <h2>${escXml(r.name)}</h2>
            <p class="desc">${escXml(r.description)}</p>
          </div>
        </div>
        <button class="approve-btn" onclick="event.stopPropagation();toggleApprove('${slug}')"></button>
      </div>
      <div class="body">
        <h3>Full View</h3>
        <div class="pair">
          <div class="ascii"><pre>${asciiBlock}</pre></div>
          <div class="svg">${r.svg}</div>
        </div>
        ${collapsedSection}
      </div>
    </section>`
  }).join('\n')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Commit Graph Visual Tests</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #111; color: #ddd; font-family: system-ui, sans-serif; padding: 24px; }
  h1 { font-size: 20px; margin-bottom: 24px; color: #fff; }
  .grid { display: grid; gap: 16px; }
  section { min-width: 0; overflow-x: auto; border: 1px solid #333; border-radius: 8px; padding: 20px; background: #181818; transition: border-color 0.2s; }
  section.approved { border-color: #22c55e40; background: #22c55e18; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
  .approve-btn { background: none; border: 1px solid #444; border-radius: 6px; width: 28px; height: 28px; cursor: pointer; font-size: 14px; flex-shrink: 0; transition: all 0.2s; }
  .approve-btn:hover { border-color: #22c55e; }
  section.approved .approve-btn { background: #22c55e20; border-color: #22c55e; }
  .collapse-icon { font-size: 10px; color: #666; transition: transform 0.2s; user-select: none; }
  section.collapsed .collapse-icon { transform: rotate(-90deg); }
  section.collapsed .body { display: none; }
  section.collapsed .desc { display: none; }
  h2 { font-size: 16px; color: #fff; margin-bottom: 4px; }
  h3 { font-size: 13px; color: #888; margin: 16px 0 8px; text-transform: uppercase; letter-spacing: 0.5px; }
  .desc { font-size: 13px; color: #888; margin-bottom: 12px; }
  .pair { display: flex; gap: 24px; align-items: flex-start; }
  .ascii { flex: 0 0 auto; }
  .ascii pre {
    background: #0d0d0d; border: 1px solid #333; border-radius: 6px; padding: 12px 16px;
    font-family: ui-monospace, 'SF Mono', monospace; font-size: 12px; line-height: 1.4;
    color: #aaa; white-space: pre; overflow-x: auto;
  }
  .svg { flex: 0 0 auto; overflow-x: auto; }
  .svg svg { border-radius: 6px; }
</style>
</head>
<body>
<div style="display:flex;align-items:center;gap:16px;margin-bottom:24px">
  <h1 style="margin:0">Commit Graph — Visual Test Report</h1>
  <select id="col-select" onchange="setColumns(this.value)" style="background:#222;color:#ddd;border:1px solid #444;border-radius:6px;padding:4px 8px;font-size:13px">
    <option value="1">1 column</option>
    <option value="2">2 columns</option>
    <option value="3" selected>3 columns</option>
    <option value="4">4 columns</option>
  </select>
</div>
<div class="grid">
${sections}
</div>
<script>
  const COL_KEY = 'graph-visual-columns'
  function setColumns(n) {
    localStorage.setItem(COL_KEY, n)
    document.querySelector('.grid').style.gridTemplateColumns = 'repeat(' + n + ', 1fr)'
    document.getElementById('col-select').value = n
  }
  setColumns(localStorage.getItem(COL_KEY) || '3')

  const COLLAPSE_KEY = 'graph-visual-collapsed'
  function getCollapsed() { try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}') } catch { return {} } }
  function saveCollapsed(data) { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(data)) }

  function toggleCollapse(slug) {
    const data = getCollapsed()
    if (data[slug]) delete data[slug]; else data[slug] = true
    saveCollapsed(data)
    renderCollapsed()
  }

  function renderCollapsed() {
    const data = getCollapsed()
    document.querySelectorAll('section[data-test]').forEach(s => {
      s.classList.toggle('collapsed', !!data[s.dataset.test])
    })
  }

  const KEY = 'graph-visual-approved'
  function getApproved() { try { return JSON.parse(localStorage.getItem(KEY) || '{}') } catch { return {} } }
  function saveApproved(data) { localStorage.setItem(KEY, JSON.stringify(data)) }

  function toggleApprove(slug) {
    const data = getApproved()
    if (data[slug]) delete data[slug]; else data[slug] = Date.now()
    saveApproved(data)
    render()
  }

  function render() {
    const data = getApproved()
    document.querySelectorAll('section[data-test]').forEach(s => {
      const slug = s.dataset.test
      const approved = !!data[slug]
      s.classList.toggle('approved', approved)
      s.querySelector('.approve-btn').textContent = approved ? '\\u2713' : ''
    })
  }

  render()
  renderCollapsed()
</script>
</body>
</html>`
}

const html = generateHtml(results)
const outPath = resolve(dirname(fileURLToPath(import.meta.url)), '../..', 'graph-visual-report.html')
writeFileSync(outPath, html, 'utf-8')
console.log(`\n✓ Report written to ${outPath}`)
console.log(`  Open with: open "${outPath}"`)
