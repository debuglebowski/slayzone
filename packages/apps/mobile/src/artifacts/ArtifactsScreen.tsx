/**
 * A task's artifacts: the tree desktop's panel shows (folders first, then artifacts, by
 * name; folders collapsible, open at first), live, plus Upload (photos, camera, files) to
 * the task's hub. Phone: the list alone, a tap opens the artifact on its own screen.
 * Wide screen (iPad): the list with the selected artifact beside it.
 *
 * Must render inside the task's hub scope (`HubScope`): every read and the uploads go
 * to the hub that owns the task.
 */
import { getEffectiveRenderMode, RENDER_MODE_INFO } from '@slayzone/task-contracts/types'
import { dbTimestampToIso, formatRelativeDate } from '@slayzone/task-artifacts/shared'
import type { TaskArtifact } from '@slayzone/task-contracts/types'
import { useState } from 'react'
import {
  ActionSheetIOS,
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View
} from 'react-native'
import { findTaskRow } from '../hub-board'
import { useHubFeeds } from '../hub-connections'
import type { HubSession } from '../hub-session'
import { type ChromeColors, useTheme } from '../theme'
import { ArtifactViewer } from './ArtifactViewer'
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
  /** `split`: the list + the selected artifact beside it (iPad); `list`: the list (phone). */
  layout: 'list' | 'split'
  /** Split: the artifact beside the list (null: the first) and the version shown. */
  selected: { artifactId: string; version: number | null } | null
  /** A row was tapped (phone: open it; split: show it beside the list). */
  onSelect: (artifactId: string) => void
  onSelectVersion: (artifactId: string, version: number | null) => void
  onBack: () => void
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
  onBack
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

  const chooseUpload = () =>
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: 'Upload to this task',
        options: [...UPLOAD_SOURCES.map((s) => s.label), 'Cancel'],
        cancelButtonIndex: UPLOAD_SOURCES.length
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
      : null

  const subtitle = [taskTitle, feeds.length > 1 ? session.entry.label : null]
    .filter(Boolean)
    .join(' · ')

  const listPane = (
    <View style={layout === 'split' ? styles.listPane : styles.fill}>
      <ScreenHeader
        title="Artifacts"
        subtitle={subtitle || null}
        onBack={onBack}
        backLabel="Task"
        actions={<HeaderButton label="Upload" onPress={chooseUpload} />}
      />
      {uploads.pickError ? <Text style={styles.error}>{uploads.pickError}</Text> : null}
      {uploads.items.map((item) => (
        <UploadRow
          key={item.id}
          item={item}
          onRetry={() => uploads.retry(item.id)}
          onDismiss={() => uploads.dismiss(item.id)}
        />
      ))}
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

  if (layout === 'list') return <View style={styles.screen}>{listPane}</View>
  return (
    <View style={[styles.screen, styles.split]}>
      {listPane}
      <View style={styles.detailPane}>
        {shownId ? (
          <ArtifactViewer
            key={shownId}
            target={target}
            taskId={taskId}
            artifactId={shownId}
            version={selected?.artifactId === shownId ? selected.version : null}
            onSelectVersion={(version) => onSelectVersion(shownId, version)}
            onOpenArtifact={onSelect}
          />
        ) : (
          <View style={styles.center}>
            <Text style={styles.note}>{list.artifacts ? 'No artifacts yet' : ''}</Text>
          </View>
        )}
      </View>
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
        accessibilityState={{ expanded: row.expanded }}
        onPress={() => onToggle(row.folder.id)}
        style={[styles.row, indent]}
      >
        <Text style={styles.chevron}>{row.expanded ? '▾' : '▸'}</Text>
        <Text style={styles.folderName} numberOfLines={1}>
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
          <Text style={styles.title} numberOfLines={1}>
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
  onDismiss
}: {
  item: UploadItem
  onRetry: () => void
  onDismiss: () => void
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const fraction = item.total > 0 ? item.sent / item.total : 0
  return (
    <View style={styles.upload} testID={`upload-${item.file.name}`}>
      <View style={styles.rowText}>
        <Text style={styles.title} numberOfLines={1}>
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
        <Text style={styles.meta}>
          {item.total > 0 ? `${Math.round(fraction * 100)}%` : 'Uploading…'}
        </Text>
      )}
    </View>
  )
}

/** Wide enough for the list beside the artifact. */
export const ARTIFACTS_LIST_WIDTH = 340

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
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
    error: { color: t.destructive, paddingHorizontal: 16, paddingVertical: 8, fontSize: 13 },
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
    folderName: { flex: 1, fontSize: 15, color: t.foreground, fontFamily: 'Menlo' },
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
