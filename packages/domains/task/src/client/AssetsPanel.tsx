import { useState, useEffect, useCallback, useRef, useImperativeHandle, forwardRef, useMemo, type CSSProperties, type DragEvent } from 'react'
import { Upload, Download, Trash2, FileText, Code, Globe, Image, GitBranch, Eye, Code2, Columns2, ZoomIn, ZoomOut, FolderPlus, Pencil, FilePlus, FolderOpen, Folder, ArrowRight, Copy, Search, Files, PanelLeftClose, PanelLeft, ChevronDown, ImageDown, FileCode, Archive } from 'lucide-react'
import {
  cn, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, PanelToggle, Button, Input,
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent,
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent,
  Tooltip, TooltipTrigger, TooltipContent, TooltipProvider,
} from '@slayzone/ui'
import { RichTextEditor, noteVariant } from '@slayzone/editor'
import type { RenderMode, TaskAsset, AssetFolder } from '@slayzone/task/shared'
import { getEffectiveRenderMode, getExtensionFromTitle, RENDER_MODE_INFO, isBinaryRenderMode, canExportAsPdf, canExportAsPng, canExportAsHtml } from '@slayzone/task/shared'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useAppearance, getThemeEditorColors, type EditorThemeColors } from '@slayzone/ui'
import { useTheme } from '@slayzone/settings/client'
import { useAssets } from './useAssets'
import { AssetFindBar } from './AssetFindBar'
import { AssetSearchPanel } from './AssetSearchPanel'

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

// --- Image viewer ---

function ImageViewer({ assetId, updatedAt, zoomLevel, onZoom, getFilePath }: { assetId: string; updatedAt: string; zoomLevel: number; onZoom: (fn: (z: number) => number) => void; getFilePath: (id: string) => Promise<string | null> }) {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    getFilePath(assetId).then((p) => {
      if (p) setSrc(`slz-file://${p}?v=${encodeURIComponent(updatedAt)}`)
    })
  }, [assetId, updatedAt, getFilePath])

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

function PdfViewer({ assetId, updatedAt, getFilePath }: { assetId: string; updatedAt: string; getFilePath: (id: string) => Promise<string | null> }) {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    getFilePath(assetId).then((p) => {
      if (p) setSrc(`slz-file://${p}?v=${encodeURIComponent(updatedAt)}`)
    })
  }, [assetId, updatedAt, getFilePath])

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

function AssetContentEditor({ asset, viewMode, zoomLevel, onZoom, readContent, saveContent, getFilePath, onStats, onContentReady, scrollToLineRef }: {
  asset: TaskAsset
  viewMode: 'preview' | 'split' | 'raw'
  zoomLevel: number
  onZoom: (fn: (z: number) => number) => void
  readContent: (id: string) => Promise<string | null>
  saveContent: (id: string, content: string) => Promise<void>
  getFilePath: (id: string) => Promise<string | null>
  onStats?: (stats: AssetStats) => void
  onContentReady?: (content: string) => void
  scrollToLineRef?: React.MutableRefObject<((line: number) => void) | null>
}) {
  const { notesFontFamily, notesLineSpacing, notesCheckedHighlight, notesShowToolbar, notesSpellcheck } = useAppearance()
  const variant = noteVariant(notesLineSpacing)
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
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const contentRef = useRef(content)
  const onStatsRef = useRef(onStats)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  contentRef.current = content
  onStatsRef.current = onStats

  const renderMode = getEffectiveRenderMode(asset.title, asset.render_mode)
  const isBinary = isBinaryRenderMode(renderMode)

  useEffect(() => {
    const text = content ?? ''
    const words = text.trim() ? text.trim().split(/\s+/).length : 0
    const lines = text ? text.split('\n').length : 0
    window.api.assets.getFileSize(asset.id).then((size) => {
      onStatsRef.current?.({ fileSize: size, words, lines })
    })
  }, [content, asset.id])

  useEffect(() => {
    if (isBinary) {
      setLoading(false)
      window.api.assets.getFileSize(asset.id).then((size) => {
        onStatsRef.current?.({ fileSize: size, words: 0, lines: 0 })
      })
      return
    }
    setLoading(true)
    readContent(asset.id).then((c) => {
      setContent(c ?? '')
      setLoading(false)
    })
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        if (contentRef.current !== null) saveContent(asset.id, contentRef.current)
      }
    }
  }, [asset.id, isBinary, readContent, saveContent])

  // Re-read content when asset is updated externally (e.g. CLI write/append)
  const prevUpdatedAtRef = useRef(asset.updated_at)
  useEffect(() => {
    if (prevUpdatedAtRef.current === asset.updated_at) return
    prevUpdatedAtRef.current = asset.updated_at
    if (isBinary || saveTimerRef.current) return
    readContent(asset.id).then((c) => setContent(c ?? ''))
  }, [asset.updated_at, asset.id, isBinary, readContent])

  // Notify parent of content changes for find bar
  useEffect(() => {
    if (content != null) onContentReady?.(content)
  }, [content, onContentReady])

  // Register scroll-to-line for find bar
  useEffect(() => {
    if (!scrollToLineRef) return
    scrollToLineRef.current = (line: number) => {
      const ta = textareaRef.current
      if (!ta) return
      const lineHeight = ta.scrollHeight / Math.max(1, (content ?? '').split('\n').length)
      ta.scrollTop = Math.max(0, (line - 3) * lineHeight)
    }
    return () => { scrollToLineRef.current = null }
  }, [scrollToLineRef, content])

  const handleChange = useCallback((value: string) => {
    setContent(value)
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      saveContent(asset.id, value)
    }, 500)
  }, [asset.id, saveContent])

  if (loading) return <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">Loading...</div>
  if (renderMode === 'image') return <ImageViewer assetId={asset.id} updatedAt={asset.updated_at} zoomLevel={zoomLevel} onZoom={onZoom} getFilePath={getFilePath} />
  if (renderMode === 'pdf') return <PdfViewer assetId={asset.id} updatedAt={asset.updated_at} getFilePath={getFilePath} />

  const hasPreview = renderMode === 'markdown' || renderMode === 'html-preview' || renderMode === 'svg-preview' || renderMode === 'mermaid-preview'

  if (renderMode === 'markdown' && viewMode === 'preview') {
    return (
      <div className="flex-1 overflow-y-auto">
        <RichTextEditor value={content ?? ''} onChange={handleChange} placeholder="Write markdown..." variant={variant} fontFamily={notesFontFamily} checkedHighlight={notesCheckedHighlight} showToolbar={notesShowToolbar} spellcheck={notesSpellcheck} themeColors={themeColors} />
      </div>
    )
  }

  if (renderMode === 'markdown' && viewMode === 'split') {
    return (
      <div className="flex-1 flex flex-row overflow-hidden">
        <textarea ref={textareaRef} value={content ?? ''} onChange={(e) => handleChange(e.target.value)} className="flex-1 bg-transparent text-xs font-mono p-3 resize-none outline-none min-w-0" placeholder="Write markdown..." spellCheck={false} />
        <div className="flex-1 border-l border-border min-w-0 min-h-0">
          <div className="mk-doc" data-variant={variant} style={themeStyle}>
            <div className="mk-doc-scroll">
              <div className="mk-doc-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{content ?? ''}</ReactMarkdown>
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
        <textarea ref={textareaRef} value={content ?? ''} onChange={(e) => handleChange(e.target.value)} className="flex-1 bg-transparent text-xs font-mono p-3 resize-none outline-none min-w-0" placeholder={`Write ${getExtensionFromTitle(asset.title) || 'content'}...`} spellCheck={false} />
        <div className="flex-1 flex flex-col border-l border-border overflow-hidden min-w-0">
          <AssetPreview renderMode={renderMode} content={content ?? ''} zoomLevel={zoomLevel} onZoom={onZoom} />
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <textarea ref={textareaRef} value={content ?? ''} onChange={(e) => handleChange(e.target.value)} className="flex-1 bg-transparent text-xs font-mono p-3 resize-none outline-none" placeholder={`Write ${getExtensionFromTitle(asset.title) || 'content'}...`} spellCheck={false} />
    </div>
  )
}

// --- Preview pane ---

function AssetPreview({ renderMode, content, zoomLevel = 1, onZoom }: { renderMode: RenderMode; content: string; zoomLevel?: number; onZoom?: (fn: (z: number) => number) => void }) {
  const [mermaidSvg, setMermaidSvg] = useState<string | null>(null)

  useEffect(() => {
    if (renderMode !== 'mermaid-preview' || !content.trim()) { setMermaidSvg(null); return }
    let cancelled = false
    import('mermaid').then(async (mod) => {
      const mermaid = mod.default
      mermaid.initialize({ startOnLoad: false, theme: 'dark' })
      try {
        const { svg } = await mermaid.render(`mermaid-preview-${Date.now()}`, content)
        if (!cancelled) setMermaidSvg(svg)
      } catch { if (!cancelled) setMermaidSvg(null) }
    }).catch(() => {})
    return () => { cancelled = true }
  }, [renderMode, content])

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!e.metaKey && !e.ctrlKey) return
    e.preventDefault()
    onZoom?.(z => Math.min(4, Math.max(0.25, z + (e.deltaY > 0 ? -0.1 : 0.1))))
  }, [onZoom])

  if (renderMode === 'html-preview') return <iframe srcDoc={content} sandbox="allow-scripts" className="flex-1 bg-white" title="HTML preview" />

  const zoomStyle = zoomLevel !== 1 ? { transform: `scale(${zoomLevel})`, transformOrigin: 'top left' } : undefined

  if (renderMode === 'svg-preview') return <div className="flex-1 p-4 overflow-auto" onWheel={handleWheel}><div style={zoomStyle} dangerouslySetInnerHTML={{ __html: content }} /></div>
  if (renderMode === 'mermaid-preview' && mermaidSvg) return <div className="flex-1 p-4 overflow-auto" onWheel={handleWheel}><div style={zoomStyle} dangerouslySetInnerHTML={{ __html: mermaidSvg }} /></div>
  return null
}

// --- Main panel ---

export const AssetsPanel = forwardRef<AssetsPanelHandle, AssetsPanelProps>(function AssetsPanel({ taskId, isResizing, initialActiveAssetId, onActiveAssetIdChange }, ref) {
  const {
    assets, folders, selectedId, setSelectedId,
    createAsset, updateAsset, deleteAsset, renameAsset, moveAssetToFolder,
    readContent, saveContent, uploadAsset, uploadDir, getFilePath,
    downloadFile, downloadFolder, downloadAsPdf, downloadAsPng, downloadAsHtml, downloadAllAsZip,
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

  const { editorMarkdownViewMode } = useAppearance()
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
  const contentForFindRef = useRef<string>('')

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

  // Expanded folders state
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set())

  // Auto-expand all folders on first load
  useEffect(() => {
    if (folders.length > 0) {
      setExpandedFolders(prev => {
        const next = new Set(prev)
        for (const f of folders) next.add(f.id)
        return next
      })
    }
  }, [folders])

  // Focus create/rename inputs when they appear
  useEffect(() => { if (renaming) renameInputRef.current?.focus() }, [renaming])

  const selectedAsset = assets.find(a => a.id === selectedId) ?? null
  const selectedRenderMode = selectedAsset ? getEffectiveRenderMode(selectedAsset.title, selectedAsset.render_mode) : null

  useEffect(() => {
    const asset = assets.find(a => a.id === selectedId)
    setViewMode((asset?.view_mode as 'preview' | 'split' | 'raw') ?? assetDefaultViewMode)
    setZoomLevel(1); setFindOpen(false); setFindQuery('')
  }, [selectedId])

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
      }
    }
  }, [selectedAsset])

  const handleSearchResult = useCallback((assetId: string, query: string, _line: number) => {
    setSelectedId(assetId)
    setFindQuery(query)
    // Defer opening find bar so the new asset content loads first
    setTimeout(() => setFindOpen(true), 50)
  }, [setSelectedId])

  const scrollToLineRef = useRef<((line: number) => void) | null>(null)

  const toggleFolder = useCallback((folderId: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev)
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
          const expanded = expandedFolders.has(folder.id)
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
      className={cn("flex flex-col h-full", dragOver && "ring-2 ring-primary/50 ring-inset")}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleFileDrop}
      onDragEnd={handleDragEnd}
      onKeyDown={handlePanelKeyDown}
    >
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
                {hasPreviewToggle(selectedRenderMode) && (
                  <PanelToggle
                    variant="raised"
                    panels={[
                      { id: 'preview', icon: Eye, label: 'Preview', active: viewMode === 'preview' },
                      { id: 'split', icon: Columns2, label: 'Split', active: viewMode === 'split' },
                      { id: 'raw', icon: Code2, label: 'Raw', active: viewMode === 'raw' },
                    ]}
                    onChange={(id) => { const mode = id as 'preview' | 'split' | 'raw'; setViewMode(mode); if (selectedAsset) updateAsset({ id: selectedAsset.id, viewMode: mode }) }}
                  />
                )}
                <div className="bg-surface-3 rounded-lg p-1">
                  <Select
                    value={selectedAsset.render_mode ?? '__auto__'}
                    onValueChange={(v) => updateAsset({ id: selectedAsset.id, renderMode: v === '__auto__' ? null : v as RenderMode })}
                  >
                    <SelectTrigger size="sm" className="!h-7 text-xs w-auto min-w-0 gap-1.5 px-2.5 border-0 bg-transparent"><SelectValue /></SelectTrigger>
                    <SelectContent position="popper" side="bottom" className="max-h-none overflow-y-visible">
                      <SelectItem value="__auto__">Auto ({RENDER_MODE_INFO[getEffectiveRenderMode(selectedAsset.title, null)].label})</SelectItem>
                      {(Object.keys(RENDER_MODE_INFO) as RenderMode[]).map((mode) => (
                        <SelectItem key={mode} value={mode}>{RENDER_MODE_INFO[mode].label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
            {selectedAsset && selectedRenderMode && (() => {
              const mode = selectedRenderMode
              const hasPdf = canExportAsPdf(mode)
              const hasPng = canExportAsPng(mode)
              const hasHtml = canExportAsHtml(mode)
              const hasExport = hasPdf || hasPng || hasHtml

              return (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="!h-7 gap-1 px-1.5 shrink-0" title="Download">
                      <Download className="size-3.5" />
                      <ChevronDown className="size-3" />
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
              onClose={() => { setFindOpen(false); setFindQuery('') }}
              content={contentForFindRef.current}
              onScrollToLine={scrollToLineRef.current ?? undefined}
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
                onContentReady={(c) => { contentForFindRef.current = c }}
                scrollToLineRef={scrollToLineRef}
              />
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground/60">
              {assets.length > 0 ? 'Select an asset' : 'Create an asset to get started'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
})
