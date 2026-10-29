import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  useInsertionEffect,
  type CSSProperties
} from 'react'
import { useSubscription } from '@slayzone/transport/client'
import { useTRPC, useTRPCClient } from './trpc'
import { Button, useStableCallback, useVisibleInterval } from '@slayzone/ui'
import {
  RichTextEditor,
  resolveReadOnlyLinkClickTarget,
  usePdfViewerLinks,
  useHtmlPreviewLinks,
  type LinkOpenTarget
} from '@slayzone/editor'
import { toSlzFileUrl } from '@slayzone/platform/slz-file-url'
import type { EditorView as CMEditorView } from '@codemirror/view'
import type { RenderMode, TaskArtifact } from '@slayzone/task-contracts'
import {
  getEffectiveRenderMode,
  getExtensionFromTitle,
  isBinaryRenderMode
} from '@slayzone/task-contracts'
import { Markdown, MermaidBlock, MediaView } from '@slayzone/markdown/client'
import { useAppearance, useTheme, getThemeEditorColors, type EditorThemeColors } from '@slayzone/ui'
import {
  SearchableCodeView,
  type SearchableCodeViewHandle
} from '@slayzone/file-editor/client/SearchableCodeView'
import { EditorToc } from '@slayzone/file-editor/client/EditorToc'
import { type MarkdownHeading } from '@slayzone/file-editor/client/markdown-headings'
import type { ArtifactViewMode } from './ArtifactsPanel.types'
import type { HtmlArtifactTheme } from './ArtifactsPanel.constants'

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
  getFilePath,
  onOpenLink
}: {
  artifactId: string
  contentVersion: number
  getFilePath: (id: string) => Promise<string | null>
  onOpenLink: (href: string, target: LinkOpenTarget) => void
}) {
  const [src, setSrc] = useState<string | null>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  usePdfViewerLinks(iframeRef, onOpenLink)

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

  return <iframe ref={iframeRef} src={src} className="flex-1 w-full" title="PDF preview" />
}

// --- Zoom ---

/**
 * CSS-zoom container for document surfaces (rich text, CodeMirror, rendered
 * markdown).
 *
 * `zoom`, not `transform: scale`: zoom is a layout-level scale, so the content
 * REFLOWS the way browser zoom does — line wrapping, CodeMirror's own rect
 * measurement and the scrollbars all stay in one coordinate space, instead of a
 * rasterized bitmap stretched over a differently-sized layout box.
 *
 * The inner absolute layer keeps the zoomed box out of the parent's flex
 * sizing: a zoomed flex *item* gets its base size resolved in the parent's
 * (unzoomed) space and is then scaled, overflowing by the zoom factor. Against
 * an absolute containing block the insets resolve inside the zoomed space, so
 * the pane fills its parent exactly at any zoom.
 *
 * Rendered unconditionally — including at zoom 1 — so stepping through 100%
 * never changes the element tree under the editors, which would remount them
 * and drop caret/scroll state.
 */
function ZoomPane({ zoom, children }: { zoom: number; children: React.ReactNode }) {
  return (
    <div className="relative flex-1 flex flex-col min-h-0 min-w-0">
      <div
        className="absolute inset-0 flex flex-col"
        style={{ zoom }}
        data-testid="artifact-zoom-pane"
      >
        {children}
      </div>
    </div>
  )
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
  zoomPct,
  htmlTheme,
  searchQuery,
  searchActiveIndex,
  searchMatchCase,
  searchRegex,
  onSearchMatchCountChange,
  onOpenUrl
}: {
  artifact: TaskArtifact
  viewMode: ArtifactViewMode
  readContent: (id: string) => Promise<string | null>
  saveContent: (id: string, content: string) => Promise<void>
  getFilePath: (id: string) => Promise<string | null>
  effectiveReadability: 'compact' | 'normal'
  effectiveWidth: 'narrow' | 'wide'
  zoomPct: number
  htmlTheme: HtmlArtifactTheme
  searchQuery: string
  searchActiveIndex: number
  searchMatchCase: boolean
  searchRegex: boolean
  onSearchMatchCountChange: (count: number) => void
  /** ⌘-clicked links (markdown, PDF, HTML): open in the task's in-app browser. */
  onOpenUrl?: (url: string) => void
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
  // Which artifact's text `content` holds. "Loading" is derived from it, so it
  // is shown only until an artifact's text first arrives — never on a tab
  // re-show, where the editor must stay mounted (caret, scroll, undo).
  const [loadedId, setLoadedId] = useState<string | null>(null)
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
  // Latest-value mirrors for the unmount flush, subscription and save timers.
  // Insertion effects run first in commit, before any layout/passive effect or
  // cleanup that reads them.
  useInsertionEffect(() => {
    contentRef.current = content
    isDirtyRef.current = isDirty
  })
  const fileExt = getExtensionFromTitle(artifact.title) || undefined

  const renderMode = getEffectiveRenderMode(artifact.title, artifact.render_mode)
  const isBinary = isBinaryRenderMode(renderMode)
  const zoom = zoomPct / 100
  const loading = !isBinary && loadedId !== artifact.id

  // Read file + mtime from disk. Pure: callers apply the result.
  const readFromDisk = useCallback(
    (): Promise<[string | null, number | null]> =>
      Promise.all([readContent(artifact.id), getMtime(artifact.id)]),
    [artifact.id, readContent, getMtime]
  )
  // Show a disk read + refresh baseline mtime. Clears dirty + pending flags.
  const applyDisk = useCallback(([c, mtime]: [string | null, number | null]): void => {
    setContent(c ?? '')
    baselineMtimeRef.current = mtime
    setIsDirty(false)
    setExternalChangePending(false)
    setEditorReloadVersion((v) => v + 1)
    setPreviewVersion((v) => v + 1)
  }, [])
  const loadFromDisk = useCallback(
    (): Promise<void> => readFromDisk().then(applyDisk),
    [readFromDisk, applyDisk]
  )

  // Load on mount / artifact change / tab show. Flush pending save on unmount or
  // hide (with mtime guard). A read that lands after the artifact changed or the
  // tab hid is dropped: it would show (and the next autosave would write) the
  // previous artifact's text under the new one.
  useEffect(() => {
    const id = artifact.id
    let cancelled = false
    if (isBinary) {
      // Cache-bust the preview once the baseline is in (or failed), so it
      // re-reads the file on every show.
      getMtime(id)
        .then(
          (m) => {
            if (!cancelled) baselineMtimeRef.current = m
          },
          () => undefined
        )
        .then(() => {
          if (!cancelled) setPreviewVersion((v) => v + 1)
        })
      return () => {
        cancelled = true
      }
    }
    readFromDisk()
      .then((disk) => {
        if (!cancelled) applyDisk(disk)
      })
      .finally(() => {
        if (!cancelled) setLoadedId(id)
      })
    return () => {
      cancelled = true
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
  }, [artifact.id, isBinary, readFromDisk, applyDisk, saveContent, getMtime])

  // fs.watch subscription — disk is the single source of truth for content.
  const handleContentChanged = useStableCallback((changedId: string) => {
    if (changedId !== artifact.id) return
    if (isDirtyRef.current) {
      setExternalChangePending(true)
    } else {
      loadFromDisk()
    }
  })
  useSubscription(
    trpc.artifacts.onContentChanged.subscriptionOptions(undefined, {
      onData: handleContentChanged
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

  const handleOpenLink = useStableCallback((href: string, target: LinkOpenTarget) => {
    if (target === 'in-app-browser' && onOpenUrl) onOpenUrl(href)
    else void trpcClient.app.shell.openExternal.mutate({ url: href })
  })

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
          onOpenLink={handleOpenLink}
        />
      )

    const hasPreview =
      renderMode === 'markdown' ||
      renderMode === 'html-preview' ||
      renderMode === 'svg-preview' ||
      renderMode === 'mermaid-preview'

    if (renderMode === 'markdown' && viewMode === 'preview') {
      return (
        <ZoomPane zoom={zoom}>
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
            onOpenLink={handleOpenLink}
          />
        </ZoomPane>
      )
    }

    if (renderMode === 'markdown' && viewMode === 'split') {
      return (
        <ZoomPane zoom={zoom}>
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
                // Never let a preview anchor navigate the app window itself.
                const anchor = (e.target as HTMLElement).closest('a[href]')
                if (anchor) {
                  e.preventDefault()
                  const href = anchor.getAttribute('href') ?? ''
                  const target = resolveReadOnlyLinkClickTarget(href, e)
                  if (target) handleOpenLink(href, target)
                  return
                }
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
        </ZoomPane>
      )
    }

    // Preview-only: the HTML frame scales itself (see HtmlPreviewFrame); the SVG
    // and mermaid canvases own their zoom via MediaView, so no ZoomPane here.
    if (hasPreview && viewMode === 'preview') {
      return (
        <div className="flex-1 flex flex-col overflow-hidden">
          <ArtifactPreview
            renderMode={renderMode}
            content={content ?? ''}
            artifactId={artifact.id}
            contentVersion={previewVersion}
            getFilePath={getFilePath}
            zoom={zoom}
            htmlTheme={htmlTheme}
            onOpenLink={handleOpenLink}
          />
        </div>
      )
    }

    if (hasPreview && viewMode === 'split') {
      return (
        <div className="flex-1 flex flex-row overflow-hidden">
          <ZoomPane zoom={zoom}>
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
          </ZoomPane>
          <div className="flex-1 flex flex-col border-l border-border overflow-hidden min-w-0">
            <ArtifactPreview
              renderMode={renderMode}
              content={content ?? ''}
              artifactId={artifact.id}
              contentVersion={previewVersion}
              getFilePath={getFilePath}
              zoom={zoom}
              htmlTheme={htmlTheme}
              onOpenLink={handleOpenLink}
            />
          </div>
        </div>
      )
    }

    return (
      <ZoomPane zoom={zoom}>
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
      </ZoomPane>
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
  getFilePath,
  zoom,
  htmlTheme,
  onOpenLink
}: {
  renderMode: RenderMode
  content: string
  artifactId: string
  contentVersion: number
  getFilePath: (id: string) => Promise<string | null>
  zoom: number
  htmlTheme: HtmlArtifactTheme
  onOpenLink: (href: string, target: LinkOpenTarget) => void
}) {
  if (renderMode === 'html-preview')
    return (
      // Keyed on the identity of what is being previewed (theme included), so
      // switching artifacts, saving a new version, or toggling the theme
      // REMOUNTS the frame with fresh state instead of the effect having to
      // reset it — which is both the idiomatic reset and what keeps a
      // previous artifact's resolved path or error off the new one.
      <HtmlPreviewFrame
        key={`${artifactId}:${contentVersion}:${htmlTheme}`}
        artifactId={artifactId}
        contentVersion={contentVersion}
        getFilePath={getFilePath}
        zoom={zoom}
        htmlTheme={htmlTheme}
        onOpenLink={onOpenLink}
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
//
// `htmlTheme` rides the same URL as a `?theme=` param (see `toSlzFileUrl`):
// the sandbox (no `allow-same-origin`) also means the parent can't reach
// `contentDocument` to force a color scheme at runtime, so a forced theme is
// injected as CSS into the response body by the main-process slz-file
// handler instead, before the bytes ever reach this frame.
//
// Zoom cannot go through CSS `zoom` here the way it does for the DOM panes: the
// frame is a separate document on its own origin behind `sandbox`, so the parent
// can neither restyle it nor rely on a layout-scale crossing the frame boundary.
// Shrinking the frame's layout viewport by the zoom factor and scaling the
// element back up by the same factor reproduces browser zoom exactly — the inner
// document reflows to the narrower viewport, then paints enlarged.
function HtmlPreviewFrame({
  artifactId,
  contentVersion,
  getFilePath,
  zoom,
  htmlTheme,
  onOpenLink
}: {
  artifactId: string
  contentVersion: number
  getFilePath: (id: string) => Promise<string | null>
  zoom: number
  htmlTheme: HtmlArtifactTheme
  onOpenLink: (href: string, target: LinkOpenTarget) => void
}) {
  const [src, setSrc] = useState<string | null>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  // Links: the sandbox drops popups and a bare click would navigate the preview
  // itself — main's bridge relays them here instead (html-preview-links.ts).
  useHtmlPreviewLinks(iframeRef, onOpenLink)
  // `null` while in flight or resolved; a string once the path could not be
  // resolved. Previously there was no error branch at all: `getFilePath` had no
  // `.catch` and no null handling, so a rejection OR a null path left `src` null
  // forever and the pane sat on "Loading..." with no retry and no way to tell a
  // slow load from a dead one. That indefinite state is what the e2e preview
  // "flake" was — it never resolved, so no timeout could have saved it.
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    // Guard the late resolution. The `key` at the call site already remounts this
    // component per artifact/version, so there is no state to reset here; this
    // covers the remaining in-mount case (a `Retry` issued while the previous
    // lookup is still in flight).
    let cancelled = false
    getFilePath(artifactId)
      .then((p) => {
        if (cancelled) return
        if (p)
          setSrc(toSlzFileUrl(p, contentVersion, htmlTheme === 'system' ? undefined : htmlTheme))
        else setError('This artifact has no file on disk yet.')
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Could not load the preview.')
      })
    return () => {
      cancelled = true
    }
  }, [artifactId, contentVersion, getFilePath, htmlTheme, attempt])

  if (error)
    return (
      <div
        data-testid="html-preview-error"
        className="flex-1 flex flex-col items-center justify-center gap-2 text-xs text-muted-foreground"
      >
        <span className="text-destructive">{error}</span>
        <button
          type="button"
          className="underline hover:text-foreground"
          onClick={() => setAttempt((n) => n + 1)}
        >
          Retry
        </button>
      </div>
    )
  if (!src)
    return (
      <div
        data-testid="html-preview-loading"
        className="flex-1 flex items-center justify-center text-xs text-muted-foreground"
      >
        Loading...
      </div>
    )
  return (
    <div className="relative flex-1 min-h-0 min-w-0 overflow-hidden bg-white">
      <iframe
        ref={iframeRef}
        src={src}
        sandbox="allow-scripts"
        className="absolute top-0 left-0 border-0"
        style={{
          width: `${100 / zoom}%`,
          height: `${100 / zoom}%`,
          transform: `scale(${zoom})`,
          transformOrigin: '0 0'
        }}
        title="HTML preview"
      />
    </div>
  )
}
