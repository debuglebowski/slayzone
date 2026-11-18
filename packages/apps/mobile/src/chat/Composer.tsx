/**
 * The composer: the `/` menu above the input while a command is being typed, the
 * messages waiting in the queue ("Up next", removable, addable to the running
 * turn — then "With agent…" until the agent reads it), the files the next message
 * carries (given back by Stop, or a photo attached with ＋; removable), and the input
 * with Send — and Stop while a turn runs (asking first when queued messages would be
 * dropped). Keyboard dictation works as in any text field.
 *
 * In a screen too short for all of it (the keyboard is up), the `/` menu and the queue
 * shrink and scroll; the input row never does, so it stays above the keyboard.
 */
import {
  userMessageAttachments,
  type ChatAttachment,
  type QueuedChatMessage
} from '@slayzone/terminal-contracts'
import { useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import type { ChromeColors } from '../theme'
import { BottomSheet } from '../ui-kit/Chrome'
import { attachmentLabel, queuedFiles, queuedLabel } from './attachments'
import type { SlashItem } from './slash-menu'
import { MONO, useThemedStyles } from './styles'
import type { ChatAttach, AttachSource } from './useChatAttach'
import type { ChatComposer } from './useChatComposer'

const KIND_LABELS: Record<Exclude<SlashItem['type'], 'cli'>, string> = {
  builtin: 'app',
  skill: 'skill',
  command: 'command',
  agent: 'agent'
}

/** Send / Stop: 40pt drawn, 44pt+ to a finger. */
const BUTTON_SLOP = 4

export function Composer({
  composer,
  queued,
  onRemoveQueued,
  onSteerQueued,
  withdrawSteered = false,
  inFlight,
  disabled,
  placeholder,
  cliLabel = 'Claude Code',
  attach = null
}: {
  composer: ChatComposer
  queued: readonly QueuedChatMessage[]
  onRemoveQueued: (id: string) => void
  /**
   * "Send now": the agent takes it after its current step. Absent →
   * not offered (no turn runs, a prompt waits, or the provider can't).
   */
  onSteerQueued?: (id: string) => void
  /** A message with the agent (`steering`) can be taken back until it is read. */
  withdrawSteered?: boolean
  inFlight: boolean
  /** Not ready to send yet (loading), or the session ended. */
  disabled: boolean
  placeholder: string
  /** What the `/` menu calls the CLI's own commands: its product ("Claude Code", "Codex"). */
  cliLabel?: string
  /** ＋: attach a photo; null = not offered. */
  attach?: ChatAttach | null
}) {
  const { s, theme } = useThemedStyles(makeStyles)
  const [attachSheet, setAttachSheet] = useState(false)
  const pickFrom = (source: AttachSource) => {
    setAttachSheet(false)
    attach?.pick(source)
  }
  const waiting = queued.length + (composer.pendingQueuedMessages?.length ?? 0)
  // Stop clears the queue too: with messages waiting, ask first.
  const stop = () => {
    if (waiting === 0) {
      composer.stop()
      return
    }
    Alert.alert(
      `Stop and drop ${waiting === 1 ? '1 queued message' : `${waiting} queued messages`}?`,
      'Stopping clears the queue: the messages waiting are not sent.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Stop', style: 'destructive', onPress: composer.stop }
      ]
    )
  }
  // Saved on this device, not confirmed by the hub yet: shown at once at the end of
  // Up next (no actions until confirmed); the hub's row replaces it once listed.
  const listed = new Set(queued.map((q) => q.id))
  const unconfirmed = (composer.pendingQueuedMessages ?? []).filter((e) => !listed.has(e.id))
  return (
    <View style={s.wrap}>
      {composer.menu && (
        <FlatList
          testID="slash-menu"
          style={s.menu}
          data={composer.menu}
          keyExtractor={(item) => item.key}
          keyboardShouldPersistTaps="always"
          renderItem={({ item }) => (
            <Pressable
              onPress={() => composer.pick(item)}
              style={({ pressed }) => [s.menuItem, pressed && s.menuItemPressed]}
              accessibilityRole="button"
              accessibilityLabel={`/${item.name}`}
            >
              <View style={s.menuTop}>
                <Text style={s.menuName} numberOfLines={1}>
                  /{item.name}
                  {item.type === 'cli' && item.argumentHint ? (
                    <Text style={s.menuHint}> {item.argumentHint}</Text>
                  ) : null}
                </Text>
                <Text style={s.menuKind}>
                  {item.type === 'cli' ? cliLabel : KIND_LABELS[item.type]}
                </Text>
              </View>
              {item.description ? (
                <Text style={s.menuDescription} numberOfLines={1}>
                  {item.description}
                </Text>
              ) : null}
            </Pressable>
          )}
        />
      )}
      {queued.length + unconfirmed.length > 0 && (
        <ScrollView style={s.queue} testID="chat-queue" keyboardShouldPersistTaps="handled">
          <Text style={s.queueTitle}>Up next</Text>
          {queued.map((q) => {
            const label = queuedLabel(q)
            const files = q.original ? queuedFiles(q) : []
            return (
              <View key={q.id} style={s.queueRow}>
                <View style={s.queueBody}>
                  <Text style={s.queueText} numberOfLines={2}>
                    {label}
                  </Text>
                  {files.length > 0 ? (
                    <Text style={s.queueFiles} numberOfLines={1}>
                      📎 {files.map((f) => f.name).join(', ')}
                    </Text>
                  ) : null}
                </View>
                {q.steering ? (
                  <>
                    <Text style={s.queueSteering}>With agent…</Text>
                    {withdrawSteered && (
                      <Pressable
                        onPress={() => onRemoveQueued(q.id)}
                        hitSlop={8}
                        accessibilityRole="button"
                        accessibilityLabel={`Take back from the agent: ${label}`}
                      >
                        <Text style={s.queueRemove}>✕</Text>
                      </Pressable>
                    )}
                  </>
                ) : (
                  <>
                    {onSteerQueued && (
                      <Pressable
                        onPress={() => onSteerQueued(q.id)}
                        hitSlop={8}
                        accessibilityRole="button"
                        accessibilityLabel={`Send now: ${label}`}
                      >
                        <Text style={s.queueAction}>Send now</Text>
                      </Pressable>
                    )}
                    <Pressable
                      onPress={() => onRemoveQueued(q.id)}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove queued message: ${label}`}
                    >
                      <Text style={s.queueRemove}>✕</Text>
                    </Pressable>
                  </>
                )}
              </View>
            )
          })}
          {unconfirmed.map((entry) => {
            const label = entry.original || entry.send || 'Attached files'
            const files = userMessageAttachments(entry.content)
            return (
              <View key={entry.id} style={s.queueRow}>
                <View style={s.queueBody}>
                  <Text style={s.queueText} numberOfLines={2}>
                    {label}
                  </Text>
                  {files.length > 0 ? (
                    <Text style={s.queueFiles} numberOfLines={1}>
                      📎 {files.map((f) => f.name).join(', ')}
                    </Text>
                  ) : null}
                  {entry.state === 'failed' && entry.error ? (
                    <Text style={s.queueFiles} accessibilityLiveRegion="polite">
                      {entry.error}
                    </Text>
                  ) : null}
                </View>
                {entry.state === 'failed' && (
                  <>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Retry queued message: ${label}`}
                      onPress={() => {
                        void composer.retryQueuedSubmission?.(entry.id).catch(() => {
                          /* The local copy keeps the error. */
                        })
                      }}
                    >
                      <Text style={s.queueRemove}>Retry</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Remove local copy; accepted messages are not cancelled"
                      onPress={() => {
                        void composer.dismissQueuedSubmission?.(entry.id).catch(() => {
                          /* Keep the local copy if deletion fails. */
                        })
                      }}
                    >
                      <Text style={s.queueRemove}>Dismiss</Text>
                    </Pressable>
                  </>
                )}
              </View>
            )
          })}
        </ScrollView>
      )}
      {composer.attachments.length > 0 && (
        <View style={s.files} testID="chat-attachments">
          {composer.attachments.map((file, i) => (
            <AttachedFile
              key={`${file.artifactId}-${i}`}
              file={file}
              onRemove={() => composer.removeAttachment(i)}
              s={s}
            />
          ))}
        </View>
      )}
      <View style={s.inputRow}>
        {attach ? (
          <Pressable
            onPress={() => setAttachSheet(true)}
            disabled={disabled}
            hitSlop={BUTTON_SLOP}
            style={[s.button, s.plus, disabled && s.off]}
            accessibilityRole="button"
            accessibilityLabel="Attach a photo"
            accessibilityState={{ disabled, busy: attach.uploading > 0 }}
          >
            {attach.uploading > 0 ? (
              <ActivityIndicator size="small" color={theme.mutedForeground} />
            ) : (
              <Text style={s.plusText}>＋</Text>
            )}
          </Pressable>
        ) : null}
        <TextInput
          testID="chat-input"
          value={composer.draft}
          onChangeText={composer.setDraft}
          placeholder={placeholder}
          placeholderTextColor={theme.mutedForeground}
          multiline
          editable={!disabled}
          style={s.input}
          accessibilityLabel="Message"
          autoCorrect
        />
        {inFlight && (
          <Pressable
            onPress={stop}
            hitSlop={BUTTON_SLOP}
            style={[s.button, s.stop]}
            accessibilityRole="button"
            accessibilityLabel="Stop generation"
          >
            <Text style={s.stopText}>■</Text>
          </Pressable>
        )}
        <Pressable
          onPress={composer.send}
          hitSlop={BUTTON_SLOP}
          disabled={disabled || !composer.canSend}
          style={[s.button, s.send, (disabled || !composer.canSend) && s.off]}
          accessibilityRole="button"
          accessibilityLabel={inFlight ? 'Queue message' : 'Send'}
          accessibilityState={{ disabled: disabled || !composer.canSend }}
        >
          <Text style={s.sendText}>↑</Text>
        </Pressable>
      </View>
      {attach ? (
        <BottomSheet
          visible={attachSheet}
          onClose={() => setAttachSheet(false)}
          testID="attach-sheet"
        >
          <Pressable
            onPress={() => pickFrom('camera')}
            accessibilityRole="button"
            style={s.sheetRow}
          >
            <Text style={s.sheetText}>Take photo</Text>
          </Pressable>
          <Pressable
            onPress={() => pickFrom('photos')}
            accessibilityRole="button"
            style={s.sheetRow}
          >
            <Text style={s.sheetText}>Photo library</Text>
          </Pressable>
        </BottomSheet>
      ) : null}
    </View>
  )
}

function AttachedFile({
  file,
  onRemove,
  s
}: {
  file: ChatAttachment
  onRemove: () => void
  s: ReturnType<typeof makeStyles>
}) {
  return (
    <View style={s.file}>
      <Text style={s.fileName} numberOfLines={1} accessibilityLabel={attachmentLabel(file)}>
        📎 {file.name}
      </Text>
      <Pressable
        onPress={onRemove}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`Remove ${file.name}`}
      >
        <Text style={s.queueRemove}>✕</Text>
      </Pressable>
    </View>
  )
}

function makeStyles(t: ChromeColors) {
  return StyleSheet.create({
    wrap: {
      // Shrinks (its menu and queue do) before the input row could leave the screen.
      flexShrink: 1,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.border,
      backgroundColor: t.background,
      paddingHorizontal: 8,
      paddingTop: 6,
      paddingBottom: 8
    },
    menu: {
      maxHeight: 240,
      flexShrink: 1,
      minHeight: 44,
      marginBottom: 6,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      backgroundColor: t.popover
    },
    menuItem: { paddingHorizontal: 10, paddingVertical: 8 },
    menuItemPressed: { backgroundColor: t.accent },
    menuTop: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
    menuName: { flexShrink: 1, color: t.popoverForeground, fontFamily: MONO, fontSize: 14 },
    menuHint: { color: t.mutedForeground, fontFamily: MONO, fontSize: 12 },
    menuKind: { color: t.mutedForeground, fontSize: 11 },
    menuDescription: { color: t.mutedForeground, fontSize: 12, marginTop: 1 },
    queue: {
      flexShrink: 1,
      flexGrow: 0,
      minHeight: 44,
      marginBottom: 6,
      padding: 8,
      borderRadius: 8,
      backgroundColor: t.surface1,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border
    },
    queueTitle: { color: t.mutedForeground, fontSize: 11, fontWeight: '700', marginBottom: 4 },
    queueRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 2 },
    queueBody: { flex: 1 },
    queueText: { color: t.foreground, fontSize: 13 },
    queueFiles: { color: t.mutedForeground, fontSize: 12, marginTop: 1 },
    queueSteering: { color: t.mutedForeground, fontSize: 12, fontStyle: 'italic' },
    queueAction: { color: t.primary, fontSize: 12, fontWeight: '600' },
    files: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 },
    file: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      maxWidth: '100%',
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 8,
      backgroundColor: t.surface1,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border
    },
    fileName: { flexShrink: 1, color: t.foreground, fontSize: 13 },
    queueRemove: { color: t.mutedForeground, fontSize: 14 },
    inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 6, flexShrink: 0 },
    input: {
      flex: 1,
      minHeight: 40,
      maxHeight: 160,
      borderRadius: 18,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.input,
      backgroundColor: t.surface1,
      color: t.foreground,
      paddingHorizontal: 14,
      paddingTop: 9,
      paddingBottom: 9,
      fontSize: 16
    },
    button: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center'
    },
    send: { backgroundColor: t.primary },
    sendText: { color: t.primaryForeground, fontSize: 18, fontWeight: '700' },
    stop: { backgroundColor: t.destructive },
    stopText: { color: t.background, fontSize: 14 },
    off: { opacity: 0.4 },
    plus: { backgroundColor: t.surface2 },
    plusText: { color: t.foreground, fontSize: 18 },
    sheetRow: {
      minHeight: 44,
      justifyContent: 'center',
      paddingVertical: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.border
    },
    sheetText: { fontSize: 16, color: t.foreground }
  })
}
