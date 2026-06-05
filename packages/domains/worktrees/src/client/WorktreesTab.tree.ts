import type React from 'react'
import type { Task } from '@slayzone/task/shared'
import type { DetectedWorktree } from '../shared/types'
import type { WorktreeNode } from './WorktreesTab.types'

// Build hierarchical tree structure from detected worktrees + tasks
export function buildWorktreeTree(
  worktrees: DetectedWorktree[],
  tasks: Task[]
): WorktreeNode[] {
  const nodes: Map<string, WorktreeNode> = new Map()
  const activeTasks = tasks.filter((t) => !t.archived_at)

  // Create initial nodes and map tasks
  worktrees.forEach((wt) => {
    nodes.set(wt.branch || wt.path, {
      ...wt,
      children: [],
      depth: 0,
      task: activeTasks.find((t) => t.worktree_path === wt.path)
    })
  })

  const rootNodes: WorktreeNode[] = []

  // Link nodes based on parent branch
  worktrees.forEach((wt) => {
    const node = nodes.get(wt.branch || wt.path)!
    const parentBranch = node.task?.worktree_parent_branch

    let parentNode: WorktreeNode | undefined
    if (parentBranch) {
      // Try to find a worktree that has this branch checked out
      parentNode = Array.from(nodes.values()).find((n) => n.branch === parentBranch)
    }

    if (parentNode && parentNode !== node) {
      parentNode.children.push(node)
    } else if (!wt.isMain) {
      // Find main repo to be the parent if no other parent found
      const main = Array.from(nodes.values()).find((n) => n.isMain)
      if (main && main !== node) {
        main.children.push(node)
      } else {
        rootNodes.push(node)
      }
    } else {
      rootNodes.push(node)
    }
  })

  // Calculate depths
  const setDepth = (node: WorktreeNode, depth: number) => {
    node.depth = depth
    node.children.forEach((c) => setDepth(c, depth + 1))
  }
  rootNodes.forEach((r) => setDepth(r, 0))

  return rootNodes
}

export function renderTree(
  nodes: WorktreeNode[],
  expandedPaths: Set<string>,
  renderNode: (node: WorktreeNode) => React.ReactNode
): React.ReactNode[] {
  return nodes.flatMap((node) => [
    renderNode(node),
    ...renderTree(node.children, expandedPaths, renderNode)
  ])
}
