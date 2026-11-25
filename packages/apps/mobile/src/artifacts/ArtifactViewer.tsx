/**
 * One artifact, the way desktop's artifact viewer shows it, read-only: the viewer its
 * render mode picks (`viewerKindOf`) — markdown, code, HTML report, SVG, mermaid (each a
 * page in `DocumentWebView`), image (`ZoomableImage`), PDF — with desktop's controls
 * that fit a phone: Preview / Source for SVG and mermaid, the HTML colour scheme
 * (System → Dark → Light, saved on the artifact as on desktop), Zoom (desktop's steps,
 * saved on the artifact; on the surfaces desktop zooms: not images, PDFs or drawings,
 * which pinch-zoom), History (its versions;
 * picking one shows that version), Share (the iOS share sheet: save to Files, open
 * in another app, AirDrop…), and Export: the text on screen as PDF / PNG / HTML, the
 * formats desktop offers for its render mode, made on the phone (`export/`) and handed
 * to the share sheet.
 *
 * Must render inside the artifact's hub scope; everything it reads or writes goes to
 * that hub.
 */
import { nextHtmlTheme } from '@slayzone/platform/forced-html-theme'
import type { ArtifactVersion } from '@slayzone/task-artifacts/shared'
import { dbTimestampToIso, formatRelativeDate } from '@slayzone/task-artifacts/shared'
import {
  DEFAULT_ZOOM_PCT,
  getEffectiveRenderMode,
  hasZoomableSurface,
  stepZoom,
  type TaskArtifact,
  ZOOM_STEPS
} from '@slayzone/task-contracts/types'
import { useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ActionSheetIOS,
  ActivityIndicator,
  FlatList,
  type HostInstance,
  findNodeHandle,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Text,
  useWindowDimensions,
  View
} from 'react-native'
import { BottomSheet } from '../ui-kit/Chrome'
import { type ChromeColors, useTheme, useThemeVariant } from '../theme'
import { useTRPC, useTRPCClient } from '../trpc'
import { mediaPlayer } from './media-player'
import { DocumentWebView, type DocumentPage } from './DocumentWebView'
import { exportArtifact } from './export/export-artifact'
import { exportFormatsOf } from './export/export-formats'
import { useExportRenderer } from './export/use-export-renderer'
import { downloadArtifactFile } from './files'
import type { HubTarget } from './hub-rest'
import { loadHtml2canvasScript, loadMermaidScript } from './page-assets'
import { codePage } from './pages/code-page'
import { htmlReportPage } from './pages/html-report-page'
import { markdownNeedsMermaid, markdownPage } from './pages/markdown-page'
import { mermaidPage } from './pages/mermaid-page'
import type { PageTheme } from './pages/page-style'
import { pageAtZoom } from './pages/page-zoom'
import { svgPage } from './pages/svg-page'
import { HeaderButton, ScreenHeader } from './ScreenHeader'
import {
  useArtifactFile,
  useArtifactRow,
  useArtifactText,
  useArtifactVersions,
  useMermaidScript
} from './use-artifact'
import {
  extensionBadge,
  isFileKind,
  isMediaKind,
  isPlayableOnDevice,
  isShareOnlyKind,
  type ViewerKind,
  viewerKindOf
} from './viewer-kind'
import { ZoomableImage } from './ZoomableImage'

export interface ArtifactViewerProps {
  target: HubTarget
  taskId: string
  artifactId: string
  /** A version to show instead of the working copy (its number); null = the artifact. */
  version: number | null
  onSelectVersion: (version: number | null) => void
  /** An artifact link was tapped. */
  onOpenArtifact: (artifactId: string) => void
  /** Phone: back to where the artifact was opened from. */
  onBack?: () => void
  /** The back button's label: the screen it goes back to. */
  backLabel?: string
  /** Share/export presentations belong to the focused viewer. */
  active?: boolean
}

export function ArtifactViewer(props: ArtifactViewerProps) {
  const styles = makeStyles(useTheme())
  const { artifact, error, contentTick, retry } = useArtifactRow(props.taskId, props.artifactId)

  if (artifact) return <LoadedArtifact {...props} artifact={artifact} contentTick={contentTick} />
  return (
    <View style={styles.screen} testID="artifact-viewer">
      <ScreenHeader title="" onBack={props.onBack} backLabel={props.backLabel} />
      {artifact === null ? (
        <Text style={styles.note}>This artifact no longer exists.</Text>
      ) : error ? (
        <Center>
          <Text style={styles.note}>{error}</Text>
          <HeaderButton label="Retry" onPress={retry} />
        </Center>
      ) : (
        <Center>
          <ActivityIndicator testID="artifact-loading" />
        </Center>
      )}
    </View>
  )
}

type Body =
  | { kind: 'page'; page: DocumentPage }
  | { kind: 'image'; uri: string }
  | { kind: 'binary' }
  | { kind: 'too-large'; size: number }
  | { kind: 'media'; uri: string }
  | { kind: 'unsupported'; message: string }
  | { kind: 'loading' }
  | { kind: 'error'; message: string; retry: () => void }

function LoadedArtifact({
  target,
  artifact,
  contentTick,
  version,
  onSelectVersion,
  onOpenArtifact,
  onBack,
  backLabel,
  active = true
}: ArtifactViewerProps & { artifact: TaskArtifact; contentTick: number }) {
  const theme = useTheme()
  const variant = useThemeVariant()
  const styles = makeStyles(theme)
  const trpc = useTRPC()
  const hubClient = useTRPCClient()
  const queryClient = useQueryClient()

  const kind = viewerKindOf(artifact)
  const fileKind = isFileKind(kind)
  const mediaKind = isMediaKind(kind)
  const player = mediaKind ? mediaPlayer() : null
  // A container iOS can't play (WebM, Ogg) never reaches the player.
  const playable = !mediaKind || isPlayableOnDevice(artifact.title)
  // Played from the downloaded file when this build has the native player.
  const downloads = fileKind || (player !== null && playable)
  const shareOnly = isShareOnlyKind(kind) || (mediaKind && (player === null || !playable))
  // The file the player reported it can't play.
  const [unplayableUri, setUnplayableUri] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  // The button whose action sheet points at it on an iPad.
  const exportButton = useRef<HostInstance>(null)
  const [view, setView] = useState<'preview' | 'source'>(
    artifact.view_mode === 'raw' ? 'source' : 'preview'
  )
  const [shareState, setShareState] = useState<{ busy: boolean; error: string | null }>({
    busy: false,
    error: null
  })
  // Why saving the colour scheme failed (its own line: not Share's).
  const [themeError, setThemeError] = useState<string | null>(null)
  // The zoom being saved, shown until the row has it; null = the row's.
  const [zoomDraft, setZoomDraft] = useState<number | null>(null)
  const [zoomError, setZoomError] = useState<string | null>(null)
  const [exportState, setExportState] = useState<{
    busy: boolean
    error: string | null
    /** Something to know about the file just exported (not an error). */
    notice: string | null
  }>({ busy: false, error: null, notice: null })
  const exportRenderer = useExportRenderer()
  // The running export's abort: closing the viewer stops it, so its share sheet never
  // opens over another screen.
  const exportAbort = useRef<AbortController | null>(null)
  const shareAbort = useRef<AbortController | null>(null)
  const [presentation, setPresentation] = useState({ active, version })
  if (presentation.active !== active || presentation.version !== version) {
    setPresentation({ active, version })
    if (shareState.busy) setShareState({ busy: false, error: null })
    if (exportState.busy) setExportState({ busy: false, error: null, notice: null })
  }
  useLayoutEffect(
    () => () => {
      shareAbort.current?.abort()
      exportAbort.current?.abort()
    },
    [active, version]
  )
  const renderMode = getEffectiveRenderMode(artifact.title, artifact.render_mode)
  const exportFormats = fileKind ? [] : exportFormatsOf(renderMode)

  const versions = useArtifactVersions(artifact.id, showHistory || version !== null)
  const selected: ArtifactVersion | null =
    version === null ? null : (versions.data?.find((v) => v.version_num === version) ?? null)
  const versionReady = version === null || selected !== null

  const text = useArtifactText(artifact.id, selected, !downloads && !shareOnly && versionReady)
  const file = useArtifactFile(target, artifact, selected, contentTick, downloads && versionReady)
  const content = text.data?.kind === 'text' ? text.data.content : undefined
  const isText = content !== undefined
  const needsMermaid = useMemo(
    () =>
      content !== undefined &&
      ((kind === 'markdown' && markdownNeedsMermaid(content)) ||
        (kind === 'mermaid' && view === 'preview')),
    [content, kind, view]
  )
  const mermaid = useMermaidScript(needsMermaid)
  const pageTheme = useMemo<PageTheme>(() => ({ colors: theme, variant }), [theme, variant])

  // The page is the costly part (a diagram page carries the whole mermaid build): built
  // only when what it shows changes.
  const scheme = artifact.html_theme_override
  const ready = isText && !(needsMermaid && mermaid.data === undefined && mermaid.error === null)
  const page = useMemo(
    () =>
      ready && content !== undefined
        ? textPage(kind, content, view, scheme, pageTheme, mermaid.data ?? null)
        : null,
    [ready, kind, content, view, scheme, pageTheme, mermaid.data]
  )

  // Desktop's rule for what its zoom applies to, by what is on screen: a diff shows as
  // its source here.
  const zoomable = hasZoomableSurface(
    renderMode,
    view === 'source' || renderMode === 'diff' ? 'raw' : 'preview'
  )
  const zoomPct = zoomDraft ?? artifact.zoom_pct ?? DEFAULT_ZOOM_PCT
  const shownPage = useMemo(
    () => (page && zoomable ? pageAtZoom(page, zoomPct) : page),
    [page, zoomable, zoomPct]
  )

  let body: Body
  if (version !== null && !versionReady) {
    body = versions.error
      ? { kind: 'error', message: versions.error, retry: versions.retry }
      : versions.data
        ? {
            kind: 'error',
            message: `This artifact has no version ${version}.`,
            retry: versions.retry
          }
        : { kind: 'loading' }
  } else if (shareOnly) {
    body = {
      kind: 'unsupported',
      message: !mediaKind
        ? `${kind === 'font' ? 'Fonts' : 'Archives'} can't be shown in the app yet. Share it to open it in another app.`
        : player === null
          ? `This ${kind} can't be played in this build of the app. Share it to open it in another app.`
          : unplayableMessage()
    }
  } else if (downloads) {
    body = file.error
      ? { kind: 'error', message: file.error, retry: file.retry }
      : file.data === undefined
        ? { kind: 'loading' }
        : mediaKind
          ? file.data === unplayableUri
            ? { kind: 'unsupported', message: unplayableMessage() }
            : { kind: 'media', uri: file.data }
          : kind === 'image'
            ? { kind: 'image', uri: file.data }
            : { kind: 'page', page: { kind: 'file', fileUri: file.data } }
  } else if (text.error) {
    body = { kind: 'error', message: text.error, retry: text.retry }
  } else if (text.data?.kind === 'binary') {
    body = { kind: 'binary' }
  } else if (text.data?.kind === 'too-large') {
    body = { kind: 'too-large', size: text.data.size }
  } else {
    // Diagrams wait for the mermaid build; if it can't be read they show as code.
    body = shownPage ? { kind: 'page', page: shownPage } : { kind: 'loading' }
  }

  const share = () => {
    if (!active || !versionReady) return
    shareAbort.current?.abort()
    const { signal } = (shareAbort.current = new AbortController())
    setShareState({ busy: true, error: null })
    const ready =
      fileKind && file.data !== undefined
        ? Promise.resolve(file.data)
        : downloadArtifactFile(target, {
            artifact,
            version: selected
              ? { ref: selected.version_num, contentHash: selected.content_hash }
              : null,
            contentTick
          })
    ready
      .then((uri) => {
        if (!signal.aborted) return Share.share({ url: uri, title: artifact.title })
      })
      .then(() => {
        if (!signal.aborted) setShareState({ busy: false, error: null })
      })
      .catch((err: unknown) => {
        if (!signal.aborted) {
          setShareState({ busy: false, error: err instanceof Error ? err.message : String(err) })
        }
      })
  }

  // What is on screen: the working copy's text or the version's. Nothing while the
  // version picked is loading or missing, or the text failed to load: the screen shows
  // a spinner or an error then, and the cache may still hold another copy's text.
  const exportContent = versionReady && !text.error ? content : undefined
  const chooseExport = () => {
    if (!active || exportContent === undefined) return
    exportAbort.current?.abort()
    const abort = new AbortController()
    exportAbort.current = abort
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: 'Export',
        options: [...exportFormats.map((f) => f.label), 'Cancel'],
        cancelButtonIndex: exportFormats.length,
        // iPad: a popover from the button.
        anchor: anchorOf(exportButton.current)
      },
      (index) => {
        const choice = exportFormats[index]
        if (abort.signal.aborted) return
        if (!choice) {
          exportAbort.current = null
          return
        }
        setExportState({ busy: true, error: null, notice: null })
        exportArtifact(
          {
            content: exportContent,
            mode: renderMode,
            title: artifact.title,
            format: choice.format
          },
          {
            render: exportRenderer.render,
            mermaidScript: loadMermaidScript,
            html2canvasScript: loadHtml2canvasScript,
            signal: abort.signal,
            // Shown under the toolbar as soon as it is known: before the share sheet opens.
            onNotice: (notice) => {
              if (!abort.signal.aborted) setExportState((state) => ({ ...state, notice }))
            }
          }
        )
          .then(() => {
            if (!abort.signal.aborted) {
              setExportState((state) => ({ ...state, busy: false, error: null }))
            }
          })
          .catch((err: unknown) => {
            if (!abort.signal.aborted) {
              setExportState({
                busy: false,
                error: err instanceof Error ? err.message : String(err),
                notice: null
              })
            }
          })
          .then(() => {
            if (exportAbort.current === abort) exportAbort.current = null
          })
      }
    )
  }

  const htmlTheme = artifact.html_theme_override ?? 'system'
  const cycleHtmlTheme = () => {
    const next = nextHtmlTheme(htmlTheme)
    setThemeError(null)
    hubClient.artifacts.update
      .mutate({ id: artifact.id, htmlThemeOverride: next === 'system' ? null : next })
      .then(() =>
        queryClient.invalidateQueries(trpc.artifacts.get.queryFilter({ id: artifact.id }))
      )
      .catch((err: unknown) => setThemeError(err instanceof Error ? err.message : String(err)))
  }

  // Saved as desktop saves it: 100% as none.
  const saveZoom = (next: number) => {
    setZoomError(null)
    setZoomDraft(next)
    hubClient.artifacts.update
      .mutate({ id: artifact.id, zoomPct: next === DEFAULT_ZOOM_PCT ? null : next })
      .then(() =>
        queryClient.invalidateQueries(trpc.artifacts.get.queryFilter({ id: artifact.id }))
      )
      // A later step still saving stays shown.
      .then(() => setZoomDraft((draft) => (draft === next ? null : draft)))
      .catch((err: unknown) => {
        setZoomDraft(null)
        setZoomError(err instanceof Error ? err.message : String(err))
      })
  }

  const badge = extensionBadge(artifact.title)
  const actions = (
    <>
      {kind === 'svg' || kind === 'mermaid' ? (
        <>
          <HeaderButton
            label="Preview"
            active={view === 'preview'}
            onPress={() => setView('preview')}
          />
          <HeaderButton
            label="Source"
            active={view === 'source'}
            onPress={() => setView('source')}
          />
        </>
      ) : null}
      {kind === 'html' && version === null ? (
        <HeaderButton
          label={HTML_THEME_LABEL[htmlTheme]}
          accessibilityLabel={`Colour scheme: ${HTML_THEME_LABEL[htmlTheme]}`}
          onPress={cycleHtmlTheme}
        />
      ) : null}
      {zoomable ? (
        <View style={styles.zoom}>
          <HeaderButton
            label="−"
            accessibilityLabel="Zoom out"
            disabled={zoomPct <= ZOOM_STEPS[0]}
            onPress={() => saveZoom(stepZoom(zoomPct, -1))}
          />
          <HeaderButton
            label={`${zoomPct}%`}
            accessibilityLabel={`Reset zoom (${zoomPct}%)`}
            onPress={() => saveZoom(DEFAULT_ZOOM_PCT)}
          />
          <HeaderButton
            label="+"
            accessibilityLabel="Zoom in"
            disabled={zoomPct >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
            onPress={() => saveZoom(stepZoom(zoomPct, 1))}
          />
        </View>
      ) : null}
      <HeaderButton label="History" active={showHistory} onPress={() => setShowHistory(true)} />
      <HeaderButton
        label={shareState.busy ? 'Sharing…' : 'Share'}
        // The version picked is loading or missing: there is nothing of it to share
        // (the download would fall back to the working copy).
        disabled={shareState.busy || !versionReady}
        onPress={share}
      />
      {exportFormats.length > 0 ? (
        <HeaderButton
          ref={exportButton}
          label={exportState.busy ? 'Exporting…' : 'Export'}
          disabled={exportState.busy || exportContent === undefined}
          onPress={chooseExport}
        />
      ) : null}
    </>
  )

  return (
    <View style={styles.screen} testID="artifact-viewer">
      <ScreenHeader
        title={artifact.title}
        subtitle={[badge, formatRelativeDate(dbTimestampToIso(artifact.updated_at))]
          .filter(Boolean)
          .join(' · ')}
        onBack={onBack}
        backLabel={backLabel}
      />
      {/* Below the title, so a phone's narrow header keeps the title readable. */}
      <View style={styles.toolbar}>{actions}</View>
      {selected ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>
            Viewing v{selected.version_num}
            {selected.name ? ` · ${selected.name}` : ''}
          </Text>
          <Pressable onPress={() => onSelectVersion(null)} accessibilityRole="button" hitSlop={8}>
            <Text style={styles.bannerAction}>Back to current</Text>
          </Pressable>
        </View>
      ) : null}
      {shareState.error ? <Text style={styles.error}>{shareState.error}</Text> : null}
      {themeError ? <Text style={styles.error}>{themeError}</Text> : null}
      {zoomError ? <Text style={styles.error}>{zoomError}</Text> : null}
      {exportState.error ? <Text style={styles.error}>{exportState.error}</Text> : null}
      {exportState.notice ? <Text style={styles.notice}>{exportState.notice}</Text> : null}
      <View style={styles.body}>
        <ArtifactBody
          body={body}
          onOpenArtifact={onOpenArtifact}
          onShare={share}
          onUnplayable={setUnplayableUri}
          kind={kind}
        />
      </View>
      <BottomSheet
        visible={showHistory}
        onClose={() => setShowHistory(false)}
        testID="artifact-history-sheet"
      >
        <VersionsList
          artifact={artifact}
          versions={versions}
          selected={version}
          onClose={() => setShowHistory(false)}
          onSelect={(n) => {
            setShowHistory(false)
            onSelectVersion(n)
          }}
        />
      </BottomSheet>
      {exportRenderer.view}
    </View>
  )
}

const HTML_THEME_LABEL = { system: 'System', dark: 'Dark', light: 'Light' } as const

const unplayableMessage = (): string =>
  `Can't play this format on ${Platform.OS === 'ios' && Platform.isPad ? 'iPad' : 'iPhone'}. Share it to open it in another app.`

/** A view to point an iPad's action sheet (a popover) at; none on a phone. */
export function anchorOf(view: HostInstance | null): number | undefined {
  if (!view) return undefined
  return findNodeHandle(view) ?? undefined
}

/** The page for a text kind. */
function textPage(
  kind: ViewerKind,
  text: string,
  view: 'preview' | 'source',
  scheme: TaskArtifact['html_theme_override'],
  theme: PageTheme,
  mermaidScript: string | null
): DocumentPage {
  switch (kind) {
    case 'markdown': {
      const page = markdownPage(text, { theme, mermaidScript })
      return { kind: 'document', html: page.html, scripts: page.scripts }
    }
    case 'html': {
      // No scheme of its own: the app's (desktop's frame follows the app's theme too).
      const report = htmlReportPage(text, { forcedTheme: scheme ?? theme.variant })
      return { kind: 'report', html: report.html, token: report.token }
    }
    case 'svg':
      return {
        kind: 'document',
        html: view === 'preview' ? svgPage(text, theme) : codePage(text, theme),
        scripts: false
      }
    case 'mermaid':
      return view === 'preview' && mermaidScript !== null
        ? { kind: 'document', html: mermaidPage(text, { theme, mermaidScript }), scripts: true }
        : { kind: 'document', html: codePage(text, theme), scripts: false }
    default:
      return { kind: 'document', html: codePage(text, theme), scripts: false }
  }
}

function ArtifactBody({
  body,
  kind,
  onOpenArtifact,
  onShare,
  onUnplayable
}: {
  body: Body
  kind: ViewerKind
  onOpenArtifact: (id: string) => void
  onShare: () => void
  /** The player can't play the file at `uri`. */
  onUnplayable: (uri: string) => void
}) {
  const styles = makeStyles(useTheme())
  switch (body.kind) {
    case 'loading':
      return (
        <Center>
          <ActivityIndicator testID="artifact-loading" />
        </Center>
      )
    case 'error':
      return (
        <Center>
          <Text style={styles.note}>{body.message}</Text>
          <HeaderButton label="Retry" onPress={body.retry} />
        </Center>
      )
    case 'binary':
      return (
        <Center>
          <Text style={styles.note} testID="artifact-binary">
            This file isn't text, so it can't be shown here. Share it to open it in another app.
          </Text>
          <HeaderButton label="Share" onPress={onShare} />
        </Center>
      )
    case 'too-large':
      return (
        <Center>
          <Text style={styles.note} testID="artifact-too-large">
            This file is too large to preview ({formatBytes(body.size)}). Share it to open it in
            another app.
          </Text>
          <HeaderButton label="Share" onPress={onShare} />
        </Center>
      )
    case 'unsupported':
      return (
        <Center>
          <Text style={styles.note} testID="artifact-unsupported">
            {body.message}
          </Text>
          <HeaderButton label="Share" onPress={onShare} />
        </Center>
      )
    case 'media': {
      const Player = mediaPlayer()?.ArtifactMediaPlayer
      const uri = body.uri
      return Player ? (
        <Player uri={uri} testID="artifact-media" onUnplayable={() => onUnplayable(uri)} />
      ) : null
    }
    case 'image':
      return <ZoomableImage uri={body.uri} testID="artifact-image" />
    case 'page':
      return (
        <DocumentWebView
          page={body.page}
          onOpenArtifact={onOpenArtifact}
          testID={`artifact-page-${kind}`}
        />
      )
  }
}

const AUTHOR_LABEL = { user: 'Person', agent: 'Agent' } as const

function VersionsList({
  artifact,
  versions,
  selected,
  onSelect,
  onClose
}: {
  artifact: TaskArtifact
  versions: { data: ArtifactVersion[] | undefined; error: string | null; retry: () => void }
  selected: number | null
  onSelect: (version: number | null) => void
  onClose: () => void
}) {
  const styles = makeStyles(useTheme())
  const { height } = useWindowDimensions()
  let content: ReactNode
  if (versions.error) {
    content = (
      <View style={styles.historyError}>
        <Text style={styles.note}>{versions.error}</Text>
        <HeaderButton label="Retry" onPress={versions.retry} />
      </View>
    )
  } else if (!versions.data) content = <ActivityIndicator style={styles.historyLoading} />
  else if (versions.data.length === 0) content = <Text style={styles.note}>No versions yet.</Text>
  else {
    content = (
      <FlatList
        data={versions.data}
        keyExtractor={(v) => v.id}
        renderItem={({ item }) => {
          const current = item.id === artifact.current_version_id
          const shown = current ? selected === null : selected === item.version_num
          return (
            <Pressable
              testID={`artifact-version-${item.version_num}`}
              accessibilityRole="button"
              accessibilityState={{ selected: shown }}
              onPress={() => onSelect(current ? null : item.version_num)}
              style={[styles.version, shown ? styles.versionSelected : null]}
            >
              <View style={styles.versionLine}>
                <Text style={styles.versionNum}>Version {item.version_num}</Text>
                {item.name ? (
                  <Text style={styles.versionName} numberOfLines={1}>
                    {item.name}
                  </Text>
                ) : null}
                {current ? <Text style={styles.chip}>current</Text> : null}
              </View>
              <Text style={styles.versionMeta} numberOfLines={1}>
                {[
                  item.author_type ? AUTHOR_LABEL[item.author_type] : null,
                  formatRelativeDate(dbTimestampToIso(item.created_at)),
                  formatBytes(item.size)
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </Pressable>
          )
        }}
      />
    )
  }
  return (
    <View style={[styles.history, { maxHeight: height * 0.7 }]} testID="artifact-history">
      <View style={styles.historyHeader}>
        <Text style={styles.historyTitle} accessibilityRole="header">
          History
        </Text>
        <HeaderButton label="Done" onPress={onClose} />
      </View>
      {content}
    </View>
  )
}

/** A byte count as people read it: `12 KB`, `68.4 MB`. */
export function formatBytes(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return unit === 0
    ? `${value} bytes`
    : `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

function Center({ children }: { children: ReactNode }) {
  const styles = makeStyles(useTheme())
  return <View style={styles.center}>{children}</View>
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.background },
    body: { flex: 1 },
    toolbar: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    zoom: { flexDirection: 'row', gap: 4 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
    note: { color: t.mutedForeground, textAlign: 'center', padding: 24 },
    error: { color: t.destructive, paddingHorizontal: 16, paddingVertical: 6, fontSize: 13 },
    notice: { color: t.mutedForeground, paddingHorizontal: 16, paddingVertical: 6, fontSize: 13 },
    banner: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 8,
      backgroundColor: t.muted
    },
    bannerText: { color: t.foreground, fontSize: 13 },
    bannerAction: { color: t.foreground, fontSize: 13, fontWeight: '600' },
    history: { minHeight: 160 },
    historyHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingBottom: 8
    },
    historyTitle: { fontSize: 15, fontWeight: '600', color: t.foreground },
    historyLoading: { padding: 24 },
    historyError: { alignItems: 'center', gap: 12, padding: 16 },
    version: {
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    versionSelected: { backgroundColor: t.muted },
    versionLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    versionNum: { fontSize: 14, fontWeight: '600', color: t.foreground },
    versionName: { flexShrink: 1, fontSize: 14, color: t.foreground },
    versionMeta: { fontSize: 12, color: t.mutedForeground, marginTop: 2 },
    chip: {
      fontSize: 11,
      color: t.foreground,
      backgroundColor: t.muted,
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: 4,
      overflow: 'hidden'
    }
  })
