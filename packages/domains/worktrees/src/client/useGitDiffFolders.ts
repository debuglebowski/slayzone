import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flattenFileTree, type TreeNode } from '@slayzone/ui'
import type { FileEntry } from './GitDiffPanel.types'

/**
 * Sidebar file-tree folder expansion state. Owns expandedFolders, the inverted
 * collapsedFolders set, the flattened visible-entry list used for keyboard nav,
 * and auto-expansion of newly-appearing folders.
 */
export function useGitDiffFolders(
  stagedTree: TreeNode<FileEntry>[],
  unstagedTree: TreeNode<FileEntry>[]
) {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())

  // Invert expanded → collapsed for flattenFileTree
  const collapsedFolders = useMemo(() => {
    const allPaths = new Set<string>()
    function walk(nodes: TreeNode<FileEntry>[]) {
      for (const n of nodes) {
        if (n.type === 'folder') {
          allPaths.add(n.path)
          walk(n.children)
        }
      }
    }
    walk(stagedTree)
    walk(unstagedTree)
    const collapsed = new Set<string>()
    for (const p of allPaths) {
      if (!expandedFolders.has(p)) collapsed.add(p)
    }
    return collapsed
  }, [stagedTree, unstagedTree, expandedFolders])

  const visibleFlatEntries = useMemo(
    () => [
      ...flattenFileTree(stagedTree, collapsedFolders),
      ...flattenFileTree(unstagedTree, collapsedFolders)
    ],
    [stagedTree, unstagedTree, collapsedFolders]
  )

  const toggleFolder = useCallback((path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  // Auto-expand all folders when new folders appear
  const prevFolderPathsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const allPaths = new Set<string>()
    function walk(nodes: TreeNode<FileEntry>[]) {
      for (const n of nodes) {
        if (n.type === 'folder') {
          allPaths.add(n.path)
          walk(n.children)
        }
      }
    }
    walk(stagedTree)
    walk(unstagedTree)
    const prev = prevFolderPathsRef.current
    const newPaths = [...allPaths].filter((p) => !prev.has(p))
    prevFolderPathsRef.current = allPaths
    if (newPaths.length > 0) {
      setExpandedFolders((old) => {
        const next = new Set(old)
        for (const p of newPaths) next.add(p)
        return next
      })
    }
  }, [stagedTree, unstagedTree])

  return { expandedFolders, toggleFolder, visibleFlatEntries }
}
