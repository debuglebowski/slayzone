import { useState, useEffect, useCallback, useRef, useMemo, type CSSProperties } from 'react'
import { useTRPC, useTRPCClient, useSubscription } from '@slayzone/transport/client'
import { Button, useVisibleInterval } from '@slayzone/ui'
import { RichTextEditor } from '@slayzone/editor'
import { toSlzFileUrl } from '@slayzone/platform/slz-file-url'
import type { EditorView as CMEditorView } from '@codemirror/view'
import type { RenderMode, TaskArtifact } from '@slayzone/task/shared'
import {
  getEffectiveRenderMode,
  getExtensionFromTitle,
  isBinaryRenderMode
} from '@slayzone/task/shared'
import { Markdown, MermaidBlock, MediaView } from '@slayzone/markdown/client'
import { useAppearance, getThemeEditorColors, type EditorThemeColors } from '@slayzone/ui'
import { useTheme } from '@slayzone/settings/client'
import {
  SearchableCodeView,
  type SearchableCodeViewHandle
} from '@slayzone/file-editor/client/SearchableCodeView'
import { EditorToc } from '@slayzone/file-editor/client/EditorToc'
import { type MarkdownHeading } from '@slayzone/file-editor/client/markdown-headings'
import type { ArtifactViewMode } from './ArtifactsPanel.types'

// --- Image viewer ---

function ImageViewer({
  artifactId,
  contentVersion,
  getFilePath
}: {
  artifactId: string
  contentVersion: number
  getFilePath: (id: string) => Promise<string | null>
}) {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    getFilePath(artifactId).then((p) => {
      if (p) setSrc(toSlzFileUrl(p, contentVersion))
    })
  }, [artifactId, contentVersion, getFilePath])

  if (!src)
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
        Loading...
      </div>
    )

  return (
    <div className="flex-1 relative bg-muted/20 overflow-hidden">
      <MediaView source={{ kind: 'image', src }} className="absolute inset-0" />
    </div>
  )
}

// --- PDF viewer ---

function PdfViewer({
  artifactId,
  contentVersion,
  getFilePath
}: {
  artifactId: string
  contentVersion: number
  getFilePath: (id: string) => Promise<string | null>
}) {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    getFilePath(artifactId).then((p) => {
      if (p) setSrc(toSlzFileUrl(p, contentVersion))
    })
  }, [artifactId, contentVersion, getFilePath])

  if (!src)
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
        Loading...
      </div>
    )

  return <iframe src={src} className="flex-1 w-full" title="PDF preview" />
}

// --- Artifact content editor ---

export function ArtifactContentEditor({
  artifact,
  viewMode,
  readContent,
  saveContent,
  getFilePath,
  effectiveReadability,
  effectiveWidth,
  searchQuery,
  searchActiveIndex,
  searchMatchCase,
  searchRegex,
  onSearchMatchCountChange
}: {
  artifact: TaskArtifact
  viewMode: ArtifactViewMode
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
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const getMtime = useCallback(
    (id: string): Promise<number | null> => trpcClient.artifacts.getMtime.query({ id }),
    [trpcClient]
  )
  const {
    notesFontFamily,
    notesCheckedHighlight,
    notesShowToolbar,
    notesSpellcheck,
    editorMinimapEnabled,
    editorTocEnabled
  } = useAppearance()
  const { editorThemeId, contentVariant } = useTheme()
  const themeColors: EditorThemeColors = useMemo(
    () => getThemeEditorColors(editorThemeId, contentVariant),
    [editorThemeId, contentVariant]
  )
  const themeStyle = useMemo(
    () =>
      ({
        '--mk-bg': themeColors.background,
        '--mk-fg': themeColors.foreground,
        '--mk-heading': themeColors.heading,
        '--mk-link': themeColors.link,
        '--mk-code-fg': themeColors.keyword,
        '--mk-code-bg': themeColors.selection,
        '--mk-quote-border': themeColors.comment,
        '--mk-hr-color': themeColors.comment
      }) as CSSProperties,
    [themeColors]
  )
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
    const [c, mtime] = await Promise.all([readContent(artifact.id), getMtime(artifact.id)])
    setContent(c ?? '')
    baselineMtimeRef.current = mtime
    setIsDirty(false)
    setExternalChangePending(false)
    setEditorReloadVersion((v) => v + 1)
    setPreviewVersion((v) => v + 1)
  }, [artifact.id, readContent, getMtime])

  // Load on mount / artifact change. Flush pending save on unmount (with mtime guard).
  useEffect(() => {
    if (isBinary) {
      setLoading(false)
      getMtime(artifact.id).then((m) => {
        baselineMtimeRef.current = m
      })
      setPreviewVersion((v) => v + 1)
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
  }, [artifact.id, isBinary, loadFromDisk, saveContent, getMtime])

  // fs.watch subscription — disk is the single source of truth for content.
  useSubscription(
    trpc.artifacts.onContentChanged.subscriptionOptions(undefined, {
      onData: (changedId) => {
        if (changedId !== artifact.id) return
        if (isDirtyRef.current) {
          setExternalChangePending(true)
        } else {
          loadFromDisk()
        }
      }
    })
  )

  // fs.watch can miss rapid writes on some platforms. Poll mtime while visible
  // so external changes still surface before an autosave can clobber them.
  useVisibleInterval(
    () => {
      if (isBinary) return
      void (async () => {
        const currentMtime = await getMtime(artifact.id)
        const baseline = baselineMtimeRef.current
        if (currentMtime == null) return
        if (baseline == null) {
          baselineMtimeRef.current = currentMtime
          return
        }
        if (currentMtime <= baseline) return
        if (isDirtyRef.current) {
          setExternalChangePending(true)
        } else {
          await loadFromDisk()
        }
      })()
    },
    1_000,
    { enabled: !isBinary }
  )

  const handleChange = useCallback(
    (value: string) => {
      setContent(value)
      setIsDirty(true)
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(async () => {
        saveTimerRef.current = null
        const currentMtime = await getMtime(artifact.id)
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
        const newMtime = await getMtime(artifact.id)
        baselineMtimeRef.current = newMtime
        setIsDirty(false)
        // Cache-bust preview iframes only. Editor must NOT see this bump or
        // CodeMirror replaceAll resets the caret mid-typing.
        setPreviewVersion((v) => v + 1)
      }, 500)
    },
    [artifact.id, saveContent, getMtime]
  )

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
    const newMtime = await getMtime(artifact.id)
    baselineMtimeRef.current = newMtime
    setIsDirty(false)
    setExternalChangePending(false)
  }, [artifact.id, saveContent, getMtime])

  const banner = externalChangePending ? (
    <div
      className="absolute bottom-3 right-3 z-10 flex items-center gap-2 rounded-md border border-border bg-amber-500/10 px-3 py-1.5 text-[11px] shadow-md backdrop-blur-sm"
      data-testid="artifact-conflict-banner"
    >
      <span className="text-muted-foreground">File changed externally.</span>
      <Button
        variant="outline"
        size="sm"
        className="!h-6 text-[10px] px-2"
        onClick={handleReloadFromDisk}
        data-testid="artifact-conflict-reload"
      >
        Reload
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="!h-6 text-[10px] px-2"
        onClick={handleKeepMine}
        data-testid="artifact-conflict-keep"
      >
        Keep mine
      </Button>
    </div>
  ) : null

  const inner = ((): React.ReactElement => {
    if (loading)
      return (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
          Loading...
        </div>
      )
    if (renderMode === 'image')
      return (
        <ImageViewer
          artifactId={artifact.id}
          contentVersion={previewVersion}
          getFilePath={getFilePath}
        />
      )
    if (renderMode === 'pdf')
      return (
        <PdfViewer
          artifactId={artifact.id}
          contentVersion={previewVersion}
          getFilePath={getFilePath}
        />
      )

    const hasPreview =
      renderMode === 'markdown' ||
      renderMode === 'html-preview' ||
      renderMode === 'svg-preview' ||
      renderMode === 'mermaid-preview'

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
            <div
              className="mk-doc"
              data-readability={effectiveReadability}
              data-width={effectiveWidth}
              style={themeStyle}
            >
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
      return (
        <div className="flex-1 flex flex-col overflow-hidden">
          <ArtifactPreview
            renderMode={renderMode}
            content={content ?? ''}
            artifactId={artifact.id}
            contentVersion={previewVersion}
            getFilePath={getFilePath}
          />
        </div>
      )
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
            <ArtifactPreview
              renderMode={renderMode}
              content={content ?? ''}
              artifactId={artifact.id}
              contentVersion={previewVersion}
              getFilePath={getFilePath}
            />
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

function ArtifactPreview({
  renderMode,
  content,
  artifactId,
  contentVersion,
  getFilePath
}: {
  renderMode: RenderMode
  content: string
  artifactId: string
  contentVersion: number
  getFilePath: (id: string) => Promise<string | null>
}) {
  if (renderMode === 'html-preview')
    return (
      <HtmlPreviewFrame
        artifactId={artifactId}
        contentVersion={contentVersion}
        getFilePath={getFilePath}
      />
    )
  if (renderMode === 'svg-preview')
    return (
      <div className="flex-1 min-h-0 overflow-hidden bg-muted/30 relative">
        <MediaView source={{ kind: 'svg', svg: content }} className="absolute inset-0" />
      </div>
    )
  if (renderMode === 'mermaid-preview' && content.trim())
    return <MermaidBlock code={content} fill />
  return null
}

// HTML preview via slz-file:// custom scheme (registered with bypassCSP +
// secure privileges). Cannot use srcDoc/blob/data URLs: parent renderer's CSP
// `script-src 'self'` is inherited by them and blocks inline + CDN scripts.
// slz-file gets its own origin and bypasses CSP so user HTML runs unmodified.
// `contentVersion` cache-busts on each save so the iframe reloads after edits.
function HtmlPreviewFrame({
  artifactId,
  contentVersion,
  getFilePath
}: {
  artifactId: string
  contentVersion: number
  getFilePath: (id: string) => Promise<string | null>
}) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    getFilePath(artifactId).then((p) => {
      if (p) setSrc(toSlzFileUrl(p, contentVersion))
    })
  }, [artifactId, contentVersion, getFilePath])
  if (!src)
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
        Loading...
      </div>
    )
  return (
    <iframe src={src} sandbox="allow-scripts" className="flex-1 bg-white" title="HTML preview" />
  )
}
