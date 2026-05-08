import { useState, useEffect, useCallback, useRef, useImperativeHandle, forwardRef, useMemo, type CSSProperties, type DragEvent } from 'react'
import { Upload, Download, Trash2, FileText, Code, Globe, Image, GitBranch, Eye, Code2, Columns2, FolderPlus, Pencil, FilePlus, FolderOpen, Folder, ArrowRight, Copy, Search, Files, PanelLeftClose, PanelLeft, ImageDown, FileCode, Archive, History, Scissors, ClipboardPaste, CopyPlus, SlidersHorizontal } from 'lucide-react'
import {
  cn, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Button, Input, Label, Switch,
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent,
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent,
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
  Tabs, TabsList, TabsTrigger,
  toast,
  Tooltip, TooltipTrigger, TooltipContent, TooltipProvider,
  PulseGrid,
} from '@slayzone/ui'
import type { ArtifactVersion, DiffResult } from '@slayzone/task-artifacts/shared'
import { RichTextEditor, MarkdownSettingsPopover } from '@slayzone/editor'
import type { EditorView as CMEditorView } from '@codemirror/view'
import type { RenderMode, TaskArtifact, ArtifactFolder } from '@slayzone/task/shared'
import { getEffectiveRenderMode, getExtensionFromTitle, RENDER_MODE_INFO, isBinaryRenderMode, canExportAsPdf, canExportAsPng, canExportAsHtml } from '@slayzone/task/shared'
import { Markdown, MermaidBlock, CanvasMediaView } from '@slayzone/markdown/client'
import { useAppearance, getThemeEditorColors, type EditorThemeColors } from '@slayzone/ui'
import { useTheme } from '@slayzone/settings/client'
import { SearchableCodeView, type SearchableCodeViewHandle } from '@slayzone/file-editor/client/SearchableCodeView'
import { EditorToc } from '@slayzone/file-editor/client/EditorToc'
import { type MarkdownHeading } from '@slayzone/file-editor/client/markdown-headings'
import { useArtifacts } from './useArtifacts'
import { ArtifactFindBar } from './ArtifactFindBar'
import { ArtifactSearchPanel } from './ArtifactSearchPanel'
import { ArtifactVersionsDialog } from './ArtifactVersionsDialog'
import { ArtifactVersionDiffView } from './ArtifactVersionDiffView'

export interface ArtifactsPanelHandle {
  selectArtifact: (id: string) => void
  createArtifact: () => void
  toggleSearch: () => void
}

interface ArtifactsPanelProps {
  taskId: string
  isResizing?: boolean
  initialActiveArtifactId?: string | null
  onActiveArtifactIdChange?: (id: string | null) => void
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

function getArtifactIcon(artifact: TaskArtifact): typeof FileText {
  const mode = getEffectiveRenderMode(artifact.title, artifact.render_mode)
  return RENDER_MODE_ICONS[mode] ?? Code
}


// --- Image viewer ---

function ImageViewer({ artifactId, contentVersion, getFilePath }: { artifactId: string; contentVersion: number; getFilePath: (id: string) => Promise<string | null> }) {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    getFilePath(artifactId).then((p) => {
      if (p) setSrc(`slz-file://${p}?v=${contentVersion}`)
    })
  }, [artifactId, contentVersion, getFilePath])

  if (!src) return <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">Loading...</div>

  return (
    <div className="flex-1 relative bg-muted/20 overflow-hidden">
      <CanvasMediaView source={{ kind: 'image', src }} className="absolute inset-0" />
    </div>
  )
}

// --- PDF viewer ---

function PdfViewer({ artifactId, contentVersion, getFilePath }: { artifactId: string; contentVersion: number; getFilePath: (id: string) => Promise<string | null> }) {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    getFilePath(artifactId).then((p) => {
      if (p) setSrc(`slz-file://${p}?v=${contentVersion}`)
    })
  }, [artifactId, contentVersion, getFilePath])

  if (!src) return <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">Loading...</div>

  return <iframe src={src} className="flex-1 w-full" title="PDF preview" />
}

// --- Artifact content editor ---

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

function ArtifactContentEditor({ artifact, viewMode, readContent, saveContent, getFilePath, effectiveReadability, effectiveWidth, searchQuery, searchActiveIndex, searchMatchCase, searchRegex, onSearchMatchCountChange }: {
  artifact: TaskArtifact
  viewMode: 'preview' | 'split' | 'raw'
  readContent: (id: string) => Promise<string | null>
  saveContent: (id: string, content: string) => Promise<void>
  getFilePath: (id: string) => Promise<string | null>
  effectiveReadability: 'compact' | 'normal'
  effectiveWidth: 'narrow' | 'wide'
  searchQuery: string
  searchActiveIndex: number
  searchMatchCase: boolean
  searchRegex: boolean
  onSearchMatchCountChange: (count: number) => void
}) {
  const { notesFontFamily, notesCheckedHighlight, notesShowToolbar, notesSpellcheck, editorMinimapEnabled, editorTocEnabled } = useAppearance()
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
  // Two counters with distinct purposes:
  // - editorReloadVersion: bumps only on external reload (loadFromDisk). Drives
  //   CodeMirror replaceAll in SearchableCodeView. Never bumped on save → caret
  //   survives save round-trips.
  // - previewVersion: bumps on save AND external reload. Cache-busts preview
  //   iframes (HTML/PDF/image) so they refetch from disk.
  const [editorReloadVersion, setEditorReloadVersion] = useState(0)
  const [previewVersion, setPreviewVersion] = useState(0)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const baselineMtimeRef = useRef<number | null>(null)
  const contentRef = useRef(content)
  const isDirtyRef = useRef(false)
  const splitCodeRef = useRef<SearchableCodeViewHandle>(null)
  const cmViewRef = useRef<CMEditorView | null>(null)
  const contentAreaRef = useRef<HTMLDivElement>(null)
  const [tocWidth, setTocWidth] = useState(220)
  contentRef.current = content
  isDirtyRef.current = isDirty
  const fileExt = getExtensionFromTitle(artifact.title) || undefined

  const renderMode = getEffectiveRenderMode(artifact.title, artifact.render_mode)
  const isBinary = isBinaryRenderMode(renderMode)

  // Read file from disk + refresh baseline mtime. Clears dirty + pending flags.
  const loadFromDisk = useCallback(async (): Promise<void> => {
    const [c, mtime] = await Promise.all([
      readContent(artifact.id),
      window.api.artifacts.getMtime(artifact.id),
    ])
    setContent(c ?? '')
    baselineMtimeRef.current = mtime
    setIsDirty(false)
    setExternalChangePending(false)
    setEditorReloadVersion(v => v + 1)
    setPreviewVersion(v => v + 1)
  }, [artifact.id, readContent])

  // Load on mount / artifact change. Flush pending save on unmount (with mtime guard).
  useEffect(() => {
    if (isBinary) {
      setLoading(false)
      window.api.artifacts.getMtime(artifact.id).then((m) => { baselineMtimeRef.current = m })
      setPreviewVersion(v => v + 1)
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
        saveContent(artifact.id, contentRef.current)
      }
    }
  }, [artifact.id, isBinary, loadFromDisk, saveContent])

  // fs.watch subscription — disk is the single source of truth for content.
  useEffect(() => {
    const off = window.api.artifacts.onContentChanged((changedId) => {
      if (changedId !== artifact.id) return
      if (isDirtyRef.current) {
        setExternalChangePending(true)
      } else {
        loadFromDisk()
      }
    })
    return () => { off() }
  }, [artifact.id, loadFromDisk])


  const handleChange = useCallback((value: string) => {
    setContent(value)
    setIsDirty(true)
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(async () => {
      saveTimerRef.current = null
      const currentMtime = await window.api.artifacts.getMtime(artifact.id)
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
      await saveContent(artifact.id, value)
      const newMtime = await window.api.artifacts.getMtime(artifact.id)
      baselineMtimeRef.current = newMtime
      setIsDirty(false)
      // Cache-bust preview iframes only. Editor must NOT see this bump or
      // CodeMirror replaceAll resets the caret mid-typing.
      setPreviewVersion(v => v + 1)
    }, 500)
  }, [artifact.id, saveContent])

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
    await saveContent(artifact.id, contentRef.current)
    const newMtime = await window.api.artifacts.getMtime(artifact.id)
    baselineMtimeRef.current = newMtime
    setIsDirty(false)
    setExternalChangePending(false)
  }, [artifact.id, saveContent])

  const banner = externalChangePending ? (
    <div className="absolute bottom-3 right-3 z-10 flex items-center gap-2 rounded-md border border-border bg-amber-500/10 px-3 py-1.5 text-[11px] shadow-md backdrop-blur-sm" data-testid="artifact-conflict-banner">
      <span className="text-muted-foreground">File changed externally.</span>
      <Button variant="outline" size="sm" className="!h-6 text-[10px] px-2" onClick={handleReloadFromDisk} data-testid="artifact-conflict-reload">Reload</Button>
      <Button variant="outline" size="sm" className="!h-6 text-[10px] px-2" onClick={handleKeepMine} data-testid="artifact-conflict-keep">Keep mine</Button>
    </div>
  ) : null

  const inner = ((): React.ReactElement => {
    if (loading) return <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">Loading...</div>
    if (renderMode === 'image') return <ImageViewer artifactId={artifact.id} contentVersion={previewVersion} getFilePath={getFilePath} />
    if (renderMode === 'pdf') return <PdfViewer artifactId={artifact.id} contentVersion={previewVersion} getFilePath={getFilePath} />

    const hasPreview = renderMode === 'markdown' || renderMode === 'html-preview' || renderMode === 'svg-preview' || renderMode === 'mermaid-preview'

    if (renderMode === 'markdown' && viewMode === 'preview') {
      return (
        <RichTextEditor
          className="flex-1 min-h-0"
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
      )
    }

    if (renderMode === 'markdown' && viewMode === 'split') {
      return (
        <div className="flex-1 flex flex-row overflow-hidden">
          <div className="flex-1 min-w-0">
            <SearchableCodeView
              ref={splitCodeRef}
              value={content ?? ''}
              onChange={handleChange}
              fileExt={fileExt}
              version={editorReloadVersion}
              searchQuery={searchQuery}
              searchActiveIndex={searchActiveIndex}
              searchMatchCase={searchMatchCase}
              searchRegex={searchRegex}
              onSearchMatchCountChange={onSearchMatchCountChange}
              placeholder="Write markdown..."
              minimap={editorMinimapEnabled}
              viewHandleRef={cmViewRef}
            />
          </div>
          <div
            className="flex-1 border-l border-border min-w-0 min-h-0"
            onClick={(e) => {
              const el = (e.target as HTMLElement).closest('[data-source-line]')
              const line = el ? parseInt(el.getAttribute('data-source-line') || '1', 10) : 1
              splitCodeRef.current?.focusLine(Number.isFinite(line) ? line : 1)
            }}
          >
            <div className="mk-doc" data-readability={effectiveReadability} data-width={effectiveWidth} style={themeStyle}>
              <div className="mk-doc-scroll">
                <div className="mk-doc-body">
                  <Markdown attachSourceLines>{content ?? ''}</Markdown>
                </div>
              </div>
            </div>
          </div>
        </div>
      )
    }

    if (hasPreview && viewMode === 'preview') {
      return <div className="flex-1 flex flex-col overflow-hidden"><ArtifactPreview renderMode={renderMode} content={content ?? ''} artifactId={artifact.id} contentVersion={previewVersion} getFilePath={getFilePath} /></div>
    }

    if (hasPreview && viewMode === 'split') {
      return (
        <div className="flex-1 flex flex-row overflow-hidden">
          <div className="flex-1 min-w-0">
            <SearchableCodeView
              value={content ?? ''}
              onChange={handleChange}
              fileExt={fileExt}
              version={editorReloadVersion}
              searchQuery={searchQuery}
              searchActiveIndex={searchActiveIndex}
              searchMatchCase={searchMatchCase}
              searchRegex={searchRegex}
              onSearchMatchCountChange={onSearchMatchCountChange}
              placeholder={`Write ${fileExt || 'content'}...`}
              minimap={editorMinimapEnabled}
              viewHandleRef={cmViewRef}
            />
          </div>
          <div className="flex-1 flex flex-col border-l border-border overflow-hidden min-w-0">
            <ArtifactPreview renderMode={renderMode} content={content ?? ''} artifactId={artifact.id} contentVersion={previewVersion} getFilePath={getFilePath} />
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
          version={editorReloadVersion}
          searchQuery={searchQuery}
          searchActiveIndex={searchActiveIndex}
          onSearchMatchCountChange={onSearchMatchCountChange}
          placeholder={`Write ${fileExt || 'content'}...`}
          minimap={editorMinimapEnabled}
          viewHandleRef={cmViewRef}
        />
      </div>
    )
  })()

  const handleTocJump = (heading: MarkdownHeading) => {
    if (viewMode === 'preview') {
      const root = contentAreaRef.current
      if (!root) return
      const headings = root.querySelectorAll('h1,h2,h3,h4,h5,h6')
      const target = headings[heading.index] as HTMLElement | undefined
      target?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      return
    }
    const view = cmViewRef.current
    if (!view) return
    const line = Math.max(1, Math.min(heading.line, view.state.doc.lines))
    const lineObj = view.state.doc.line(line)
    view.dispatch({ selection: { anchor: lineObj.from }, scrollIntoView: true })
    view.focus()
  }

  const showToc = renderMode === 'markdown' && editorTocEnabled && content != null
  return (
    <div className="relative flex-1 flex flex-row min-h-0">
      <div ref={contentAreaRef} className="relative flex-1 flex flex-col min-h-0 min-w-0">
        {inner}
        {banner}
      </div>
      {showToc && (
        <EditorToc
          content={content ?? ''}
          width={tocWidth}
          onWidthChange={setTocWidth}
          onJump={handleTocJump}
          minimapVisible={editorMinimapEnabled && viewMode !== 'preview'}
        />
      )}
    </div>
  )
}

// --- Preview pane ---

function ArtifactPreview({ renderMode, content, artifactId, contentVersion, getFilePath }: { renderMode: RenderMode; content: string; artifactId: string; contentVersion: number; getFilePath: (id: string) => Promise<string | null> }) {
  if (renderMode === 'html-preview') return <HtmlPreviewFrame artifactId={artifactId} contentVersion={contentVersion} getFilePath={getFilePath} />
  // svg-preview + mermaid-preview share the same svg-pan-zoom-driven viewer.
  if (renderMode === 'svg-preview') return (
    <div className="flex-1 min-h-0 overflow-hidden bg-muted/30 relative">
      <CanvasMediaView source={{ kind: 'svg', svg: content }} className="absolute inset-0" />
    </div>
  )
  if (renderMode === 'mermaid-preview' && content.trim()) return <MermaidBlock code={content} fill />
  return null
}

// HTML preview via slz-file:// custom scheme (registered with bypassCSP +
// secure privileges). Cannot use srcDoc/blob/data URLs: parent renderer's CSP
// `script-src 'self'` is inherited by them and blocks inline + CDN scripts.
// slz-file gets its own origin and bypasses CSP so user HTML runs unmodified.
// `contentVersion` cache-busts on each save so the iframe reloads after edits.
function HtmlPreviewFrame({ artifactId, contentVersion, getFilePath }: { artifactId: string; contentVersion: number; getFilePath: (id: string) => Promise<string | null> }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    getFilePath(artifactId).then(p => { if (p) setSrc(`slz-file://${p}?v=${contentVersion}`) })
  }, [artifactId, contentVersion, getFilePath])
  if (!src) return <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">Loading...</div>
  return <iframe src={src} sandbox="allow-scripts" className="flex-1 bg-white" title="HTML preview" />
}

// --- Main panel ---

export const ArtifactsPanel = forwardRef<ArtifactsPanelHandle, ArtifactsPanelProps>(function ArtifactsPanel({ taskId, isResizing, initialActiveArtifactId, onActiveArtifactIdChange }, ref) {
  const {
    artifacts, folders, isLoading, selectedId, setSelectedId,
    createArtifact, updateArtifact, deleteArtifact, renameArtifact, moveArtifactToFolder,
    readContent, saveContent, uploadArtifact, uploadDir, getFilePath,
    downloadFile, downloadFolder, downloadAsPdf, downloadAsPng, downloadAsHtml, downloadAllAsZip,
    listVersions, readVersion, createVersion, renameVersion, diffVersions, setCurrentVersion,
    createFolder, deleteFolder, renameFolder,
    getArtifactPath, folderPathMap,
  } = useArtifacts(taskId, initialActiveArtifactId)

  // Notify parent when selection changes (for persistence)
  const prevSelectedIdRef = useRef(selectedId)
  useEffect(() => {
    if (selectedId !== prevSelectedIdRef.current) {
      prevSelectedIdRef.current = selectedId
      onActiveArtifactIdChange?.(selectedId)
    }
  }, [selectedId, onActiveArtifactIdChange])

  // Keep multi-select in sync with single-select changes from outside (imperative handle, search panel)
  useEffect(() => {
    setSelectedIds((prev) => {
      if (selectedId == null) return prev
      if (prev.size === 1 && prev.has(selectedId)) return prev
      if (prev.size > 1 && prev.has(selectedId)) return prev
      return new Set([selectedId])
    })
  }, [selectedId])

  const { editorMarkdownViewMode, notesReadability, notesWidth, notesFontFamily, editorMinimapEnabled, editorTocEnabled } = useAppearance()
  const [displayOpen, setDisplayOpen] = useState(false)
  const artifactDefaultViewMode = editorMarkdownViewMode === 'code' ? 'raw' : editorMarkdownViewMode === 'split' ? 'split' : 'preview'
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

  // Versions modal state
  const [artifactVersions, setArtifactVersions] = useState<ArtifactVersion[]>([])
  const [versionsLoading, setVersionsLoading] = useState(false)
  const [versionsDialogOpen, setVersionsDialogOpen] = useState(false)
  const [viewingVersion, setViewingVersion] = useState<{
    version: ArtifactVersion
    content: string
    diff: DiffResult | null
    mode: 'diff' | 'content'
    /** version_num to diff against. undefined = default (latest per IPC). */
    diffAgainst: number | undefined
  } | null>(null)

  const refreshVersions = useCallback(async (artifactId: string): Promise<void> => {
    setVersionsLoading(true)
    try {
      const rows = await listVersions(artifactId, { limit: 50 })
      setArtifactVersions(rows)
    } catch {
      setArtifactVersions([])
    } finally {
      setVersionsLoading(false)
    }
  }, [listVersions])

  const openVersion = useCallback(async (artifactId: string, version: ArtifactVersion, mode: 'diff' | 'content'): Promise<void> => {
    try {
      const [content, diff] = await Promise.all([
        readVersion(artifactId, version.version_num),
        diffVersions(artifactId, version.version_num).catch(() => null),
      ])
      setViewingVersion({ version, content, diff, mode, diffAgainst: undefined })
    } catch (err) {
      console.error('Failed to load version', err)
    }
  }, [readVersion, diffVersions])

  const changeDiffAgainst = useCallback(async (artifactId: string, targetVersionNum: number | undefined): Promise<void> => {
    setViewingVersion((v) => (v ? { ...v, diffAgainst: targetVersionNum } : v))
    if (!viewingVersion) return
    try {
      const diff = await diffVersions(artifactId, viewingVersion.version.version_num, targetVersionNum)
      setViewingVersion((v) => (v ? { ...v, diff } : v))
    } catch {
      setViewingVersion((v) => (v ? { ...v, diff: null } : v))
    }
  }, [diffVersions, viewingVersion])

  const handleCreateVersion = useCallback(async (artifactId: string): Promise<void> => {
    try {
      await createVersion(artifactId)
      await refreshVersions(artifactId)
    } catch (err) {
      console.error('Create version failed', err)
    }
  }, [createVersion, refreshVersions])

  // Inline creation/rename state
  const [creating, setCreating] = useState<{ parentFolderId: string | null; type: 'file' | 'folder' } | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; type: 'artifact' | 'folder' } | null>(null)
  const [renameValue, setRenameValue] = useState('')

  // Multi-select for artifact rows + internal clipboard
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const lastClickedRef = useRef<string | null>(null)
  const [clipboard, setClipboard] = useState<{ ids: string[]; mode: 'copy' | 'cut' } | null>(null)
  const [osHasFiles, setOsHasFiles] = useState(false)
  const refreshOsClipboard = useCallback(() => {
    window.api.clipboard.hasFiles().then(setOsHasFiles).catch(() => setOsHasFiles(false))
  }, [])
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
  const expandedStorageKey = `slayzone:artifacts-panel:expanded:${taskId}`
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

  const selectedArtifact = artifacts.find(a => a.id === selectedId) ?? null
  const selectedRenderMode = selectedArtifact ? getEffectiveRenderMode(selectedArtifact.title, selectedArtifact.render_mode) : null
  const effectiveReadability: 'compact' | 'normal' = selectedArtifact?.readability_override ?? notesReadability
  const effectiveWidth: 'narrow' | 'wide' = selectedArtifact?.width_override ?? notesWidth

  useEffect(() => {
    const artifact = artifacts.find(a => a.id === selectedId)
    setViewMode((artifact?.view_mode as 'preview' | 'split' | 'raw') ?? artifactDefaultViewMode)
    setFindOpen(false); setFindQuery(''); setFindActiveIndex(0); setFindMatchCount(0); setFindMatchCase(false); setFindUseRegex(false)
  }, [selectedId])

  // Reset active index when the search parameters change so the first match is the target
  useEffect(() => { setFindActiveIndex(0) }, [findQuery, findMatchCase, findUseRegex])

  // Reset match count when query clears — a blank query should show no matches
  useEffect(() => { if (!findQuery.trim()) setFindMatchCount(0) }, [findQuery])

  useImperativeHandle(ref, () => ({
    selectArtifact: (id: string) => setSelectedId(id),
    createArtifact: () => setCreating({ parentFolderId: null, type: 'file' }),
    toggleSearch: () => setSidebarMode(m => m === 'search' ? 'tree' : 'search'),
  }), [setSelectedId])

  // --- Inline create/rename handlers ---

  const handleInlineCreate = useCallback((value: string) => {
    if (!creating) return
    const name = value.trim()
    if (!name) { setCreating(null); return }
    if (creating.type === 'file') {
      createArtifact({ title: name, folderId: creating.parentFolderId })
    } else {
      createFolder({ name, parentId: creating.parentFolderId })
    }
    setCreating(null)
  }, [creating, createArtifact, createFolder])

  const handleInlineRename = useCallback((value: string) => {
    if (!renaming) return
    const name = value.trim()
    if (!name) { setRenaming(null); return }
    if (renaming.type === 'artifact') {
      renameArtifact(renaming.id, name)
    } else {
      renameFolder(renaming.id, name)
    }
    setRenaming(null)
  }, [renaming, renameArtifact, renameFolder])

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

  const handleFileDrop = useCallback(async (e: DragEvent) => {
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
  }, [uploadArtifact, uploadDir])

  // --- Drag-to-folder handlers ---

  const handleArtifactDragStart = useCallback((artifactId: string) => (e: React.DragEvent) => {
    const ids = selectedIds.has(artifactId) && selectedIds.size > 1 ? [...selectedIds] : [artifactId]
    dragArtifactIdsRef.current = ids
    e.dataTransfer.setData('application/x-slayzone-artifact-ids', JSON.stringify(ids))
    e.dataTransfer.setData('text/plain', ids.join(','))
    e.dataTransfer.effectAllowed = 'move'
  }, [selectedIds])

  const handleFolderDragOver = useCallback((folderId: string) => (e: React.DragEvent) => {
    if (!dragArtifactIdsRef.current.length) return
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
    const ids = dragArtifactIdsRef.current
    dragArtifactIdsRef.current = []
    if (!ids.length) return
    for (const id of ids) moveArtifactToFolder(id, folderId)
  }, [moveArtifactToFolder])

  const handleRootDragOver = useCallback((e: React.DragEvent) => {
    if (!dragArtifactIdsRef.current.length) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropTargetFolder('__root__')
  }, [])

  const handleRootDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDropTargetFolder(null)
    const ids = dragArtifactIdsRef.current
    dragArtifactIdsRef.current = []
    if (!ids.length) return
    for (const id of ids) moveArtifactToFolder(id, null)
  }, [moveArtifactToFolder])

  const handleDragEnd = useCallback(() => {
    dragArtifactIdsRef.current = []
    setDropTargetFolder(null)
  }, [])

  // --- Search handlers ---

  const handleSearchResult = useCallback((artifactId: string, payload: { query: string; matchCase: boolean; useRegex: boolean; matchIndex: number }) => {
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
  }, [setSelectedId])

  const toggleFolder = useCallback((folderId: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev ?? [])
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }, [])

  // --- Build tree structure from folders + artifacts ---

  const { childFolders, artifactsByFolder } = useMemo(() => {
    const cf = new Map<string | null, ArtifactFolder[]>()
    for (const f of folders) {
      const arr = cf.get(f.parent_id) ?? []
      arr.push(f)
      cf.set(f.parent_id, arr)
    }
    const ab = new Map<string | null, TaskArtifact[]>()
    for (const a of artifacts) {
      const arr = ab.get(a.folder_id) ?? []
      arr.push(a)
      ab.set(a.folder_id, arr)
    }
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
    for (const arr of cf.values()) arr.sort((a, b) => collator.compare(a.name, b.name))
    for (const arr of ab.values()) arr.sort((a, b) => collator.compare(a.title, b.title))
    return { childFolders: cf, artifactsByFolder: ab }
  }, [folders, artifacts])

  // --- "Move to" folder list for context menu ---

  const moveToFolders = useMemo(() => {
    return folders.map(f => ({ id: f.id, name: f.name, path: folderPathMap.get(f.id) ?? f.name }))
  }, [folders, folderPathMap])

  // --- Copy path ---

  const handleCopyPath = useCallback(async (artifactId: string) => {
    const fp = await getFilePath(artifactId)
    if (fp) navigator.clipboard.writeText(fp)
  }, [getFilePath])

  // --- Multi-select + clipboard ---

  const flatArtifactIds = useMemo(() => {
    const out: string[] = []
    function walk(parentId: string | null) {
      const subFolders = childFolders.get(parentId) ?? []
      for (const f of subFolders) {
        const expanded = expandedFolders?.has(f.id) ?? true
        if (expanded) walk(f.id)
      }
      const subArtifacts = artifactsByFolder.get(parentId) ?? []
      for (const a of subArtifacts) out.push(a.id)
    }
    walk(null)
    return out
  }, [childFolders, artifactsByFolder, expandedFolders])

  const handleArtifactClick = useCallback((e: React.MouseEvent, artifactId: string) => {
    const isMeta = e.metaKey || e.ctrlKey
    const isShift = e.shiftKey
    if (isMeta) {
      setSelectedIds((prev) => {
        const next = new Set(prev)
        if (next.has(artifactId)) next.delete(artifactId)
        else next.add(artifactId)
        return next
      })
      lastClickedRef.current = artifactId
      setSelectedId(artifactId)
      return
    }
    if (isShift && lastClickedRef.current) {
      const startIdx = flatArtifactIds.indexOf(lastClickedRef.current)
      const endIdx = flatArtifactIds.indexOf(artifactId)
      if (startIdx >= 0 && endIdx >= 0) {
        const [lo, hi] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx]
        setSelectedIds(new Set(flatArtifactIds.slice(lo, hi + 1)))
        setSelectedId(artifactId)
        return
      }
    }
    setSelectedIds(new Set([artifactId]))
    lastClickedRef.current = artifactId
    setSelectedId(artifactId)
  }, [flatArtifactIds, setSelectedId])

  const getEffectiveArtifactIds = useCallback((artifactId: string): string[] => {
    if (selectedIds.has(artifactId) && selectedIds.size > 1) return [...selectedIds]
    return [artifactId]
  }, [selectedIds])

  const writeArtifactsToOsClipboard = useCallback(async (ids: string[]) => {
    const paths = (await Promise.all(ids.map((id) => getFilePath(id)))).filter((p): p is string => !!p)
    await window.api.clipboard.writeFilePaths(paths)
  }, [getFilePath])

  const handleArtifactCopy = useCallback((ids: string[]) => {
    if (!ids.length) return
    setClipboard({ ids, mode: 'copy' })
    void writeArtifactsToOsClipboard(ids)
  }, [writeArtifactsToOsClipboard])

  const handleArtifactCut = useCallback((ids: string[]) => {
    if (!ids.length) return
    setClipboard({ ids, mode: 'cut' })
    void writeArtifactsToOsClipboard(ids)
  }, [writeArtifactsToOsClipboard])

  const handleArtifactPaste = useCallback(async (destFolderId: string | null) => {
    const osPaths = await window.api.clipboard.readFilePaths()
    if (!osPaths.length) return
    const created = await window.api.artifacts.pasteFiles({ sourcePaths: osPaths, destTaskId: taskId, destFolderId })
    // Cut-mode source delete only if internal clipboard markers still match OS clipboard
    if (clipboard?.mode === 'cut') {
      const sourcePathSet = new Set(osPaths)
      const internalPaths = (await Promise.all(clipboard.ids.map((id) => getFilePath(id)))).filter((p): p is string => !!p)
      const matchesInternal = internalPaths.length === osPaths.length && internalPaths.every((p) => sourcePathSet.has(p))
      if (matchesInternal) {
        for (const id of clipboard.ids) {
          await deleteArtifact(id)
        }
        setClipboard(null)
      }
    }
    if (created.length) {
      setSelectedIds(new Set(created.map((a) => a.id)))
      setSelectedId(created[created.length - 1].id)
      lastClickedRef.current = created[created.length - 1].id
    }
  }, [clipboard, taskId, getFilePath, deleteArtifact, setSelectedId])

  const handleArtifactDuplicate = useCallback(async (ids: string[]) => {
    if (!ids.length) return
    const paths = (await Promise.all(ids.map((id) => getFilePath(id)))).filter((p): p is string => !!p)
    if (!paths.length) return
    const sourceArtifact = artifacts.find((a) => a.id === ids[0])
    const destFolderId = sourceArtifact?.folder_id ?? null
    await window.api.artifacts.pasteFiles({ sourcePaths: paths, destTaskId: taskId, destFolderId })
  }, [getFilePath, artifacts, taskId])

  const handleDeleteSelected = useCallback(async (ids: string[]) => {
    for (const id of ids) await deleteArtifact(id)
    setSelectedIds(new Set())
  }, [deleteArtifact])

  const handleSelectAll = useCallback(() => {
    setSelectedIds(new Set(flatArtifactIds))
  }, [flatArtifactIds])

  const handlePanelKeyDown = useCallback((e: React.KeyboardEvent) => {
    const meta = e.metaKey || e.ctrlKey
    const target = e.target as HTMLElement
    const inEditableField =
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable
    const inSidebar = target.closest('[data-testid="artifacts-sidebar"]') !== null

    if (meta && e.key === 'f') {
      e.preventDefault()
      e.stopPropagation()
      const rm = selectedArtifact ? getEffectiveRenderMode(selectedArtifact.title, selectedArtifact.render_mode) : null
      if (selectedArtifact && rm && !isBinaryRenderMode(rm)) {
        setFindOpen(true)
        setFindFocusToken(t => t + 1)
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
      const focusedArtifact = selectedId ? artifacts.find(a => a.id === selectedId) : null
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
  }, [selectedArtifact, selectedId, selectedIds, artifacts, handleArtifactCopy, handleArtifactCut, handleArtifactPaste, handleArtifactDuplicate, handleDeleteSelected, handleSelectAll])

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
          data-testid="artifacts-create-input"
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
    const subArtifacts = artifactsByFolder.get(parentId) ?? []

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
                        data-testid="artifacts-rename-input"
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
                    <FilePlus className="size-3 mr-2" /> New Artifact
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => { willCreateRef.current = true; setCreating({ parentFolderId: folder.id, type: 'folder' }) }}>
                    <FolderPlus className="size-3 mr-2" /> New Folder
                  </ContextMenuItem>
                  {(clipboard || osHasFiles) && (
                    <>
                      <ContextMenuSeparator />
                      <ContextMenuItem onSelect={() => void handleArtifactPaste(folder.id)}>
                        <ClipboardPaste className="size-3 mr-2" /> Paste
                        <ContextMenuShortcut>⌘V</ContextMenuShortcut>
                      </ContextMenuItem>
                    </>
                  )}
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

        {subArtifacts.length > 0 && (
          <div className="flex flex-col gap-1 py-0.5">
            {subArtifacts.map(artifact => {
              const TypeIcon = getArtifactIcon(artifact)
              const isRenaming = renaming?.id === artifact.id && renaming.type === 'artifact'
              const ext = getExtensionFromTitle(artifact.title).replace('.', '').toUpperCase()
              const effectiveMode = getEffectiveRenderMode(artifact.title, artifact.render_mode)
              const modeLabel = RENDER_MODE_INFO[effectiveMode].label

              return (
                <div key={`f:${artifact.id}`} data-testid={`artifact-row-${artifact.id}`} style={{ marginLeft: depth * INDENT_PX + BASE_PAD, marginRight: 4 }}>
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <button
                        className={cn(
                          'group/artifact flex w-full flex-col gap-0.5 rounded-md border px-2.5 py-2 text-left text-xs cursor-pointer transition-colors',
                          artifact.id === selectedId
                            ? 'border-primary/40 bg-primary/[0.08] text-foreground'
                            : selectedIds.has(artifact.id)
                              ? 'border-primary/30 bg-primary/[0.04] text-foreground'
                              : 'border-border/60 bg-card/50 text-muted-foreground hover:text-foreground hover:bg-muted/50 hover:border-border',
                          clipboard?.mode === 'cut' && clipboard.ids.includes(artifact.id) && 'opacity-50',
                        )}
                        onClick={(e) => handleArtifactClick(e, artifact.id)}
                        draggable={!isRenaming}
                        onDragStart={handleArtifactDragStart(artifact.id)}
                      >
                        <div className="flex w-full items-center gap-1.5 min-w-0">
                          <TypeIcon className="size-4 shrink-0" />
                          {isRenaming ? (
                            <Input
                              ref={renameInputRef}
                              data-testid="artifacts-rename-input"
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
                            <span className="truncate flex-1 font-medium">{artifact.title}</span>
                          )}
                          {ext && !isRenaming && (
                            <span className="shrink-0 rounded bg-muted px-1 py-px text-[10px] font-mono text-muted-foreground">{ext}</span>
                          )}
                        </div>
                        {!isRenaming && (
                          <div className="flex items-center gap-1.5 pl-[22px] text-[10px] text-muted-foreground/70">
                            <span>{modeLabel}</span>
                            <span className="text-muted-foreground/40">&middot;</span>
                            <span>{formatRelativeDate(artifact.updated_at)}</span>
                          </div>
                        )}
                      </button>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onSelect={() => handleArtifactCut(getEffectiveArtifactIds(artifact.id))}>
                        <Scissors className="size-3 mr-2" /> Cut
                        <ContextMenuShortcut>⌘X</ContextMenuShortcut>
                      </ContextMenuItem>
                      <ContextMenuItem onSelect={() => handleArtifactCopy(getEffectiveArtifactIds(artifact.id))}>
                        <Copy className="size-3 mr-2" /> Copy
                        <ContextMenuShortcut>⌘C</ContextMenuShortcut>
                      </ContextMenuItem>
                      {(clipboard || osHasFiles) && (
                        <ContextMenuItem onSelect={() => void handleArtifactPaste(artifact.folder_id)}>
                          <ClipboardPaste className="size-3 mr-2" /> Paste
                          <ContextMenuShortcut>⌘V</ContextMenuShortcut>
                        </ContextMenuItem>
                      )}
                      <ContextMenuItem onSelect={() => void handleArtifactDuplicate(getEffectiveArtifactIds(artifact.id))}>
                        <CopyPlus className="size-3 mr-2" /> Duplicate
                        <ContextMenuShortcut>⌘D</ContextMenuShortcut>
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        onSelect={() => startRenameArtifact(artifact)}
                        disabled={selectedIds.size > 1 && selectedIds.has(artifact.id)}
                      >
                        <Pencil className="size-3 mr-2" /> Rename
                      </ContextMenuItem>
                      {moveToFolders.length > 0 && (
                        <ContextMenuSub>
                          <ContextMenuSubTrigger>
                            <ArrowRight className="size-3 mr-2" /> Move to
                          </ContextMenuSubTrigger>
                          <ContextMenuSubContent>
                            {artifact.folder_id && (
                              <ContextMenuItem onSelect={() => moveArtifactToFolder(artifact.id, null)}>
                                Root
                              </ContextMenuItem>
                            )}
                            {moveToFolders
                              .filter(f => f.id !== artifact.folder_id)
                              .map(f => (
                                <ContextMenuItem key={f.id} onSelect={() => moveArtifactToFolder(artifact.id, f.id)}>
                                  {f.path}
                                </ContextMenuItem>
                              ))
                            }
                          </ContextMenuSubContent>
                        </ContextMenuSub>
                      )}
                      <ContextMenuSeparator />
                      <ContextMenuItem onSelect={() => handleCopyPath(artifact.id)}>
                        <Copy className="size-3 mr-2" /> Copy Path
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem onSelect={() => downloadFile(artifact.id)}>
                        <Download className="size-3 mr-2" /> Download
                      </ContextMenuItem>
                      {(canExportAsPdf(effectiveMode) || canExportAsPng(effectiveMode) || canExportAsHtml(effectiveMode)) && (
                        <ContextMenuSub>
                          <ContextMenuSubTrigger>
                            <Download className="size-3 mr-2" /> Download as
                          </ContextMenuSubTrigger>
                          <ContextMenuSubContent>
                            {canExportAsPdf(effectiveMode) && (
                              <ContextMenuItem onSelect={() => downloadAsPdf(artifact.id)}>
                                <FileText className="size-3 mr-2" /> PDF
                              </ContextMenuItem>
                            )}
                            {canExportAsPng(effectiveMode) && (
                              <ContextMenuItem onSelect={() => downloadAsPng(artifact.id)}>
                                <ImageDown className="size-3 mr-2" /> PNG
                              </ContextMenuItem>
                            )}
                            {canExportAsHtml(effectiveMode) && (
                              <ContextMenuItem onSelect={() => downloadAsHtml(artifact.id)}>
                                <FileCode className="size-3 mr-2" /> HTML
                              </ContextMenuItem>
                            )}
                          </ContextMenuSubContent>
                        </ContextMenuSub>
                      )}
                      <ContextMenuSeparator />
                      <ContextMenuItem variant="destructive" onSelect={() => void handleDeleteSelected(getEffectiveArtifactIds(artifact.id))}>
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
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide mr-auto">Artifacts</span>
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
          {/* Top-right: action buttons + artifact controls */}
          <div className="flex items-center gap-1.5 px-3 py-1.5 flex-1">
            <button
              className="flex items-center justify-center size-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
              onClick={() => setSidebarVisible(v => !v)}
              title={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
            >
              {sidebarVisible ? <PanelLeftClose className="size-4" /> : <PanelLeft className="size-4" />}
            </button>
            <div className="flex-1" />
            {selectedArtifact && selectedRenderMode && (
              <div className="flex items-center gap-1.5">
                {selectedArtifact && selectedRenderMode === 'markdown' && (
                  <MarkdownSettingsPopover
                    open={displayOpen}
                    onOpenChange={setDisplayOpen}
                    trigger={
                      <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs font-medium text-muted-foreground">
                        <SlidersHorizontal className="size-3.5" />
                        Display
                      </Button>
                    }
                  >
                    <div className="grid grid-cols-3 rounded-md border border-border/50 p-0.5 gap-0.5">
                      {([
                        { mode: 'preview' as const, icon: Eye, label: 'Preview' },
                        { mode: 'split' as const, icon: Columns2, label: 'Split' },
                        { mode: 'raw' as const, icon: Code2, label: 'Raw' },
                      ]).map(({ mode, icon: Icon, label }) => {
                        const active = viewMode === mode
                        return (
                          <button
                            key={mode}
                            className={cn(
                              'flex flex-col items-center justify-center gap-1 py-3 text-[10px] font-medium rounded transition-colors',
                              active ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                            )}
                            onClick={() => { setViewMode(mode); updateArtifact({ id: selectedArtifact.id, viewMode: mode }) }}
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
                        <Label htmlFor="art-toc" className="text-sm cursor-pointer">Outline</Label>
                        <Switch id="art-toc" checked={editorTocEnabled} onCheckedChange={(v) => {
                          void window.api.settings.set('editor_toc_enabled', v ? '1' : '0')
                          window.dispatchEvent(new Event('sz:settings-changed'))
                        }} />
                      </div>
                      <div className="flex items-center justify-between">
                        <Label htmlFor="art-minimap" className={cn('text-sm cursor-pointer', viewMode === 'preview' && 'text-muted-foreground/50')}>Minimap{viewMode === 'preview' ? ' (not in preview)' : ''}</Label>
                        <Switch id="art-minimap" checked={editorMinimapEnabled && viewMode !== 'preview'} disabled={viewMode === 'preview'} onCheckedChange={(v) => {
                          void window.api.settings.set('editor_minimap_enabled', v ? '1' : '0')
                          window.dispatchEvent(new Event('sz:settings-changed'))
                        }} />
                      </div>
                    </div>

                    <div className="space-y-3">
                      <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-3 block">Layout</span>
                      <div className="flex items-center justify-between">
                        <Label htmlFor="art-compact" className="text-sm cursor-pointer">
                          Compact
                          {selectedArtifact.readability_override && <span className="ml-1.5 text-xs text-muted-foreground/70">(override)</span>}
                        </Label>
                        <Switch id="art-compact" checked={effectiveReadability === 'compact'} onCheckedChange={(v) => {
                          const next: 'compact' | 'normal' = v ? 'compact' : 'normal'
                          const override = next === notesReadability ? null : next
                          updateArtifact({ id: selectedArtifact.id, readabilityOverride: override })
                        }} />
                      </div>
                      <div className="flex items-center justify-between">
                        <Label htmlFor="art-wide" className="text-sm cursor-pointer">
                          Wide
                          {selectedArtifact.width_override && <span className="ml-1.5 text-xs text-muted-foreground/70">(override)</span>}
                        </Label>
                        <Switch id="art-wide" checked={effectiveWidth === 'wide'} onCheckedChange={(v) => {
                          const next: 'narrow' | 'wide' = v ? 'wide' : 'narrow'
                          const override = next === notesWidth ? null : next
                          updateArtifact({ id: selectedArtifact.id, widthOverride: override })
                        }} />
                      </div>
                      <div className="flex items-center justify-between">
                        <Label htmlFor="art-mono" className="text-sm cursor-pointer">Use mono font</Label>
                        <Switch id="art-mono" checked={notesFontFamily === 'mono'} onCheckedChange={(v) => {
                          void window.api.settings.set('notes_font_family', v ? 'mono' : 'sans')
                          window.dispatchEvent(new Event('sz:settings-changed'))
                        }} />
                      </div>
                    </div>
                  </MarkdownSettingsPopover>
                )}
                <Select
                  value={selectedArtifact.render_mode ?? '__auto__'}
                  onValueChange={(v) => updateArtifact({ id: selectedArtifact.id, renderMode: v === '__auto__' ? null : v as RenderMode })}
                >
                  <SelectTrigger size="sm" className="!h-7 text-xs w-auto min-w-0 gap-1.5 px-2.5 shrink-0"><SelectValue /></SelectTrigger>
                  <SelectContent position="popper" side="bottom" className="max-h-none overflow-y-visible">
                    <SelectItem value="__auto__">Auto ({RENDER_MODE_INFO[getEffectiveRenderMode(selectedArtifact.title, null)].label})</SelectItem>
                    {(Object.keys(RENDER_MODE_INFO) as RenderMode[]).map((mode) => (
                      <SelectItem key={mode} value={mode}>{RENDER_MODE_INFO[mode].label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {selectedArtifact && selectedRenderMode && (() => {
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
                            <DropdownMenuItem onSelect={() => downloadAsPdf(selectedArtifact.id)}>
                              <FileText className="size-3 mr-2" /> PDF
                            </DropdownMenuItem>
                          )}
                          {hasPng && (
                            <DropdownMenuItem onSelect={() => downloadAsPng(selectedArtifact.id)}>
                              <ImageDown className="size-3 mr-2" /> PNG
                            </DropdownMenuItem>
                          )}
                          {hasHtml && (
                            <DropdownMenuItem onSelect={() => downloadAsHtml(selectedArtifact.id)}>
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
          <div className="shrink-0 flex flex-col border-r border-border" style={{ width: sidebarWidth }}>
            {sidebarMode === 'search' ? (
              <ArtifactSearchPanel
                artifacts={artifacts}
                readContent={readContent}
                getArtifactPath={getArtifactPath}
                onSelectResult={handleSearchResult}
              />
            ) : (
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <div
                    data-testid="artifacts-sidebar"
                    tabIndex={-1}
                    className={cn("flex-1 overflow-y-auto p-1.5 select-none text-sm outline-none", dropTargetFolder === '__root__' && 'bg-primary/10')}
                    onDragOver={handleRootDragOver}
                    onDragLeave={handleFolderDragLeave}
                    onDrop={handleRootDrop}
                    onMouseEnter={refreshOsClipboard}
                    onFocus={refreshOsClipboard}
                    onClick={(e) => {
                      // Click on empty area clears selection (matches editor pattern)
                      if (e.target === e.currentTarget) {
                        setSelectedIds(new Set())
                      }
                    }}
                  >
                    {artifacts.length > 0 || folders.length > 0 ? (
                      <>
                        {renderTree(null, 0)}
                        {renderInlineInput(null, 0)}
                      </>
                    ) : creating ? (
                      renderInlineInput(null, 0)
                    ) : (
                      <div className="text-[10px] text-muted-foreground/60 text-center py-4">
                        No artifacts yet
                      </div>
                    )}
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent onCloseAutoFocus={preventAutoFocus}>
                  <ContextMenuItem onSelect={() => { willCreateRef.current = true; setCreating({ parentFolderId: null, type: 'file' }) }}>
                    <FilePlus className="size-3 mr-2" /> New Artifact
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => { willCreateRef.current = true; setCreating({ parentFolderId: null, type: 'folder' }) }}>
                    <FolderPlus className="size-3 mr-2" /> New Folder
                  </ContextMenuItem>
                  {(clipboard || osHasFiles) && (
                    <>
                      <ContextMenuSeparator />
                      <ContextMenuItem onSelect={() => void handleArtifactPaste(null)}>
                        <ClipboardPaste className="size-3 mr-2" /> Paste
                        <ContextMenuShortcut>⌘V</ContextMenuShortcut>
                      </ContextMenuItem>
                    </>
                  )}
                  {artifacts.length > 0 && (
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
              <Button data-testid="artifacts-new-btn" variant="outline" size="sm" className={cn("!h-7 text-[10px] flex-1 min-w-0", sidebarWidth < 180 ? "px-0 justify-center" : "px-2")} onClick={() => setCreating({ parentFolderId: null, type: 'file' })} title="New file">
                <FilePlus className="size-3 shrink-0" />
                {sidebarWidth >= 180 && <span className="ml-1 truncate">New</span>}
              </Button>
              <Button data-testid="artifacts-folder-btn" variant="outline" size="sm" className={cn("!h-7 text-[10px] flex-1 min-w-0", sidebarWidth < 180 ? "px-0 justify-center" : "px-2")} onClick={() => setCreating({ parentFolderId: null, type: 'folder' })} title="New folder">
                <FolderPlus className="size-3 shrink-0" />
                {sidebarWidth >= 180 && <span className="ml-1 truncate">Folder</span>}
              </Button>
              <Button data-testid="artifacts-upload-btn" variant="outline" size="sm" className={cn("!h-7 text-[10px] flex-1 min-w-0", sidebarWidth < 180 ? "px-0 justify-center" : "px-2")} onClick={handleUpload} title="Upload file">
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
          {findOpen && selectedArtifact && selectedRenderMode && !isBinaryRenderMode(selectedRenderMode) && (
            <ArtifactFindBar
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
      <ArtifactVersionsDialog
        open={versionsDialogOpen}
        onOpenChange={setVersionsDialogOpen}
        versions={artifactVersions}
        currentVersionId={selectedArtifact?.current_version_id ?? null}
        loading={versionsLoading}
        onSetCurrent={async (ref) => {
          if (!selectedArtifact) return
          try {
            await setCurrentVersion(selectedArtifact.id, ref)
            await refreshVersions(selectedArtifact.id)
          } catch (err) {
            toast.error(`Failed to set current: ${err instanceof Error ? err.message : String(err)}`)
          }
        }}
        onRename={async (ref, newName) => {
          if (!selectedArtifact) return
          await renameVersion(selectedArtifact.id, ref, newName)
          await refreshVersions(selectedArtifact.id)
        }}
        onOpenPreview={(v) => {
          if (!selectedArtifact) return
          void openVersion(selectedArtifact.id, v, 'content')
        }}
        onDiff={(v) => {
          if (!selectedArtifact) return
          void openVersion(selectedArtifact.id, v, 'diff')
        }}
        onCreateVersion={async () => {
          if (!selectedArtifact) return
          await handleCreateVersion(selectedArtifact.id)
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
            <ArtifactVersionDiffView diff={viewingVersion.diff} />
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
                      if (!selectedArtifact) return
                      const num = val === '__current__' ? undefined : Number(val)
                      void changeDiffAgainst(selectedArtifact.id, num)
                    }}
                  >
                    <SelectTrigger size="sm" className="text-xs w-[160px]">
                      <SelectValue placeholder="vs…" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__current__">vs current</SelectItem>
                      {artifactVersions
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
                disabled={!viewingVersion || viewingVersion.version.id === (selectedArtifact?.current_version_id ?? null)}
                onClick={async () => {
                  if (!viewingVersion || !selectedArtifact) return
                  try {
                    await setCurrentVersion(selectedArtifact.id, viewingVersion.version.version_num)
                    await refreshVersions(selectedArtifact.id)
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
