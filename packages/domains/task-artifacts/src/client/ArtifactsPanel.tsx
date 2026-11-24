import {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
  useImperativeHandle,
  forwardRef,
  type DragEvent,
  type RefObject
} from 'react'
import {
  Upload,
  FolderPlus,
  FilePlus,
  Loader2,
  Search,
  Files,
  PanelLeftClose,
  PanelLeft
} from 'lucide-react'
import {
  cn,
  Button,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
  PulseGrid,
  matchesShortcut,
  useShortcutStore,
  useShortcutDisplay,
  withShortcut,
  withModalGuard,
  useStableCallback
} from '@slayzone/ui'
import { useMutation } from '@tanstack/react-query'
import { electronBootstrap, useHubId, useHubRegistryStore } from '@slayzone/transport/client'
import { useTRPC } from './trpc'
import type { TaskArtifact, ArtifactFolder } from '@slayzone/task-contracts'
import { getEffectiveRenderMode, isBinaryRenderMode } from '@slayzone/task-contracts'
import { useAppearance, safeClipboardWriteText, toast } from '@slayzone/ui'
import { useArtifacts } from './useArtifacts'
import { ArtifactFindBar } from './ArtifactFindBar'
import { ArtifactSearchPanel } from './ArtifactSearchPanel'
import { ArtifactContentEditor } from './ArtifactContentEditor'
import { artifactDevicePreviews } from './ArtifactDevicePicker'
import { ArtifactToolbar } from './ArtifactToolbar'
import { useDevicePreviewPreferences } from './device-preview-preferences'
import { VersionsPanel } from './VersionsPanel'
import { TreeSidebar } from './TreeSidebar'
import { useArtifactTree } from './useArtifactTree'
import { useArtifactClipboard } from './useArtifactClipboard'
import { useArtifactVersions } from './useArtifactVersions'
import type { ArtifactsPanelHandle, ArtifactsPanelProps } from './ArtifactsPanel.types'
import { DEFAULT_SIDEBAR_WIDTH, DEFAULT_ZOOM_PCT } from './ArtifactsPanel.constants'

export type { ArtifactsPanelHandle } from './ArtifactsPanel.types'

// Document-level mousemove/mouseup drag for the sidebar resize handle. Plain module
// function: the self-removing listener pair can't live in a compiled component body.
function startSidebarResize(
  startX: number,
  startW: number,
  sidebarDrag: RefObject<{ startX: number; startW: number } | null>,
  setSidebarWidth: (width: number) => void,
  setSidebarDragging: (dragging: boolean) => void,
  onResizeEnd: (width: number) => void
): void {
  sidebarDrag.current = { startX, startW }
  setSidebarDragging(true)
  let width = startW
  const handleMove = (ev: MouseEvent) => {
    if (!sidebarDrag.current) return
    const delta = ev.clientX - sidebarDrag.current.startX
    width = Math.max(100, Math.min(400, sidebarDrag.current.startW + delta))
    setSidebarWidth(width)
  }
  const handleUp = () => {
    sidebarDrag.current = null
    setSidebarDragging(false)
    if (width !== startW) onResizeEnd(width)
    document.removeEventListener('mousemove', handleMove)
    document.removeEventListener('mouseup', handleUp)
  }
  document.addEventListener('mousemove', handleMove)
  document.addEventListener('mouseup', handleUp)
}

// --- Main panel ---

export const ArtifactsPanel = forwardRef<ArtifactsPanelHandle, ArtifactsPanelProps>(
  function ArtifactsPanel(
    {
      taskId,
      isResizing,
      initialActiveArtifactId,
      onActiveArtifactIdChange,
      initialSidebarState,
      onSidebarStateChange,
      onOpenUrl,
      onShareArtifact,
      readOnly = false
    },
    ref
  ) {
    const trpc = useTRPC()
    const { mutateAsync: showOpenDialog } = useMutation(
      trpc.app.dialog.showOpenDialog.mutationOptions()
    )
    const hubId = useHubId()
    // Only the co-located hub can read paths picked on this device.
    const canUploadLocalPaths = useHubRegistryStore(({ hubs, defaultHubId }) =>
      hubs.some((hub) => hub.id === (hubId ?? defaultHubId) && hub.kind === 'local')
    )
    const uploadInputRef = useRef<HTMLInputElement>(null)
    const {
      artifacts,
      folders,
      isLoading,
      selectedId,
      setSelectedId,
      createArtifact,
      updateArtifact,
      deleteArtifact,
      renameArtifact,
      moveArtifactToFolder,
      readContent,
      readText,
      saveContent,
      uploadArtifact,
      uploadDir,
      getFilePath,
      downloadFile,
      downloadFolder,
      downloadAsPdf,
      downloadAsPng,
      downloadAsHtml,
      downloadAllAsZip,
      listVersions,
      readVersion,
      createVersion,
      renameVersion,
      diffVersions,
      setCurrentVersion,
      createFolder,
      deleteFolder,
      renameFolder,
      getArtifactPath,
      folderPathMap
    } = useArtifacts(taskId, initialActiveArtifactId)

    const {
      expandedFolders,
      toggleFolder,
      childFolders,
      artifactsByFolder,
      moveToFolders,
      flatArtifactIds
    } = useArtifactTree({ taskId, folders, artifacts, folderPathMap })

    const {
      selectedIds,
      setSelectedIds,
      clipboard,
      osHasFiles,
      refreshOsClipboard,
      handleArtifactClick,
      getEffectiveArtifactIds,
      handleArtifactCopy,
      handleArtifactCut,
      handleArtifactPaste,
      handleArtifactDuplicate,
      handleDeleteSelected,
      handleSelectAll
    } = useArtifactClipboard({
      taskId,
      artifacts,
      selectedId,
      setSelectedId,
      deleteArtifact,
      getFilePath,
      flatArtifactIds
    })

    const {
      artifactVersions,
      versionsLoading,
      versionsDialogOpen,
      setVersionsDialogOpen,
      viewingVersion,
      setViewingVersion,
      refreshVersions,
      openVersion,
      changeDiffAgainst,
      handleCreateVersion
    } = useArtifactVersions({ listVersions, readVersion, diffVersions, createVersion })

    // Notify parent when selection changes (for persistence)
    const prevSelectedIdRef = useRef(selectedId)
    useEffect(() => {
      if (selectedId !== prevSelectedIdRef.current) {
        prevSelectedIdRef.current = selectedId
        onActiveArtifactIdChange?.(selectedId)
      }
    }, [selectedId, onActiveArtifactIdChange])

    const { editorMarkdownViewMode, notesReadability, notesWidth } = useAppearance()
    const artifactDefaultViewMode =
      editorMarkdownViewMode === 'code'
        ? 'raw'
        : editorMarkdownViewMode === 'split'
          ? 'split'
          : 'preview'
    const [viewMode, setViewMode] = useState<'preview' | 'split' | 'raw'>('preview')
    const [dragOver, setDragOver] = useState(false)
    const [dropTargetFolder, setDropTargetFolder] = useState<string | null>(null)
    const dragArtifactIdsRef = useRef<string[]>([])

    // Search state
    const [sidebarMode, setSidebarMode] = useState<'tree' | 'search'>('tree')
    // Sidebar visibility + width: seeded from the task's saved state, every user
    // change reported to the parent (which saves it per task).
    const [sidebarVisible, setSidebarVisible] = useState(initialSidebarState?.visible ?? true)
    const [sidebarWidth, setSidebarWidth] = useState(
      initialSidebarState?.width ?? DEFAULT_SIDEBAR_WIDTH
    )
    const commitSidebar = useStableCallback((next: { visible?: boolean; width?: number }) => {
      const state = {
        visible: next.visible ?? sidebarVisible,
        width: next.width ?? sidebarWidth
      }
      setSidebarVisible(state.visible)
      setSidebarWidth(state.width)
      onSidebarStateChange?.(state)
    })
    const toggleSidebar = useStableCallback(() => commitSidebar({ visible: !sidebarVisible }))
    const sidebarKeys = useShortcutStore((s) => s.getKeys('artifacts-toggle-sidebar'))
    const isRecordingShortcut = useShortcutStore((s) => s.isRecording)
    const sidebarShortcut = useShortcutDisplay('artifacts-toggle-sidebar')
    useEffect(() => {
      if (!sidebarKeys || isRecordingShortcut) return
      const handleKeyDown = withModalGuard((event: KeyboardEvent) => {
        if (event.defaultPrevented || !matchesShortcut(event, sidebarKeys)) return
        event.preventDefault()
        toggleSidebar()
      })
      window.addEventListener('keydown', handleKeyDown)
      return () => window.removeEventListener('keydown', handleKeyDown)
    }, [sidebarKeys, isRecordingShortcut, toggleSidebar])
    const [findOpen, setFindOpen] = useState(false)
    const [findQuery, setFindQuery] = useState('')
    const [findActiveIndex, setFindActiveIndex] = useState(0)
    const [findMatchCount, setFindMatchCount] = useState(0)
    const [findMatchCase, setFindMatchCase] = useState(false)
    const [findUseRegex, setFindUseRegex] = useState(false)
    const [findFocusToken, setFindFocusToken] = useState(0)

    // Inline creation/rename state
    const [creating, setCreating] = useState<{
      parentFolderId: string | null
      type: 'file' | 'folder'
    } | null>(null)
    const [renaming, setRenaming] = useState<{ id: string; type: 'artifact' | 'folder' } | null>(
      null
    )
    const [renameValue, setRenameValue] = useState('')

    // Set by a context-menu item that opens an inline input (New…, Rename): the menu,
    // closing, must not hand focus back to the row it opened on. That hand-back lands
    // after the input took focus and blurs it — and blur commits a rename and closes it.
    const inputTakesFocusRef = useRef(false)
    const createInputRef = useCallback((node: HTMLInputElement | null) => {
      if (node) requestAnimationFrame(() => node.focus())
    }, [])
    const preventAutoFocus = useCallback((e: Event) => {
      if (inputTakesFocusRef.current) {
        e.preventDefault()
        inputTakesFocusRef.current = false
      }
    }, [])
    const renameInputRef = useRef<HTMLInputElement>(null)

    // Focus create/rename inputs when they appear — on the next frame, as the create
    // input does: started from a context menu, the menu is still open (and traps focus)
    // in this commit, so a focus now is taken straight back.
    useEffect(() => {
      if (!renaming) return
      const frame = requestAnimationFrame(() => renameInputRef.current?.focus())
      return () => cancelAnimationFrame(frame)
    }, [renaming])

    const selectedArtifact = artifacts.find((a) => a.id === selectedId) ?? null
    const selectedRenderMode = selectedArtifact
      ? getEffectiveRenderMode(selectedArtifact.title, selectedArtifact.render_mode)
      : null
    const effectiveReadability: 'compact' | 'normal' =
      selectedArtifact?.readability_override ?? notesReadability
    const effectiveWidth: 'narrow' | 'wide' = selectedArtifact?.width_override ?? notesWidth
    const zoomPct = selectedArtifact?.zoom_pct ?? DEFAULT_ZOOM_PCT
    const htmlTheme = selectedArtifact?.html_theme_override ?? 'system'
    const {
      selection: deviceSelection,
      setSelection: setDeviceSelection,
      showDeviceFrame,
      setShowDeviceFrame
    } = useDevicePreviewPreferences(selectedArtifact?.id)
    const devicePreviews = useMemo(() => artifactDevicePreviews(deviceSelection), [deviceSelection])

    const applyViewMode = (mode: typeof viewMode) => {
      setViewMode(mode)
      if (selectedArtifact && !readOnly) {
        void updateArtifact({ id: selectedArtifact.id, viewMode: mode })
      }
    }

    // The view state (view mode, find bar) belongs to one artifact: when another one
    // is on screen, it resets to that artifact's saved mode (else the default), find bar
    // closed. Adjusted while rendering, on a change of the artifact shown only: an
    // effect also re-ran on every tab re-show (<Activity>), closing the find bar and
    // putting the saved mode back over one picked since. Keyed on the artifact found
    // in the list, not the selected id, so its saved mode applies once the list loads.
    // The stored mode / default are read as of the switch — a later artifacts refetch
    // (e.g. after persisting a mode change) must not reset the view again.
    const viewArtifactId = selectedArtifact?.id ?? null
    // undefined = not set up yet: the first render sets it up.
    const [viewStateFor, setViewStateFor] = useState<string | null | undefined>(undefined)
    if (viewStateFor !== viewArtifactId) {
      setViewStateFor(viewArtifactId)
      const savedMode = selectedArtifact?.view_mode
      setViewMode(
        savedMode === 'preview' || savedMode === 'split' || savedMode === 'raw'
          ? savedMode
          : artifactDefaultViewMode
      )
      setFindOpen(false)
      setFindQuery('')
      setFindActiveIndex(0)
      setFindMatchCount(0)
      setFindMatchCase(false)
      setFindUseRegex(false)
    }

    // Reset active index when the search parameters change so the first match is the target
    useEffect(() => {
      setFindActiveIndex(0)
    }, [findQuery, findMatchCase, findUseRegex])

    // Reset match count when query clears — a blank query should show no matches
    useEffect(() => {
      if (!findQuery.trim()) setFindMatchCount(0)
    }, [findQuery])

    useImperativeHandle(
      ref,
      () => ({
        selectArtifact: (id: string) => setSelectedId(id),
        createArtifact: () => {
          if (!readOnly) setCreating({ parentFolderId: null, type: 'file' })
        },
        toggleSearch: () => setSidebarMode((m) => (m === 'search' ? 'tree' : 'search'))
      }),
      [setSelectedId, readOnly]
    )

    // --- Inline create/rename handlers ---

    const handleInlineCreate = useCallback(
      (value: string) => {
        if (!creating) return
        const name = value.trim()
        if (!name) {
          setCreating(null)
          return
        }
        if (creating.type === 'file') {
          createArtifact({ title: name, folderId: creating.parentFolderId })
        } else {
          createFolder({ name, parentId: creating.parentFolderId })
        }
        setCreating(null)
      },
      [creating, createArtifact, createFolder]
    )

    const handleInlineRename = useCallback(
      (value: string) => {
        if (!renaming) return
        const name = value.trim()
        if (!name) {
          setRenaming(null)
          return
        }
        if (renaming.type === 'artifact') {
          renameArtifact(renaming.id, name)
        } else {
          renameFolder(renaming.id, name)
        }
        setRenaming(null)
      },
      [renaming, renameArtifact, renameFolder]
    )

    const startRenameArtifact = useCallback((artifact: TaskArtifact) => {
      inputTakesFocusRef.current = true
      setRenaming({ id: artifact.id, type: 'artifact' })
      setRenameValue(artifact.title)
    }, [])

    const startRenameFolder = useCallback((folder: ArtifactFolder) => {
      inputTakesFocusRef.current = true
      setRenaming({ id: folder.id, type: 'folder' })
      setRenameValue(folder.name)
    }, [])

    // --- Upload / drop ---

    const [activeUploads, setActiveUploads] = useState<{ name: string }[]>([])
    const [activeUpload] = activeUploads
    const uploadSources = useCallback(
      async (sources: readonly (string | File)[], allowDirectories = false) => {
        for (const source of sources) {
          const name =
            typeof source === 'string'
              ? (source.split(/[/\\]/).filter(Boolean).pop() ?? source)
              : source.name
          const upload = { name }
          setActiveUploads((active) => [...active, upload])
          try {
            if (allowDirectories && typeof source === 'string') {
              try {
                await uploadDir(source)
                continue
              } catch {
                // A dropped path may be a regular file.
              }
            }
            await uploadArtifact(source)
          } catch (err) {
            toast.error('Upload failed', {
              description: `${name}: ${err instanceof Error ? err.message : String(err)}`
            })
          } finally {
            setActiveUploads((active) => active.filter((entry) => entry !== upload))
          }
        }
      },
      [uploadArtifact, uploadDir]
    )

    const handleUpload = useCallback(async () => {
      if (!canUploadLocalPaths) {
        uploadInputRef.current?.click()
        return
      }
      try {
        const result = await showOpenDialog({
          title: 'Upload Artifact',
          properties: ['openFile', 'multiSelections']
        })
        if (!result.canceled) await uploadSources(result.filePaths)
      } catch (err) {
        toast.error('Could not open the file picker', {
          description: err instanceof Error ? err.message : String(err)
        })
      }
    }, [showOpenDialog, uploadSources, canUploadLocalPaths])

    const handleFileDrop = useCallback(
      (e: DragEvent) => {
        e.preventDefault()
        setDragOver(false)
        if (dragArtifactIdsRef.current.length || !e.dataTransfer.files.length) return
        const files = Array.from(e.dataTransfer.files)
        const paths = canUploadLocalPaths ? electronBootstrap.getDropPaths().filter(Boolean) : []
        if (paths.length === files.length) void uploadSources(paths, true)
        else void uploadSources(files)
      },
      [uploadSources, canUploadLocalPaths]
    )

    // --- Drag-to-folder handlers ---

    const handleArtifactDragStart = useCallback(
      (artifactId: string) => (e: React.DragEvent) => {
        const ids =
          selectedIds.has(artifactId) && selectedIds.size > 1 ? [...selectedIds] : [artifactId]
        dragArtifactIdsRef.current = ids
        e.dataTransfer.setData('application/x-slayzone-artifact-ids', JSON.stringify(ids))
        e.dataTransfer.setData('text/plain', ids.join(','))
        e.dataTransfer.effectAllowed = 'move'
      },
      [selectedIds]
    )

    const handleFolderDragOver = useCallback(
      (folderId: string) => (e: React.DragEvent) => {
        if (!dragArtifactIdsRef.current.length) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        setDropTargetFolder(folderId)
      },
      []
    )

    const handleFolderDragLeave = useCallback(() => {
      setDropTargetFolder(null)
    }, [])

    const handleFolderDrop = useCallback(
      (folderId: string) => (e: React.DragEvent) => {
        e.preventDefault()
        e.stopPropagation()
        setDropTargetFolder(null)
        const ids = dragArtifactIdsRef.current
        dragArtifactIdsRef.current = []
        if (!ids.length) return
        for (const id of ids) moveArtifactToFolder(id, folderId)
      },
      [moveArtifactToFolder]
    )

    const handleRootDragOver = useCallback((e: React.DragEvent) => {
      if (!dragArtifactIdsRef.current.length) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDropTargetFolder('__root__')
    }, [])

    const handleRootDrop = useCallback(
      (e: React.DragEvent) => {
        e.preventDefault()
        setDropTargetFolder(null)
        const ids = dragArtifactIdsRef.current
        dragArtifactIdsRef.current = []
        if (!ids.length) return
        for (const id of ids) moveArtifactToFolder(id, null)
      },
      [moveArtifactToFolder]
    )

    const handleDragEnd = useCallback(() => {
      dragArtifactIdsRef.current = []
      setDropTargetFolder(null)
    }, [])

    // --- Search handlers ---

    const handleSearchResult = useCallback(
      (
        artifactId: string,
        payload: { query: string; matchCase: boolean; useRegex: boolean; matchIndex: number }
      ) => {
        setSelectedId(artifactId)
        // The view state set below is this artifact's: no reset when it comes on screen.
        setViewStateFor(artifactId)
        setFindQuery(payload.query)
        setFindMatchCase(payload.matchCase)
        setFindUseRegex(payload.useRegex)
        // Force raw view. Rendered-preview views (Milkdown markdown, html/svg/
        // mermaid) index matches over rendered text and would diverge from the
        // sidebar's raw-text matchIndex — the source-text CodeMirror view is the
        // only one guaranteed to agree with the sidebar's indexing.
        setViewMode('raw')
        // Defer opening find bar + setting active index so the new artifact content
        // loads and the view's match list is rebuilt before we try to scroll.
        setTimeout(() => {
          setFindOpen(true)
          setFindActiveIndex(payload.matchIndex)
        }, 50)
      },
      [setSelectedId]
    )

    // --- Copy path ---

    const handleCopyPath = useCallback(
      async (artifactId: string) => {
        const fp = await getFilePath(artifactId)
        if (fp) void safeClipboardWriteText(fp)
      },
      [getFilePath]
    )

    const handlePanelKeyDown = (e: React.KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey
      const target = e.target as HTMLElement
      const inEditableField =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
      const inSidebar = target.closest('[data-testid="artifacts-sidebar"]') !== null

      if (meta && e.key === 'f') {
        e.preventDefault()
        e.stopPropagation()
        const rm = selectedArtifact
          ? getEffectiveRenderMode(selectedArtifact.title, selectedArtifact.render_mode)
          : null
        if (selectedArtifact && rm && !isBinaryRenderMode(rm)) {
          setFindOpen(true)
          setFindFocusToken((t) => t + 1)
        }
        return
      }

      if (!inSidebar || inEditableField) return

      if (meta && e.key === 'c') {
        const ids = selectedIds.size > 0 ? [...selectedIds] : selectedId ? [selectedId] : []
        if (ids.length) {
          e.preventDefault()
          handleArtifactCopy(ids)
        }
        return
      }
      // A View member's panel (T-100): copying out is all; nothing below changes files.
      if (readOnly) return
      if (meta && e.key === 'x') {
        const ids = selectedIds.size > 0 ? [...selectedIds] : selectedId ? [selectedId] : []
        if (ids.length) {
          e.preventDefault()
          handleArtifactCut(ids)
        }
        return
      }
      if (meta && e.key === 'v') {
        e.preventDefault()
        const focusedArtifact = selectedId ? artifacts.find((a) => a.id === selectedId) : null
        void handleArtifactPaste(focusedArtifact?.folder_id ?? null)
        return
      }
      if (meta && e.key === 'd') {
        const ids = selectedIds.size > 0 ? [...selectedIds] : selectedId ? [selectedId] : []
        if (ids.length) {
          e.preventDefault()
          void handleArtifactDuplicate(ids)
        }
        return
      }
      if (meta && e.key === 'a') {
        e.preventDefault()
        handleSelectAll()
        return
      }
      if ((e.key === 'Backspace' || e.key === 'Delete') && (selectedIds.size > 0 || selectedId)) {
        const ids = selectedIds.size > 0 ? [...selectedIds] : selectedId ? [selectedId] : []
        if (ids.length) {
          e.preventDefault()
          void handleDeleteSelected(ids)
        }
        return
      }
    }

    // Sidebar resize
    const [sidebarDragging, setSidebarDragging] = useState(false)
    const sidebarDrag = useRef<{ startX: number; startW: number } | null>(null)

    const handleSidebarMouseDown = useCallback(
      (e: React.MouseEvent) => {
        e.preventDefault()
        startSidebarResize(
          e.clientX,
          sidebarWidth,
          sidebarDrag,
          setSidebarWidth,
          setSidebarDragging,
          (width) => commitSidebar({ width })
        )
      },
      [sidebarWidth, setSidebarWidth, commitSidebar]
    )

    return (
      <div
        className={cn(
          'relative flex flex-col h-full',
          dragOver && 'ring-2 ring-primary/50 ring-inset'
        )}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={
          readOnly
            ? (e) => {
                e.preventDefault()
                setDragOver(false)
              }
            : handleFileDrop
        }
        onDragEnd={handleDragEnd}
        onKeyDown={handlePanelKeyDown}
      >
        {isLoading && (
          <div className="absolute inset-0 z-20 bg-background">
            <PulseGrid />
          </div>
        )}
        {/* Panel header */}
        <TooltipProvider delayDuration={400}>
          <div
            className={cn(
              'flex items-center border-b border-border shrink-0',
              sidebarVisible && 'grid grid-cols-[auto_minmax(0,1fr)]'
            )}
          >
            {/* Top-left: label + mode toggles */}
            {sidebarVisible && (
              <div
                className="flex items-center gap-1 px-2 h-10 border-r border-border bg-surface-1"
                style={{ width: sidebarWidth }}
              >
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide mr-auto">
                  Artifacts
                </span>
                <div className="ml-auto flex items-center gap-0.5">
                  {[
                    { mode: 'tree' as const, icon: Files, label: 'Explorer' },
                    { mode: 'search' as const, icon: Search, label: 'Search' }
                  ].map(({ mode, icon: Icon, label }) => (
                    <Tooltip key={mode}>
                      <TooltipTrigger asChild>
                        <button
                          className={`size-7 flex items-center justify-center rounded transition-colors ${sidebarMode === mode ? 'text-foreground bg-muted' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'}`}
                          onClick={() => setSidebarMode(mode)}
                        >
                          <Icon className="size-4" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">{label}</TooltipContent>
                    </Tooltip>
                  ))}
                </div>
              </div>
            )}
            {/* Top-right: action buttons + artifact controls */}
            <div className="flex min-w-0 flex-1 items-center gap-1.5 px-3 py-1.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className="flex items-center justify-center size-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
                    onClick={toggleSidebar}
                    aria-label={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
                  >
                    {sidebarVisible ? (
                      <PanelLeftClose className="size-4" />
                    ) : (
                      <PanelLeft className="size-4" />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {withShortcut(sidebarVisible ? 'Hide sidebar' : 'Show sidebar', sidebarShortcut)}
                </TooltipContent>
              </Tooltip>
              {!sidebarVisible && selectedArtifact ? (
                <span
                  data-testid="artifacts-header-title"
                  className="flex-1 min-w-0 truncate text-sm font-medium text-foreground"
                  title={selectedArtifact.title}
                >
                  {selectedArtifact.title}
                </span>
              ) : (
                <div className="flex-1" />
              )}
              {selectedArtifact && selectedRenderMode && (
                <ArtifactToolbar
                  key={selectedArtifact.id + ':' + selectedRenderMode}
                  artifact={selectedArtifact}
                  mode={selectedRenderMode}
                  viewMode={viewMode}
                  onViewModeChange={applyViewMode}
                  device={{
                    selection: deviceSelection,
                    onChange: setDeviceSelection,
                    showDeviceFrame,
                    onShowDeviceFrameChange: setShowDeviceFrame
                  }}
                  update={(patch) => void updateArtifact({ id: selectedArtifact.id, ...patch })}
                  downloads={{
                    file: () => void downloadFile(selectedArtifact.id),
                    pdf: () => void downloadAsPdf(selectedArtifact.id),
                    png: () => void downloadAsPng(selectedArtifact.id),
                    html: () => void downloadAsHtml(selectedArtifact.id),
                    zip: () => void downloadAllAsZip()
                  }}
                  onVersions={() => {
                    setVersionsDialogOpen(true)
                    void refreshVersions(selectedArtifact.id)
                  }}
                />
              )}
            </div>
          </div>
        </TooltipProvider>

        {activeUpload && (
          <div
            role="status"
            className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground"
          >
            <Loader2 aria-hidden="true" className="size-3.5 shrink-0 motion-safe:animate-spin" />
            <span className="truncate">Uploading {activeUpload.name}…</span>
            {activeUploads.length > 1 && (
              <span className="shrink-0">(+{activeUploads.length - 1} more)</span>
            )}
          </div>
        )}

        <div className="flex flex-1 min-h-0">
          {/* Left sidebar */}
          {sidebarVisible && (
            <div
              className="shrink-0 flex flex-col border-r border-border"
              style={{ width: sidebarWidth }}
            >
              {sidebarMode === 'search' ? (
                <ArtifactSearchPanel
                  artifacts={artifacts}
                  readContent={readContent}
                  getArtifactPath={getArtifactPath}
                  onSelectResult={handleSearchResult}
                />
              ) : (
                <TreeSidebar
                  readOnly={readOnly}
                  onShareArtifact={onShareArtifact}
                  artifacts={artifacts}
                  folders={folders}
                  selectedId={selectedId}
                  childFolders={childFolders}
                  artifactsByFolder={artifactsByFolder}
                  expandedFolders={expandedFolders}
                  toggleFolder={toggleFolder}
                  moveToFolders={moveToFolders}
                  selectedIds={selectedIds}
                  setSelectedIds={setSelectedIds}
                  clipboard={clipboard}
                  osHasFiles={osHasFiles}
                  refreshOsClipboard={refreshOsClipboard}
                  handleArtifactClick={handleArtifactClick}
                  getEffectiveArtifactIds={getEffectiveArtifactIds}
                  handleArtifactCopy={handleArtifactCopy}
                  handleArtifactCut={handleArtifactCut}
                  handleArtifactPaste={handleArtifactPaste}
                  handleArtifactDuplicate={handleArtifactDuplicate}
                  handleDeleteSelected={handleDeleteSelected}
                  handleCopyPath={handleCopyPath}
                  creating={creating}
                  setCreating={setCreating}
                  renaming={renaming}
                  renameValue={renameValue}
                  setRenameValue={setRenameValue}
                  setRenaming={setRenaming}
                  handleInlineCreate={handleInlineCreate}
                  handleInlineRename={handleInlineRename}
                  startRenameArtifact={startRenameArtifact}
                  startRenameFolder={startRenameFolder}
                  createInputRef={createInputRef}
                  renameInputRef={renameInputRef}
                  preventAutoFocus={preventAutoFocus}
                  inputTakesFocusRef={inputTakesFocusRef}
                  dropTargetFolder={dropTargetFolder}
                  handleFolderDragOver={handleFolderDragOver}
                  handleFolderDragLeave={handleFolderDragLeave}
                  handleFolderDrop={handleFolderDrop}
                  handleRootDragOver={handleRootDragOver}
                  handleRootDrop={handleRootDrop}
                  handleArtifactDragStart={handleArtifactDragStart}
                  moveArtifactToFolder={moveArtifactToFolder}
                  downloadFile={downloadFile}
                  downloadFolder={downloadFolder}
                  deleteFolder={deleteFolder}
                  downloadAllAsZip={downloadAllAsZip}
                  downloadAsPdf={downloadAsPdf}
                  downloadAsPng={downloadAsPng}
                  downloadAsHtml={downloadAsHtml}
                />
              )}
              {!readOnly && (
                <div className="flex items-center gap-1.5 px-2 py-2 border-t border-border shrink-0 overflow-hidden">
                  <Button
                    data-testid="artifacts-new-btn"
                    variant="outline"
                    size="sm"
                    className={cn(
                      '!h-7 text-[10px] flex-1 min-w-0',
                      sidebarWidth < 180 ? 'px-0 justify-center' : 'px-2'
                    )}
                    onClick={() => setCreating({ parentFolderId: null, type: 'file' })}
                    title="New file"
                  >
                    <FilePlus className="size-3 shrink-0" />
                    {sidebarWidth >= 180 && <span className="ml-1 truncate">New</span>}
                  </Button>
                  <Button
                    data-testid="artifacts-folder-btn"
                    variant="outline"
                    size="sm"
                    className={cn(
                      '!h-7 text-[10px] flex-1 min-w-0',
                      sidebarWidth < 180 ? 'px-0 justify-center' : 'px-2'
                    )}
                    onClick={() => setCreating({ parentFolderId: null, type: 'folder' })}
                    title="New folder"
                  >
                    <FolderPlus className="size-3 shrink-0" />
                    {sidebarWidth >= 180 && <span className="ml-1 truncate">Folder</span>}
                  </Button>
                  <Button
                    data-testid="artifacts-upload-btn"
                    variant="outline"
                    size="sm"
                    className={cn(
                      '!h-7 text-[10px] flex-1 min-w-0',
                      sidebarWidth < 180 ? 'px-0 justify-center' : 'px-2'
                    )}
                    onClick={handleUpload}
                    title="Upload file"
                  >
                    <Upload className="size-3 shrink-0" />
                    {sidebarWidth >= 180 && <span className="ml-1 truncate">Upload</span>}
                  </Button>
                  {!canUploadLocalPaths && (
                    <input
                      ref={uploadInputRef}
                      type="file"
                      multiple
                      hidden
                      data-testid="artifacts-upload-input"
                      onChange={(e) => {
                        const files = Array.from(e.currentTarget.files ?? [])
                        e.currentTarget.value = ''
                        void uploadSources(files)
                      }}
                    />
                  )}
                </div>
              )}
            </div>
          )}

          {/* Right content area */}
          <div className="relative flex-1 flex flex-col min-w-0">
            {/* Resize handle (overlay) */}
            {sidebarVisible && (
              <div
                className="absolute left-0 inset-y-0 w-2 -translate-x-1/2 z-10 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 transition-colors"
                data-testid="artifacts-sidebar-resize"
                onMouseDown={handleSidebarMouseDown}
                onDoubleClick={() => commitSidebar({ width: DEFAULT_SIDEBAR_WIDTH })}
              />
            )}
            {(isResizing || sidebarDragging) && <div className="absolute inset-0 z-10" />}
            {findOpen &&
              selectedArtifact &&
              selectedRenderMode &&
              !isBinaryRenderMode(selectedRenderMode) && (
                <ArtifactFindBar
                  query={findQuery}
                  onQueryChange={setFindQuery}
                  onClose={() => {
                    setFindOpen(false)
                    setFindQuery('')
                    setFindActiveIndex(0)
                  }}
                  matchCount={findMatchCount}
                  activeIndex={findActiveIndex}
                  onActiveIndexChange={(fn) => setFindActiveIndex(fn)}
                  matchCase={findMatchCase}
                  onMatchCaseChange={setFindMatchCase}
                  useRegex={findUseRegex}
                  onUseRegexChange={setFindUseRegex}
                  focusToken={findFocusToken}
                />
              )}
            {selectedArtifact?.storage?.available === false ? (
              <div role="status" className="p-4 text-sm text-muted-foreground">
                This file is stored on a computer that is unavailable. Reconnect its computer to
                view or edit it.
              </div>
            ) : selectedArtifact ? (
              <>
                <ArtifactContentEditor
                  key={selectedArtifact.id}
                  artifact={selectedArtifact}
                  siblingArtifacts={artifacts}
                  viewMode={viewMode}
                  readText={readText}
                  saveContent={saveContent}
                  getFilePath={getFilePath}
                  effectiveReadability={effectiveReadability}
                  effectiveWidth={effectiveWidth}
                  zoomPct={zoomPct}
                  htmlTheme={htmlTheme}
                  devicePreviews={devicePreviews}
                  showDeviceFrame={showDeviceFrame}
                  searchQuery={findOpen ? findQuery : ''}
                  searchActiveIndex={findActiveIndex}
                  searchMatchCase={findMatchCase}
                  searchRegex={findUseRegex}
                  onSearchMatchCountChange={setFindMatchCount}
                  onOpenUrl={onOpenUrl}
                  onDownload={() => void downloadFile(selectedArtifact.id)}
                  readOnly={readOnly}
                />
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground/60">
                {artifacts.length > 0 ? 'Select an artifact' : 'Create an artifact to get started'}
              </div>
            )}
          </div>
        </div>
        <VersionsPanel
          selectedArtifact={selectedArtifact}
          versionsDialogOpen={versionsDialogOpen}
          onVersionsDialogOpenChange={setVersionsDialogOpen}
          artifactVersions={artifactVersions}
          versionsLoading={versionsLoading}
          viewingVersion={viewingVersion}
          setViewingVersion={setViewingVersion}
          refreshVersions={refreshVersions}
          openVersion={openVersion}
          changeDiffAgainst={changeDiffAgainst}
          handleCreateVersion={handleCreateVersion}
          setCurrentVersion={setCurrentVersion}
          renameVersion={renameVersion}
        />
      </div>
    )
  }
)
