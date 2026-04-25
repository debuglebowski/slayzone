import { useState, useEffect, useCallback, useRef, useImperativeHandle, forwardRef, useMemo, type CSSProperties, type DragEvent } from 'react'
import { Upload, Download, Trash2, FileText, Code, Globe, Image, GitBranch, Eye, Code2, Columns2, ZoomIn, ZoomOut, FolderPlus, Pencil, FilePlus, FolderOpen, Folder, ArrowRight, Copy, Search, Files, PanelLeftClose, PanelLeft, ImageDown, FileCode, Archive, Rows2, Rows3, Maximize2, AlignCenter, History, type LucideIcon } from 'lucide-react'
import {
  cn, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Button, Input,
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent,
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent,
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
  Tabs, TabsList, TabsTrigger,
  toast,
  Tooltip, TooltipTrigger, TooltipContent, TooltipProvider,
  PulseGrid,
} from '@slayzone/ui'
import type { AssetVersion, DiffResult } from '@slayzone/task-assets/shared'
import { RichTextEditor } from '@slayzone/editor'
import type { RenderMode, TaskAsset, AssetFolder } from '@slayzone/task/shared'
import { getEffectiveRenderMode, getExtensionFromTitle, RENDER_MODE_INFO, isBinaryRenderMode, canExportAsPdf, canExportAsPng, canExportAsHtml } from '@slayzone/task/shared'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { MermaidBlock, mermaidCodeOverride } from '@slayzone/markdown/client'

const markdownComponents = { code: mermaidCodeOverride }
import { useAppearance, getThemeEditorColors, type EditorThemeColors } from '@slayzone/ui'
import { useTheme } from '@slayzone/settings/client'
import { SearchableCodeView } from '@slayzone/file-editor/client/SearchableCodeView'
import { useAssets } from './useAssets'
import { AssetFindBar } from './AssetFindBar'
import { AssetSearchPanel } from './AssetSearchPanel'
import { AssetVersionsDialog } from './AssetVersionsDialog'
import { AssetVersionDiffView } from './AssetVersionDiffView'

export interface AssetsPanelHandle {
  selectAsset: (id: string) => void
  createAsset: () => void
  toggleSearch: () => void
}

interface AssetsPanelProps {
  taskId: string
  isResizing?: boolean
  initialActiveAssetId?: string | null
  onActiveAssetIdChange?: (id: string | null) => void
}

const INDENT_PX = 20
const BASE_PAD = 4

const RENDER_MODE_ICONS: Record<RenderMode, typeof FileText> = {
  'markdown': FileText,
  'code': Code,
  'html-preview': Globe,
  'svg-preview': Image,
  'mermaid-preview': GitBranch,
  'image': Image,
  'pdf': FileText,
}

function getAssetIcon(asset: TaskAsset): typeof FileText {
  const mode = getEffectiveRenderMode(asset.title, asset.render_mode)
  return RENDER_MODE_ICONS[mode] ?? Code
}

function hasPreviewToggle(mode: RenderMode): boolean {
  return mode === 'markdown' || mode === 'html-preview' || mode === 'svg-preview' || mode === 'mermaid-preview'
}

function hasZoom(mode: RenderMode): boolean {
  return mode === 'image' || mode === 'svg-preview' || mode === 'mermaid-preview'
}

function IconToggleButton({ icon: Icon, active, onClick, tooltip }: {
  icon: LucideIcon
  active: boolean
  onClick: () => void
  tooltip: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-pressed={active}
          className={cn(
            'flex items-center justify-center size-6 rounded transition-colors',
            active ? 'bg-muted text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
          )}
          onClick={onClick}
        >
          <Icon className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  )
}

const TOGGLE_PILL_CLASS = 'flex items-center shrink-0 bg-surface-1 border border-border rounded-md p-0.5 gap-0.5'

// --- Image viewer ---

function ImageViewer({ assetId, contentVersion, zoomLevel, onZoom, getFilePath }: { assetId: string; contentVersion: number; zoomLevel: number; onZoom: (fn: (z: number) => number) => void; getFilePath: (id: string) => Promise<string | null> }) {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    getFilePath(assetId).then((p) => {
      if (p) setSrc(`slz-file://${p}?v=${contentVersion}`)
    })
  }, [assetId, contentVersion, getFilePath])

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!e.metaKey && !e.ctrlKey) return
    e.preventDefault()
    onZoom(z => Math.min(4, Math.max(0.25, z + (e.deltaY > 0 ? -0.1 : 0.1))))
  }, [onZoom])

  if (!src) return <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">Loading...</div>

  return (
    <div className={cn("flex-1 p-4 overflow-auto bg-muted/20", zoomLevel <= 1 && "flex items-center justify-center")} onWheel={handleWheel}>
      <img src={src} style={zoomLevel !== 1 ? { transform: `scale(${zoomLevel})`, transformOrigin: 'top left' } : undefined} className={zoomLevel <= 1 ? "max-w-full max-h-full object-contain" : ""} alt="" />
    </div>
  )
}

// --- PDF viewer ---

function PdfViewer({ assetId, contentVersion, getFilePath }: { assetId: string; contentVersion: number; getFilePath: (id: string) => Promise<string | null> }) {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    getFilePath(assetId).then((p) => {
      if (p) setSrc(`slz-file://${p}?v=${contentVersion}`)
    })
  }, [assetId, contentVersion, getFilePath])

  if (!src) return <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">Loading...</div>

  return <iframe src={src} className="flex-1 w-full" title="PDF preview" />
}

// --- Asset content editor ---

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatRelativeDate(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 7) return `${diffDays}d ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export interface AssetStats {
  fileSize: number | null
  words: number
  lines: number
}

function AssetContentEditor({ asset, viewMode, zoomLevel, onZoom, readContent, saveContent, getFilePath, onStats, effectiveReadability, effectiveWidth, searchQuery, searchActiveIndex, searchMatchCase, searchRegex, onSearchMatchCountChange }: {
  asset: TaskAsset
  viewMode: 'preview' | 'split' | 'raw'
  zoomLevel: number
  onZoom: (fn: (z: number) => number) => void
  readContent: (id: string) => Promise<string | null>
  saveContent: (id: string, content: string) => Promise<void>
  getFilePath: (id: string) => Promise<string | null>
  onStats?: (stats: AssetStats) => void
  effectiveReadability: 'compact' | 'normal'
  effectiveWidth: 'narrow' | 'wide'
  searchQuery: string
  searchActiveIndex: number
  searchMatchCase: boolean
  searchRegex: boolean
  onSearchMatchCountChange: (count: number) => void
}) {
  const { notesFontFamily, notesCheckedHighlight, notesShowToolbar, notesSpellcheck } = useAppearance()
  const { editorThemeId, contentVariant } = useTheme()
  const themeColors: EditorThemeColors = useMemo(
    () => getThemeEditorColors(editorThemeId, contentVariant),
    [editorThemeId, contentVariant]
  )
  const themeStyle = useMemo(() => ({
    '--mk-bg': themeColors.background,
    '--mk-fg': themeColors.foreground,
    '--mk-heading': themeColors.heading,
    '--mk-link': themeColors.link,
    '--mk-code-fg': themeColors.keyword,
    '--mk-code-bg': themeColors.selection,
    '--mk-quote-border': themeColors.comment,
    '--mk-hr-color': themeColors.comment,
  } as CSSProperties), [themeColors])
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [isDirty, setIsDirty] = useState(false)
  const [externalChangePending, setExternalChangePending] = useState(false)
  const [contentVersion, setContentVersion] = useState(0)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const baselineMtimeRef = useRef<number | null>(null)
  const contentRef = useRef(content)
  const isDirtyRef = useRef(false)
  const onStatsRef = useRef(onStats)
  contentRef.current = content
  isDirtyRef.current = isDirty
  onStatsRef.current = onStats
  const fileExt = getExtensionFromTitle(asset.title) || undefined

  const renderMode = getEffectiveRenderMode(asset.title, asset.render_mode)
  const isBinary = isBinaryRenderMode(renderMode)

  // Read file from disk + refresh baseline mtime. Clears dirty + pending flags.
  const loadFromDisk = useCallback(async (): Promise<void> => {
    const [c, mtime] = await Promise.all([
      readContent(asset.id),
      window.api.assets.getMtime(asset.id),
    ])
    setContent(c ?? '')
    baselineMtimeRef.current = mtime
    setIsDirty(false)
    setExternalChangePending(false)
    setContentVersion(v => v + 1)
  }, [asset.id, readContent])

  useEffect(() => {
    const text = content ?? ''
    const words = text.trim() ? text.trim().split(/\s+/).length : 0
    const lines = text ? text.split('\n').length : 0
    window.api.assets.getFileSize(asset.id).then((size) => {
      onStatsRef.current?.({ fileSize: size, words, lines })
    })
  }, [content, asset.id])

  // Load on mount / asset change. Flush pending save on unmount (with mtime guard).
  useEffect(() => {
    if (isBinary) {
      setLoading(false)
      window.api.assets.getMtime(asset.id).then((m) => { baselineMtimeRef.current = m })
      setContentVersion(v => v + 1)
      window.api.assets.getFileSize(asset.id).then((size) => {
        onStatsRef.current?.({ fileSize: size, words: 0, lines: 0 })
      })
      return
    }
    setLoading(true)
    loadFromDisk().finally(() => setLoading(false))
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      if (isDirtyRef.current && contentRef.current !== null) {
        // Best-effort flush. mtime guard happens inside saveContent path at the
        // handler level — we can't await a newer-disk check in cleanup.
        saveContent(asset.id, contentRef.current)
      }
    }
  }, [asset.id, isBinary, loadFromDisk, saveContent])

  // fs.watch subscription — disk is the single source of truth for content.
  useEffect(() => {
    const off = window.api.assets.onContentChanged((changedId) => {
      if (changedId !== asset.id) return
      if (isDirtyRef.current) {
        setExternalChangePending(true)
      } else {
        loadFromDisk()
      }
    })
    return () => { off() }
  }, [asset.id, loadFromDisk])


  const handleChange = useCallback((value: string) => {
    setContent(value)
    setIsDirty(true)
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(async () => {
      saveTimerRef.current = null
      const currentMtime = await window.api.assets.getMtime(asset.id)
      if (
        currentMtime != null &&
        baselineMtimeRef.current != null &&
        currentMtime > baselineMtimeRef.current
      ) {
        // External write happened while we were holding a draft. Surface conflict
        // instead of clobbering disk.
        setExternalChangePending(true)
        return
      }
      await saveContent(asset.id, value)
      const newMtime = await window.api.assets.getMtime(asset.id)
      baselineMtimeRef.current = newMtime
      setIsDirty(false)
    }, 500)
  }, [asset.id, saveContent])

  const handleReloadFromDisk = useCallback((): void => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    loadFromDisk()
  }, [loadFromDisk])

  const handleKeepMine = useCallback(async (): Promise<void> => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    if (contentRef.current == null) return
    await saveContent(asset.id, contentRef.current)
    const newMtime = await window.api.assets.getMtime(asset.id)
    baselineMtimeRef.current = newMtime
    setIsDirty(false)
    setExternalChangePending(false)
  }, [asset.id, saveContent])

  const banner = externalChangePending ? (
    <div className="shrink-0 flex items-center gap-2 border-b border-border bg-amber-500/10 px-3 py-1.5 text-[11px]" data-testid="asset-conflict-banner">
      <span className="flex-1 text-muted-foreground">File changed externally.</span>
      <Button variant="outline" size="sm" className="!h-6 text-[10px] px-2" onClick={handleReloadFromDisk} data-testid="asset-conflict-reload">Reload</Button>
      <Button variant="outline" size="sm" className="!h-6 text-[10px] px-2" onClick={handleKeepMine} data-testid="asset-conflict-keep">Keep mine</Button>
    </div>
  ) : null

  const inner = ((): React.ReactElement => {
    if (loading) return <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">Loading...</div>
    if (renderMode === 'image') return <ImageViewer assetId={asset.id} contentVersion={contentVersion} zoomLevel={zoomLevel} onZoom={onZoom} getFilePath={getFilePath} />
    if (renderMode === 'pdf') return <PdfViewer assetId={asset.id} contentVersion={contentVersion} getFilePath={getFilePath} />

    const hasPreview = renderMode === 'markdown' || renderMode === 'html-preview' || renderMode === 'svg-preview' || renderMode === 'mermaid-preview'

    if (renderMode === 'markdown' && viewMode === 'preview') {
      return (
        <div className="flex-1 overflow-y-auto">
          <RichTextEditor
            value={content ?? ''}
            onChange={handleChange}
            placeholder="Write markdown..."
            readability={effectiveReadability}
            width={effectiveWidth}
            fontFamily={notesFontFamily}
            checkedHighlight={notesCheckedHighlight}
            showToolbar={notesShowToolbar}
            spellcheck={notesSpellcheck}
            themeColors={themeColors}
            searchQuery={searchQuery}
            searchActiveIndex={searchActiveIndex}
            onSearchMatchCountChange={onSearchMatchCountChange}
          />
        </div>
      )
    }

    if (renderMode === 'markdown' && viewMode === 'split') {
      return (
        <div className="flex-1 flex flex-row overflow-hidden">
          <div className="flex-1 min-w-0">
            <SearchableCodeView
              value={content ?? ''}
              onChange={handleChange}
              fileExt={fileExt}
              version={contentVersion}
              searchQuery={searchQuery}
              searchActiveIndex={searchActiveIndex}
              searchMatchCase={searchMatchCase}
              searchRegex={searchRegex}
              onSearchMatchCountChange={onSearchMatchCountChange}
              placeholder="Write markdown..."
            />
          </div>
          <div className="flex-1 border-l border-border min-w-0 min-h-0">
            <div className="mk-doc" data-readability={effectiveReadability} data-width={effectiveWidth} style={themeStyle}>
              <div className="mk-doc-scroll">
                <div className="mk-doc-body">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{content ?? ''}</ReactMarkdown>
                </div>
              </div>
            </div>
          </div>
        </div>
      )
    }

    if (hasPreview && viewMode === 'preview') {
      return <div className="flex-1 flex flex-col overflow-hidden"><AssetPreview renderMode={renderMode} content={content ?? ''} zoomLevel={zoomLevel} onZoom={onZoom} /></div>
    }

    if (hasPreview && viewMode === 'split') {
      return (
        <div className="flex-1 flex flex-row overflow-hidden">
          <div className="flex-1 min-w-0">
            <SearchableCodeView
              value={content ?? ''}
              onChange={handleChange}
              fileExt={fileExt}
              version={contentVersion}
              searchQuery={searchQuery}
              searchActiveIndex={searchActiveIndex}
              searchMatchCase={searchMatchCase}
              searchRegex={searchRegex}
              onSearchMatchCountChange={onSearchMatchCountChange}
              placeholder={`Write ${fileExt || 'content'}...`}
            />
          </div>
          <div className="flex-1 flex flex-col border-l border-border overflow-hidden min-w-0">
            <AssetPreview renderMode={renderMode} content={content ?? ''} zoomLevel={zoomLevel} onZoom={onZoom} />
          </div>
        </div>
      )
    }

    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <SearchableCodeView
          value={content ?? ''}
          onChange={handleChange}
          fileExt={fileExt}
          version={contentVersion}
          searchQuery={searchQuery}
          searchActiveIndex={searchActiveIndex}
          onSearchMatchCountChange={onSearchMatchCountChange}
          placeholder={`Write ${fileExt || 'content'}...`}
        />
      </div>
    )
  })()

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {banner}
      {inner}
    </div>
  )
}

// --- Preview pane ---

function AssetPreview({ renderMode, content, zoomLevel = 1, onZoom }: { renderMode: RenderMode; content: string; zoomLevel?: number; onZoom?: (fn: (z: number) => number) => void }) {
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!e.metaKey && !e.ctrlKey) return
    e.preventDefault()
    onZoom?.(z => Math.min(4, Math.max(0.25, z + (e.deltaY > 0 ? -0.1 : 0.1))))
  }, [onZoom])

  if (renderMode === 'html-preview') return <iframe srcDoc={content} sandbox="allow-scripts" className="flex-1 bg-white" title="HTML preview" />

  const zoomStyle = zoomLevel !== 1 ? { transform: `scale(${zoomLevel})`, transformOrigin: 'top left' } : undefined

  if (renderMode === 'svg-preview') return <div className="flex-1 p-4 overflow-auto" onWheel={handleWheel}><div style={zoomStyle} dangerouslySetInnerHTML={{ __html: content }} /></div>
  // mermaid-preview: MermaidBlock owns its own zoom/pan controls, so skip the
  // outer wheel-zoom wrapper to avoid two stacked zoom systems.
  if (renderMode === 'mermaid-preview' && content.trim()) return <div className="flex-1 p-4 overflow-auto"><MermaidBlock code={content} /></div>
  return null
}

// --- Main panel ---

export const AssetsPanel = forwardRef<AssetsPanelHandle, AssetsPanelProps>(function AssetsPanel({ taskId, isResizing, initialActiveAssetId, onActiveAssetIdChange }, ref) {
  const {
    assets, folders, isLoading, selectedId, setSelectedId,
    createAsset, updateAsset, deleteAsset, renameAsset, moveAssetToFolder,
    readContent, saveContent, uploadAsset, uploadDir, getFilePath,
    downloadFile, downloadFolder, downloadAsPdf, downloadAsPng, downloadAsHtml, downloadAllAsZip,
    listVersions, readVersion, createVersion, renameVersion, diffVersions, setCurrentVersion,
    createFolder, deleteFolder, renameFolder,
    getAssetPath, folderPathMap,
  } = useAssets(taskId, initialActiveAssetId)

  // Notify parent when selection changes (for persistence)
  const prevSelectedIdRef = useRef(selectedId)
  useEffect(() => {
    if (selectedId !== prevSelectedIdRef.current) {
      prevSelectedIdRef.current = selectedId
      onActiveAssetIdChange?.(selectedId)
    }
  }, [selectedId, onActiveAssetIdChange])

  const { editorMarkdownViewMode, notesReadability, notesWidth } = useAppearance()
  const assetDefaultViewMode = editorMarkdownViewMode === 'code' ? 'raw' : editorMarkdownViewMode === 'split' ? 'split' : 'preview'
  const [viewMode, setViewMode] = useState<'preview' | 'split' | 'raw'>('preview')
  const [zoomLevel, setZoomLevel] = useState(1)
  const [assetStats, setAssetStats] = useState<AssetStats>({ fileSize: null, words: 0, lines: 0 })
  const [dragOver, setDragOver] = useState(false)
  const [dropTargetFolder, setDropTargetFolder] = useState<string | null>(null)
  const dragAssetIdRef = useRef<string | null>(null)

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

  // Versions modal state
  const [assetVersions, setAssetVersions] = useState<AssetVersion[]>([])
  const [versionsLoading, setVersionsLoading] = useState(false)
  const [versionsDialogOpen, setVersionsDialogOpen] = useState(false)
  const [viewingVersion, setViewingVersion] = useState<{
    version: AssetVersion
    content: string
    diff: DiffResult | null
    mode: 'diff' | 'content'
    /** version_num to diff against. undefined = default (latest per IPC). */
    diffAgainst: number | undefined
  } | null>(null)

  const refreshVersions = useCallback(async (assetId: string): Promise<void> => {
    setVersionsLoading(true)
    try {
      const rows = await listVersions(assetId, { limit: 50 })
      setAssetVersions(rows)
    } catch {
      setAssetVersions([])
    } finally {
      setVersionsLoading(false)
    }
  }, [listVersions])

  const openVersion = useCallback(async (assetId: string, version: AssetVersion, mode: 'diff' | 'content'): Promise<void> => {
    try {
      const [content, diff] = await Promise.all([
        readVersion(assetId, version.version_num),
        diffVersions(assetId, version.version_num).catch(() => null),
      ])
      setViewingVersion({ version, content, diff, mode, diffAgainst: undefined })
    } catch (err) {
      console.error('Failed to load version', err)
    }
  }, [readVersion, diffVersions])

  const changeDiffAgainst = useCallback(async (assetId: string, targetVersionNum: number | undefined): Promise<void> => {
    setViewingVersion((v) => (v ? { ...v, diffAgainst: targetVersionNum } : v))
    if (!viewingVersion) return
    try {
      const diff = await diffVersions(assetId, viewingVersion.version.version_num, targetVersionNum)
      setViewingVersion((v) => (v ? { ...v, diff } : v))
    } catch {
      setViewingVersion((v) => (v ? { ...v, diff: null } : v))
    }
  }, [diffVersions, viewingVersion])

  const handleCreateVersion = useCallback(async (assetId: string): Promise<void> => {
    try {
      await createVersion(assetId)
      await refreshVersions(assetId)
    } catch (err) {
      console.error('Create version failed', err)
    }
  }, [createVersion, refreshVersions])

  // Inline creation/rename state
  const [creating, setCreating] = useState<{ parentFolderId: string | null; type: 'file' | 'folder' } | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; type: 'asset' | 'folder' } | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const willCreateRef = useRef(false)
  const createInputRef = useCallback((node: HTMLInputElement | null) => {
    if (node) requestAnimationFrame(() => node.focus())
  }, [])
  const preventAutoFocus = useCallback((e: Event) => {
    if (willCreateRef.current) { e.preventDefault(); willCreateRef.current = false }
  }, [])
  const renameInputRef = useRef<HTMLInputElement>(null)

  // Expanded folders state — persisted in localStorage per task.
  // null sentinel = nothing persisted yet; auto-expand all once folders load.
  const expandedStorageKey = `slayzone:assets-panel:expanded:${taskId}`
  const [expandedFolders, setExpandedFolders] = useState<Set<string> | null>(() => {
    try {
      const raw = window.localStorage?.getItem(expandedStorageKey)
      if (raw) return new Set(JSON.parse(raw) as string[])
    } catch { /* ignore */ }
    return null
  })

  // Auto-expand all folders on first load when nothing was persisted
  useEffect(() => {
    if (expandedFolders === null && folders.length > 0) {
      setExpandedFolders(new Set(folders.map(f => f.id)))
    }
  }, [folders, expandedFolders])

  // Persist on change
  useEffect(() => {
    if (expandedFolders === null) return
    try {
      window.localStorage?.setItem(expandedStorageKey, JSON.stringify([...expandedFolders]))
    } catch { /* ignore */ }
  }, [expandedFolders, expandedStorageKey])

  // Focus create/rename inputs when they appear
  useEffect(() => { if (renaming) renameInputRef.current?.focus() }, [renaming])

  const selectedAsset = assets.find(a => a.id === selectedId) ?? null
  const selectedRenderMode = selectedAsset ? getEffectiveRenderMode(selectedAsset.title, selectedAsset.render_mode) : null
  const effectiveReadability: 'compact' | 'normal' = selectedAsset?.readability_override ?? notesReadability
  const effectiveWidth: 'narrow' | 'wide' = selectedAsset?.width_override ?? notesWidth

  useEffect(() => {
    const asset = assets.find(a => a.id === selectedId)
    setViewMode((asset?.view_mode as 'preview' | 'split' | 'raw') ?? assetDefaultViewMode)
    setZoomLevel(1); setFindOpen(false); setFindQuery(''); setFindActiveIndex(0); setFindMatchCount(0); setFindMatchCase(false); setFindUseRegex(false)
  }, [selectedId])

  // Reset active index when the search parameters change so the first match is the target
  useEffect(() => { setFindActiveIndex(0) }, [findQuery, findMatchCase, findUseRegex])

  // Reset match count when query clears — a blank query should show no matches
  useEffect(() => { if (!findQuery.trim()) setFindMatchCount(0) }, [findQuery])

  useImperativeHandle(ref, () => ({
    selectAsset: (id: string) => setSelectedId(id),
    createAsset: () => setCreating({ parentFolderId: null, type: 'file' }),
    toggleSearch: () => setSidebarMode(m => m === 'search' ? 'tree' : 'search'),
  }), [setSelectedId])

  // --- Inline create/rename handlers ---

  const handleInlineCreate = useCallback((value: string) => {
    if (!creating) return
    const name = value.trim()
    if (!name) { setCreating(null); return }
    if (creating.type === 'file') {
      createAsset({ title: name, folderId: creating.parentFolderId })
    } else {
      createFolder({ name, parentId: creating.parentFolderId })
    }
    setCreating(null)
  }, [creating, createAsset, createFolder])

  const handleInlineRename = useCallback((value: string) => {
    if (!renaming) return
    const name = value.trim()
    if (!name) { setRenaming(null); return }
    if (renaming.type === 'asset') {
      renameAsset(renaming.id, name)
    } else {
      renameFolder(renaming.id, name)
    }
    setRenaming(null)
  }, [renaming, renameAsset, renameFolder])

  const startRenameAsset = useCallback((asset: TaskAsset) => {
    setRenaming({ id: asset.id, type: 'asset' })
    setRenameValue(asset.title)
  }, [])

  const startRenameFolder = useCallback((folder: AssetFolder) => {
    setRenaming({ id: folder.id, type: 'folder' })
    setRenameValue(folder.name)
  }, [])

  // --- Upload / drop ---

  const handleUpload = useCallback(async () => {
    const result = await window.api.dialog.showOpenDialog({
      title: 'Upload Asset',
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled || !result.filePaths.length) return
    for (const filePath of result.filePaths) {
      await uploadAsset(filePath)
    }
  }, [uploadAsset])

  const handleFileDrop = useCallback(async (e: DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (dragAssetIdRef.current) return
    const filePaths = window.api.files.getDropPaths()
    for (const fp of filePaths) {
      try {
        await uploadDir(fp)
      } catch {
        await uploadAsset(fp)
      }
    }
  }, [uploadAsset, uploadDir])

  // --- Drag-to-folder handlers ---

  const handleAssetDragStart = useCallback((assetId: string) => (e: React.DragEvent) => {
    dragAssetIdRef.current = assetId
    e.dataTransfer.setData('text/plain', assetId)
    e.dataTransfer.effectAllowed = 'move'
  }, [])

  const handleFolderDragOver = useCallback((folderId: string) => (e: React.DragEvent) => {
    if (!dragAssetIdRef.current) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    setDropTargetFolder(folderId)
  }, [])

  const handleFolderDragLeave = useCallback(() => {
    setDropTargetFolder(null)
  }, [])

  const handleFolderDrop = useCallback((folderId: string) => (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDropTargetFolder(null)
    const assetId = dragAssetIdRef.current
    dragAssetIdRef.current = null
    if (!assetId) return
    moveAssetToFolder(assetId, folderId)
  }, [moveAssetToFolder])

  const handleRootDragOver = useCallback((e: React.DragEvent) => {
    if (!dragAssetIdRef.current) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropTargetFolder('__root__')
  }, [])

  const handleRootDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDropTargetFolder(null)
    const assetId = dragAssetIdRef.current
    dragAssetIdRef.current = null
    if (!assetId) return
    moveAssetToFolder(assetId, null)
  }, [moveAssetToFolder])

  const handleDragEnd = useCallback(() => {
    dragAssetIdRef.current = null
    setDropTargetFolder(null)
  }, [])

  // --- Search handlers ---

  const handlePanelKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
      e.preventDefault()
      e.stopPropagation()
      const rm = selectedAsset ? getEffectiveRenderMode(selectedAsset.title, selectedAsset.render_mode) : null
      if (selectedAsset && rm && !isBinaryRenderMode(rm)) {
        setFindOpen(true)
        // Bump so the find bar pulls focus even when already open.
        setFindFocusToken(t => t + 1)
      }
    }
  }, [selectedAsset])

  const handleSearchResult = useCallback((assetId: string, payload: { query: string; matchCase: boolean; useRegex: boolean; matchIndex: number }) => {
    setSelectedId(assetId)
    setFindQuery(payload.query)
    setFindMatchCase(payload.matchCase)
    setFindUseRegex(payload.useRegex)
    // Force raw view. Rendered-preview views (Milkdown markdown, html/svg/
    // mermaid) index matches over rendered text and would diverge from the
    // sidebar's raw-text matchIndex — the source-text CodeMirror view is the
    // only one guaranteed to agree with the sidebar's indexing.
    setViewMode('raw')
    // Defer opening find bar + setting active index so the new asset content
    // loads and the view's match list is rebuilt before we try to scroll.
    setTimeout(() => {
      setFindOpen(true)
      setFindActiveIndex(payload.matchIndex)
    }, 50)
  }, [setSelectedId])

  const toggleFolder = useCallback((folderId: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev ?? [])
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }, [])

  // --- Build tree structure from folders + assets ---

  const { childFolders, assetsByFolder } = useMemo(() => {
    const cf = new Map<string | null, AssetFolder[]>()
    for (const f of folders) {
      const arr = cf.get(f.parent_id) ?? []
      arr.push(f)
      cf.set(f.parent_id, arr)
    }
    const ab = new Map<string | null, TaskAsset[]>()
    for (const a of assets) {
      const arr = ab.get(a.folder_id) ?? []
      arr.push(a)
      ab.set(a.folder_id, arr)
    }
    for (const arr of cf.values()) arr.sort((a, b) => a.name.localeCompare(b.name))
    for (const arr of ab.values()) arr.sort((a, b) => a.title.localeCompare(b.title))
    return { childFolders: cf, assetsByFolder: ab }
  }, [folders, assets])

  // --- "Move to" folder list for context menu ---

  const moveToFolders = useMemo(() => {
    return folders.map(f => ({ id: f.id, name: f.name, path: folderPathMap.get(f.id) ?? f.name }))
  }, [folders, folderPathMap])

  // --- Copy path ---

  const handleCopyPath = useCallback(async (assetId: string) => {
    const fp = await getFilePath(assetId)
    if (fp) navigator.clipboard.writeText(fp)
  }, [getFilePath])

  // --- Render inline input ---

  const renderInlineInput = (parentFolderId: string | null, depth: number) => {
    if (!creating || creating.parentFolderId !== parentFolderId) return null
    return (
      <div style={{ paddingLeft: depth * INDENT_PX + BASE_PAD }} className="flex items-center gap-1.5 py-0.5">
        {creating.type === 'file'
          ? <FileText className="size-4 shrink-0 text-muted-foreground" />
          : <Folder className="size-4 shrink-0 text-amber-500/80" />}
        <Input
          ref={createInputRef}
          data-testid="assets-create-input"
          placeholder={creating.type === 'file' ? 'filename.md' : 'folder name'}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleInlineCreate((e.target as HTMLInputElement).value)
            if (e.key === 'Escape') setCreating(null)
          }}
          onBlur={(e) => { const v = (e.target as HTMLInputElement).value.trim(); if (v) handleInlineCreate(v) }}
          className="h-6 text-xs font-mono py-0 px-1 border-0 focus-visible:ring-0 shadow-none"
        />
      </div>
    )
  }

  // --- Recursive tree renderer ---

  const renderTree = (parentId: string | null, depth: number) => {
    const subFolders = childFolders.get(parentId) ?? []
    const subAssets = assetsByFolder.get(parentId) ?? []

    return (
      <>
        {subFolders.map(folder => {
          const expanded = expandedFolders?.has(folder.id) ?? true
          const isDropTarget = dropTargetFolder === folder.id
          const isRenaming = renaming?.id === folder.id && renaming.type === 'folder'

          return (
            <div
              key={`d:${folder.id}`}
              data-testid={`folder-row-${folder.id}`}
              className={cn(isDropTarget && 'bg-primary/10 ring-1 ring-primary/30 rounded')}
              onDragOver={handleFolderDragOver(folder.id)}
              onDragLeave={handleFolderDragLeave}
              onDrop={handleFolderDrop(folder.id)}
            >
              <div style={{ marginLeft: depth * INDENT_PX + BASE_PAD, marginRight: 4 }} className="mb-1">
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <button
                    className="group/folder flex w-full select-none items-center gap-1.5 rounded-md border border-border/60 bg-card/50 px-2.5 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 hover:border-border transition-colors"
                    onClick={() => toggleFolder(folder.id)}
                  >
                    {expanded
                      ? <FolderOpen className="size-4 shrink-0 text-amber-400" />
                      : <Folder className="size-4 shrink-0 text-amber-500/80" />}
                    {isRenaming ? (
                      <Input
                        ref={renameInputRef}
                        data-testid="assets-rename-input"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          e.stopPropagation()
                          if (e.key === 'Enter') handleInlineRename(renameValue)
                          if (e.key === 'Escape') setRenaming(null)
                        }}
                        onBlur={() => handleInlineRename(renameValue)}
                        onClick={(e) => e.stopPropagation()}
                        className="h-5 text-xs font-mono py-0 px-1 flex-1"
                      />
                    ) : (
                      <span className="truncate font-mono flex-1 text-left">{folder.name}</span>
                    )}
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent onCloseAutoFocus={preventAutoFocus}>
                  <ContextMenuItem onSelect={() => { willCreateRef.current = true; setCreating({ parentFolderId: folder.id, type: 'file' }) }}>
                    <FilePlus className="size-3 mr-2" /> New Asset
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => { willCreateRef.current = true; setCreating({ parentFolderId: folder.id, type: 'folder' }) }}>
                    <FolderPlus className="size-3 mr-2" /> New Folder
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => startRenameFolder(folder)}>
                    <Pencil className="size-3 mr-2" /> Rename
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => downloadFolder(folder.id)}>
                    <Download className="size-3 mr-2" /> Download
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem variant="destructive" onSelect={() => deleteFolder(folder.id)}>
                    <Trash2 className="size-3 mr-2" /> Delete
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
              </div>

              {expanded && (
                <>
                  {renderTree(folder.id, depth + 1)}
                  {renderInlineInput(folder.id, depth + 1)}
                </>
              )}
            </div>
          )
        })}

        {subAssets.length > 0 && (
          <div className="flex flex-col gap-1 py-0.5">
            {subAssets.map(asset => {
              const TypeIcon = getAssetIcon(asset)
              const isRenaming = renaming?.id === asset.id && renaming.type === 'asset'
              const ext = getExtensionFromTitle(asset.title).replace('.', '').toUpperCase()
              const effectiveMode = getEffectiveRenderMode(asset.title, asset.render_mode)
              const modeLabel = RENDER_MODE_INFO[effectiveMode].label

              return (
                <div key={`f:${asset.id}`} data-testid={`asset-row-${asset.id}`} style={{ marginLeft: depth * INDENT_PX + BASE_PAD, marginRight: 4 }}>
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <button
                        className={cn(
                          'group/asset flex w-full flex-col gap-0.5 rounded-md border px-2.5 py-2 text-left text-xs cursor-pointer transition-colors',
                          asset.id === selectedId
                            ? 'border-primary/40 bg-primary/[0.08] text-foreground'
                            : 'border-border/60 bg-card/50 text-muted-foreground hover:text-foreground hover:bg-muted/50 hover:border-border',
                        )}
                        onClick={() => setSelectedId(asset.id)}
                        draggable={!isRenaming}
                        onDragStart={handleAssetDragStart(asset.id)}
                      >
                        <div className="flex w-full items-center gap-1.5 min-w-0">
                          <TypeIcon className="size-4 shrink-0" />
                          {isRenaming ? (
                            <Input
                              ref={renameInputRef}
                              data-testid="assets-rename-input"
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              onKeyDown={(e) => {
                                e.stopPropagation()
                                if (e.key === 'Enter') handleInlineRename(renameValue)
                                if (e.key === 'Escape') setRenaming(null)
                              }}
                              onBlur={() => handleInlineRename(renameValue)}
                              onClick={(e) => e.stopPropagation()}
                              className="h-5 text-xs font-mono py-0 px-1 flex-1"
                            />
                          ) : (
                            <span className="truncate flex-1 font-medium">{asset.title}</span>
                          )}
                          {ext && !isRenaming && (
                            <span className="shrink-0 rounded bg-muted px-1 py-px text-[10px] font-mono text-muted-foreground">{ext}</span>
                          )}
                        </div>
                        {!isRenaming && (
                          <div className="flex items-center gap-1.5 pl-[22px] text-[10px] text-muted-foreground/70">
                            <span>{modeLabel}</span>
                            <span className="text-muted-foreground/40">&middot;</span>
                            <span>{formatRelativeDate(asset.updated_at)}</span>
                          </div>
                        )}
                      </button>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onSelect={() => startRenameAsset(asset)}>
                        <Pencil className="size-3 mr-2" /> Rename
                      </ContextMenuItem>
                      {moveToFolders.length > 0 && (
                        <ContextMenuSub>
                          <ContextMenuSubTrigger>
                            <ArrowRight className="size-3 mr-2" /> Move to
                          </ContextMenuSubTrigger>
                          <ContextMenuSubContent>
                            {asset.folder_id && (
                              <ContextMenuItem onSelect={() => moveAssetToFolder(asset.id, null)}>
                                Root
                              </ContextMenuItem>
                            )}
                            {moveToFolders
                              .filter(f => f.id !== asset.folder_id)
                              .map(f => (
                                <ContextMenuItem key={f.id} onSelect={() => moveAssetToFolder(asset.id, f.id)}>
                                  {f.path}
                                </ContextMenuItem>
                              ))
                            }
                          </ContextMenuSubContent>
                        </ContextMenuSub>
                      )}
                      <ContextMenuSeparator />
                      <ContextMenuItem onSelect={() => handleCopyPath(asset.id)}>
                        <Copy className="size-3 mr-2" /> Copy Path
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem onSelect={() => downloadFile(asset.id)}>
                        <Download className="size-3 mr-2" /> Download
                      </ContextMenuItem>
                      {(canExportAsPdf(effectiveMode) || canExportAsPng(effectiveMode) || canExportAsHtml(effectiveMode)) && (
                        <ContextMenuSub>
                          <ContextMenuSubTrigger>
                            <Download className="size-3 mr-2" /> Download as
                          </ContextMenuSubTrigger>
                          <ContextMenuSubContent>
                            {canExportAsPdf(effectiveMode) && (
                              <ContextMenuItem onSelect={() => downloadAsPdf(asset.id)}>
                                <FileText className="size-3 mr-2" /> PDF
                              </ContextMenuItem>
                            )}
                            {canExportAsPng(effectiveMode) && (
                              <ContextMenuItem onSelect={() => downloadAsPng(asset.id)}>
                                <ImageDown className="size-3 mr-2" /> PNG
                              </ContextMenuItem>
                            )}
                            {canExportAsHtml(effectiveMode) && (
                              <ContextMenuItem onSelect={() => downloadAsHtml(asset.id)}>
                                <FileCode className="size-3 mr-2" /> HTML
                              </ContextMenuItem>
                            )}
                          </ContextMenuSubContent>
                        </ContextMenuSub>
                      )}
                      <ContextMenuSeparator />
                      <ContextMenuItem variant="destructive" onSelect={() => deleteAsset(asset.id)}>
                        <Trash2 className="size-3 mr-2" /> Delete
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                </div>
              )
            })}
          </div>
        )}
      </>
    )
  }

  // Sidebar resize
  const DEFAULT_SIDEBAR_WIDTH = 300
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH)
  const [sidebarDragging, setSidebarDragging] = useState(false)
  const sidebarDrag = useRef<{ startX: number; startW: number } | null>(null)

  const handleSidebarMouseDown = useCallback((e: React.MouseEvent) => {
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
  }, [sidebarWidth])

  return (
    <div
      className={cn("relative flex flex-col h-full", dragOver && "ring-2 ring-primary/50 ring-inset")}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
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
        <div className={cn("flex items-center border-b border-border shrink-0", sidebarVisible && "grid grid-cols-[auto_1fr]")}>
          {/* Top-left: label + mode toggles */}
          {sidebarVisible && (
            <div className="flex items-center gap-1 px-2 h-10 border-r border-border bg-surface-1" style={{ width: sidebarWidth }}>
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide mr-auto">Assets</span>
              <div className="ml-auto flex items-center gap-0.5">
                {([
                  { mode: 'tree' as const, icon: Files, label: 'Explorer' },
                  { mode: 'search' as const, icon: Search, label: 'Search' },
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
            </div>
          )}
          {/* Top-right: action buttons + asset controls */}
          <div className="flex items-center gap-1.5 px-3 py-1.5 flex-1">
            <button
              className="flex items-center justify-center size-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
              onClick={() => setSidebarVisible(v => !v)}
              title={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
            >
              {sidebarVisible ? <PanelLeftClose className="size-4" /> : <PanelLeft className="size-4" />}
            </button>
            {selectedAsset && (
              <>
                <div className="flex items-center gap-3 text-[10px] text-muted-foreground ml-1">
                  {assetStats.fileSize != null && <span><span className="text-muted-foreground/60">Size:</span> {formatFileSize(assetStats.fileSize)}</span>}
                  {!isBinaryRenderMode(selectedRenderMode!) && (
                    <>
                      <span><span className="text-muted-foreground/60">Words:</span> {assetStats.words}</span>
                      <span><span className="text-muted-foreground/60">Lines:</span> {assetStats.lines}</span>
                    </>
                  )}
                </div>
              </>
            )}
            <div className="flex-1" />
            {selectedAsset && selectedRenderMode && (
              <div className="flex items-center gap-1.5">
                {hasZoom(selectedRenderMode) && (
                  <div className="flex items-center gap-1 bg-surface-3 rounded-lg p-1">
                    <button type="button" className="size-6 flex items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-foreground" onClick={() => setZoomLevel(z => Math.max(0.25, z - 0.25))}><ZoomOut className="size-3.5" /></button>
                    <button type="button" className="text-[10px] text-muted-foreground hover:text-foreground min-w-[3ch] text-center" onClick={() => setZoomLevel(1)}>{Math.round(zoomLevel * 100)}%</button>
                    <button type="button" className="size-6 flex items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-foreground" onClick={() => setZoomLevel(z => Math.min(4, z + 0.25))}><ZoomIn className="size-3.5" /></button>
                  </div>
                )}
                {selectedRenderMode === 'markdown' && viewMode !== 'raw' && (
                  <>
                    <div className={TOGGLE_PILL_CLASS}>
                      <IconToggleButton
                        icon={effectiveReadability === 'compact' ? Rows2 : Rows3}
                        active={effectiveReadability === 'compact'}
                        onClick={() => {
                          const next = effectiveReadability === 'compact' ? 'normal' : 'compact'
                          const override = next === notesReadability ? null : next
                          updateAsset({ id: selectedAsset.id, readabilityOverride: override })
                        }}
                        tooltip={`Readability: ${effectiveReadability === 'compact' ? 'Compact' : 'Normal'}${selectedAsset.readability_override ? ' (override)' : ''}`}
                      />
                    </div>
                    <div className={TOGGLE_PILL_CLASS}>
                      <IconToggleButton
                        icon={effectiveWidth === 'wide' ? Maximize2 : AlignCenter}
                        active={effectiveWidth === 'wide'}
                        onClick={() => {
                          const next = effectiveWidth === 'wide' ? 'narrow' : 'wide'
                          const override = next === notesWidth ? null : next
                          updateAsset({ id: selectedAsset.id, widthOverride: override })
                        }}
                        tooltip={`Width: ${effectiveWidth === 'wide' ? 'Wide' : 'Narrow'}${selectedAsset.width_override ? ' (override)' : ''}`}
                      />
                    </div>
                  </>
                )}
                {hasPreviewToggle(selectedRenderMode) && (
                  <div className={TOGGLE_PILL_CLASS}>
                    {([
                      { mode: 'preview' as const, icon: Eye, title: 'Preview' },
                      { mode: 'split' as const, icon: Columns2, title: 'Split view' },
                      { mode: 'raw' as const, icon: Code2, title: 'Raw' },
                    ]).map(({ mode, icon, title }) => (
                      <IconToggleButton
                        key={mode}
                        icon={icon}
                        active={viewMode === mode}
                        onClick={() => { setViewMode(mode); updateAsset({ id: selectedAsset.id, viewMode: mode }) }}
                        tooltip={title}
                      />
                    ))}
                  </div>
                )}
                <Select
                  value={selectedAsset.render_mode ?? '__auto__'}
                  onValueChange={(v) => updateAsset({ id: selectedAsset.id, renderMode: v === '__auto__' ? null : v as RenderMode })}
                >
                  <SelectTrigger size="sm" className="!h-7 text-xs w-auto min-w-0 gap-1.5 px-2.5 shrink-0"><SelectValue /></SelectTrigger>
                  <SelectContent position="popper" side="bottom" className="max-h-none overflow-y-visible">
                    <SelectItem value="__auto__">Auto ({RENDER_MODE_INFO[getEffectiveRenderMode(selectedAsset.title, null)].label})</SelectItem>
                    {(Object.keys(RENDER_MODE_INFO) as RenderMode[]).map((mode) => (
                      <SelectItem key={mode} value={mode}>{RENDER_MODE_INFO[mode].label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {selectedAsset && selectedRenderMode && (() => {
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
                    <Button variant="outline" size="sm" className="!h-7 px-1.5 shrink-0" title="Download">
                      <Download className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => downloadFile(selectedAsset.id)}>
                      <Download className="size-3 mr-2" /> Download
                    </DropdownMenuItem>
                    {hasExport && (
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                          <Download className="size-3 mr-2" /> Download as
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                          {hasPdf && (
                            <DropdownMenuItem onSelect={() => downloadAsPdf(selectedAsset.id)}>
                              <FileText className="size-3 mr-2" /> PDF
                            </DropdownMenuItem>
                          )}
                          {hasPng && (
                            <DropdownMenuItem onSelect={() => downloadAsPng(selectedAsset.id)}>
                              <ImageDown className="size-3 mr-2" /> PNG
                            </DropdownMenuItem>
                          )}
                          {hasHtml && (
                            <DropdownMenuItem onSelect={() => downloadAsHtml(selectedAsset.id)}>
                              <FileCode className="size-3 mr-2" /> HTML
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    )}
                    {assets.length > 0 && (
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
                    if (!selectedAsset) return
                    setVersionsDialogOpen(true)
                    void refreshVersions(selectedAsset.id)
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
          <div className="shrink-0 flex flex-col border-r border-border" style={{ width: sidebarWidth }}>
            {sidebarMode === 'search' ? (
              <AssetSearchPanel
                assets={assets}
                readContent={readContent}
                getAssetPath={getAssetPath}
                onSelectResult={handleSearchResult}
              />
            ) : (
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <div
                    data-testid="assets-sidebar"
                    className={cn("flex-1 overflow-y-auto p-1.5 select-none text-sm", dropTargetFolder === '__root__' && 'bg-primary/10')}
                    onDragOver={handleRootDragOver}
                    onDragLeave={handleFolderDragLeave}
                    onDrop={handleRootDrop}
                  >
                    {assets.length > 0 || folders.length > 0 ? (
                      <>
                        {renderTree(null, 0)}
                        {renderInlineInput(null, 0)}
                      </>
                    ) : creating ? (
                      renderInlineInput(null, 0)
                    ) : (
                      <div className="text-[10px] text-muted-foreground/60 text-center py-4">
                        No assets yet
                      </div>
                    )}
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent onCloseAutoFocus={preventAutoFocus}>
                  <ContextMenuItem onSelect={() => { willCreateRef.current = true; setCreating({ parentFolderId: null, type: 'file' }) }}>
                    <FilePlus className="size-3 mr-2" /> New Asset
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => { willCreateRef.current = true; setCreating({ parentFolderId: null, type: 'folder' }) }}>
                    <FolderPlus className="size-3 mr-2" /> New Folder
                  </ContextMenuItem>
                  {assets.length > 0 && (
                    <>
                      <ContextMenuSeparator />
                      <ContextMenuItem onSelect={() => downloadAllAsZip()}>
                        <Archive className="size-3 mr-2" /> Download all as ZIP
                      </ContextMenuItem>
                    </>
                  )}
                </ContextMenuContent>
              </ContextMenu>
            )}
            <div className="flex items-center gap-1.5 px-2 py-2 border-t border-border shrink-0 overflow-hidden">
              <Button data-testid="assets-new-btn" variant="outline" size="sm" className={cn("!h-7 text-[10px] flex-1 min-w-0", sidebarWidth < 180 ? "px-0 justify-center" : "px-2")} onClick={() => setCreating({ parentFolderId: null, type: 'file' })} title="New file">
                <FilePlus className="size-3 shrink-0" />
                {sidebarWidth >= 180 && <span className="ml-1 truncate">New</span>}
              </Button>
              <Button data-testid="assets-folder-btn" variant="outline" size="sm" className={cn("!h-7 text-[10px] flex-1 min-w-0", sidebarWidth < 180 ? "px-0 justify-center" : "px-2")} onClick={() => setCreating({ parentFolderId: null, type: 'folder' })} title="New folder">
                <FolderPlus className="size-3 shrink-0" />
                {sidebarWidth >= 180 && <span className="ml-1 truncate">Folder</span>}
              </Button>
              <Button data-testid="assets-upload-btn" variant="outline" size="sm" className={cn("!h-7 text-[10px] flex-1 min-w-0", sidebarWidth < 180 ? "px-0 justify-center" : "px-2")} onClick={handleUpload} title="Upload file">
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
          {findOpen && selectedAsset && selectedRenderMode && !isBinaryRenderMode(selectedRenderMode) && (
            <AssetFindBar
              query={findQuery}
              onQueryChange={setFindQuery}
              onClose={() => { setFindOpen(false); setFindQuery(''); setFindActiveIndex(0) }}
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
          {selectedAsset ? (
            <>
              <AssetContentEditor
                key={selectedAsset.id}
                asset={selectedAsset}
                viewMode={viewMode}
                zoomLevel={zoomLevel}
                onZoom={(fn) => setZoomLevel(fn)}
                readContent={readContent}
                saveContent={saveContent}
                getFilePath={getFilePath}
                onStats={setAssetStats}
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
              {assets.length > 0 ? 'Select an asset' : 'Create an asset to get started'}
            </div>
          )}
        </div>
      </div>
      <AssetVersionsDialog
        open={versionsDialogOpen}
        onOpenChange={setVersionsDialogOpen}
        versions={assetVersions}
        currentVersionId={selectedAsset?.current_version_id ?? null}
        loading={versionsLoading}
        onSetCurrent={async (ref) => {
          if (!selectedAsset) return
          try {
            await setCurrentVersion(selectedAsset.id, ref)
            await refreshVersions(selectedAsset.id)
          } catch (err) {
            toast.error(`Failed to set current: ${err instanceof Error ? err.message : String(err)}`)
          }
        }}
        onRename={async (ref, newName) => {
          if (!selectedAsset) return
          await renameVersion(selectedAsset.id, ref, newName)
          await refreshVersions(selectedAsset.id)
        }}
        onOpenPreview={(v) => {
          if (!selectedAsset) return
          void openVersion(selectedAsset.id, v, 'content')
        }}
        onDiff={(v) => {
          if (!selectedAsset) return
          void openVersion(selectedAsset.id, v, 'diff')
        }}
        onCreateVersion={async () => {
          if (!selectedAsset) return
          await handleCreateVersion(selectedAsset.id)
        }}
      />
      <Dialog open={viewingVersion !== null} onOpenChange={(open) => { if (!open) setViewingVersion(null) }}>
        <DialogContent className={viewingVersion?.mode === 'diff' ? 'max-w-5xl' : 'max-w-3xl'}>
          <DialogHeader>
            <DialogTitle>
              v{viewingVersion?.version.version_num}
              {viewingVersion?.version.name ? ` · ${viewingVersion.version.name}` : ''}
            </DialogTitle>
            <DialogDescription>
              {viewingVersion ? new Date(viewingVersion.version.created_at).toLocaleString() : ''}
              {viewingVersion ? ` · ${viewingVersion.version.size} bytes · ${viewingVersion.version.content_hash.slice(0, 8)}` : ''}
            </DialogDescription>
          </DialogHeader>
          {viewingVersion && viewingVersion.mode === 'diff' && viewingVersion.diff ? (
            <AssetVersionDiffView diff={viewingVersion.diff} />
          ) : (
            <pre className="font-mono text-xs whitespace-pre-wrap break-words bg-muted p-3 rounded max-h-[60vh] overflow-auto">
              {viewingVersion?.content}
            </pre>
          )}
          <DialogFooter className="sm:justify-between">
            {viewingVersion?.diff ? (
              <div className="flex items-center gap-2">
                <Tabs
                  value={viewingVersion.mode}
                  onValueChange={(val) =>
                    setViewingVersion((v) => (v ? { ...v, mode: val as 'diff' | 'content' } : v))
                  }
                >
                  <TabsList className="h-8">
                    <TabsTrigger
                      value="diff"
                      className="text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:border-transparent"
                    >
                      Diff
                    </TabsTrigger>
                    <TabsTrigger
                      value="content"
                      className="text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:border-transparent"
                    >
                      Full
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
                {viewingVersion.mode === 'diff' && (
                  <Select
                    value={viewingVersion.diffAgainst === undefined ? '__current__' : String(viewingVersion.diffAgainst)}
                    onValueChange={(val) => {
                      if (!selectedAsset) return
                      const num = val === '__current__' ? undefined : Number(val)
                      void changeDiffAgainst(selectedAsset.id, num)
                    }}
                  >
                    <SelectTrigger size="sm" className="text-xs w-[160px]">
                      <SelectValue placeholder="vs…" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__current__">vs current</SelectItem>
                      {assetVersions
                        .filter((v) => v.version_num !== viewingVersion.version.version_num)
                        .map((v) => (
                          <SelectItem key={v.id} value={String(v.version_num)}>
                            vs v{v.version_num}{v.name ? ` · ${v.name}` : ''}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            ) : <span />}
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setViewingVersion(null)}>Close</Button>
              <Button
                size="sm"
                disabled={!viewingVersion || viewingVersion.version.id === (selectedAsset?.current_version_id ?? null)}
                onClick={async () => {
                  if (!viewingVersion || !selectedAsset) return
                  try {
                    await setCurrentVersion(selectedAsset.id, viewingVersion.version.version_num)
                    await refreshVersions(selectedAsset.id)
                    setViewingVersion(null)
                  } catch (err) {
                    toast.error(`Failed to set current: ${err instanceof Error ? err.message : String(err)}`)
                  }
                }}
              >
                Set as current
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
})
