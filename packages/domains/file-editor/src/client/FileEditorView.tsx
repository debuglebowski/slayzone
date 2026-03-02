import { useState, useCallback, useRef, useEffect, useImperativeHandle, forwardRef } from 'react'
import { FileCode, Files, Search } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button
} from '@slayzone/ui'
import type { EditorOpenFilesState } from '@slayzone/file-editor/shared'
import { useFileEditor } from './useFileEditor'
import { EditorFileTree } from './EditorFileTree'
import { EditorTabBar } from './EditorTabBar'
import { CodeEditor } from './CodeEditor'
import { SearchPanel } from './SearchPanel'

export interface FileEditorViewHandle {
  openFile: (filePath: string) => void
  closeActiveFile: () => boolean
  toggleSearch: () => void
}

interface FileEditorViewProps {
  projectPath: string
  initialEditorState?: EditorOpenFilesState | null
  onEditorStateChange?: (state: EditorOpenFilesState) => void
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024).toFixed(0)} KB`
}

export const FileEditorView = forwardRef<FileEditorViewHandle, FileEditorViewProps>(function FileEditorView({ projectPath, initialEditorState, onEditorStateChange }, ref) {
  const {
    openFiles,
    activeFile,
    activeFilePath,
    setActiveFilePath,
    openFile,
    openFileForced,
    updateContent,
    saveFile,
    closeFile,
    isDirty,
    isFileDiskChanged,
    renameOpenFile,
    isRestoring,
    treeRefreshKey,
    fileVersions
  } = useFileEditor(projectPath, initialEditorState)

  const [treeWidth, setTreeWidth] = useState(initialEditorState?.treeWidth ?? 250)
  const [treeVisible, setTreeVisible] = useState(initialEditorState?.treeVisible ?? true)
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    () => new Set(initialEditorState?.expandedFolders ?? [])
  )
  const isDragging = useRef(false)
  const [confirmClose, setConfirmClose] = useState<string | null>(null)
  const [sidebarMode, setSidebarMode] = useState<'tree' | 'search'>('tree')
  const [isFileDragOver, setIsFileDragOver] = useState(false)
  const dragCounter = useRef(0)

  // --- Emit state changes to parent for persistence ---
  // Parent (TaskDetailPage) debounces at 500ms, so frequent calls here are fine.
  // Use filePathsKey (stable string) instead of openFiles to avoid emitting on every keystroke.
  const onChangeRef = useRef(onEditorStateChange)
  onChangeRef.current = onEditorStateChange
  const filePathsKey = openFiles.map((f) => f.path).join('\0')

  useEffect(() => {
    if (isRestoring) return
    onChangeRef.current?.({
      files: filePathsKey ? filePathsKey.split('\0') : [],
      activeFile: activeFilePath,
      treeWidth,
      treeVisible,
      expandedFolders: [...expandedFolders]
    })
  }, [filePathsKey, activeFilePath, treeWidth, treeVisible, expandedFolders, isRestoring])

  const isImage = activeFile?.binary ?? false

  useImperativeHandle(ref, () => ({
    openFile,
    closeActiveFile: () => { if (activeFilePath) { closeFile(activeFilePath); return true }; return false },
    toggleSearch: () => {
      setSidebarMode(prev => {
        const next = prev === 'search' ? 'tree' : 'search'
        if (next === 'search' && !treeVisible) setTreeVisible(true)
        return next
      })
    }
  }), [openFile, activeFilePath, closeFile, treeVisible])

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

  const handleCloseFile = useCallback(
    (filePath: string) => {
      if (isDirty(filePath)) {
        setConfirmClose(filePath)
        return
      }
      closeFile(filePath)
    },
    [isDirty, closeFile]
  )

  const handleConfirmDiscard = useCallback(() => {
    if (confirmClose) {
      closeFile(confirmClose)
      setConfirmClose(null)
    }
  }, [confirmClose, closeFile])

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

  const handleFileDrop = useCallback(async (e: React.DragEvent) => {
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
  }, [projectPath, openFile])

  return (
    <div
      className="h-full flex bg-background relative"
      onDragOver={handleFileDragOver}
      onDragEnter={handleFileDragEnter}
      onDragLeave={handleFileDragLeave}
      onDrop={handleFileDrop}
    >
      {/* Sidebar: header tabs + file tree or search */}
      {treeVisible && (
        <div className="shrink-0 border-r overflow-hidden flex flex-col" style={{ width: treeWidth }}>
          {/* Sidebar tab header */}
          <div className="flex items-center gap-1 px-2 h-10 border-b border-border shrink-0 bg-surface-1">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide mr-auto">
              {sidebarMode === 'search' ? 'Search' : 'Files'}
            </span>
            {([
              { mode: 'tree' as const, icon: Files, title: 'Explorer' },
              { mode: 'search' as const, icon: Search, title: 'Search' }
            ]).map(({ mode, icon: Icon, title }) => (
              <button
                key={mode}
                className={`size-7 flex items-center justify-center rounded transition-colors ${sidebarMode === mode ? 'text-foreground bg-muted' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'}`}
                onClick={() => setSidebarMode(mode)}
                title={title}
              >
                <Icon className="size-4" />
              </button>
            ))}
          </div>
          {/* Sidebar content */}
          <div className="flex-1 min-w-0 min-h-0">
            {sidebarMode === 'search' ? (
              <SearchPanel
                projectPath={projectPath}
                onOpenFile={openFile}
              />
            ) : (
              <EditorFileTree
                projectPath={projectPath}
                onOpenFile={openFile}
                onFileRenamed={renameOpenFile}
                activeFilePath={activeFilePath}
                refreshKey={treeRefreshKey}
                expandedFolders={expandedFolders}
                onExpandedFoldersChange={setExpandedFolders}
              />
            )}
          </div>
        </div>
      )}

      {/* Editor area */}
      <div className="relative flex-1 flex flex-col min-w-0">
        {/* Resize handle (overlay) */}
        {treeVisible && (
          <div
            className="absolute left-0 inset-y-0 w-2 -translate-x-1/2 z-10 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 transition-colors"
            onMouseDown={handleResizeStart}
          />
        )}
        <div className="flex items-center shrink-0 h-10 border-b border-border bg-surface-1">
          <EditorTabBar
            files={openFiles}
            activeFilePath={activeFilePath}
            onSelect={setActiveFilePath}
            onClose={handleCloseFile}
            isDirty={isDirty}
            diskChanged={isFileDiskChanged}
            treeVisible={treeVisible}
            onToggleTree={() => setTreeVisible((v) => !v)}
          />
        </div>

        {activeFile && isImage ? (
          <div className="flex-1 min-h-0 flex items-center justify-center overflow-auto p-4 bg-[repeating-conic-gradient(hsl(var(--muted))_0%_25%,transparent_0%_50%)_50%/16px_16px]">
            <img
              src={`slz-file://${projectPath}/${activeFile.path}${fileVersions.get(activeFile.path) ? `?v=${fileVersions.get(activeFile.path)}` : ''}`}
              className="max-w-full max-h-full object-contain"
              draggable={false}
            />
          </div>
        ) : activeFile?.tooLarge ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center space-y-3">
              <FileCode className="size-8 mx-auto opacity-40" />
              <p className="text-sm">File too large ({formatSize(activeFile.sizeBytes ?? 0)})</p>
              {(activeFile.sizeBytes ?? 0) <= 10 * 1024 * 1024 && (
                <Button variant="outline" size="sm" onClick={() => openFileForced(activeFile.path)}>
                  Open anyway
                </Button>
              )}
            </div>
          </div>
        ) : activeFile?.content != null ? (
          <div className="flex-1 min-h-0 flex">
            <div className="flex-1 min-w-0">
              <CodeEditor
                key={activeFile.path}
                filePath={activeFile.path}
                content={activeFile.content}
                onChange={(content) => updateContent(activeFile.path, content)}
                onSave={() => saveFile(activeFile.path)}
                version={fileVersions.get(activeFile.path)}
              />
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center space-y-2">
              <FileCode className="size-8 mx-auto opacity-40" />
              <p className="text-sm">Select a file to edit</p>
            </div>
          </div>
        )}
      </div>

      {/* Drop overlay */}
      {isFileDragOver && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 border-2 border-dashed border-primary rounded-md pointer-events-none">
          <p className="text-sm text-primary font-medium">Drop files to open</p>
        </div>
      )}

      {/* Unsaved changes confirmation */}
      <AlertDialog open={!!confirmClose} onOpenChange={(open) => { if (!open) setConfirmClose(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved changes</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmClose?.split('/').pop()} has unsaved changes that will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDiscard}>Discard</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
})
