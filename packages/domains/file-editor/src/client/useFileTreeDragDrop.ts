import { useState, useCallback, useRef } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import type { DirEntry } from '../shared'

interface UseFileTreeDragDropArgs {
  projectPath: string
  loadDir: (dirPath: string) => Promise<DirEntry[]>
  setExpandedFolders: (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => void
  onFileRenamed?: (oldPath: string, newPath: string) => void
  selectedPaths: Set<string>
}

export function useFileTreeDragDrop({
  projectPath,
  loadDir,
  setExpandedFolders,
  onFileRenamed,
  selectedPaths
}: UseFileTreeDragDropArgs) {
  const trpc = useTRPC()
  const renameMutation = useMutation(trpc.fileEditor.rename.mutationOptions())
  // --- Drag and drop state ---
  const dragPathRef = useRef<string | null>(null)
  const dragTypeRef = useRef<'file' | 'directory' | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const dropCounterRef = useRef<Map<string, number>>(new Map())

  const handleDragStart = useCallback(
    (e: React.DragEvent, entry: DirEntry) => {
      dragPathRef.current = entry.path
      dragTypeRef.current = entry.type
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move'
        // If entry is in selection, encode all selected paths
        const paths =
          selectedPaths.has(entry.path) && selectedPaths.size > 1 ? [...selectedPaths] : [entry.path]
        e.dataTransfer.setData('application/x-slayzone-tree', JSON.stringify(paths))
      }
    },
    [selectedPaths]
  )

  const handleDragEnd = useCallback(() => {
    dragPathRef.current = null
    dragTypeRef.current = null
    setDropTarget(null)
    dropCounterRef.current.clear()
  }, [])

  const isValidDropTarget = useCallback((targetDir: string): boolean => {
    const src = dragPathRef.current
    if (!src) return false
    if (src === targetDir) return false
    const srcParent = src.includes('/') ? src.slice(0, src.lastIndexOf('/')) : ''
    if (srcParent === targetDir) return false
    if (dragTypeRef.current === 'directory' && targetDir.startsWith(src + '/')) return false
    return true
  }, [])

  const handleFolderDragOver = useCallback(
    (e: React.DragEvent, folderPath: string) => {
      if (!dragPathRef.current) return
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = isValidDropTarget(folderPath) ? 'move' : 'none'
      }
    },
    [isValidDropTarget]
  )

  const handleFolderDragEnter = useCallback(
    (e: React.DragEvent, folderPath: string) => {
      if (!dragPathRef.current) return
      e.preventDefault()
      e.stopPropagation()
      const count = (dropCounterRef.current.get(folderPath) ?? 0) + 1
      dropCounterRef.current.set(folderPath, count)
      if (isValidDropTarget(folderPath)) {
        setDropTarget(folderPath)
      }
    },
    [isValidDropTarget]
  )

  const handleFolderDragLeave = useCallback((e: React.DragEvent, folderPath: string) => {
    if (!dragPathRef.current) return
    e.preventDefault()
    e.stopPropagation()
    const count = (dropCounterRef.current.get(folderPath) ?? 0) - 1
    dropCounterRef.current.set(folderPath, count)
    if (count <= 0) {
      dropCounterRef.current.delete(folderPath)
      setDropTarget((cur) => (cur === folderPath ? null : cur))
    }
  }, [])

  const handleFolderDrop = useCallback(
    async (e: React.DragEvent, targetDir: string) => {
      e.preventDefault()
      e.stopPropagation()
      setDropTarget(null)
      dropCounterRef.current.clear()

      const srcPath = dragPathRef.current
      if (!srcPath || !isValidDropTarget(targetDir)) {
        dragPathRef.current = null
        dragTypeRef.current = null
        return
      }
      dragPathRef.current = null
      dragTypeRef.current = null

      const name = srcPath.includes('/') ? srcPath.slice(srcPath.lastIndexOf('/') + 1) : srcPath
      const newPath = targetDir ? `${targetDir}/${name}` : name
      const srcParent = srcPath.includes('/') ? srcPath.slice(0, srcPath.lastIndexOf('/')) : ''

      try {
        await renameMutation.mutateAsync({ rootPath: projectPath, oldPath: srcPath, newPath })
        onFileRenamed?.(srcPath, newPath)

        const srcPrefix = srcPath + '/'
        setExpandedFolders((prev) => {
          let changed = false
          const next = new Set<string>()
          for (const p of prev) {
            if (p === srcPath) {
              next.add(newPath)
              changed = true
            } else if (p.startsWith(srcPrefix)) {
              next.add(newPath + p.slice(srcPath.length))
              changed = true
            } else {
              next.add(p)
            }
          }
          if (!next.has(targetDir) && targetDir) {
            next.add(targetDir)
            changed = true
          }
          return changed ? next : prev
        })

        await Promise.all([loadDir(srcParent), loadDir(targetDir)])
      } catch (err) {
        console.error('Move failed:', err)
      }
    },
    [projectPath, loadDir, isValidDropTarget, onFileRenamed, setExpandedFolders, renameMutation]
  )

  return {
    dropTarget,
    setDropTarget,
    dragPathRef,
    dropCounterRef,
    isValidDropTarget,
    handleDragStart,
    handleDragEnd,
    handleFolderDragOver,
    handleFolderDragEnter,
    handleFolderDragLeave,
    handleFolderDrop
  }
}
