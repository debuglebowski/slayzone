/**
 * Editing a description as raw markdown, in a sheet. Nothing reaches the hub until Done,
 * and then the whole text, once (never a half-typed one); an unchanged text writes
 * nothing. The hub keeps whichever write comes last, so this never overwrites silently:
 * when the hub's description changed since editing started — the board delivered a new
 * one, or the hub says so when Done asks it (`task.get`) — a note says so, "Use theirs"
 * takes theirs, and Done asks before replacing it.
 *
 * Attach (photo library, camera, files): each file is uploaded to the task as an
 * artifact on its hub (`uploadArtifact`, top level, as desktop's paste) and linked at the
 * cursor, `[title](artifact:<id>)`; the link is saved with the text, on Done.
 */
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import { hubTarget } from '../artifacts/hub-rest'
import { pickUploads, type UploadSource } from '../artifacts/pick-uploads'
import { uploadArtifact } from '../artifacts/upload'
import { ChoiceSheet } from '../computers/ChoiceSheet'
import type { TaskRow } from '../hub-board'
import { useHubSessions } from '../hub-sessions'
import { type ChromeColors, useTheme } from '../theme'
import { useTRPC, useTRPCClient } from '../trpc'
import {
  artifactLink,
  descriptionUpdate,
  editableDescription,
  hubChanged,
  insertAt,
  type StoredDescription,
  type TextSelection
} from './description'
import { messageOf } from './use-task-writes'

const SOURCES: { key: UploadSource; label: string }[] = [
  { key: 'photos', label: 'Photo library' },
  { key: 'camera', label: 'Take photo' },
  { key: 'files', label: 'Files' }
]

const stored = (task: StoredDescription): StoredDescription => ({
  description: task.description,
  description_format: task.description_format
})

export function DescriptionEditor({ row, onClose }: { row: TaskRow; onClose: () => void }) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const trpc = useTRPC()
  const client = useTRPCClient()
  const queryClient = useQueryClient()
  const { sessions = [] } = useHubSessions()
  const taskId = row.task.id

  /** The hub's description editing started from (or the one taken with "Use theirs"). */
  const [base, setBase] = useState<StoredDescription>(() => stored(row.task))
  const [doc, setDoc] = useState<{ text: string; selection: TextSelection | null }>(() => ({
    text: editableDescription(row.task),
    selection: null
  }))
  /** A newer description the hub reported at Done, before its board did. */
  const [reported, setReported] = useState<StoredDescription | null>(null)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [uploading, setUploading] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const theirs =
    reported && hubChanged(base, reported)
      ? reported
      : hubChanged(base, row.task)
        ? stored(row.task)
        : null
  const original = editableDescription(base)

  const save = (update: { description: string | null }) => {
    setSaving(true)
    setError(null)
    client.task.update
      .mutate({ id: taskId, ...update })
      .then(() => {
        void queryClient.invalidateQueries(trpc.task.loadBoardData.queryFilter())
        onClose()
      })
      .catch((err: unknown) => {
        setSaving(false)
        setError(`Couldn't save: ${messageOf(err)}`)
      })
  }

  const askOverwrite = (update: { description: string | null }) =>
    Alert.alert(
      'Replace the hub’s description?',
      'It changed on the hub while you were editing. Saving replaces that version with yours.',
      [
        { text: 'Keep editing', style: 'cancel' },
        { text: 'Overwrite', style: 'destructive', onPress: () => save(update) }
      ]
    )

  const done = () => {
    const update = descriptionUpdate(original, doc.text)
    if (!update) {
      onClose()
      return
    }
    if (theirs) {
      askOverwrite(update)
      return
    }
    // The board may not have delivered a change yet: ask the hub itself.
    setSaving(true)
    client.task.get
      .query({ id: taskId })
      .then((fresh) => {
        setSaving(false)
        if (fresh && hubChanged(base, fresh)) {
          setReported(stored(fresh))
          askOverwrite(update)
        } else save(update)
      })
      .catch((err: unknown) => {
        setSaving(false)
        setError(`Couldn't save: ${messageOf(err)}`)
      })
  }

  const cancel = () => {
    if (doc.text === original) {
      onClose()
      return
    }
    Alert.alert('Discard your changes?', 'The description stays as it is on the hub.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: onClose }
    ])
  }

  const takeTheirs = () => {
    if (!theirs) return
    setBase(theirs)
    setReported(null)
    setDoc({ text: editableDescription(theirs), selection: null })
  }

  const attach = (source: UploadSource) => {
    const session = sessions.find((s) => s.entry.id === row.hubId)
    if (!session) {
      setError(`Not signed in to ${row.hubLabel}`)
      return
    }
    const target = hubTarget(session)
    setError(null)
    pickUploads(source)
      .then((files) => {
        if (files.length === 0) return
        setUploading((n) => n + files.length)
        return Promise.all(
          files.map((file) =>
            uploadArtifact(target, { taskId, file })
              .then((artifact) => artifactLink(artifact.id, artifact.title))
              .catch((err: unknown) => {
                setError(`Couldn't attach ${file.name}: ${messageOf(err)}`)
                return null
              })
              .then((link) => {
                setUploading((n) => n - 1)
                return link
              })
          )
        ).then((links) => {
          const insert = links.filter((l): l is string => l !== null).join(' ')
          if (!insert) return
          setDoc((d) => {
            const next = insertAt(d.text, d.selection, insert)
            return { text: next.text, selection: { start: next.cursor, end: next.cursor } }
          })
        })
      })
      .catch((err: unknown) => setError(messageOf(err)))
  }

  const busy = saving || uploading > 0
  return (
    <Modal visible animationType="slide" presentationStyle="formSheet" onRequestClose={cancel}>
      <View style={styles.sheet} testID="description-editor">
        <View style={styles.header}>
          <Pressable onPress={cancel} hitSlop={8} accessibilityRole="button">
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <Text style={styles.title}>Description</Text>
          <Pressable
            onPress={() => setSourcesOpen(true)}
            hitSlop={8}
            accessibilityRole="button"
            disabled={saving}
          >
            <Text style={styles.link}>Attach</Text>
          </Pressable>
          <Pressable onPress={done} hitSlop={8} accessibilityRole="button" disabled={busy}>
            <Text style={[styles.link, styles.done, busy && styles.disabled]}>Done</Text>
          </Pressable>
        </View>
        {theirs ? (
          <View style={styles.conflict}>
            <Text style={styles.conflictText}>
              The description changed on the hub while you were editing. Done asks before replacing
              it.
            </Text>
            <Pressable onPress={takeTheirs} hitSlop={8} accessibilityRole="button">
              <Text style={styles.link}>Use theirs</Text>
            </Pressable>
          </View>
        ) : null}
        {uploading > 0 ? (
          <View style={styles.status}>
            <ActivityIndicator color={theme.mutedForeground} />
            <Text style={styles.muted}>Uploading…</Text>
          </View>
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <TextInput
          testID="description-input"
          value={doc.text}
          onChangeText={(text) => setDoc((d) => ({ ...d, text }))}
          onSelectionChange={(e) => {
            const selection = e.nativeEvent.selection
            setDoc((d) => ({ ...d, selection }))
          }}
          multiline
          autoFocus
          scrollEnabled
          textAlignVertical="top"
          autoCorrect
          spellCheck
          placeholder="Add description… (markdown)"
          placeholderTextColor={theme.mutedForeground}
          style={styles.input}
        />
        <ChoiceSheet
          visible={sourcesOpen}
          title="Attach"
          choices={SOURCES}
          selectedKey={null}
          onChoose={(key) => attach(key as UploadSource)}
          onClose={() => setSourcesOpen(false)}
        />
      </View>
    </Modal>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    sheet: { flex: 1, backgroundColor: t.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 16,
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    title: { flex: 1, fontSize: 17, fontWeight: '600', color: t.foreground },
    link: { fontSize: 15, color: t.foreground, fontWeight: '500' },
    done: { fontWeight: '700' },
    disabled: { color: t.mutedForeground },
    conflict: {
      gap: 8,
      margin: 12,
      padding: 12,
      borderRadius: 8,
      backgroundColor: t.muted
    },
    conflictText: { fontSize: 14, color: t.foreground },
    status: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 16,
      paddingTop: 8
    },
    muted: { fontSize: 13, color: t.mutedForeground },
    error: { fontSize: 13, color: t.destructive, paddingHorizontal: 16, paddingTop: 8 },
    input: { flex: 1, padding: 16, fontSize: 16, lineHeight: 22, color: t.foreground }
  })
