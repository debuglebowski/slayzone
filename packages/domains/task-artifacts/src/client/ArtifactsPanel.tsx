import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useImperativeHandle,
  forwardRef,
  type DragEvent
} from 'react'
import {
  Upload,
  Download,
  FileText,
  Eye,
  Code2,
  Columns2,
  FolderPlus,
  FilePlus,
  Search,
  Files,
  PanelLeftClose,
  PanelLeft,
  ImageDown,
  FileCode,
  Archive,
  History,
  SlidersHorizontal
} from 'lucide-react'
import {
  cn,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Button,
  Label,
  Switch,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
  PulseGrid
} from '@slayzone/ui'
import { MarkdownSettingsPopover } from '@slayzone/editor'
import type { RenderMode, TaskArtifact, ArtifactFolder } from '@slayzone/task/shared'
import {
  getEffectiveRenderMode,
  RENDER_MODE_INFO,
  isBinaryRenderMode,
  canExportAsPdf,
  canExportAsPng,
  canExportAsHtml
} from '@slayzone/task/shared'
import { useAppearance } from '@slayzone/ui'
import { useArtifacts } from './useArtifacts'
import { ArtifactFindBar } from './ArtifactFindBar'
import { ArtifactSearchPanel } from './ArtifactSearchPanel'
import { ArtifactContentEditor } from './ArtifactContentEditor'
import { VersionsPanel } from './VersionsPanel'
import { TreeSidebar } from './TreeSidebar'
import { useArtifactTree } from './useArtifactTree'
import { useArtifactClipboard } from './useArtifactClipboard'
import { useArtifactVersions } from './useArtifactVersions'
import type { ArtifactsPanelHandle, ArtifactsPanelProps } from './ArtifactsPanel.types'
import { DEFAULT_SIDEBAR_WIDTH } from './ArtifactsPanel.constants'

export type { ArtifactsPanelHandle } from './ArtifactsPanel.types'

// --- Main panel ---

export const ArtifactsPanel = forwardRef<ArtifactsPanelHandle, ArtifactsPanelProps>(
  function ArtifactsPanel(
    { taskId, isResizing, initialActiveArtifactId, onActiveArtifactIdChange },
    ref
  ) {
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

    const { expandedFolders, toggleFolder, childFolders, artifactsByFolder, moveToFolders, flatArtifactIds } =
      useArtifactTree({ taskId, folders, artifacts, folderPathMap })

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

    const {
      editorMarkdownViewMode,
      notesReadability,
      notesWidth,
      notesFontFamily,
      editorMinimapEnabled,
      editorTocEnabled
    } = useAppearance()
    const [displayOpen, setDisplayOpen] = useState(false)
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
    const [sidebarVisible, setSidebarVisible] = useState(true)
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

    const willCreateRef = useRef(false)
    const createInputRef = useCallback((node: HTMLInputElement | null) => {
      if (node) requestAnimationFrame(() => node.focus())
    }, [])
    const preventAutoFocus = useCallback((e: Event) => {
      if (willCreateRef.current) {
        e.preventDefault()
        willCreateRef.current = false
      }
    }, [])
    const renameInputRef = useRef<HTMLInputElement>(null)

    // Focus create/rename inputs when they appear
    useEffect(() => {
      if (renaming) renameInputRef.current?.focus()
    }, [renaming])

    const selectedArtifact = artifacts.find((a) => a.id === selectedId) ?? null
    const selectedRenderMode = selectedArtifact
      ? getEffectiveRenderMode(selectedArtifact.title, selectedArtifact.render_mode)
      : null
    const effectiveReadability: 'compact' | 'normal' =
      selectedArtifact?.readability_override ?? notesReadability
    const effectiveWidth: 'narrow' | 'wide' = selectedArtifact?.width_override ?? notesWidth

    useEffect(() => {
      const artifact = artifacts.find((a) => a.id === selectedId)
      setViewMode((artifact?.view_mode as 'preview' | 'split' | 'raw') ?? artifactDefaultViewMode)
      setFindOpen(false)
      setFindQuery('')
      setFindActiveIndex(0)
      setFindMatchCount(0)
      setFindMatchCase(false)
      setFindUseRegex(false)
    }, [selectedId])

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
        createArtifact: () => setCreating({ parentFolderId: null, type: 'file' }),
        toggleSearch: () => setSidebarMode((m) => (m === 'search' ? 'tree' : 'search'))
      }),
      [setSelectedId]
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
      setRenaming({ id: artifact.id, type: 'artifact' })
      setRenameValue(artifact.title)
    }, [])

    const startRenameFolder = useCallback((folder: ArtifactFolder) => {
      setRenaming({ id: folder.id, type: 'folder' })
      setRenameValue(folder.name)
    }, [])

    // --- Upload / drop ---

    const handleUpload = useCallback(async () => {
      const result = await window.api.dialog.showOpenDialog({
        title: 'Upload Artifact',
        properties: ['openFile', 'multiSelections']
      })
      if (result.canceled || !result.filePaths.length) return
      for (const filePath of result.filePaths) {
        await uploadArtifact(filePath)
      }
    }, [uploadArtifact])

    const handleFileDrop = useCallback(
      async (e: DragEvent) => {
        e.preventDefault()
        setDragOver(false)
        if (dragArtifactIdsRef.current.length) return
        const filePaths = window.api.files.getDropPaths()
        for (const fp of filePaths) {
          try {
            await uploadDir(fp)
          } catch {
            await uploadArtifact(fp)
          }
        }
      },
      [uploadArtifact, uploadDir]
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
        if (fp) navigator.clipboard.writeText(fp)
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
    const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH)
    const [sidebarDragging, setSidebarDragging] = useState(false)
    const sidebarDrag = useRef<{ startX: number; startW: number } | null>(null)

    const handleSidebarMouseDown = useCallback(
      (e: React.MouseEvent) => {
        e.preventDefault()
        sidebarDrag.current = { startX: e.clientX, startW: sidebarWidth }
        setSidebarDragging(true)
        const handleMove = (ev: MouseEvent) => {
          if (!sidebarDrag.current) return
          const delta = ev.clientX - sidebarDrag.current.startX
          setSidebarWidth(Math.max(100, Math.min(400, sidebarDrag.current.startW + delta)))
        }
        const handleUp = () => {
          sidebarDrag.current = null
          setSidebarDragging(false)
          document.removeEventListener('mousemove', handleMove)
          document.removeEventListener('mouseup', handleUp)
        }
        document.addEventListener('mousemove', handleMove)
        document.addEventListener('mouseup', handleUp)
      },
      [sidebarWidth]
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
        onDrop={handleFileDrop}
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
              sidebarVisible && 'grid grid-cols-[auto_1fr]'
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
            <div className="flex items-center gap-1.5 px-3 py-1.5 flex-1">
              <button
                className="flex items-center justify-center size-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
                onClick={() => setSidebarVisible((v) => !v)}
                title={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
              >
                {sidebarVisible ? (
                  <PanelLeftClose className="size-4" />
                ) : (
                  <PanelLeft className="size-4" />
                )}
              </button>
              <div className="flex-1" />
              {selectedArtifact && selectedRenderMode && (
                <div className="flex items-center gap-1.5">
                  {selectedArtifact && selectedRenderMode === 'markdown' && (
                    <MarkdownSettingsPopover
                      open={displayOpen}
                      onOpenChange={setDisplayOpen}
                      trigger={
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 gap-1.5 px-2 text-xs font-medium text-muted-foreground"
                        >
                          <SlidersHorizontal className="size-3.5" />
                          Display
                        </Button>
                      }
                    >
                      <div className="grid grid-cols-3 rounded-md border border-border/50 p-0.5 gap-0.5">
                        {[
                          { mode: 'preview' as const, icon: Eye, label: 'Preview' },
                          { mode: 'split' as const, icon: Columns2, label: 'Split' },
                          { mode: 'raw' as const, icon: Code2, label: 'Raw' }
                        ].map(({ mode, icon: Icon, label }) => {
                          const active = viewMode === mode
                          return (
                            <button
                              key={mode}
                              className={cn(
                                'flex flex-col items-center justify-center gap-1 py-3 text-[10px] font-medium rounded transition-colors',
                                active
                                  ? 'bg-foreground text-background'
                                  : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                              )}
                              onClick={() => {
                                setViewMode(mode)
                                updateArtifact({ id: selectedArtifact.id, viewMode: mode })
                              }}
                            >
                              <Icon className="size-5" />
                              {label}
                            </button>
                          )
                        })}
                      </div>

                      <div className="space-y-3">
                        <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-3 block">
                          Editor
                        </span>
                        <div className="flex items-center justify-between">
                          <Label htmlFor="art-toc" className="text-sm cursor-pointer">
                            Outline
                          </Label>
                          <Switch
                            id="art-toc"
                            checked={editorTocEnabled}
                            onCheckedChange={(v) => {
                              void window.api.settings.set('editor_toc_enabled', v ? '1' : '0')
                              window.dispatchEvent(new Event('sz:settings-changed'))
                            }}
                          />
                        </div>
                        <div className="flex items-center justify-between">
                          <Label
                            htmlFor="art-minimap"
                            className={cn(
                              'text-sm cursor-pointer',
                              viewMode === 'preview' && 'text-muted-foreground/50'
                            )}
                          >
                            Minimap{viewMode === 'preview' ? ' (not in preview)' : ''}
                          </Label>
                          <Switch
                            id="art-minimap"
                            checked={editorMinimapEnabled && viewMode !== 'preview'}
                            disabled={viewMode === 'preview'}
                            onCheckedChange={(v) => {
                              void window.api.settings.set('editor_minimap_enabled', v ? '1' : '0')
                              window.dispatchEvent(new Event('sz:settings-changed'))
                            }}
                          />
                        </div>
                      </div>

                      <div className="space-y-3">
                        <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-3 block">
                          Layout
                        </span>
                        <div className="flex items-center justify-between">
                          <Label htmlFor="art-compact" className="text-sm cursor-pointer">
                            Compact
                            {selectedArtifact.readability_override && (
                              <span className="ml-1.5 text-xs text-muted-foreground/70">
                                (override)
                              </span>
                            )}
                          </Label>
                          <Switch
                            id="art-compact"
                            checked={effectiveReadability === 'compact'}
                            onCheckedChange={(v) => {
                              const next: 'compact' | 'normal' = v ? 'compact' : 'normal'
                              const override = next === notesReadability ? null : next
                              updateArtifact({
                                id: selectedArtifact.id,
                                readabilityOverride: override
                              })
                            }}
                          />
                        </div>
                        <div className="flex items-center justify-between">
                          <Label htmlFor="art-wide" className="text-sm cursor-pointer">
                            Wide
                            {selectedArtifact.width_override && (
                              <span className="ml-1.5 text-xs text-muted-foreground/70">
                                (override)
                              </span>
                            )}
                          </Label>
                          <Switch
                            id="art-wide"
                            checked={effectiveWidth === 'wide'}
                            onCheckedChange={(v) => {
                              const next: 'narrow' | 'wide' = v ? 'wide' : 'narrow'
                              const override = next === notesWidth ? null : next
                              updateArtifact({ id: selectedArtifact.id, widthOverride: override })
                            }}
                          />
                        </div>
                        <div className="flex items-center justify-between">
                          <Label htmlFor="art-mono" className="text-sm cursor-pointer">
                            Use mono font
                          </Label>
                          <Switch
                            id="art-mono"
                            checked={notesFontFamily === 'mono'}
                            onCheckedChange={(v) => {
                              void window.api.settings.set('notes_font_family', v ? 'mono' : 'sans')
                              window.dispatchEvent(new Event('sz:settings-changed'))
                            }}
                          />
                        </div>
                      </div>
                    </MarkdownSettingsPopover>
                  )}
                  <Select
                    value={selectedArtifact.render_mode ?? '__auto__'}
                    onValueChange={(v) =>
                      updateArtifact({
                        id: selectedArtifact.id,
                        renderMode: v === '__auto__' ? null : (v as RenderMode)
                      })
                    }
                  >
                    <SelectTrigger
                      size="sm"
                      className="!h-7 text-xs w-auto min-w-0 gap-1.5 px-2.5 shrink-0"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent
                      position="popper"
                      side="bottom"
                      className="max-h-none overflow-y-visible"
                    >
                      <SelectItem value="__auto__">
                        Auto (
                        {
                          RENDER_MODE_INFO[getEffectiveRenderMode(selectedArtifact.title, null)]
                            .label
                        }
                        )
                      </SelectItem>
                      {(Object.keys(RENDER_MODE_INFO) as RenderMode[]).map((mode) => (
                        <SelectItem key={mode} value={mode}>
                          {RENDER_MODE_INFO[mode].label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {selectedArtifact &&
                selectedRenderMode &&
                (() => {
                  const mode = selectedRenderMode
                  const hasPdf = canExportAsPdf(mode)
                  const hasPng = canExportAsPng(mode)
                  const hasHtml = canExportAsHtml(mode)
                  const hasExport = hasPdf || hasPng || hasHtml

                  return (
                    <>
                      <div className="w-px h-5 bg-border shrink-0 mx-2" />
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            className="!h-7 px-1.5 shrink-0"
                            title="Download"
                          >
                            <Download className="size-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => downloadFile(selectedArtifact.id)}>
                            <Download className="size-3 mr-2" /> Download
                          </DropdownMenuItem>
                          {hasExport && (
                            <DropdownMenuSub>
                              <DropdownMenuSubTrigger>
                                <Download className="size-3 mr-2" /> Download as
                              </DropdownMenuSubTrigger>
                              <DropdownMenuSubContent>
                                {hasPdf && (
                                  <DropdownMenuItem
                                    onSelect={() => downloadAsPdf(selectedArtifact.id)}
                                  >
                                    <FileText className="size-3 mr-2" /> PDF
                                  </DropdownMenuItem>
                                )}
                                {hasPng && (
                                  <DropdownMenuItem
                                    onSelect={() => downloadAsPng(selectedArtifact.id)}
                                  >
                                    <ImageDown className="size-3 mr-2" /> PNG
                                  </DropdownMenuItem>
                                )}
                                {hasHtml && (
                                  <DropdownMenuItem
                                    onSelect={() => downloadAsHtml(selectedArtifact.id)}
                                  >
                                    <FileCode className="size-3 mr-2" /> HTML
                                  </DropdownMenuItem>
                                )}
                              </DropdownMenuSubContent>
                            </DropdownMenuSub>
                          )}
                          {artifacts.length > 0 && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onSelect={() => downloadAllAsZip()}>
                                <Archive className="size-3 mr-2" /> Download all as ZIP
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                      <Button
                        variant="outline"
                        size="sm"
                        className="!h-7 px-1.5 shrink-0"
                        title="Versions"
                        onClick={() => {
                          if (!selectedArtifact) return
                          setVersionsDialogOpen(true)
                          void refreshVersions(selectedArtifact.id)
                        }}
                      >
                        <History className="size-3.5" />
                      </Button>
                    </>
                  )
                })()}
            </div>
          </div>
        </TooltipProvider>

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
                  willCreateRef={willCreateRef}
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
              </div>
            </div>
          )}

          {/* Right content area */}
          <div className="relative flex-1 flex flex-col min-w-0">
            {/* Resize handle (overlay) */}
            {sidebarVisible && (
              <div
                className="absolute left-0 inset-y-0 w-2 -translate-x-1/2 z-10 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 transition-colors"
                onMouseDown={handleSidebarMouseDown}
                onDoubleClick={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
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
            {selectedArtifact ? (
              <>
                <ArtifactContentEditor
                  key={selectedArtifact.id}
                  artifact={selectedArtifact}
                  viewMode={viewMode}
                  readContent={readContent}
                  saveContent={saveContent}
                  getFilePath={getFilePath}
                  effectiveReadability={effectiveReadability}
                  effectiveWidth={effectiveWidth}
                  searchQuery={findOpen ? findQuery : ''}
                  searchActiveIndex={findActiveIndex}
                  searchMatchCase={findMatchCase}
                  searchRegex={findUseRegex}
                  onSearchMatchCountChange={setFindMatchCount}
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
