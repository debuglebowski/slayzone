import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  ReactFlow,
  Background,
  useNodesState,
  useEdgesState,
  type Connection,
  type Node,
  type Edge,
  MarkerType,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react'
import { LayoutGrid, Plus } from 'lucide-react'
import { Button } from '@slayzone/ui'
import type { AiConfigItem, AiConfigScope, UpdateAiConfigItemInput } from '../shared'
import { parseSkillFrontmatter, renderSkillFrontmatter } from '../shared'
import { buildDependencyGraph, parseDependsOn, setDependsOn } from '../shared/skill-dependencies'
import { computeGraphLayout } from '../shared/graph-layout'
import { getSkillValidation } from './skill-validation'
import { SkillNodeCard, computeSkillNodeWidth, type SkillNodeData } from './SkillNodeCard'
import { DependencyEdge, type DependencyEdgeData } from './DependencyEdge'

const nodeTypes = { skill: SkillNodeCard }
const edgeTypes = { dependency: DependencyEdge }

interface SkillGraphCanvasProps {
  items: AiConfigItem[]
  scope: AiConfigScope
  selectedSkillId: string | null
  onSelectSkill: (id: string | null) => void
  onUpdateItem: (id: string, patch: Omit<UpdateAiConfigItemInput, 'id'>) => Promise<void>
  onCreateSkill?: () => void
}

const POSITION_KEY_PREFIX = 'slayzone:skill-graph-positions:'

function getStoredPositions(scope: AiConfigScope): Record<string, { x: number; y: number }> {
  try {
    const raw = localStorage.getItem(POSITION_KEY_PREFIX + scope)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

function storePositions(scope: AiConfigScope, positions: Record<string, { x: number; y: number }>) {
  localStorage.setItem(POSITION_KEY_PREFIX + scope, JSON.stringify(positions))
}

function SkillGraphCanvasInner({
  items,
  scope,
  selectedSkillId,
  onSelectSkill,
  onUpdateItem,
  onCreateSkill,
}: SkillGraphCanvasProps) {
  const skills = useMemo(() => items.filter(i => i.type === 'skill'), [items])
  const slugToId = useMemo(() => new Map(skills.map(s => [s.slug, s.id])), [skills])
  const idToItem = useMemo(() => new Map(skills.map(s => [s.id, s])), [skills])
  const { fitView } = useReactFlow()
  const initializedRef = useRef(false)

  const handleDeleteEdge = useCallback(async (edgeId: string) => {
    const [sourceId, targetId] = edgeId.split('->')
    if (!sourceId || !targetId) return
    const sourceItem = idToItem.get(sourceId)
    const targetItem = idToItem.get(targetId)
    if (!sourceItem || !targetItem) return

    const parsed = parseSkillFrontmatter(sourceItem.content)
    if (!parsed) return

    const currentDeps = parseDependsOn(parsed.frontmatter)
    const newDeps = currentDeps.filter(s => s !== targetItem.slug)
    const newFrontmatter = setDependsOn(parsed.frontmatter, newDeps)
    const newContent = renderSkillFrontmatter(newFrontmatter) + '\n' + parsed.body.replace(/^\n+/, '')

    await onUpdateItem(sourceItem.id, { content: newContent })
  }, [idToItem, onUpdateItem])

  const buildGraph = useCallback((autoLayout: boolean) => {
    const deps = buildDependencyGraph(skills)
    const stored = autoLayout ? {} : getStoredPositions(scope)

    const graphNodes = skills.map(item => ({ id: item.id, width: computeSkillNodeWidth(item.slug) }))
    const graphEdges = deps
      .map(d => ({
        source: slugToId.get(d.sourceSlug) ?? '',
        target: slugToId.get(d.targetSlug) ?? '',
      }))
      .filter(e => e.source && e.target)

    const dagrePositions = computeGraphLayout(graphNodes, graphEdges)

    const nodes: Node<SkillNodeData>[] = skills.map(item => {
      const validation = getSkillValidation(item)
      const parsed = parseSkillFrontmatter(item.content)
      const description = parsed?.frontmatter.description ?? ''
      const pos = stored[item.id] ?? dagrePositions.get(item.id) ?? { x: 0, y: 0 }
      return {
        id: item.id,
        type: 'skill',
        position: pos,
        data: {
          item,
          scope: item.scope,
          validationStatus: validation?.status ?? null,
          description,
          selected: item.id === selectedSkillId,
          width: computeSkillNodeWidth(item.slug),
        },
      }
    })

    const edges: Edge[] = deps
      .filter(d => slugToId.has(d.sourceSlug) && slugToId.has(d.targetSlug))
      .map(d => {
        const sourceId = slugToId.get(d.sourceSlug)!
        const targetId = slugToId.get(d.targetSlug)!
        return {
          id: `${sourceId}->${targetId}`,
          source: sourceId,
          target: targetId,
          type: 'dependency' as const,
          selectable: d.type === 'explicit',
          deletable: d.type === 'explicit',
          data: {
            depType: d.type,
          } satisfies DependencyEdgeData,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 28,
            height: 28,
            color: 'var(--color-muted-foreground)',
          },
        }
      })

    return { nodes, edges }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skills, slugToId, scope, selectedSkillId])

  const initial = useMemo(() => buildGraph(false), [buildGraph])
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges)

  // Rebuild graph when items/selection changes
  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true
      return
    }
    const { nodes: newNodes, edges: newEdges } = buildGraph(false)
    setNodes(newNodes)
    setEdges(newEdges)
  }, [buildGraph, setNodes, setEdges])

  const handleAutoLayout = useCallback(() => {
    const { nodes: newNodes, edges: newEdges } = buildGraph(true)
    setNodes(newNodes)
    setEdges(newEdges)
    // Clear stored positions
    storePositions(scope, {})
    setTimeout(() => fitView({ duration: 300 }), 50)
  }, [buildGraph, setNodes, setEdges, scope, fitView])

  const handleNodeDragStop = useCallback((_: unknown, node: Node) => {
    const stored = getStoredPositions(scope)
    stored[node.id] = node.position
    storePositions(scope, stored)
  }, [scope])

  const handleEdgesDelete = useCallback(async (deletedEdges: Edge[]) => {
    for (const edge of deletedEdges) {
      const data = edge.data as DependencyEdgeData | undefined
      if (data?.depType === 'explicit') {
        await handleDeleteEdge(edge.id)
      }
    }
  }, [handleDeleteEdge])

  const handleConnect = useCallback(async (connection: Connection) => {
    if (!connection.source || !connection.target) return
    const sourceItem = idToItem.get(connection.source)
    const targetItem = idToItem.get(connection.target)
    if (!sourceItem || !targetItem) return

    const parsed = parseSkillFrontmatter(sourceItem.content)
    if (!parsed) return

    const currentDeps = parseDependsOn(parsed.frontmatter)
    if (currentDeps.includes(targetItem.slug)) return

    const newFrontmatter = setDependsOn(parsed.frontmatter, [...currentDeps, targetItem.slug])
    const newContent = renderSkillFrontmatter(newFrontmatter) + '\n' + parsed.body.replace(/^\n+/, '')

    await onUpdateItem(sourceItem.id, { content: newContent })
  }, [idToItem, onUpdateItem])

  const handleNodeClick = useCallback((_: unknown, node: Node) => {
    onSelectSkill(node.id)
  }, [onSelectSkill])

  const handlePaneClick = useCallback(() => {
    onSelectSkill(null)
  }, [onSelectSkill])

  if (skills.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-muted-foreground">No skills yet</p>
        {onCreateSkill && (
          <Button size="sm" onClick={onCreateSkill}>
            <Plus className="mr-1 size-3.5" />
            Create skill
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="relative h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onEdgesDelete={handleEdgesDelete}
        onConnect={handleConnect}
        onNodeClick={handleNodeClick}
        onPaneClick={handlePaneClick}
        onNodeDragStop={handleNodeDragStop}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        className="bg-surface-0"
      >
        <Background gap={20} size={1} />
      </ReactFlow>
      <div className="absolute left-3 top-3 flex gap-2">
        <Button size="sm" variant="outline" onClick={handleAutoLayout}>
          <LayoutGrid className="mr-1.5 size-3.5" />
          Auto Layout
        </Button>
      </div>
    </div>
  )
}

export function SkillGraphCanvas(props: SkillGraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <SkillGraphCanvasInner {...props} />
    </ReactFlowProvider>
  )
}
