import { useCallback, useRef, useState } from 'react'

export interface FileDropZoneHandlers {
  onDragOver: (e: React.DragEvent) => void
  onDragEnter: (e: React.DragEvent) => void
  onDragLeave: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
}

export interface UseFileDropZoneResult {
  isFileDragOver: boolean
  dropHandlers: FileDropZoneHandlers
}

export function useFileDropZone(
  projectPath: string,
  openFile: (filePath: string) => void
): UseFileDropZoneResult {
  const [isFileDragOver, setIsFileDragOver] = useState(false)
  const dragCounter = useRef(0)

  const handleFileDragOver = useCallback((e: React.DragEvent) => {
    // Skip internal tree drags — let the tree handle them
    if (e.dataTransfer.types.includes('application/x-slayzone-tree')) return
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleFileDragEnter = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('application/x-slayzone-tree')) return
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current++
    if (e.dataTransfer.types.includes('Files')) {
      setIsFileDragOver(true)
    }
  }, [])

  const handleFileDragLeave = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('application/x-slayzone-tree')) return
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current--
    if (dragCounter.current === 0) {
      setIsFileDragOver(false)
    }
  }, [])

  const handleFileDrop = useCallback(
    async (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes('application/x-slayzone-tree')) return
      e.preventDefault()
      e.stopPropagation()
      dragCounter.current = 0
      setIsFileDragOver(false)

      // Paths extracted by preload's capture-phase drop listener
      // (contextBridge proxies File objects, so webUtils must run in preload)
      const paths = window.api.files.getDropPaths()
      if (!paths.length) return

      const normalizedRoot = projectPath.replace(/\/+$/, '') + '/'
      for (const absPath of paths) {
        if (absPath.startsWith(normalizedRoot)) {
          openFile(absPath.slice(normalizedRoot.length))
        } else {
          // External file — copy into project root
          try {
            const relPath = await window.api.fs.copyIn(projectPath, absPath)
            openFile(relPath)
          } catch {
            // Copy failed (e.g. directory, permission error)
          }
        }
      }
    },
    [projectPath, openFile]
  )

  return {
    isFileDragOver,
    dropHandlers: {
      onDragOver: handleFileDragOver,
      onDragEnter: handleFileDragEnter,
      onDragLeave: handleFileDragLeave,
      onDrop: handleFileDrop
    }
  }
}
