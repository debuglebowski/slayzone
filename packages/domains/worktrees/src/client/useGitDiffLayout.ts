import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Horizontal split sizing between the file list and the diff pane. Initializes
 * the file list to half the container width on first paint with changes, and
 * exposes the drag-resize handler.
 */
export function useGitDiffLayout(hasAnyChanges: boolean) {
  const [fileListWidth, setFileListWidth] = useState(320)
  const splitContainerRef = useRef<HTMLDivElement>(null)
  const didInitSplitRef = useRef(false)

  const handleResize = useCallback((delta: number) => {
    setFileListWidth((w) => Math.max(50, w + delta))
  }, [])

  useEffect(() => {
    if (!hasAnyChanges || didInitSplitRef.current) return
    const containerWidth = splitContainerRef.current?.clientWidth ?? 0
    if (containerWidth <= 0) return
    didInitSplitRef.current = true
    setFileListWidth(Math.max(50, containerWidth / 2))
  }, [hasAnyChanges])

  return { fileListWidth, handleResize, splitContainerRef }
}
