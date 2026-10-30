import { pickerStartDir } from '@slayzone/file-editor/dir-picker'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { type ChromeColors, useTheme } from '../theme'
import { useTRPC } from '../trpc'

/** The machine to browse and the project it is for (`workspace.*`'s target). */
export interface FolderTarget {
  computerId: string
  projectId: string
}

/**
 * Pick a folder on another machine — the computer that will run the project's agents —
 * the way desktop's `WorkspaceDirPicker` does: that computer lists its own disk through
 * the hub (`workspace.listRoots` / `listDir` / `mkdir`), within its allowed roots (the
 * same boundary every other file operation there obeys), and a path can be typed. A
 * picker of this phone's files would give a path that does not exist where the work
 * happens.
 *
 * Must sit inside the hub's `HubScope`. The sheet's state starts over at every opening
 * (its body mounts with it): the roots may have changed meanwhile.
 */
export function FolderPicker({
  visible,
  target,
  defaultPath,
  title = 'Select folder',
  onSelect,
  onClose
}: {
  visible: boolean
  target: FolderTarget
  /** Where to open (the folder there now); ignored outside the computer's roots. */
  defaultPath: string | null
  title?: string
  /** The chosen ABSOLUTE path on the target machine. */
  onSelect: (path: string) => void
  onClose: () => void
}) {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      {visible ? (
        <FolderPickerBody
          target={target}
          defaultPath={defaultPath}
          title={title}
          onSelect={onSelect}
          onClose={onClose}
        />
      ) : null}
    </Modal>
  )
}

function FolderPickerBody({
  target,
  defaultPath,
  title,
  onSelect,
  onClose
}: {
  target: FolderTarget
  defaultPath: string | null
  title: string
  onSelect: (path: string) => void
  onClose: () => void
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const rootsQ = useQuery(trpc.workspace.listRoots.queryOptions(target))
  /** Where the user went; null = still where the picker opened. */
  const [navigated, setNavigated] = useState<string | null>(null)
  /** The path field while being edited; null = it shows where the picker is. */
  const [manual, setManual] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)

  const roots = rootsQ.data?.roots ?? []
  const sep = rootsQ.data?.sep ?? '/'
  const startDir = rootsQ.data
    ? pickerStartDir({ roots, sep, home: rootsQ.data.home, defaultPath })
    : null
  const cwd = navigated ?? startDir

  const listQ = useQuery(
    trpc.workspace.listDir.queryOptions(
      { ...target, path: cwd ?? '', dirsOnly: true },
      { enabled: cwd !== null }
    )
  )
  const { mutateAsync: mkdir, isPending: mkdirPending } = useMutation(
    trpc.workspace.mkdir.mutationOptions()
  )

  const go = (path: string): void => {
    setNavigated(path)
    setManual(null)
  }

  const createFolder = (): void => {
    const name = newName.trim()
    if (!name || !cwd) return
    setCreateError(null)
    mkdir({ ...target, path: `${cwd}${sep}${name}` })
      .then(async (res) => {
        setCreating(false)
        setNewName('')
        await queryClient.invalidateQueries(trpc.workspace.listDir.queryFilter())
        go(res.path)
      })
      .catch((err: unknown) =>
        setCreateError(
          `Could not create folder: ${err instanceof Error ? err.message : String(err)}`
        )
      )
  }

  const chosen = (manual ?? cwd)?.trim() ?? ''
  const parent = listQ.data?.parent ?? null

  let body
  if (rootsQ.isError) {
    body = <Text style={styles.error}>Could not reach that machine: {rootsQ.error.message}</Text>
  } else if (rootsQ.isSuccess && roots.length === 0) {
    // A computer with no allowed roots refuses every file operation: say so, and where
    // to fix it, rather than an empty list that reads as "no folders".
    body = (
      <Text style={styles.note}>
        This computer has no allowed folders configured, so it will not open anything. Add one in
        Settings → Connections, on the computer’s row (SlayZone desktop).
      </Text>
    )
  } else {
    body = (
      <>
        <View style={styles.pathRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Up one folder"
            disabled={!parent}
            hitSlop={8}
            onPress={() => parent && go(parent)}
            style={styles.upButton}
          >
            <Text style={[styles.link, !parent && styles.disabled]}>↑</Text>
          </Pressable>
          <TextInput
            testID="folder-picker-path"
            style={styles.pathInput}
            value={manual ?? cwd ?? ''}
            onChangeText={setManual}
            onSubmitEditing={() => {
              if (manual?.trim()) go(manual.trim())
              else setManual(null)
            }}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            returnKeyType="go"
          />
        </View>
        {roots.length > 1 ? (
          <View style={styles.roots}>
            {roots.map((root) => (
              <Pressable
                key={root}
                accessibilityRole="button"
                onPress={() => go(root)}
                style={[styles.root, cwd === root && styles.rootActive]}
              >
                <Text style={styles.rootText}>{root}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <ScrollView style={styles.list}>
          {listQ.isError ? (
            <Text style={styles.error}>{listQ.error.message}</Text>
          ) : listQ.isPending ? (
            <Text style={styles.note}>Reading…</Text>
          ) : listQ.data.entries.length === 0 ? (
            <Text style={styles.note}>No sub-folders here.</Text>
          ) : (
            listQ.data.entries.map((entry) => (
              <Pressable
                key={entry.path}
                testID={`folder-entry-${entry.path}`}
                accessibilityRole="button"
                style={styles.entry}
                onPress={() => go(entry.path)}
              >
                <Text style={styles.entryName} numberOfLines={1}>
                  {entry.name}
                </Text>
                {/* Marking repos is the difference between picking a project and
                    picking the folder above it by mistake. */}
                {entry.isGitRepo ? <Text style={styles.mark}>git</Text> : null}
                <Text style={styles.mark}>›</Text>
              </Pressable>
            ))
          )}
        </ScrollView>
        {creating ? (
          <View style={styles.createRow}>
            <TextInput
              style={styles.nameInput}
              value={newName}
              placeholder="New folder name"
              placeholderTextColor={theme.mutedForeground}
              onChangeText={setNewName}
              onSubmitEditing={createFolder}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Pressable
              accessibilityRole="button"
              disabled={!newName.trim() || mkdirPending}
              onPress={createFolder}
            >
              <Text style={styles.link}>Create</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            style={styles.newFolder}
            onPress={() => setCreating(true)}
          >
            <Text style={styles.link}>New folder</Text>
          </Pressable>
        )}
        {createError ? <Text style={styles.error}>{createError}</Text> : null}
      </>
    )
  }

  return (
    <View style={styles.sheet} testID="folder-picker">
      <View style={styles.header}>
        <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button">
          <Text style={styles.link}>Cancel</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <Pressable
          onPress={() => {
            if (!chosen) return
            onSelect(chosen)
            onClose()
          }}
          disabled={!chosen}
          hitSlop={8}
          accessibilityRole="button"
        >
          <Text style={[styles.link, styles.strong, !chosen && styles.disabled]}>Select</Text>
        </Pressable>
      </View>
      <Text style={styles.description}>
        Folders on the machine that will run this project’s agents.
      </Text>
      {body}
    </View>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    sheet: { flex: 1, backgroundColor: t.background, paddingBottom: 16 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 16,
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    title: {
      flex: 1,
      textAlign: 'center',
      fontSize: 17,
      fontWeight: '600',
      color: t.foreground
    },
    link: { fontSize: 15, color: t.foreground, fontWeight: '500' },
    strong: { fontWeight: '700' },
    disabled: { color: t.mutedForeground },
    description: { fontSize: 12, color: t.mutedForeground, padding: 16, paddingBottom: 8 },
    pathRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16 },
    upButton: { paddingHorizontal: 6, paddingVertical: 4 },
    pathInput: {
      flex: 1,
      fontFamily: 'Menlo',
      fontSize: 13,
      color: t.foreground,
      backgroundColor: t.input,
      borderRadius: 6,
      paddingHorizontal: 10,
      paddingVertical: 8
    },
    roots: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, padding: 16, paddingBottom: 0 },
    root: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, backgroundColor: t.muted },
    rootActive: { backgroundColor: t.accent },
    rootText: { fontFamily: 'Menlo', fontSize: 12, color: t.foreground },
    list: {
      flex: 1,
      margin: 16,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      borderRadius: 8
    },
    entry: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    entryName: { flex: 1, fontSize: 15, color: t.foreground },
    mark: { fontSize: 12, color: t.mutedForeground },
    newFolder: { paddingHorizontal: 16, alignSelf: 'flex-start' },
    createRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16 },
    nameInput: {
      flex: 1,
      fontSize: 15,
      color: t.foreground,
      backgroundColor: t.input,
      borderRadius: 6,
      paddingHorizontal: 10,
      paddingVertical: 8
    },
    note: { color: t.mutedForeground, padding: 12, fontSize: 13 },
    error: { color: t.destructive, padding: 12, fontSize: 13 }
  })
