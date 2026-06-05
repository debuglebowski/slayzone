import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ArtifactFolder, TaskArtifact } from '@slayzone/task/shared'

interface UseArtifactTreeArgs {
  taskId: string
  folders: ArtifactFolder[]
  artifacts: TaskArtifact[]
  folderPathMap: Map<string, string>
}

/**
 * Folder/artifact hierarchy + expand state for the artifacts tree.
 * Owns the persisted expand set and derives the grouped tree maps,
 * depth-first artifact ordering, and the "move to" folder list.
 */
export function useArtifactTree({ taskId, folders, artifacts, folderPathMap }: UseArtifactTreeArgs) {
  // Expanded folders state — persisted in localStorage per task.
  // null sentinel = nothing persisted yet; auto-expand all once folders load.
  const expandedStorageKey = `slayzone:artifacts-panel:expanded:${taskId}`
  const [expandedFolders, setExpandedFolders] = useState<Set<string> | null>(() => {
    try {
      const raw = window.localStorage?.getItem(expandedStorageKey)
      if (raw) return new Set(JSON.parse(raw) as string[])
    } catch {
      /* ignore */
    }
    return null
  })

  // Auto-expand all folders on first load when nothing was persisted
  useEffect(() => {
    if (expandedFolders === null && folders.length > 0) {
      setExpandedFolders(new Set(folders.map((f) => f.id)))
    }
  }, [folders, expandedFolders])

  // Persist on change
  useEffect(() => {
    if (expandedFolders === null) return
    try {
      window.localStorage?.setItem(expandedStorageKey, JSON.stringify([...expandedFolders]))
    } catch {
      /* ignore */
    }
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

  const { childFolders, artifactsByFolder } = useMemo(() => {
    const cf = new Map<string | null, ArtifactFolder[]>()
    for (const f of folders) {
      const arr = cf.get(f.parent_id) ?? []
      arr.push(f)
      cf.set(f.parent_id, arr)
    }
    const ab = new Map<string | null, TaskArtifact[]>()
    for (const a of artifacts) {
      const arr = ab.get(a.folder_id) ?? []
      arr.push(a)
      ab.set(a.folder_id, arr)
    }
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
    for (const arr of cf.values()) arr.sort((a, b) => collator.compare(a.name, b.name))
    for (const arr of ab.values()) arr.sort((a, b) => collator.compare(a.title, b.title))
    return { childFolders: cf, artifactsByFolder: ab }
  }, [folders, artifacts])

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
