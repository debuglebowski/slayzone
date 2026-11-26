import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  useInsertionEffect,
  type CSSProperties
} from 'react'
import { useHubId, useSubscription } from '@slayzone/transport/client'
import { useTRPC, useTRPCClient } from './trpc'
import { Button, useStableCallback, useVisibleInterval } from '@slayzone/ui'
import {
  RichTextEditor,
  resolveReadOnlyLinkClickTarget,
  usePdfViewerLinks,
  type LinkOpenTarget
} from '@slayzone/editor'
import { toArtifactFileUrl } from '@slayzone/platform/slz-file-url'
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
import {
  ARTIFACT_TEXT_MAX_BYTES,
  RICH_TEXT_MAX_BYTES,
  type ArtifactTextRead
} from '../shared/text-read'
import { Download, FileQuestion, Loader2 } from 'lucide-react'
import type { ArtifactViewMode } from './ArtifactsPanel.types'
import type { ArtifactDevicePreview } from './ArtifactDevicePicker'
import { HtmlPreviewFrame } from './ArtifactHtmlPreview'
import type { ArtifactControlsPosition } from '@slayzone/platform/artifact-controls'
import { parseArtifactControls } from './artifact-controls'
import { MediaPlayerViewer } from './MediaPlayerViewer'
import { ArchiveViewer } from './ArchiveViewer'
import { FontViewer } from './FontViewer'
import { DiffPreview } from './DiffPreview'
import { subtitlesFor } from './subtitles'
import type { HtmlArtifactTheme } from './ArtifactsPanel.constants'
import { formatByteSize } from './ArtifactsPanel.utils'

/** Why an artifact is not in a text editor: the server's verdict, or a failed read. */
type NotTextState = Exclude<ArtifactTextRead, { kind: 'text' }> | { kind: 'error'; message: string }

// --- Not shown as text ---

/**
 * In place of an editor for a file that is not opened as text. Never a text
 * surface: there is nothing to type into, so nothing can autosave over the file.
 */
function NotTextView({
  state,
  title,
  onDownload,
  onRetry
}: {
  state: NotTextState
  title: string
  onDownload?: () => void
  onRetry: () => void
}) {
  const [heading, detail] =
    state.kind === 'binary'
      ? [
          'No preview',
          `${title} is not UTF-8 text (${formatByteSize(state.size)}), so it can't be shown or edited here.`
        ]
      : state.kind === 'too-large'
        ? [
            `File too large (${formatByteSize(state.size)})`,
            `Files over ${formatByteSize(ARTIFACT_TEXT_MAX_BYTES)} aren't opened in the editor.`
          ]
        : ['Could not open this file', state.message]
  return (
    <div
      data-testid="artifact-no-preview"
      data-reason={state.kind}
      className="flex-1 flex items-center justify-center p-6 text-muted-foreground"
    >
      <div className="text-center space-y-3 max-w-sm">
        <FileQuestion className="size-8 mx-auto opacity-40" />
        <p className="text-sm text-foreground">{heading}</p>
        <p className="text-xs">{detail}</p>
        {state.kind === 'error' ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        ) : (
          onDownload && (
            <Button variant="outline" size="sm" onClick={onDownload}>
              <Download className="size-3.5 mr-1.5" />
              Download
            </Button>
          )
        )}
      </div>
    </div>
  )
}

// --- Image viewer ---

function ImagePreviewStatus({ failed = false }: { failed?: boolean }) {
  return (
    <div
      role="status"
      className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground"
    >
      {!failed && <Loader2 aria-hidden="true" className="size-3.5 motion-safe:animate-spin" />}
      {failed ? 'Could not load image preview' : 'Loading preview…'}
    </div>
  )
}

function ImageViewer({
  artifactId,
  contentVersion,
  getFilePath
}: {
  artifactId: string
  contentVersion: number
  getFilePath: (id: string) => Promise<string | null>
}) {
  const hubId = useHubId()
  const [preview, setPreview] = useState<{ version: number; src: string | null }>()

  useEffect(() => {
    let cancelled = false
    getFilePath(artifactId)
      .then((path) => {
        if (cancelled) return
        const src = path ? toArtifactFileUrl(hubId, artifactId, path, contentVersion) : null
        setPreview({ version: contentVersion, src })
      })
      .catch(() => {
        if (!cancelled) setPreview({ version: contentVersion, src: null })
      })
    return () => {
      cancelled = true
    }
  }, [hubId, artifactId, contentVersion, getFilePath])

  if (!preview?.src) return <ImagePreviewStatus failed={preview?.version === contentVersion} />

  return (
    <div className="flex-1 relative bg-muted/20 overflow-hidden">
      <MediaView
        source={{ kind: 'image', src: preview.src }}
        className="absolute inset-0"
        showImageLoadStatus
      />
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
  const hubId = useHubId()
  const [src, setSrc] = useState<string | null>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  usePdfViewerLinks(iframeRef, onOpenLink)

  useEffect(() => {
    getFilePath(artifactId).then((p) => {
      if (p) setSrc(toArtifactFileUrl(hubId, artifactId, p, contentVersion))
    })
  }, [hubId, artifactId, contentVersion, getFilePath])

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

/**
 * Run one write of the editor's own, counted in `saving`. A change event that
 * arrived meanwhile (`pending`) is judged once no write is in flight: before the
 * write has its new mtime, its own echo looks like an outside change.
 */
function countedSave(
  saving: { current: number },
  pending: { current: boolean },
  recheck: () => void,
  write: () => Promise<void>
): Promise<void> {
  saving.current++
  return write().finally(() => {
    saving.current--
    if (saving.current === 0 && pending.current) {
      pending.current = false
      recheck()
    }
  })
}

export function ArtifactContentEditor({
  artifact,
  siblingArtifacts,
  viewMode,
  readText,
  saveContent,
  getFilePath,
  effectiveReadability,
  effectiveWidth,
  zoomPct,
  htmlTheme,
  devicePreviews,
  showDeviceFrame,
  displayZoomPct = 100,
  onDisplayZoomPctChange,
  searchQuery,
  searchActiveIndex,
  searchMatchCase,
  searchRegex,
  onSearchMatchCountChange,
  onOpenUrl,
  onDownload,
  readOnly = false
}: {
  artifact: TaskArtifact
  /** The task's artifacts (a video's same-named `.srt`/`.vtt` become its subtitles). */
  siblingArtifacts?: readonly TaskArtifact[]
  viewMode: ArtifactViewMode
  /** Fresh disk read: the text, or why it is not shown as text. */
  readText: (id: string) => Promise<ArtifactTextRead | null>
  saveContent: (id: string, content: string) => Promise<void>
  getFilePath: (id: string) => Promise<string | null>
  effectiveReadability: 'compact' | 'normal'
  effectiveWidth: 'narrow' | 'wide'
  zoomPct: number
  htmlTheme: HtmlArtifactTheme
  devicePreviews?: readonly ArtifactDevicePreview[]
  showDeviceFrame?: boolean
  /** Device previews only: the page's zoom inside the device; `zoomPct` scales the device. */
  displayZoomPct?: number
  /** Absent: the canvas shows no display zoom control. */
  onDisplayZoomPctChange?: (pct: number) => void
  searchQuery: string
  searchActiveIndex: number
  searchMatchCase: boolean
  searchRegex: boolean
  onSearchMatchCountChange: (count: number) => void
  /** ⌘-clicked links (markdown, PDF, HTML): open in the task's in-app browser. */
  onOpenUrl?: (url: string) => void
  /** Save the file elsewhere: offered where the artifact is not shown as text. */
  onDownload?: () => void
  /** Shown, never changed (a View member, T-100). */
  readOnly?: boolean
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
  // Set when the last disk read is not shown as text (binary, too large, failed):
  // then there is no text surface at all, so nothing can autosave over the file.
  const [notText, setNotText] = useState<NotTextState | null>(null)
  // Byte size of the text as last read from disk. Not updated by typing, so the
  // rich-text/source choice below never flips under the user mid-edit.
  const [diskSize, setDiskSize] = useState(0)
  // The user asked for rich text on a markdown file over RICH_TEXT_MAX_BYTES.
  const [richTextAnyway, setRichTextAnyway] = useState(false)
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
  const [controls, setControls] = useState<readonly ArtifactControlsPosition[]>([])
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const baselineMtimeRef = useRef<number | null>(null)
  // Saves in flight, and whether a change event arrived during one. The watcher
  // reports the editor's OWN writes too: read before the save has its new mtime,
  // that echo looked like an outside write (false conflict, or a reload over keys
  // typed meanwhile). Checked once the save is done instead.
  const savingRef = useRef(0)
  const recheckAfterSaveRef = useRef(false)
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
  // A binary preview waits for its first cache-bust version (set once the mtime
  // baseline is in, below), so it loads once instead of at v0 and again at v1.
  const loading = isBinary ? previewVersion === 0 : loadedId !== artifact.id

  const refreshTextPreview = useCallback(
    (savedContent: string) => {
      if (renderMode === 'html-preview') {
        setControls(parseArtifactControls(savedContent))
      }
      setPreviewVersion((v) => v + 1)
    },
    [renderMode]
  )

  // Read file + mtime from disk. Pure: callers apply the result.
  const readFromDisk = useCallback(
    (): Promise<[ArtifactTextRead | null, number | null]> =>
      Promise.all([readText(artifact.id), getMtime(artifact.id)]),
    [artifact.id, readText, getMtime]
  )
  // Show a disk read + refresh baseline mtime. Clears dirty + pending flags.
  const applyDisk = useCallback(
    ([read, mtime]: [ArtifactTextRead | null, number | null]): void => {
      const savedContent = read?.kind === 'text' ? read.content : ''
      if (read && read.kind !== 'text') {
        setNotText(read)
        setContent(null)
      } else {
        setNotText(null)
        setContent(savedContent)
        setDiskSize(read?.size ?? 0)
      }
      baselineMtimeRef.current = mtime
      setIsDirty(false)
      setExternalChangePending(false)
      setEditorReloadVersion((v) => v + 1)
      refreshTextPreview(savedContent)
    },
    [refreshTextPreview]
  )
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
      .catch((e: unknown) => {
        // Never an empty editor in place of text that failed to load: its first
        // autosave would write '' over the file. Text already shown stays.
        if (!cancelled && contentRef.current === null)
          setNotText({
            kind: 'error',
            message: e instanceof Error ? e.message : 'The file could not be read.'
          })
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

  // fs.watch subscription — disk is the single source of truth for content. The
  // version this editor last wrote or read (its baseline mtime) is no change: that
  // is the echo of its own save.
  const handleContentChanged = useStableCallback((changedId: string) => {
    if (changedId !== artifact.id) return
    if (savingRef.current > 0) {
      recheckAfterSaveRef.current = true
      return
    }
    void (async () => {
      const currentMtime = await getMtime(artifact.id)
      if (savingRef.current > 0) {
        recheckAfterSaveRef.current = true
        return
      }
      if (currentMtime != null && currentMtime === baselineMtimeRef.current) return
      if (isDirtyRef.current) {
        setExternalChangePending(true)
      } else {
        await loadFromDisk()
      }
    })()
  })
  const recheckAfterSave = useStableCallback(() => handleContentChanged(artifact.id))
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
        // Mid-save the new mtime is ours, before the baseline has it.
        if (savingRef.current > 0) return
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
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null
        void countedSave(savingRef, recheckAfterSaveRef, recheckAfterSave, async () => {
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
          // Clean only if nothing was typed during the save: newer keys are still
          // unsaved (their own debounced save is pending).
          if (contentRef.current === value) setIsDirty(false)
          // Cache-bust preview iframes only. Editor must NOT see this bump or
          // CodeMirror replaceAll resets the caret mid-typing.
          refreshTextPreview(value)
        })
      }, 500)
    },
    [artifact.id, saveContent, getMtime, recheckAfterSave, refreshTextPreview]
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
    const draft = contentRef.current
    if (draft == null) return
    await countedSave(savingRef, recheckAfterSaveRef, recheckAfterSave, async () => {
      await saveContent(artifact.id, draft)
      const newMtime = await getMtime(artifact.id)
      baselineMtimeRef.current = newMtime
      setIsDirty(false)
      setExternalChangePending(false)
      if (renderMode === 'html-preview') refreshTextPreview(draft)
    })
  }, [artifact.id, saveContent, getMtime, recheckAfterSave, renderMode, refreshTextPreview])

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

  const handleRetry = useStableCallback((): void => {
    readFromDisk()
      .then(applyDisk)
      .catch((e: unknown) =>
        setNotText({
          kind: 'error',
          message: e instanceof Error ? e.message : 'The file could not be read.'
        })
      )
  })

  // Markdown over RICH_TEXT_MAX_BYTES opens as source: Milkdown (and the split
  // view's rendered pane) parses and lays out the whole document on the UI thread,
  // which froze the window for seconds and crashed the renderer at 2 MB.
  const sourceOnly = renderMode === 'markdown' && diskSize > RICH_TEXT_MAX_BYTES && !richTextAnyway
  const shownViewMode: ArtifactViewMode = sourceOnly ? 'raw' : viewMode
  const largeDocNotice =
    sourceOnly && viewMode !== 'raw' ? (
      <div
        data-testid="artifact-large-doc-notice"
        className="shrink-0 flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground"
      >
        <span className="min-w-0">
          Large document ({formatByteSize(diskSize)}): showing the source. Rich text may freeze the
          app while it loads.
        </span>
        <Button
          variant="outline"
          size="sm"
          className="!h-6 text-[10px] px-2 ml-auto shrink-0"
          onClick={() => setRichTextAnyway(true)}
          data-testid="artifact-large-doc-open-rich"
        >
          Open as rich text anyway
        </Button>
      </div>
    ) : null

  const inner = ((): React.ReactElement => {
    if (loading && renderMode === 'image') return <ImagePreviewStatus />
    if (loading)
      return (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
          Loading...
        </div>
      )
    if (notText)
      return (
        <NotTextView
          state={notText}
          title={artifact.title}
          onDownload={onDownload}
          onRetry={handleRetry}
        />
      )
    if (renderMode === 'image')
      return (
        <ImageViewer
          artifactId={artifact.id}
          contentVersion={previewVersion}
          getFilePath={getFilePath}
        />
      )
    if (renderMode === 'video' || renderMode === 'audio')
      return (
        <MediaPlayerViewer
          kind={renderMode}
          artifactId={artifact.id}
          contentVersion={previewVersion}
          getFilePath={getFilePath}
          subtitles={
            renderMode === 'video' ? subtitlesFor(artifact, siblingArtifacts ?? []) : undefined
          }
          readSubtitle={(id) => readText(id).then((r) => (r?.kind === 'text' ? r.content : null))}
        />
      )
    if (renderMode === 'archive')
      return <ArchiveViewer artifactId={artifact.id} contentVersion={previewVersion} />
    if (renderMode === 'font')
      return <FontViewer artifactId={artifact.id} contentVersion={previewVersion} />
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
      renderMode === 'mermaid-preview' ||
      renderMode === 'diff'

    if (renderMode === 'markdown' && shownViewMode === 'preview') {
      return (
        <ZoomPane zoom={zoom}>
          <RichTextEditor
            className="flex-1 min-h-0"
            value={content ?? ''}
            onChange={handleChange}
            readOnly={readOnly}
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

    if (renderMode === 'markdown' && shownViewMode === 'split') {
      return (
        <ZoomPane zoom={zoom}>
          <div className="flex-1 flex flex-row overflow-hidden">
            <div className="flex-1 min-w-0">
              <SearchableCodeView
                ref={splitCodeRef}
                value={content ?? ''}
                onChange={handleChange}
                readOnly={readOnly}
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
    if (hasPreview && shownViewMode === 'preview') {
      return (
        <div className="flex-1 flex flex-col overflow-hidden">
          <ArtifactPreview
            renderMode={renderMode}
            content={content ?? ''}
            controls={controls}
            artifactId={artifact.id}
            contentVersion={previewVersion}
            getFilePath={getFilePath}
            zoom={zoom}
            htmlTheme={htmlTheme}
            devicePreviews={devicePreviews}
            showDeviceFrame={showDeviceFrame}
            displayZoomPct={displayZoomPct}
            onDisplayZoomPctChange={onDisplayZoomPctChange}
            onOpenLink={handleOpenLink}
          />
        </div>
      )
    }

    if (hasPreview && shownViewMode === 'split') {
      return (
        <div className="flex-1 flex flex-row overflow-hidden">
          <ZoomPane zoom={zoom}>
            <SearchableCodeView
              value={content ?? ''}
              onChange={handleChange}
              readOnly={readOnly}
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
              controls={controls}
              artifactId={artifact.id}
              contentVersion={previewVersion}
              getFilePath={getFilePath}
              zoom={zoom}
              htmlTheme={htmlTheme}
              devicePreviews={devicePreviews}
              showDeviceFrame={showDeviceFrame}
              displayZoomPct={displayZoomPct}
              onDisplayZoomPctChange={onDisplayZoomPctChange}
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
          readOnly={readOnly}
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
    if (shownViewMode === 'preview') {
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
        {largeDocNotice}
        {inner}
        {banner}
      </div>
      {showToc && (
        <EditorToc
          content={content ?? ''}
          width={tocWidth}
          onWidthChange={setTocWidth}
          onJump={handleTocJump}
          minimapVisible={editorMinimapEnabled && shownViewMode !== 'preview'}
        />
      )}
    </div>
  )
}

// --- Preview pane ---

function ArtifactPreview({
  renderMode,
  content,
  controls,
  artifactId,
  contentVersion,
  getFilePath,
  zoom,
  htmlTheme,
  devicePreviews,
  showDeviceFrame,
  displayZoomPct,
  onDisplayZoomPctChange,
  onOpenLink
}: {
  renderMode: RenderMode
  content: string
  controls: readonly ArtifactControlsPosition[]
  artifactId: string
  contentVersion: number
  getFilePath: (id: string) => Promise<string | null>
  zoom: number
  htmlTheme: HtmlArtifactTheme
  devicePreviews?: readonly ArtifactDevicePreview[]
  showDeviceFrame?: boolean
  displayZoomPct: number
  onDisplayZoomPctChange?: (pct: number) => void
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
        controls={controls}
        getFilePath={getFilePath}
        zoom={zoom}
        htmlTheme={htmlTheme}
        devicePreviews={devicePreviews}
        showDeviceFrame={showDeviceFrame}
        displayZoomPct={displayZoomPct}
        onDisplayZoomPctChange={onDisplayZoomPctChange}
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
  if (renderMode === 'diff') return <DiffPreview content={content} />
  return null
}
