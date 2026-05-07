import { useState, useCallback, useRef, useEffect, useMemo, useImperativeHandle, forwardRef } from 'react'
import { Code, Columns2, Eye, FileCode, Files, RefreshCw, Search, SlidersHorizontal } from 'lucide-react'
import type { EditorView as CMEditorView } from '@codemirror/view'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Label,
  PulseGrid,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
  getThemeChrome,
  getChromeStyleOverrides,
  getThemeEditorColors,
  useAppearance,
} from '@slayzone/ui'
import { MarkdownSettingsPopover, RichTextEditor, getEditorViewDOM, type Editor as MilkdownEditor } from '@slayzone/editor'
import { useTheme } from '@slayzone/settings/client'
import type { EditorOpenFilesState, MarkdownViewMode, OpenFileOptions } from '@slayzone/file-editor/shared'
import { useFileEditor } from './useFileEditor'
import { EditorFileTree, type EditorFileTreeHandle } from './EditorFileTree'
import { EditorTabBar } from './EditorTabBar'
import { CodeEditor } from './CodeEditor'
import { MarkdownSplitView } from './MarkdownSplitView'
import { SearchPanel } from './SearchPanel'
import { EditorToc } from './EditorToc'
import type { MarkdownHeading } from './markdown-headings'

const MARKDOWN_FILE_TEXT_EXTENSIONS = new Set([
  'md', 'mdx', 'markdown', 'txt', 'rst',
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
  'json', 'yaml', 'yml', 'toml', 'xml', 'html', 'css', 'scss',
  'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'sh', 'env',
])

function posixDirname(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}

function posixResolve(...parts: string[]): string {
  const segments: string[] = []
  for (const part of parts.join('/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') segments.pop()
    else segments.push(part)
  }
  return '/' + segments.join('/')
}

export interface FileEditorViewHandle {
  openFile: (filePath: string, options?: OpenFileOptions) => void
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

export interface MarkdownFilePaneHandle {
  scrollToHeadingIndex: (index: number) => void
}

interface MarkdownFilePaneProps {
  filePath: string
  projectPath: string
  content: string
  onChange: (content: string) => void
  onSave: () => void
  onOpenFile: (filePath: string) => void
  themeColors: ReturnType<typeof getThemeEditorColors>
  readability: 'compact' | 'normal'
  width: 'narrow' | 'wide'
  fontFamily: 'sans' | 'mono'
  handleRef?: React.MutableRefObject<MarkdownFilePaneHandle | null>
}

function MarkdownFilePane({ filePath, projectPath, content, onChange, onSave, onOpenFile, themeColors, readability, width, fontFamily, handleRef }: MarkdownFilePaneProps) {
  const editorRef = useRef<MilkdownEditor | null>(null)
  useEffect(() => {
    if (!handleRef) return
    handleRef.current = {
      scrollToHeadingIndex: (index: number) => {
        const root = editorRef.current ? getEditorViewDOM(editorRef.current) : null
        if (!root) return
        const headings = root.querySelectorAll('h1,h2,h3,h4,h5,h6')
        const target = headings[index] as HTMLElement | undefined
        target?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      },
    }
    return () => { if (handleRef) handleRef.current = null }
  }, [handleRef])
  const fileDirAbs = posixResolve(projectPath, posixDirname(filePath))

  const resolveSrc = useCallback((src: string): string => {
    if (src.startsWith('/')) return `slz-file://${src}`
    return `slz-file://${posixResolve(fileDirAbs, src)}`
  }, [fileDirAbs])

  const handleLinkClick = useCallback((resolvedHref: string) => {
    if (!resolvedHref) return
    if (resolvedHref.startsWith('#')) {
      const id = resolvedHref.slice(1)
      const root = editorRef.current ? getEditorViewDOM(editorRef.current) : null
      const el = id ? (root ?? document).querySelector(`#${CSS.escape(id)}`) : null
      el?.scrollIntoView({ block: 'center' })
      return
    }
    if (/^(https?:|mailto:)/i.test(resolvedHref)) {
      void window.api.shell.openExternal(resolvedHref)
      return
    }
    if (resolvedHref.startsWith('slz-file://')) {
      const absPath = resolvedHref.replace(/^slz-file:\/\//, '').replace(/\?.*$/, '').replace(/#.*$/, '')
      const projectPrefix = projectPath.endsWith('/') ? projectPath : projectPath + '/'
      if (absPath.startsWith(projectPrefix)) {
        const relPath = absPath.slice(projectPrefix.length)
        const ext = relPath.split('.').pop()?.toLowerCase() ?? ''
        if (MARKDOWN_FILE_TEXT_EXTENSIONS.has(ext)) {
          onOpenFile(relPath)
          return
        }
      }
      void window.api.shell.openPath(absPath)
    }
  }, [projectPath, onOpenFile])

  return (
    <RichTextEditor
      value={content}
      onChange={onChange}
      onSave={onSave}
      editorRef={editorRef}
      variant="page"
      readability={readability}
      width={width}
      fontFamily={fontFamily}
      themeColors={themeColors}
      frontmatter
      htmlResolveSrc={resolveSrc}
      htmlOnLinkClick={handleLinkClick}
    />
  )
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
    closeOtherFiles,
    closeFilesToRight,
    closeSavedFiles,
    closeAllFiles,
    hasDirtyFiles,
    isDirty,
    isFileDiskChanged,
    isFileDeleted,
    renameOpenFile,
    isRestoring,
    refreshTree,
    treeRefreshKey,
    fileVersions,
    goToPosition,
    clearGoToPosition
  } = useFileEditor(projectPath, initialEditorState)

  const { editorOverrideThemeId, editorThemeId, contentVariant } = useTheme()
  const editorPanelStyle = useMemo(() => {
    if (!editorOverrideThemeId) return undefined
    return getChromeStyleOverrides(getThemeChrome(editorOverrideThemeId, contentVariant))
  }, [editorOverrideThemeId, contentVariant])
  const markdownThemeColors = useMemo(
    () => getThemeEditorColors(editorThemeId, contentVariant),
    [editorThemeId, contentVariant]
  )

  const [treeWidth, setTreeWidth] = useState(initialEditorState?.treeWidth ?? 250)
  const [treeVisible, setTreeVisible] = useState(initialEditorState?.treeVisible ?? true)
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    () => new Set(initialEditorState?.expandedFolders ?? [])
  )
  const isDragging = useRef(false)
  const treeRef = useRef<EditorFileTreeHandle>(null)
  const [confirmClose, setConfirmClose] = useState<string | null>(null)
  const [confirmCloseAll, setConfirmCloseAll] = useState(false)
  const [fileViewModes, setFileViewModes] = useState<Record<string, MarkdownViewMode>>(
    initialEditorState?.fileViewModes ?? {}
  )
  const { editorMarkdownViewMode, notesReadability, notesWidth, notesFontFamily, editorMinimapEnabled, editorTocEnabled } = useAppearance()
  const [displayOpen, setDisplayOpen] = useState(false)
  const [tocWidth, setTocWidth] = useState(initialEditorState?.tocWidth ?? 220)
  const cmViewRef = useRef<CMEditorView | null>(null)
  const richPaneRef = useRef<MarkdownFilePaneHandle | null>(null)
  const viewMode: MarkdownViewMode = (activeFilePath ? fileViewModes[activeFilePath] : undefined) ?? editorMarkdownViewMode
  const setViewModeForFile = useCallback((mode: MarkdownViewMode) => {
    if (!activeFilePath) return
    setFileViewModes(prev => ({ ...prev, [activeFilePath]: mode }))
  }, [activeFilePath])
  const writeAppearance = useCallback((key: string, value: string) => {
    void window.api.settings.set(key, value)
    window.dispatchEvent(new Event('sz:settings-changed'))
  }, [])
  const [sidebarMode, setSidebarMode] = useState<'tree' | 'search'>('tree')
  const [isFileDragOver, setIsFileDragOver] = useState(false)
  const [treeReady, setTreeReady] = useState(false)
  const dragCounter = useRef(0)
  const showLoading = isRestoring || (treeVisible && !treeReady)

  // --- Emit state changes to parent for persistence ---
  // Parent (TaskDetailPage) debounces at 500ms, so frequent calls here are fine.
  // Use filePathsKey (stable string) instead of openFiles to avoid emitting on every keystroke.
  const onChangeRef = useRef(onEditorStateChange)
  onChangeRef.current = onEditorStateChange
  const filePathsKey = openFiles.map((f) => f.path).join('\0')

  const fileViewModesKey = JSON.stringify(fileViewModes)
  useEffect(() => {
    if (isRestoring) return
    const openPaths = filePathsKey ? filePathsKey.split('\0') : []
    const modes: Record<string, MarkdownViewMode> = {}
    for (const p of openPaths) {
      if (fileViewModes[p]) modes[p] = fileViewModes[p]
    }
    onChangeRef.current?.({
      files: openPaths,
      activeFile: activeFilePath,
      treeWidth,
      treeVisible,
      expandedFolders: [...expandedFolders],
      fileViewModes: Object.keys(modes).length > 0 ? modes : undefined,
      tocWidth,
    })
  }, [filePathsKey, activeFilePath, treeWidth, treeVisible, expandedFolders, isRestoring, fileViewModesKey, tocWidth])

  // Auto-reveal active file in tree when it changes
  useEffect(() => {
    if (!activeFilePath || isRestoring) return
    const parts = activeFilePath.split('/')
    if (parts.length > 1) {
      const ancestors = parts.slice(0, -1).reduce<string[]>((acc, part, i) => {
        acc.push(i === 0 ? part : `${acc[i - 1]}/${part}`)
        return acc
      }, [])
      setExpandedFolders(prev => {
        if (ancestors.every(a => prev.has(a))) return prev
        return new Set([...prev, ...ancestors])
      })
    }
    requestAnimationFrame(() => treeRef.current?.scrollToPath(activeFilePath))
  }, [activeFilePath, isRestoring])

  const isMarkdown = useMemo(() => {
    const ext = activeFilePath?.split('.').pop()?.toLowerCase()
    return ext === 'md' || ext === 'mdx'
  }, [activeFilePath])

  const handleTocJump = useCallback((heading: MarkdownHeading) => {
    if (viewMode === 'rich') {
      richPaneRef.current?.scrollToHeadingIndex(heading.index)
      return
    }
    const view = cmViewRef.current
    if (!view) return
    const line = Math.max(1, Math.min(heading.line, view.state.doc.lines))
    const lineObj = view.state.doc.line(line)
    view.dispatch({ selection: { anchor: lineObj.from }, scrollIntoView: true })
    view.focus()
  }, [viewMode])

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

  const handleCloseAll = useCallback(() => {
    if (hasDirtyFiles) {
      setConfirmCloseAll(true)
      return
    }
    closeAllFiles()
  }, [hasDirtyFiles, closeAllFiles])

  const handleConfirmCloseAll = useCallback(() => {
    closeAllFiles()
    setConfirmCloseAll(false)
  }, [closeAllFiles])

  const handleCopyPath = useCallback((filePath: string) => {
    void navigator.clipboard.writeText(`${projectPath}/${filePath}`)
  }, [projectPath])

  const handleCopyRelativePath = useCallback((filePath: string) => {
    void navigator.clipboard.writeText(filePath)
  }, [])

  const handleRevealInFinder = useCallback((filePath: string) => {
    void window.api.fs.showInFinder(projectPath, filePath)
  }, [projectPath])

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
      className="h-full flex bg-surface-0 relative"
      style={editorPanelStyle as React.CSSProperties | undefined}
      onDragOver={handleFileDragOver}
      onDragEnter={handleFileDragEnter}
      onDragLeave={handleFileDragLeave}
      onDrop={handleFileDrop}
    >
      {/* Sidebar: header tabs + file tree or search */}
      {treeVisible && (
        <div className="shrink-0 border-r overflow-hidden flex flex-col" style={{ width: treeWidth }}>
          {/* Sidebar tab header */}
          <TooltipProvider delayDuration={400}>
            <div className="flex items-center gap-1 px-2 h-10 border-b border-border shrink-0 bg-surface-1">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide mr-auto">
                {sidebarMode === 'search' ? 'Search' : 'Files'}
              </span>
              {sidebarMode === 'tree' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      className="size-7 flex items-center justify-center rounded transition-colors text-muted-foreground hover:text-foreground hover:bg-muted/50"
                      onClick={refreshTree}
                    >
                      <RefreshCw className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Refresh</TooltipContent>
                </Tooltip>
              )}
              {([
                { mode: 'tree' as const, icon: Files, label: 'Explorer' },
                { mode: 'search' as const, icon: Search, label: 'Search' }
              ]).map(({ mode, icon: Icon, label }) => (
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
          </TooltipProvider>
          {/* Sidebar content */}
          <div className="flex-1 min-w-0 min-h-0">
            {sidebarMode === 'search' ? (
              <SearchPanel
                projectPath={projectPath}
                onOpenFile={openFile}
              />
            ) : (
              <EditorFileTree
                ref={treeRef}
                projectPath={projectPath}
                onOpenFile={openFile}
                onFileRenamed={renameOpenFile}
                activeFilePath={activeFilePath}
                refreshKey={treeRefreshKey}
                expandedFolders={expandedFolders}
                onExpandedFoldersChange={setExpandedFolders}
                onReady={() => setTreeReady(true)}
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
        <TooltipProvider delayDuration={400}>
          <div className="flex items-center shrink-0 h-10 border-b border-border bg-surface-1">
            <EditorTabBar
              files={openFiles}
              activeFilePath={activeFilePath}
              onSelect={setActiveFilePath}
              onClose={handleCloseFile}
              onCloseOthers={closeOtherFiles}
              onCloseToRight={closeFilesToRight}
              onCloseSaved={closeSavedFiles}
              onCloseAll={handleCloseAll}
              onCopyPath={handleCopyPath}
              onCopyRelativePath={handleCopyRelativePath}
              onRevealInFinder={handleRevealInFinder}
              isDirty={isDirty}
              diskChanged={isFileDiskChanged}
              deleted={isFileDeleted}
              treeVisible={treeVisible}
              onToggleTree={() => setTreeVisible((v) => !v)}
            />
            {isMarkdown && activeFile?.content != null && !activeFile?.deleted && (
              <MarkdownSettingsPopover
                open={displayOpen}
                onOpenChange={setDisplayOpen}
                trigger={
                  <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 mr-2 text-xs font-medium text-muted-foreground">
                    <SlidersHorizontal className="size-3.5" />
                    Display
                  </Button>
                }
              >
                <div className="grid grid-cols-3 rounded-md border border-border/50 p-0.5 gap-0.5">
                  {([
                    { mode: 'rich' as const, icon: Eye, label: 'Rich' },
                    { mode: 'split' as const, icon: Columns2, label: 'Split' },
                    { mode: 'code' as const, icon: Code, label: 'Code' },
                  ]).map(({ mode, icon: Icon, label }) => {
                    const active = viewMode === mode
                    return (
                      <button
                        key={mode}
                        className={cn(
                          'flex flex-col items-center justify-center gap-1 py-3 text-[10px] font-medium rounded transition-colors',
                          active ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                        )}
                        onClick={() => setViewModeForFile(mode)}
                      >
                        <Icon className="size-5" />
                        {label}
                      </button>
                    )
                  })}
                </div>

                <div className="space-y-3">
                  <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-3 block">Editor</span>
                  <div className="flex items-center justify-between">
                    <Label htmlFor="md-toc" className="text-sm cursor-pointer">Outline</Label>
                    <Switch id="md-toc" checked={editorTocEnabled} onCheckedChange={(v) => writeAppearance('editor_toc_enabled', v ? '1' : '0')} />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label htmlFor="md-minimap" className={cn('text-sm cursor-pointer', viewMode === 'rich' && 'text-muted-foreground/50')}>Minimap{viewMode === 'rich' ? ' (not in rich mode)' : ''}</Label>
                    <Switch id="md-minimap" checked={editorMinimapEnabled && viewMode !== 'rich'} disabled={viewMode === 'rich'} onCheckedChange={(v) => writeAppearance('editor_minimap_enabled', v ? '1' : '0')} />
                  </div>
                </div>

                <div className="space-y-3">
                  <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-3 block">Layout</span>
                  <div className="flex items-center justify-between">
                    <Label htmlFor="md-compact" className="text-sm cursor-pointer">Compact</Label>
                    <Switch id="md-compact" checked={notesReadability === 'compact'} onCheckedChange={(v) => writeAppearance('notes_readability', v ? 'compact' : 'normal')} />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label htmlFor="md-wide" className="text-sm cursor-pointer">Wide</Label>
                    <Switch id="md-wide" checked={notesWidth === 'wide'} onCheckedChange={(v) => writeAppearance('notes_width', v ? 'wide' : 'narrow')} />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label htmlFor="md-mono" className="text-sm cursor-pointer">Use mono font</Label>
                    <Switch id="md-mono" checked={notesFontFamily === 'mono'} onCheckedChange={(v) => writeAppearance('notes_font_family', v ? 'mono' : 'sans')} />
                  </div>
                </div>
              </MarkdownSettingsPopover>
            )}
          </div>
        </TooltipProvider>

        {activeFile?.deleted && (
          <div className="shrink-0 flex items-center gap-3 px-3 py-2 bg-destructive/10 border-b border-destructive/30 text-xs">
            <span className="text-destructive font-medium">File deleted on disk.</span>
            <span className="text-muted-foreground">Save to recreate, or close tab to discard changes.</span>
            <div className="ml-auto flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => saveFile(activeFile.path)}>Save</Button>
              <Button size="sm" variant="ghost" onClick={() => closeFile(activeFile.path)}>Discard</Button>
            </div>
          </div>
        )}
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
          <div className="relative flex-1 min-h-0 flex">
            <div className="flex-1 min-w-0">
              {isMarkdown && viewMode === 'rich' ? (
                <MarkdownFilePane
                  key={activeFile.path}
                  filePath={activeFile.path}
                  projectPath={projectPath}
                  content={activeFile.content}
                  onChange={(content) => updateContent(activeFile.path, content)}
                  onSave={() => saveFile(activeFile.path)}
                  onOpenFile={openFile}
                  themeColors={markdownThemeColors}
                  readability={notesReadability}
                  width={notesWidth}
                  fontFamily={notesFontFamily}
                  handleRef={richPaneRef}
                />
              ) : isMarkdown && viewMode === 'split' ? (
                <MarkdownSplitView
                  key={activeFile.path}
                  filePath={activeFile.path}
                  content={activeFile.content}
                  onChange={(content) => updateContent(activeFile.path, content)}
                  onSave={() => saveFile(activeFile.path)}
                  version={fileVersions.get(activeFile.path)}
                  goToPosition={goToPosition?.filePath === activeFile.path ? goToPosition : null}
                  onGoToPositionApplied={clearGoToPosition}
                  minimap={editorMinimapEnabled}
                  viewHandleRef={cmViewRef}
                />
              ) : (
                <CodeEditor
                  key={activeFile.path}
                  filePath={activeFile.path}
                  content={activeFile.content}
                  onChange={(content) => updateContent(activeFile.path, content)}
                  onSave={() => saveFile(activeFile.path)}
                  version={fileVersions.get(activeFile.path)}
                  goToPosition={goToPosition?.filePath === activeFile.path ? goToPosition : null}
                  onGoToPositionApplied={clearGoToPosition}
                  minimap={editorMinimapEnabled}
                  viewHandleRef={cmViewRef}
                />
              )}
            </div>
            {isMarkdown && editorTocEnabled && (
              <EditorToc
                content={activeFile.content}
                width={tocWidth}
                onWidthChange={setTocWidth}
                onJump={handleTocJump}
                minimapVisible={editorMinimapEnabled && viewMode !== 'rich'}
              />
            )}
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

      {showLoading && (
        <div className="absolute inset-0 z-40 bg-surface-0">
          <PulseGrid />
        </div>
      )}

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

      <AlertDialog open={confirmCloseAll} onOpenChange={setConfirmCloseAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved changes</AlertDialogTitle>
            <AlertDialogDescription>
              Some open files have unsaved changes. Closing all will discard them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmCloseAll}>Discard all</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
})
