import dagre from '@dagrejs/dagre'

export interface LayoutOptions {
  direction?: 'TB' | 'LR'
  nodeWidth?: number
  nodeHeight?: number
  rankSep?: number
  nodeSep?: number
}

const DEFAULTS: Required<LayoutOptions> = {
  direction: 'TB',
  nodeWidth: 220,
  nodeHeight: 100,
  rankSep: 80,
  nodeSep: 40,
}

export function computeGraphLayout(
  nodes: Array<{ id: string; width?: number }>,
  edges: Array<{ source: string; target: string }>,
  options?: LayoutOptions
): Map<string, { x: number; y: number }> {
  const opts = { ...DEFAULTS, ...options }
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: opts.direction, ranksep: opts.rankSep, nodesep: opts.nodeSep })
  g.setDefaultEdgeLabel(() => ({}))

  for (const node of nodes) {
    const w = node.width ?? opts.nodeWidth
    g.setNode(node.id, { width: w, height: opts.nodeHeight })
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target)
  }

  dagre.layout(g)

  const positions = new Map<string, { x: number; y: number }>()
  for (const node of nodes) {
    const n = g.node(node.id)
    if (n) positions.set(node.id, { x: n.x - n.width / 2, y: n.y - opts.nodeHeight / 2 })
  }
  return positions
}
