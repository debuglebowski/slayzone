/**
 * The board's ⋯ (iOS's own action sheet): everything the board's toolbar used to show —
 * Filter… (with "Clear filters" while one narrows the board), Display…, the views, and
 * desktop's "Archive all" of each completed column that shows tasks (after asking). A
 * dot on ⋯ says a filter narrows the board, so it is never invisible.
 */
import { useEffect, useEffectEvent, useRef } from 'react'
import {
  ActionSheetIOS,
  Alert,
  findNodeHandle,
  type HostInstance,
  Pressable,
  StyleSheet,
  Text,
  View
} from 'react-native'
import { type ChromeColors, useTheme } from '../theme'
import type { BoardView } from './board-prefs'
import { useArchiveAll } from './use-archive-all'

/** A completed column whose (shown) tasks "Archive all" archives. */
export interface ArchivableColumn {
  id: string
  title: string
  taskIds: readonly string[]
}

export interface BoardMenuProps {
  /** The sheet's title (the project). */
  title: string
  /** Priority, due date or tags narrow the board: dot on ⋯, "Clear filters". */
  narrows: boolean
  /** Filter… and Display… (the project's board has loaded). */
  canFilter: boolean
  view: BoardView
  views: readonly { id: BoardView; label: string }[]
  archivable: readonly ArchivableColumn[]
  onFilter: () => void
  onClearFilters: () => void
  onDisplay: () => void
  onView: (view: BoardView) => void
  /** A link asked for ⋯ (`/?sheet=menu`): it opens, then `onRequested`. */
  requested?: boolean
  onRequested?: () => void
}

interface Entry {
  label: string
  run: () => void
  destructive?: boolean
}

/** ⋯ inside the board's `HubScope`: "Archive all" writes to the project's hub. */
export function ScopedBoardMenuButton(props: BoardMenuProps) {
  const archiveAll = useArchiveAll()
  return <BoardMenuButton {...props} onArchiveAll={(ids) => void archiveAll(ids)} />
}

export function BoardMenuButton({
  onArchiveAll,
  ...props
}: BoardMenuProps & { onArchiveAll?: (taskIds: readonly string[]) => void }) {
  const styles = makeStyles(useTheme())
  const anchor = useRef<HostInstance>(null)

  const confirmArchive = (column: ArchivableColumn) => {
    const n = column.taskIds.length
    Alert.alert(
      `Archive ${n === 1 ? 'task' : `${n} tasks`}?`,
      `Archive ${n === 1 ? 'the task' : `all ${n} tasks`} in “${column.title}”? You can restore them later from the archive.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Archive', style: 'destructive', onPress: () => onArchiveAll?.(column.taskIds) }
      ]
    )
  }

  const showMenu = () => {
    const entries: Entry[] = []
    if (props.canFilter) {
      entries.push({ label: props.narrows ? 'Filter… (on)' : 'Filter…', run: props.onFilter })
      if (props.narrows) entries.push({ label: 'Clear filters', run: props.onClearFilters })
      entries.push({ label: 'Display…', run: props.onDisplay })
    }
    for (const v of props.views) {
      entries.push({
        label: v.id === props.view ? `${v.label} view ✓` : `${v.label} view`,
        run: () => props.onView(v.id)
      })
    }
    if (onArchiveAll) {
      for (const column of props.archivable) {
        entries.push({
          label: `Archive all in ${column.title} (${column.taskIds.length})…`,
          run: () => confirmArchive(column),
          destructive: true
        })
      }
    }
    const destructive = entries.flatMap((e, i) => (e.destructive ? [i] : []))
    const node = anchor.current ? findNodeHandle(anchor.current) : null
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: props.title,
        options: [...entries.map((e) => e.label), 'Cancel'],
        cancelButtonIndex: entries.length,
        destructiveButtonIndex: destructive,
        // iPad: a popover from ⋯.
        anchor: node ?? undefined
      },
      (index) => entries[index]?.run()
    )
  }

  const { requested } = props
  const answerLink = useEffectEvent(() => {
    props.onRequested?.()
    showMenu()
  })
  useEffect(() => {
    if (requested) answerLink()
  }, [requested])

  return (
    <Pressable
      ref={anchor}
      onPress={showMenu}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={props.narrows ? 'Board options, filter on' : 'Board options'}
      testID="board-menu"
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      <Text style={styles.glyph}>⋯</Text>
      {props.narrows ? <View style={styles.dot} testID="board-menu-dot" /> : null}
    </Pressable>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    button: {
      width: 34,
      height: 34,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.surface2,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border
    },
    pressed: { opacity: 0.6 },
    glyph: { fontSize: 18, fontWeight: '700', color: t.mutedForeground, marginTop: -2 },
    dot: {
      position: 'absolute',
      top: 4,
      right: 4,
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: t.primary
    }
  })
