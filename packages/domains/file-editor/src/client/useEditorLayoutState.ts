import { useCallback, useRef, useState } from 'react'
import type { EditorOpenFilesState } from '@slayzone/file-editor/shared'

export interface UseEditorLayoutStateResult {
  treeWidth: number
  setTreeWidth: React.Dispatch<React.SetStateAction<number>>
  treeVisible: boolean
  setTreeVisible: React.Dispatch<React.SetStateAction<boolean>>
  expandedFolders: Set<string>
  setExpandedFolders: React.Dispatch<React.SetStateAction<Set<string>>>
  sidebarMode: 'tree' | 'search'
  setSidebarMode: React.Dispatch<React.SetStateAction<'tree' | 'search'>>
  tocWidth: number
  setTocWidth: React.Dispatch<React.SetStateAction<number>>
  treeReady: boolean
  setTreeReady: React.Dispatch<React.SetStateAction<boolean>>
  handleResizeStart: (e: React.MouseEvent) => void
}

export function useEditorLayoutState(
  initialEditorState?: EditorOpenFilesState | null
): UseEditorLayoutStateResult {
  const [treeWidth, setTreeWidth] = useState(initialEditorState?.treeWidth ?? 250)
  const [treeVisible, setTreeVisible] = useState(initialEditorState?.treeVisible ?? true)
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    () => new Set(initialEditorState?.expandedFolders ?? [])
  )
  const [sidebarMode, setSidebarMode] = useState<'tree' | 'search'>('tree')
  const [tocWidth, setTocWidth] = useState(initialEditorState?.tocWidth ?? 220)
  const [treeReady, setTreeReady] = useState(false)
  const isDragging = useRef(false)

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      isDragging.current = true
      const startX = e.clientX
      const startWidth = treeWidth

      const onMove = (e: MouseEvent) => {
        if (!isDragging.current) return
        const delta = e.clientX - startX
        setTreeWidth(Math.max(180, Math.min(500, startWidth + delta)))
      }
      const onUp = () => {
        isDragging.current = false
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [treeWidth]
  )

  return {
    treeWidth,
    setTreeWidth,
    treeVisible,
    setTreeVisible,
    expandedFolders,
    setExpandedFolders,
    sidebarMode,
    setSidebarMode,
    tocWidth,
    setTocWidth,
    treeReady,
    setTreeReady,
    handleResizeStart
  }
}
