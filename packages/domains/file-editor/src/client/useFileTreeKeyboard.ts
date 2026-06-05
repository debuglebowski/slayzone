import { useCallback } from 'react'
import type { VisibleEntry } from './useFileTreeData'
import type { ClipboardState } from './useFileTreeClipboard'

interface UseFileTreeKeyboardArgs {
  focusedPath: string | null
  setFocusedPath: (path: string | null) => void
  selectedPaths: Set<string>
  setSelectedPaths: (paths: Set<string>) => void
  visibleEntries: VisibleEntry[]
  expandedFolders: Set<string>
  setExpandedFolders: (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => void
  clipboard: ClipboardState | null
  setClipboard: (clipboard: ClipboardState | null) => void
  handleToggleFolder: (folderPath: string, chainPaths?: string[]) => void
  onOpenFile: (path: string) => void
  handleCopy: (paths: string[]) => void
  handleCut: (paths: string[]) => void
  handlePaste: (targetDir: string) => void
  executeDelete: (paths: string[]) => Promise<void>
  setConfirmDelete: (paths: string[] | null) => void
  treeContainerRef: React.RefObject<HTMLDivElement | null>
}

export function useFileTreeKeyboard({
  focusedPath,
  setFocusedPath,
  selectedPaths,
  setSelectedPaths,
  visibleEntries,
  expandedFolders,
  setExpandedFolders,
  clipboard,
  setClipboard,
  handleToggleFolder,
  onOpenFile,
  handleCopy,
  handleCut,
  handlePaste,
  executeDelete,
  setConfirmDelete,
  treeContainerRef
}: UseFileTreeKeyboardArgs) {
  // --- Keyboard navigation ---
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Don't intercept when inside an input (create/rename)
      if ((e.target as HTMLElement).tagName === 'INPUT') return

      const meta = e.metaKey || e.ctrlKey

      if (meta && e.key === 'ArrowLeft') {
        e.preventDefault()
        setExpandedFolders(new Set())
        return
      }

      if (meta && e.key === 'c') {
        e.preventDefault()
        const paths = selectedPaths.size > 0 ? [...selectedPaths] : focusedPath ? [focusedPath] : []
        if (paths.length) handleCopy(paths)
        return
      }

      if (meta && e.key === 'x') {
        e.preventDefault()
        const paths = selectedPaths.size > 0 ? [...selectedPaths] : focusedPath ? [focusedPath] : []
        if (paths.length) handleCut(paths)
        return
      }

      if (meta && e.key === 'v') {
        e.preventDefault()
        let targetDir = ''
        if (focusedPath) {
          const focused = visibleEntries.find((v) => v.entry.path === focusedPath)
          if (focused) {
            targetDir =
              focused.entry.type === 'directory'
                ? focused.entry.path
                : focused.entry.path.includes('/')
                  ? focused.entry.path.slice(0, focused.entry.path.lastIndexOf('/'))
                  : ''
          }
        }
        handlePaste(targetDir)
        return
      }

      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault()
        const paths = selectedPaths.size > 0 ? [...selectedPaths] : focusedPath ? [focusedPath] : []
        if (!paths.length) return
        if (paths.length > 1) {
          setConfirmDelete(paths)
        } else {
          executeDelete(paths).then(() => setFocusedPath(null))
        }
        return
      }

      if (e.key === 'Escape') {
        e.preventDefault()
        setFocusedPath(null)
        setSelectedPaths(new Set())
        if (clipboard?.mode === 'cut') setClipboard(null)
        treeContainerRef.current?.blur()
        return
      }

      const currentIdx = focusedPath
        ? visibleEntries.findIndex((v) => v.entry.path === focusedPath)
        : -1

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        const nextIdx = currentIdx + 1
        if (nextIdx < visibleEntries.length) {
          setFocusedPath(visibleEntries[nextIdx].entry.path)
          if (!e.shiftKey) setSelectedPaths(new Set([visibleEntries[nextIdx].entry.path]))
        }
        return
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault()
        const prevIdx = currentIdx <= 0 ? 0 : currentIdx - 1
        if (visibleEntries.length > 0) {
          setFocusedPath(visibleEntries[prevIdx].entry.path)
          if (!e.shiftKey) setSelectedPaths(new Set([visibleEntries[prevIdx].entry.path]))
        }
        return
      }

      if (e.key === 'ArrowRight') {
        e.preventDefault()
        if (currentIdx < 0) return
        const { entry, chainPaths } = visibleEntries[currentIdx]
        if (entry.type === 'directory') {
          if (!expandedFolders.has(entry.path)) {
            handleToggleFolder(entry.path, chainPaths.length ? chainPaths : undefined)
          } else {
            // Move focus to first child
            if (currentIdx + 1 < visibleEntries.length) {
              const nextEntry = visibleEntries[currentIdx + 1]
              // Verify it's actually a child
              if (nextEntry.entry.path.startsWith(entry.path + '/')) {
                setFocusedPath(nextEntry.entry.path)
                setSelectedPaths(new Set([nextEntry.entry.path]))
              }
            }
          }
        }
        return
      }

      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        if (currentIdx < 0) return
        const { entry, chainPaths } = visibleEntries[currentIdx]
        if (entry.type === 'directory' && expandedFolders.has(entry.path)) {
          handleToggleFolder(entry.path, chainPaths.length ? chainPaths : undefined)
        } else {
          // Move focus to parent
          const parentPath = entry.path.includes('/')
            ? entry.path.slice(0, entry.path.lastIndexOf('/'))
            : ''
          if (parentPath) {
            setFocusedPath(parentPath)
            setSelectedPaths(new Set([parentPath]))
          }
        }
        return
      }

      if (e.key === 'Enter') {
        e.preventDefault()
        if (currentIdx < 0) return
        const entry = visibleEntries[currentIdx].entry
        if (entry.type === 'file') onOpenFile(entry.path)
        else handleToggleFolder(entry.path)
        return
      }
    },
    [
      focusedPath,
      selectedPaths,
      visibleEntries,
      expandedFolders,
      clipboard,
      handleToggleFolder,
      onOpenFile,
      handleCopy,
      handleCut,
      handlePaste,
      executeDelete,
      setExpandedFolders,
      setConfirmDelete,
      setFocusedPath,
      setClipboard,
      setSelectedPaths
    ]
  )

  return { handleKeyDown }
}
