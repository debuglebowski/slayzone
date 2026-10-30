/**
 * One artifact, the way desktop's artifact viewer shows it, read-only: the viewer its
 * render mode picks (`viewerKindOf`) — markdown, code, HTML report, SVG, mermaid (each a
 * page in `DocumentWebView`), image (`ZoomableImage`), PDF — with desktop's controls
 * that fit a phone: Preview / Source for SVG and mermaid, the HTML colour scheme
 * (System → Dark → Light, saved on the artifact as on desktop), History (its versions;
 * picking one shows that version), and Share (the iOS share sheet: save to Files, open
 * in another app, AirDrop…).
 *
 * Must render inside the artifact's hub scope; everything it reads or writes goes to
 * that hub.
 */
import { nextHtmlTheme } from '@slayzone/platform/forced-html-theme'
import type { ArtifactVersion } from '@slayzone/task-artifacts/shared'
import { dbTimestampToIso, formatRelativeDate } from '@slayzone/task-artifacts/shared'
import type { TaskArtifact } from '@slayzone/task-contracts/types'
import { useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useMemo, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, Share, StyleSheet, Text, View } from 'react-native'
import { type ChromeColors, useTheme, useThemeVariant } from '../theme'
import { useTRPC, useTRPCClient } from '../trpc'
import { DocumentWebView, type DocumentPage } from './DocumentWebView'
import { downloadArtifactFile } from './files'
import type { HubTarget } from './hub-rest'
import { codePage } from './pages/code-page'
import { htmlReportPage } from './pages/html-report-page'
import { markdownNeedsMermaid, markdownPage } from './pages/markdown-page'
import { mermaidPage } from './pages/mermaid-page'
import type { PageTheme } from './pages/page-style'
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
  looksBinary,
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
  /** Phone: back to the list. */
  onBack?: () => void
}

export function ArtifactViewer(props: ArtifactViewerProps) {
  const styles = makeStyles(useTheme())
  const { artifact, error, contentTick } = useArtifactRow(props.taskId, props.artifactId)

  if (artifact) return <LoadedArtifact {...props} artifact={artifact} contentTick={contentTick} />
  return (
    <View style={styles.screen} testID="artifact-viewer">
      <ScreenHeader title="" onBack={props.onBack} backLabel="Artifacts" />
      {artifact === null ? (
        <Text style={styles.note}>This artifact no longer exists.</Text>
      ) : error ? (
        <Text style={styles.note}>{error}</Text>
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
  | { kind: 'loading' }
  | { kind: 'error'; message: string; retry: () => void }

function LoadedArtifact({
  target,
  artifact,
  contentTick,
  version,
  onSelectVersion,
  onOpenArtifact,
  onBack
}: ArtifactViewerProps & { artifact: TaskArtifact; contentTick: number }) {
  const theme = useTheme()
  const variant = useThemeVariant()
  const styles = makeStyles(theme)
  const trpc = useTRPC()
  const hubClient = useTRPCClient()
  const queryClient = useQueryClient()

  const kind = viewerKindOf(artifact)
  const fileKind = isFileKind(kind)
  const [showHistory, setShowHistory] = useState(false)
  const [view, setView] = useState<'preview' | 'source'>(
    artifact.view_mode === 'raw' ? 'source' : 'preview'
  )
  const [shareState, setShareState] = useState<{ busy: boolean; error: string | null }>({
    busy: false,
    error: null
  })

  const versions = useArtifactVersions(artifact.id, showHistory || version !== null)
  const selected: ArtifactVersion | null =
    version === null ? null : (versions.data?.find((v) => v.version_num === version) ?? null)
  const versionReady = version === null || selected !== null

  const text = useArtifactText(artifact.id, selected, !fileKind && versionReady)
  const file = useArtifactFile(target, artifact, selected, contentTick, fileKind && versionReady)
  const isText = text.data !== undefined && !looksBinary(text.data)
  const needsMermaid = useMemo(
    () =>
      isText &&
      ((kind === 'markdown' && markdownNeedsMermaid(text.data ?? '')) ||
        (kind === 'mermaid' && view === 'preview')),
    [isText, kind, view, text.data]
  )
  const mermaid = useMermaidScript(needsMermaid)
  const pageTheme = useMemo<PageTheme>(() => ({ colors: theme, variant }), [theme, variant])

  // The page is the costly part (a diagram page carries the whole mermaid build): built
  // only when what it shows changes.
  const scheme = artifact.html_theme_override
  const ready = isText && !(needsMermaid && mermaid.data === undefined && mermaid.error === null)
  const page = useMemo(
    () =>
      ready && text.data !== undefined
        ? textPage(kind, text.data, view, scheme, pageTheme, mermaid.data ?? null)
        : null,
    [ready, kind, text.data, view, scheme, pageTheme, mermaid.data]
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
  } else if (fileKind) {
    body = file.error
      ? { kind: 'error', message: file.error, retry: file.retry }
      : file.data === undefined
        ? { kind: 'loading' }
        : kind === 'image'
          ? { kind: 'image', uri: file.data }
          : { kind: 'page', page: { kind: 'file', fileUri: file.data } }
  } else if (text.error) {
    body = { kind: 'error', message: text.error, retry: text.retry }
  } else if (text.data !== undefined && !isText) {
    body = { kind: 'binary' }
  } else {
    // Diagrams wait for the mermaid build; if it can't be read they show as code.
    body = page ? { kind: 'page', page } : { kind: 'loading' }
  }

  const share = () => {
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
      .then((uri) => Share.share({ url: uri, title: artifact.title }))
      .then(() => setShareState({ busy: false, error: null }))
      .catch((err: unknown) =>
        setShareState({ busy: false, error: err instanceof Error ? err.message : String(err) })
      )
  }

  const htmlTheme = artifact.html_theme_override ?? 'system'
  const cycleHtmlTheme = () => {
    const next = nextHtmlTheme(htmlTheme)
    hubClient.artifacts.update
      .mutate({ id: artifact.id, htmlThemeOverride: next === 'system' ? null : next })
      .then(() =>
        queryClient.invalidateQueries(trpc.artifacts.get.queryFilter({ id: artifact.id }))
      )
      .catch((err: unknown) =>
        setShareState({ busy: false, error: err instanceof Error ? err.message : String(err) })
      )
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
      <HeaderButton
        label="History"
        active={showHistory}
        onPress={() => setShowHistory((s) => !s)}
      />
      <HeaderButton
        label={shareState.busy ? 'Sharing…' : 'Share'}
        disabled={shareState.busy}
        onPress={share}
      />
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
        backLabel="Artifacts"
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
      <View style={styles.body}>
        <ArtifactBody body={body} onOpenArtifact={onOpenArtifact} onShare={share} kind={kind} />
        {showHistory ? (
          <VersionsList
            artifact={artifact}
            versions={versions}
            selected={version}
            onSelect={(n) => {
              setShowHistory(false)
              onSelectVersion(n)
            }}
          />
        ) : null}
      </View>
    </View>
  )
}

const HTML_THEME_LABEL = { system: 'System', dark: 'Dark', light: 'Light' } as const

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
    case 'html':
      return { kind: 'report', html: htmlReportPage(text, { forcedTheme: scheme }) }
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
  onShare
}: {
  body: Body
  kind: ViewerKind
  onOpenArtifact: (id: string) => void
  onShare: () => void
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

function VersionsList({
  artifact,
  versions,
  selected,
  onSelect
}: {
  artifact: TaskArtifact
  versions: { data: ArtifactVersion[] | undefined; error: string | null; retry: () => void }
  selected: number | null
  onSelect: (version: number | null) => void
}) {
  const styles = makeStyles(useTheme())
  let content: ReactNode
  if (versions.error) content = <Text style={styles.note}>{versions.error}</Text>
  else if (!versions.data) content = <ActivityIndicator />
  else if (versions.data.length === 0) content = <Text style={styles.note}>No versions yet.</Text>
  else {
    content = (
      <FlatList
        data={versions.data}
        keyExtractor={(v) => v.id}
        renderItem={({ item }) => {
          const current = item.id === artifact.current_version_id
          return (
            <Pressable
              testID={`artifact-version-${item.version_num}`}
              accessibilityRole="button"
              onPress={() => onSelect(current ? null : item.version_num)}
              style={[
                styles.version,
                selected === item.version_num ? styles.versionSelected : null
              ]}
            >
              <View style={styles.versionLine}>
                <Text style={styles.versionNum}>v{item.version_num}</Text>
                <Text style={styles.versionHash}>{item.content_hash.slice(0, 7)}</Text>
                {current ? <Text style={styles.chip}>current</Text> : null}
              </View>
              <Text style={styles.versionMeta} numberOfLines={1}>
                {[
                  item.name,
                  item.author_type,
                  formatRelativeDate(dbTimestampToIso(item.created_at))
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
    <View style={styles.history} testID="artifact-history">
      <Text style={styles.historyTitle}>History</Text>
      {content}
    </View>
  )
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
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
    note: { color: t.mutedForeground, textAlign: 'center', padding: 24 },
    error: { color: t.destructive, paddingHorizontal: 16, paddingVertical: 6, fontSize: 13 },
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
    history: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      width: '100%',
      maxWidth: 360,
      backgroundColor: t.popover,
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderLeftColor: t.border
    },
    historyTitle: { fontSize: 15, fontWeight: '600', color: t.foreground, padding: 16 },
    version: {
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    versionSelected: { backgroundColor: t.muted },
    versionLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    versionNum: { fontSize: 14, fontWeight: '600', color: t.foreground },
    versionHash: { fontSize: 12, color: t.mutedForeground, fontFamily: 'Menlo' },
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
