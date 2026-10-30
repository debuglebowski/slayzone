/**
 * The composer: the `/` menu above the input while a command is being typed, the
 * messages waiting in the queue ("Up next", removable), the files the next message
 * carries (given back by Stop; removable), and the input with Send — and Stop while a
 * turn runs. Keyboard dictation works as in any text field.
 */
import { type ChatAttachment, type QueuedChatMessage } from '@slayzone/terminal-contracts'
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import type { ChromeColors } from '../theme'
import { attachmentLabel, queuedFiles, queuedLabel } from './attachments'
import type { SlashItem } from './slash-menu'
import { MONO, useThemedStyles } from './styles'
import type { ChatComposer } from './useChatComposer'

const KIND_LABELS: Record<SlashItem['type'], string> = {
  builtin: 'app',
  skill: 'skill',
  command: 'command',
  agent: 'agent',
  cli: 'Claude Code'
}

export function Composer({
  composer,
  queued,
  onRemoveQueued,
  inFlight,
  disabled,
  placeholder
}: {
  composer: ChatComposer
  queued: readonly QueuedChatMessage[]
  onRemoveQueued: (id: string) => void
  inFlight: boolean
  /** Not ready to send yet (loading), or the session ended. */
  disabled: boolean
  placeholder: string
}) {
  const { s, theme } = useThemedStyles(makeStyles)
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
                <Text style={s.menuKind}>{KIND_LABELS[item.type]}</Text>
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
      {queued.length > 0 && (
        <View style={s.queue} testID="chat-queue">
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
                <Pressable
                  onPress={() => onRemoveQueued(q.id)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove queued message: ${label}`}
                >
                  <Text style={s.queueRemove}>✕</Text>
                </Pressable>
              </View>
            )
          })}
        </View>
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
            onPress={composer.stop}
            style={[s.button, s.stop]}
            accessibilityRole="button"
            accessibilityLabel="Stop generation"
          >
            <Text style={s.stopText}>■</Text>
          </Pressable>
        )}
        <Pressable
          onPress={composer.send}
          disabled={disabled || !composer.canSend}
          style={[s.button, s.send, (disabled || !composer.canSend) && s.off]}
          accessibilityRole="button"
          accessibilityLabel={inFlight ? 'Queue message' : 'Send'}
          accessibilityState={{ disabled: disabled || !composer.canSend }}
        >
          <Text style={s.sendText}>↑</Text>
        </Pressable>
      </View>
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
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.border,
      backgroundColor: t.background,
      paddingHorizontal: 8,
      paddingTop: 6,
      paddingBottom: 8
    },
    menu: {
      maxHeight: 240,
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
    inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 6 },
    input: {
      flex: 1,
      minHeight: 38,
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
      width: 38,
      height: 38,
      borderRadius: 19,
      alignItems: 'center',
      justifyContent: 'center'
    },
    send: { backgroundColor: t.primary },
    sendText: { color: t.primaryForeground, fontSize: 18, fontWeight: '700' },
    stop: { backgroundColor: t.destructive },
    stopText: { color: t.background, fontSize: 14 },
    off: { opacity: 0.4 }
  })
}
