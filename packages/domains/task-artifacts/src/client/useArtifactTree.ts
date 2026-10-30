import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ArtifactFolder, TaskArtifact } from '@slayzone/task-contracts'
import { groupArtifactTree } from '../shared/tree'

interface UseArtifactTreeArgs {
  taskId: string
  folders: ArtifactFolder[]
  artifacts: TaskArtifact[]
  folderPathMap: Map<string, string>
}

function readPersistedExpanded(key: string): Set<string> | null {
  try {
    const raw = window.localStorage?.getItem(key)
    if (raw) return new Set(JSON.parse(raw) as string[])
  } catch {
    /* ignore */
  }
  return null
}

function persistExpanded(key: string, expanded: Set<string>): void {
  try {
    window.localStorage?.setItem(key, JSON.stringify([...expanded]))
  } catch {
    /* ignore */
  }
}

/**
 * Folder/artifact hierarchy + expand state for the artifacts tree.
 * Owns the persisted expand set and derives the grouped tree maps,
 * depth-first artifact ordering, and the "move to" folder list.
 */
export function useArtifactTree({
  taskId,
  folders,
  artifacts,
  folderPathMap
}: UseArtifactTreeArgs) {
  // Expanded folders state — persisted in localStorage per task.
  // null sentinel = nothing persisted yet; auto-expand all once folders load.
  const expandedStorageKey = `slayzone:artifacts-panel:expanded:${taskId}`
  const [expandedFolders, setExpandedFolders] = useState<Set<string> | null>(() =>
    readPersistedExpanded(expandedStorageKey)
  )

  // Auto-expand all folders on first load when nothing was persisted. Adjusted while
  // rendering, so no commit has the folders without their expand set; settles at once
  // (the set is non-null from then on). The persist effect below stores it.
  if (expandedFolders === null && folders.length > 0) {
    setExpandedFolders(new Set(folders.map((f) => f.id)))
  }

  // Persist on change
  useEffect(() => {
    if (expandedFolders === null) return
    persistExpanded(expandedStorageKey, expandedFolders)
  }, [expandedFolders, expandedStorageKey])

  const toggleFolder = useCallback((folderId: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev ?? [])
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }, [])

  // --- Build tree structure from folders + artifacts ---

  const { childFolders, artifactsByFolder } = useMemo(
    () => groupArtifactTree(folders, artifacts),
    [folders, artifacts]
  )

  // --- "Move to" folder list for context menu ---

  const moveToFolders = useMemo(() => {
    return folders.map((f) => ({
      id: f.id,
      name: f.name,
      path: folderPathMap.get(f.id) ?? f.name
    }))
  }, [folders, folderPathMap])

  // Depth-first ordered artifact ids (respecting expand state) for shift-range selection
  const flatArtifactIds = useMemo(() => {
    const out: string[] = []
    function walk(parentId: string | null) {
      const subFolders = childFolders.get(parentId) ?? []
      for (const f of subFolders) {
        const expanded = expandedFolders?.has(f.id) ?? true
        if (expanded) walk(f.id)
      }
      const subArtifacts = artifactsByFolder.get(parentId) ?? []
      for (const a of subArtifacts) out.push(a.id)
    }
    walk(null)
    return out
  }, [childFolders, artifactsByFolder, expandedFolders])

  return {
    expandedFolders,
    toggleFolder,
    childFolders,
    artifactsByFolder,
    moveToFolders,
    flatArtifactIds
  }
}
