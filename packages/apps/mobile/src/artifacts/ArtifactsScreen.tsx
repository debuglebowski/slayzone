/**
 * A task's artifacts: the tree desktop's panel shows (folders first, then artifacts, by
 * name; folders collapsible, open at first), live, plus Upload (photos, camera, files) to
 * the task's hub. Phone: the list alone, a tap opens the artifact on its own screen
 * (`artifact`: this screen showing just the artifact). Wide screen (iPad): the list with
 * the selected artifact beside it. `split` and `artifact` show the artifact in the same
 * place of the same tree, so an iPad going narrow or wide (rotating, Split View) keeps
 * the open artifact as it is — a video playing, a zoomed image — rather than opening it
 * anew.
 *
 * Must render inside the task's hub scope (`HubScope`): every read and the uploads go
 * to the hub that owns the task.
 */
import { getEffectiveRenderMode, RENDER_MODE_INFO } from '@slayzone/task-contracts/types'
import { dbTimestampToIso, formatRelativeDate } from '@slayzone/task-artifacts/shared'
import type { TaskArtifact } from '@slayzone/task-contracts/types'
import { useRef, useState } from 'react'
import {
  ActionSheetIOS,
  ActivityIndicator,
  FlatList,
  type HostInstance,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View
} from 'react-native'
import { findTaskRow } from '../hub-board'
import { useHubFeeds } from '../hub-connections'
import type { HubSession } from '../hub-session'
import { type ChromeColors, useTheme } from '../theme'
import { anchorOf, ArtifactViewer } from './ArtifactViewer'
import { hubTarget } from './hub-rest'
import type { UploadSource } from './pick-uploads'
import { HeaderButton, ScreenHeader } from './ScreenHeader'
import { type ArtifactTreeRow, artifactTreeRows } from './tree-rows'
import { type UploadItem, useArtifactUploads } from './use-artifact-uploads'
import { useTaskArtifacts } from './use-task-artifacts'
import { extensionBadge } from './viewer-kind'

/** Folders closed by hand, per hub + task, for as long as the app runs. */
const collapsedFolders = new Map<string, Set<string>>()

export interface ArtifactsScreenProps {
  session: HubSession
  taskId: string
  /**
   * `split`: the list + the selected artifact beside it (iPad); `list`: the list (phone);
   * `artifact`: the selected artifact alone (phone, or an iPad gone narrow).
   */
  layout: 'list' | 'split' | 'artifact'
  /** Split / artifact: the artifact shown (split, null: the first) and the version shown. */
  selected: { artifactId: string; version: number | null } | null
  /** A row was tapped (phone: open it; split: show it beside the list). */
  onSelect: (artifactId: string) => void
  onSelectVersion: (artifactId: string, version: number | null) => void
  /** An artifact link was tapped in the artifact shown (default: `onSelect`). */
  onOpenArtifact?: (artifactId: string) => void
  onBack: () => void
  /** `artifact`: leaves the artifact; its Back is labelled `artifactBackLabel`. */
  onCloseArtifact?: () => void
  artifactBackLabel?: string
  active?: boolean
  /** Inside the task page (its Artifacts tab): no screen header, an Upload row instead. */
  embedded?: boolean
}

const UPLOAD_SOURCES: Array<{ label: string; source: UploadSource }> = [
  { label: 'Photo Library', source: 'photos' },
  { label: 'Take Photo', source: 'camera' },
  { label: 'Choose File', source: 'files' }
]

export function ArtifactsScreen({
  session,
  taskId,
  layout,
  selected,
  onSelect,
  onSelectVersion,
  onOpenArtifact = onSelect,
  onBack,
  onCloseArtifact,
  artifactBackLabel,
  active = true,
  embedded = false
}: ArtifactsScreenProps) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const target = hubTarget(session)
  const { feeds } = useHubFeeds()
  const feed = feeds.find((f) => f.hub.id === session.entry.id)
  const taskTitle = feed ? findTaskRow(feed, taskId)?.task.title : undefined
  const list = useTaskArtifacts(taskId)
  const uploads = useArtifactUploads(target, taskId)

  const collapseKey = `${session.entry.id}\n${taskId}`
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => collapsedFolders.get(collapseKey) ?? new Set()
  )
  const toggleFolder = (folderId: string) => {
    const next = new Set(collapsed)
    if (next.has(folderId)) next.delete(folderId)
    else next.add(folderId)
    collapsedFolders.set(collapseKey, next)
    setCollapsed(next)
  }

  // iPad: the sheet is a popover from the Upload button.
  const uploadButton = useRef<HostInstance>(null)
  const chooseUpload = () =>
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: 'Upload to this task',
        options: [...UPLOAD_SOURCES.map((s) => s.label), 'Cancel'],
        cancelButtonIndex: UPLOAD_SOURCES.length,
        anchor: anchorOf(uploadButton.current)
      },
      (index) => {
        const choice = UPLOAD_SOURCES[index]
        if (choice) uploads.start(choice.source)
      }
    )

  const rows =
    list.artifacts && list.folders ? artifactTreeRows(list.folders, list.artifacts, collapsed) : []
  const firstArtifact = rows.find((r) => r.kind === 'artifact')
  const shownId =
    layout === 'split'
      ? (selected?.artifactId ??
        (firstArtifact?.kind === 'artifact' ? firstArtifact.artifact.id : null))
      : layout === 'artifact'
        ? (selected?.artifactId ?? null)
        : null

  const subtitle = [taskTitle, feeds.length > 1 ? session.entry.label : null]
    .filter(Boolean)
    .join(' · ')

  const listPane = (
    <View style={layout === 'split' ? styles.listPane : styles.fill}>
      {embedded ? (
        <View style={styles.embeddedBar}>
          <HeaderButton
            ref={uploadButton}
            label="＋ Upload"
            accessibilityLabel="Upload"
            onPress={chooseUpload}
          />
        </View>
      ) : (
        <ScreenHeader
          title="Artifacts"
          subtitle={subtitle || null}
          onBack={onBack}
          backLabel="Task"
          actions={<HeaderButton ref={uploadButton} label="Upload" onPress={chooseUpload} />}
        />
      )}
      {uploads.pickError ? (
        <Banner
          message={uploads.pickError.message}
          action={
            uploads.pickError.needsSettings
              ? { label: 'Open Settings', onPress: () => void Linking.openSettings() }
              : null
          }
          onDismiss={uploads.dismissPickError}
        />
      ) : null}
      {uploads.items.map((item) => (
        <UploadRow
          key={item.id}
          item={item}
          onRetry={() => uploads.retry(item.id)}
          onCancel={() => uploads.cancel(item.id)}
          onDismiss={() => uploads.dismiss(item.id)}
        />
      ))}
      {/* A reload that failed while the list shows: say so, the list stays. */}
      {list.error && list.artifacts ? (
        <Banner
          message={`Couldn't refresh: ${list.error}`}
          action={{ label: 'Retry', onPress: list.refresh }}
        />
      ) : null}
      {list.error && !list.artifacts ? (
        <View style={styles.center}>
          <Text style={styles.note}>{list.error}</Text>
          <HeaderButton label="Retry" onPress={list.refresh} />
        </View>
      ) : !list.artifacts ? (
        <View style={styles.center}>
          <ActivityIndicator testID="artifacts-loading" />
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(row) => row.key}
          renderItem={({ item }) => (
            <TreeRow
              row={item}
              selected={item.kind === 'artifact' && item.artifact.id === shownId}
              onToggle={toggleFolder}
              onOpen={onSelect}
            />
          )}
          ListEmptyComponent={<Text style={styles.note}>No artifacts yet</Text>}
          refreshing={list.refreshing}
          onRefresh={list.refresh}
        />
      )}
    </View>
  )

  // One tree for every layout: the list pane and the artifact pane keep their places
  // (a pane not shown is null), so changing layout never remounts the artifact.
  return (
    <View style={[styles.screen, layout === 'split' ? styles.split : null]}>
      {layout === 'artifact' ? null : listPane}
      {layout === 'list' ? null : (
        <View style={styles.detailPane}>
          {shownId ? (
            <ArtifactViewer
              key={shownId}
              target={target}
              taskId={taskId}
              artifactId={shownId}
              version={selected?.artifactId === shownId ? selected.version : null}
              active={active}
              onSelectVersion={(version) => onSelectVersion(shownId, version)}
              onOpenArtifact={onOpenArtifact}
              onBack={layout === 'artifact' ? onCloseArtifact : undefined}
              backLabel={artifactBackLabel}
            />
          ) : (
            <View style={styles.center}>
              <Text style={styles.note}>{list.artifacts ? 'No artifacts yet' : ''}</Text>
            </View>
          )}
        </View>
      )}
    </View>
  )
}

/** A line under the header: what went wrong, an action, and (optionally) Dismiss. */
function Banner({
  message,
  action,
  onDismiss
}: {
  message: string
  action: { label: string; onPress: () => void } | null
  onDismiss?: () => void
}) {
  const styles = makeStyles(useTheme())
  return (
    <View style={styles.banner}>
      <Text style={styles.bannerText}>{message}</Text>
      {action ? <HeaderButton label={action.label} onPress={action.onPress} /> : null}
      {onDismiss ? <HeaderButton label="Dismiss" onPress={onDismiss} /> : null}
    </View>
  )
}

function TreeRow({
  row,
  selected,
  onToggle,
  onOpen
}: {
  row: ArtifactTreeRow
  selected: boolean
  onToggle: (folderId: string) => void
  onOpen: (artifactId: string) => void
}) {
  const styles = makeStyles(useTheme())
  const indent = { paddingLeft: 16 + row.depth * 20 }
  if (row.kind === 'folder') {
    return (
      <Pressable
        testID={`artifact-folder-${row.folder.id}`}
        accessibilityRole="button"
        // VoiceOver: the folder's name and state, not the chevron glyph.
        accessibilityLabel={`${row.folder.name}, folder`}
        accessibilityState={{ expanded: row.expanded }}
        onPress={() => onToggle(row.folder.id)}
        style={[styles.row, indent]}
      >
        <Text style={styles.chevron} importantForAccessibility="no" accessibilityElementsHidden>
          {row.expanded ? '▾' : '▸'}
        </Text>
        <Text style={styles.folderName} numberOfLines={1} ellipsizeMode="middle">
          {row.folder.name}
        </Text>
      </Pressable>
    )
  }
  return (
    <ArtifactRow
      artifact={row.artifact}
      selected={selected}
      style={indent}
      onPress={() => onOpen(row.artifact.id)}
    />
  )
}

function ArtifactRow({
  artifact,
  selected,
  style,
  onPress
}: {
  artifact: TaskArtifact
  selected: boolean
  style: { paddingLeft: number }
  onPress: () => void
}) {
  const styles = makeStyles(useTheme())
  const badge = extensionBadge(artifact.title)
  const mode = RENDER_MODE_INFO[getEffectiveRenderMode(artifact.title, artifact.render_mode)].label
  return (
    <Pressable
      testID={`artifact-row-${artifact.id}`}
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.row, style, selected ? styles.rowSelected : null]}
    >
      <View style={styles.rowText}>
        <View style={styles.titleLine}>
          <Text style={styles.title} numberOfLines={1} ellipsizeMode="middle">
            {artifact.title}
          </Text>
          {badge ? <Text style={styles.badge}>{badge}</Text> : null}
        </View>
        <Text style={styles.meta} numberOfLines={1}>
          {mode} · {formatRelativeDate(dbTimestampToIso(artifact.updated_at))}
        </Text>
      </View>
    </Pressable>
  )
}

function UploadRow({
  item,
  onRetry,
  onCancel,
  onDismiss
}: {
  item: UploadItem
  onRetry: () => void
  onCancel: () => void
  onDismiss: () => void
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const fraction = item.total > 0 ? item.sent / item.total : 0
  return (
    <View style={styles.upload} testID={`upload-${item.file.name}`}>
      <View style={styles.rowText}>
        <Text style={styles.title} numberOfLines={1} ellipsizeMode="middle">
          {item.file.name}
        </Text>
        {item.status === 'failed' ? (
          <Text style={styles.uploadError} numberOfLines={2}>
            {item.error}
          </Text>
        ) : (
          <View style={styles.track}>
            <View style={[styles.bar, { width: `${Math.round(fraction * 100)}%` }]} />
          </View>
        )}
      </View>
      {item.status === 'failed' ? (
        <>
          <HeaderButton label="Retry" onPress={onRetry} />
          <HeaderButton label="Dismiss" onPress={onDismiss} />
        </>
      ) : (
        <>
          <Text style={styles.meta}>
            {item.total > 0 ? `${Math.round(fraction * 100)}%` : 'Uploading…'}
          </Text>
          <HeaderButton
            label="Cancel"
            accessibilityLabel={`Cancel upload of ${item.file.name}`}
            onPress={onCancel}
          />
        </>
      )}
    </View>
  )
}

/** Wide enough for the list beside the artifact. */
export const ARTIFACTS_LIST_WIDTH = 340

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    embeddedBar: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      paddingHorizontal: 14,
      paddingVertical: 6
    },
    screen: { flex: 1, backgroundColor: t.background },
    fill: { flex: 1 },
    split: { flexDirection: 'row' },
    listPane: {
      width: ARTIFACTS_LIST_WIDTH,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: t.border
    },
    detailPane: { flex: 1 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
    note: { color: t.mutedForeground, textAlign: 'center', padding: 24 },
    banner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    bannerText: { flex: 1, color: t.destructive, fontSize: 13 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingRight: 16,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    rowSelected: { backgroundColor: t.muted },
    chevron: { width: 14, fontSize: 13, color: t.mutedForeground },
    folderName: { flex: 1, fontSize: 15, color: t.foreground },
    rowText: { flex: 1, gap: 3 },
    titleLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    title: { flexShrink: 1, fontSize: 15, color: t.foreground },
    badge: {
      fontSize: 10,
      fontWeight: '600',
      color: t.mutedForeground,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      borderRadius: 4,
      paddingHorizontal: 4,
      paddingVertical: 1,
      overflow: 'hidden'
    },
    meta: { fontSize: 12, color: t.mutedForeground },
    upload: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 10,
      backgroundColor: t.muted,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    uploadError: { fontSize: 12, color: t.destructive },
    track: { height: 4, borderRadius: 2, backgroundColor: t.border, overflow: 'hidden' },
    bar: { height: 4, backgroundColor: t.primary }
  })
